"""Face-verification fairness (docs/prompts/10 §8, PRD §4.1): error-rate parity across skin-type
cohorts must be within a ratio of 1.5, at the production threshold (cosine >= 0.45).

Input: a CSV of verification pairs scored by the production models, with columns
    cohort,same_person,cosine
where `cohort` is a Fitzpatrick skin-type group (e.g. I-II, III-IV, V-VI) from a consented,
fairness-balanced evaluation set, `same_person` is 1/0 and `cosine` the ArcFace similarity.

    uv run python eval/fairness.py pairs.csv [--threshold 0.45] [--max-ratio 1.5]

Exit code 1 when parity fails (a release gate). Protected attributes live only in this offline
evaluation set, never in production data (PRD §4.1).
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
from dataclasses import dataclass
from pathlib import Path

THRESHOLD = 0.45
MAX_RATIO = 1.5
MIN_PAIRS = 50  # per cohort and pair type; fewer is not evidence


@dataclass(frozen=True)
class CohortRates:
    cohort: str
    genuine: int
    impostor: int
    fnmr: float  # genuine pairs rejected (a candidate wrongly flagged as someone else)
    fmr: float  # impostor pairs accepted (an impersonation missed)


def rates(rows: list[dict[str, str]], threshold: float = THRESHOLD) -> list[CohortRates]:
    cohorts: dict[str, list[tuple[bool, float]]] = {}
    for r in rows:
        cohorts.setdefault(r['cohort'], []).append(
            (r['same_person'] in ('1', 'true', 'True'), float(r['cosine']))
        )
    out = []
    for name, pairs in sorted(cohorts.items()):
        genuine = [c for same, c in pairs if same]
        impostor = [c for same, c in pairs if not same]
        fnmr = sum(c < threshold for c in genuine) / len(genuine) if genuine else 0.0
        fmr = sum(c >= threshold for c in impostor) / len(impostor) if impostor else 0.0
        out.append(CohortRates(name, len(genuine), len(impostor), round(fnmr, 4), round(fmr, 4)))
    return out


def parity_ratio(values: list[float], floor: float = 0.001) -> float:
    """Worst / best error rate; a floor keeps a perfect cohort from making the ratio infinite."""
    if not values:
        return 1.0
    return max(values) / max(min(values), floor) if max(values) > 0 else 1.0


def evaluate(
    rows: list[dict[str, str]], threshold: float = THRESHOLD, max_ratio: float = MAX_RATIO
) -> dict[str, object]:
    per = rates(rows, threshold)
    problems = [
        f'{c.cohort}: {c.genuine} genuine / {c.impostor} impostor pairs (need >= {MIN_PAIRS} each)'
        for c in per
        if c.genuine < MIN_PAIRS or c.impostor < MIN_PAIRS
    ]
    fnmr_ratio = parity_ratio([c.fnmr for c in per])
    fmr_ratio = parity_ratio([c.fmr for c in per])
    passed = not problems and len(per) >= 2 and fnmr_ratio <= max_ratio and fmr_ratio <= max_ratio
    return {
        'threshold': threshold,
        'max_ratio': max_ratio,
        'cohorts': [c.__dict__ for c in per],
        'fnmr_ratio': round(fnmr_ratio, 3),
        'fmr_ratio': round(fmr_ratio, 3),
        'problems': problems if len(per) >= 2 else [*problems, 'at least two cohorts are needed'],
        'passed': passed,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('pairs', type=Path)
    parser.add_argument('--threshold', type=float, default=THRESHOLD)
    parser.add_argument('--max-ratio', type=float, default=MAX_RATIO)
    args = parser.parse_args(argv)
    with args.pairs.open(newline='') as f:
        report = evaluate(list(csv.DictReader(f)), args.threshold, args.max_ratio)
    print(json.dumps(report, indent=2))
    return 0 if report['passed'] else 1


if __name__ == '__main__':  # pragma: no cover
    sys.exit(main())
