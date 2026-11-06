# sandbox-svc (brick 9)

Multi-language code execution judge: runs, submissions, verdicts, fair queueing and plagiarism fingerprints. This is the first Go brick.

Spec: [`docs/prompts/09-sandbox-svc.md`](../../docs/prompts/09-sandbox-svc.md) · Contract: [`openapi.yaml`](openapi.yaml) · Design decisions: [ADR-0006](../../docs/adr/0006-sandbox-judge-queue-and-boundary.md) · Images: [`infra/sandbox-images`](../../infra/sandbox-images) · Cluster: [`infra/k8s/sandbox`](../../infra/k8s/sandbox) · Runtime detection: [`infra/falco`](../../infra/falco/sandbox-rules.yaml)

## Design

```
cmd/sandbox-api      HTTP API, event consumer, queue maintenance (lease reaper, 24 h run purge)
cmd/judge-worker     claims jobs fairly, judges them in isolate boxes (one Deployment per language)
internal/domain      verdicts and severity, limits and hard caps, checkers, isolate meta parsing,
                     smooth weighted round robin, winnowing fingerprints (standard library only)
internal/app         API use cases, Judge (compile once, fresh box per case), Worker, Maintenance,
                     event handlers; ports for the store, boxes and object storage
internal/adapters    postgres (pgx, RLS), isolate (box pool), blob (S3/MinIO + node cache),
                     httpapi (net/http, JWT/JWKS, RFC 9457), kafka (franz-go, Debezium records)
```

### The path of a submission

1. assessment-svc checks the candidate's session and calls `POST /v1/sessions/{id}/questions/{qid}/submissions` with a service token and an `Idempotency-Key`. Candidates never call this service directly (ADR-0006).
2. The `coding_submissions` row is the job (`status = queued`, lane `submit`). The same key returns the same row.
3. A worker of that language picks a lane, then a tenant, by smooth weighted round robin. Lane weights are interactive 6, submit 3, bulk 1. The worker claims the tenant's oldest job with `FOR UPDATE SKIP LOCKED`, under a 60 s lease that heartbeats every 10 s.
4. The worker loads the test cases from object storage, verified against the checksum recorded in Postgres and cached on the node.
5. It compiles once (10 s CPU, 512 MB), then runs each case in a fresh box: `--cleanup`/`--init`, with the compiled files restored. The program sees `input.txt` only. Expected outputs are compared in the worker after the process exits, so they never enter the box.
6. Results, the verdict, the weighted score and `sandbox.submission.judged.v1` are written in one transaction, only if the worker still holds the lease.
7. Plagiarism: fingerprints are compared with other sessions' submissions to the same assessment question. Above 0.8, both sessions get `proctoring.violation.raised.v1` (`rule: code_similarity`, `action: review`).

### Verdicts and limits

