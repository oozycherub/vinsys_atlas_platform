"""Test helpers: a real embedded Postgres (pgserver) with chosen migrations, and HS256 tokens."""

from __future__ import annotations

import time
from collections.abc import Iterable
from pathlib import Path
from typing import Any

import jwt
import psycopg

MIGRATIONS = Path(__file__).resolve().parents[4] / 'db' / 'migrations'
TEST_JWT_SECRET = 'test-secret-for-atlas-python-0123456789'  # noqa: S105 - test tokens only
TEST_ISSUER = 'https://identity.atlas.test'
TEST_AUDIENCE = 'atlas-api'


def start_postgres(data_dir: Path, migrations: Iterable[str]) -> tuple[Any, str]:
    """Starts pgserver (Postgres + pgvector) and applies the named migrations as the owner."""
    import pgserver

    server = pgserver.get_server(data_dir, cleanup_mode='stop')
    uri: str = server.get_uri()
    with psycopg.connect(uri, autocommit=True) as conn:
        conn.execute('CREATE EXTENSION IF NOT EXISTS vector')
        for name in migrations:
            conn.execute((MIGRATIONS / name).read_text())  # type: ignore[arg-type]
    return server, uri


def make_token(
    *,
    roles: list[str] | None = None,
    scopes: list[str] | None = None,
    tid: str | None = None,
    sub: str = 'svc:test',
    exp_in: int = 600,
    secret: str = TEST_JWT_SECRET,
) -> str:
    claims: dict[str, Any] = {
        'sub': sub,
        'iss': TEST_ISSUER,
        'aud': TEST_AUDIENCE,
        'exp': int(time.time()) + exp_in,
        'roles': roles or ['service'],
        'scopes': scopes or [],
    }
    if tid:
        claims['tid'] = tid
    return str(jwt.encode(claims, secret, algorithm='HS256'))
