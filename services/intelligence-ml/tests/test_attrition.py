"""Attrition: features and their governance, the model and its gates, SHAP drivers, the alert
rule, drift, and the whole nightly pipeline on a synthetic workforce."""

from __future__ import annotations

import json
import os
import re
from datetime import date, timedelta
from pathlib import Path

import numpy as np
import pytest
from atlas_platform.db import PgDatabase

from intelligence_ml import gaps, synthetic
from intelligence_ml.attrition import features as feats
from intelligence_ml.attrition import model as mdl
from intelligence_ml.attrition import pipeline
from intelligence_ml.attrition.rules import decide
from tests.conftest import FIXTURES, employee, uid

TODAY = date(2026, 11, 6)


# --- features ---------------------------------------------------------------------------------


def test_no_protected_attribute_is_ever_a_feature() -> None:
    feats.assert_no_protected(feats.FEATURE_NAMES)
    for name in (
        'gender',
        'age_band',
        'Ethnicity',
        'marital_status',
        'nationality',
        'has-disability',
    ):
        with pytest.raises(feats.ProtectedFeatureError):
            feats.assert_no_protected([*feats.FEATURE_NAMES, name])
    with pytest.raises(feats.ProtectedFeatureError):
        mdl.train(np.zeros((10, 1)), np.zeros(10), np.arange(10), ['age'])


def test_the_feast_repository_declares_the_same_features() -> None:
    source = (Path(__file__).resolve().parents[1] / 'feature_repo' / 'features.py').read_text()
    declared = re.findall(r"Field\(name='(\w+)'", source)
    assert tuple(declared) == feats.FEATURE_NAMES
    feats.assert_no_protected(declared)


def test_compute_features() -> None:
    six = TODAY - timedelta(days=100)
    me = {
        'employee_id': 'me',
        'hired_at': TODAY - timedelta(days=3 * 365),
        'last_promotion_at': None,
        'role_started_at': TODAY - timedelta(days=365),
        'manager_changed_at': six,
        'compa_ratio': 0.9,
        'engagement_delta': -1.0,
        'overtime_hours_4w': None,
    }
    leaver = {'terminated_at': TODAY - timedelta(days=30), 'termination_voluntary': True}
    fired = {'terminated_at': TODAY - timedelta(days=30), 'termination_voluntary': False}
    old = {'terminated_at': TODAY - timedelta(days=400), 'termination_voluntary': True}
    f = feats.compute(
        TODAY,
        me,
        team=[leaver, fired, {}, {}],
        department=[leaver, old],
        skill_gap=0.3,
        skill_gap_6m_ago=0.2,
        applications_6m=2,
        rejections_6m=1,
    )
    assert f['tenure_months'] == pytest.approx(36, abs=0.1)
    assert f['months_since_promotion'] == f['tenure_months']  # never promoted: since hire
    assert f['months_in_role'] == pytest.approx(12, abs=0.1)
    assert (f['manager_changed_6m'], f['team_attrition_6m'], f['peer_exits_6m']) == (1.0, 0.25, 1.0)
    assert f['skill_gap_trend'] == pytest.approx(0.1)
    assert (f['overtime_hours_4w'], f['compa_ratio']) == (None, 0.9)
    assert feats.phrase('months_since_promotion', 34.2) == 'No promotion in 34 months'
    assert feats.phrase('compa_ratio', 0.87) == 'Pay at 87% of the band midpoint'
    assert feats.phrase('manager_changed_6m', 1) == 'Manager changed in the last 6 months'
    assert feats.phrase('unknown', 1) == 'unknown'


def test_proxies_for_protected_attributes_are_dropped() -> None:
    fs = synthetic.features(400, 3, proxy=True)
    X = pipeline.matrix(fs.rows, feats.FEATURE_NAMES)
    report = feats.proxy_report(X, feats.FEATURE_NAMES, fs.audit)
    keep, dropped = feats.select(feats.FEATURE_NAMES, report)
    assert list(dropped) == ['engagement_delta']
    assert dropped['engagement_delta']['gender'] > feats.MI_PROXY_LIMIT
    assert 'engagement_delta' not in keep
    assert all(v <= feats.MI_PROXY_LIMIT for n in keep for v in report.get(n, {}).values())
    # Too few audited people: no verdict, nothing dropped.
    assert (
        feats.proxy_report(X[:10], feats.FEATURE_NAMES, {'gender': fs.audit['gender'][:10]}) == {}
    )


