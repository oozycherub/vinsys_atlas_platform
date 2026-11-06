"""Settings from the environment (12-factor); invalid configuration stops the process."""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, field
from urllib.parse import urlparse


class ConfigError(ValueError):
    pass


@dataclass(frozen=True)
class Config:
    kafka_brokers: str
    triton_url: str
    proctoring_url: str
    token_url: str
    client_id: str
    client_secret: str
    environment: str = 'development'
    log_level: str = 'info'
    port: int = 8092
    s3_endpoint: str | None = None
    bucket: str = 'atlas-proctoring'
    versions: dict[str, str] = field(default_factory=dict)

    @staticmethod
    def from_env(env: Mapping[str, str]) -> Config:
        problems: list[str] = []

        def need(key: str) -> str:
            value = env.get(key, '').strip()
            if not value:
                problems.append(f'{key} is required')
            return value

        def url(key: str) -> str:
            value = need(key)
            parsed = urlparse(value)
            if value and (parsed.scheme not in ('http', 'https') or not parsed.netloc):
                problems.append(f'{key} must be an http(s) URL')
            return value

        try:
            port = int(env.get('ATLAS_CV_INFERENCE_PORT', '8092'))
            if not 1 <= port <= 65535:
                raise ValueError
        except ValueError:
            problems.append('ATLAS_CV_INFERENCE_PORT must be a port number')
            port = 0
        try:
            versions = json.loads(env.get('ATLAS_CV_MODEL_VERSIONS', '{}'))
            if not isinstance(versions, dict) or not all(
                isinstance(v, str) for v in versions.values()
            ):
                raise TypeError
        except (ValueError, TypeError):
            problems.append('ATLAS_CV_MODEL_VERSIONS must be a JSON object of strings')
            versions = {}
        level = env.get('ATLAS_LOG_LEVEL', 'info')
        if level not in ('debug', 'info', 'warn', 'error'):
            problems.append('ATLAS_LOG_LEVEL must be debug, info, warn or error')
        environment = env.get('NODE_ENV', 'development')
        cfg = Config(
            kafka_brokers=need('ATLAS_KAFKA_BROKERS'),
            triton_url=need('ATLAS_TRITON_URL'),
            proctoring_url=url('ATLAS_PROCTORING_SVC_URL'),
            token_url=url('ATLAS_IDENTITY_TOKEN_URL'),
            client_id=need('ATLAS_CV_INFERENCE_CLIENT_ID'),
            client_secret=need('ATLAS_CV_INFERENCE_CLIENT_SECRET'),
            environment=environment,
            log_level=level,
            port=port,
            s3_endpoint=env.get('ATLAS_S3_ENDPOINT') or None,
            bucket=env.get('ATLAS_PROCTORING_BUCKET', 'atlas-proctoring'),
            versions=versions,
        )
        if environment == 'production' and not versions:
            problems.append(
                'ATLAS_CV_MODEL_VERSIONS is required in production (results record model versions)'
            )
        if problems:
            raise ConfigError('invalid configuration:\n  - ' + '\n  - '.join(problems))
        return cfg
