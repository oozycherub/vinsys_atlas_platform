# Component Prompt 11: interview-svc (Generative AI Voice/Text Screening)

## Status

**Built:** `services/interview-svc` (Python: API, text WebSocket, voice agent worker, LangGraph graph, prompts registered in llm-gateway, offline calibration), `infra/livekit` and the Helm chart `infra/k8s/interview`. The deviations are recorded in ADR-0008:

- an AI interview is an assessment question (`ai_interview`), started through assessment-svc's `:startInterview`;
- the graph runs one event per invocation and checkpoints after every node, with `next` in the state, so a successor resumes mid-turn;
- agents are allocated by a lease on the session row (as in sandbox-svc), not a Temporal workflow;
- the LLM fallbacks (filler, failover, plan) live in interview-svc;
- recordings are WAV per track written by the agent, not LiveKit egress;
- the migrations are `0015` (0014 was taken) and `0016` (the question type).

**Verified on this machine:**

- A scripted candidate completes a 3-question plan, over text and over a fake LiveKit room with WAV fixtures. Transcripts and checkpoints are persisted.
- A crash mid-turn resumes on another worker from the checkpoint; the dead worker can no longer write.
- An LLM timeout plays a filler, and the interview continues from the plan.
- An injection is flagged and not scored.
- A hostile model never gets a blocked question said (red-team set).
- Scores without valid citations become "insufficient evidence".
- Barge-in stops speech within 150 ms; low confidence repeats, then offers text; silence nudges; pauses and abandonment; erasure.
- assessment-svc replays the recorded `interview.session.completed.v1` fixtures (review, then override).
- 33 of 33 interview-svc mutations and 8 of 8 assessment-svc (brick 11) mutations are caught.

**Not verified here:**

- real LiveKit, Silero, faster-whisper and TTS (media server and GPUs);
- turn latency p95 ≤ 1.5 s, 2k concurrent interviews per cell, STT real-time factor ≤ 0.2;
- κ ≥ 0.7 on a real calibration set (`eval/calibration.py` computes it from human and AI scores).

**Supporting changes:**

- contracts: `ai_interview` in `QUESTION_TYPES`, `interview.session.flagged.v1`, and optional report members on `interview.session.completed.v1`;
- assessment-svc: the `ai_interview` question type, `:startInterview`, and flagged interviews putting the session into review. A reviewed coding or interview answer now clears the session's review (a brick 8/9 gap).

## 1. Context

- PRD Module 4 (§2.4 a–d), §4.1 (structured interviews, human-in-the-loop, illegal-question filter), §4.3 (turn latency).
- Brick 11 (Python). Depends on llm-gateway and assessment-svc (an AI interview is an assessment of kind `ai_interview`).

## 2. Scope

**In**

- **Interview plan generation:** recruiter edits, then publishes a frozen version.
- **LiveKit agent worker** (voice): Silero VAD, endpointing, faster-whisper streaming STT, LangGraph orchestrator, streaming TTS.
- **WebSocket text mode.**
- **Checkpointed state:** Redis for the hot path, Postgres checkpoints.
- **Pause and resume:** ≤ 2 pauses of 120 s.
- **Barge-in.**
- **Scoring:** separate interviewer, turn-evaluator and scorer roles; a citation validator; a deterministic recommendation.
- **Guardrails:** injection classifier, illegal-question output filter.

**Out:** the recruiter report UI (brick 14).

## 3. Owned data

- Migration `0015_interviews.sql` (0014 was taken): `interview_plans` (versioned), `interview_sessions`, `interview_turns`, `interview_checkpoints`, `interview_evaluations`, `evaluation_overrides`.
- S3: `t/{tid}/interviews/{sid}/` for audio.

## 4. API contract

As in PRD §2.4: `POST /v1/interviews`, `/sessions`, `:join` (LiveKit token TTL 10 min, room-scoped publish rights), `/transcript`, `/evaluation`, and `POST /v1/interview-sessions/{sid}/evaluation:override {reason}`.

## 5. Events

- **Produced:** `interview.session.completed.v1` (competency scores and recommendation), `interview.session.flagged.v1` (injection attempts, safety stops).
- **Consumed:** `assessment.session.started.v1` (to allocate an agent).

## 6. Domain rules

- **Graph states and edges:** exactly the PRD state machine.
- **Probes:** maximum 2 per question.
- **Silence handling:** 8 s nudge, 30 s offer to move on, 60 s next question.
- **Low STT confidence** (avg_logprob < −1.0) triggers a repeat. After 2 failures, offer text mode.
- **Recommendations** come from code thresholds, never from the LLM.
- **Human approval** is required before "do not advance" in flagged jurisdictions (tenant settings).

## 7. Non-functional

- Turn latency p95 ≤ 1.5 s.
- 2k concurrent interviews per cell.
- STT real-time factor ≤ 0.2.

## 8. Acceptance tests

- **Scripted runs:**
  - A scripted candidate (recorded WAV fixtures, through a fake LiveKit transport) completes a 3-question plan.
  - Transcripts and checkpoints are persisted.
  - A crash mid-turn resumes on another worker from the checkpoint.
- **Robustness:**
  - LLM timeout plays a filler and the interview continues from the pre-generated plan.
  - An injection utterance is flagged, and the answer is not scored as a response.
  - The interviewer never asks a blocked question (red-team prompt set).
- **Scoring validity:**
  - A score without valid citations becomes "insufficient evidence".
  - Human–AI agreement κ ≥ 0.7 on the calibration set (offline evaluation).

## 9. Deliverables

`services/interview-svc/` (API plus agent worker), LangGraph graph module with unit tests per node, prompt templates registered in the llm-gateway, LiveKit configuration in `infra/`.
