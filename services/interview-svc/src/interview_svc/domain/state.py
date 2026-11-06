"""The interview graph's state (PRD §2.4b `InterviewState`), JSON-serialisable so it can be
checkpointed after every node, plus the input events that drive it."""

from __future__ import annotations

from typing import Any, Literal, NotRequired, TypedDict

Phase = Literal[
    'CONSENT',
    'GREETING',
    'ASK_QUESTION',
    'LISTEN',
    'FOLLOW_UP',
    'EVAL_TURN',
    'WRAP_UP',
    'SCORING',
    'PAUSED',
    'END',
]
Outcome = Literal['completed', 'declined', 'escalated', 'abandoned']
EventType = Literal[
    'start', 'consent', 'utterance', 'silence', 'disconnect', 'rejoin', 'pause_timeout'
]
AWAIT = 'AWAIT'  # `next` when the graph waits for the candidate


class Event(TypedDict):
    id: str
    type: EventType
    at_ms: int  # session clock (ms since the session started)
    accepted: NotRequired[bool]
    text: NotRequired[str]
    t0_ms: NotRequired[int]
    t1_ms: NotRequired[int]
    avg_logprob: NotRequired[float | None]
    no_speech_prob: NotRequired[float | None]
    silent_ms: NotRequired[int]


class Utterance(TypedDict):
    id: str  # '{session_id}:{n}': stable across replays of the node that said it
    text: str
    kind: str
    qid: str | None


class Turn(TypedDict):
    index: int
    role: Literal['interviewer', 'candidate']
    kind: str
    qid: str | None
    text: str
    t0_ms: int
    t1_ms: int
    stt_conf: float | None
    interrupted: bool
    excluded: bool
    flags: list[str]
    utterance_id: str | None


class Emit(TypedDict):
    flag: str
    turn_index: int | None
    ended: bool


class InterviewState(TypedDict):
    session_id: str
    tenant_id: str
    mode: Literal['voice', 'text']
    phase: Phase
    next: str
    event: Event | None
    q_index: int
    probes_used: int
    draft: dict[str, Any] | None  # the interviewer's decided follow-up, spoken by FOLLOW_UP
    turns: list[Turn]
    outbox: list[Utterance]  # said during the current invocation
    emits: list[Emit]  # flagged events for the outbox, written with the next checkpoint
    pending_evals: list[str]  # qids for the turn evaluator
    knockouts: dict[str, Literal['pass', 'fail', 'unclear']]
    elapsed_ms: int  # active interview time (pauses excluded)
    clock_ms: int  # session clock at the last event
    silence_stage: int
    repeat_failures: int
    text_offered: bool
    pauses: int
    paused_at_ms: int | None
    phase_before_pause: Phase | None
    flags: list[str]
    outcome: Outcome | None
    utterances: int  # utterance id counter
    evaluation: dict[str, Any] | None


def initial_state(
    session_id: str, tenant_id: str, mode: Literal['voice', 'text']
) -> InterviewState:
    return {
        'session_id': session_id,
        'tenant_id': tenant_id,
        'mode': mode,
        'phase': 'CONSENT',
        'next': AWAIT,
        'event': None,
        'q_index': 0,
        'probes_used': 0,
        'draft': None,
        'turns': [],
        'outbox': [],
        'emits': [],
        'pending_evals': [],
        'knockouts': {},
        'elapsed_ms': 0,
        'clock_ms': 0,
        'silence_stage': 0,
        'repeat_failures': 0,
        'text_offered': False,
        'pauses': 0,
        'paused_at_ms': None,
        'phase_before_pause': None,
        'flags': [],
        'outcome': None,
        'utterances': 0,
        'evaluation': None,
    }
