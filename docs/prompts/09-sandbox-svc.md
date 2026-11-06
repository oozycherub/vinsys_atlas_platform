# Component Prompt 09: sandbox-svc (Multi-Language Code Execution Judge)

## Status

**Built.** Everything in §2–§8, with the deviations recorded in ADR-0006:

- the Postgres job queue;
- assessment-svc as the candidate's boundary.

**Tests:**

- The acceptance suite passes against the real HTTP stack, Postgres (RLS on), worker loop and reaper, including fair queueing (a 2,000-job tenant vs ten 1-job tenants: p95 wait 15 ms).
- 20 deliberate mutations of sandbox-svc and 8 of the new assessment-svc rules are all caught.
- The attack corpus and golden programs in 6 languages (`test/attacks`) are written, but they need Linux with Docker and have **not been run yet**. Neither have the image builds or the Helm chart rendering.

**Supporting changes:**

- assessment-svc:
  - the publish gate on verified tests;
  - candidate run and submit routes;
  - auto-submit of drafts when a session ends (migration 0013);
  - weighted scores, latest-submission-wins, and judge failures sent to review;
- `@atlas/contracts`: `score_ratio` and `submitted_at` on the judged event, `coding_languages` on the published event.

Decisions and gaps are in `services/sandbox-svc/README.md`.

## 1. Context

- PRD Module 2 (§2.2 a–d) and §3 (`sandbox_languages`, `coding_submissions`, `coding_test_results`).
- Brick 9. **First Go brick:** Go 1.23, golangci-lint, `cmd/`, `internal/{domain,app,adapters}`. Depends on assessment-svc.

## 2. Scope

**In**

- Judge API: run and submit, as in PRD §2.2.
- Pull-based workers on the tainted `sandbox` node pool:
  - gVisor `runsc` runtime class.
  - `isolate` boxes with cgroups v2, namespaces and a seccomp allowlist.
  - Per-language registry with images pinned by digest.
- Verdict engine and checkers: `exact`, `trim_ws`, `float_tol`, `unordered_lines`, custom checker.
- Weighted fair queueing per tenant, plus priority lanes.
- Warm box pools.
- KEDA scaling manifests.
- Post-submit plagiarism fingerprints: winnowing on normalised AST tokens.

**Out:** the editor UI (brick 14).

## 3. Owned data

Migration `0012_sandbox.sql`: `sandbox_languages`, `coding_submissions`, `coding_test_results`, `test_case_bundles` (S3 key and checksum). RLS on tenant tables.

## 4. API contract

As in PRD §2.2: `runs`, `submissions`, `languages`. Workers are internal only.

Errors: `RUN_THROTTLED` (429 with Retry-After), `SESSION_NOT_ACTIVE`, `LANGUAGE_DISABLED`.

## 5. Events

- **Produced:** `sandbox.submission.judged.v1`, `proctoring.violation.raised.v1` (`type: code_similarity`, consumed by proctoring and assessment).
- **Consumed:** `assessment.assessment.published.v1` (pre-warm the language images).

## 6. Domain rules

- **Limits:** the PRD limits table, with defaults and hard caps.
- **Expected outputs never enter the box.**
- **Verdict severity:** CE > RE > TLE > MLE > OLE > WA > AC.
- **Worker crashes:** a lease plus heartbeat; after 3 redeliveries the result is `internal_error`, which is never charged to the candidate.
- **Flaky-test guard:** at publish time the reference solution runs 5×, and the question is rejected if its results differ.

## 7. Non-functional

- Run p95 < 3 s (warm); submit p95 < 10 s for ≤ 20 tests.
- **Zero escapes.** Quarterly red-team test with the attack corpus in `test/attacks/`.

## 8. Acceptance tests

**Attack corpus:**

- Fork bomb gives RE `RESOURCE_PROCESSES`.
- Infinite loop gives TLE; `sleep(999)` gives TLE by wall time; 2 GB allocation gives MLE.
- Network connect fails.
- Reading `/proc/1/environ` or the host filesystem fails.
- 50 MB of stdout gives OLE.
- C++ template bomb gives CE within the compile limit.

**Correctness:**

- Golden programs in 6 languages produce AC/WA as expected.
- Idempotent submit (same key gives one row).
- Fair queueing: a 2,000-job tenant does not starve a 1-job tenant (p95 wait < 2 s for the small tenant).

## 9. Deliverables

`services/sandbox-svc/` (Go), language images under `infra/sandbox-images/`, Kubernetes manifests (RuntimeClass, NetworkPolicy deny-all, KEDA ScaledObject), Falco rules.
