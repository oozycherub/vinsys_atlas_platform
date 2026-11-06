# taxonomy-svc (brick 3)

The skill graph every other service refers to: a global taxonomy curated by the platform, tenant overlays and custom skills, skill normalisation, and job profiles with required skills.

Spec: [`docs/prompts/03-taxonomy-svc.md`](../../docs/prompts/03-taxonomy-svc.md) · Contract: [`openapi.yaml`](openapi.yaml)

## Design

```
http/            SkillsController, TaxonomyController, JobsController + zod DTOs
  └─▶ application/  SkillService, NormalizeService, ImportService, JobService, TenantEventHandlers
        └─▶ domain/   terms, paths, skill lifecycle, normalisation thresholds, import planning, job profiles
infrastructure/  Pg repositories (SQL-first, ltree + pgvector), embeddings (stub + gateway), CSV/XLSX parser
```

**Scopes.** Global rows have `tenant_id IS NULL`. A tenant sees global skills plus its own, minus the ones it hid. Row-level security enforces this, and every query also filters on the viewing tenant explicitly. That second filter matters because the curator works in a system transaction, which RLS would otherwise let read every tenant's rows.

| Who                       | Reads                    | Writes                                          |
| ------------------------- | ------------------------ | ----------------------------------------------- |
| Tenant users              | their tenant's view      | –                                               |
| `tenant_admin`            | their tenant's view      | own nodes, overrides, edges, imports, jobs      |
| `super_admin` (curator)   | global, or `?tenant_id=` | global taxonomy, or a tenant with `?tenant_id=` |
| `service` (platform-wide) | global, or `?tenant_id=` | –                                               |

**Hierarchy.** Domain → Sub-domain → Cluster → Skill as an `ltree` path whose depth is fixed by node type. A node's parent must exist, be active and sit one level up. Global nodes cannot sit under tenant nodes. Paths are immutable: to move a skill, create the new one and deprecate the old one with `replaced_by`.

**Overlays** (`PUT /v1/skills/{id}/override`) apply to global skills only: `hidden` (invisible to that tenant in lists, reads, normalisation and job profiles), `adopted`, `display_name` and extra `aliases`. Tenants cannot edit global skills directly (403 `GLOBAL_SKILL_READ_ONLY`).

**Edges.** `RELATED_TO` is symmetric and stored once (`src < dst`). `PREREQUISITE_OF` is refused if it would close a cycle in the edges the scope can see; the check takes a transaction-scoped advisory lock so concurrent inserts cannot race. `REPLACES` is created only by deprecation.

**Normalisation** (`POST /v1/skills:normalize`, ≤ 100 terms):

