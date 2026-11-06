# Component Prompt 07: matching-svc (Hybrid Candidate ↔ Job Scoring)

## 1. Context

- PRD §2.1(b) (semantic matching formula, two-stage retrieval), §4.3 (match API SLA), §4.1 (bias tests).
- Brick 7 (TypeScript). Depends on taxonomy, profile and parsing.

## Status

**Built.** Everything in §2–§8. The acceptance tests pass against the real HTTP stack, event consumer and Postgres (RLS on), and 18 deliberate formula and behaviour mutations were all caught.

The formula lives in `packages/scoring`, which brick 12 reuses. Supporting changes:

- tenant-svc gained a service-readable settings endpoint;
- parsing-svc search gained per-candidate chunk vectors.

Decisions and gaps are in `services/matching-svc/README.md`.

## 2. Scope

**In**

- `Score(c, j) = M · (w_sem·SEM + w_cov·COV + w_exp·EXP + w_lex·LEX)`, with weights from tenant settings and recorded as `weights_version`.
- Retrieval: HNSW top-500 unioned with OpenSearch BM25 top-200, then re-ranking.
- Explanations: matched skills, gaps, evidence snippets.
- Incremental re-scoring on profile and requisition changes.
- Job requisitions (JR): title, openings, location, hiring manager, linked job profile, calibration state.
- Candidate rediscovery for new JRs.

**Out:** the internal marketplace (brick 12 reuses this library).

## 3. Owned data

Migration `0010_matching.sql`: `job_requisitions`, `requisition_embeddings`, `match_scores` (tenant, jr, candidate, score, band, components jsonb, weights_version, computed_at).

The OpenSearch index `t-{tenant}-profiles` is fed by a CDC consumer.

## 4. API contract

- `POST /v1/job-requisitions`; `POST /v1/job-requisitions/{id}:calibrate`.
- `POST /v1/job-requisitions/{id}:match {limit, filters}` returns ranked candidates with `{score, band, components, explanation}`.
- `GET /v1/candidates/{id}/matches`.

## 5. Events

- **Consumed:** `profile.resume.parsed.v1`, `profile.candidate.skills_updated.v1`, `taxonomy.job_profile.updated.v1`.
- **Produced:** `matching.requisition.calibrated.v1`, `matching.candidate.rescored.v1`.

**Erasure:** consume `privacy.erasure.requested.v1`, delete the candidate's scores and reply with `privacy.erasure.acknowledged.v1` (`service: "matching-svc"`).

## 6. Domain rules

Implement the formula _exactly_ as in the PRD:

- SEM rescaled with bounds (0.30, 0.85).
- COV credits related skills with ρ ≤ 0.8.
- EXP is a Gaussian with σ = 2 years.
- The must-have soft gate is 0.5.
- Bands: Strong ≥ 0.75, Good ≥ 0.60, Partial ≥ 0.45, otherwise Weak.

The scoring function is pure and lives in `src/domain/score.ts`. It is shared as a package for brick 12.

## 7. Non-functional

Match API p95 < 400 ms. ANN query < 50 ms at ≤ 10M vectors per index. Results cached 10 min per (jr, weights_version).

## 8. Acceptance tests

- Golden unit tests for every formula component.
- **Counterfactual fairness test:** swapping names and pronouns changes scores by less than 0.02 on average.
- Must-have gate behaviour.
- Weights not summing to 1 are rejected (enforced upstream by tenant-svc, asserted here).
- Leak test: a JR in tenant A never surfaces tenant B candidates.

## 9. Deliverables

Per master layout, plus `packages/scoring` (pure functions) and contracts.
