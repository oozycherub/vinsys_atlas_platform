"""Reversible pseudonymisation (PRD §4.1(i)).

PII spans become tokens such as `[[PII_EMAIL_3F2A9C1B]]` before anything leaves the gateway.
The token map lives only in the gateway's short-lived store (1 h). Model output is re-identified
only in the JSON fields a prompt allows, so a model cannot be tricked into echoing PII elsewhere.
"""

from __future__ import annotations

import re
import secrets
from collections.abc import Callable, Iterable, Sequence
from typing import Any

from atlas_platform.pii import Detection, known_value_detections, merge, pattern_detections

TOKEN = re.compile(r'\[\[PII_([A-Z_]{2,30})_([0-9A-F]{8})\]\]')
#: The longest a token can be; streaming holds back at most this many characters.
MAX_TOKEN_LENGTH = len('[[PII_') + 30 + 1 + 8 + len(']]')


#: Derives the 8 hex characters of a token from a value. The default is random; the gateway
#: injects a keyed HMAC so the same value gets the same token within a tenant and month, which
#: is what makes a response cache over redacted input possible at all.
Namer = Callable[[str], str]


def random_namer(_value: str) -> str:
    return secrets.token_hex(4).upper()


class TokenMap:
    """token → original value, plus the reverse so a repeated value gets the same token."""

    def __init__(self, initial: dict[str, str] | None = None, namer: Namer = random_namer) -> None:
        self.forward: dict[str, str] = dict(initial or {})
        self._reverse = {v.casefold(): k for k, v in self.forward.items()}
        self._namer = namer

    def token_for(self, value: str, entity_type: str) -> str:
        key = value.casefold()
        if key in self._reverse:
            return self._reverse[key]
        label = re.sub(r'[^A-Z_]', '_', entity_type.upper())[:30] or 'PII'
        suffix = self._namer(key)
        token = f'[[PII_{label}_{suffix}]]'
        while token in self.forward:  # a collision with a different value: fall back to random
            token = f'[[PII_{label}_{secrets.token_hex(4).upper()}]]'
        self.forward[token] = value
        self._reverse[key] = token
        return token


def redact(
    text: str, detections: Sequence[Detection], tokens: TokenMap
) -> tuple[str, dict[str, int]]:
    """Replaces every detected span with its token. Returns the text and counts per entity type."""
    counts: dict[str, int] = {}
    out: list[str] = []
    cursor = 0
    for d in merge(detections):
        out.append(text[cursor : d.start])
        out.append(tokens.token_for(text[d.start : d.end], d.entity_type))
        counts[d.entity_type] = counts.get(d.entity_type, 0) + 1
        cursor = d.end
    out.append(text[cursor:])
    return ''.join(out), counts


def anonymise(text: str, detections: Sequence[Detection]) -> str:
    """Irreversible: spans become `[EMAIL]`-style placeholders (used before embeddings)."""
    out: list[str] = []
    cursor = 0
    for d in merge(detections):
        out.append(text[cursor : d.start])
        out.append(f'[{d.entity_type}]')
        cursor = d.end
    out.append(text[cursor:])
    return ''.join(out)


def reidentify_text(text: str, tokens: TokenMap) -> str:
    return TOKEN.sub(lambda m: tokens.forward.get(m.group(0), m.group(0)), text)


def _pointer_matches(pattern: Sequence[str], path: Sequence[str]) -> bool:
    return len(pattern) == len(path) and all(
        p in ('*', q) for p, q in zip(pattern, path, strict=True)
    )


def _split(pointer: str) -> list[str]:
    return [p.replace('~1', '/').replace('~0', '~') for p in pointer.split('/')[1:]]


def reidentify_fields(value: Any, tokens: TokenMap, allowed: Iterable[str]) -> Any:
    """Re-identifies string leaves only at the allowed JSON Pointers (`*` matches any array index
    or key). Every other leaf keeps its tokens, so PII stays out of fields nobody asked for."""
    patterns = [_split(p) for p in allowed]

    def walk(node: Any, path: list[str]) -> Any:
        if isinstance(node, dict):
            return {k: walk(v, [*path, k]) for k, v in node.items()}
        if isinstance(node, list):
            return [walk(v, [*path, str(i)]) for i, v in enumerate(node)]
        if isinstance(node, str) and any(_pointer_matches(p, path) for p in patterns):
            return reidentify_text(node, tokens)
        return node

    return walk(value, [])


def contains_token(value: Any) -> bool:
    if isinstance(value, str):
        return TOKEN.search(value) is not None
    if isinstance(value, dict):
        return any(contains_token(v) for v in value.values())
    if isinstance(value, list):
        return any(contains_token(v) for v in value)
    return False


class StreamReidentifier:
    """Re-identifies a token stream without ever emitting half a token: text that could still be
    the start of a token is held back until it is complete or clearly is not one."""

    def __init__(self, tokens: TokenMap, enabled: bool) -> None:
        self._tokens = tokens
        self._enabled = enabled
        self._buffer = ''

    def feed(self, chunk: str) -> str:
        if not self._enabled:
            return chunk
        self._buffer += chunk
        start = self._buffer.rfind('[[')
        if (
            start != -1
            and self._buffer.find(']]', start) == -1
            and len(self._buffer) - start < MAX_TOKEN_LENGTH
        ):
            safe = self._buffer[:start]  # an unfinished token: hold it back
        elif self._buffer.endswith('['):
            safe = self._buffer[:-1]  # a trailing '[' might begin the next token
        else:
            safe = self._buffer
        self._buffer = self._buffer[len(safe) :]
        return reidentify_text(safe, self._tokens)

    def flush(self) -> str:
        rest, self._buffer = self._buffer, ''
        return reidentify_text(rest, self._tokens) if self._enabled else rest


__all__ = [
    'Detection',
    'TokenMap',
    'known_value_detections',
    'merge',
    'pattern_detections',
]
