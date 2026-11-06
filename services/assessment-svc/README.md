# assessment-svc (brick 8)

Question bank, assessments, invite links, candidate sessions with a server-authoritative timer, auto-scoring, the reviewer workflow and results.

Spec: [`docs/prompts/08-assessment-svc.md`](../../docs/prompts/08-assessment-svc.md) · Contract: [`openapi.yaml`](openapi.yaml) · Events: [`packages/contracts/src/assessment-events.ts`](../../packages/contracts/src/assessment-events.ts) · Runner DTOs: [`assessment-runner.ts`](../../packages/contracts/src/assessment-runner.ts)

## Design

```
http/controllers.ts    Authoring (staff), Runtime (candidate, Session token), Results (staff), Health
  └─▶ application/     AuthoringService, RuntimeService, EvaluationService, ResultsService
                       (+ sweeper), AssessmentEventHandlers; zod schemas live in schemas.ts
        └─▶ domain/    questions.ts (candidate view, auto-scoring), assessment.ts (pinning,
                       deterministic plans, bands), session.ts (state machine, timer, evaluation)
infrastructure/        Postgres repositories (CAS on lock_version), profile directory (HTTP)
```

## Authoring

- **Questions** are versioned: `PUT /v1/questions/{id}` creates version n+1. The app role cannot UPDATE a question row except its `status`, so a version's content never changes.
- Types: `mcq`, `multiple_answer` (optional partial credit), `true_false`, `fill_blank` (accepted answers, optional case sensitivity), `descriptive` (rubric, human review) and `coding` (scored by sandbox-svc, brick 9).
- **Assessments** are versioned too. Only a `draft` can be edited (If-Match on `lock_version`). A database trigger rejects changes to the definition, settings, duration or report config of any non-draft version.
- `:publish` pins every fixed question to its version and checks that each bank can supply its draw count. `:newVersion` copies the latest published version into a new draft; `:clone` makes a separate assessment. `:setStatus?version=n` deactivates or archives a given version.
- Limits: 20 sections, 5 banks per section, 60 s – 6 h.

## Coding questions (sandbox-svc, brick 9, ADR-0006)

- **Payload.** A coding payload carries `languages`, `starter_code` and `tests` (`input`, `expected`, `hidden`, optional `weight`). It may also carry `checker` and `limits`, and it needs `reference_solution {language, code}` before it can be published.
- **Registration.** When a coding question version is saved, its tests are registered with sandbox-svc, which stores them and starts verifying the reference solution (5 runs).
- **Publish gate.** Publish registers every coding question again (an idempotent PUT): the fixed ones and those in referenced banks. It refuses with:
  - `REFERENCE_SOLUTION_REQUIRED`;
  - `CODING_TESTS_PENDING` (try again shortly);
  - `CODING_TESTS_INVALID` (flaky or failing reference);
  - 503 if the judge is down.

  The published event lists `coding_languages`, so sandbox-svc keeps those workers warm.

- **Candidate routes** (session token). Each checks the live session, the plan and the language, then forwards with a service token (`sandbox:execute`) and the session deadline as `active_until`:
  - `POST /v1/sessions/{id}/questions/{qid}/runs` and `GET …/runs/{runId}?wait=`;
  - `POST /v1/sessions/{id}/questions/{qid}/submissions` and `GET …/submissions/{submissionId}`.

  A run or submission is readable only from its own session. The judge's refusals are passed on (`RUN_THROTTLED` with Retry-After, `LANGUAGE_DISABLED`, …).

- **Idempotency.** A submission's key is the session plus sha256(question | code), so retrying after a network drop never creates a second job.
- **Auto-submit.** When a session ends (submitted, expired or terminated), coding drafts that were never submitted are flagged (`coding_dispatch_pending`, migration 0013) and sent to the judge, immediately after a candidate submit and by every sweep. Failures are retried until each draft has a submission.

## Proctoring (proctoring-svc, brick 10, ADR-0007)

- **Settings.** `settings.proctoring = {enabled, id_verification, rules}`. The rules are validated by proctoring-svc.
- **Starting.** After the pre-check, the candidate calls `POST /v1/sessions/{sid}:startProctoring` with `{consent: {biometrics, version}}`. The session must be live, and `PROCTORING_NOT_ENABLED` is returned for unproctored assessments.
  - This service calls proctoring-svc with a service token (`proctoring:sessions`) and returns the proctor token and HMAC session key to the SDK.
  - Calling it again (a page reload) resumes with a new key.
- **Termination.** `proctoring.violation.raised.v1` with `action: terminate` ends a live session.
- **Trust Score.** `proctoring.session.finalized.v1` records the Trust Score; `review_required` (a red band) sets `pending_review`. AI never rejects a candidate.
- **Contract tests.** Both payloads are replayed from proctoring-svc's recorded fixtures.

## Candidate runtime

1. **Invite:** an open link (needs name and email; the candidate is found or created through profile-svc with an Idempotency-Key) or a targeted invite. The `inv_…` token is shown once and stored as sha256.
2. **Redeem:** checks max attempts, retake cooldown and invite uses (atomically), then builds the session's question plan. Bank draws use a PRNG seeded by the session id, so a plan can be rebuilt and audited. Returns an `ast_…` session token, bound to that one session.
3. **Start:** `deadline = now + duration`. Every response carries `server_time` and `remaining_seconds`; the client timer is display only.
4. **Answer:** `PUT /responses/{qid}` with `client_rev` = previous + 1. An older revision gets `409 STALE_REVISION` with the stored `client_rev`. Writes after the deadline get `409 SESSION_EXPIRED`, and the expiry is committed before the error is returned.
5. **Navigation:** `fixed_section_order` refuses going back to an earlier section (`409 SECTION_LOCKED`).
6. **Interruptions:** no heartbeat for 30 s pauses the session (the sweeper does this). The next heartbeat resumes it and credits the paused time, up to `pause_allowance_seconds` (default 300) per session.
7. **Submit / expire / terminate:** every transition is a compare-and-set on `lock_version`, so exactly one of two concurrent submits wins.
8. **SSE** (`/events`): `state`, `time_warning` (300 s and 60 s), `paused`, `resumed`, `terminated`, `ended`.

