"""The evaluation roles (PRD §2.4b): the turn evaluator (in the background, off the latency
path) and the final scorer, then the citation validator and the deterministic decision. The
result is stored and `interview.session.completed.v1` is published in one transaction."""

from __future__ import annotations

import json
import logging
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from atlas_platform.db import Database

from interview_svc.application.ports import Clock, LlmGateway, Outbox, SessionRow, Store
from interview_svc.domain.plan import Plan
from interview_svc.domain.scoring import (
    Decision,
    ScoredCompetency,
    TranscriptTurn,
    decide,
    validate_scores,
)
from interview_svc.domain.state import InterviewState, Turn
from interview_svc.prompts import PURPOSE_EVALUATION, SCORER, SCORER_CALIBRATION, TURN_EVALUATOR

log = logging.getLogger('interview_svc')

COMPLETED_TOPIC = 'interview.session.completed.v1'


def scorable(turns: Sequence[Turn], qid: str | None = None) -> list[Turn]:
    """Candidate answers the scorer may cite: not excluded (injection, abuse, low confidence)."""
    return [
        t
        for t in turns
        if t['role'] == 'candidate'
        and t['kind'] == 'answer'
        and not t['excluded']
        and (qid is None or t['qid'] == qid)
    ]


def numbered(turns: Sequence[Turn]) -> str:
    return '\n'.join(f'[turn {t["index"]}] {t["text"]}' for t in turns) or '(no answers)'


def summary(ev: dict[str, Any]) -> dict[str, Any]:
    return {
        'recommendation': ev.get('recommendation'),
        'weighted_score': ev.get('weighted_score'),
        'requires_approval': bool(ev.get('requires_approval')),
        'revision': ev.get('revision', 1),
    }


def completed_payload(
    session: SessionRow,
    *,
    outcome: str,
    competencies: Sequence[dict[str, Any]],
    recommendation: str | None,
    requires_approval: bool,
    score_ratio: float,
    needs_review: bool,
    revision: int,
    at: str,
) -> dict[str, Any]:
    return {
        'tenant_id': session.tenant_id,
        'session_id': session.assessment_session_id,
        'question_id': session.question_id,
        'score_ratio': score_ratio,
        'needs_review': needs_review,
        'completed_at': at,
        'interview_session_id': session.session_id,
        'interview_id': session.interview_id,
        'outcome': outcome,
        'recommendation': recommendation,
        'requires_approval': requires_approval,
        'competencies': [
            {'skill_id': c['skill_id'], 'weight': c['weight'], 'score': c['score']}
            for c in competencies
        ],
        'revision': revision,
    }


class ScoringService:
    def __init__(
        self,
        db: Database,
        store: Store,
        outbox: Outbox,
        llm: LlmGateway,
        clock: Clock,
        *,
        calibration: bool = False,
    ) -> None:
        self.db = db
        self.store = store
        self.outbox = outbox
        self.llm = llm
        self.clock = clock
        self.scorer_prompt = SCORER_CALIBRATION if calibration else SCORER

    def bind(self, session: SessionRow, plan: Plan, thresholds: dict[str, float]) -> BoundScoring:
        return BoundScoring(self, session, plan, thresholds)

    async def evaluate_turn(
        self, session: SessionRow, plan: Plan, qid: str, turns: Sequence[Turn]
    ) -> None:
        """Turn evaluator: evidence and a provisional level for one question (idempotent)."""
        comp = plan.competency_of(qid)
        question = next((q for c in plan.competencies for q in c.questions if q.qid == qid), None)
        answers = scorable(turns, qid)
        if comp is None or question is None or not answers:
            return
        out = await self.llm.complete(
            session.tenant_id,
            PURPOSE_EVALUATION,
            TURN_EVALUATOR,
            {
                'competency': comp.name,
                'rubric': json.dumps(question.rubric, ensure_ascii=False),
                'question': question.text,
                'answer_turns': numbered(answers),
            },
        )
        evidence = [e for e in out.get('evidence', []) if isinstance(e, dict)][:6]
        level = out.get('provisional_level')
        async with self.db.tenant_tx(session.tenant_id) as tx:
            await self.store.upsert_turn_evaluation(
                tx,
                session.tenant_id,
                session.session_id,
                qid,
                evidence,
                level if isinstance(level, int) and 1 <= level <= 5 else None,
                out.get('_model'),
            )


