"""Live golden-set evaluation: field F1 of the real model, through a running llm-gateway.

The CI test (tests/test_golden.py) replaces the model with an oracle and so measures everything
around it. This script measures the model itself: the same 50 résumés go through extraction,
redaction and the registered `resume.extract@1` prompt, and the verified output is scored
against the expected JSON. It makes 50 billed model calls.

    GATEWAY_URL=http://localhost:8085 GATEWAY_TOKEN=<service token with llm:invoke> \\
    TENANT_ID=<uuid> uv run python scripts/eval_golden.py [--limit N]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from atlas_platform.presidio import PresidioDetector
from tests.test_golden import fields_expected

from parsing_svc.domain.layout import drop_hidden
from parsing_svc.domain.redact import redact
from parsing_svc.domain.schema import from_llm
from parsing_svc.domain.sections import segment
from parsing_svc.domain.verify import verify
from parsing_svc.infrastructure.clients import GatewayClient
from parsing_svc.infrastructure.extract import DocumentExtractor

GOLDEN = Path(__file__).resolve().parents[1] / 'tests' / 'golden'


class StaticToken:
    def __init__(self, token: str) -> None:
        self._token = token

    async def token(self) -> str:
        return self._token


async def main(limit: int) -> int:
    gateway = GatewayClient(os.environ['GATEWAY_URL'], StaticToken(os.environ['GATEWAY_TOKEN']))
    tenant = os.environ['TENANT_ID']
    await gateway.register_prompt()
    detector = PresidioDetector()
    extractor = DocumentExtractor()
    tp = fp = fn = 0
    for path in sorted((GOLDEN / 'expected').glob('G*.json'))[:limit]:
        expected = json.loads(path.read_text())
        data = (GOLDEN / 'files' / expected['file']).read_bytes()
        mime = {
            'pdf': 'application/pdf',
            'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'txt': 'text/plain',
        }[expected['file'].rsplit('.', 1)[1]]
        if mime == 'application/pdf':
            data = extractor.sanitize_pdf(data)
        seg = segment(drop_hidden(extractor.extract(mime, data))[0])
        red = redact(seg, await detector.detect(seg.text))
        result = await gateway.extract(tenant, red.text, list(red.pii_map.values()))
        verified = verify(from_llm(result.data), red.text)
        found: set[tuple[str, ...]] = set()
        for r, _ in verified.items.get('work_history', []):
            found.add(('role', (r['title'] or '').lower(), (r['employer'] or '').lower()))
            found.add(
                ('role_dates', (r['employer'] or '').lower(), r['start'], r['end'] or 'current')
            )
        for x, _ in verified.items.get('education', []):
            found.add(('education', (x['institution'] or '').lower(), (x['degree'] or '').lower()))
        for c, _ in verified.items.get('certifications', []):
            found.add(('certification', (c['certificate'] or '').lower()))
        for s, _ in verified.items.get('skills', []):
            found.add(('skill', s['raw'].lower()))
        c = red.contact
        for kind, value in (('name', c.full_name), ('email', c.email), ('phone', c.phone)):
            if value:
                found.add((kind, value if kind == 'phone' else value.lower()))
        want = fields_expected(expected)
        tp, fp, fn = tp + len(want & found), fp + len(found - want), fn + len(want - found)
        print(
            f'{expected["id"]}: missing {sorted(want - found)[:5]} extra {sorted(found - want)[:5]}'
        )
    precision, recall = tp / max(1, tp + fp), tp / max(1, tp + fn)
    f1 = 2 * precision * recall / max(1e-9, precision + recall)
    print(f'precision {precision:.3f} recall {recall:.3f} F1 {f1:.3f} (target 0.95)')
    return 0 if f1 >= 0.95 else 1


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--limit', type=int, default=50)
    sys.exit(asyncio.run(main(parser.parse_args().limit)))