1. Terms are keyed (NFKC, lower-case, punctuation removed except `+ # .` inside tokens, so C++, C# and .NET survive) and looked up against names, aliases and tenant override aliases. A hit has confidence 1.0. Tenant skills win over global ones, and an alias shared by two skills is treated as ambiguous (no match).
2. The rest are embedded in one batch and matched by HNSW cosine over active, non-hidden leaf skills embedded with the same model. Cosine ≥ 0.82 is accepted. Between 0.70 and 0.82 the term is queued in `unmapped_skill_suggestions` and null is returned. Below 0.70 there is no match.
3. Deprecated matches resolve to their successor.

**Versions.** Every change stamps `taxonomy_version = published + 1` for its scope. `POST /v1/taxonomy:publish` makes that the published version and emits `taxonomy.version.published.v1`, which downstream re-normalisation keys off.

**Imports.** Upload a CSV or XLSX file and get a stored dry-run diff (create, update, unchanged or error per row, parents first; imports never delete). Commit is all-or-nothing. It is refused if the diff has errors (422), or if the taxonomy changed since the dry run (409 `IMPORT_STALE`, detected by a fingerprint), so what was reviewed is exactly what is applied. Embeddings are computed before the commit transaction opens.

**Job profiles.** Families → roles → profiles. Required skills must be active, visible leaf skills; weights are in (0, 1], targets 0–5 in steps of 0.5. Publishing needs at least one skill. Published and archived profiles emit `taxonomy.job_profile.updated.v1` with the full skill list.

## Owned data (`0006_taxonomy.sql`)

| Table                                                             | Scope  | Notes                                                                       |
| ----------------------------------------------------------------- | ------ | --------------------------------------------------------------------------- |
| `skills`                                                          | mixed  | ltree path (GiST), search keys (GIN), trigram name index, HNSW on embedding |
| `skill_edges`                                                     | mixed  | `RELATED_TO` stored once; FK cascade on skill delete                        |
| `tenant_skill_overrides`                                          | tenant | hide / adopt / rename / aliases on global skills                            |
| `unmapped_skill_suggestions`                                      | tenant | weak matches for admins (`GET /v1/skill-suggestions`)                       |
| `taxonomy_versions`                                               | mixed  | published version per scope                                                 |
| `taxonomy_import_batches`                                         | mixed  | stored dry runs (24 h) and committed imports                                |
| `job_families`, `job_roles`, `job_profiles`, `job_profile_skills` | tenant | composite tenant foreign keys                                               |

There are no foreign keys to `tenants` (owned by tenant-svc); purge arrives as an event.

## Events

- **Produced:** `taxonomy.skill.created.v1`, `taxonomy.skill.deprecated.v1` (`replaced_by`), `taxonomy.version.published.v1`, `taxonomy.job_profile.updated.v1` (`packages/contracts/src/taxonomy-events.ts`). Global changes have `tenant_id: null`.
- **Consumed** (`taxonomy-svc.tenant-lifecycle`): `tenant.tenant.purged.v1`, which deletes every row the tenant owns and never a global one.

## Configuration

| Variable                                                                                                        | Required        | Default | Notes                                             |
| --------------------------------------------------------------------------------------------------------------- | --------------- | ------- | ------------------------------------------------- |
| `ATLAS_DATABASE_URL`, `ATLAS_AUTH_ISSUER`, `ATLAS_AUTH_AUDIENCE`                                                | yes             |         |                                                   |
| `ATLAS_AUTH_JWKS_URL`                                                                                           | prod            |         | identity-svc `/.well-known/jwks.json`             |
| `ATLAS_TAXONOMY_EMBEDDINGS`                                                                                     | gateway in prod | `stub`  | `stub` is lexical only; refused in production     |
| `ATLAS_LLM_GATEWAY_URL`, `ATLAS_IDENTITY_TOKEN_URL`, `ATLAS_TAXONOMY_CLIENT_ID`, `ATLAS_TAXONOMY_CLIENT_SECRET` | gateway mode    |         | Client credentials with scope `embeddings:create` |
| `ATLAS_TAXONOMY_EVENT_SOURCE`, `ATLAS_KAFKA_BROKERS`                                                            | kafka in prod   | `none`  | Poison events go to `dlq.taxonomy-svc`            |
| `ATLAS_AUTH_SHARED_SECRET`                                                                                      | dev only        |         | Refused in production                             |
| `ATLAS_TAXONOMY_PORT`                                                                                           | no              | `8083`  |                                                   |

## Run and test

```bash
npm test                               # PGlite with ltree, pg_trgm and pgvector; no Docker needed
make infra-up && make migrate
npm run build && node services/taxonomy-svc/dist/main.js
```

## Known gaps

- **Semantic matching needs llm-gateway (brick 5).** The development stub is a hashed bag of words and trigrams: "JS" and "JavaScript" match through aliases, but "event streaming" and "Kafka" only match with real bge-m3. Acceptance test 3's ANN case uses fixture vectors at exact cosines, which tests the pipeline and thresholds, not semantics.
- **llm-gateway does not exist yet.** The embeddings contract the client calls is in `docs/prompts/05-llm-gateway.md`.
- **Filtered HNSW.** pgvector filters after the index scan. If many nearby skills are hidden for a tenant, the nearest visible one can be missed; pgvector ≥ 0.8 `hnsw.iterative_scan` fixes this and should be enabled on the production cluster.
- **Cross-scope cycles.** A global prerequisite edge is checked against global edges only, because the curator cannot see tenant edges. A tenant edge is checked against both.
- **Path clash.** If the curator later creates a global node at a path a tenant already uses, that tenant sees both.
- **Not done yet:** `RELATED_TO` weight learning (offline, brick 12), the nightly re-normalisation job, and a cleanup job for expired import dry runs.
- **Not measured:** the `:normalize` p95 target (< 20 ms per term). Nothing has run against real Postgres yet.
