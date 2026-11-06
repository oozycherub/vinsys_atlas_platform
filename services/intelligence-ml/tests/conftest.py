"""Fixtures: a real Postgres (pgserver) with migrations 0001 + 0017, as the app role (RLS on).

LightGBM needs OpenMP: on macOS run the tests with the venv's Python and
DYLD_FALLBACK_LIBRARY_PATH pointing at scikit-learn's bundled libomp (see the Makefile)."""

from __future__ import annotations

import json
import uuid
from collections.abc import AsyncIterator, Iterator
from datetime import date
from pathlib import Path
from typing import Any

import psycopg
import pytest
from atlas_platform.db import PgDatabase

MIGRATIONS = Path(__file__).resolve().parents[3] / 'db' / 'migrations'
FIXTURES = Path(__file__).resolve().parents[3] / 'packages' / 'contracts' / 'fixtures'


@pytest.fixture(scope='session')
def postgres_uri(tmp_path_factory: pytest.TempPathFactory) -> Iterator[str]:
    import pgserver

    server = pgserver.get_server(tmp_path_factory.mktemp('pg'), cleanup_mode='stop')  # type: ignore[attr-defined]
    uri: str = server.get_uri()
    with psycopg.connect(uri, autocommit=True) as conn:
        for name in ('0001_foundation.sql', '0017_intelligence.sql'):
            conn.execute((MIGRATIONS / name).read_text())
    yield uri
    server.cleanup()


@pytest.fixture(scope='session')
async def db(postgres_uri: str) -> AsyncIterator[PgDatabase]:
    database = PgDatabase(postgres_uri, app_role='atlas_app', max_size=4)
    await database.open()
    yield database
    await database.close()


@pytest.fixture
def tenant() -> str:
    return str(uuid.uuid4())


def uid() -> str:
    return str(uuid.uuid4())


async def employee(db: PgDatabase, tenant_id: str, employee_id: str, **fields: Any) -> None:
    row = {
        'status': 'active',
        'marketplace_opt_in': True,
        'source_synced_at': '2026-11-06T00:00:00Z',
        **fields,
    }
    cols = ['tenant_id', 'employee_id', *row]
    async with db.tenant_tx(tenant_id) as tx:
        await tx.execute(
            f'INSERT INTO intel_employees ({", ".join(cols)}) VALUES ({", ".join(["%s"] * len(cols))})',
            (tenant_id, employee_id, *row.values()),
        )


async def skills(
    db: PgDatabase, tenant_id: str, employee_id: str, levels: dict[str, float]
) -> None:
    async with db.tenant_tx(tenant_id) as tx:
        for sid, p in levels.items():
            await tx.execute(
                """INSERT INTO intel_employee_skills (tenant_id, employee_id, skill_id, proficiency, is_validated)
                   VALUES (%s, %s, %s, %s, true)""",
                (tenant_id, employee_id, sid, p),
            )


async def demand(
    db: PgDatabase,
    tenant_id: str,
    *,
    title: str,
    skills_: list[dict[str, Any]],
    start: date,
    headcount: int = 1,
    allocation: int = 100,
    end: date | None = None,
    account: str | None = None,
) -> str:
    d = uid()
    async with db.tenant_tx(tenant_id) as tx:
        await tx.execute(
            """INSERT INTO demands (tenant_id, demand_id, account_id, title, skills, headcount, allocation_pct,
                 start_date, end_date) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (tenant_id, d, account, title, json.dumps(skills_), headcount, allocation, start, end),
        )
    return d


def req(skill: str, target: float, weight: float = 1.0) -> dict[str, Any]:
    return {'skill_id': skill, 'weight': weight, 'target_proficiency': target, 'must_have': False}
