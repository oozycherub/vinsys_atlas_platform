"""Use cases behind the HTTP API (PRD §2.4b "APIs", §2.4c data flow)."""

from __future__ import annotations

import hashlib
import json
import secrets
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Literal

from atlas_platform.db import Database
from atlas_platform.ids import uuid7

from interview_svc.application.ports import (
    Clock,
    LlmGateway,
    Outbox,
    RoomTokens,
    SessionRow,
    Store,
    Taxonomy,
    Tenants,
)
from interview_svc.application.runner import ENDED_STATUSES
from interview_svc.application.scoring import COMPLETED_TOPIC, completed_payload
from interview_svc.domain.errors import InterviewError, PlanError
from interview_svc.domain.plan import parse_plan, plan_to_dict
from interview_svc.domain.scoring import DEFAULT_THRESHOLDS
from interview_svc.prompts import PLANNER, PURPOSE_PLANNING

TOKEN_PREFIX = 'ivt_'  # noqa: S105 - a prefix, not a secret
LIVEKIT_TTL_S = 600  # PRD: LiveKit token TTL 10 min
MANAGE_ROLES = frozenset({'recruiter', 'hiring_manager', 'tenant_admin', 'super_admin'})
REVIEW_ROLES = MANAGE_ROLES | {'reviewer'}


@dataclass(frozen=True)
class Actor:
    subject: str
    tenant_id: str
    roles: frozenset[str]

    def require(self, roles: frozenset[str]) -> None:
        if not self.roles & roles:
            raise InterviewError('forbidden', 'FORBIDDEN', 'Your role cannot do this.')


def hash_token(token: str) -> bytes:
    return hashlib.sha256(token.encode()).digest()


def new_token() -> str:
    return TOKEN_PREFIX + secrets.token_urlsafe(32)


def _not_found(what: str) -> InterviewError:
    code = what.upper().replace(' ', '_')
    return InterviewError('not_found', f'{code}_NOT_FOUND', f'{what.capitalize()} not found.')


def interview_view(row: dict[str, Any], plans: Sequence[dict[str, Any]]) -> dict[str, Any]:
    latest = plans[0] if plans else None
    return {
        'interview_id': row['interview_id'],
        'tenant_id': row['tenant_id'],
        'job_profile_id': row['job_profile_id'],
        'title': row['title'],
        'mode': row['mode'],
        'language': row['language'],
        'status': row['status'],
        'published_version': row['published_version'],
        'thresholds': row['thresholds'],
        'plan': None
        if latest is None
        else {
            'version': latest['version'],
            'status': latest['status'],
            'source': latest['source'],
            'plan': latest['plan'],
        },
        'versions': [{'version': p['version'], 'status': p['status']} for p in plans],
        'created_at': row['created_at'].isoformat(),
        'updated_at': row['updated_at'].isoformat(),
    }


def _thresholds(raw: dict[str, float] | None) -> dict[str, float]:
    t = {**DEFAULT_THRESHOLDS, **(raw or {})}
    if not 1 <= t['hold'] <= t['advance'] <= 5:
        raise InterviewError(
            'validation', 'INVALID_THRESHOLDS', 'Thresholds need 1 <= hold <= advance <= 5.'
        )
    return {'advance': float(t['advance']), 'hold': float(t['hold'])}


