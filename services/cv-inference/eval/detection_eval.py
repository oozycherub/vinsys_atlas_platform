"""Detection acceptance (docs/prompts/10 §8): labelled frame fixtures — no face, two faces, phone,
mismatched identity, low light — must give the expected detections with the production models.

A fixture directory holds JPEGs and labels.json:
    [{"file": "two_faces_01.jpg", "faces": 2, "objects": ["phone"], "identity": "candidate-a",
      "low_quality": false}, ...]
Frames with the same `identity` as a `reference: true` fixture are compared with it.

    uv run python eval/detection_eval.py fixtures/ --triton localhost:8001

Runs on the GPU evaluation job (needs Triton with models/); exit code 1 on any mismatch.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path
from typing import Any

import numpy as np

from cv_inference.domain.cascade import Cascade, Models
from cv_inference.domain.vision import decode_jpeg

MATCH = 0.45


async def evaluate(models: Models, directory: Path) -> dict[str, Any]:
    labels: list[dict[str, Any]] = json.loads((directory / 'labels.json').read_text())
    cascade = Cascade(models)
    refs: dict[str, np.ndarray] = {}
    for item in labels:
        if item.get('reference'):
            img = decode_jpeg((directory / item['file']).read_bytes())
            assert img is not None, item['file']
            ref = await cascade.frame(img, triggered=False, reference=True)
            if ref.embedding is not None:
                refs[item['identity']] = np.array(ref.embedding)
    failures: list[str] = []
    checked = 0
    for item in labels:
        if item.get('reference'):
            continue
        img = decode_jpeg((directory / item['file']).read_bytes())
        if img is None:
            failures.append(f'{item["file"]}: undecodable')
            continue
        out = await cascade.frame(img, triggered=bool(item.get('triggered', True)))
        checked += 1
        low = out.luminance < 40 or out.blur_variance < 60
        if bool(item.get('low_quality', False)) != low:
            failures.append(f'{item["file"]}: low_quality {low}')
            continue
        if low:
            continue
        if 'faces' in item and out.faces != item['faces']:
            failures.append(f'{item["file"]}: faces {out.faces}, want {item["faces"]}')
        for obj in item.get('objects', []):
            if obj not in out.objects:
                failures.append(f'{item["file"]}: missed {obj}')
        if 'identity' in item and out.embedding is not None and item['identity'] in refs:
            same = float(np.dot(out.embedding, refs[item['identity']])) >= MATCH
            if same != bool(item.get('same_person', True)):
                failures.append(f'{item["file"]}: identity match {same}')
    return {'checked': checked, 'failures': failures, 'passed': not failures and checked > 0}


def main(argv: list[str] | None = None) -> int:  # pragma: no cover - needs Triton
    parser = argparse.ArgumentParser(description='Detection acceptance on labelled fixtures')
    parser.add_argument('directory', type=Path)
    parser.add_argument('--triton', default='localhost:8001')
    args = parser.parse_args(argv)
    from cv_inference.infrastructure.triton import TritonModels

    report = asyncio.run(evaluate(TritonModels(args.triton, {}), args.directory))
    print(json.dumps(report, indent=2))
    return 0 if report['passed'] else 1


if __name__ == '__main__':  # pragma: no cover
    sys.exit(main())