Hidden data never reaches the candidate: the candidate view is an allow-list (no `correct` flags, accepted answers, rubric or tests).

## Scoring and review

- **Auto-scoring:** MCQ and true/false are all-or-nothing; multiple-answer with partial credit is `max(0, (right − wrong) / correct)`. Negative marks apply only to wrong answers, never to blanks, and never exceed the question's marks.
- **Coding** waits for `sandbox.submission.judged.v1`: marks × `score_ratio`, the weighted share of passed tests. A result that arrives while the session is still running is kept at submit. The latest submission wins: a result for an older submission than the one on record is ignored. An `internal_error` is never charged: the answer goes to review (`pending_review`) and a reviewer scores it.
- **Descriptive** answers need review. Reviewers are assigned per session. Each scores every reviewable question; the score is **held** until all assigned reviewers finish, then the mean is released.
- When nothing is pending, the session gets its percentage, band and per-skill scores (proficiency = 5 × earned / available, confidence = min(0.9, 0.4 + 0.1 × items)). `assessment.session.evaluated.v1` carries `valid_until` (default 24 months), which profile-svc stores on the evidence.
- Terminated sessions are scored for the report but never produce skill evidence.
- Item statistics: attempts and correct counts per question version; the difficulty index is shown from 10 attempts.

## Events

- **Produced:** `assessment.assessment.published.v1`, `assessment.session.started.v1`, `assessment.session.submitted.v1` (`outcome`: submitted | expired), `assessment.session.terminated.v1`, `assessment.session.evaluated.v1`.
- **Consumed** (`assessment-svc.events`): `sandbox.submission.judged.v1` (brick 9), `proctoring.violation.raised.v1` (brick 10: trust score, review flag or termination), `interview.session.completed.v1` (brick 11), `privacy.erasure.requested.v1` (deletes the candidate's sessions and invites, then acknowledges), `tenant.tenant.purged.v1`.

The contracts for bricks 9–11 are fixed now in `packages/contracts`.

## Owned data (`0011_assessments.sql`)

`question_banks`, `questions`, `question_stats`, `assessments`, `assessment_invites`, `assessment_sessions`, `session_responses`, `review_assignments`. All have tenant RLS. Sessions and invites are also readable in system transactions, for token lookup and the sweeper.

## Configuration

| Variable                                                                    | Purpose                                                           |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `ATLAS_ASSESSMENT_PORT`                                                     | 8088                                                              |
| `ATLAS_DATABASE_URL`, `ATLAS_REDIS_URL`                                     | Postgres; Redis for the per-session rate limit (required in prod) |
| `ATLAS_AUTH_ISSUER`, `ATLAS_AUTH_AUDIENCE`, `ATLAS_AUTH_JWKS_URL`           | Staff JWT verification                                            |
| `ATLAS_IDENTITY_TOKEN_URL`, `ATLAS_ASSESSMENT_CLIENT_ID` / `_CLIENT_SECRET` | Service token for profile-svc calls                               |
| `ATLAS_PROFILE_SVC_URL`                                                     | Candidate lookup/creation for open links                          |
| `ATLAS_PROCTORING_SVC_URL`                                                  | proctoring-svc (scope `proctoring:sessions`)                      |
| `ATLAS_SANDBOX_SVC_URL`                                                     | sandbox-svc (scopes `sandbox:execute`, `sandbox:bundles`)         |
| `ATLAS_ASSESSMENT_INVITE_BASE_URL`                                          | Base of invite URLs                                               |
| `ATLAS_ASSESSMENT_SESSION_RPS`                                              | Candidate requests per second per session (default 20)            |
| `ATLAS_ASSESSMENT_EVENT_SOURCE`, `ATLAS_KAFKA_BROKERS`                      | `none` or `kafka` for consumed events                             |

Production refuses shared-secret auth, a missing event bus and a missing Redis URL.

## Tests

`npx vitest run services/assessment-svc`: acceptance tests AT1–AT6 plus pause, navigation, authoring lifecycle, judge, proctoring, SSE, interview, time warnings, erasure and purge, against the real HTTP stack and Postgres with RLS. 18 deliberate mutations (answer-key leak, no CAS, deadline ignored, uncapped pause, early score release, …) were all caught.

## Decisions and gaps

- The timer is enforced on the server by `deadline_at` plus the sweeper; there is no per-session timer process.
- SSE polls the session row (`ssePollMs`, 1 s) rather than subscribing to a bus; fine at this scale, revisit with brick 10's live proctoring.
- Coding drafts live in this service's autosave (`client_rev`); sandbox-svc has no draft endpoint.
- Bank draws use the bank's latest question versions at redeem time. A coding question revised after publish needs its new version verified, or submissions for it get `BUNDLE_NOT_VERIFIED` from the judge.
- The request body limit (512 KB) also bounds a coding question's tests; larger suites would need an upload path.
- AI-interview sections record the score from interview-svc (brick 11); the interview itself is not run here.
- Reports beyond the result view (PDF export, cohort analytics) are left to brick 13 (analytics).