class InterviewService:
    def __init__(
        self,
        *,
        db: Database,
        store: Store,
        outbox: Outbox,
        llm: LlmGateway,
        taxonomy: Taxonomy,
        tenants: Tenants,
        rooms: RoomTokens,
        clock: Clock,
        ws_base_url: str,
    ) -> None:
        self.db = db
        self.store = store
        self.outbox = outbox
        self.llm = llm
        self.taxonomy = taxonomy
        self.tenants = tenants
        self.rooms = rooms
        self.clock = clock
        self.ws_base_url = ws_base_url.rstrip('/')

    # --- templates and plans -----------------------------------------------------------------

    async def create(self, actor: Actor, body: dict[str, Any]) -> dict[str, Any]:
        actor.require(MANAGE_ROLES)
        if body.get('plan') is not None:
            plan, source = parse_plan(body['plan']), 'recruiter'
        else:
            plan, source = await self._generate(actor.tenant_id, body), 'generated'
        interview_id = uuid7()
        row = {
            'tenant_id': actor.tenant_id,
            'interview_id': interview_id,
            'job_profile_id': body['job_profile_id'],
            'title': body.get('title') or 'AI interview',
            'mode': body['mode'],
            'language': plan.language,
            'thresholds': _thresholds(body.get('thresholds')),
            'created_by': actor.subject,
        }
        async with self.db.tenant_tx(actor.tenant_id) as tx:
            await self.store.insert_interview(tx, row)
            await self.store.insert_plan(
                tx,
                tenant_id=actor.tenant_id,
                interview_id=interview_id,
                version=1,
                plan=plan_to_dict(plan),
                source=source,
                by=actor.subject,
            )
        return await self.get(actor, interview_id)

    async def _generate(self, tenant_id: str, body: dict[str, Any]) -> Any:
        profile = await self.taxonomy.job_profile(tenant_id, str(body['job_profile_id']))
        if profile is None:
            raise _not_found('job profile')
        if not profile.skills:
            raise InterviewError(
                'rule', 'JOB_PROFILE_WITHOUT_SKILLS', 'The job profile lists no skills to assess.'
            )
        total = sum(float(s['weight']) for s in profile.skills) or 1.0
        skills = [
            {
                'skill_id': s['skill_id'],
                'name': s['name'],
                'weight': round(float(s['weight']) / total, 4),
            }
            for s in profile.skills[:10]
        ]
        skills[-1]['weight'] = round(1 - sum(s['weight'] for s in skills[:-1]), 4)
        out = await self.llm.complete(
            tenant_id,
            PURPOSE_PLANNING,
            PLANNER,
            {
                'language': str(body.get('language') or 'en'),
                'max_minutes': str(body.get('max_minutes') or 20),
                'questions_per_skill': str(body.get('questions_per_skill') or 1),
                'skills': json.dumps(skills, ensure_ascii=False),
                'job_title': profile.title,
                'job_description': profile.description or '(none)',
            },
        )
        out.pop('_model', None)
        try:
            return parse_plan(out)
        except PlanError as error:
            raise InterviewError(
                'upstream_invalid',
                'PLAN_GENERATION_FAILED',
                f'The generated plan was rejected: {error.message} Edit it or try again.',
            ) from error

    async def get(self, actor: Actor, interview_id: str) -> dict[str, Any]:
        actor.require(REVIEW_ROLES)
        async with self.db.tenant_tx(actor.tenant_id) as tx:
            row = await self.store.get_interview(tx, interview_id)
            if row is None:
                raise _not_found('interview')
            plans = await self.store.plans(tx, interview_id)
        return interview_view(row, plans)

    async def update_plan(self, actor: Actor, interview_id: str, raw: object) -> dict[str, Any]:
        """Edits the draft, or starts a new draft version after a publish (published plans are
        frozen)."""
        actor.require(MANAGE_ROLES)
        plan = plan_to_dict(parse_plan(raw))
        async with self.db.tenant_tx(actor.tenant_id) as tx:
            row = await self.store.get_interview(tx, interview_id)
            if row is None:
                raise _not_found('interview')
            if row['status'] == 'archived':
                raise InterviewError('conflict', 'INTERVIEW_ARCHIVED', 'The interview is archived.')
            plans = await self.store.plans(tx, interview_id)
            latest = plans[0]
            if latest['status'] == 'draft':
                await self.store.replace_draft(
                    tx, interview_id, latest['version'], plan, 'recruiter', actor.subject
                )
            else:
                await self.store.insert_plan(
                    tx,
                    tenant_id=actor.tenant_id,
                    interview_id=interview_id,
                    version=latest['version'] + 1,
                    plan=plan,
                    source='recruiter',
                    by=actor.subject,
                )
        return await self.get(actor, interview_id)

    async def publish(self, actor: Actor, interview_id: str) -> dict[str, Any]:
        actor.require(MANAGE_ROLES)
        async with self.db.tenant_tx(actor.tenant_id) as tx:
            row = await self.store.get_interview(tx, interview_id)
            if row is None:
                raise _not_found('interview')
            plans = await self.store.plans(tx, interview_id)
            draft = plans[0]
            if draft['status'] != 'draft':
                raise InterviewError(
                    'conflict',
                    'NOTHING_TO_PUBLISH',
                    'The latest plan version is already published.',
                )
            parse_plan(draft['plan'])  # re-checked: the filter may have grown since the edit
            await self.store.publish_plan(
                tx, interview_id, draft['version'], actor.subject, self.clock.now()
            )
            if not await self.store.update_interview(
                tx,
                interview_id,
                row['lock_version'],
                {'status': 'published', 'published_version': draft['version']},
            ):
                raise InterviewError('conflict', 'CONCURRENT_UPDATE', 'Try again.')
        return await self.get(actor, interview_id)

    # --- sessions ----------------------------------------------------------------------------

    async def create_session(
        self, tenant_id: str, interview_id: str, body: dict[str, Any]
    ) -> dict[str, Any]:
        """assessment-svc starts an AI interview question (service token). Idempotent per
        (assessment session, question): a repeat call issues a fresh token."""
        token = new_token()
        async with self.db.tenant_tx(tenant_id) as tx:
            existing = await self.store.session_for_question(
                tx, body['assessment_session_id'], body['question_id']
            )
            if existing is not None:
                if (
                    existing.interview_id != interview_id
                    or existing.candidate_id != body['candidate_id']
                ):
                    raise InterviewError(
                        'conflict',
                        'SESSION_MISMATCH',
                        'The question already has another interview.',
                    )
                await self.store.reissue_token(tx, existing.session_id, hash_token(token))
                return self._session_view(existing, token)
            row = await self.store.get_interview(tx, interview_id)
            if row is None:
                raise _not_found('interview')
            if row['status'] != 'published' or row['published_version'] is None:
                raise InterviewError(
                    'conflict', 'INTERVIEW_NOT_PUBLISHED', 'The interview has no published plan.'
                )
        jurisdictions = await self.tenants.jurisdictions(tenant_id)
        session_id = uuid7()
        async with self.db.tenant_tx(tenant_id) as tx:
            await self.store.insert_session(
                tx,
                {
                    'tenant_id': tenant_id,
                    'session_id': session_id,
                    'interview_id': interview_id,
                    'plan_version': row['published_version'],
                    'assessment_id': body['assessment_id'],
                    'assessment_session_id': body['assessment_session_id'],
                    'question_id': body['question_id'],
                    'candidate_id': body['candidate_id'],
                    'mode': row['mode'],
                    'token_hash': hash_token(token),
                    'jurisdictions': [j.lower() for j in jurisdictions],
                },
            )
            await self.store.remove_demand(tx, body['assessment_session_id'])
            created = await self.store.session(tx, session_id)
        assert created is not None
        return self._session_view(created, token)

    def _session_view(self, s: SessionRow, token: str) -> dict[str, Any]:
        return {
            'session_id': s.session_id,
            'interview_token': token,
            'mode': s.mode,
            'status': s.status,
            'join_path': f'/v1/interview-sessions/{s.session_id}:join',
        }

    async def by_token(self, session_id: str, token: str) -> SessionRow:
        if not token.startswith(TOKEN_PREFIX):
            raise InterviewError(
                'unauthorized', 'INVALID_INTERVIEW_TOKEN', 'Invalid interview token.'
            )
        async with self.db.system_tx() as tx:
            row = await self.store.session_by_token(tx, hash_token(token))
        if row is None or row.session_id != session_id.lower():
            raise InterviewError(
                'unauthorized', 'INVALID_INTERVIEW_TOKEN', 'Invalid interview token.'
            )
        return row

    async def join(self, session_id: str, token: str) -> dict[str, Any]:
        """The candidate's client: a LiveKit token for room `iv_{sid}` (audio publish only, 10
        minutes) in voice mode, the WebSocket URL, and where the transcript resumes."""
        s = await self.by_token(session_id, token)
        if s.status in ENDED_STATUSES:
            raise InterviewError('conflict', 'INTERVIEW_ENDED', 'The interview has ended.')
        livekit: dict[str, Any] = {'livekit_token': None, 'livekit_url': None}
        if s.mode == 'voice':
            async with self.db.tenant_tx(s.tenant_id) as tx:
                await self.store.want_worker(tx, s.session_id)
            livekit = {
                'livekit_token': self.rooms.candidate(
                    f'iv_{s.session_id}', f'candidate:{s.candidate_id}', LIVEKIT_TTL_S
                ),
                'livekit_url': self.rooms.url,
            }
        async with self.db.tenant_tx(s.tenant_id) as tx:
            cp = await self.store.latest_checkpoint(tx, s.session_id)
        return {
            'session_id': s.session_id,
            'mode': s.mode,
            'status': s.status,
            **livekit,
            'ws_url': f'{self.ws_base_url}/v1/interviews/{s.session_id}/ws',
            'resume_cursor': len(cp.state['turns']) if cp else 0,
        }

    async def transcript(self, tenant_id: str, session_id: str) -> dict[str, Any]:
        async with self.db.tenant_tx(tenant_id) as tx:
            s = await self.store.session(tx, session_id)
            if s is None:
                raise _not_found('interview session')
            flushed = await self.store.turns(tx, session_id)
            cp = await self.store.latest_checkpoint(tx, session_id)
        live = cp.state['turns'][len(flushed) :] if cp else []
        turns = [*flushed, *live]
        return {
            'session_id': s.session_id,
            'status': s.status,
            'turns': [
                {
                    'index': t['index'],
                    'role': t['role'],
                    'kind': t['kind'],
                    'qid': t['qid'],
                    'text': t['text'],
                    't0_ms': t['t0_ms'],
                    't1_ms': t['t1_ms'],
                    'interrupted': t['interrupted'],
                    'excluded': t['excluded'],
                    'flags': list(t['flags']),
                }
                for t in turns
                if t['kind'] != 'filler'
            ],
        }

    async def evaluation(self, actor: Actor, session_id: str) -> dict[str, Any]:
        actor.require(REVIEW_ROLES)
        async with self.db.tenant_tx(actor.tenant_id) as tx:
            s = await self.store.session(tx, session_id)
            ev = await self.store.evaluation(tx, session_id) if s else None
            overrides = await self.store.overrides(tx, session_id) if ev else []
        if s is None:
            raise _not_found('interview session')
        if ev is None:
            raise InterviewError(
                'not_found', 'EVALUATION_NOT_READY', 'The interview has not been scored yet.'
            )
        return {
            'session_id': s.session_id,
            'status': s.status,
            'revision': ev['revision'],
            'competencies': ev['competencies'],
            'weighted_score': ev['weighted_score'],
            'recommendation': ev['recommendation'],
            'requires_approval': ev['requires_approval'],
            'approved_by': ev['approved_by'],
            'flags': list(ev['flags']),
            'overrides': [
                {
                    'by': o['by_user'],
                    'reason': o['reason'],
                    'at': o['created_at'].isoformat(),
                }
                for o in overrides
            ],
        }

    async def override(
        self,
        actor: Actor,
        session_id: str,
        reason: str,
        recommendation: Literal['advance', 'hold', 'do_not_advance'] | None,
        scores: dict[str, int | None],
    ) -> dict[str, Any]:
        """A person's decision replaces the AI's (and approves a pending "do not advance").
        Stored with the reason and re-published with a higher revision."""
        actor.require(MANAGE_ROLES)
        now = self.clock.now()
        async with self.db.tenant_tx(actor.tenant_id) as tx:
            s = await self.store.session(tx, session_id)
            ev = await self.store.evaluation(tx, session_id) if s else None
            if s is None or ev is None:
                raise InterviewError(
                    'not_found', 'EVALUATION_NOT_READY', 'The interview has not been scored yet.'
                )
            comps = [dict(c) for c in ev['competencies']]
            known = {c['skill_id'] for c in comps}
            if unknown := sorted(set(scores) - known):
                raise InterviewError(
                    'validation',
                    'UNKNOWN_COMPETENCY',
                    f'Not in this interview: {", ".join(unknown)}.',
                )
            for c in comps:
                if c['skill_id'] in scores:
                    c['score'] = scores[c['skill_id']]
                    c['status'] = 'overridden'
            scored = [c for c in comps if c['score'] is not None]
            weight = sum(c['weight'] for c in scored)
            weighted = (
                round(sum(c['weight'] * c['score'] for c in scored) / weight, 3) if weight else None
            )
            final_recommendation: str | None = recommendation or ev['recommendation']
            after: dict[str, Any] = {
                'competencies': comps,
                'weighted_score': weighted,
                'recommendation': final_recommendation,
                'approved_by': actor.subject,
                'approved_at': now,
            }
            if not await self.store.update_evaluation(tx, session_id, ev['revision'], after):
                raise InterviewError('conflict', 'CONCURRENT_UPDATE', 'Try again.')
            await self.store.insert_override(
                tx,
                {
                    'tenant_id': actor.tenant_id,
                    'override_id': uuid7(),
                    'session_id': session_id,
                    'by_user': actor.subject,
                    'reason': reason,
                    'before': {
                        'competencies': ev['competencies'],
                        'recommendation': ev['recommendation'],
                        'weighted_score': ev['weighted_score'],
                    },
                    'after': {**after, 'approved_at': now.isoformat()},
                },
            )
            ratio = sum(c['weight'] * ((c['score'] or 1) - 1) / 4 for c in comps)
            await self.outbox.append(
                tx,
                topic=COMPLETED_TOPIC,
                tenant_id=actor.tenant_id,
                aggregate_type='assessment_session',
                aggregate_id=s.assessment_session_id,
                payload=completed_payload(
                    s,
                    outcome=s.status if s.status in ENDED_STATUSES else 'completed',
                    competencies=comps,
                    recommendation=final_recommendation,
                    requires_approval=False,
                    score_ratio=round(max(0.0, min(1.0, ratio)), 4),
                    needs_review=False,
                    revision=ev['revision'] + 1,
                    at=now.isoformat(),
                ),
            )
        return await self.evaluation(actor, session_id)
