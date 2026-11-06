"""Environment configuration. Every variable is prefixed ATLAS_INTERVIEW_."""

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
    tenant_url: str
    token_url: str
    client_id: str
    client_secret: str
    livekit_url: str
    livekit_api_key: str
    livekit_api_secret: str
    ws_base_url: str
    redis_url: str | None = None
    kafka_brokers: str | None = None
    s3_bucket: str | None = None
    s3_endpoint: str | None = None
    tts_url: str | None = None
    tts_voice: str = 'en-neutral'
    stt_model: str = 'large-v3'
    vad: str = 'silero'  # silero | energy
    worker_id: str = 'interview-svc'
    worker_capacity: int = 4
    lease_ttl_s: int = 60
    calibration: bool = False
    db_app_role: str | None = None
    environment: str = 'development'
    port: int = 8091

    @staticmethod
    def from_env(env: dict[str, str] | None = None) -> Config:
        e = dict(os.environ if env is None else env)

        def need(name: str) -> str:
            value = e.get(name)
            if not value:
                raise ValueError(f'{name} is required.')
            return value

        p = 'ATLAS_INTERVIEW_'
        config = Config(
            database_url=need(p + 'DATABASE_URL'),
            issuer=need(p + 'JWT_ISSUER'),
            audience=e.get(p + 'JWT_AUDIENCE', 'atlas-api'),
            jwks_url=e.get(p + 'JWKS_URL'),
            jwt_secret=e.get(p + 'JWT_SECRET'),
            gateway_url=need(p + 'GATEWAY_URL'),
            taxonomy_url=need(p + 'TAXONOMY_URL'),
            tenant_url=need(p + 'TENANT_URL'),
            token_url=need(p + 'TOKEN_URL'),
            client_id=need(p + 'CLIENT_ID'),
            client_secret=need(p + 'CLIENT_SECRET'),
            livekit_url=need(p + 'LIVEKIT_URL'),
            livekit_api_key=need(p + 'LIVEKIT_API_KEY'),
            livekit_api_secret=need(p + 'LIVEKIT_API_SECRET'),
            ws_base_url=need(p + 'WS_BASE_URL'),
            redis_url=e.get(p + 'REDIS_URL'),
            kafka_brokers=e.get(p + 'KAFKA_BROKERS'),
            s3_bucket=e.get(p + 'S3_BUCKET'),
            s3_endpoint=e.get(p + 'S3_ENDPOINT'),
            tts_url=e.get(p + 'TTS_URL'),
            tts_voice=e.get(p + 'TTS_VOICE', 'en-neutral'),
            stt_model=e.get(p + 'STT_MODEL', 'large-v3'),
            vad=e.get(p + 'VAD', 'silero'),
            worker_id=e.get(p + 'WORKER_ID') or e.get('HOSTNAME', 'interview-svc'),
            worker_capacity=int(e.get(p + 'WORKER_CAPACITY', '4')),
            lease_ttl_s=int(e.get(p + 'LEASE_TTL_S', '60')),
            calibration=e.get(p + 'CALIBRATION', 'off') == 'on',
            db_app_role=e.get(p + 'DB_APP_ROLE'),
            environment=e.get('ATLAS_ENV', 'development'),
            port=int(e.get('PORT', '8091')),
        )
        if config.vad not in ('silero', 'energy'):
            raise ValueError(p + 'VAD must be silero|energy.')
        if not 15 <= config.lease_ttl_s <= 600:
            raise ValueError(p + 'LEASE_TTL_S must be 15-600.')
        if config.environment == 'production':
            # Fail closed: no shared-secret tokens, no in-memory hot state, real recordings.
            if config.jwt_secret or not config.jwks_url:
                raise ValueError('production verifies tokens with JWKS only (no JWT secret).')
            if not config.redis_url or not config.kafka_brokers or not config.s3_bucket:
                raise ValueError('production needs Redis, Kafka and an S3 bucket.')
            if not config.ws_base_url.startswith('wss://'):
                raise ValueError(p + 'WS_BASE_URL must use wss:// in production.')
        return config
