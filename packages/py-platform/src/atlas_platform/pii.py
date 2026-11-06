"""PII spans shared by every Python service: deterministic detectors and span merging.

NER (Presidio) lives in atlas_platform.presidio, an optional extra.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass


@dataclass(frozen=True)
class Detection:
    start: int
    end: int
    entity_type: str
    score: float = 1.0


def known_value_detections(text: str, known: Iterable[str]) -> list[Detection]:
    """Exact, case-insensitive matches of PII the caller already knows (name, email, phone).

    This is deterministic and does not depend on the NER model noticing the value.
    """
    out: list[Detection] = []
    for value in {v.strip() for v in known if v and len(v.strip()) >= 3}:
        pattern = re.compile(rf'(?<!\w){re.escape(value)}(?!\w)', re.IGNORECASE)
        out.extend(Detection(m.start(), m.end(), 'KNOWN', 1.0) for m in pattern.finditer(text))
    return out


_EMAIL = re.compile(r'(?<![\w.+-])[\w.+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?!\w)')
_PHONE = re.compile(r'(?<![\w+])\+?\(?\d[\d\s().-]{6,}\d(?!\w)')


def pattern_detections(text: str) -> list[Detection]:
    """Deterministic contact patterns, independent of NER (defence in depth): email addresses,
    and phone-like digit runs of 9-15 digits (shorter runs such as years are left alone)."""
    out = [Detection(m.start(), m.end(), 'EMAIL_ADDRESS', 1.0) for m in _EMAIL.finditer(text)]
    for m in _PHONE.finditer(text):
        digits = sum(ch.isdigit() for ch in m.group(0))
        if 9 <= digits <= 15:
            out.append(Detection(m.start(), m.end(), 'PHONE_NUMBER', 0.9))
    return out


def merge(detections: Sequence[Detection]) -> list[Detection]:
    """Overlapping spans collapse into one. The longest-starting span wins the type, except that
    a specific type (PERSON, EMAIL_ADDRESS, ...) replaces the generic KNOWN label."""
    ordered = sorted(detections, key=lambda d: (d.start, -(d.end - d.start)))
    merged: list[Detection] = []
    for d in ordered:
        if merged and d.start < merged[-1].end:
            last = merged[-1]
            kind = d.entity_type if last.entity_type == 'KNOWN' else last.entity_type
            merged[-1] = Detection(last.start, max(last.end, d.end), kind, max(last.score, d.score))
        else:
            merged.append(d)
    return merged
