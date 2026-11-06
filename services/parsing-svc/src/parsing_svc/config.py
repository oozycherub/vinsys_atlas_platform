"""Environment configuration. Every variable is prefixed ATLAS_PARSE_."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Config:
    database_url: str
    issuer: str
    audience: str
    jwks_url: str | None
    jwt_secret: str | None
    gateway_url: str
    taxonomy_url: str
    profile_url: str
    token_url: str
    client_id: str
    client_secret: str
    storage: str = 'memory'  # s3 | memory
    s3_bucket: str | None = None
    s3_endpoint: str | None = None
    clamd_host: str | None = None
    clamd_port: int = 3310
    ocr: bool = False
    runner: str = 'inline'  # temporal | inline
    temporal_address: str = 'localhost:7233'
    temporal_namespace: str = 'default'
    temporal_payload_key: str | None = None
    kafka_brokers: str | None = None
    per_tenant_concurrency: int = 10
    parser_version: str = 'v3.0.0'
    spacy_model: str = 'en_core_web_sm'
    summary_locale: str = 'English'
    db_app_role: str | None = None
    environment: str = 'development'
    port: int = 8086

    @staticmethod
    def from_env(env: dict[str, str] | None = None) -> Config:
        e = dict(os.environ if env is None else env)

        def need(name: str) -> str:
            value = e.get(name)
            if not value:
                raise ValueError(f'{name} is required.')
            return value

        config = Config(
            database_url=need('ATLAS_PARSE_DATABASE_URL'),
            issuer=need('ATLAS_PARSE_JWT_ISSUER'),
            audience=e.get('ATLAS_PARSE_JWT_AUDIENCE', 'atlas-api'),
            jwks_url=e.get('ATLAS_PARSE_JWKS_URL'),
            jwt_secret=e.get('ATLAS_PARSE_JWT_SECRET'),
            gateway_url=need('ATLAS_PARSE_GATEWAY_URL'),
            taxonomy_url=need('ATLAS_PARSE_TAXONOMY_URL'),
            profile_url=need('ATLAS_PARSE_PROFILE_URL'),
            token_url=need('ATLAS_PARSE_TOKEN_URL'),
            client_id=need('ATLAS_PARSE_CLIENT_ID'),
            client_secret=need('ATLAS_PARSE_CLIENT_SECRET'),
            storage=e.get('ATLAS_PARSE_STORAGE', 'memory'),
            s3_bucket=e.get('ATLAS_PARSE_S3_BUCKET'),
            s3_endpoint=e.get('ATLAS_PARSE_S3_ENDPOINT'),
            clamd_host=e.get('ATLAS_PARSE_CLAMD_HOST'),
            clamd_port=int(e.get('ATLAS_PARSE_CLAMD_PORT', '3310')),
            ocr=e.get('ATLAS_PARSE_OCR', 'off') == 'paddle',
            runner=e.get('ATLAS_PARSE_RUNNER', 'inline'),
            temporal_address=e.get('ATLAS_PARSE_TEMPORAL_ADDRESS', 'localhost:7233'),
            temporal_namespace=e.get('ATLAS_PARSE_TEMPORAL_NAMESPACE', 'default'),
            temporal_payload_key=e.get('ATLAS_PARSE_TEMPORAL_PAYLOAD_KEY'),
            kafka_brokers=e.get('ATLAS_PARSE_KAFKA_BROKERS'),
            per_tenant_concurrency=int(e.get('ATLAS_PARSE_PER_TENANT_CONCURRENCY', '10')),
            parser_version=e.get('ATLAS_PARSE_PARSER_VERSION', 'v3.0.0'),
            spacy_model=e.get('ATLAS_PARSE_SPACY_MODEL', 'en_core_web_sm'),
            summary_locale=e.get('ATLAS_PARSE_SUMMARY_LOCALE', 'English'),
            db_app_role=e.get('ATLAS_PARSE_DB_APP_ROLE'),
            environment=e.get('ATLAS_ENV', 'development'),
            port=int(e.get('PORT', '8086')),
        )
        if config.storage not in ('s3', 'memory') or config.runner not in ('temporal', 'inline'):
            raise ValueError(
                'ATLAS_PARSE_STORAGE must be s3|memory and ATLAS_PARSE_RUNNER temporal|inline.'
            )
        if config.storage == 's3' and not config.s3_bucket:
            raise ValueError('ATLAS_PARSE_S3_BUCKET is required when ATLAS_PARSE_STORAGE=s3.')
        if config.environment == 'production':
            # Fail closed: production never runs without real malware scanning, S3, Temporal and
            # encrypted Temporal payloads.
            missing = [
                name
                for name, ok in (
                    ('ATLAS_PARSE_CLAMD_HOST', config.clamd_host),
                    ('ATLAS_PARSE_STORAGE=s3', config.storage == 's3'),
                    ('ATLAS_PARSE_RUNNER=temporal', config.runner == 'temporal'),
                    ('ATLAS_PARSE_TEMPORAL_PAYLOAD_KEY', config.temporal_payload_key),
                )
                if not ok
            ]
            if missing:
                raise ValueError('Production requires ' + ', '.join(missing) + '.')
        return config
