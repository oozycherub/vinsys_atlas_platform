"""Ports: what the application needs from the outside world (hexagonal rule, §4.1)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal, Protocol

from atlas_platform.db import Tx

from interview_svc.domain.state import InterviewState, Turn, Utterance


class Clock(Protocol):
    def now(self) -> datetime: ...


class UpstreamError(Exception):
    """A dependency failed or timed out (retryable)."""


# --- LLM roles (through llm-gateway) -------------------------------------------------------


@dataclass(frozen=True)
class InterviewerRequest:
    tenant_id: str
    task: Literal['ask', 'decide']
    language: str
    competency: str
    question: str
    probes: tuple[str, ...]
    probes_remaining: int
    recent_turns: tuple[tuple[str, str], ...]  # (role, text), oldest first, at most 6
    first_question: bool


@dataclass(frozen=True)
class InterviewerReply:
    action: Literal['ask', 'probe', 'next', 'redirect']
    utterance: str
    probe_index: int | None = None
    source: Literal['fast', 'failover', 'fallback'] = 'fast'
    filler: bool = False


FillerSink = Callable[[], Awaitable[None]]


class Interviewer(Protocol):
    """The next utterance. Implementations must never raise: they fall back to the plan."""

    async def respond(self, req: InterviewerRequest, on_filler: FillerSink) -> InterviewerReply: ...


class LlmGateway(Protocol):
    """POST /v1/llm/messages with a registered prompt; returns the JSON `output`."""

    async def complete(
        self,
        tenant_id: str,
        purpose: str,
        prompt: str,
        variables: dict[str, str],
        known_pii: Sequence[str] = (),
    ) -> dict[str, Any]: ...

    async def register_prompts(self, prompts: Sequence[dict[str, Any]]) -> None: ...


@dataclass(frozen=True)
class TurnEvaluation:
    qid: str
    evidence: list[dict[str, Any]]
    provisional_level: int | None
    model: str | None = None


@dataclass(frozen=True)
class ScorerOutput:
    competencies: list[dict[str, Any]]
    model: str | None = None


# --- Graph context ---------------------------------------------------------------------------


class Scoring(Protocol):
    """Runs SCORING for a session (idempotent); returns the evaluation summary for the state."""

    async def score(self, state: InterviewState) -> dict[str, Any]: ...


@dataclass
class GraphContext:
    plan: Any  # domain.plan.Plan
    title: str
    interviewer: Interviewer
    scoring: Scoring
    # Plays a filler immediately (before the node finishes), with an id the node will reuse.
    say_now: Callable[[Utterance], Awaitable[None]]


# --- Persistence -----------------------------------------------------------------------------


@dataclass(frozen=True)
class SessionRow:
    tenant_id: str
    session_id: str
    interview_id: str
    plan_version: int
    assessment_id: str
    assessment_session_id: str
    question_id: str
    candidate_id: str
    mode: Literal['voice', 'text']
    status: str
    phase: str
    jurisdictions: tuple[str, ...]
    checkpoint_seq: int
    worker_id: str | None
    lease_expires_at: datetime | None
    turns_flushed: int
    started_at: datetime | None
    ended_at: datetime | None
    paused_at: datetime | None
    recording_key: str | None
    created_at: datetime


@dataclass(frozen=True)
class Checkpoint:
    seq: int
    node: str
    state: InterviewState


class HotState(Protocol):
    """Redis copy of the latest checkpoint (`t:{tid}:iv:{sid}`, TTL 2 h)."""

    async def get(self, tenant_id: str, session_id: str) -> Checkpoint | None: ...

    async def put(self, tenant_id: str, session_id: str, checkpoint: Checkpoint) -> None: ...

    async def drop(self, tenant_id: str, session_id: str) -> None: ...


class Recorder(Protocol):
    """Interview audio, finalised to `t/{tid}/interviews/{sid}/` at WRAP_UP."""

    async def finalize(self, tenant_id: str, session_id: str, tracks: dict[str, bytes]) -> str: ...

    async def delete(self, keys: Sequence[str]) -> None: ...


class Tenants(Protocol):
    async def jurisdictions(self, tenant_id: str) -> list[str]: ...


@dataclass(frozen=True)
class JobProfile:
    job_profile_id: str
    title: str
    description: str
    skills: list[dict[str, Any]] = field(
        default_factory=list
    )  # {skill_id, name, weight, must_have}


class Taxonomy(Protocol):
    async def job_profile(self, tenant_id: str, job_profile_id: str) -> JobProfile | None: ...


class RoomTokens(Protocol):
    """LiveKit access tokens (room-scoped, short-lived)."""

    url: str

    def candidate(self, room: str, identity: str, ttl_s: int) -> str: ...

    def agent(self, room: str, identity: str, ttl_s: int) -> str: ...


class Outbox(Protocol):
    async def append(
        self,
        tx: Tx,
        *,
        topic: str,
        tenant_id: str | None,
        aggregate_type: str,
        aggregate_id: str,
        payload: dict[str, Any],
    ) -> str: ...


class Store(Protocol):
    """Persistence (implemented by infrastructure.repositories.PgStore)."""

    async def insert_interview(self, tx: Tx, row: dict[str, Any]) -> None: ...

    async def get_interview(self, tx: Tx, interview_id: str) -> dict[str, Any] | None: ...

    async def update_interview(
        self, tx: Tx, interview_id: str, lock_version: int, fields: dict[str, Any]
    ) -> bool: ...

    async def insert_plan(
        self,
        tx: Tx,
        *,
        tenant_id: str,
        interview_id: str,
        version: int,
        plan: dict[str, Any],
        source: str,
        by: str,
    ) -> None: ...

    async def plans(self, tx: Tx, interview_id: str) -> list[dict[str, Any]]: ...

    async def get_plan(self, tx: Tx, interview_id: str, version: int) -> dict[str, Any] | None: ...

    async def replace_draft(
        self, tx: Tx, interview_id: str, version: int, plan: dict[str, Any], source: str, by: str
    ) -> bool: ...

    async def publish_plan(
        self, tx: Tx, interview_id: str, version: int, by: str, at: datetime
    ) -> None: ...

    async def insert_session(self, tx: Tx, row: dict[str, Any]) -> None: ...

    async def session(self, tx: Tx, session_id: str) -> SessionRow | None: ...

    async def session_for_question(
        self, tx: Tx, assessment_session_id: str, question_id: str
    ) -> SessionRow | None: ...

    async def session_by_token(self, tx: Tx, token_hash: bytes) -> SessionRow | None: ...

    async def reissue_token(self, tx: Tx, session_id: str, token_hash: bytes) -> None: ...

    async def want_worker(self, tx: Tx, session_id: str) -> None: ...

    async def acquire_lease(
        self, tx: Tx, session_id: str, worker_id: str, ttl_s: int
    ) -> SessionRow | None: ...

    async def claim_voice(
        self, tx: Tx, worker_id: str, ttl_s: int, limit: int
    ) -> list[SessionRow]: ...

    async def renew_lease(self, tx: Tx, session_id: str, worker_id: str, ttl_s: int) -> bool: ...

    async def release_lease(self, tx: Tx, session_id: str, worker_id: str) -> None: ...

    async def save_checkpoint(
        self,
        tx: Tx,
        *,
        session: SessionRow,
        seq: int,
        node: str,
        state: InterviewState,
        worker_id: str,
        status: str,
        started_at: datetime | None,
        ended_at: datetime | None,
        paused_at: datetime | None,
    ) -> bool: ...

    async def latest_checkpoint(self, tx: Tx, session_id: str) -> Checkpoint | None: ...

    async def flush_turns(
        self, tx: Tx, session: SessionRow, turns: Sequence[Turn], start: int
    ) -> None: ...

    async def turns(self, tx: Tx, session_id: str) -> list[dict[str, Any]]: ...

    async def set_recording(self, tx: Tx, session_id: str, key: str) -> None: ...

    async def delete_candidate(self, tx: Tx, candidate_id: str) -> tuple[int, list[str]]: ...

    async def expired_pauses(
        self, tx: Tx, older_than: datetime, limit: int
    ) -> list[SessionRow]: ...

    async def stalled(self, tx: Tx, limit: int) -> list[SessionRow]: ...

    async def expire_demand(self, tx: Tx) -> int: ...

    async def assessment_has_voice(self, tx: Tx, assessment_id: str) -> bool: ...

    async def add_demand(
        self,
        tx: Tx,
        tenant_id: str,
        assessment_session_id: str,
        assessment_id: str,
        until: datetime,
    ) -> None: ...

    async def remove_demand(self, tx: Tx, assessment_session_id: str) -> None: ...

    async def upsert_turn_evaluation(
        self,
        tx: Tx,
        tenant_id: str,
        session_id: str,
        qid: str,
        evidence: list[dict[str, Any]],
        level: int | None,
        model: str | None,
    ) -> None: ...

    async def turn_evaluations(self, tx: Tx, session_id: str) -> dict[str, dict[str, Any]]: ...

    async def evaluation(self, tx: Tx, session_id: str) -> dict[str, Any] | None: ...

    async def insert_evaluation(self, tx: Tx, tenant_id: str, ev: dict[str, Any]) -> bool: ...

    async def update_evaluation(
        self, tx: Tx, session_id: str, revision: int, ev: dict[str, Any]
    ) -> bool: ...

    async def insert_override(self, tx: Tx, row: dict[str, Any]) -> None: ...

    async def overrides(self, tx: Tx, session_id: str) -> list[dict[str, Any]]: ...

    async def purge_tenant(self, tx: Tx) -> dict[str, int]: ...
