"""The attrition model (PRD §2.5(vi)): LightGBM with isotonic calibration, a time-based split,
SHAP drivers, and the governance gates that switch alerts off (ECE > 0.1, failed parity).

Artifacts are JSON (LightGBM's own text format and the calibration points), never pickles.
"""

from __future__ import annotations

import itertools
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any

import lightgbm as lgb
import numpy as np
import shap
from sklearn.isotonic import IsotonicRegression
from sklearn.metrics import roc_auc_score

from intelligence_ml.attrition.features import assert_no_protected, phrase

MAX_ECE = 0.1
MIN_PARITY = 0.8  # four-fifths rule on flag rates
TOP_SHARE = 0.10
MIN_TENANT_EMPLOYEES = 2000
MIN_TENANT_EXITS = 150
MIN_TRAIN_EXITS = 20
PSI_ALERT = 0.2
PARAMS: dict[str, Any] = {
    'objective': 'binary',
    'n_estimators': 200,
    'learning_rate': 0.05,
    'num_leaves': 15,
    'min_child_samples': 20,
    'subsample': 1.0,
    'colsample_bytree': 1.0,
    'deterministic': True,
    'num_threads': 1,
    'random_state': 7,
    'verbose': -1,
}


def expected_calibration_error(y: np.ndarray, p: np.ndarray, bins: int = 10) -> float:
    edges = np.linspace(0, 1, bins + 1)
    ece = 0.0
    for lo, hi in itertools.pairwise(edges):
        mask = (p >= lo) & ((p < hi) if hi < 1 else (p <= hi))
        if mask.any():
            ece += mask.mean() * abs(float(y[mask].mean()) - float(p[mask].mean()))
    return float(ece)


def precision_at(y: np.ndarray, p: np.ndarray, share: float = TOP_SHARE) -> float:
    k = max(1, round(len(p) * share))
    top = np.argsort(-p, kind='stable')[:k]
    return float(y[top].mean())


def parity(
    p: np.ndarray, groups: Mapping[str, Sequence[str | None]], share: float = TOP_SHARE
) -> dict[str, Any]:
    """Flag-rate ratio (min/max) per audit attribute, at the top-share threshold."""
    k = max(1, round(len(p) * share))
    threshold = np.sort(p)[::-1][k - 1]
    flagged = p >= threshold
    out: dict[str, Any] = {}
    for attr, values in groups.items():
        rates = {}
        for g in sorted({v for v in values if v is not None}):
            mask = np.array([v == g for v in values])
            if mask.sum() >= 20:
                rates[g] = float(flagged[mask].mean())
        if len(rates) >= 2:
            hi = max(rates.values())
            out[attr] = {
                'rates': rates,
                'ratio': round(min(rates.values()) / hi, 4) if hi > 0 else 1.0,
            }
    return out


def psi(expected: Sequence[float], actual: Sequence[float]) -> float:
    """Population stability index between two binned distributions (proportions)."""
    e = np.clip(np.asarray(expected, dtype=float), 1e-6, None)
    a = np.clip(np.asarray(actual, dtype=float), 1e-6, None)
    return float(np.sum((a - e) * np.log(a / e)))


def bin_edges(x: np.ndarray, bins: int = 10) -> list[float]:
    finite = x[np.isfinite(x)]
    if finite.size == 0:
        return []
    return [float(v) for v in np.unique(np.quantile(finite, np.linspace(0, 1, bins + 1)[1:-1]))]


def proportions(x: np.ndarray, edges: Sequence[float]) -> list[float]:
    finite = np.isfinite(x)
    counts = np.bincount(np.digitize(x[finite], edges), minlength=len(edges) + 1).astype(float)
    counts = np.append(counts, float((~finite).sum()))  # missing is its own bin
    return list(counts / max(1.0, counts.sum()))


