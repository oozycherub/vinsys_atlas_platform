"""The nightly attrition pipeline (PRD §2.5(vi)): extract → features → batch score → write
`attrition_scores` → rules → outbox `intel.attrition.alert_raised.v1`, plus the monthly retrain.
Dagster runs these steps (intelligence_ml.dagster_defs); each is a plain function here.

Every transaction runs with the tenant context *and* the HRBP policy (`app.hrbp = 'on'`):
attrition tables are invisible without it (ADR-0009 §6).
"""

from __future__ import annotations

import json
import logging
import uuid
from collections.abc import AsyncIterator, Mapping, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any

import numpy as np
from atlas_platform.db import Database, Tx
from atlas_platform.events import PgOutbox
from atlas_platform.ids import uuid7

from intelligence_ml.attrition import features as feats
from intelligence_ml.attrition import model as mdl
from intelligence_ml.attrition.rules import DEFAULT_THRESHOLD, decide
from intelligence_ml.readiness import Gap, LearningItem, learning_plan

log = logging.getLogger('intelligence_ml')

ALERT_TOPIC = 'intel.attrition.alert_raised.v1'
HORIZON = timedelta(days=182)  # "voluntary exit within the next 6 months"
POOLED_SALT = 'atlas-attrition-pooled'


def _json(v: Any) -> Any:
    return json.loads(v) if isinstance(v, str) else v


@asynccontextmanager
async def hrbp_tx(db: Database, tenant_id: str) -> AsyncIterator[Tx]:
    async with db.tenant_tx(tenant_id) as tx:
        await tx.execute("SELECT set_config('app.hrbp', 'on', true)")
        yield tx


async def tenants(db: Database) -> list[str]:
    async with db.system_tx() as tx:
        rows = await tx.fetch(
            'SELECT DISTINCT tenant_id::text AS t FROM intel_employees ORDER BY 1'
        )
    return [r['t'] for r in rows]


# --- 1. features ------------------------------------------------------------------------------


async def snapshot(db: Database, tenant_id: str, as_of: date) -> int:
    """Today's features for every active employee (the Feast offline store's equivalent)."""
    six = as_of - HORIZON
    async with hrbp_tx(db, tenant_id) as tx:
        roster = await tx.fetch(
            """SELECT employee_id::text, manager_user_id, department, hired_at, role_started_at,
                      last_promotion_at, manager_changed_at, compa_ratio::float8, engagement_delta::float8,
                      overtime_hours_4w::float8, status, terminated_at, termination_voluntary
               FROM intel_employees"""
        )
        gaps = {
            r['employee_id']: float(r['g'])
            for r in await tx.fetch(
                'SELECT employee_id::text, role_gap_pct::float8 AS g FROM employee_role_gaps'
            )
        }
        old = {
            r['employee_id']: _json(r['features']).get('skill_gap')
            for r in await tx.fetch(
                """SELECT DISTINCT ON (employee_id) employee_id::text, features
                   FROM attrition_feature_snapshots WHERE as_of <= %s ORDER BY employee_id, as_of DESC""",
                (six,),
            )
        }
        activity: dict[str, tuple[int, int]] = {
            r['employee_id']: (int(r['applied']), int(r['rejected']))
            for r in await tx.fetch(
                """SELECT employee_id::text,
                          count(*) FILTER (WHERE kind = 'application') AS applied,
                          count(*) FILTER (WHERE kind = 'application' AND status = 'declined') AS rejected
                   FROM opportunity_applications WHERE created_at > %s AND created_at <= %s
                   GROUP BY employee_id""",
                (six, as_of + timedelta(days=1)),
            )
        }
        by_manager: dict[str | None, list[Mapping[str, Any]]] = {}
        by_department: dict[str | None, list[Mapping[str, Any]]] = {}
        for r in roster:
            by_manager.setdefault(r['manager_user_id'], []).append(r)
            by_department.setdefault(r['department'], []).append(r)
        n = 0
        for e in roster:
            # Employed on that date (back-filled snapshots include people who have left since).
            if (e['hired_at'] and e['hired_at'] > as_of) or (
                e['terminated_at'] is not None and e['terminated_at'] <= as_of
            ):
                continue
            eid = e['employee_id']
            team = (
                [r for r in by_manager.get(e['manager_user_id'], []) if r['employee_id'] != eid]
                if e['manager_user_id']
                else []
            )
            dept = (
                [r for r in by_department.get(e['department'], []) if r['employee_id'] != eid]
                if e['department']
                else []
            )
            applied, rejected = activity.get(eid, (0, 0))
            row = feats.compute(
                as_of,
                e,
                team=team,
                department=dept,
                skill_gap=gaps.get(eid),
                skill_gap_6m_ago=old.get(eid),
                applications_6m=applied,
                rejections_6m=rejected,
            )
            await tx.execute(
                """INSERT INTO attrition_feature_snapshots (tenant_id, employee_id, as_of, features)
                   VALUES (current_tenant_id(), %s, %s, %s)
                   ON CONFLICT (tenant_id, employee_id, as_of) DO UPDATE SET features = EXCLUDED.features""",
                (eid, as_of, json.dumps(row)),
            )
            n += 1
        return n


