# Component Prompt 12: intelligence-svc (Workforce Intelligence & Internal Marketplace)

## Status

**Built:** `services/intelligence-svc` (TypeScript) and `services/intelligence-ml` (Python: CP-SAT plans, the attrition pipeline as Dagster jobs, a model card and an evaluation report), plus contracts. The deviations are recorded in ADR-0009:

- intelligence-svc owns an HR roster fed by HRIS sync, since department, tenure and exits are on no event;
- allocations are capped by a trigger serialised per employee (an `EXCLUDE` constraint cannot sum percentages);
- fulfilment objectives use the structured score (no embeddings in batch);
- Feast is declared (`feature_repo/`, optional extra) while the pipeline computes the same features in SQL;
- the migrations are `0017` (0015 was taken) and `0018` (matching-svc's requisition sources).

**Verified on this machine:**

- The allocation constraint refuses a 120% overbooking (database trigger, also straight into the table).
- The fulfilment classification matches the golden scenarios (redeploy, upskill, recruit; capacity; learning time).
- Career-path readiness golden numbers, from one golden file shared by TypeScript and Python.
- Attrition endpoints return 403 for managers without the `hrbp` scope, and for employees always.
- No protected attributes in the feature list (and proxies dropped by MI).
- Alert throttling; the ECE and parity gates.
- Leak tests on opportunities, analytics, demands and attrition.
- matching-svc replays the recorded `intel.demand.recruit_required.v1` fixture and opens one on-hold requisition per demand.
- Seeded mutations: 26 of 26 caught in TypeScript (intelligence-svc, the capacity trigger, matching-svc), 24 of 24 in intelligence-ml.

**Not verified here:**

- feed p95 < 300 ms, a 5k × 50k solve ≤ 10 min, dashboards p95 < 2 s;
- attrition quality on real HR data (the evaluation report is synthetic);
- Feast serving.

**Supporting changes:**

- contracts: `intel.*` events;
- matching-svc: a `recruit_required` consumer;
- the Makefile runs intelligence-ml's tests with OpenMP on macOS.

## 1. Context

- PRD Module 5 (§2.5 a–d) and the feature inventory's Talent Management sections (skill gaps, career paths, mobility, demand fulfilment, analytics).
- Brick 12: TypeScript API plus a Python ML pipeline (Dagster). Depends on taxonomy, profile and matching (`packages/scoring`).

## 2. Scope

**In**

- **Skill-gap analytics:** heat-maps by department, role and location; pre-aggregated nightly and incrementally.
- **Career paths:** `TRANSITIONS_TO` graph, readiness and recommended learning.
- **Opportunities marketplace:** roles, projects and gigs; matching with availability constraints; applications with an optional manager-visibility policy.
- **Projects and allocations.**
- **Demand capture:** Excel upload, then a fulfilment plan solved with OR-Tools CP-SAT and classified _redeploy / upskill / recruit_.
- **Attrition model:** LightGBM features in Feast, SHAP explanations, alert rules, PSI drift monitoring.

**Out:** LMS content (integration only).

## 3. Owned data

Migration `0017_intelligence.sql` (0015 was taken): `job_profile_transitions`, `opportunities`, `opportunity_matches`, `opportunity_applications`, `projects`, `project_allocations` (exclusion constraint: allocation ≤ 100% over overlapping ranges), `demands`, `fulfilment_plans`, `fulfilment_plan_lines`, `skill_gap_aggregates`, `attrition_scores` (HRBP-only RLS policy in addition to the tenant policy), `learning_items`.

## 4. API contract

As in PRD §2.5: analytics, career paths, opportunities, demands, fulfilment plans and attrition alerts. Attrition endpoints require the `hrbp` scope and are audit-logged.

## 5. Events

- **Consumed:** `profile.candidate.skills_updated.v1`, `taxonomy.job_profile.updated.v1`, `matching.candidate.rescored.v1`.
- **Produced:** `intel.opportunity.published.v1`, `intel.allocation.changed.v1`, `intel.demand.recruit_required.v1` (can create a JR in matching-svc), `intel.attrition.alert_raised.v1`.

## 6. Domain rules

- **Readiness and gap formulas:** exactly as in the PRD.
- **`Score_internal = Score · A`**, where A combines the availability, tenure and opt-in factors.
- **Fulfilment classification thresholds:** 0.75 and 0.5.
- **Attrition:**
  - Protected attributes and their proxies (MI > 0.1) are excluded from features.
  - Alert when p ≥ threshold and (Δ30d ≥ 0.10 or first crossing); at most 1 alert per 60 days.
  - Alerts are disabled automatically when ECE > 0.1.
- **Employees never see risk scores.**

## 7. Non-functional

- Marketplace feed p95 < 300 ms.
- Fulfilment solve ≤ 10 min for 5k × 50k (time-limited best solution).
- Dashboards p95 < 2 s.

## 8. Acceptance tests

- **Matching and allocation:**
  - The allocation constraint prevents a 120% overbooking (DB exclusion constraint).
  - The fulfilment classification matches golden scenarios.
  - Career-path readiness golden numbers.
- **Attrition governance:**
  - Attrition endpoints return 403 for managers without the hrbp scope.
  - Feature-list check: no protected attributes.
  - Alert throttling.
- **Isolation:** leak test on opportunities and analytics.

## 9. Deliverables

`services/intelligence-svc/` (TypeScript), `services/intelligence-ml/` (Python: Dagster jobs, model card, evaluation report), contracts.
