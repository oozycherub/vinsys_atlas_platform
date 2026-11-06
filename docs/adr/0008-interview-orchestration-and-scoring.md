# ADR-0008: AI interviews: assessment questions, event-driven LangGraph with per-node checkpoints, separated scoring

- Status: Accepted
- Date: 2026-11-06

## Context

PRD Module 4 describes an AI interviewer over voice (LiveKit) or text. A LangGraph orchestrator is checkpointed after every node, so a crashed worker resumes elsewhere. Interviewer, turn evaluator and final scorer are separate LLM roles, and the recommendation is deterministic code. Several details need deciding:

- **How an interview reaches a candidate.** Prompt 11 makes an AI interview an assessment of kind `ai_interview`. assessment-svc already consumes `interview.session.completed.v1` per question.
- **Who authenticates the candidate.** Only assessment-svc can verify the candidate's session token (as for proctoring, ADR-0007).
- **What a checkpoint holds.** It must be enough to resume _mid-turn_, not only between turns.
- **Agent allocation.** The PRD names a Temporal workflow; sandbox-svc already uses a Postgres lease queue (ADR-0006).
- **LLM latency.** The PRD's fallbacks are timed in seconds (1.2 s filler, 3 s failover), so they live in interview-svc, not the gateway.

## Decision

1. **An AI interview is an assessment question.**
   - Question type `ai_interview` has the payload `{interview_id}` (migration 0016, contracts `QUESTION_TYPES`).
   - The runner calls assessment-svc `POST /v1/sessions/{sid}/questions/{qid}:startInterview`. That checks the session token and the live session, then calls interview-svc `POST /v1/interviews/{id}/sessions` with a service token (`interviews:sessions`). The call is idempotent on `(assessment_session_id, question_id)`.
   - The answer stored is `{interview_session_id}`. The question waits for the result, like a coding answer waits for the judge.
   - interview-svc returns an **interview token** (`ivt_…`, stored as sha256). The candidate uses it for `:join`, the transcript of their own session and the text WebSocket.
2. **The graph runs per event and stores its next step.**
   - The state machine is the PRD's: CONSENT → GREETING → ASK_QUESTION → LISTEN → (FOLLOW_UP | EVAL_TURN) → … → WRAP_UP → SCORING → END. The global edges are candidate question (approved FAQ only), repeat, off-topic redirect, PAUSED and SAFETY. It is a LangGraph `StateGraph` whose conditional edges read `state.next`.
   - An invocation consumes one input event: consent, utterance, silence, disconnect, rejoin, pause timeout or start. It runs nodes until one sets `next = AWAIT`.
   - The input is written into a checkpoint _before_ the first node runs, and the whole state is checkpointed after every node (`interview_checkpoints`). The checkpoint holds `next` and the pending event, so a new worker resumes at the exact node.
   - Utterances carry `(checkpoint seq, index)` ids, so a replayed node cannot speak twice to a transport that has already played them.
   - Redis holds the hot copy (`t:{tid}:iv:{sid}`, TTL 2 h). It is used only when its `seq` matches Postgres.
3. **Allocation is a lease on the session row** (60 s, renewed every 15 s), not Temporal.
   - Voice sessions set `wants_worker` on `:join`, and agent workers claim them with `FOR UPDATE SKIP LOCKED` in a system transaction.
   - Text sessions are run by the API process holding the candidate's WebSocket, under the same lease.
   - `interview_pending_sessions()` (owner function, `atlas_metrics` role) feeds the KEDA scaler.
   - Pauses: at most 2, of 120 s each. The worker's maintenance loop fires `pause_timeout`, which ends the session as `abandoned`, scored on what was said and marked for review.
4. **LLM calls go through llm-gateway prompts** that interview-svc registers at start-up (`interview.*@1`).
   - **Interviewer:** fast route. It sees the current question, the probes and the last 6 turns, never scores.
   - **Endpointing completeness:** fast route.
   - **Turn evaluator:** primary route, run in the background after EVAL_TURN.
   - **Final scorer:** primary route, or eval route for calibration runs.
   - **Planner:** primary route.
   - **Timeouts:** with no reply in 1.2 s the interviewer emits a filler. At 3 s it fails over to the primary-route variant. If that fails too, the next question comes verbatim from the frozen plan.
   - The interviewer returns structured `{action, probe_index, utterance}`. Code enforces at most 2 probes and the probe list.
5. **Guardrails run in code, on both sides of the model.**
   - **Input:** injection and abuse heuristics on every candidate turn. A hit flags the turn `excluded` (never scored), the interviewer declines politely, and `interview.session.flagged.v1` is published.
   - **Output:** every interviewer utterance passes the illegal-question filter (age, religion, marital or family status, pregnancy, nationality or origin, race, disability, sexual orientation, health, union membership). Work authorisation stays allowed. A blocked utterance is replaced by the plan's own text, which is checked at publish.
6. **Scoring is validated, then decided by code.**
   - The scorer must cite `{turn, quote}`. A citation counts only if it names a candidate turn that is not excluded and the quote fuzzy-matches that turn at ≥ 0.9 (rapidfuzz `partial_ratio`). A competency without one valid citation becomes `insufficient_evidence` (score null).
   - **Recommendation:** a failed knockout gives `do_not_advance`. Evidenced weight below 0.5 gives `hold`. Otherwise the weighted mean is compared with the interview's thresholds (`advance` ≥ 3.5, `hold` ≥ 2.5).
   - `do_not_advance` needs human approval when the tenant's `compliance.jurisdictions` include a regulated one (`us-nyc`, `eu`, `uk`, `ca-qc`, `il`, `co`). Flags and insufficient evidence also send the result to review.
   - **Overrides** are append-only, with a reason, and republish the completed event with `revision + 1`.
7. **Voice is a pipeline of ports:** transport (LiveKit), VAD (Silero), STT (faster-whisper), TTS and endpointing.
   - Production adapters import their heavy dependencies lazily (optional `voice` dependency group).
   - Tests use a fake transport, synthetic WAV fixtures, energy VAD and scripted STT.
   - **Barge-in:** speech during playback cancels TTS and marks the utterance `interrupted`.
   - **Low STT confidence:** `avg_logprob < −1.0` or no-speech probability > 0.6 takes the REPEAT edge. After 2 failures in a row the agent offers text mode.

## Consequences

- An interview can only be taken inside an assessment session; standalone links would need a second authentication path.
- Checkpoints store the full state after every node. That is a few KB per node and about 200 rows for a 20-minute interview. They are deleted with the session on erasure.
- Replays are at-least-once at node granularity. LLM calls in a replayed node run again. The utterance ids make speaking idempotent; billing may count the call twice.
- Not verified here: real LiveKit, Silero, faster-whisper and TTS. They need GPUs and media servers, and their adapters are thin. Neither are the p95 ≤ 1.5 s turn latency and 2k concurrent interviews per cell (load tests in a cell), nor κ ≥ 0.7 on a real calibration set (`eval/calibration.py` computes it from human and AI scores).