@dataclass
class BoundScoring:
    service: ScoringService
    session: SessionRow
    plan: Plan
    thresholds: dict[str, float]

    async def score(self, state: InterviewState) -> dict[str, Any]:
        svc, session = self.service, self.session
        async with svc.db.tenant_tx(session.tenant_id) as tx:
            existing = await svc.store.evaluation(tx, session.session_id)
        if existing is not None:  # a replayed SCORING node: the result already stands
            return summary(existing)
        outcome = state['outcome'] or 'completed'
        transcript = [
            TranscriptTurn(t['index'], t['role'], t['text'], t['excluded'] or t['kind'] != 'answer')
            for t in state['turns']
        ]
        model: str | None = None
        if outcome in ('declined', 'escalated'):
            # Nothing is scored: a person decides (no candidate is assessed on a refusal or a
            # safety stop).
            competencies = validate_scores(self.plan, [], transcript)
            decision = Decision(None, 'hold', False, True, 0.0, (outcome,))
            recommendation: str | None = None
        else:
            await self._ensure_turn_evaluations(state)
            async with svc.db.tenant_tx(session.tenant_id) as tx:
                turn_evals = await svc.store.turn_evaluations(tx, session.session_id)
            out = await svc.llm.complete(
                session.tenant_id,
                PURPOSE_EVALUATION,
                svc.scorer_prompt,
                {
                    'competencies': json.dumps(self._rubrics(), ensure_ascii=False),
                    'turn_evaluations': json.dumps(turn_evals, ensure_ascii=False),
                    'transcript': numbered(scorable(state['turns'])),
                },
            )
            model = out.get('_model')
            raw = [c for c in out.get('competencies', []) if isinstance(c, dict)]
            competencies = validate_scores(self.plan, raw, transcript)
            decision = decide(
                competencies,
                state['knockouts'],
                self.thresholds,
                session.jurisdictions,
                state['flags'],
            )
            recommendation = decision.recommendation
        return await self._store(state, outcome, competencies, decision, recommendation, model)

    async def _ensure_turn_evaluations(self, state: InterviewState) -> None:
        svc, session = self.service, self.session
        async with svc.db.tenant_tx(session.tenant_id) as tx:
            done = await svc.store.turn_evaluations(tx, session.session_id)
        for qid in state['pending_evals']:
            if qid not in done:
                await svc.evaluate_turn(session, self.plan, qid, state['turns'])

    def _rubrics(self) -> list[dict[str, Any]]:
        return [
            {
                'skill_id': c.skill_id,
                'name': c.name,
                'weight': c.weight,
                'questions': [
                    {'qid': q.qid, 'text': q.text, 'rubric': q.rubric} for q in c.questions
                ],
            }
            for c in self.plan.competencies
        ]

    async def _store(
        self,
        state: InterviewState,
        outcome: str,
        competencies: list[ScoredCompetency],
        decision: Decision,
        recommendation: str | None,
        model: str | None,
    ) -> dict[str, Any]:
        svc, session = self.service, self.session
        comps = [c.to_dict() for c in competencies]
        flags = sorted({*state['flags'], *decision.reasons})
        ev = {
            'session_id': session.session_id,
            'competencies': comps,
            'weighted_score': decision.weighted_score,
            'recommendation': recommendation,
            'requires_approval': decision.requires_approval,
            'flags': flags,
            'model': model,
        }
        at = svc.clock.now().isoformat()
        async with svc.db.tenant_tx(session.tenant_id) as tx:
            if await svc.store.insert_evaluation(tx, session.tenant_id, ev):
                await svc.outbox.append(
                    tx,
                    topic=COMPLETED_TOPIC,
                    tenant_id=session.tenant_id,
                    aggregate_type='assessment_session',
                    aggregate_id=session.assessment_session_id,
                    payload=completed_payload(
                        session,
                        outcome=outcome,
                        competencies=comps,
                        recommendation=recommendation,
                        requires_approval=decision.requires_approval,
                        score_ratio=decision.score_ratio,
                        needs_review=decision.needs_review,
                        revision=1,
                        at=at,
                    ),
                )
        log.info(
            'interview scored',
            extra={
                'tenant_id': session.tenant_id,
                'outcome': outcome,
                'review': decision.needs_review,
            },
        )
        return summary({**ev, 'revision': 1})