def matrix(rows: Sequence[Mapping[str, Any]], names: Sequence[str]) -> np.ndarray:
    return np.array(
        [[np.nan if r.get(n) is None else float(r[n]) for n in names] for r in rows], dtype=float
    ).reshape(len(rows), len(names))


# --- 2. training ------------------------------------------------------------------------------


@dataclass
class Dataset:
    tenant_id: str
    rows: list[dict[str, Any]]
    y: np.ndarray
    order: np.ndarray
    audit: dict[str, list[str | None]]
    employees: int = 0  # distinct people in the labelled snapshots
    exits: int = 0  # distinct people who left voluntarily


async def dataset(db: Database, tenant_id: str, as_of: date) -> Dataset:
    """Labelled snapshots: those at least 6 months old, labelled by a voluntary exit within 6
    months. Involuntary exits in the window are censored (dropped), not counted as stays."""
    async with hrbp_tx(db, tenant_id) as tx:
        rows = await tx.fetch(
            """SELECT s.employee_id::text, s.as_of, s.features, e.terminated_at, e.termination_voluntary,
                      p.attributes
               FROM attrition_feature_snapshots s
               JOIN intel_employees e USING (tenant_id, employee_id)
               LEFT JOIN intel_employee_protected p USING (tenant_id, employee_id)
               WHERE s.as_of <= %s ORDER BY s.as_of, s.employee_id""",
            (as_of - HORIZON,),
        )
    feats, ys, order = [], [], []
    people: set[str] = set()
    leavers: set[str] = set()
    audit: dict[str, list[str | None]] = {}
    attrs = sorted({k for r in rows if r['attributes'] for k in _json(r['attributes'])})
    for r in rows:
        t, voluntary = r['terminated_at'], r['termination_voluntary']
        within = t is not None and r['as_of'] < t <= r['as_of'] + HORIZON
        if within and not voluntary:
            continue
        if t is not None and t <= r['as_of']:
            continue
        feats.append(_json(r['features']))
        ys.append(1 if within else 0)
        people.add(r['employee_id'])
        if within:
            leavers.add(r['employee_id'])
        order.append(r['as_of'].toordinal())
        a = _json(r['attributes']) or {}
        for k in attrs:
            audit.setdefault(k, []).append(a.get(k))
    return Dataset(
        tenant_id, feats, np.array(ys, dtype=int), np.array(order), audit, len(people), len(leavers)
    )


async def train(db: Database, as_of: date) -> dict[str, str | None]:
    """Monthly retrain. Tenants with ≥ 2,000 employees and ≥ 150 exits get their own model;
    the others, new tenants included, share a pooled model (features carry no tenant identity).
    Returns the model version per tenant (None when there is not enough data anywhere)."""
    sets = [await dataset(db, t, as_of) for t in await tenants(db)]
    out: dict[str, str | None] = {}
    pooled_sets: list[Dataset] = []
    for d in sets:
        if d.employees >= mdl.MIN_TENANT_EMPLOYEES and d.exits >= mdl.MIN_TENANT_EXITS:
            out[d.tenant_id] = await _fit_and_store(db, [d], 'tenant', as_of, [d.tenant_id])
        else:  # including tenants with no labelled history yet (cold start)
            pooled_sets.append(d)
    if pooled_sets:
        version = await _fit_and_store(
            db, pooled_sets, 'pooled', as_of, [d.tenant_id for d in pooled_sets]
        )
        for d in pooled_sets:
            out[d.tenant_id] = version
    return out


