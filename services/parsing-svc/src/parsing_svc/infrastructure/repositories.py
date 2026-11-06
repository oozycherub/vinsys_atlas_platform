"""Postgres repositories (migration 0009)."""

from __future__ import annotations

from typing import Any

from atlas_platform.db import Tx
from psycopg.types.json import Jsonb

from parsing_svc.application.store import Job, SearchHit, StoredChunk

_JOB_COLUMNS = """tenant_id::text, job_id::text, document_id::text, candidate_id::text, storage_key,
  mime_type, byte_size, origin, parser_version, status::text, stage, progress, attempts, error_code,
  flags, batch_id::text, idempotency_key, result, created_at, started_at, finished_at"""


def _job(row: dict[str, Any]) -> Job:
    return Job(**{**row, 'flags': list(row['flags'] or [])})


class PgJobRepository:
    async def insert(self, tx: Tx, job: Job) -> Job:
        rows = await tx.fetch(
            f"""INSERT INTO parse_jobs (tenant_id, job_id, document_id, candidate_id, storage_key, mime_type,
                  byte_size, origin, parser_version, batch_id, idempotency_key)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT DO NOTHING
                RETURNING {_JOB_COLUMNS}""",
            (
                job.tenant_id,
                job.job_id,
                job.document_id,
                job.candidate_id,
                job.storage_key,
                job.mime_type,
                job.byte_size,
                job.origin,
                job.parser_version,
                job.batch_id,
                job.idempotency_key,
            ),
        )
        if rows:
            return _job(rows[0])
        # Conflict: the same Idempotency-Key, or a live job for the document already exists.
        if job.idempotency_key:
            same_key = await tx.fetch(
                f'SELECT {_JOB_COLUMNS} FROM parse_jobs WHERE idempotency_key = %s',
                (job.idempotency_key,),
            )
            if same_key:
                return _job(same_key[0])
        live = await tx.fetch(
            f"""SELECT {_JOB_COLUMNS} FROM parse_jobs
                WHERE document_id = %s AND status IN ('queued', 'running')""",
            (job.document_id,),
        )
        return _job(live[0])

    async def get(self, tx: Tx, job_id: str) -> Job | None:
        rows = await tx.fetch(f'SELECT {_JOB_COLUMNS} FROM parse_jobs WHERE job_id = %s', (job_id,))
        return _job(rows[0]) if rows else None

    async def set_stage(self, tx: Tx, job_id: str, stage: str, progress: int) -> None:
        await tx.execute(
            """UPDATE parse_jobs SET stage = %s, progress = GREATEST(progress, %s), updated_at = now()
               WHERE job_id = %s AND status IN ('queued', 'running')""",
            (stage, progress, job_id),
        )

    async def finish(
        self,
        tx: Tx,
        job_id: str,
        status: str,
        *,
        error_code: str | None = None,
        flags: list[str] | None = None,
        result: dict[str, Any] | None = None,
    ) -> bool:
        count = await tx.execute(
            """UPDATE parse_jobs SET status = %s::parse_job_status, error_code = %s,
                 flags = COALESCE(%s, flags), result = COALESCE(%s, result),
                 progress = CASE WHEN %s = 'succeeded' THEN 100 ELSE progress END,
                 finished_at = now(), updated_at = now()
               WHERE job_id = %s AND status IN ('queued', 'running')""",
            (
                status,
                error_code,
                flags,
                Jsonb(result) if result is not None else None,
                status,
                job_id,
            ),
        )
        return count == 1

    async def claim(self, tx: Tx, limit: int, per_tenant_cap: int) -> list[Job]:
        # One dispatcher at a time; the lock is released at commit.
        await tx.execute("SELECT pg_advisory_xact_lock(hashtext('parsing-svc.dispatch'))")
        rows = await tx.fetch(
            f"""WITH running AS (
                  SELECT tenant_id, count(*) AS n FROM parse_jobs WHERE status = 'running' GROUP BY tenant_id
                ), ranked AS (
                  SELECT j.job_id, j.created_at,
                         row_number() OVER (PARTITION BY j.tenant_id ORDER BY j.created_at, j.job_id) AS rn,
                         COALESCE(r.n, 0) AS busy
                  FROM parse_jobs j LEFT JOIN running r USING (tenant_id)
                  WHERE j.status = 'queued'
                ), picked AS (
                  SELECT job_id, rn, created_at FROM ranked WHERE rn + busy <= %s
                  ORDER BY rn, created_at LIMIT %s
                )
                UPDATE parse_jobs j SET status = 'running', attempts = attempts + 1,
                       started_at = COALESCE(started_at, now()), updated_at = now()
                FROM picked WHERE j.job_id = picked.job_id
                RETURNING {', '.join('j.' + c.strip() for c in _JOB_COLUMNS.replace(chr(10), ' ').split(','))},
                          picked.rn AS rank_round, picked.created_at AS rank_at""",
            (per_tenant_cap, limit),
        )
        # RETURNING has no defined order: restore the round-robin order for the runner.
        rows.sort(key=lambda r: (r.pop('rank_round'), r.pop('rank_at')))
        return [_job(r) for r in rows]

    async def delete_candidate(self, tx: Tx, candidate_id: str) -> int:
        return await tx.execute('DELETE FROM parse_jobs WHERE candidate_id = %s', (candidate_id,))


