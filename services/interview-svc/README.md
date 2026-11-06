# interview-svc (brick 11)

Structured first-round interviews run by an AI interviewer, over voice (LiveKit) or text (WebSocket). Every candidate gets the same frozen questions. Each competency is scored against a behaviourally anchored rubric with cited evidence. The recommendation (_advance / hold / do not advance_) is decided by code, and a person has the final say.

An AI interview is a question of an assessment (type `ai_interview`, payload `{interview_id}`): assessment-svc starts it and receives its score.

Spec: [`docs/prompts/11-interview-svc.md`](../../docs/prompts/11-interview-svc.md) · Decisions: [ADR-0008](../../docs/adr/0008-interview-orchestration-and-scoring.md) · PRD Module 4

## Flow

1. **Plan.** A recruiter creates an interview from a job profile: `POST /v1/interviews`.
   - The planner prompt drafts the plan from taxonomy-svc's profile and skills, unless a plan is supplied.
   - The plan holds competencies, weighted questions, up to 4 probes, a 1/3/5 rubric, knockouts and an approved FAQ.
   - The recruiter edits it (`PUT /v1/interviews/{id}/plan`) and publishes it (`:publish`).
   - A published version is **frozen**: a database trigger refuses changes, and an edit starts a new draft version.
   - Every question, probe, knockout and FAQ answer must pass the illegal-question filter.
2. **Session.** The candidate reaches the question.
   - assessment-svc calls `POST /v1/interviews/{id}/sessions` (service scope `interviews:sessions`). The call is idempotent per assessment session and question, and returns an `ivt_…` interview token.
   - `POST /v1/interview-sessions/{sid}:join` returns a LiveKit token in voice mode: room `iv_{sid}`, microphone only, 10 minutes.
   - It also returns the WebSocket URL and the resume cursor.
3. **Interview.** The LangGraph graph runs one input event at a time: consent, utterance, silence, disconnect, rejoin, pause timeout.
   - The state is checkpointed to Postgres after every node, with a hot copy in Redis.
   - Voice sessions are claimed by agent workers. Text sessions are run by the API process holding the WebSocket. Either way the runner holds a lease on the session.
4. **Scoring.**
   - The turn evaluator runs in the background after each question.
   - The final scorer's citations are validated: a quote must fuzzy-match a scorable candidate turn at ≥ 0.9, or the competency becomes "insufficient evidence".
   - Code decides the recommendation. The result is stored and `interview.session.completed.v1` is published.
5. **Review.** Recruiters read the transcript and the evaluation. An override (`evaluation:override`, with a reason) is stored append-only and republished as revision 2, 3, …

## The graph (PRD §2.4b)

`CONSENT → GREETING → ASK_QUESTION → LISTEN → (FOLLOW_UP | EVAL_TURN) → … → WRAP_UP → SCORING → END`

The global edges are CANDIDATE_QUESTION (approved FAQ only), REPEAT, OFF_TOPIC, PAUSE/RESUME/ABANDON and SAFETY. `graph/nodes.py` has one function per node; `graph/builder.py` holds the entry rule and the compiled `StateGraph`.

| Rule              | Behaviour                                                                                                                                                |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Probes            | At most 2 per question, chosen from the plan's approved probes                                                                                           |
| Silence           | 8 s nudge, 30 s offer to move on, 60 s next question                                                                                                     |
| STT confidence    | `avg_logprob < −1.0` or no-speech > 0.6: repeat (the turn is not scored); after 2 failures, offer text mode                                              |
| Pauses            | At most 2, of 120 s each; paused time does not count; a third drop or a timeout ends the interview as `abandoned`                                        |
| LLM latency       | Filler at 1.2 s, failover model at 3 s, else a deterministic reply from the plan. Core questions are always said verbatim                                |
| Input guardrails  | Injection, requests for answers or scores, and abuse: the turn is excluded and flagged (`interview.session.flagged.v1`); safety risks end the interview  |
| Output guardrails | Questions about age, religion, family, pregnancy, origin, race, disability or health, orientation, union or politics, or criminal record are never said  |
| Recommendation    | A failed knockout gives `do_not_advance`; evidenced weight under 0.5 gives `hold`; otherwise the weighted mean against thresholds (3.5 / 2.5 by default) |
| Human approval    | `do_not_advance` in a regulated jurisdiction (tenant `compliance.jurisdictions`: `us-nyc`, `eu`, `uk`, `ca-qc`, `us-il`, `us-co`) waits for a person     |

## Voice (`voice/`)

The agent turns 20 ms frames into an interview:

- **VAD:** Silero, with an energy VAD as fallback.
- **Endpointing:** 700 ms of silence plus a completeness check (fast route), or 2.5 s of silence.
- **STT:** faster-whisper large-v3.
- **Graph**, then **sentence-chunked streaming TTS** into the room.
- **Barge-in:** speech during playback stops TTS within 60 ms of speech. The cut-off utterances are marked `interrupted`.
- **Recordings:** a WAV per track, written to `t/{tid}/interviews/{sid}/` at the end.