async def _fit_and_store(
    db: Database, sets: Sequence[Dataset], scope: str, as_of: date, tenant_ids: Sequence[str]
) -> str | None:
    rows = [r for d in sets for r in d.rows]
    y = np.concatenate([d.y for d in sets])
    order = np.concatenate([d.order for d in sets])
    # Align audit columns across the sets (a tenant without an attribute contributes None).
    audit: dict[str, list[str | None]] = {}
    names_all = sorted({k for d in sets for k in d.audit})
    for k in names_all:
        col: list[str | None] = []
        for d in sets:
            col.extend(d.audit.get(k, [None] * len(d.rows)))
        audit[k] = col
    X_all = matrix(rows, feats.FEATURE_NAMES)
    keep, excluded = feats.select(
        feats.FEATURE_NAMES, feats.proxy_report(X_all, feats.FEATURE_NAMES, audit)
    )
    X = X_all[:, [feats.FEATURE_NAMES.index(n) for n in keep]]
    trained = mdl.train(X, y, order, keep, audit or None)
    version = f'{scope}-{as_of.isoformat()}-{uuid.uuid5(uuid.NAMESPACE_URL, POOLED_SALT + ",".join(sorted(tenant_ids)) + as_of.isoformat()).hex[:8]}'
    for tenant_id in tenant_ids:
        async with hrbp_tx(db, tenant_id) as tx:
            await tx.execute('UPDATE attrition_models SET active = false WHERE active')
            policy = await tx.fetch(
                'SELECT attrition_threshold::float8 AS t FROM intel_tenant_policies'
            )
            threshold = float(policy[0]['t']) if policy else DEFAULT_THRESHOLD
            if trained is None:
                await tx.execute(
                    """INSERT INTO attrition_models (tenant_id, model_version, scope, trained_at, metrics,
                         features, excluded, alerts_enabled, disabled_reason, threshold, artifact, active)
                       VALUES (current_tenant_id(), %s, %s, now(), %s, %s, %s, false, %s, %s, %s, false)
                       ON CONFLICT (tenant_id, model_version) DO NOTHING""",
                    (
                        version,
                        scope,
                        json.dumps({'rows': len(rows), 'exits': int(y.sum())}),
                        json.dumps(keep),
                        json.dumps(excluded),
                        'insufficient_data',
                        threshold,
                        json.dumps({}),
                    ),
                )
                continue
            await tx.execute(
                """INSERT INTO attrition_models (tenant_id, model_version, scope, trained_at, metrics, features,
                     excluded, alerts_enabled, disabled_reason, threshold, artifact, active)
                   VALUES (current_tenant_id(), %s, %s, now(), %s, %s, %s, %s, %s, %s, %s, true)
                   ON CONFLICT (tenant_id, model_version) DO UPDATE SET active = true""",
                (
                    version,
                    scope,
                    json.dumps(trained.metrics),
                    json.dumps(keep),
                    json.dumps(excluded),
                    trained.alerts_enabled,
                    trained.disabled_reason,
                    threshold,
                    json.dumps(trained.artifact()),
                ),
            )
    if trained is None:
        log.warning('attrition model not trained: too few exits', extra={'scope': scope})
        return None
    log.info(
        'attrition model trained',
        extra={'scope': scope, **{k: trained.metrics[k] for k in ('auc', 'ece')}},
    )
    return version


# --- 3. scoring, drift and alerts ------------------------------------------------------------


async def score(db: Database, tenant_id: str, as_of: date) -> dict[str, int]:
    out = {'scored': 0, 'alerts': 0}
    async with hrbp_tx(db, tenant_id) as tx:
        models = await tx.fetch(
            """SELECT model_version, alerts_enabled, threshold::float8, artifact FROM attrition_models
               WHERE active ORDER BY trained_at DESC LIMIT 1"""
        )
        if not models:
            return out
        m = models[0]
        trained = mdl.load(_json(m['artifact']), alerts_enabled=bool(m['alerts_enabled']))
        snaps = await tx.fetch(
            """SELECT s.employee_id::text, s.features, e.manager_user_id
               FROM attrition_feature_snapshots s JOIN intel_employees e USING (tenant_id, employee_id)
               WHERE s.as_of = %s AND e.status = 'active' ORDER BY s.employee_id""",
            (as_of,),
        )
        if not snaps:
            return out
        X = matrix([_json(s['features']) for s in snaps], trained.features)
        p = trained.predict(X)
        drivers = trained.drivers(X)
        psi = mdl.drift(trained.bins, X, trained.features)
        await tx.execute(
            'UPDATE attrition_models SET psi = %s WHERE model_version = %s',
            (json.dumps(psi), m['model_version']),
        )
        drifting = {f: v for f, v in psi.items() if v > mdl.PSI_ALERT}
        if drifting:
            log.warning('attrition feature drift', extra={'tenant_id': tenant_id, 'psi': drifting})
        history: dict[str, list[tuple[date, float]]] = {}
        for r in await tx.fetch(
            'SELECT employee_id::text, scored_on, probability::float8 AS p FROM attrition_scores WHERE scored_on < %s',
            (as_of,),
        ):
            history.setdefault(r['employee_id'], []).append((r['scored_on'], float(r['p'])))
        last_alert = {
            r['employee_id']: r['d']
            for r in await tx.fetch(
                'SELECT employee_id::text, max(raised_on) AS d FROM attrition_alerts GROUP BY employee_id'
            )
        }
        for i, s in enumerate(snaps):
            eid = s['employee_id']
            prob = round(float(p[i]), 4)
            await tx.execute(
                """INSERT INTO attrition_scores (tenant_id, employee_id, scored_on, probability, model_version, drivers)
                   VALUES (current_tenant_id(), %s, %s, %s, %s, %s)
                   ON CONFLICT (tenant_id, employee_id, scored_on) DO UPDATE
                   SET probability = EXCLUDED.probability, model_version = EXCLUDED.model_version,
                       drivers = EXCLUDED.drivers""",
                (eid, as_of, prob, m['model_version'], json.dumps(drivers[i])),
            )
            out['scored'] += 1
            if not trained.alerts_enabled:
                continue  # analytics only (ECE or parity gate)
            d = decide(
                as_of, prob, history.get(eid, []), last_alert.get(eid), float(m['threshold'])
            )
            if d.alert:
                await _raise(
                    tx,
                    tenant_id,
                    eid,
                    s['manager_user_id'],
                    prob,
                    d.delta_30d,
                    d.first_crossing,
                    drivers[i],
                    m['model_version'],
                    as_of,
                )
                out['alerts'] += 1
    return out


