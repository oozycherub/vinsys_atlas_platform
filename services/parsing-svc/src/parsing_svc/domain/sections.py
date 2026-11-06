"""Section segmentation (PRD §2.1(b) stage 4): heading vocabulary plus font-size jumps, over
blocks in reading order. Produces the document text with section offsets."""

from __future__ import annotations

import re
import statistics
from dataclasses import dataclass

from parsing_svc.domain.layout import Block, LayoutDoc, reading_order

SectionType = str  # header | contact | summary | experience | education | skills | projects | certifications | other

_HEADINGS: dict[str, tuple[str, ...]] = {
    'summary': (
        'summary',
        'profile',
        'about me',
        'about',
        'objective',
        'professional summary',
        'career summary',
        'personal statement',
        'career objective',
    ),
    'experience': (
        'experience',
        'work experience',
        'employment',
        'employment history',
        'professional experience',
        'work history',
        'career history',
        'relevant experience',
    ),
    'education': (
        'education',
        'academic background',
        'qualifications',
        'education and training',
        'academic qualifications',
    ),
    'skills': (
        'skills',
        'technical skills',
        'core skills',
        'key skills',
        'competencies',
        'core competencies',
        'technologies',
        'tech stack',
        'skills and tools',
        'tools',
    ),
    'projects': ('projects', 'personal projects', 'selected projects', 'key projects'),
    'certifications': (
        'certifications',
        'certificates',
        'licenses',
        'licences',
        'licenses and certifications',
        'certifications and licenses',
        'courses',
        'training',
    ),
    'contact': ('contact', 'contact details', 'personal details', 'personal information'),
    'other': (
        'languages',
        'interests',
        'hobbies',
        'awards',
        'publications',
        'volunteering',
        'references',
        'achievements',
        'additional information',
    ),
}
_LOOKUP = {h: kind for kind, words in _HEADINGS.items() for h in words}


@dataclass(frozen=True)
class Section:
    type: SectionType
    title: str
    start: int
    end: int


@dataclass(frozen=True)
class Segmented:
    text: str
    sections: tuple[Section, ...]
    page_count: int

    def section_at(self, offset: int) -> SectionType:
        for s in self.sections:
            if s.start <= offset < s.end:
                return s.type
        return 'other'


def heading_type(line: str) -> SectionType | None:
    key = re.sub(r'[^a-z& ]', '', line.lower().replace('&', ' and ')).strip()
    key = re.sub(r'\s+', ' ', key)
    if not key or len(key.split()) > 5:
        return None
    return _LOOKUP.get(key)


def segment(doc: LayoutDoc) -> Segmented:
    blocks: list[Block] = []
    for page in doc.pages:
        blocks += reading_order(page.blocks, page.width)
    sizes = [b.font_size for b in blocks if b.text.strip()]
    body = statistics.median(sizes) if sizes else 11.0

    parts: list[str] = []
    sections: list[Section] = []
    current, title, start, offset = 'header', '', 0, 0
    for block in blocks:
        for line in block.text.splitlines():
            stripped = line.strip()
            if not stripped:
                continue
            kind = heading_type(stripped)
            # A known heading word set in body text ("Skills: Python, SQL") is not a heading
            # unless it stands alone or is visibly larger / bold.
            if kind and (len(stripped) <= 40 or block.font_size >= body * 1.15 or block.bold):
                if offset > start:
                    sections.append(Section(current, title, start, offset))
                current, title, start = kind, stripped, offset
            parts.append(stripped + '\n')
            offset += len(stripped) + 1
    if offset > start:
        sections.append(Section(current, title, start, offset))
    return Segmented(''.join(parts), tuple(sections), len(doc.pages))