# --- model ------------------------------------------------------------------------------------


def trained(n: int = 1500, **kw: object) -> tuple[mdl.Trained, np.ndarray]:
    fs = synthetic.features(n, 6, **kw)  # type: ignore[arg-type]
    X = pipeline.matrix(fs.rows, feats.FEATURE_NAMES)
    m = mdl.train(X, fs.y, fs.order, list(feats.FEATURE_NAMES), fs.audit)
    assert m is not None
    return m, X


def test_the_model_learns_and_is_calibrated() -> None:
    m, X = trained()
    assert m.metrics['auc'] >= 0.75  # synthetic data: the real gate runs on tenant history
    assert m.metrics['precision_at_10'] >= 0.40
    assert m.metrics['ece'] <= mdl.MAX_ECE
    assert m.metrics['parity']['gender']['ratio'] >= mdl.MIN_PARITY
    assert m.alerts_enabled
    p = m.predict(X[:50])
    assert ((p >= 0) & (p <= 1)).all()
    # The artifact is JSON and round-trips exactly (no pickles).
    restored = mdl.load(json.loads(json.dumps(m.artifact())))
    assert np.allclose(restored.predict(X[:50]), p)


def test_drivers_are_shap_contributions_in_plain_words() -> None:
    m, X = trained()
    rows = m.drivers(X[:20])
    assert all(len(r) <= 3 for r in rows)
    first = next(r for r in rows if r)
    assert all(d['shap'] > 0 for d in first)
    assert first == sorted(first, key=lambda d: -d['shap'])
    phrases = {d['feature'] for r in rows for d in r}
    assert 'months_since_promotion' in phrases
    assert any(d['phrase'].startswith('No promotion in') for r in rows for d in r)


def test_governance_gates_disable_alerts(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mdl, 'MAX_ECE', 0.0)
    m, _ = trained(800)
    assert not m.alerts_enabled
    assert 'ece' in (m.disabled_reason or '')
    monkeypatch.setattr(mdl, 'MAX_ECE', 0.1)
    # An audit attribute that tracks the label: flag rates differ, the four-fifths check fails.
    fs = synthetic.features(1500, 6)
    unfair = {'group': ['a' if y else ('a' if i % 9 == 0 else 'b') for i, y in enumerate(fs.y)]}
    X = pipeline.matrix(fs.rows, feats.FEATURE_NAMES)
    biased = mdl.train(X, fs.y, fs.order, list(feats.FEATURE_NAMES), unfair)
    assert biased is not None
    assert biased.metrics['parity']['group']['ratio'] < mdl.MIN_PARITY
    assert not biased.alerts_enabled
    assert 'parity' in (biased.disabled_reason or '')
    # Too few exits to learn from: no model at all.
    assert (
        mdl.train(X[:100], np.zeros(100, dtype=int), fs.order[:100], list(feats.FEATURE_NAMES))
        is None
    )


def test_metric_helpers() -> None:
    y = np.array([0, 0, 1, 1])
    assert mdl.expected_calibration_error(y, np.array([0.0, 0.0, 1.0, 1.0])) == 0
    assert mdl.expected_calibration_error(y, np.array([0.5, 0.5, 0.5, 0.5])) == pytest.approx(0.0)
    assert mdl.expected_calibration_error(y, np.array([1.0, 1.0, 0.0, 0.0])) == pytest.approx(1.0)
    assert mdl.precision_at(np.array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]), np.linspace(1, 0, 10)) == 1.0
    assert mdl.psi([0.5, 0.5], [0.5, 0.5]) == pytest.approx(0)
    assert mdl.psi([0.5, 0.5], [0.9, 0.1]) > mdl.PSI_ALERT
    x = np.array([1.0, 2.0, 3.0, np.nan])
    edges = mdl.bin_edges(x, 2)
    assert sum(mdl.proportions(x, edges)) == pytest.approx(1)
    assert mdl.bin_edges(np.array([np.nan])) == []


def test_drift_is_measured_per_feature() -> None:
    m, X = trained(800)
    same = mdl.drift(m.bins, X, m.features)
    assert max(same.values()) < mdl.PSI_ALERT
    shifted = X.copy()
    shifted[:, m.features.index('months_since_promotion')] += 40
    assert mdl.drift(m.bins, shifted, m.features)['months_since_promotion'] > mdl.PSI_ALERT


