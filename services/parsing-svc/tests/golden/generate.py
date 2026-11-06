"""Generates the golden set: 50 synthetic, anonymised résumés with their expected extraction.

Every person, employer and institution is fictional and composed from the lists below; no real
résumé was used. Formats rotate through single-column PDF, two-column PDF, DOCX (skills in a
table) and plain text. Run from the service directory:

    uv run python tests/golden/generate.py
"""

from __future__ import annotations

import json
import random
from pathlib import Path

HERE = Path(__file__).resolve().parent
FILES = HERE / 'files'
EXPECTED = HERE / 'expected'

FIRST = [
    'Aria',
    'Bram',
    'Celine',
    'Dario',
    'Elif',
    'Farid',
    'Greta',
    'Hugo',
    'Ines',
    'Jonas',
    'Kaia',
    'Lorcan',
    'Mirela',
    'Nadim',
    'Odile',
    'Pavel',
    'Quilla',
    'Rafe',
    'Selin',
    'Tobias',
    'Ulla',
    'Viggo',
    'Wren',
    'Xenia',
    'Yusuf',
]
LAST = [
    'Achterberg',
    'Brannigan',
    'Castellanos',
    'Dovrat',
    'Eskildsen',
    'Falkenrath',
    'Grimaldo',
    'Halloran',
    'Ivanescu',
    'Jaramillo',
    'Kowalczyk',
    'Lindqvist',
    'Mastrangelo',
    'Nyberg',
    'Okonkwo',
    'Petrakis',
    'Quintanilla',
    'Rasmussen',
    'Szabo',
    'Thorvaldsen',
]
CITIES = [
    ('Rotterdam', 'Netherlands'),
    ('Porto', 'Portugal'),
    ('Gdansk', 'Poland'),
    ('Leeds', 'United Kingdom'),
    ('Aarhus', 'Denmark'),
    ('Valencia', 'Spain'),
    ('Tampere', 'Finland'),
]
EMPLOYERS = [
    'Northwind Systems',
    'Bluefjord Analytics',
    'Quarry Lane Software',
    'Tidewater Logistics',
    'Copperleaf Health',
    'Orbitfield Labs',
    'Granite Peak Retail',
    'Silverline Payments',
    'Meadowbrook Energy',
    'Ironbark Robotics',
    'Lanternfish Media',
    'Cobalt Harbor Insurance',
]
TITLES = [
    'Data Engineer',
    'Senior Data Engineer',
    'Backend Engineer',
    'Software Engineer',
    'Platform Engineer',
    'Machine Learning Engineer',
    'Analytics Engineer',
    'Site Reliability Engineer',
]
INSTITUTIONS = [
    'Lakeside Institute of Technology',
    'Westmarch University',
    'Riverbend Polytechnic',
    'Northgate College of Engineering',
    'Ashford Technical University',
]
DEGREES = [
    ('BSc', 'Computer Science'),
    ('MSc', 'Data Science'),
    ('BEng', 'Software Engineering'),
    ('MSc', 'Applied Mathematics'),
]
CERTS = [
    ('AWS Certified Solutions Architect', 'Amazon Web Services'),
    ('Certified Kubernetes Administrator', 'CNCF'),
    ('Google Professional Data Engineer', 'Google Cloud'),
    ('Terraform Associate', 'HashiCorp'),
]
SKILLS = [
    'Python',
    'SQL',
    'Kafka',
    'Spark',
    'Airflow',
    'dbt',
    'Kubernetes',
    'Docker',
    'Terraform',
    'AWS',
    'PostgreSQL',
    'Go',
    'Java',
    'TypeScript',
    'React',
    'Snowflake',
    'Redis',
    'GraphQL',
    'Pandas',
    'PyTorch',
    'Scala',
    'Elasticsearch',
    'Grafana',
    'Linux',
]
VERBS = ['Built', 'Designed', 'Maintained', 'Migrated', 'Automated', 'Scaled']
OBJECTS = [
    'event pipelines',
    'reporting services',
    'deployment tooling',
    'customer APIs',
    'data models',
    'batch jobs',
]
MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
FORMATS = ['pdf', 'pdf2col', 'docx', 'txt', 'pdf']


def human(month: str) -> str:
    year, mon = month.split('-')
    return f'{MONTHS[int(mon) - 1]} {year}'


def make(n: int) -> dict[str, object]:
    rng = random.Random(1000 + n)
    first, last = FIRST[n % len(FIRST)], LAST[(n * 7) % len(LAST)]
    city, country = CITIES[n % len(CITIES)]
    email = f'{first.lower()}.{last.lower()}{n}@mailbox.example'
    phone = f'+31 6 {rng.randint(1000, 9999)} {rng.randint(1000, 9999)}'
    roles = []
    year = 2026
    used: list[str] = []
    for r in range(rng.randint(2, 3)):
        current = r == 0
        start_year = year - rng.randint(2, 4)
        start = f'{start_year}-{rng.randint(1, 12):02d}'
        end = None if current else f'{year}-{rng.randint(1, 12):02d}'
        skills = rng.sample([s for s in SKILLS if s not in used] or SKILLS, 3)
        used += skills
        roles.append(
            {
                'title': rng.choice(TITLES),
                'employer': EMPLOYERS[(n + r * 5) % len(EMPLOYERS)],
                'start': start,
                'end': end,
                'is_current': current,
                'responsibilities': [
                    f'{rng.choice(VERBS)} {rng.choice(OBJECTS)} with {skills[0]} and {skills[1]}',
                    f'{rng.choice(VERBS)} {rng.choice(OBJECTS)} using {skills[2]}',
                ],
                'skills': skills,
            }
        )
        year = start_year
    extra = rng.sample([s for s in SKILLS if s not in used], 3)
    lead_skills = [str(s) for s in used[:3]]
    degree, field = DEGREES[n % len(DEGREES)]
    education = [
        {
            'institution': INSTITUTIONS[n % len(INSTITUTIONS)],
            'degree': degree,
            'field': field,
            'end_year': year - rng.randint(0, 2),
        }
    ]
    cert, issuer = CERTS[n % len(CERTS)]
    certs = (
        [{'certificate': cert, 'issuer': issuer, 'issued': f'2024-{rng.randint(1, 12):02d}'}]
        if n % 3
        else []
    )
    return {
        'id': f'G{n:02d}',
        'format': FORMATS[n % len(FORMATS)],
        'contact': {'full_name': f'{first} {last}', 'email': email, 'phone': phone},
        'location': f'{city}, {country}',
        'summary': f'{roles[0]["title"]} with experience in {", ".join(lead_skills)}.',
        'work_history': roles,
        'education': education,
        'certifications': certs,
        'skills': list(dict.fromkeys(used + extra)),
        'skills_line_extra': extra,
    }


