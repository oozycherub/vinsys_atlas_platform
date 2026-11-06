# ADR-0009: Workforce intelligence: TypeScript API, Python solver and attrition pipeline, governed attrition data

- Status: Accepted
- Date: 2026-11-06

## Context

PRD Module 5 and Component Prompt 12 put several things in one bounded context:

- skill-gap analytics, career paths and an internal marketplace with allocations;
- demand capture with a fulfilment plan solved by OR-Tools CP-SAT;
- an attrition model (LightGBM, Feast, SHAP, Dagster).

Several details need deciding:

- **Employee data.** Department, location, role, tenure and promotions do not travel on any event; profile-svc holds skills, not HR history.
- **The allocation rule.** "≤ 100% over overlapping ranges" cannot be an exclusion constraint: `EXCLUDE` forbids overlapping pairs, it cannot sum percentages.
- **Where each formula runs.** Readiness is needed by the TypeScript API (career paths, the feed) and by the Python solver.
- **Attrition data access.** It is the most sensitive data the platform holds: employees must never see it, and only HRBPs may.

## Decision

1. **Two deployables, one schema.**
   - `intelligence-svc` (TypeScript) owns the API, the read models and the incremental work.
   - `intelligence-ml` (Python) owns the CP-SAT fulfilment solver and the attrition pipeline, as Dagster jobs.
   - They share migration `0017_intelligence.sql` and coordinate through tables: a fulfilment-plan queue with leases, attrition scores and alerts. The service boundary (ADR-0001) is the bounded context, not the process.
2. **An HR roster owned here.**
   - `intel_employees` is fed by HRIS sync: `PUT /v1/employees/{id}` and `:bulkUpsert`, with role `tenant_admin` or service scope `hris:sync`.
   - It holds department, location, job profile, manager, tenure dates, opt-in, exit dates and reason.
   - Every record carries `source_synced_at`; matches against records older than 24 h are marked stale (PRD §2.5d).
   - Skills come from `profile.candidate.skills_updated.v1` (fused proficiencies) and job profiles from `taxonomy.job_profile.updated.v1`.
   - Protected attributes, when a tenant supplies them for fairness audits, live in a separate table that only the attrition audit reads (HRBP policy).
3. **Allocations: a trigger, serialised per employee.**
   - A `BEFORE INSERT OR UPDATE` trigger takes a transaction advisory lock on (tenant, employee).
   - It then checks the load at every start date inside the new range (the maximum of a step function over half-open date ranges is reached at a start date), and refuses with `check_violation` above 100%.
   - Concurrent inserts for the same employee serialise, so two 60% bookings cannot both pass.
4. **Readiness is defined once and checked twice.**
   - TypeScript (`domain/readiness.ts`) and Python (`fulfilment/readiness.py`) implement PRD §2.5(iii) and both pass the same golden file, `packages/contracts/fixtures/readiness-golden.json`.
   - The marketplace scores with `@atlas/scoring`, with the unvalidated factor 0.5 and the availability factor A.
   - Role opportunities linked to a requisition reuse matching-svc's score from `matching.candidate.rescored.v1`, so hiring and mobility agree.
5. **Fulfilment.**
   - CP-SAT assigns employees to demand slots. It maximises Σ readiness·A·1000 (integer coefficients), subject to one employee per slot and each employee's load (existing allocations plus assigned demands) ≤ 100% at every start date in the horizon.
   - Only pairs with readiness ≥ 0.5 are variables. The time limit is configurable (default 600 s) and the best solution found is kept.
   - Each slot is then classified: **redeploy** (readiness ≥ 0.75), **upskill** (readiness ≥ 0.5 and the learning time for the gap fits before the start date) or **recruit**.
   - Learning time comes from a greedy weighted cover of the gap by `learning_items`.
   - Unfilled slots emit `intel.demand.recruit_required.v1`, one per demand. matching-svc consumes it and creates a draft requisition, idempotently.
   - Plan objectives use the structured part of the score only (no embeddings in batch), a deliberate deviation from "Σ Score".
6. **Attrition governance.**
   - Attrition tables (`attrition_scores`, `attrition_alerts`, `attrition_models`, `intel_employee_protected`) have a second RLS policy, `current_setting('app.hrbp') = 'on'`. The API sets it only for callers holding the `hrbp` scope; the pipeline sets it in its own transactions. Without it a query sees no rows, even with the tenant context.
   - Every attrition read is written to `intel_audit_log`, append-only for the app role.
   - Employee-facing routes never select from attrition tables.
   - **Features:** protected attributes are never features. Candidate features are dropped when their mutual information with any supplied protected attribute exceeds 0.1.
   - **Calibration:** if expected calibration error > 0.1, or the four-fifths parity check fails on the audit attributes, the model is stored with `alerts_enabled = false` and only analytics are shown.
   - **Drift:** PSI > 0.2 on any feature is recorded and logged.
   - **Training data:** the pipeline writes nightly feature snapshots (`attrition_feature_snapshots`, the Feast offline store's equivalent), and training labels are voluntary exits within 6 months of a snapshot. `feature_repo/` defines the same features for Feast (optional `feast` extra).

## Consequences

- HR history arrives only through HRIS sync. Without it the roster is empty: career paths and the feed still work from job profiles and skills, but attrition does not.
- The readiness formula exists in two languages. The shared golden file keeps them equal, at the cost of updating both on a formula change.
- Fulfilment objectives ignore semantic similarity. Demand lines are structured (skills, dates), so the loss is small; the feed and recommendations keep the full score.
- Not verified here: the PRD's performance targets (feed p95 < 300 ms, a 5k × 50k solve ≤ 10 min, dashboards < 2 s) and attrition model quality (AUC ≥ 0.75, precision@10% ≥ 0.40) on real HR data. The tests use synthetic data. The evaluation report states the synthetic numbers as synthetic.