# --- the alert rule ---------------------------------------------------------------------------


def test_alert_rule() -> None:
    d = TODAY
    assert decide(d, 0.30, [], None).reason == 'below_threshold'
    assert decide(d, 0.40, [], None).reason == 'first_crossing'
    assert decide(d, 0.40, [(d - timedelta(days=40), 0.20)], None).alert  # first crossing too
    risen = decide(d, 0.50, [(d - timedelta(days=40), 0.38), (d - timedelta(days=31), 0.39)], None)
    assert (risen.alert, risen.reason, risen.delta_30d) == (True, 'rising', 0.11)
    flat = decide(d, 0.45, [(d - timedelta(days=35), 0.40)], None)
    assert (flat.alert, flat.reason) == (False, 'no_change')
    recent = decide(d, 0.45, [(d - timedelta(days=10), 0.10)], None)  # only within 30 days
    assert recent.delta_30d is None
    assert decide(d, 0.90, [], d - timedelta(days=59)).reason == 'throttled'
    assert decide(d, 0.90, [], d - timedelta(days=60)).alert  # 60 days later: allowed again
    assert decide(d, 0.30, [], None, threshold=0.25).alert  # the tenant's threshold


# --- the pipeline -----------------------------------------------------------------------------


async def seed_roster(db: PgDatabase, tenant: str, n: int) -> list[dict]:  # type: ignore[type-arg]
    rows = synthetic.roster(n, TODAY)
    async with db.tenant_tx(tenant) as tx:
        for r in rows:
            await tx.execute(
                """INSERT INTO intel_employees (tenant_id, employee_id, manager_user_id, department, hired_at,
                     role_started_at, last_promotion_at, manager_changed_at, compa_ratio, status, terminated_at,
                     termination_voluntary, marketplace_opt_in, source_synced_at)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, true, now())""",
                (
                    tenant,
                    r['employee_id'],
                    r['manager_user_id'],
                    r['department'],
                    r['hired_at'],
                    r['role_started_at'],
                    r['last_promotion_at'],
                    r['manager_changed_at'],
                    r['compa_ratio'],
                    r['status'],
                    r['terminated_at'],
                    r['termination_voluntary'],
                ),
            )
        await tx.execute("SELECT set_config('app.hrbp', 'on', true)")
        for r in rows:
            await tx.execute(
                'INSERT INTO intel_employee_protected (tenant_id, employee_id, attributes) VALUES (%s, %s, %s)',
                (tenant, r['employee_id'], json.dumps({'gender': r['gender']})),
            )
    return rows


async def test_the_nightly_pipeline_end_to_end(db: PgDatabase, tenant: str) -> None:
    roster = await seed_roster(db, tenant, 700)
    exits = sum(1 for r in roster if r['termination_voluntary'])
    assert exits > 60
    # Back-fill monthly snapshots, as the nightly job would have written them.
    for months in range(18, -1, -1):
        await pipeline.snapshot(db, tenant, TODAY - timedelta(days=30 * months))
    versions = await pipeline.train(db, TODAY)
    assert versions[tenant] is not None
    assert str(versions[tenant]).startswith('pooled-')  # far below 2,000 employees / 150 exits
    report = await pipeline.score(db, tenant, TODAY)
    active = sum(1 for r in roster if r['status'] == 'active')
    assert report['scored'] == active
    async with pipeline.hrbp_tx(db, tenant) as tx:
        model = (await tx.fetch('SELECT * FROM attrition_models WHERE active'))[0]
        alerts = await tx.fetch('SELECT * FROM attrition_alerts')
        scores = await tx.fetch('SELECT * FROM attrition_scores')
        events = await tx.fetch(
            "SELECT payload FROM outbox_events WHERE topic = 'intel.attrition.alert_raised.v1'"
        )
    assert model['excluded'] == {}  # gender is independent of every feature here
    assert set(model['features']) == set(feats.FEATURE_NAMES)
    assert model['psi']
    assert len(scores) == active
    assert all(
        len(json.loads(s['drivers']) if isinstance(s['drivers'], str) else s['drivers']) <= 3
        for s in scores
    )
    assert model['alerts_enabled'], model['disabled_reason']
    if model['alerts_enabled']:
        assert report['alerts'] == len(alerts) == len(events) > 0
        e = events[0]['payload']
        assert set(e) == {
            'tenant_id',
            'alert_id',
            'employee_id',
            'manager_user_id',
            'recipients',
            'drivers',
            'suggested_actions',
            'model_version',
            'occurred_at',
        }
        assert 'probability' not in e  # the score never travels on the bus
        assert e['recipients'] == ['hrbp', 'manager']
        # The recorded contract for the notification service (brick 13).
        recorded = {**e, 'drivers': ['{{driver}}'] * len(e['drivers'])}
        for k in (
            'tenant_id',
            'alert_id',
            'employee_id',
            'manager_user_id',
            'model_version',
            'occurred_at',
        ):
            recorded[k] = '{{' + k + '}}'
        doc = {
            'payload': dict(sorted(recorded.items())),
            'topic': 'intel.attrition.alert_raised.v1',
        }
        path = FIXTURES / 'intel.attrition.alert_raised.v1.json'
        if os.environ.get('ATLAS_UPDATE_FIXTURES') == '1':
            path.write_text(json.dumps(doc, indent=2) + '\n')
        assert json.loads(path.read_text()) == doc, f'{path.name} is stale'
        # The next night: still high, but throttled (one alert per 60 days).
        await pipeline.snapshot(db, tenant, TODAY + timedelta(days=1))
        again = await pipeline.score(db, tenant, TODAY + timedelta(days=1))
        assert again['alerts'] == 0
    # Without the HRBP context the attrition tables look empty, even inside the tenant.
    async with db.tenant_tx(tenant) as tx:
        assert await tx.fetch('SELECT 1 FROM attrition_scores') == []
        assert await tx.fetch('SELECT 1 FROM intel_employee_protected') == []
    # Nothing to score for a tenant without a model.
    assert await pipeline.score(db, uid(), TODAY) == {'scored': 0, 'alerts': 0}


