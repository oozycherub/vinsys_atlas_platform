"""Object storage: S3 / MinIO (boto3 in a worker thread) and in-memory for tests."""

from __future__ import annotations

import asyncio
from typing import Any

from parsing_svc.application.ports import UpstreamError


class S3Storage:
    def __init__(
        self, bucket: str, *, endpoint_url: str | None = None, region: str | None = None
    ) -> None:
        import boto3
        from botocore.config import Config

        self.bucket = bucket
        self._s3: Any = boto3.client(
            's3',
            endpoint_url=endpoint_url,
            region_name=region,
            config=Config(
                retries={'max_attempts': 3, 'mode': 'standard'}, connect_timeout=3, read_timeout=20
            ),
        )

    async def get(self, key: str) -> bytes:
        from botocore.exceptions import BotoCoreError, ClientError

        try:
            response = await asyncio.to_thread(self._s3.get_object, Bucket=self.bucket, Key=key)
            body: bytes = await asyncio.to_thread(response['Body'].read)
        except ClientError as error:
            if error.response.get('Error', {}).get('Code') in ('NoSuchKey', '404'):
                raise FileNotFoundError(key) from error
            raise UpstreamError(f's3: {error}') from error
        except BotoCoreError as error:
            raise UpstreamError(f's3: {type(error).__name__}') from error
        return body

    async def put(self, key: str, data: bytes, content_type: str) -> None:
        from botocore.exceptions import BotoCoreError, ClientError

        try:
            await asyncio.to_thread(
                self._s3.put_object,
                Bucket=self.bucket,
                Key=key,
                Body=data,
                ContentType=content_type,
            )
        except (BotoCoreError, ClientError) as error:
            raise UpstreamError(f's3: {type(error).__name__}') from error

    async def move(self, source: str, target: str) -> None:
        from botocore.exceptions import BotoCoreError, ClientError

        try:
            await asyncio.to_thread(
                self._s3.copy_object,
                Bucket=self.bucket,
                Key=target,
                CopySource={'Bucket': self.bucket, 'Key': source},
            )
            await asyncio.to_thread(self._s3.delete_object, Bucket=self.bucket, Key=source)
        except ClientError as error:
            if error.response.get('Error', {}).get('Code') in ('NoSuchKey', '404'):
                raise FileNotFoundError(source) from error
            raise UpstreamError(f's3: {error}') from error
        except BotoCoreError as error:
            raise UpstreamError(f's3: {type(error).__name__}') from error


class MemoryStorage:
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}

    async def get(self, key: str) -> bytes:
        if key not in self.objects:
            raise FileNotFoundError(key)
        return self.objects[key]

    async def put(self, key: str, data: bytes, content_type: str) -> None:
        self.objects[key] = data

    async def move(self, source: str, target: str) -> None:
        if source not in self.objects:
            raise FileNotFoundError(source)
        self.objects[target] = self.objects.pop(source)
