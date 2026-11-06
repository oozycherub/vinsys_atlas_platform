# Component Prompt 08: assessment-svc (Tests, Question Bank, Sessions, Scoring)

## Status

**Built.** Everything in §2–§8. The acceptance tests pass against the real HTTP stack, event consumer and Postgres (RLS on), and 18 deliberate scoring, timer and isolation mutations were all caught.

Supporting changes:

- `packages/contracts` gained the assessment events, the runner DTOs and the contracts consumed from bricks 9–11;
- `assessment.session.evaluated.v1` gained `valid_until`, which profile-svc stores on the evidence.

Decisions and gaps are in `services/assessment-svc/README.md`.

## 1. Context

- PRD §1.0 (assessment and session), §3 (`assessments`, `assessment_sessions`), §4.3 (99.95% availability for test-taking).
- Feature inventory §3.2–3.4 (test builder, settings, question types, reports).
- Brick 8 (TypeScript). Depends on identity, taxonomy and profile.

## 2. Scope

**In**

- **Question bank:** MCQ, multiple-answer, true/false, fill-in-the-blank, descriptive and coding question types. Difficulty index computed from attempts.
- **Assessment builder:** up to 20 sections, ≤ 5 question banks per section, mapped to taxonomy skills. Versioned and immutable once published.
- **Invite links:** open link or targeted invites.
- **Sessions:** server-authoritative timer (`deadline_at`), autosave, navigation modes, a pause rule for interruptions.
- **Scoring and results:** auto-scoring, performance bands, manual reviewer workflow.
- **Candidate status pipeline:** shortlist and reject.
- **Retakes and skill validity:** produce `assessment` skill evidence for profile-svc.

**Out:** code execution (brick 9), proctoring (brick 10), AI interviews (brick 11).

## 3. Owned data

Migration `0011_assessments.sql`: `question_banks`, `questions` (versioned), `assessments`, `assessment_invites`, `assessment_sessions`, `session_responses`, `review_assignments`. All have RLS; `lock_version` on sessions.

## 4. API contract

- **Authoring** (recruiter): `/v1/questions`, `/v1/assessments`, `POST /v1/assessments/{id}:publish`, `:clone`, `/v1/assessments/{id}/invite-links`.
- **Candidate runtime** (candidate token bound to the session):
  - `POST /v1/sessions/{id}:start`
  - `GET /v1/sessions/{id}/questions/{n}`
  - `PUT /v1/sessions/{id}/responses/{qid}` (autosave, `client_rev`)
  - `POST /v1/sessions/{id}:submit`
  - `GET /v1/sessions/{id}/events` (SSE: time warnings, termination)
- **Results:** `GET /v1/assessments/{id}/sessions?filters`, `POST /v1/sessions/{id}:review`, `PATCH /v1/sessions/{id}/candidate-status`.

## 5. Events

- **Produced:** `assessment.session.started.v1`, `.submitted.v1`, `.terminated.v1`, `.evaluated.v1` (per-skill proficiency for profile-svc), `assessment.assessment.published.v1`.
- **Consumed:** `sandbox.submission.judged.v1`, `proctoring.violation.raised.v1` (may terminate), `interview.session.completed.v1`.

**Contract already fixed by profile-svc:** emit `assessment.session.evaluated.v1` as defined in `packages/contracts/src/profile-events.ts` (per-skill `score` 0–5 and `confidence`). Consume `privacy.erasure.requested.v1` and acknowledge.

## 6. Domain rules

- **Session state machine:** invited → started → in_progress ⇄ paused → submitted | terminated | expired → evaluated. Every transition is a compare-and-set on `lock_version`.
- **Deadline:** the server clock decides. Late responses are rejected with `SESSION_EXPIRED`. An expiry workflow auto-submits the last acknowledged answers.
- **Published versions are immutable.** Editing creates version n+1, and sessions pin their version.
- **Hidden answers** (correct options, test cases) never appear in any candidate response.

## 7. Non-functional

- Autosave p95 < 100 ms; 20k concurrent sessions per cell.
- Candidate endpoints are rate-limited per session.

## 8. Acceptance tests

1. Publish, invite, start, answer, submit, then the score and band are correct.
2. Submit after the deadline returns 409; the expiry workflow submits the drafts.
3. Concurrent submits: exactly one wins (lock_version).
4. A candidate token cannot read another session (leak test), and answers never leak.
5. Reviewer workflow holds the score until all reviewers finish.
6. Evaluated event carries the per-skill proficiency.

## 9. Deliverables

Per master layout, plus contracts and `assessment-runner` SDK types for the web app.