- **Severity:** CE > RE > TLE > MLE > OLE > WA > AC. A sandbox fault (`internal_error`) outranks everything, is retried and is never scored.
- **Score:** Σ weight(passed) / Σ weights, which is `score_ratio` in the event.
- **Detail codes:** `RESOURCE_PROCESSES` (fork bomb: the cgroup's `pids.events`, or EAGAIN from a crashed runtime), `CPU_TIME`, `WALL_TIME`, `SIGNAL_n`, `EXIT_n`.

| Limit     | Default        | Hard cap | Notes                                                             |
| --------- | -------------- | -------- | ----------------------------------------------------------------- |
| CPU time  | 2 s × language | 15 s     | Python ×3, Java ×2, Node ×2.5, Go ×1.2                            |
| Wall time | 2 × CPU + 1 s  | 30 s     | Catches sleeps and blocking I/O                                   |
| Memory    | 256 MB × lang. | 1 GB     | cgroup OOM gives MLE; `${MEM}` (heap flags) gets the base value   |
| Processes | 32             | 64       |                                                                   |
| Output    | 1 MB           | 8 MB     | stdout + stderr; stored excerpts ≤ 4 KB per case, ≤ 64 KB per run |

Authors may override within the caps; out-of-range values are rejected (`INVALID_LIMITS`), never silently clipped.

### Checkers

`trim_ws` is the default (it ignores trailing whitespace and blank lines at the end). The others are `exact`, `float_tol` (relative tolerance, default 1e-6), `unordered_lines` and `custom`. A custom checker is an author program in its own box: it reads `input.txt`, `expected.txt` and `output.txt` and exits 0 for pass, 1 for fail. Anything else is the author's fault and becomes an `internal_error`, never a WA.

### Test-case bundles and the flaky-test guard

`PUT /v1/test-case-bundles/{qid}/versions/{v}` (assessment-svc, when a coding question is saved and again at publish):

- stores the cases at `t/{tenant}/sandbox/bundles/{qid}/{v}/{sha256}.json`;
- queues the reference solution, which runs **5 times** against every case;
- the bundle is `verified` only if every run accepts every case with identical results. Otherwise it is `flaky` (results differ) or `reference_failed` (WA, TLE or CE, with the case).

Re-registering the same content is a no-op. A verified bundle is immutable (`409 BUNDLE_IMMUTABLE`). assessment-svc publishes an assessment only when all of its coding bundles are verified.

### Runs

Runs execute the sample (non-hidden) tests, or custom `stdin` with nothing compared. They are throttled to 1 per 3 s per session (`429 RUN_THROTTLED` with Retry-After), long-polled with `GET /v1/runs/{id}?wait=…` (up to 10 s), and deleted after 24 h. Runs never emit events.

### Reliability

- **Lost workers:** the reaper re-queues expired leases. After the 3rd attempt the job ends as `internal_error`, which is announced (so assessment-svc sends the answer to a reviewer), logged as an on-call alert and never charged.
- **Sandbox faults:** box errors, isolate `XX`, a missing meta file or a tampered bundle release the job for a retry, with the same cap.
- **Stale results:** a worker whose lease was taken over cannot write its result (compare-and-set on `worker_id` and the lease).
- **Immutability:** judged submissions cannot change, enforced by a trigger.

## Security layers (PRD §2.2d)

1. **gVisor** (`runtimeClassName: gvisor`) on the tainted `sandbox` node pool. Nothing else runs there, and service-account tokens are not mounted.
2. **isolate** boxes:
   - cgroups v2 for memory and pids;
   - an empty network namespace;
   - a private mount namespace with read-only `/usr` and `/etc`, and `/box` on tmpfs;
   - rlimits for file size and processes;
   - an environment allow-list, so nothing from the worker reaches the box.
3. **NetworkPolicy:**
   - default deny;
   - workers may reach only PgBouncer and the S3 endpoint;
   - only assessment-svc's namespace may call the API.
4. **Falco** rules for outbound connections, shells outside boxes, privileged syscalls, reads of secrets or isolate state, and writes to the image.

Workers serve a language only when its registry digest equals their own image digest.

## Owned data (`0012_sandbox.sql`)

- `sandbox_languages`: global registry, read-only for the app;
- `test_case_bundles`, `coding_submissions` (also the job queue), `coding_test_results`, `code_fingerprints`: tenant RLS. Workers claim, lease and reap in system transactions and do each job's work in the tenant's transaction;
- `sandbox_language_demand`: languages to keep warm.

KEDA connects as `atlas_metrics` and can only call `sandbox_queue_depth(lang)` and `sandbox_language_warm(lang)`.

## Events

- **Produced:**
  - `sandbox.submission.judged.v1` (with `score_ratio` and `submitted_at`);
  - `proctoring.violation.raised.v1` (`code_similarity`);
  - `privacy.erasure.acknowledged.v1`.
- **Consumed** (`sandbox-svc.events`):
  - `assessment.assessment.published.v1`: its `coding_languages` keep one worker per language warm for 7 days;
  - `privacy.erasure.requested.v1`: deletes the candidate's code and results, and acknowledges when `sandbox-svc` is in `ack_required_from` (add it to profile-svc's `ATLAS_PROFILE_ERASURE_CONSUMERS`);
  - `tenant.tenant.purged.v1`: deletes rows, then the stored bundles.

