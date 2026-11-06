"""Postgres persistence (SQL first, ADR-0004). Every method runs in the caller's transaction:
tenant transactions for tenant data (RLS), system transactions only for token lookups, lease
claims and maintenance scans."""

from __future__ import annotations

import json
from collections.abc import Sequence
from datetime import datetime
from typing import Any, cast

from atlas_platform.db import Tx
from psycopg.types.json import Jsonb

from interview_svc.application.ports import Checkpoint, SessionRow
from interview_svc.domain.state import InterviewState, Turn

_SESSION_COLUMNS = """tenant_id::text, session_id::text, interview_id::text, plan_version,
  assessment_id::text, assessment_session_id::text, question_id::text, candidate_id::text, mode,
  status, phase, jurisdictions, checkpoint_seq, worker_id, lease_expires_at, turns_flushed,
  started_at, ended_at, paused_at, recording_key, created_at"""


def _session(r: dict[str, Any]) -> SessionRow:
    return SessionRow(
        tenant_id=r['tenant_id'],
        session_id=r['session_id'],
        interview_id=r['interview_id'],
        plan_version=r['plan_version'],
        assessment_id=r['assessment_id'],
        assessment_session_id=r['assessment_session_id'],
        question_id=r['question_id'],
        candidate_id=r['candidate_id'],
        mode=r['mode'],
        status=r['status'],
        phase=r['phase'],
        jurisdictions=tuple(r['jurisdictions'] or ()),
        checkpoint_seq=r['checkpoint_seq'],
        worker_id=r['worker_id'],
        lease_expires_at=r['lease_expires_at'],
        turns_flushed=r['turns_flushed'],
        started_at=r['started_at'],
        ended_at=r['ended_at'],
        paused_at=r['paused_at'],
        recording_key=r['recording_key'],
        created_at=r['created_at'],
    )


def _json(value: Any) -> Any:
    """jsonb read back by psycopg is already decoded; text is decoded here."""
    return json.loads(value) if isinstance(value, str) else value