async def test_alerts_stay_off_when_the_model_is_gated(
    db: PgDatabase, tenant: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(mdl, 'MAX_ECE', 0.0)
    await seed_roster(db, tenant, 500)
    for months in range(18, -1, -2):
        await pipeline.snapshot(db, tenant, TODAY - timedelta(days=30 * months))
    await pipeline.train(db, TODAY)
    report = await pipeline.score(db, tenant, TODAY)
    assert report['scored'] > 0
    assert report['alerts'] == 0  # analytics only
    async with pipeline.hrbp_tx(db, tenant) as tx:
        m = (
            await tx.fetch(
                'SELECT alerts_enabled, disabled_reason FROM attrition_models WHERE active'
            )
        )[0]
    assert (m['alerts_enabled'], 'ece' in m['disabled_reason']) == (False, True)


async def test_too_little_history_means_no_model(db: PgDatabase, tenant: str) -> None:
    await seed_roster(db, tenant, 30)
    await pipeline.snapshot(db, tenant, TODAY)
    out = await pipeline.train(db, TODAY)
    assert tenant in out
    rows = await pipeline.nightly(db, TODAY)
    assert tenant in rows


async def test_skill_gap_rebuild(db: PgDatabase, tenant: str) -> None:
    await employee(db, tenant, uid())  # tenants are discovered through the roster
    async with db.tenant_tx(tenant) as tx:
        for _ in range(3):
            await tx.execute(
                """INSERT INTO employee_role_gaps (tenant_id, employee_id, job_profile_id, role_gap_pct, readiness, gaps,
                     department, location) VALUES (%s, %s, %s, 0.5, 0.5, %s, 'risk', 'AE')""",
                (
                    tenant,
                    uid(),
                    (profile := '0192f0c1-0000-7000-8000-0000000000f1'),
                    json.dumps(
                        [
                            {
                                'skill_id': '0192f0c1-0000-7000-8000-0000000000aa',
                                'weight': 1,
                                'required': 4,
                                'proficiency': 2,
                                'gap': 2,
                            }
                        ]
                    ),
                ),
            )
    out = await gaps.rebuild(db)
    assert out[tenant] == 3  # one cell per dimension
    async with db.tenant_tx(tenant) as tx:
        cells = await tx.fetch(
            'SELECT dimension, group_key, employees, gap_sum::float8 AS g FROM skill_gap_aggregates ORDER BY dimension'
        )
    assert [(c['dimension'], c['group_key'], c['employees'], c['g']) for c in cells] == [
        ('department', 'risk', 3, 6.0),
        ('job_profile', profile, 3, 6.0),
        ('location', 'AE', 3, 6.0),
    ]
