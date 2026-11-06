"""Interview plans (PRD §2.4b): competencies with weighted questions, probes and a 1-5 rubric,
knockouts and an approved FAQ. Generated before the session and frozen when published, so every
candidate gets the same core questions."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any

from interview_svc.domain.errors import PlanError
from interview_svc.domain.guardrails import blocked_category

UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
QID = re.compile(r'^[a-z0-9_-]{1,20}$')
MAX_COMPETENCIES = 10
MAX_QUESTIONS = 20
MAX_PROBES = 4
WEIGHT_TOLERANCE = 0.01


@dataclass(frozen=True)
class Question:
    qid: str
    text: str
    probes: tuple[str, ...]
    rubric: dict[str, str]  # '1', '3', '5' anchors (others optional)


@dataclass(frozen=True)
class Competency:
    skill_id: str
    name: str
    weight: float
    questions: tuple[Question, ...]


@dataclass(frozen=True)
class Knockout:
    kid: str
    question: str
    expected: str  # 'yes' | 'no'


@dataclass(frozen=True)
class Faq:
    question: str
    answer: str


@dataclass(frozen=True)
class Plan:
    language: str
    max_minutes: int
    competencies: tuple[Competency, ...]
    knockouts: tuple[Knockout, ...]
    faq: tuple[Faq, ...]

    def questions(self) -> list[tuple[Competency, Question]]:
        """The interview order: competencies in plan order, their questions in order."""
        return [(c, q) for c in self.competencies for q in c.questions]

    def question(self, index: int) -> tuple[Competency, Question] | None:
        items = self.questions()
        return items[index] if 0 <= index < len(items) else None

    def competency_of(self, qid: str) -> Competency | None:
        return next((c for c in self.competencies if any(q.qid == qid for q in c.questions)), None)


def _text(value: object, where: str, max_len: int = 1000) -> str:
    if not isinstance(value, str) or not value.strip():
        raise PlanError(f'{where} must be a non-empty string.')
    text = value.strip()
    if len(text) > max_len:
        raise PlanError(f'{where} is longer than {max_len} characters.')
    return text


def _asked(text: str, where: str) -> str:
    """Text the interviewer will say verbatim: it must pass the illegal-question filter."""
    category = blocked_category(text)
    if category:
        raise PlanError(f'{where} asks about a protected characteristic ({category}).')
    return text


def parse_plan(raw: object) -> Plan:
    """Validates a plan document (generated or edited). Raises PlanError with the first problem."""
    if not isinstance(raw, dict):
        raise PlanError('The plan must be an object.')
    language = raw.get('language', 'en')
    if not isinstance(language, str) or not re.fullmatch(r'[a-z]{2}(-[A-Z]{2})?', language):
        raise PlanError('language must be a language tag such as "en" or "en-GB".')
    minutes = raw.get('max_minutes', 20)
    if not isinstance(minutes, int) or isinstance(minutes, bool) or not 5 <= minutes <= 60:
        raise PlanError('max_minutes must be an integer from 5 to 60.')
    comps_raw = raw.get('competencies')
    if not isinstance(comps_raw, list) or not 1 <= len(comps_raw) <= MAX_COMPETENCIES:
        raise PlanError(f'competencies must list 1 to {MAX_COMPETENCIES} competencies.')
    competencies: list[Competency] = []
    seen_qids: set[str] = set()
    seen_skills: set[str] = set()
    for i, c in enumerate(comps_raw):
        where = f'competencies[{i}]'
        if not isinstance(c, dict):
            raise PlanError(f'{where} must be an object.')
        skill_id = str(c.get('skill_id', '')).lower()
        if not UUID.match(skill_id):
            raise PlanError(f'{where}.skill_id must be a UUID.')
        if skill_id in seen_skills:
            raise PlanError(f'{where}.skill_id appears twice.')
        seen_skills.add(skill_id)
        weight = c.get('weight')
        if not isinstance(weight, int | float) or isinstance(weight, bool) or not 0 < weight <= 1:
            raise PlanError(f'{where}.weight must be in (0, 1].')
        questions: list[Question] = []
        qs_raw = c.get('questions')
        if not isinstance(qs_raw, list) or not qs_raw:
            raise PlanError(f'{where}.questions must not be empty.')
        for j, q in enumerate(qs_raw):
            qwhere = f'{where}.questions[{j}]'
            if not isinstance(q, dict):
                raise PlanError(f'{qwhere} must be an object.')
            qid = q.get('qid')
            if not isinstance(qid, str) or not QID.match(qid):
                raise PlanError(f'{qwhere}.qid must match [a-z0-9_-]{{1,20}}.')
            if qid in seen_qids:
                raise PlanError(f'{qwhere}.qid "{qid}" appears twice.')
            seen_qids.add(qid)
            probes_raw = q.get('probes', [])
            if not isinstance(probes_raw, list) or len(probes_raw) > MAX_PROBES:
                raise PlanError(f'{qwhere}.probes must list at most {MAX_PROBES} probes.')
            rubric = q.get('rubric')
            if not isinstance(rubric, dict) or not {'1', '3', '5'} <= set(rubric):
                raise PlanError(f'{qwhere}.rubric must anchor levels 1, 3 and 5.')
            if not set(rubric) <= {'1', '2', '3', '4', '5'}:
                raise PlanError(f'{qwhere}.rubric levels are 1 to 5.')
            questions.append(
                Question(
                    qid=qid,
                    text=_asked(_text(q.get('text'), f'{qwhere}.text'), f'{qwhere}.text'),
                    probes=tuple(
                        _asked(_text(p, f'{qwhere}.probes[{k}]', 500), f'{qwhere}.probes[{k}]')
                        for k, p in enumerate(probes_raw)
                    ),
                    rubric={k: _text(v, f'{qwhere}.rubric.{k}', 500) for k, v in rubric.items()},
                )
            )
        competencies.append(
            Competency(
                skill_id=skill_id,
                name=_text(c.get('name'), f'{where}.name', 200),
                weight=float(weight),
                questions=tuple(questions),
            )
        )
    if len(seen_qids) > MAX_QUESTIONS:
        raise PlanError(f'A plan has at most {MAX_QUESTIONS} questions.')
    total = sum(c.weight for c in competencies)
    if abs(total - 1) > WEIGHT_TOLERANCE:
        raise PlanError(f'Competency weights must sum to 1 (they sum to {total:.3f}).')
    knockouts: list[Knockout] = []
    for k, ko in enumerate(raw.get('knockouts', []) or []):
        where = f'knockouts[{k}]'
        if not isinstance(ko, dict) or ko.get('expected') not in ('yes', 'no'):
            raise PlanError(f'{where} needs a question and expected "yes" or "no".')
        knockouts.append(
            Knockout(
                kid=f'k{k + 1}',
                question=_asked(_text(ko.get('question'), f'{where}.question', 500), where),
                expected=str(ko['expected']),
            )
        )
    faq: list[Faq] = []
    for k, f in enumerate(raw.get('faq', []) or []):
        where = f'faq[{k}]'
        if not isinstance(f, dict):
            raise PlanError(f'{where} must be an object.')
        faq.append(
            Faq(
                question=_text(f.get('question'), f'{where}.question', 500),
                answer=_asked(_text(f.get('answer'), f'{where}.answer', 1000), where),
            )
        )
    return Plan(
        language=language,
        max_minutes=minutes,
        competencies=tuple(competencies),
        knockouts=tuple(knockouts),
        faq=tuple(faq),
    )


def plan_to_dict(plan: Plan) -> dict[str, Any]:
    return {
        'language': plan.language,
        'max_minutes': plan.max_minutes,
        'competencies': [
            {
                'skill_id': c.skill_id,
                'name': c.name,
                'weight': c.weight,
                'questions': [
                    {'qid': q.qid, 'text': q.text, 'probes': list(q.probes), 'rubric': q.rubric}
                    for q in c.questions
                ],
            }
            for c in plan.competencies
        ],
        'knockouts': [{'question': k.question, 'expected': k.expected} for k in plan.knockouts],
        'faq': [{'question': f.question, 'answer': f.answer} for f in plan.faq],
    }