## Configuration

| Variable                                                                                  | Purpose                                                            |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `ATLAS_SANDBOX_PORT`                                                                      | 8089 (API)                                                         |
| `ATLAS_DATABASE_URL`                                                                      | Postgres as `atlas_app`                                            |
| `ATLAS_AUTH_ISSUER`, `ATLAS_AUTH_AUDIENCE`, `ATLAS_AUTH_JWKS_URL`                         | JWT verification (HS256 shared secret outside production only)     |
| `ATLAS_S3_ENDPOINT`, `ATLAS_S3_ACCESS_KEY`, `ATLAS_S3_SECRET_KEY`, `ATLAS_SANDBOX_BUCKET` | Test-case bundles (memory store when unset; refused in production) |
| `ATLAS_SANDBOX_EVENT_SOURCE`, `ATLAS_KAFKA_BROKERS`                                       | `kafka` in production                                              |
| `ATLAS_JUDGE_LANGUAGES`, `ATLAS_JUDGE_IMAGE_DIGEST`                                       | Worker: languages served and this image's digest                   |
| `ATLAS_JUDGE_BOX_POOL`, `ATLAS_JUDGE_BOX_FIRST_ID`                                        | Worker: warm boxes per pod (2 per concurrent job)                  |
| `ATLAS_JUDGE_EXTRA_DIRS`                                                                  | Worker: read-only box mounts (`/etc:noexec`; Java adds `/opt`)     |
| `ATLAS_JUDGE_ISOLATE_BIN`, `ATLAS_JUDGE_CGROUP_ROOT`, `ATLAS_JUDGE_CACHE_DIR`             | Worker: isolate installation and node cache                        |

## Development

Go 1.23 (`GOTOOLCHAIN=local`).

```bash
make go-verify
```

`make go-verify` runs gofmt, vet, golangci-lint and tests with coverage. The tests need a Postgres 16 (`ATLAS_TEST_PG_URL`, default `postgres://atlas_owner@127.0.0.1:5544/postgres`). Each test package gets a fresh database with migrations 0001 and 0012, and connects as `atlas_app`, so RLS applies.

- **Unit and acceptance tests** (`internal/...`, `test/`): the real HTTP stack, Postgres, worker loop and reaper, with a scripted fake box. They cover verification and flaky references, weights and hidden-test masking, every verdict, runs and throttling, crashed and stale workers, sandbox faults, custom checkers, expected outputs never entering the box, tampered bundles, plagiarism, events, auth and fair queueing (a 2,000-job tenant vs ten 1-job tenants: p95 wait 15 ms against the 2 s target). 20 deliberate mutations are all caught.
- **Attack corpus** (`test/attacks`, Linux with Docker, `test/attacks/run.sh`): fork bombs, infinite loops, `sleep(999)`, 2 GB allocations, network and DNS, `/proc/1/environ` (with a canary in the worker's environment), host paths, `kill -1`, 50 MB of stdout, a C++ template bomb, and golden AC/WA programs in Python, Java, C++, C, Node.js and Go. These run through the real judge and isolate in each language's image.

## Decisions and gaps

- **Queue:** the queue is Postgres, not Redis Streams or Kafka (ADR-0006). Claims use partial indexes on `status = 'queued'`.
- **Drafts:** the draft endpoint of PRD §2.2 is not here; assessment-svc's autosave (with `client_rev`) already holds drafts.
- **Disk:** per-box disk is bounded by the tmpfs size of the pod's box root and by `--fsize` per file, not by a per-box quota.
- **SQL:** SQL (language 82) is registered but disabled. It needs a throw-away Postgres inside the box.
- **Bulk re-judging:** the bulk lane exists, but there is no bulk re-judge endpoint yet.
- **Not verified on this machine (macOS, no Docker):**
  - the attack corpus;
  - the image builds;
  - the Helm chart rendering.

  Run `test/attacks/run.sh` and `helm template infra/k8s/sandbox` on Linux. gVisor itself is exercised only in the cluster.
