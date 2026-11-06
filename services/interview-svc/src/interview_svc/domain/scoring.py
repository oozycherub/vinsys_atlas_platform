"""Scoring rules (PRD §2.4b, §2.4d, §4.1): citations are validated against the transcript, and
the recommendation is deterministic code over validated scores, never the model's opinion."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

from rapidfuzz import fuzz

from interview_svc.domain.guardrails import normalise
from interview_svc.domain.plan import Plan

CITATION_MATCH = 90.0  # rapidfuzz partial_ratio, 0-100 (PRD: fuzzy-match >= 0.9)
MIN_QUOTE_CHARS = 12
MIN_EVIDENCED_WEIGHT = 0.5
DEFAULT_THRESHOLDS = {'advance': 3.5, 'hold': 2.5}

# Jurisdictions where an automated "do not advance" needs a person's approval first
# (NYC Local Law 144, EU AI Act high-risk employment use, UK GDPR art. 22, Quebec Law 25,
# Illinois AI Video Interview Act, Colorado AI Act).
REGULATED_JURISDICTIONS = frozenset({'us-nyc', 'eu', 'uk', 'ca-qc', 'us-il', 'us-co'})

Recommendation = Literal['advance', 'hold', 'do_not_advance']


@dataclass(frozen=True)
class TranscriptTurn:
    index: int
    role: Literal['interviewer', 'candidate']
    text: str
    excluded: bool = False


@dataclass(frozen=True)
class Citation:
    turn: int
    quote: str


@dataclass(frozen=True)
class ScoredCompetency:
    skill_id: str
    name: str
    weight: float
    score: int | None  # None: insufficient evidence
    rationale: str
    evidence: tuple[Citation, ...]
    status: Literal['scored', 'insufficient_evidence']
    rejected_citations: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            'skill_id': self.skill_id,
            'name': self.name,
            'weight': self.weight,
            'score': self.score,
            'rationale': self.rationale,
            'evidence': [{'turn': c.turn, 'quote': c.quote} for c in self.evidence],
            'status': self.status,
            'rejected_citations': self.rejected_citations,
        }


def citation_valid(c: Citation, turns: Mapping[int, TranscriptTurn]) -> bool:
    """A quote counts only if it names a scorable candidate turn and appears in it (fuzzy, so
    STT punctuation and filler words do not break an honest quote)."""
    turn = turns.get(c.turn)
    if turn is None or turn.role != 'candidate' or turn.excluded:
        return False
    quote = normalise(c.quote)
    if len(quote) < MIN_QUOTE_CHARS:
        return False
    return fuzz.partial_ratio(quote, normalise(turn.text)) >= CITATION_MATCH


def validate_scores(
    plan: Plan,
    raw: Sequence[Mapping[str, Any]],
    transcript: Sequence[TranscriptTurn],
) -> list[ScoredCompetency]:
    """The scorer's output → one result per plan competency. Unknown skills are ignored, a
    missing competency or one without a valid citation is "insufficient evidence"."""
    turns = {t.index: t for t in transcript}
    by_skill = {str(r.get('skill_id', '')).lower(): r for r in raw}
    out: list[ScoredCompetency] = []
    for comp in plan.competencies:
        r = by_skill.get(comp.skill_id)
        citations: list[Citation] = []
        rejected = 0
        score: int | None = None
        rationale = ''
        if r is not None:
            rationale = str(r.get('rationale', ''))[:2000]
            raw_score = r.get('score')
            if (
                isinstance(raw_score, int)
                and not isinstance(raw_score, bool)
                and 1 <= raw_score <= 5
            ):
                score = raw_score
            for e in r.get('evidence', []) or []:
                try:
                    c = Citation(turn=int(e['turn']), quote=str(e['quote'])[:1000])
                except (KeyError, TypeError, ValueError):
                    rejected += 1
                    continue
                if citation_valid(c, turns):
                    citations.append(c)
                else:
                    rejected += 1
        evidenced = score is not None and bool(citations)
        out.append(
            ScoredCompetency(
                skill_id=comp.skill_id,
                name=comp.name,
                weight=comp.weight,
                score=score if evidenced else None,
                rationale=rationale if evidenced else 'Insufficient evidence in the transcript.',
                evidence=tuple(citations) if evidenced else (),
                status='scored' if evidenced else 'insufficient_evidence',
                rejected_citations=rejected,
            )
        )
    return out


@dataclass(frozen=True)
class Decision:
    weighted_score: float | None
    recommendation: Recommendation
    requires_approval: bool
    needs_review: bool
    score_ratio: float
    reasons: tuple[str, ...] = field(default_factory=tuple)


def decide(
    competencies: Sequence[ScoredCompetency],
    knockouts: Mapping[str, Literal['pass', 'fail', 'unclear']],
    thresholds: Mapping[str, float],
    jurisdictions: Sequence[str],
    flags: Sequence[str],
) -> Decision:
    """Weighted score over evidenced competencies, knockouts, then the tenant's thresholds."""
    advance = float(thresholds.get('advance', DEFAULT_THRESHOLDS['advance']))
    hold = float(thresholds.get('hold', DEFAULT_THRESHOLDS['hold']))
    scored = [c for c in competencies if c.score is not None]
    evidenced_weight = sum(c.weight for c in scored)
    weighted = (
        round(sum(c.weight * (c.score or 0) for c in scored) / evidenced_weight, 3)
        if evidenced_weight > 0
        else None
    )
    reasons: list[str] = []
    if any(v == 'fail' for v in knockouts.values()):
        rec: Recommendation = 'do_not_advance'
        reasons.append('knockout_failed')
    elif weighted is None or evidenced_weight < MIN_EVIDENCED_WEIGHT:
        rec = 'hold'
        reasons.append('insufficient_evidence')
    elif weighted >= advance:
        rec = 'advance'
    elif weighted >= hold:
        rec = 'hold'
    else:
        rec = 'do_not_advance'
    if any(v == 'unclear' for v in knockouts.values()):
        reasons.append('knockout_unclear')
    if any(c.score is None for c in competencies):
        reasons.append('competency_without_evidence')
    if flags:
        reasons.append('flagged')
    regulated = any(j.lower() in REGULATED_JURISDICTIONS for j in jurisdictions)
    requires_approval = rec == 'do_not_advance' and regulated
    if requires_approval:
        reasons.append('approval_required')
    # The assessment question's marks: each competency's 1-5 score mapped to 0-1, weighted over
    # *all* competencies (one without evidence earns nothing).
    ratio = max(0.0, min(1.0, sum(c.weight * ((c.score or 1) - 1) / 4 for c in competencies)))
    return Decision(
        weighted_score=weighted,
        recommendation=rec,
        requires_approval=requires_approval,
        needs_review=requires_approval or len(reasons) > 0,
        score_ratio=round(ratio, 4),
        reasons=tuple(reasons),
    )
