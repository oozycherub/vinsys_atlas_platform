"""Golden set (Component Prompt 06 §8): 50 anonymised résumés, field F1 ≥ 0.95.

The model is replaced by an oracle that returns each résumé's expected data with verbatim
evidence quotes, so this measures everything *around* the model: the security gate, extraction
(PDF, two-column PDF, DOCX tables, text), reading order, segmentation, redaction (which must not
eat employers, titles or skills), evidence verification, normalisation and contact extraction.
The live-model F1 is measured by scripts/eval_golden.py against a running llm-gateway.
"""

from __future__ import annotations

import json
from typing import Any

from atlas_platform.ids import uuid7

from parsing_svc.infrastructure.repositories import PgBatchRepository
from tests.conftest import GOLDEN, World, expected, golden_file

F1_TARGET = 0.95


def fields_expected(e: dict[str, Any]) -> set[tuple[str, ...]]:
    out: set[tuple[str, ...]] = set()
    for r in e['work_history']:
        out.add(('role', r['title'].lower(), r['employer'].lower()))
        out.add(('role_dates', r['employer'].lower(), r['start'], r['end'] or 'current'))
    for x in e['education']:
        out.add(('education', x['institution'].lower(), x['degree'].lower()))
    for c in e['certifications']:
        out.add(('certification', c['certificate'].lower()))
    for s in e['skills']:
        out.add(('skill', s.lower()))
    c = e['contact']
    out |= {('name', c['full_name'].lower()), ('email', c['email'].lower()), ('phone', c['phone'])}
    return out


def fields_found(profile: dict[str, Any], contact: Any) -> set[tuple[str, ...]]:
    out: set[tuple[str, ...]] = set()
    for r in profile['work_history']:
        out.add(('role', (r['title'] or '').lower(), (r['employer'] or '').lower()))
        out.add(('role_dates', (r['employer'] or '').lower(), r['start'], r['end'] or 'current'))
    for x in profile['education']:
        out.add(('education', (x['institution'] or '').lower(), (x['degree'] or '').lower()))
    for c in profile['certifications']:
        out.add(('certification', (c['certificate'] or '').lower()))
    for s in profile['skills']:
        if s['skill_id']:
            out.add(('skill', s['raw'].lower()))
    if contact is not None:
        for kind, value in (
            ('name', contact.full_name),
            ('email', contact.email),
            ('phone', contact.phone),
        ):
            if value:
                out.add((kind, value if kind == 'phone' else value.lower()))
    return out


async def test_golden_set_f1(world: World) -> None:
    refs = sorted(p.stem for p in (GOLDEN / 'expected').glob('G*.json'))
    assert len(refs) == 50
    batches = PgBatchRepository()
    batch = uuid7()
    async with world.db.tenant_tx(world.tenant) as tx:
        await batches.create(
            tx, tenant_id=world.tenant, batch_id=batch, by='golden', items=[('.pdf', 1)] * 50
        )

    tp = fp = fn = 0
    misses: dict[str, list[str]] = {}
    for n, ref in enumerate(refs):
        data, mime = golden_file(ref)
        candidate = str(__import__('uuid').uuid4())
        async with world.db.tenant_tx(world.tenant) as tx:
            await batches.update_item(
                tx, batch, n, candidate_id=candidate
            )  # a placeholder candidate
        world.llm.ref = ref
        job = await world.parse(data, mime, candidate=candidate)
        assert job.status == 'succeeded', (ref, job.error_code)
        event = next(
            e
            for e in await world.events('profile.resume.parsed.v1')
            if e['document_id'] == job.document_id
        )
        e = expected(ref)
        want = fields_expected(e)
        got = fields_found(event['profile'], world.profile.contacts.get(candidate))
        tp += len(want & got)
        fp += len(got - want)
        fn += len(want - got)
        if want != got:
            misses[ref] = sorted(' '.join(x) for x in (want ^ got))
        # PII from the contact block never reaches the event or the model.
        blob = json.dumps(event)
        for value in e['contact'].values():
            assert value not in blob, (ref, value)
            assert value not in world.llm.texts[-1], (ref, value)

    precision = tp / (tp + fp)
    recall = tp / (tp + fn)
    f1 = 2 * precision * recall / (precision + recall)
    print(f'golden set: precision {precision:.3f} recall {recall:.3f} F1 {f1:.3f}')
    print(json.dumps(misses, indent=1))
    assert f1 >= F1_TARGET, json.dumps({'f1': f1, 'misses': misses}, indent=1)[:12000]