@dataclass
class Trained:
    features: list[str]
    booster: lgb.Booster
    calibration: IsotonicRegression
    metrics: dict[str, Any]
    bins: dict[str, dict[str, list[float]]]
    alerts_enabled: bool
    disabled_reason: str | None
    excluded: dict[str, Any] = field(default_factory=dict)

    def predict(self, X: np.ndarray) -> np.ndarray:
        raw = self.booster.predict(X)
        out: np.ndarray = np.clip(self.calibration.predict(np.asarray(raw, dtype=float)), 0.0, 1.0)
        return out

    def drivers(self, X: np.ndarray, top: int = 3) -> list[list[dict[str, Any]]]:
        """SHAP top drivers per row (contributions towards leaving), as HRBP phrases."""
        values = np.asarray(shap.TreeExplainer(self.booster).shap_values(X))
        if values.ndim == 3:  # some versions return one matrix per class
            values = values[-1] if values.shape[0] == 2 else values[..., -1]
        out: list[list[dict[str, Any]]] = []
        for i in range(X.shape[0]):
            order = np.argsort(-values[i], kind='stable')
            row = []
            for j in order[:top]:
                if values[i, j] <= 0:
                    break
                v = X[i, j]
                row.append(
                    {
                        'feature': self.features[j],
                        'shap': round(float(values[i, j]), 4),
                        'phrase': phrase(self.features[j], float(v))
                        if np.isfinite(v)
                        else self.features[j],
                    }
                )
            out.append(row)
        return out

    def artifact(self) -> dict[str, Any]:
        return {
            'booster': self.booster.model_to_string(),
            'calibration': {
                'x': [float(v) for v in self.calibration.X_thresholds_],
                'y': [float(v) for v in self.calibration.y_thresholds_],
            },
            'bins': self.bins,
            'features': self.features,
        }


def load(a: Mapping[str, Any], *, alerts_enabled: bool = True) -> Trained:
    """A stored model. Refitting isotonic regression on its own thresholds reproduces it."""
    booster = lgb.Booster(model_str=a['booster'])
    iso = IsotonicRegression(out_of_bounds='clip', y_min=0.0, y_max=1.0)
    iso.fit(np.asarray(a['calibration']['x']), np.asarray(a['calibration']['y']))
    return Trained(list(a['features']), booster, iso, {}, dict(a['bins']), alerts_enabled, None)


def train(
    X: np.ndarray,
    y: np.ndarray,
    order: np.ndarray,
    features: Sequence[str],
    audit: Mapping[str, Sequence[str | None]] | None = None,
) -> Trained | None:
    """Time-based split on `order` (the snapshot dates): oldest 60% train, next 20% calibrate,
    latest 20% evaluate. None when there are too few exits to learn from."""
    assert_no_protected(features)
    idx = np.argsort(order, kind='stable')
    n = len(idx)
    a, b = int(n * 0.6), int(n * 0.8)
    tr, ca, te = idx[:a], idx[a:b], idx[b:]
    if y[tr].sum() < MIN_TRAIN_EXITS or y[te].sum() < 5 or y[ca].sum() < 5:
        return None
    clf = lgb.LGBMClassifier(**PARAMS)
    clf.fit(X[tr], y[tr])
    booster = clf.booster_
    iso = IsotonicRegression(out_of_bounds='clip', y_min=0.0, y_max=1.0)
    iso.fit(np.asarray(booster.predict(X[ca]), dtype=float), y[ca])
    p = np.clip(iso.predict(np.asarray(booster.predict(X[te]), dtype=float)), 0.0, 1.0)
    metrics: dict[str, Any] = {
        'auc': round(float(roc_auc_score(y[te], p)), 4),
        'precision_at_10': round(precision_at(y[te], p), 4),
        'ece': round(expected_calibration_error(y[te], p), 4),
        'rows': {'train': len(tr), 'calibration': len(ca), 'test': len(te)},
        'exits': {'train': int(y[tr].sum()), 'test': int(y[te].sum())},
    }
    reasons = []
    if metrics['ece'] > MAX_ECE:
        reasons.append(f'ece {metrics["ece"]} > {MAX_ECE}')
    if audit:
        metrics['parity'] = parity(p, {k: [v[i] for i in te] for k, v in audit.items()})
        for attr, r in metrics['parity'].items():
            if r['ratio'] < MIN_PARITY:
                reasons.append(f'parity on {attr} {r["ratio"]} < {MIN_PARITY}')
    bins = {}
    for j, f in enumerate(features):
        edges = bin_edges(X[tr, j])
        bins[f] = {'edges': edges, 'expected': proportions(X[tr, j], edges)}
    return Trained(
        list(features),
        booster,
        iso,
        metrics,
        bins,
        alerts_enabled=not reasons,
        disabled_reason='; '.join(reasons) or None,
    )


def drift(
    bins: Mapping[str, Mapping[str, list[float]]], X: np.ndarray, features: Sequence[str]
) -> dict[str, float]:
    """PSI per feature between the training distribution and today's scoring population."""
    return {
        f: round(psi(bins[f]['expected'], proportions(X[:, j], bins[f]['edges'])), 4)
        for j, f in enumerate(features)
        if f in bins
    }
