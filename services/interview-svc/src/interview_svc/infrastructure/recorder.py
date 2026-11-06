"""Interview audio (PRD §2.4c step 5): one WAV per track under `t/{tid}/interviews/{sid}/`."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any


def prefix(tenant_id: str, session_id: str) -> str:
    return f't/{tenant_id}/interviews/{session_id}/'


class MemoryRecorder:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    async def finalize(self, tenant_id: str, session_id: str, tracks: dict[str, bytes]) -> str:
        base = prefix(tenant_id, session_id)
        for name, data in tracks.items():
            self.objects[f'{base}{name}.wav'] = data
        return base

    async def delete(self, keys: Sequence[str]) -> None:
        for k in keys:
            for name in [n for n in self.objects if n.startswith(k)]:
                del self.objects[name]


class S3Recorder:  # pragma: no cover - needs object storage
    """boto3 is in the `voice` dependency group (agent image only)."""

    def __init__(self, bucket: str, endpoint_url: str | None = None) -> None:
        import boto3

        self.bucket = bucket
        self.s3: Any = boto3.client('s3', endpoint_url=endpoint_url)

    async def finalize(self, tenant_id: str, session_id: str, tracks: dict[str, bytes]) -> str:
        import asyncio

        base = prefix(tenant_id, session_id)
        for name, data in tracks.items():
            await asyncio.to_thread(
                self.s3.put_object,
                Bucket=self.bucket,
                Key=f'{base}{name}.wav',
                Body=data,
                ContentType='audio/wav',
                ServerSideEncryption='aws:kms',
            )
        return base

    async def delete(self, keys: Sequence[str]) -> None:
        import asyncio

        for k in keys:
            listed = await asyncio.to_thread(self.s3.list_objects_v2, Bucket=self.bucket, Prefix=k)
            for obj in listed.get('Contents', []):
                await asyncio.to_thread(self.s3.delete_object, Bucket=self.bucket, Key=obj['Key'])
