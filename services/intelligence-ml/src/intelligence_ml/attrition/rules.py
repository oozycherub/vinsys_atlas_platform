"""The alerting rule (PRD §2.5(vi)):

alert if p ≥ threshold (default 0.35) and (Δp over 30 days ≥ 0.10 or first crossing),
at most one alert per employee per 60 days.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, timedelta

DEFAULT_THRESHOLD = 0.35
MIN_DELTA = 0.10
DELTA_WINDOW = timedelta(days=30)
THROTTLE = timedelta(days=60)


@dataclass(frozen=True)
class Decision:
    alert: bool
    delta_30d: float | None
    first_crossing: bool
    reason: str


def decide(
    today: date,
    p: float,
    history: Sequence[tuple[date, float]],
    last_alert: date | None,
    threshold: float = DEFAULT_THRESHOLD,
) -> Decision:
    """`history` holds earlier scores (before today), any order."""
    earlier = sorted((d, v) for d, v in history if d < today)
    then = [v for d, v in earlier if d <= today - DELTA_WINDOW]
    delta = round(p - then[-1], 4) if then else None
    first = not any(v >= threshold for _, v in earlier)
    if p < threshold:
        return Decision(False, delta, False, 'below_threshold')
    if last_alert is not None and today - last_alert < THROTTLE:
        return Decision(False, delta, first, 'throttled')
    if first:
        return Decision(True, delta, True, 'first_crossing')
    if delta is not None and delta >= MIN_DELTA:
        return Decision(True, delta, False, 'rising')
    return Decision(False, delta, False, 'no_change')
