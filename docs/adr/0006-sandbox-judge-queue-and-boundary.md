# ADR-0006: Sandbox judge: Postgres job queue, assessment-svc as the candidate boundary

- Status: Accepted
- Date: 2026-11-05

## Context

PRD §2.2 describes sandbox-svc (brick 9) as an API that writes a `coding_submissions` row and enqueues the job on Redis Streams or Kafka, with per-tenant streams, a weighted fair scheduler, priority lanes, leases with heartbeats and at most 3 redeliveries. It also says the candidate's request passes through assessment-svc, which checks the session before forwarding.

Two separate writes, the row and a stream message, can disagree: the row commits and the enqueue fails, or the reverse. Fixing that needs an outbox relay for jobs as well as events.

## Decision

1. **The submission row is the job.**
   - Workers claim jobs with `UPDATE … WHERE submission_id = (SELECT … FOR UPDATE SKIP LOCKED LIMIT 1)`.
   - A claim sets `worker_id`, `lease_until = now() + 60 s` and `attempt_count + 1`. Heartbeats extend the lease every 10 s.
   - A reaper re-queues expired leases. After the third attempt the job ends as `internal_error`.
   - Enqueueing commits atomically with the submission and its idempotency key.
2. **Fairness happens in the worker.**
   - Each worker reads the heads of the queue (lanes and tenants that have queued work for the languages it serves).
   - It picks a lane, then a tenant, with a smooth weighted round robin. Lane weights are interactive 6, submit 3, bulk 1, so no lane starves.
   - A tenant with one job is served within one round however long another tenant's backlog is.
3. **KEDA scales on Postgres.** The PostgreSQL scaler counts queued jobs per language (target 20 per worker) and keeps one warm worker for languages published in the last 7 days.
4. **assessment-svc is the candidate's boundary.**
   - Candidates never call sandbox-svc. assessment-svc checks the session token, that the session is live and the deadline not passed, that the question is in the session's plan and that the language is allowed.
   - It then calls sandbox-svc with a service token (scopes `sandbox:execute`, `sandbox:bundles`), passing the tenant as `tenant_id`.
   - The coding draft stays in assessment-svc's autosaved responses (`client_rev`). There is no separate sandbox draft endpoint.
5. **Test cases are registered per question version.**
   - When assessment-svc saves a coding question version, it registers the tests, checker, limits and reference solution with sandbox-svc.
   - The cases are stored in object storage by checksum. The reference solution runs 5 times on the submit lane.
   - A version can be published only once its bundle is `verified`.

## Consequences

- No dual write, no separate job relay. Postgres carries the queue load: at PRD scale (thousands of jobs per minute) the partial indexes on `status = 'queued'` keep claims cheap. If it ever becomes the bottleneck, the claim step can move to Redis Streams behind the same port.
- Workers need system-transaction access to `coding_submissions` for claims, leases and reaping (RLS policies `system_queue_*`). All per-job work happens in the tenant's transaction.
- sandbox-svc trusts assessment-svc's session check. It defends in depth by rejecting candidate requests after the deadline that assessment-svc passes (`SESSION_NOT_ACTIVE`) and by throttling runs per session (`RUN_THROTTLED`).
