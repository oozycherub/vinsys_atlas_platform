"""Vector search for other services, the embedding-model upgrade (shadow → swap), and the
data-protection consumers (erasure, tenant purge)."""

from __future__ import annotations

import logging
from typing import Any

from atlas_platform.db import Database, Tx
from atlas_platform.errors import AppError

from parsing_svc.application.ports import Clock, Embedder
from parsing_svc.application.store import (
    BatchRepository,
    EmbeddingRepository,
    JobRepository,
    ModelSlots,
    Outbox,
    SearchHit,
)

log = logging.getLogger('parsing_svc')

SERVICE = 'parsing-svc'
DIMENSIONS = 1024


class EmbeddingIndex:
    def __init__(
        self, db: Database, embeddings: EmbeddingRepository, slots: ModelSlots, embedder: Embedder
    ) -> None:
        self.db = db
        self.embeddings = embeddings
        self.slots = slots
        self.embedder = embedder

    async def models(self) -> dict[str, str | None]:
        async with self.db.system_tx() as tx:
            active, shadow = await self.slots.get(tx)
        return {'active': active, 'shadow': shadow}

    async def search(
        self,
        tenant_id: str,
        vector: list[float],
        model_id: str,
        k: int,
        chunk_types: list[str] | None,
        candidate_ids: list[str] | None = None,
        per_candidate: int | None = None,
        include_vectors: bool = False,
    ) -> list[SearchHit]:
        """ANN over the tenant's chunks. The caller names the model its query vector came from;
        it must be the active one, because vectors from two models are not comparable."""
        if per_candidate and not candidate_ids:
            raise AppError(
                'validation', 'CANDIDATES_REQUIRED', 'per_candidate needs candidate_ids.'
            )
        if len(vector) != DIMENSIONS:
            raise AppError(
                'validation', 'INVALID_VECTOR', f'The vector must have {DIMENSIONS} dimensions.'
            )
        active = (await self.models())['active']
        if model_id != active:
            raise AppError(
                'conflict',
                'EMBEDDING_MODEL_MISMATCH',
                f'Queries must use the active model {active}.',
                active_model=active,
            )
        async with self.db.tenant_tx(tenant_id) as tx:
            return await self.embeddings.search(
                tx,
                model_id=model_id,
                vector=vector,
                k=k,
                chunk_types=chunk_types,
                candidate_ids=candidate_ids,
                per_candidate=per_candidate,
                include_vectors=include_vectors,
            )

    async def set_shadow(self, model_id: str | None, by: str) -> dict[str, str | None]:
        async with self.db.system_tx() as tx:
            active, _ = await self.slots.get(tx)
            if model_id == active:
                raise AppError('rule', 'SHADOW_IS_ACTIVE', 'That model is already active.')
            await self.slots.set(tx, 'shadow', model_id, by)
        return await self.models()

    async def backfill(self, tenant_id: str, limit: int = 200) -> dict[str, Any]:
        """Embeds one tenant's existing chunks with the shadow model (from the stored redacted
        text; no re-parse). Call until `remaining` is 0, then promote."""
        models = await self.models()
        shadow, active = models['shadow'], models['active']
        if not shadow or not active:
            raise AppError('rule', 'NO_SHADOW_MODEL', 'Set a shadow model first.')
        async with self.db.tenant_tx(tenant_id) as tx:
            rows = await self.embeddings.chunks_without(
                tx, have=active, missing=shadow, limit=limit
            )
        if rows:
            vectors = await self.embedder.embed(
                tenant_id, [r['content_redacted'] for r in rows], shadow
            )
            async with self.db.tenant_tx(tenant_id) as tx:
                for row, vector in zip(rows, vectors, strict=True):
                    await self.embeddings.insert_one(tx, row=row, model_id=shadow, vector=vector)
        async with self.db.tenant_tx(tenant_id) as tx:
            remaining = len(
                await self.embeddings.chunks_without(tx, have=active, missing=shadow, limit=1)
            )
        return {
            'tenant_id': tenant_id,
            'model_id': shadow,
            'embedded': len(rows),
            'remaining': remaining,
        }

    async def promote(self, by: str) -> dict[str, str | None]:
        """Blue/green swap: the shadow becomes active in one statement-level transaction. Rows of
        the old model stay until a cleanup, so a rollback is another promote."""
        async with self.db.system_tx() as tx:
            active, shadow = await self.slots.get(tx)
            if not shadow:
                raise AppError('rule', 'NO_SHADOW_MODEL', 'There is no shadow model to promote.')
            await self.slots.set(tx, 'active', shadow, by)
            await self.slots.set(tx, 'shadow', active, by)
        log.warning(
            'embedding model promoted', extra={'active': shadow, 'previous': active, 'by': by}
        )
        return await self.models()


class DataProtection:
    def __init__(
        self,
        db: Database,
        jobs: JobRepository,
        embeddings: EmbeddingRepository,
        batches: BatchRepository,
        outbox: Outbox,
        clock: Clock,
    ) -> None:
        self.db = db
        self.jobs = jobs
        self.embeddings = embeddings
        self.batches = batches
        self.outbox = outbox
        self.clock = clock

    async def erase(self, tx: Tx, payload: dict[str, Any]) -> dict[str, int]:
        """`privacy.erasure.requested.v1`: everything held about the candidate goes, in the
        consumer's transaction; the acknowledgement is written in the same transaction."""
        candidate_id = str(payload['candidate_id'])
        counts = {
            'embeddings': await self.embeddings.delete_candidate(tx, candidate_id),
            'jobs': await self.jobs.delete_candidate(tx, candidate_id),
            'batch_items': await self.batches.forget_candidate(tx, candidate_id),
        }
        if SERVICE in payload.get('ack_required_from', []):
            await self.outbox.append(
                tx,
                topic='privacy.erasure.acknowledged.v1',
                tenant_id=str(payload['tenant_id']),
                aggregate_type='privacy_request',
                aggregate_id=str(payload['request_id']),
                payload={
                    'tenant_id': payload['tenant_id'],
                    'request_id': payload['request_id'],
                    'service': SERVICE,
                    'occurred_at': self.clock.now().isoformat(),
                },
            )
        return counts

    @staticmethod
    async def purge_tenant(tx: Tx) -> dict[str, int]:
        """`tenant.tenant.purged.v1`: the transaction is bound to the tenant, so RLS scopes every
        DELETE; the explicit filter is defence in depth."""
        out = {}
        for table in ('resume_embeddings', 'parse_jobs', 'parse_batch_items', 'parse_batches'):
            out[table] = await tx.execute(
                f'DELETE FROM {table} WHERE tenant_id = current_tenant_id()'  # noqa: S608 - fixed names
            )
        return out
