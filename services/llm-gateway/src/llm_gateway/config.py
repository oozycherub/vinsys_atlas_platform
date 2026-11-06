"""Environment configuration (12-factor). Every variable is prefixed ATLAS_LLM_."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field

from llm_gateway.application.ports import RouteTarget

#: Default model routes (docs/prompts/05 §2). Failover targets come after the first entry;
#: production adds Claude on Bedrock or Vertex here as a second provider.
DEFAULT_ROUTES = {
    'primary': [{'provider': 'anthropic', 'model': 'claude-sonnet-5-5'}],
    'fast': [{'provider': 'anthropic', 'model': 'claude-haiku-5-5'}],
    'eval': [{'provider': 'anthropic', 'model': 'claude-opus-5-5'}],
}


@dataclass(frozen=True)
class Config:
    database_url: str
    issuer: str
    audience: str
    jwks_url: str | None = None
    jwt_secret: str | None = None
    anthropic_api_key: str | None = None
    #: 'anthropic' in production; 'stub' runs without a key (development only).
    provider: str = 'anthropic'
    routes: dict[str, list[RouteTarget]] = field(default_factory=dict)
    redis_url: str | None = None
    kafka_brokers: str | None = None
    triton_url: str | None = None
    embedding_model: str = 'bge-m3'
    pii_detector: str = 'presidio'
    spacy_model: str = 'en_core_web_sm'
    pseudonym_secret: bytes = b''
    default_monthly_tokens: int = 5_000_000
    default_monthly_gpu_seconds: float = 3_600.0
    db_app_role: str | None = None
    port: int = 8080

    @staticmethod
    def from_env(env: dict[str, str] | None = None) -> Config:
        e = dict(os.environ if env is None else env)

        def need(name: str) -> str:
            value = e.get(name)
            if not value:
                raise ValueError(f'{name} is required.')
            return value

        raw_routes = (
            json.loads(e['ATLAS_LLM_ROUTES']) if e.get('ATLAS_LLM_ROUTES') else DEFAULT_ROUTES
        )
        provider = e.get('ATLAS_LLM_PROVIDER', 'anthropic')
        routes = {
            name: [
                RouteTarget(provider if provider == 'stub' else t['provider'], t['model'])
                for t in targets
            ]
            for name, targets in raw_routes.items()
        }
        secret = need('ATLAS_LLM_PSEUDONYM_SECRET')
        if len(secret) < 32:
            raise ValueError('ATLAS_LLM_PSEUDONYM_SECRET must be at least 32 characters.')
        if provider == 'anthropic':
            need('ANTHROPIC_API_KEY')
        return Config(
            database_url=need('ATLAS_LLM_DATABASE_URL'),
            issuer=need('ATLAS_LLM_JWT_ISSUER'),
            audience=e.get('ATLAS_LLM_JWT_AUDIENCE', 'atlas-api'),
            jwks_url=e.get('ATLAS_LLM_JWKS_URL'),
            jwt_secret=e.get('ATLAS_LLM_JWT_SECRET'),
            anthropic_api_key=e.get('ANTHROPIC_API_KEY'),
            provider=provider,
            routes=routes,
            redis_url=e.get('ATLAS_LLM_REDIS_URL'),
            kafka_brokers=e.get('ATLAS_LLM_KAFKA_BROKERS'),
            triton_url=e.get('ATLAS_LLM_TRITON_URL'),
            embedding_model=e.get('ATLAS_LLM_EMBEDDING_MODEL', 'bge-m3'),
            pii_detector=e.get('ATLAS_LLM_PII_DETECTOR', 'presidio'),
            spacy_model=e.get('ATLAS_LLM_SPACY_MODEL', 'en_core_web_sm'),
            pseudonym_secret=secret.encode(),
            default_monthly_tokens=int(e.get('ATLAS_LLM_DEFAULT_MONTHLY_TOKENS', '5000000')),
            default_monthly_gpu_seconds=float(
                e.get('ATLAS_LLM_DEFAULT_MONTHLY_GPU_SECONDS', '3600')
            ),
            db_app_role=e.get('ATLAS_LLM_DB_APP_ROLE'),
            port=int(e.get('PORT', '8080')),
        )
