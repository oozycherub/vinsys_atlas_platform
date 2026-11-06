"""Evidence verification (PRD §2.1(b) stage 7): every item must be supported by text that exists
in the source (fuzzy ratio ≥ 0.85), or it is dropped. This blocks hallucinated skills and roles."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from rapidfuzz import fuzz

from parsing_svc.domain.schema import LlmResume

THRESHOLD = 85.0
#: How far around a quote the item's key terms may appear (a title line, then the employer).
WINDOW = 160


@dataclass(frozen=True)
class Span:
    start: int
    end: int
    score: float


@dataclass
class Verified:
    items: dict[str, list[tuple[dict[str, Any], Span]]] = field(default_factory=dict)
    dropped: list[str] = field(default_factory=list)


def _norm(value: str) -> str:
    return re.sub(r'\s+', ' ', value.lower())


def locate(quote: str, source: str) -> Span | None:
    """Where the quote occurs in the source, if anywhere (fuzzy, whitespace-insensitive)."""
    quote = ' '.join(quote.split())
    if len(quote) < 3:
        return None
    exact = source.lower().find(quote.lower())
    if exact >= 0:
        return Span(exact, exact + len(quote), 100.0)
    # Case-fold both sides; lower() keeps the length for the scripts résumés use, so offsets in
    # the folded text are offsets in the source.
    hay = source.lower()
    result = fuzz.partial_ratio_alignment(quote.lower(), hay, score_cutoff=THRESHOLD)
    if result is None:
        return None
    return Span(result.dest_start, result.dest_end, float(result.score))


def supported(term: str, region: str) -> bool:
    """Is the term present in the region? Very short terms (Go, R, C#) need an exact word."""
    term_n = _norm(term).strip()
    region_n = _norm(region)
    if len(term_n) <= 3:
        return re.search(rf'(?<![\w#+]){re.escape(term_n)}(?![\w#+])', region_n) is not None
    return fuzz.partial_ratio(term_n, region_n) >= THRESHOLD


def verify(resume: LlmResume, source: str) -> Verified:
    out = Verified()
    for item in resume.items:
        span = locate(item.evidence, source)
        label = f'{item.kind}[{item.index}]'
        if span is None:
            out.dropped.append(f'{label}: evidence not found')
            continue
        region = source[max(0, span.start - WINDOW) : span.end + WINDOW]
        if item.key_terms and not any(supported(t, region) for t in item.key_terms):
            out.dropped.append(f'{label}: evidence does not mention {item.key_terms[0]!r}')
            continue
        out.items.setdefault(item.kind, []).append((item.data, span))
    _filter_role_skills(out, source)
    return out


def _filter_role_skills(out: Verified, source: str) -> None:
    """A role or project may only mention skills that appear in its own text: from its evidence
    to the start of the next role (or 1,500 characters at most)."""
    for kind in ('work_history', 'projects'):
        entries = sorted(out.items.get(kind, []), key=lambda e: e[1].start)
        for n, (data, span) in enumerate(entries):
            nxt = entries[n + 1][1].start if n + 1 < len(entries) else len(source)
            region = source[span.start : min(nxt, span.start + 1500)]
            kept = [s for s in data['skills_mentioned'] if supported(s, region)]
            for s in data['skills_mentioned']:
                if s not in kept:
                    out.dropped.append(f'{kind}.skills_mentioned: {s!r} not in that entry')
            data['skills_mentioned'] = kept
