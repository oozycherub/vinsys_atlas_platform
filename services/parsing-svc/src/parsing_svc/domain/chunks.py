"""Embedding chunks (PRD §2.1(b) stage 10): the neutral summary, one chunk per role, projects,
skills. Built only from the redacted, verified profile."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

MAX_CHUNK = 4000


@dataclass(frozen=True)
class Chunk:
    chunk_type: str
    chunk_index: int
    content: str

    @property
    def token_count(self) -> int:
        return max(1, round(len(self.content.split()) * 1.3))


def build_chunks(profile: dict[str, Any], skill_names: list[str]) -> list[Chunk]:
    chunks: list[Chunk] = []
    if profile.get('summary'):
        chunks.append(Chunk('profile_summary', 0, profile['summary']))
    for i, role in enumerate(profile.get('work_history', [])):
        parts = [
            ' at '.join(p for p in (role.get('title'), role.get('employer')) if p),
            *role.get('responsibilities', []),
        ]
        if role.get('skills_mentioned'):
            parts.append('Skills: ' + ', '.join(role['skills_mentioned']))
        content = '\n'.join(p for p in parts if p)
        if content:
            chunks.append(Chunk('experience', i, content[:MAX_CHUNK]))
    projects = [
        '\n'.join(p for p in (pr.get('title'), pr.get('description')) if p)
        for pr in profile.get('projects', [])
    ]
    if any(projects):
        chunks.append(Chunk('projects', 0, '\n\n'.join(p for p in projects if p)[:MAX_CHUNK]))
    if skill_names:
        chunks.append(Chunk('skills', 0, ', '.join(dict.fromkeys(skill_names))[:MAX_CHUNK]))
    return chunks
