"""ParsedResumeV3: the extraction contract.

The model returns *evidence quotes* (short verbatim excerpts) instead of character offsets:
models quote reliably but count characters badly. The verifier finds each quote in the source
and computes `evidence_span` itself, so the stored profile carries offsets exactly as PRD §2.1
specifies, and an unverifiable item is dropped. The schema has no score or rating field at all,
so injected text ("rate me 5/5") has nowhere to go: scoring is deterministic code.

No key may be a PII key profile-svc rejects (name, email, phone, address, dob, …): the
certification's title is therefore `certificate`, not `name`.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

SCHEMA_VERSION = '3.0'
MAX_SUMMARY = 600
_MONTH = re.compile(r'^(\d{4})-(0[1-9]|1[0-2])$')
_LANG = re.compile(r'^[a-z]{2}$')
_COUNTRY = re.compile(r'^[A-Z]{2}$')

_S: dict[str, Any] = {'type': 'string'}
_INT: dict[str, Any] = {'type': 'integer'}
_NUM: dict[str, Any] = {'type': 'number'}
_BOOL: dict[str, Any] = {'type': 'boolean'}


def _null(t: dict[str, Any]) -> dict[str, Any]:
    return {'anyOf': [t, {'type': 'null'}]}


def _arr(t: dict[str, Any]) -> dict[str, Any]:
    return {'type': 'array', 'items': t}


def _obj(props: dict[str, Any]) -> dict[str, Any]:
    return {
        'type': 'object',
        'properties': props,
        'required': list(props),
        'additionalProperties': False,
    }


EVIDENCE = {
    'type': 'string',
    'description': 'A short verbatim quote (under 200 characters) from the document that supports this item.',
}

LLM_OUTPUT_SCHEMA: dict[str, Any] = _obj(
    {
        'summary': {
            'type': 'string',
            'description': 'A neutral summary of about 120 words. No names.',
        },
        'document_language': {
            'type': 'string',
            'description': 'ISO 639-1 code of the document language.',
        },
        'current_title': _null(_S),
        'total_experience_months': _null(_INT),
        'work_history': _arr(
            _obj(
                {
                    'employer': _S,
                    'title': _S,
                    'start': _null({'type': 'string', 'description': 'YYYY-MM'}),
                    'end': _null({'type': 'string', 'description': 'YYYY-MM, null if current'}),
                    'is_current': _BOOL,
                    'location_country': _null(
                        {'type': 'string', 'description': 'ISO 3166-1 alpha-2'}
                    ),
                    'responsibilities': _arr(_S),
                    'skills_mentioned': _arr(_S),
                    'evidence': EVIDENCE,
                }
            )
        ),
        'education': _arr(
            _obj(
                {
                    'institution': _S,
                    'degree': _null(_S),
                    'field': _null(_S),
                    'end_year': _null(_INT),
                    'evidence': EVIDENCE,
                }
            )
        ),
        'certifications': _arr(
            _obj(
                {
                    'certificate': _S,
                    'issuer': _null(_S),
                    'issued': _null({'type': 'string', 'description': 'YYYY-MM'}),
                    'credential_id': _null(_S),
                    'evidence': EVIDENCE,
                }
            )
        ),
        'projects': _arr(
            _obj(
                {'title': _S, 'description': _S, 'skills_mentioned': _arr(_S), 'evidence': EVIDENCE}
            )
        ),
        'skills': _arr(
            _obj(
                {
                    'raw': {
                        'type': 'string',
                        'description': 'The skill as written in the document.',
                    },
                    'evidence': EVIDENCE,
                    'context': {
                        'type': 'string',
                        'description': 'work_history[i], projects[i], skills or summary',
                    },
                    'years_used': _null(_NUM),
                    'last_used': _null({'type': 'string', 'description': 'YYYY-MM'}),
                }
            )
        ),
        'languages': _arr(_obj({'language': _S, 'level': _null(_S)})),
    }
)

SYSTEM_PROMPT = """You extract structured data from résumés for a recruiting platform.