def lines(r: dict[str, object]) -> list[tuple[str, str]]:
    """(kind, text) in document order; kind is h1 | h2 | body."""
    c = r['contact']
    assert isinstance(c, dict)
    out = [
        ('h1', c['full_name']),
        ('body', f'{c["email"]} | {c["phone"]} | {r["location"]}'),
        ('body', f'Ref: {r["id"]}'),
        ('h2', 'Summary'),
        ('body', str(r['summary'])),
        ('h2', 'Experience'),
    ]
    for role in r['work_history']:  # type: ignore[attr-defined]
        out.append(('body', f'{role["title"]} - {role["employer"]}'))
        end = 'Present' if role['is_current'] else human(role['end'])
        out.append(('body', f'{human(role["start"])} - {end}'))
        out += [('body', f'* {x}') for x in role['responsibilities']]
    out.append(('h2', 'Education'))
    for e in r['education']:  # type: ignore[attr-defined]
        out.append(('body', f'{e["degree"]} in {e["field"]}, {e["institution"]}, {e["end_year"]}'))
    if r['certifications']:
        out.append(('h2', 'Certifications'))
        for cert in r['certifications']:  # type: ignore[attr-defined]
            out.append(
                ('body', f'{cert["certificate"]} - {cert["issuer"]}, {human(cert["issued"])}')
            )
    out.append(('h2', 'Skills'))
    skills = list(r['skills'])  # type: ignore[call-overload]
    for i in range(0, len(skills), 4):
        out.append(('body', ', '.join(skills[i : i + 4])))
    return out


def write_pdf(r: dict[str, object], path: Path, columns: int) -> None:
    import pymupdf

    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    sizes = {'h1': 18.0, 'h2': 12.5, 'body': 9.5}
    items = lines(r)
    if columns == 1:
        y = 50.0
        for kind, text in items:
            y += sizes[kind] + 5
            if y > 800:
                page = doc.new_page(width=595, height=842)
                y = 50.0
            page.insert_text(
                (40, y), text, fontsize=sizes[kind], fontname='hebo' if kind != 'body' else 'helv'
            )
    else:
        # Header full width; Education / Certifications / Skills in a left column, the rest right.
        split = next(i for i, (k, t) in enumerate(items) if k == 'h2' and t == 'Education')
        header, right, left = items[:3], items[3:split], items[split:]
        y = 50.0
        for kind, text in header:
            y += sizes[kind] + 5
            page.insert_text(
                (40, y), text, fontsize=sizes[kind], fontname='hebo' if kind != 'body' else 'helv'
            )
        top = y + 20
        for x, block, width in ((40, left, 190), (260, right, 300)):
            yy = top
            for kind, text in block:
                yy += sizes[kind] + 5
                page.insert_textbox(
                    pymupdf.Rect(x, yy - sizes[kind], x + width, yy + 40),
                    text,
                    fontsize=sizes[kind] - 1,
                    fontname='hebo' if kind != 'body' else 'helv',
                )
                yy += 14 * (len(text) * (sizes[kind] - 1) * 0.5 // width)
    doc.save(path)


def write_docx(r: dict[str, object], path: Path) -> None:
    import docx

    document = docx.Document()
    items = lines(r)
    skills_at = next(i for i, (k, t) in enumerate(items) if k == 'h2' and t == 'Skills')
    for kind, text in items[:skills_at]:
        if kind == 'h1':
            document.add_heading(text, level=0)
        elif kind == 'h2':
            document.add_heading(text, level=1)
        else:
            document.add_paragraph(text)
    document.add_heading('Skills', level=1)
    table = document.add_table(rows=0, cols=1)
    for _, text in items[skills_at + 1 :]:
        table.add_row().cells[0].text = text
    document.save(str(path))


def main() -> None:
    FILES.mkdir(exist_ok=True)
    EXPECTED.mkdir(exist_ok=True)
    for n in range(50):
        r = make(n)
        fmt = r['format']
        ext = {'pdf': 'pdf', 'pdf2col': 'pdf', 'docx': 'docx', 'txt': 'txt'}[str(fmt)]
        target = FILES / f'{r["id"]}.{ext}'
        if fmt == 'pdf':
            write_pdf(r, target, 1)
        elif fmt == 'pdf2col':
            write_pdf(r, target, 2)
        elif fmt == 'docx':
            write_docx(r, target)
        else:
            target.write_text('\n'.join(t for _, t in lines(r)) + '\n')
        r['file'] = target.name
        (EXPECTED / f'{r["id"]}.json').write_text(json.dumps(r, indent=2) + '\n')


if __name__ == '__main__':
    main()
