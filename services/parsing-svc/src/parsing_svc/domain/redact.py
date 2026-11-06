"""PII extraction and redaction (PRD §2.1(b) stage 5). Only the redacted text leaves this stage
toward the LLM or embeddings; `pii_map` stays inside the worker and goes only to profile-svc."""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass, field

from atlas_platform.pii import Detection, known_value_detections, merge, pattern_detections

from parsing_svc.domain.sections import Section, Segmented, heading_type

LABELS = {
    'PERSON': 'PERSON',
    'EMAIL_ADDRESS': 'EMAIL',
    'PHONE_NUMBER': 'PHONE',
    'LOCATION': 'ADDRESS',
    'URL': 'URL',
    'DATE_TIME': 'DOB',
    'IP_ADDRESS': 'IP',
    'CREDIT_CARD': 'CARD',
    'IBAN_CODE': 'IBAN',
    'US_SSN': 'NATIONAL_ID',
    'UK_NHS': 'NATIONAL_ID',
    'KNOWN': 'PII',
}
PLACEHOLDER = re.compile(r'<([A-Z_]+)_(\d+)>')
_CONTACT_SECTIONS = {'header', 'contact'}
_REFERENCES = re.compile(r'refer', re.I)
_PROFILE_URL = re.compile(
    r'linkedin\.com/in/|github\.com/|gitlab\.com/|twitter\.com/|x\.com/', re.I
)


@dataclass(frozen=True)
class Contact:
    full_name: str | None = None
    email: str | None = None
    phone: str | None = None


@dataclass
class Redacted:
    text: str
    sections: tuple[Section, ...]
    pii_map: dict[str, str] = field(default_factory=dict)  # placeholder → original value
    counts: dict[str, int] = field(default_factory=dict)
    contact: Contact = Contact()


_NAME_LINE = re.compile(
    r"^(?:name\s*:\s*)?([A-Z][\w'\u2019.-]+(?:[ \t]+[A-Z][\w'\u2019.-]+){1,3})$", re.UNICODE
)
_NOT_A_NAME = re.compile(
    r'\b(resume|résumé|curriculum|vitae|cv|profile|engineer|developer|manager)\b', re.I
)


def header_name(seg: Segmented) -> list[Detection]:
    """The candidate's name, by résumé convention: the first name-shaped line of the header
    (2-4 capitalised words, optionally after "Name:"). Deterministic, so it does not depend on
    the NER model recognising an unusual name."""
    offset = 0
    for n, line in enumerate(seg.text.split('\n')):
        if n >= 6 or seg.section_at(offset) not in _CONTACT_SECTIONS:
            break
        match = _NAME_LINE.match(line.strip())
        if match and not _NOT_A_NAME.search(line) and heading_type(line) is None:
            start = offset + line.index(match.group(1))
            return [Detection(start, start + len(match.group(1)), 'PERSON', 1.0)]
        offset += len(line) + 1
    return []


def keep_detection(d: Detection, seg: Segmented) -> bool:
    """Section-aware filter for NER hits (deterministic detectors are always kept).

    In the contact block everything is redacted. Elsewhere, locations and links are useful and
    harmless ("Dubai", "acme.com"), and the NER model's PERSON hits are mostly employers,
    institutions and technologies ("Quarry Lane Software", "Redis"); redacting them would erase
    the facts the profile exists for. Other people's names appear in References sections, so
    PERSON is redacted there. The candidate's own name is redacted everywhere by the header and
    known-value rules, which do not depend on NER.
    """
    section = _section(seg, d.start)
    if section is None or section.type in _CONTACT_SECTIONS:
        return True
    value = seg.text[d.start : d.end]
    if d.entity_type in ('LOCATION', 'URL'):
        return bool(_PROFILE_URL.search(value))
    if d.entity_type == 'PERSON':
        return bool(_REFERENCES.search(section.title))
    return True


def _one_line(d: Detection, text: str) -> Detection:
    """NER sometimes runs a name into the next line (the email under it); entities never span
    lines, so the span stops at the first line break."""
    cut = text.find('\n', d.start, d.end)
    return d if cut < 0 else Detection(d.start, cut, d.entity_type, d.score)


def _section(seg: Segmented, offset: int) -> Section | None:
    return next((s for s in seg.sections if s.start <= offset < s.end), None)


def redact(seg: Segmented, ner: Sequence[Detection], known: Sequence[str] = ()) -> Redacted:
    text = seg.text
    detections = [
        d
        for d in [*(_one_line(d, text) for d in ner), *pattern_detections(text)]
        if keep_detection(d, seg)
    ] + header_name(seg)
    # The name and contacts found in the header are redacted everywhere they recur.
    header_values = {
        text[d.start : d.end]: d.entity_type
        for d in detections
        if d.entity_type in ('PERSON', 'EMAIL_ADDRESS', 'PHONE_NUMBER')
        and seg.section_at(d.start) in _CONTACT_SECTIONS
    }
    for value, kind in header_values.items():
        detections += [
            Detection(k.start, k.end, kind, 1.0) for k in known_value_detections(text, [value])
        ]
    detections += known_value_detections(text, known)
    spans = merge(detections)

    numbering: dict[tuple[str, str], str] = {}
    per_label: dict[str, int] = {}
    pii_map: dict[str, str] = {}
    counts: dict[str, int] = {}
    out: list[str] = []
    shifts: list[tuple[int, int]] = []  # (original offset, delta after it)
    cursor, delta = 0, 0
    first: dict[str, str] = {}
    for d in spans:
        value = text[d.start : d.end]
        label = LABELS.get(d.entity_type, 'PII')
        key = (label, value.casefold())
        if key not in numbering:
            per_label[label] = per_label.get(label, 0) + 1
            numbering[key] = f'<{label}_{per_label[label]}>'
            pii_map[numbering[key]] = value
        placeholder = numbering[key]
        counts[label] = counts.get(label, 0) + 1
        if seg.section_at(d.start) in _CONTACT_SECTIONS:
            first.setdefault(label, value)
        out.append(text[cursor : d.start])
        out.append(placeholder)
        cursor = d.end
        delta += len(placeholder) - (d.end - d.start)
        shifts.append((d.end, delta))
    out.append(text[cursor:])

    def moved(offset: int) -> int:
        shift = 0
        for end, total in shifts:
            if end <= offset:
                shift = total
        return offset + shift

    sections = tuple(Section(s.type, s.title, moved(s.start), moved(s.end)) for s in seg.sections)
    contact = Contact(first.get('PERSON'), first.get('EMAIL'), first.get('PHONE'))
    return Redacted(''.join(out), sections, pii_map, counts, contact)


def scrub(value: object, pii_map: dict[str, str]) -> object:
    """Defence in depth for anything leaving the worker: an original PII value that reappears
    (the model echoed it, or it was split oddly) is replaced by its placeholder again."""
    if isinstance(value, str):
        for placeholder, original in pii_map.items():
            if len(original) >= 3:
                value = re.sub(re.escape(original), placeholder, value, flags=re.I)
        return value
    if isinstance(value, list):
        return [scrub(v, pii_map) for v in value]
    if isinstance(value, dict):
        return {k: scrub(v, pii_map) for k, v in value.items()}
    return value