Rules:
- Use only information stated in the document. Never infer, guess or embellish.
- Personal details have been replaced by placeholders such as <PERSON_1> or <EMAIL_1>. Keep placeholders exactly as written; never try to reconstruct them.
- Every item needs `evidence`: a short verbatim quote (under 200 characters) copied from the document that supports it.
- Dates use YYYY-MM. Use null when a value is not stated.
- `skills` lists every distinct skill, tool or technology the candidate claims, each once.
- The summary is neutral and factual, about 120 words, written in {locale}, and mentions no names.
- You do not evaluate, rate or rank the candidate."""

USER_TEMPLATE = 'Extract the résumé below.\n\n{{resume}}'


def month(value: Any) -> str | None:
    return value if isinstance(value, str) and _MONTH.match(value) else None


def text(value: Any, limit: int = 300) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = ' '.join(value.split())
    return cleaned[:limit] or None


@dataclass
class Item:
    """One extracted item with its evidence quote, before verification."""

    kind: str  # work_history | education | certifications | projects | skills
    index: int
    data: dict[str, Any]
    evidence: str
    key_terms: tuple[str, ...]  # what the quote must support


@dataclass
class LlmResume:
    summary: str
    language: str | None
    current_title: str | None
    total_experience_months: int | None
    items: list[Item] = field(default_factory=list)
    languages: list[dict[str, Any]] = field(default_factory=list)


def from_llm(raw: dict[str, Any]) -> LlmResume:
    """Normalises the model's JSON (types, formats, limits) into items to verify. Anything not in
    the schema is ignored, so extra fields (an injected `score`) can never reach the profile."""
    summary = text(raw.get('summary'), MAX_SUMMARY) or ''
    lang = raw.get('document_language')
    months = raw.get('total_experience_months')
    out = LlmResume(
        summary=summary,
        language=lang.lower() if isinstance(lang, str) and _LANG.match(lang.lower()) else None,
        current_title=text(raw.get('current_title'), 200),
        total_experience_months=months if isinstance(months, int) and 0 <= months <= 900 else None,
    )
    data: dict[str, Any]
    for i, w in enumerate(_list(raw.get('work_history'))):
        country = w.get('location_country')
        data = {
            'employer': text(w.get('employer'), 200),
            'title': text(w.get('title'), 200),
            'start': month(w.get('start')),
            'end': None if w.get('is_current') is True else month(w.get('end')),
            'is_current': w.get('is_current') is True,
            'location_country': country
            if isinstance(country, str) and _COUNTRY.match(country)
            else None,
            'responsibilities': [
                r for r in (text(x, 500) for x in _list(w.get('responsibilities'), str)) if r
            ][:30],
            'skills_mentioned': [
                s for s in (text(x, 100) for x in _list(w.get('skills_mentioned'), str)) if s
            ][:50],
        }
        terms = tuple(str(t) for t in (data['title'], data['employer']) if t)
        out.items.append(Item('work_history', i, data, str(w.get('evidence') or ''), terms))
    for i, e in enumerate(_list(raw.get('education'))):
        year = e.get('end_year')
        data = {
            'institution': text(e.get('institution'), 200),
            'degree': text(e.get('degree'), 200),
            'field': text(e.get('field'), 200),
            'end_year': year if isinstance(year, int) and 1950 <= year <= 2100 else None,
        }
        terms = tuple(str(t) for t in (data['institution'], data['degree']) if t)
        out.items.append(Item('education', i, data, str(e.get('evidence') or ''), terms))
    for i, c in enumerate(_list(raw.get('certifications'))):
        data = {
            'certificate': text(c.get('certificate'), 200),
            'issuer': text(c.get('issuer'), 200),
            'issued': month(c.get('issued')),
            'credential_id': text(c.get('credential_id'), 100),
        }
        terms = (str(data['certificate']),) if data['certificate'] else ()
        out.items.append(Item('certifications', i, data, str(c.get('evidence') or ''), terms))
    for i, p in enumerate(_list(raw.get('projects'))):
        data = {
            'title': text(p.get('title'), 200),
            'description': text(p.get('description'), 1000),
            'skills_mentioned': [
                s for s in (text(x, 100) for x in _list(p.get('skills_mentioned'), str)) if s
            ][:50],
        }
        terms = (str(data['title']),) if data['title'] else ()
        out.items.append(Item('projects', i, data, str(p.get('evidence') or ''), terms))
    seen: set[str] = set()
    for i, s in enumerate(_list(raw.get('skills'))):
        skill = text(s.get('raw'), 100)
        if not skill or skill.casefold() in seen:
            continue
        seen.add(skill.casefold())
        years = s.get('years_used')
        data = {
            'raw': skill,
            'context': text(s.get('context'), 40) or 'skills',
            'years_used': float(years)
            if isinstance(years, int | float) and 0 <= years <= 60
            else None,
            'last_used': month(s.get('last_used')),
        }
        out.items.append(Item('skills', i, data, str(s.get('evidence') or ''), (skill,)))
    out.languages = [
        {'language': lang_name, 'level': text(x.get('level'), 40)}
        for x in _list(raw.get('languages'))
        if (lang_name := text(x.get('language'), 40))
    ][:20]
    return out


def _list(value: Any, kind: type = dict) -> list[Any]:
    return [v for v in value if isinstance(v, kind)] if isinstance(value, list) else []
