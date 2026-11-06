# Component Prompt 03: taxonomy-svc (Skill Graph & Normalisation)

## 1. Context

- PRD §2.5(b)(i) (skill graph), §2.1 stage 8 (skill normalisation), §3 (`skills` DDL).
- Brick 3; depends on tenant-svc and identity-svc. matching, profile, assessment and intelligence all depend on stable `skill_id`s from here.

## Status

**Built.** Everything in §2–§8; acceptance tests 1–6 pass. Remaining work (real embeddings once brick 5 exists, nightly re-normalisation, filtered-HNSW tuning) is listed in `services/taxonomy-svc/README.md`.

## 2. Scope

**In**

- Global taxonomy (`tenant_id IS NULL`) and tenant overlays: adopt, alias, hide, add.
- Hierarchy Domain → Sub-domain → Cluster → Skill, stored as `ltree`.
- Lateral edges (`RELATED_TO`, `PREREQUISITE_OF`, `REPLACES`).
- Skill classifications.
- Bulk Excel/CSV import with a dry-run diff.
- Versioned publishing (`taxonomy_version`).
- `POST /v1/skills:normalize`: raw strings to canonical skills with confidence (alias lookup, then ANN).
- Job roles, job families and job profiles: required skills with `weight`, `target_proficiency` and `must_have`.

**Out:** embedding _generation_ infrastructure. Use the llm-gateway embeddings endpoint once brick 5 exists; until then, a deterministic local stub behind `EmbeddingPort`.

## 3. Owned data

Migration `0006_taxonomy.sql`:

- Extensions `ltree`, `vector`.
- `skills` (PRD §3).
- `skill_edges(src, dst, edge_type, weight)` with `CHECK (src <> dst)`; `RELATED_TO` is stored once, with `src < dst`.
- `tenant_skill_overrides`.
- `job_families`, `job_roles`, `job_profiles`, `job_profile_skills`.
- `taxonomy_import_batches`.

## 4. API contract

- `GET /v1/skills?path=&q=&classification=` (cursor pagination); `GET /v1/skills/{id}` (with ancestors and related skills).
- `POST /v1/skills` (tenant node); `PATCH /v1/skills/{id}`; `POST /v1/skills/{id}:deprecate {replaced_by}`.
- `POST /v1/skills:normalize {terms[≤100]}` returns `[{term, skill_id|null, confidence, method: alias|ann|none}]`.
- `POST /v1/taxonomy-imports` (multipart) returns a dry-run diff; `POST /v1/taxonomy-imports/{id}:commit`.
- `GET/POST/PATCH /v1/job-profiles`, `PUT /v1/job-profiles/{id}/skills`.

Roles: reads for any tenant user; writes for tenant_admin. Global taxonomy writes require the `super_admin` curator.

## 5. Events

- **Produced:** `taxonomy.skill.created.v1`, `.deprecated.v1` (with `replaced_by`), `taxonomy.version.published.v1`, `taxonomy.job_profile.updated.v1`.
- **Consumed:** `tenant.tenant.purged.v1` (delete overlays).

## 6. Domain rules

- **Paths** are unique per tenant (global namespace and tenant namespace). A skill's `node_type` must be one level below its parent.
- **No cycles** in `PREREQUISITE_OF`, checked with a recursive CTE before insert.
- **Normalisation:**
  - Alias exact match gives confidence 1.0.
  - ANN cosine ≥ 0.82 accepts the match.
  - Cosine 0.70–0.82 creates an `unmapped_skill_suggestions` row and returns null.
  - Below 0.70, none.
- **Job profile weights** are > 0. `target_proficiency` is 0–5 in steps of 0.5. At least one skill is required to publish.
- **Deprecation** keeps the row and resolves to its successor through `REPLACES`.

## 7. Non-functional

`:normalize` p95 < 20 ms per term (alias hits stay under 5 ms). The HNSW index on `skills.embedding` covers active skill nodes only.

## 8. Acceptance tests

1. Import dry-run shows a correct diff, and commit is atomic.
2. A cycle in prerequisites is rejected.
3. Normalisation: "JS" → JavaScript via alias, "event streaming" → Kafka via ANN, gibberish → none.
4. Tenant overlay: a hidden global skill is invisible to that tenant only.
5. Cross-tenant: tenant B never sees tenant A's custom skills (leak test).
6. Deprecating a skill emits an event; GET of the old ID returns the successor link.

## 9. Deliverables

Per the master layout, plus `EmbeddingPort` with a local deterministic stub and a gateway adapter, and `@atlas/contracts/taxonomy-events.ts`.
