"""Bulk import (`POST /v1/resumes:bulkImport`): a zip of ≤ 500 résumés becomes placeholder
candidates and uploaded documents in profile-svc. Each upload then follows the normal path
(S3 notification → profile.resume.uploaded.v1 → a parse job), so fair-share scheduling, the
security gate and every other rule apply to bulk files exactly as to single uploads."""

from __future__ import annotations

import hashlib
import io
import logging
import zipfile
from dataclasses import dataclass
from typing import Any

from atlas_platform.db import Database
from atlas_platform.errors import AppError
from atlas_platform.ids import uuid7

from parsing_svc.application.ports import (
    DuplicateDocumentError,
    ObjectStorage,
    ProfileApi,
    UpstreamError,
)
from parsing_svc.application.store import BatchRepository
from parsing_svc.domain.sniff import DOCX, JPEG, MAX_DOCUMENT_BYTES, OLE, PDF, PNG, TEXT, ZIP, sniff

log = logging.getLogger('parsing_svc')

MAX_FILES = 500
MAX_ARCHIVE_UNCOMPRESSED = 600 * 1024 * 1024
EXTENSIONS = {'.pdf', '.docx', '.doc', '.png', '.jpg', '.jpeg', '.txt'}
_MIME_FOR = {PDF: PDF, PNG: PNG, JPEG: JPEG, TEXT: TEXT, ZIP: DOCX, OLE: 'application/msword'}


@dataclass(frozen=True)
class Entry:
    index: int
    name: str
    extension: str
    size: int


def list_entries(data: bytes) -> list[Entry]:
    """Validates the archive without extracting it. Raises AppError (400/422)."""
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
        infos = archive.infolist()
    except zipfile.BadZipFile as error:
        raise AppError(
            'validation', 'INVALID_ARCHIVE', 'The upload is not a valid zip archive.'
        ) from error
    files = [
        i
        for i in infos
        if not i.is_dir()
        and not i.filename.startswith('__MACOSX/')
        and not i.filename.rsplit('/', 1)[-1].startswith('.')
    ]
    if not files:
        raise AppError('validation', 'EMPTY_ARCHIVE', 'The archive contains no files.')
    if len(files) > MAX_FILES:
        raise AppError('rule', 'TOO_MANY_FILES', f'At most {MAX_FILES} files per import.')
    if sum(i.file_size for i in infos) > MAX_ARCHIVE_UNCOMPRESSED:
        raise AppError('rule', 'ARCHIVE_TOO_LARGE', 'The archive expands beyond the import limit.')
    out = []
    for n, info in enumerate(files):
        name = info.filename.rsplit('/', 1)[-1]
        ext = ('.' + name.rsplit('.', 1)[-1].lower()) if '.' in name else ''
        out.append(Entry(n, info.filename, ext, info.file_size))
    return out


class BulkImporter:
    def __init__(
        self, db: Database, batches: BatchRepository, storage: ObjectStorage, profile: ProfileApi
    ) -> None:
        self.db = db
        self.batches = batches
        self.storage = storage
        self.profile = profile

    @staticmethod
    def archive_key(tenant_id: str, batch_id: str) -> str:
        return f't/{tenant_id}/imports/{batch_id}.zip'

    async def accept(self, tenant_id: str, data: bytes, by: str) -> dict[str, Any]:
        entries = list_entries(data)
        batch_id = uuid7()
        await self.storage.put(self.archive_key(tenant_id, batch_id), data, 'application/zip')
        async with self.db.tenant_tx(tenant_id) as tx:
            await self.batches.create(
                tx,
                tenant_id=tenant_id,
                batch_id=batch_id,
                by=by,
                items=[(e.extension, e.size) for e in entries],
            )
        return {'batch_id': batch_id, 'total': len(entries), 'status': 'accepted'}

    async def run(self, tenant_id: str, batch_id: str) -> dict[str, int]:
        """Submits every pending item; safe to re-run (idempotent per item)."""
        async with self.db.tenant_tx(tenant_id) as tx:
            await self.batches.set_status(tx, batch_id, 'importing')
            items = await self.batches.items(tx, batch_id)
        data = await self.storage.get(self.archive_key(tenant_id, batch_id))
        entries = list_entries(data)
        archive = zipfile.ZipFile(io.BytesIO(data))
        counts = {'submitted': 0, 'skipped': 0, 'failed': 0}
        for item in items:
            if item['status'] != 'pending':
                continue
            entry = entries[item['item_index']]
            outcome = await self._one(tenant_id, batch_id, entry, archive)
            counts[outcome] += 1
        async with self.db.tenant_tx(tenant_id) as tx:
            pending = [
                i for i in await self.batches.items(tx, batch_id) if i['status'] == 'pending'
            ]
            await self.batches.set_status(tx, batch_id, 'importing' if pending else 'imported')
        log.info('bulk import ran', extra={'tenant_id': tenant_id, 'batch_id': batch_id, **counts})
        return counts

    async def _one(
        self, tenant_id: str, batch_id: str, entry: Entry, archive: zipfile.ZipFile
    ) -> str:
        async def update(**fields: Any) -> None:
            async with self.db.tenant_tx(tenant_id) as tx:
                await self.batches.update_item(tx, batch_id, entry.index, **fields)

        if entry.extension not in EXTENSIONS or entry.size > MAX_DOCUMENT_BYTES or entry.size == 0:
            await update(status='skipped', error_code='UNSUPPORTED_DOCUMENT')
            return 'skipped'
        with archive.open(entry.name) as handle:
            content = handle.read(MAX_DOCUMENT_BYTES + 1)
        mime = _MIME_FOR.get(sniff(content) or '')
        if mime is None or len(content) > MAX_DOCUMENT_BYTES:
            await update(status='skipped', error_code='UNSUPPORTED_DOCUMENT')
            return 'skipped'
        ref = f'bulk:{batch_id}:{entry.index}'
        try:
            candidate_id = await self.profile.create_candidate(
                tenant_id,
                f'Imported résumé {batch_id[-6:]}-{entry.index + 1}',
                ref,
                f'{ref}:candidate',
            )
            await update(candidate_id=candidate_id)
            target = await self.profile.initiate_upload(
                tenant_id, candidate_id, mime, len(content), hashlib.sha256(content).hexdigest()
            )
            await self.profile.upload(target, content)
        except DuplicateDocumentError as dup:
            await update(
                status='skipped', error_code='DOCUMENT_DUPLICATE', document_id=dup.document_id
            )
            return 'skipped'
        except UpstreamError:
            return 'failed'  # stays pending; a re-run retries it
        await update(status='submitted', document_id=target.document_id)
        return 'submitted'

    async def status(self, tenant_id: str, batch_id: str) -> dict[str, Any]:
        async with self.db.tenant_tx(tenant_id) as tx:
            batch = await self.batches.get(tx, batch_id)
            if batch is None:
                raise AppError('not_found', 'BATCH_NOT_FOUND', 'No such import in this tenant.')
            items = await self.batches.items(tx, batch_id)
        counts: dict[str, int] = {}
        for i in items:
            counts[i['status']] = counts.get(i['status'], 0) + 1
        return {
            'batch_id': batch_id,
            'status': batch['status'],
            'total': batch['total'],
            'items': counts,
            'created_at': batch['created_at'].isoformat(),
        }