def _vector(values: list[float]) -> str:
    return '[' + ','.join(f'{v:.7g}' for v in values) + ']'


class PgEmbeddingRepository:
    async def replace(
        self,
        tx: Tx,
        *,
        tenant_id: str,
        candidate_id: str,
        document_id: str,
        model_id: str,
        chunks: list[StoredChunk],
    ) -> int:
        """The candidate's chunks for this model are exactly these afterwards: a newer résumé
        with fewer roles leaves no stale experience chunks behind, and a retry is a no-op."""
        await tx.execute(
            'DELETE FROM resume_embeddings WHERE candidate_id = %s AND model_id = %s',
            (candidate_id, model_id),
        )
        for c in chunks:
            await tx.execute(
                """INSERT INTO resume_embeddings (tenant_id, candidate_id, document_id, chunk_type, chunk_index,
                     content_redacted, token_count, model_id, embedding)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::vector)""",
                (
                    tenant_id,
                    candidate_id,
                    document_id,
                    c.chunk_type,
                    c.chunk_index,
                    c.content,
                    c.token_count,
                    model_id,
                    _vector(c.vector),
                ),
            )
        return len(chunks)

    async def search(
        self,
        tx: Tx,
        *,
        model_id: str,
        vector: list[float],
        k: int,
        chunk_types: list[str] | None,
        candidate_ids: list[str] | None = None,
        per_candidate: int | None = None,
        include_vectors: bool = False,
    ) -> list[SearchHit]:
        """ANN over the tenant's chunks (RLS limits rows to the transaction's tenant; model_id keeps
        one vector space per query). With `per_candidate`, an exact search over the named
        candidates returning each one's closest chunks: what re-ranking needs for SEM."""
        params = {
            'v': _vector(vector),
            'm': model_id,
            'types': chunk_types,
            'cands': candidate_ids,
            'k': k,
            'per': per_candidate,
        }
        vec = ', embedding::text AS embedding' if include_vectors else ''
        if per_candidate:
            rows = await tx.fetch(
                f"""SELECT candidate_id, document_id, chunk_type, chunk_index, score{', embedding' if include_vectors else ''}
                    FROM (
                      SELECT candidate_id::text, document_id::text, chunk_type::text, chunk_index,
                             1 - (embedding <=> %(v)s::vector) AS score{vec},
                             row_number() OVER (PARTITION BY candidate_id ORDER BY embedding <=> %(v)s::vector) AS rn
                      FROM resume_embeddings
                      WHERE model_id = %(m)s AND candidate_id = ANY(%(cands)s::uuid[])
                        AND (%(types)s::text[] IS NULL OR chunk_type::text = ANY(%(types)s))
                    ) ranked
                    WHERE rn <= %(per)s
                    ORDER BY score DESC
                    LIMIT %(k)s""",
                params,
            )
        else:
            await tx.execute('SET LOCAL hnsw.ef_search = 100')
            rows = await tx.fetch(
                f"""SELECT candidate_id::text, document_id::text, chunk_type::text, chunk_index,
                          1 - (embedding <=> %(v)s::vector) AS score{vec}
                   FROM resume_embeddings
                   WHERE model_id = %(m)s
                     AND (%(types)s::text[] IS NULL OR chunk_type::text = ANY(%(types)s))
                     AND (%(cands)s::uuid[] IS NULL OR candidate_id = ANY(%(cands)s::uuid[]))
                   ORDER BY embedding <=> %(v)s::vector
                   LIMIT %(k)s""",
                params,
            )
        return [
            SearchHit(
                candidate_id=r['candidate_id'],
                document_id=r['document_id'],
                chunk_type=r['chunk_type'],
                chunk_index=r['chunk_index'],
                score=round(float(r['score']), 6),
                embedding=[float(x) for x in r['embedding'].strip('[]').split(',')]
                if include_vectors
                else None,
            )
            for r in rows
        ]

    async def chunks_without(
        self, tx: Tx, *, have: str, missing: str, limit: int
    ) -> list[dict[str, Any]]:
        return await tx.fetch(
            """SELECT tenant_id::text, candidate_id::text, document_id::text, chunk_type::text,
                      chunk_index, content_redacted, token_count
               FROM resume_embeddings a
               WHERE a.model_id = %s AND NOT EXISTS (
                 SELECT 1 FROM resume_embeddings b
                 WHERE b.candidate_id = a.candidate_id AND b.model_id = %s
                   AND b.chunk_type = a.chunk_type AND b.chunk_index = a.chunk_index)
               ORDER BY a.embedding_id LIMIT %s""",
            (have, missing, limit),
        )

    async def insert_one(
        self, tx: Tx, *, row: dict[str, Any], model_id: str, vector: list[float]
    ) -> None:
        await tx.execute(
            """INSERT INTO resume_embeddings (tenant_id, candidate_id, document_id, chunk_type, chunk_index,
                 content_redacted, token_count, model_id, embedding)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::vector)
               ON CONFLICT DO NOTHING""",
            (
                row['tenant_id'],
                row['candidate_id'],
                row['document_id'],
                row['chunk_type'],
                row['chunk_index'],
                row['content_redacted'],
                row['token_count'],
                model_id,
                _vector(vector),
            ),
        )

    async def delete_candidate(self, tx: Tx, candidate_id: str) -> int:
        return await tx.execute(
            'DELETE FROM resume_embeddings WHERE candidate_id = %s', (candidate_id,)
        )

    async def count(self, tx: Tx, candidate_id: str) -> int:
        rows = await tx.fetch(
            'SELECT count(*) AS n FROM resume_embeddings WHERE candidate_id = %s', (candidate_id,)
        )
        return int(rows[0]['n'])


