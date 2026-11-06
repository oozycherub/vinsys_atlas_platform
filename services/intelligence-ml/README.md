# intelligence-ml (brick 12)

The Python half of workforce intelligence: the fulfilment-plan solver (OR-Tools CP-SAT) and the attrition pipeline (LightGBM, SHAP, Dagster). It shares the schema of [`intelligence-svc`](../intelligence-svc) (migration `0017_intelligence.sql`) and works through it: queued plans, feature snapshots, scores and alerts.

Spec: [`docs/prompts/12-intelligence-svc.md`](../../docs/prompts/12-intelligence-svc.md) · Decisions: [ADR-0009](../../docs/adr/0009-workforce-intelligence-split-and-governance.md) · [Model card](docs/model_card.md) · [Evaluation report](docs/evaluation_report.md) (synthetic data)

## Fulfilment plans (`fulfilment.py`, `plans.py`)

The worker claims queued plans with a lease (`FOR UPDATE SKIP LOCKED`, 15 min, at most 3 attempts), solves them outside any transaction, and writes one line per demand slot.

- **Variables:** only employees who are redeployable (readiness ≥ 0.75) or upskillable (readiness ≥ 0.5, and the learning for the gap fits before the start at the tenant's hours per day) are candidates for a slot.
- **Objective:** maximise Σ readiness × tenure factor.
- **Constraints:**
  - at most the headcount per demand;
  - for each employee, existing allocations plus assigned demands ≤ 100% at every start date.
- **Limits:** the solve is time-limited, and the best solution found is kept.
- **Unfilled slots:** each demand with slots left over emits one `intel.demand.recruit_required.v1`; matching-svc turns it into an on-hold requisition.

Readiness is the same formula as intelligence-svc's. Both pass `packages/contracts/fixtures/readiness-golden.json`.

## Attrition (`attrition/`)

| Step         | What                                                                                                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Features     | 13 features from the HR roster and marketplace activity, snapshotted nightly into `attrition_feature_snapshots` (the offline store; `feature_repo/` declares them for Feast) |
| Governance   | Protected attributes are refused as features; features with mutual information > 0.1 bit against an audit attribute are dropped and recorded                                 |
| Model        | LightGBM plus isotonic calibration, time-based split; per tenant at ≥ 2,000 employees and ≥ 150 exits, otherwise pooled (new tenants included)                               |
| Gates        | ECE > 0.1 or four-fifths parity < 0.8 turns alerts off (analytics only); PSI > 0.2 is recorded and logged                                                                    |
| Explanations | SHAP top-3 contributions, as phrases ("No promotion in 34 months")                                                                                                           |
| Rule         | p ≥ threshold (default 0.35) and (Δp over 30 days ≥ 0.10 or first crossing); one alert per 60 days; HRBP plus manager                                                        |
| Event        | `intel.attrition.alert_raised.v1`: drivers and suggested actions (opportunities with readiness ≥ 0.6, learning), never the probability                                       |

Every attrition transaction sets the HRBP RLS context: these tables are invisible without it.

## Running

```bash
uv sync
.venv/bin/python -m intelligence_ml.main           # fulfilment-plan worker (on-demand plans)
dagster dev -m intelligence_ml.dagster_defs         # nightly (02:00) and monthly retrain (1st, 03:00)
.venv/bin/python eval/evaluate.py                   # regenerate docs/model_card.md and docs/evaluation_report.md
```

Environment: `ATLAS_INTELLIGENCE_DATABASE_URL`, `ATLAS_DB_APP_ROLE`, `ATLAS_FULFILMENT_TIME_LIMIT_S` (default 600).

**macOS:** LightGBM needs OpenMP. Without Homebrew's `libomp`, run Python directly (not `uv run`, which drops the variable) with `DYLD_FALLBACK_LIBRARY_PATH=.venv/lib/python3.12/site-packages/sklearn/.dylibs`; `make py-verify` does this. Linux images install `libgomp1`.

## Tests

`make py-verify` runs ruff, `mypy --strict` and pytest against a real Postgres (pgserver): 36 tests at 97% coverage. All 24 seeded mutations are caught.

- **Readiness:** parity with the shared golden file.
- **Fulfilment, golden scenarios:** redeploy, upskill and recruit; learning that does or does not fit; capacity across overlapping and disjoint demands; headcount slots; tenure; time limits.
- **The plan worker:** account and horizon filters; the recruit event and its recorded contract fixture; leases, takeover and retries.
- **Attrition:**
  - feature-list checks (no protected attributes, Feast parity);
  - proxy detection;
  - model quality on synthetic data;
  - SHAP drivers;
  - the ECE and parity gates;
  - the alert rule and its throttle;
  - PSI;
  - the full nightly pipeline on a synthetic roster: back-filled snapshots, pooled training, scoring, alerts, throttling, the HRBP-only visibility, and the alert contract fixture.
- **Dagster:** the definitions load, and both jobs run in-process against the test database.

## Gaps

- **Model quality:** AUC ≥ 0.75 and precision@10% ≥ 0.40 are met on synthetic data only. Real numbers come from each tenant's history (stored with the model).
- **Scale:** the 5k × 50k solve within 10 minutes has not been measured.
- **Feast serving:** not exercised. The definitions are checked against the pipeline's feature list.
