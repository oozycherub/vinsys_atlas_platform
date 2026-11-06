"""The offline κ evaluation (the real calibration set needs human raters and the eval model)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from calibration import evaluate, main, weighted_kappa


def test_weighted_kappa() -> None:
    assert weighted_kappa([1, 2, 3, 4, 5], [1, 2, 3, 4, 5]) == 1.0
    assert weighted_kappa([3, 3, 3], [3, 3, 3]) == 1.0  # no disagreement possible
    assert weighted_kappa([1, 5, 1, 5], [5, 1, 5, 1]) < 0
    near = weighted_kappa([1, 2, 3, 4, 5, 3], [2, 2, 3, 4, 4, 3])
    assert 0.8 < near < 1.0
    with pytest.raises(ValueError, match='equally long'):
        weighted_kappa([1], [])


def test_report_and_cli(tmp_path: Path) -> None:
    rows: list[dict[str, object]] = [
        {'human': 4, 'ai': 4},
        {'human': 2, 'ai': 3},
        {'human': 5, 'ai': 5},
        {'human': 1, 'ai': 1},
        {'human': 3, 'ai': None},
        {'human': None, 'ai': 2},
    ]
    report = evaluate(rows)
    assert (report.items, report.paired, report.ai_insufficient, report.human_insufficient) == (
        6,
        4,
        1,
        1,
    )
    assert report.exact == 0.75
    assert report.within_one == 1.0
    assert report.passes(0.7)
    assert not evaluate([{'human': None, 'ai': None}]).passes(0.7)
    path = tmp_path / 'set.jsonl'
    path.write_text('\n'.join(json.dumps(r) for r in rows) + '\n')
    assert main([str(path)]) == 0
    assert main([str(path), '--min-kappa', '0.99']) == 1
