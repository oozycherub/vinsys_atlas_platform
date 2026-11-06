"""The checked-in model card and evaluation report are what eval/evaluate.py produces."""

from __future__ import annotations

import evaluate


def test_the_checked_in_report_and_card_are_current() -> None:
    assert (evaluate.DOCS / 'model_card.md').read_text() == evaluate.card()
    assert (evaluate.DOCS / 'evaluation_report.md').read_text() == evaluate.report(
        evaluate.evaluate()
    ), 'run: python eval/evaluate.py'