The heavy adapters (livekit, torch/silero, faster-whisper, boto3) are in the optional `voice` dependency group and are imported lazily.

## Events

| Direction | Topic                             | Notes                                                                                                             |
| --------- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Produced  | `interview.session.completed.v1`  | Score ratio, review flag, recommendation, competency scores, revision (fixtures in `packages/contracts/fixtures`) |
| Produced  | `interview.session.flagged.v1`    | Injection, abuse, safety stop, blocked question; turn index only, never text                                      |
| Produced  | `privacy.erasure.acknowledged.v1` | When asked                                                                                                        |
| Consumed  | `assessment.session.started.v1`   | Allocation hint for KEDA when the assessment has had voice interviews                                             |
| Consumed  | `privacy.erasure.requested.v1`    | Deletes the candidate's sessions (everything cascades) and recordings                                             |
| Consumed  | `tenant.tenant.purged.v1`         | Deletes the tenant's interviews                                                                                   |

## Running

```bash
uv sync
uv run python -m interview_svc.main          # API (REST + text WebSocket + consumer + maintenance)
uv run python -m interview_svc.main worker   # voice agent worker (needs `uv sync --extra voice`, LiveKit, a GPU)
```

| Variable (`ATLAS_INTERVIEW_…`)                             | Purpose                                                              |
| ---------------------------------------------------------- | -------------------------------------------------------------------- |
| `DATABASE_URL`, `DB_APP_ROLE`                              | Postgres (migration 0015); the app role is under RLS                 |
| `JWT_ISSUER`, `JWKS_URL` (`JWT_SECRET` outside production) | Bearer tokens                                                        |
| `TOKEN_URL`, `CLIENT_ID`, `CLIENT_SECRET`                  | Service token: `llm:invoke`, `prompts:write`, `tenant-settings:read` |
| `GATEWAY_URL`, `TAXONOMY_URL`, `TENANT_URL`                | llm-gateway, taxonomy-svc, tenant-svc                                |
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`     | Room tokens                                                          |
| `WS_BASE_URL`                                              | Public WebSocket base (`wss://` in production)                       |
| `REDIS_URL`, `KAFKA_BROKERS`, `S3_BUCKET`                  | Hot state, events, recordings (all required in production)           |
| `TTS_URL`, `STT_MODEL`, `VAD`, `WORKER_CAPACITY`           | Agent worker                                                         |
| `CALIBRATION=on`                                           | Routes the final scorer to the eval model (calibration runs)         |

Infrastructure: [`infra/livekit/livekit.yaml`](../../infra/livekit/livekit.yaml) and the Helm chart [`infra/k8s/interview`](../../infra/k8s/interview). The chart covers the API, GPU agent workers, KEDA on `interview_pending_sessions()`, network policies and LiveKit.

## Tests

`make py-verify` runs ruff, `mypy --strict` and pytest against a real Postgres (pgserver). There are 170 tests at 96% coverage, and 33 of 33 seeded mutations are caught.

- **Domain:** plan validation; red-team sets for the illegal-question filter (34 blocked, 9 job-related questions that must pass); injection attempts; silence, confidence and intent rules; citations; the recommendation matrix.
- **Graph:** every node on its own, the entry rule, and the compiled graph's path through the state machine.
- **Sessions:**
  - a scripted 3-question interview end to end, with the transcript and checkpoints persisted;
  - a crash mid-turn, resumed on another worker, with the dead worker locked out;
  - an LLM timeout that plays a filler and continues from the plan;
  - an injection flagged and never scored;
  - a hostile model that never gets a blocked question out;
  - invented citations becoming "insufficient evidence";
  - pauses, abandonment and scorer retries;
  - the event contract fixtures that assessment-svc replays.
- **HTTP and WebSocket:** the plan lifecycle, idempotent sessions, LiveKit token claims, the transcript, evaluation and override, text mode over a WebSocket, and a dropped socket pausing the interview.
- **Voice:**
  - recorded WAV fixtures through a fake LiveKit room complete the interview;
  - barge-in stops speech within 150 ms;
  - low-confidence audio is repeated, then text mode is offered;
  - silence brings a nudge;
  - workers claim sessions and hand over after a crash.
- **Calibration:** `eval/calibration.py` computes quadratic-weighted κ between human raters and the scorer (gate ≥ 0.7).

## Gaps

- **Not run here:** real LiveKit, Silero, faster-whisper and TTS. They need a media server and GPUs, and their adapters are thin and excluded from coverage.
- **Not measured:** turn latency (p95 ≤ 1.5 s), 2k concurrent interviews per cell, STT real-time factor ≤ 0.2, and κ ≥ 0.7 on a real calibration set. These need a cell and human raters.
- **Recordings** are WAV per track written by the agent, not LiveKit egress (Opus per track).
