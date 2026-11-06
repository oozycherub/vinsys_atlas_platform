"""Offline human-AI agreement (PRD §2.4 acceptance: κ ≥ 0.7 on the calibration set).

The calibration set is JSONL, one scored competency per line:
    {"session": "...", "skill_id": "...", "human": 1-5 | null, "ai": 1-5 | null}
`ai` comes from the final scorer run in calibration mode (ATLAS_INTERVIEW_CALIBRATION=on routes it
to the eval model); `human` from trained raters. Agreement is quadratic-weighted Cohen's kappa
over items both scored; "insufficient evidence" (null) is reported separately, never imputed.

    python eval/calibration.py calibration.jsonl [--min-kappa 0.7]
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from pathlib import Path

LEVELS = (1, 2, 3, 4, 5)


def weighted_kappa(a: Sequence[int], b: Sequence[int], levels: Sequence[int] = LEVELS) -> float:
    """Quadratic-weighted Cohen's kappa for two raters on an ordinal scale."""
    if len(a) != len(b) or not a:
        raise ValueError('need two equally long, non-empty rating lists')
    k = len(levels)
    index = {v: i for i, v in enumerate(levels)}
    observed = [[0.0] * k for _ in range(k)]
    for x, y in zip(a, b, strict=True):
        observed[index[x]][index[y]] += 1
    n = float(len(a))
    row = [sum(r) for r in observed]
    col = [sum(observed[i][j] for i in range(k)) for j in range(k)]
    num = den = 0.0
    for i in range(k):
        for j in range(k):
            w = ((i - j) ** 2) / ((k - 1) ** 2)
            num += w * observed[i][j]
            den += w * row[i] * col[j] / n
    return 1.0 if den == 0 else 1.0 - num / den


@dataclass(frozen=True)
class Report:
    items: int
    paired: int
    kappa: float | None
    exact: float | None
    within_one: float | None
    ai_insufficient: int
    human_insufficient: int

    def passes(self, min_kappa: float) -> bool:
        return self.kappa is not None and self.kappa >= min_kappa


def evaluate(rows: Iterable[dict[str, object]]) -> Report:
    pairs: list[tuple[int, int]] = []
    items = ai_null = human_null = 0
    for r in rows:
        items += 1
        human, ai = r.get('human'), r.get('ai')
        if ai is None:
            ai_null += 1
        if human is None:
            human_null += 1
        if isinstance(human, int) and isinstance(ai, int):
            pairs.append((human, ai))
    if not pairs:
        return Report(items, 0, None, None, None, ai_null, human_null)
    h, a = [p[0] for p in pairs], [p[1] for p in pairs]
    return Report(
        items=items,
        paired=len(pairs),
        kappa=round(weighted_kappa(h, a), 4),
        exact=round(sum(x == y for x, y in pairs) / len(pairs), 4),
        within_one=round(sum(abs(x - y) <= 1 for x, y in pairs) / len(pairs), 4),
        ai_insufficient=ai_null,
        human_insufficient=human_null,
    )


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('path', type=Path)
    parser.add_argument('--min-kappa', type=float, default=0.7)
    args = parser.parse_args(argv)
    rows = [json.loads(line) for line in args.path.read_text().splitlines() if line.strip()]
    report = evaluate(rows)
    sys.stdout.write(json.dumps(report.__dict__, indent=2) + '\n')
    return 0 if report.passes(args.min_kappa) else 1


if __name__ == '__main__':
    raise SystemExit(main())
