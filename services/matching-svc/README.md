# matching-svc (brick 7)

Job requisitions and hybrid candidate ↔ requisition scoring: two-stage retrieval, the PRD formula, explanations, and incremental re-scoring as profiles, job profiles and weights change.

Spec: [`docs/prompts/07-matching-svc.md`](../../docs/prompts/07-matching-svc.md) · Contract: [`openapi.yaml`](openapi.yaml) · Formula: [`packages/scoring`](../../packages/scoring)

## Design

```
http/controllers.ts      requisitions CRUD, :calibrate, :match, candidate matches
  └─▶ application/       RequisitionService, MatchService, RescoreWorker, MatchingEventHandlers
        └─▶ domain/      score.ts (the shared formula + weights_version + explanations),
                         requisition.ts (calibration snapshot, retrieval text), features.ts
infrastructure/          Postgres repositories, parsing-svc vector search, llm-gateway
                         embeddings, taxonomy, tenant weights, BM25 (Postgres FTS | OpenSearch)
packages/scoring         the formula as pure functions, reused by the marketplace (brick 12)
```

### The formula

`Score = M · (w_sem·SEM + w_cov·COV + w_exp·EXP + w_lex·LEX)`, exactly as PRD §2.1(b). Each component has golden unit tests in `packages/scoring`.

| Component | Definition                                                                                                                 |
| --------- | -------------------------------------------------------------------------------------------------------------------------- |
| SEM       | `clip((cos(ē_c, ē_j) − 0.30) / 0.55, 0, 1)`. ē_c is the normalised mean of the candidate's 3 chunks closest to ē_j.        |
| COV       | `Σ w·min(1, p̂/p_req) / Σ w`, with `p̂ = max(p_c(s), max ρ·p_c(s'))`. ρ comes from taxonomy RELATED_TO edges, capped at 0.8. |
| EXP       | `exp(−max(0, y_req − y_c)² / 8)`: a Gaussian with σ = 2 years. Extra experience is never penalised.                        |
| LEX       | BM25 divided by the best BM25 in the result set.                                                                           |
| M         | A factor of 0.5 for every must-have where p̂ < 0.5·p_req.                                                                   |

Bands: Strong ≥ 0.75, Good ≥ 0.60, Partial ≥ 0.45, otherwise Weak.

**Weights** come from tenant-svc (`GET /v1/tenants/{id}/settings`, scope `tenant-settings:read`).

- They are checked again here: if they don't sum to 1, the response is `422 INVALID_WEIGHTS`.
- Every stored score records `weights_version`, which is a hash of the weights.
- A `tenant.tenant.settings_updated.v1` event that changes `matching` re-ranks every open requisition under the new version.

### Requisitions and calibration

`POST /v1/job-requisitions/{id}:calibrate` snapshots:

- the requirements: from the linked job profile, or a manual `skills` list;
- each skill's name and related skills (ρ ≤ 0.8);
- ē_j: the embedding of the title, description, required-skill names and keywords, made with parsing-svc's **active** embedding model;
- the BM25 query.

It then queues a full ranking, which is how candidates are **rediscovered** for a new requisition. Editing the title, description, job profile, years or keywords marks the calibration `stale`. A `taxonomy.job_profile.updated.v1` event re-calibrates the linked requisitions automatically.

### Matching (`POST /v1/job-requisitions/{id}:match`)

1. **Candidate generation:** HNSW ANN over the top 500 résumé chunks (parsing-svc), unioned with the BM25 top 200. That gives at most 700 candidates.
2. **Re-ranking:**
   - each candidate's 3 closest chunk vectors are fetched in one call;
   - BM25 is computed for the whole pool, since LEX is normalised by the pool's maximum;
   - the candidate's skills and experience come from the local read model.
3. The requisition's stored scores are replaced, and the ranking is cached for 10 minutes per (requisition, calibration version, weights_version). The cache is cleared whenever a candidate is re-scored or the weights change.

**Explanations** list:

- matched skills, partial skills (with the related skill that supplied the credit) and gaps;
- failed must-haves;
- redacted evidence snippets from the parsed résumé;
- the chunk types closest to the job.

### Incremental re-scoring

| Event                                 | What it updates                             | What it queues                                                      |
| ------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------- |
| `profile.resume.parsed.v1`            | Profile text, evidence snippets, experience | The candidate, re-scored against every open, calibrated requisition |
| `profile.candidate.skills_updated.v1` | Fused proficiencies                         | The candidate, re-scored against every open, calibrated requisition |