class PgModelSlots:
    async def get(self, tx: Tx) -> tuple[str, str | None]:
        rows = {
            r['slot']: r['model_id']
            for r in await tx.fetch('SELECT slot, model_id FROM embedding_model_slots')
        }
        return str(rows['active']), rows.get('shadow')

    async def set(self, tx: Tx, slot: str, model_id: str | None, by: str) -> None:
        await tx.execute(
            'UPDATE embedding_model_slots SET model_id = %s, updated_by = %s, updated_at = now() WHERE slot = %s',
            (model_id, by, slot),
        )


class PgBatchRepository:
    async def create(
        self, tx: Tx, *, tenant_id: str, batch_id: str, by: str, items: list[tuple[str, int]]
    ) -> None:
        await tx.execute(
            """INSERT INTO parse_batches (tenant_id, batch_id, status, total, created_by)
               VALUES (%s, %s, 'accepted', %s, %s)""",
            (tenant_id, batch_id, len(items), by),
        )
        for n, (ext, size) in enumerate(items):
            await tx.execute(
                """INSERT INTO parse_batch_items (tenant_id, batch_id, item_index, extension, byte_size, status)
                   VALUES (%s, %s, %s, %s, %s, 'pending')""",
                (tenant_id, batch_id, n, ext[:10], size),
            )

    async def get(self, tx: Tx, batch_id: str) -> dict[str, Any] | None:
        rows = await tx.fetch('SELECT * FROM parse_batches WHERE batch_id = %s', (batch_id,))
        return rows[0] if rows else None

    async def items(self, tx: Tx, batch_id: str) -> list[dict[str, Any]]:
        return await tx.fetch(
            """SELECT item_index, extension, byte_size, status, candidate_id::text, document_id::text, error_code
               FROM parse_batch_items WHERE batch_id = %s ORDER BY item_index""",
            (batch_id,),
        )

    async def set_status(
        self, tx: Tx, batch_id: str, status: str, error_code: str | None = None
    ) -> None:
        await tx.execute(
            'UPDATE parse_batches SET status = %s, error_code = %s, updated_at = now() WHERE batch_id = %s',
            (status, error_code, batch_id),
        )

    async def update_item(self, tx: Tx, batch_id: str, index: int, **fields: Any) -> None:
        allowed = {'status', 'candidate_id', 'document_id', 'error_code'}
        assignments = [f'{k} = %s' for k in fields if k in allowed]
        values = [v for k, v in fields.items() if k in allowed]
        await tx.execute(
            f"""UPDATE parse_batch_items SET {', '.join(assignments)}, updated_at = now()
                WHERE batch_id = %s AND item_index = %s""",
            (*values, batch_id, index),
        )

    async def is_placeholder(self, tx: Tx, candidate_id: str) -> bool:
        rows = await tx.fetch(
            'SELECT 1 FROM parse_batch_items WHERE candidate_id = %s LIMIT 1', (candidate_id,)
        )
        return bool(rows)

    async def forget_candidate(self, tx: Tx, candidate_id: str) -> int:
        return await tx.execute(
            'UPDATE parse_batch_items SET candidate_id = NULL, document_id = NULL WHERE candidate_id = %s',
            (candidate_id,),
        )