class PgStore:
    # --- interviews and plans ----------------------------------------------------------------

    async def insert_interview(self, tx: Tx, row: dict[str, Any]) -> None:
        await tx.execute(
            """INSERT INTO interviews (tenant_id, interview_id, job_profile_id, title, mode, language,
                 thresholds, created_by)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""",
            (
                row['tenant_id'],
                row['interview_id'],
                row['job_profile_id'],
                row['title'],
                row['mode'],
                row['language'],
                Jsonb(row['thresholds']),
                row['created_by'],
            ),
        )

    async def get_interview(self, tx: Tx, interview_id: str) -> dict[str, Any] | None:
        rows = await tx.fetch(
            """SELECT tenant_id::text, interview_id::text, job_profile_id::text, title, mode, language,
                      status, published_version, thresholds, created_by, created_at, updated_at,
                      lock_version
               FROM interviews WHERE interview_id = %s""",
            (interview_id,),
        )
        if not rows:
            return None
        row = rows[0]
        row['thresholds'] = _json(row['thresholds'])
        return row

    async def update_interview(
        self, tx: Tx, interview_id: str, lock_version: int, fields: dict[str, Any]
    ) -> bool:
        allowed = {'title', 'status', 'published_version', 'thresholds'}
        sets = [f'{k} = %s' for k in fields if k in allowed]
        values = [Jsonb(v) if k == 'thresholds' else v for k, v in fields.items() if k in allowed]
        count = await tx.execute(
            f"""UPDATE interviews SET {', '.join(sets)}, lock_version = lock_version + 1
                WHERE interview_id = %s AND lock_version = %s""",  # noqa: S608 - fixed column names
            (*values, interview_id, lock_version),
        )
        return count == 1

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
    ) -> None:
        await tx.execute(
            """INSERT INTO interview_plans (tenant_id, interview_id, version, plan, source, created_by)
               VALUES (%s, %s, %s, %s, %s, %s)""",
            (tenant_id, interview_id, version, Jsonb(plan), source, by),
        )

    async def plans(self, tx: Tx, interview_id: str) -> list[dict[str, Any]]:
        rows = await tx.fetch(
            """SELECT version, status, plan, source, created_by, created_at, published_at, published_by
               FROM interview_plans WHERE interview_id = %s ORDER BY version DESC""",
            (interview_id,),
        )
        for r in rows:
            r['plan'] = _json(r['plan'])
        return rows

    async def get_plan(self, tx: Tx, interview_id: str, version: int) -> dict[str, Any] | None:
        rows = await tx.fetch(
            'SELECT plan FROM interview_plans WHERE interview_id = %s AND version = %s',
            (interview_id, version),
        )
        return cast(dict[str, Any], _json(rows[0]['plan'])) if rows else None

    async def replace_draft(
        self, tx: Tx, interview_id: str, version: int, plan: dict[str, Any], source: str, by: str
    ) -> bool:
        count = await tx.execute(
            """UPDATE interview_plans SET plan = %s, source = %s, created_by = %s
               WHERE interview_id = %s AND version = %s AND status = 'draft'""",
            (Jsonb(plan), source, by, interview_id, version),
        )
        return count == 1

    async def publish_plan(
        self, tx: Tx, interview_id: str, version: int, by: str, at: datetime
    ) -> None:
        await tx.execute(
            """UPDATE interview_plans SET status = 'superseded'
               WHERE interview_id = %s AND status = 'published'""",
            (interview_id,),
        )
        await tx.execute(
            """UPDATE interview_plans SET status = 'published', published_at = %s, published_by = %s
               WHERE interview_id = %s AND version = %s AND status = 'draft'""",
            (at, by, interview_id, version),
        )

    # --- sessions ----------------------------------------------------------------------------

    async def insert_session(self, tx: Tx, row: dict[str, Any]) -> None:
        await tx.execute(
            """INSERT INTO interview_sessions (tenant_id, session_id, interview_id, plan_version,
                 assessment_id, assessment_session_id, question_id, candidate_id, mode, token_hash,
                 jurisdictions)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (
                row['tenant_id'],
                row['session_id'],
                row['interview_id'],
                row['plan_version'],
                row['assessment_id'],
                row['assessment_session_id'],
                row['question_id'],
                row['candidate_id'],
                row['mode'],
                row['token_hash'],
                list(row['jurisdictions']),
            ),
        )

    async def session(self, tx: Tx, session_id: str) -> SessionRow | None:
        rows = await tx.fetch(
            f'SELECT {_SESSION_COLUMNS} FROM interview_sessions WHERE session_id = %s',  # noqa: S608
            (session_id,),
        )
        return _session(rows[0]) if rows else None

    async def session_for_question(
        self, tx: Tx, assessment_session_id: str, question_id: str
    ) -> SessionRow | None:
        rows = await tx.fetch(
            f"""SELECT {_SESSION_COLUMNS} FROM interview_sessions
                WHERE assessment_session_id = %s AND question_id = %s""",  # noqa: S608
            (assessment_session_id, question_id),
        )
        return _session(rows[0]) if rows else None

    async def session_by_token(self, tx: Tx, token_hash: bytes) -> SessionRow | None:
        """System transaction: the token is the only key the candidate has."""
        rows = await tx.fetch(
            f'SELECT {_SESSION_COLUMNS} FROM interview_sessions WHERE token_hash = %s',  # noqa: S608
            (token_hash,),
        )
        return _session(rows[0]) if rows else None

    async def reissue_token(self, tx: Tx, session_id: str, token_hash: bytes) -> None:
        await tx.execute(
            'UPDATE interview_sessions SET token_hash = %s WHERE session_id = %s',
            (token_hash, session_id),
        )

    async def want_worker(self, tx: Tx, session_id: str) -> None:
        await tx.execute(
            'UPDATE interview_sessions SET wants_worker = true WHERE session_id = %s', (session_id,)
        )

    async def acquire_lease(
        self, tx: Tx, session_id: str, worker_id: str, ttl_s: int
    ) -> SessionRow | None:
        """System transaction. Takes the lease when it is free, lapsed, or already ours."""
        rows = await tx.fetch(
            f"""UPDATE interview_sessions
                SET worker_id = %s, lease_expires_at = now() + make_interval(secs => %s)
                WHERE session_id = %s
                  AND status IN ('created', 'active', 'paused', 'scoring')
                  AND (worker_id IS NULL OR worker_id = %s OR lease_expires_at < now())
                RETURNING {_SESSION_COLUMNS}""",  # noqa: S608
            (worker_id, ttl_s, session_id, worker_id),
        )
        return _session(rows[0]) if rows else None

    async def claim_voice(self, tx: Tx, worker_id: str, ttl_s: int, limit: int) -> list[SessionRow]:
        """System transaction: voice sessions waiting for an agent, oldest first."""
        rows = await tx.fetch(
            f"""UPDATE interview_sessions s
                SET worker_id = %s, lease_expires_at = now() + make_interval(secs => %s)
                FROM (SELECT session_id FROM interview_sessions
                      WHERE wants_worker AND status IN ('created', 'active', 'paused', 'scoring')
                        AND (lease_expires_at IS NULL OR lease_expires_at < now())
                      ORDER BY created_at LIMIT %s FOR UPDATE SKIP LOCKED) c
                WHERE s.session_id = c.session_id
                RETURNING {', '.join('s.' + c.strip() for c in _SESSION_COLUMNS.split(','))}""",  # noqa: S608
            (worker_id, ttl_s, limit),
        )
        return [_session(r) for r in rows]

    async def renew_lease(self, tx: Tx, session_id: str, worker_id: str, ttl_s: int) -> bool:
        count = await tx.execute(
            """UPDATE interview_sessions SET lease_expires_at = now() + make_interval(secs => %s)
               WHERE session_id = %s AND worker_id = %s""",
            (ttl_s, session_id, worker_id),
        )
        return count == 1

    async def release_lease(self, tx: Tx, session_id: str, worker_id: str) -> None:
        await tx.execute(
            """UPDATE interview_sessions SET worker_id = NULL, lease_expires_at = NULL
               WHERE session_id = %s AND worker_id = %s""",
            (session_id, worker_id),
        )

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
    ) -> bool:
        """Writes the checkpoint and the session's projection, if this worker still holds the
        lease (False otherwise: another worker took over and this one must stop)."""
        count = await tx.execute(
            """UPDATE interview_sessions
               SET checkpoint_seq = %s, phase = %s, status = %s, started_at = %s, ended_at = %s,
                   paused_at = %s, wants_worker = wants_worker AND %s::text NOT IN
                     ('completed', 'declined', 'escalated', 'abandoned')
               WHERE session_id = %s AND worker_id = %s AND checkpoint_seq = %s
                 AND lease_expires_at > now()""",
            (
                seq,
                state['phase'],
                status,
                started_at,
                ended_at,
                paused_at,
                status,
                session.session_id,
                worker_id,
                seq - 1,
            ),
        )
        if count != 1:
            return False
        await tx.execute(
            """INSERT INTO interview_checkpoints (tenant_id, session_id, seq, node, state, worker_id)
               VALUES (%s, %s, %s, %s, %s, %s)""",
            (session.tenant_id, session.session_id, seq, node, Jsonb(state), worker_id),
        )
        return True

    async def latest_checkpoint(self, tx: Tx, session_id: str) -> Checkpoint | None:
        rows = await tx.fetch(
            """SELECT seq, node, state FROM interview_checkpoints WHERE session_id = %s
               ORDER BY seq DESC LIMIT 1""",
            (session_id,),
        )
        if not rows:
            return None
        return Checkpoint(
            seq=rows[0]['seq'],
            node=rows[0]['node'],
            state=cast(InterviewState, _json(rows[0]['state'])),
        )

    async def flush_turns(
        self, tx: Tx, session: SessionRow, turns: Sequence[Turn], start: int
    ) -> None:
        """Upserts turns from `start` (flags such as `interrupted` can change after a flush)."""
        for t in turns[start:]:
            await tx.execute(
                """INSERT INTO interview_turns (tenant_id, session_id, turn_index, role, kind, qid,
                     text, t0_ms, t1_ms, stt_conf, interrupted, excluded, flags)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (session_id, turn_index) DO UPDATE
                   SET interrupted = EXCLUDED.interrupted, excluded = EXCLUDED.excluded,
                       flags = EXCLUDED.flags""",
                (
                    session.tenant_id,
                    session.session_id,
                    t['index'],
                    t['role'],
                    t['kind'],
                    t['qid'],
                    t['text'],
                    t['t0_ms'],
                    t['t1_ms'],
                    t['stt_conf'],
                    t['interrupted'],
                    t['excluded'],
                    t['flags'],
                ),
            )
        await tx.execute(
            'UPDATE interview_sessions SET turns_flushed = GREATEST(turns_flushed, %s) WHERE session_id = %s',
            (len(turns), session.session_id),
        )

    async def turns(self, tx: Tx, session_id: str) -> list[dict[str, Any]]:
        return await tx.fetch(
            """SELECT turn_index AS index, role, kind, qid, text, t0_ms, t1_ms, stt_conf,
                      interrupted, excluded, flags
               FROM interview_turns WHERE session_id = %s ORDER BY turn_index""",
            (session_id,),
        )

    async def set_recording(self, tx: Tx, session_id: str, key: str) -> None:
        await tx.execute(
            'UPDATE interview_sessions SET recording_key = %s WHERE session_id = %s',
            (key, session_id),
        )

    async def delete_candidate(self, tx: Tx, candidate_id: str) -> tuple[int, list[str]]:
        """Erasure: the candidate's sessions (everything below cascades). Returns the count and
        the recording keys to delete from object storage."""
        rows = await tx.fetch(
            'DELETE FROM interview_sessions WHERE candidate_id = %s RETURNING recording_key',
            (candidate_id,),
        )
        return len(rows), [r['recording_key'] for r in rows if r['recording_key']]

    # --- maintenance scans (system transactions) ---------------------------------------------

    async def expired_pauses(self, tx: Tx, older_than: datetime, limit: int) -> list[SessionRow]:
        rows = await tx.fetch(
            f"""SELECT {_SESSION_COLUMNS} FROM interview_sessions
                WHERE status = 'paused' AND paused_at < %s
                  AND (lease_expires_at IS NULL OR lease_expires_at < now())
                ORDER BY paused_at LIMIT %s""",  # noqa: S608
            (older_than, limit),
        )
        return [_session(r) for r in rows]

    async def stalled(self, tx: Tx, limit: int) -> list[SessionRow]:
        """Sessions whose worker died mid-SCORING (text sessions have no agent to reclaim them)."""
        rows = await tx.fetch(
            f"""SELECT {_SESSION_COLUMNS} FROM interview_sessions
                WHERE status = 'scoring' AND (lease_expires_at IS NULL OR lease_expires_at < now())
                ORDER BY created_at LIMIT %s""",  # noqa: S608
            (limit,),
        )
        return [_session(r) for r in rows]

    async def expire_demand(self, tx: Tx) -> int:
        return await tx.execute('DELETE FROM interview_demand WHERE expires_at < now()')

    # --- demand ------------------------------------------------------------------------------

    async def assessment_has_voice(self, tx: Tx, assessment_id: str) -> bool:
        rows = await tx.fetch(
            """SELECT 1 FROM interview_sessions WHERE assessment_id = %s AND mode = 'voice' LIMIT 1""",
            (assessment_id,),
        )
        return bool(rows)

    async def add_demand(
        self,
        tx: Tx,
        tenant_id: str,
        assessment_session_id: str,
        assessment_id: str,
        until: datetime,
    ) -> None:
        await tx.execute(
            """INSERT INTO interview_demand (tenant_id, assessment_session_id, assessment_id, expires_at)
               VALUES (%s, %s, %s, %s) ON CONFLICT (assessment_session_id) DO NOTHING""",
            (tenant_id, assessment_session_id, assessment_id, until),
        )

    async def remove_demand(self, tx: Tx, assessment_session_id: str) -> None:
        await tx.execute(
            'DELETE FROM interview_demand WHERE assessment_session_id = %s',
            (assessment_session_id,),
        )

    # --- evaluations -------------------------------------------------------------------------

    async def upsert_turn_evaluation(
        self,
        tx: Tx,
        tenant_id: str,
        session_id: str,
        qid: str,
        evidence: list[dict[str, Any]],
        level: int | None,
        model: str | None,
    ) -> None:
        await tx.execute(
            """INSERT INTO interview_turn_evaluations (tenant_id, session_id, qid, evidence,
                 provisional_level, model)
               VALUES (%s, %s, %s, %s, %s, %s)
               ON CONFLICT (session_id, qid) DO UPDATE SET evidence = EXCLUDED.evidence,
                 provisional_level = EXCLUDED.provisional_level, model = EXCLUDED.model""",
            (tenant_id, session_id, qid, Jsonb(evidence), level, model),
        )

    async def turn_evaluations(self, tx: Tx, session_id: str) -> dict[str, dict[str, Any]]:
        rows = await tx.fetch(
            """SELECT qid, evidence, provisional_level FROM interview_turn_evaluations
               WHERE session_id = %s""",
            (session_id,),
        )
        return {
            r['qid']: {
                'evidence': _json(r['evidence']),
                'provisional_level': r['provisional_level'],
            }
            for r in rows
        }

    async def evaluation(self, tx: Tx, session_id: str) -> dict[str, Any] | None:
        rows = await tx.fetch(
            """SELECT session_id::text, revision, competencies, weighted_score::float8 AS weighted_score,
                      recommendation, requires_approval, approved_by, approved_at, flags, model,
                      created_at, updated_at
               FROM interview_evaluations WHERE session_id = %s""",
            (session_id,),
        )
        if not rows:
            return None
        row = rows[0]
        row['competencies'] = _json(row['competencies'])
        return row

    async def insert_evaluation(self, tx: Tx, tenant_id: str, ev: dict[str, Any]) -> bool:
        count = await tx.execute(
            """INSERT INTO interview_evaluations (tenant_id, session_id, competencies, weighted_score,
                 recommendation, requires_approval, flags, model)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT (session_id) DO NOTHING""",
            (
                tenant_id,
                ev['session_id'],
                Jsonb(ev['competencies']),
                ev['weighted_score'],
                ev['recommendation'],
                ev['requires_approval'],
                list(ev['flags']),
                ev.get('model'),
            ),
        )
        return count == 1

    async def update_evaluation(
        self, tx: Tx, session_id: str, revision: int, ev: dict[str, Any]
    ) -> bool:
        count = await tx.execute(
            """UPDATE interview_evaluations
               SET revision = revision + 1, competencies = %s, weighted_score = %s,
                   recommendation = %s, requires_approval = false, approved_by = %s,
                   approved_at = %s
               WHERE session_id = %s AND revision = %s""",
            (
                Jsonb(ev['competencies']),
                ev['weighted_score'],
                ev['recommendation'],
                ev['approved_by'],
                ev['approved_at'],
                session_id,
                revision,
            ),
        )
        return count == 1

    async def insert_override(self, tx: Tx, row: dict[str, Any]) -> None:
        await tx.execute(
            """INSERT INTO evaluation_overrides (tenant_id, override_id, session_id, by_user, reason,
                 before, after)
               VALUES (%s, %s, %s, %s, %s, %s, %s)""",
            (
                row['tenant_id'],
                row['override_id'],
                row['session_id'],
                row['by_user'],
                row['reason'],
                Jsonb(row['before']),
                Jsonb(row['after']),
            ),
        )

    async def overrides(self, tx: Tx, session_id: str) -> list[dict[str, Any]]:
        return await tx.fetch(
            """SELECT override_id::text, by_user, reason, before, after, created_at
               FROM evaluation_overrides WHERE session_id = %s ORDER BY created_at""",
            (session_id,),
        )

    async def purge_tenant(self, tx: Tx) -> dict[str, int]:
        out: dict[str, int] = {}
        for table in ('interview_demand', 'interview_sessions', 'interviews'):
            out[table] = await tx.execute(
                f'DELETE FROM {table} WHERE tenant_id = current_tenant_id()'  # noqa: S608 - fixed names
            )
        return out