Handlers only update the read model and queue work in the consumer's transaction. `RescoreWorker` does the HTTP calls outside any transaction, and emits `matching.candidate.rescored.v1` with the new scores.

Failed work is put back and retried up to 5 times, then dropped and logged; the next event about that candidate queues it again.

### Fairness

- Lexical scoring and explanations use only the **redacted** parsed profile, so names never reach them.
- A counterfactual test swaps names and pronouns across 5 pairs of otherwise identical candidates. The mean score change must stay below 0.02, and it does.

### Who may call what

| Endpoint                             | Roles                                                                             |
| ------------------------------------ | --------------------------------------------------------------------------------- |
| Create, patch, calibrate, match      | tenant_admin, recruiter, hiring_manager; super_admin and service with `tenant_id` |
| Read requisitions, candidate matches | the above, plus reviewer                                                          |
| —                                    | candidates and employees: never                                                   |

## Owned data (`0010_matching.sql`)

| Table                    | Holds                                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `job_requisitions`       | Fields, status, calibration status, and the calibration snapshot (jsonb).                                                  |
| `requisition_embeddings` | ē_j per model, with the hash of the text it embeds. A stale vector is never used.                                          |
| `candidate_features`     | The read model: skills, evidence snippets, experience, redacted profile text, and a generated `tsvector` with a GIN index. |
| `match_scores`           | Score, band, components, explanation and weights_version per (requisition, candidate).                                     |
| `match_work`             | The re-scoring queue. One row per subject, so repeated events coalesce.                                                    |

RLS is strict per tenant. The exception is `match_work`, which the worker claims inside system transactions. There are no foreign keys to other services' tables. Erasure (acknowledged as `matching-svc`) and tenant purge delete this service's rows.

## Changes in other services

- **tenant-svc:** a new `GET /v1/tenants/{id}/settings` for services, scope `tenant-settings:read`.
- **parsing-svc:** `POST /v1/resume-embeddings:search` gained `candidate_ids`, `per_candidate` and `include_vectors`, because SEM needs each candidate's actual chunk vectors.
- **`@atlas/contracts`:** `matching.requisition.calibrated.v1` and `matching.candidate.rescored.v1`.

## Configuration

| Variable                                                                                           | Default    | Notes                                                                               |
| -------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------- |
| `ATLAS_DATABASE_URL`, `ATLAS_AUTH_*`                                                               | —          | As in the other services.                                                           |
| `ATLAS_IDENTITY_TOKEN_URL`, `ATLAS_MATCHING_CLIENT_ID`, `…_CLIENT_SECRET`                          | —          | Scopes: `embeddings:create`, `embeddings:search`, `tenant-settings:read`.           |
| `ATLAS_TENANT_SVC_URL`, `ATLAS_TAXONOMY_SVC_URL`, `ATLAS_PARSING_SVC_URL`, `ATLAS_LLM_GATEWAY_URL` | —          | Required.                                                                           |
| `ATLAS_MATCHING_LEXICAL` (`postgres` \| `opensearch`), `ATLAS_OPENSEARCH_URL`                      | `postgres` | OpenSearch uses the index `t-{tenant}-profiles`, fed by the parsed-résumé consumer. |
| `ATLAS_MATCHING_CACHE_TTL_SECONDS`                                                                 | 600        |                                                                                     |
| `ATLAS_MATCHING_EVENT_SOURCE` (`none` \| `kafka`), `ATLAS_KAFKA_BROKERS`                           | `none`     | Production refuses `none`.                                                          |

## Decisions and known gaps

- **BM25 locally.** The local adapter ranks with Postgres `ts_rank_cd`, not true BM25. LEX is normalised by the pool's maximum, so only the ordering matters; production should use OpenSearch.
- **Incremental LEX.** Re-scoring a single candidate normalises its BM25 by the maximum stored from the requisition's last full ranking.
- **Result cache.** It is per process (memory, 10 minutes). With several replicas, each keeps its own; Redis would share it.
- **Work queue.** Claiming deletes the row, so a crash mid-run loses that item until the next event about the subject.
- **Hiring managers** see every requisition in their tenant, not only their own.
- **Not done yet:** the OpenSearch index mapping and bootstrap job, and per-tenant partial HNSW indexes for very large tenants. The ANN latency target (< 50 ms at 10M vectors) has not been load-tested.
