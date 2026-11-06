# intelligence-svc (brick 12)

Workforce intelligence and the internal talent marketplace: a live, skills-based view of the workforce for HR and leaders, and a personalised path for employees.

The CP-SAT fulfilment solver and the attrition pipeline run in [`services/intelligence-ml`](../intelligence-ml) (Python); both share migration `0017_intelligence.sql`.

Spec: [`docs/prompts/12-intelligence-svc.md`](../../docs/prompts/12-intelligence-svc.md) · Decisions: [ADR-0009](../../docs/adr/0009-workforce-intelligence-split-and-governance.md) · PRD Module 5 · API: [`openapi.yaml`](openapi.yaml)

## What it does

- **HR roster.**
  - `PUT /v1/employees/{id}` and `:bulkUpsert` sync department, location, job profile, manager, tenure dates, opt-in and exits from the HRIS. They need `tenant_admin` or scope `hris:sync`.
  - Skills come from `profile.candidate.skills_updated.v1` (fused proficiencies); job profiles come from `taxonomy.job_profile.updated.v1`.
  - Records older than 24 h make their matches `stale`.
- **Gaps and readiness (PRD §2.5(iii)).**
  - `gap = max(0, p_req − p)`; `role_gap% = Σ w·gap / Σ w·p_req`; `readiness = 1 − role_gap%`.
  - Bands: High > 50%, Medium 20–50%, Low < 20%.
  - The formula is pinned by `packages/contracts/fixtures/readiness-golden.json`, which intelligence-ml checks too.
- **Skill-gap heat-map.**
  - `GET /v1/analytics/skill-gaps?group_by=department|job_profile|location&period=6m`.
  - Cells are pre-aggregated: incrementally when an employee changes, nightly by intelligence-ml.
  - Each cell carries its trend against the period's start.
  - Groups under 3 employees are suppressed.
- **Career paths.**
  - `GET /v1/employees/{id}/career-paths`: `TRANSITIONS_TO` edges up to 3 steps, typed vertical, horizontal or diagonal.
  - Each path has readiness, gaps and learning: a greedy cover of the weighted gap per hour over `learning_items`.
- **Marketplace.**
  - **Matching:** `Score_internal = Score · A`.
    - Score is `@atlas/scoring`: unvalidated skills count at 50%, there is no BM25 index, and without embeddings SEM's weight moves to COV.
    - A is the availability factor: allocation ≤ 100%, a 30% cut below the minimum tenure, and opt-in unless it is a project.
    - Roles linked to a requisition use matching-svc's score (`matching.candidate.rescored.v1`).
  - **Ranking:** publishing (`intel.opportunity.published.v1`) ranks employees. Large workforces get a pre-filter first: ANN over profile chunks, plus anyone holding a required skill. The top 200 are kept, and allocation changes re-score only that employee.
  - **Feed and recommendations:** `GET /v1/opportunities?for=me` and `:recommendCandidates`.
  - **Applications and invitations:** accepting books the allocation.
  - **Privacy:** an employee's current manager does not see their applications until the employee discloses them (tenant policy can change this).
- **Allocations.**
  - The database refuses any booking over 100% on any day: a trigger serialised per employee, since an `EXCLUDE` constraint cannot sum.
  - Each change emits `intel.allocation.changed.v1`.
- **Demand and fulfilment.**
  - `POST /v1/demands:upload` takes `.csv` or `.xlsx`; bad rows are reported by row and re-uploads update by `external_ref`.
  - `POST /v1/fulfilment-plans:compute` queues a plan for intelligence-ml.
  - `GET /v1/fulfilment-plans/{id}` returns one line per slot: redeploy, upskill or recruit.
- **Attrition (HRBP only).**
  - `/v1/attrition/*` needs a staff role and the `hrbp` scope; employees are refused even with it.
  - Every call runs under the HRBP RLS policy (`app.hrbp`) and is written to an append-only audit log.
  - Employee-facing routes never touch attrition data.

## Events

| Direction | Topic                                 | Notes                                                    |
| --------- | ------------------------------------- | -------------------------------------------------------- |
| Produced  | `intel.opportunity.published.v1`      |                                                          |
| Produced  | `intel.allocation.changed.v1`         |                                                          |
| Produced  | `privacy.erasure.acknowledged.v1`     | When asked                                               |
| Consumed  | `profile.candidate.skills_updated.v1` | Skills, then gaps and matches re-scored                  |
| Consumed  | `taxonomy.job_profile.updated.v1`     | Requirements (monotonic by version)                      |
| Consumed  | `matching.candidate.rescored.v1`      | Employees' requisition scores                            |
| Consumed  | `privacy.erasure.requested.v1`        | Removes the employee everywhere, attrition data included |
| Consumed  | `tenant.tenant.purged.v1`             |                                                          |

intelligence-ml produces `intel.demand.recruit_required.v1` (matching-svc creates an on-hold requisition) and `intel.attrition.alert_raised.v1`.

## Configuration

`ATLAS_INTELLIGENCE_PORT` (8092), `ATLAS_DATABASE_URL`, `ATLAS_AUTH_*`, `ATLAS_IDENTITY_TOKEN_URL`, `ATLAS_INTELLIGENCE_CLIENT_ID` / `_SECRET` (scopes `embeddings:create`, `embeddings:search`), `ATLAS_TAXONOMY_SVC_URL`, `ATLAS_PARSING_SVC_URL`, `ATLAS_LLM_GATEWAY_URL`, `ATLAS_INTELLIGENCE_EVENT_SOURCE` (`kafka` in production), `ATLAS_KAFKA_BROKERS`.

## Tests

`npx vitest run services/intelligence-svc`: 39 tests (24 unit, 15 integration) against PGlite under RLS. The domain is at 100% line coverage.

- **Unit:**
  - the shared readiness golden file;
  - the availability factor;
  - career paths and learning;
  - CSV parsing and row validation;
  - the marketplace score;
  - lifecycle rules, config and the HTTP clients.
- **Integration:**
  - **Workforce:** HRIS sync and role-scoped views; career-path readiness golden numbers; the heat-map with suppression.
  - **Marketplace:** publish, rank and the feed (ANN plus the skill pre-filter); apply, accept and allocate; the 120% overbooking refused by the database; manager privacy; invitations; requisition-linked roles.
  - **Demand:** CSV and XLSX uploads; plan queueing.
  - **Attrition governance:** 403 for managers without `hrbp` and for employees; the audit trail; empty tables without the HRBP context.
  - **Isolation:** leak tests on opportunities, analytics, demands and attrition.
  - **Data protection:** erasure and purge.