async def _suggestions(tx: Tx, employee_id: str) -> list[dict[str, str]]:
    """Internal opportunities with readiness ≥ 0.6, and learning for the role gap (PRD §2.5(vi))."""
    out = [
        {'kind': 'opportunity', 'id': r['id'], 'title': r['title']}
        for r in await tx.fetch(
            """SELECT o.opportunity_id::text AS id, o.title FROM opportunity_matches m
               JOIN opportunities o USING (tenant_id, opportunity_id)
               WHERE m.employee_id = %s AND o.status = 'open' AND m.readiness >= 0.6 AND m.availability > 0
               ORDER BY m.score_internal DESC LIMIT 3""",
            (employee_id,),
        )
    ]
    gaps = await tx.fetch(
        'SELECT gaps FROM employee_role_gaps WHERE employee_id = %s', (employee_id,)
    )
    if gaps:
        items = [
            LearningItem(r['item_id'], r['title'], tuple(r['skill_ids']), float(r['h']))
            for r in await tx.fetch(
                """SELECT item_id::text, title, skill_ids::text[] AS skill_ids, duration_hours::float8 AS h
                   FROM learning_items WHERE active"""
            )
        ]
        plan = learning_plan(
            [
                Gap(
                    g['skill_id'],
                    float(g['weight']),
                    float(g['required']),
                    float(g['proficiency']),
                    float(g['gap']),
                )
                for g in _json(gaps[0]['gaps'])
            ],
            items,
        )
        out += [{'kind': 'learning', 'id': i.item_id, 'title': i.title} for i in plan.items[:2]]
    return out


async def _raise(
    tx: Tx,
    tenant_id: str,
    employee_id: str,
    manager: str | None,
    prob: float,
    delta: float | None,
    first: bool,
    drivers: list[dict[str, Any]],
    version: str,
    as_of: date,
) -> None:
    alert_id = uuid7()
    actions = await _suggestions(tx, employee_id)
    await tx.execute(
        """INSERT INTO attrition_alerts (tenant_id, alert_id, employee_id, probability, delta_30d, first_crossing,
             drivers, suggested_actions, manager_user_id, model_version, raised_on)
           VALUES (current_tenant_id(), %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
        (
            alert_id,
            employee_id,
            prob,
            delta,
            first,
            json.dumps(drivers),
            json.dumps(actions),
            manager,
            version,
            as_of,
        ),
    )
    await PgOutbox().append(
        tx,
        topic=ALERT_TOPIC,
        tenant_id=tenant_id,
        aggregate_type='employee',
        aggregate_id=employee_id,
        payload={
            'tenant_id': tenant_id,
            'alert_id': alert_id,
            'employee_id': employee_id,
            'manager_user_id': manager,
            'recipients': ['hrbp', 'manager'] if manager else ['hrbp'],
            'drivers': [d['phrase'] for d in drivers][:3],
            'suggested_actions': actions,
            'model_version': version,
            'occurred_at': datetime.combine(as_of, datetime.min.time()).astimezone().isoformat(),
        },
    )


async def nightly(db: Database, as_of: date) -> dict[str, Any]:
    """Snapshot and score every tenant (the Dagster nightly job, in one call)."""
    report: dict[str, Any] = {}
    for t in await tenants(db):
        snapped = await snapshot(db, t, as_of)
        report[t] = {'snapshots': snapped, **await score(db, t, as_of)}
    return report
