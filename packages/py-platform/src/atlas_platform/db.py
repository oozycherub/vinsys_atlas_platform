"""psycopg 3 pool. Every unit of work is one transaction bound to a tenant (RLS) or marked system
(MASTER_ORCHESTRATION_PROMPT §4.3), exactly as @atlas/platform's withTenantTx / withSystemTx."""

from __future__ import annotations

from collections.abc import AsyncIterator
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from typing import Any, Protocol

from psycopg import AsyncConnection
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from atlas_platform.errors import AppError
from atlas_platform.ids import is_uuid

Params = tuple[Any, ...] | dict[str, Any]


class Tx(Protocol):
    """One open transaction, already bound to a tenant or marked as a system transaction."""

    async def execute(self, sql: str, params: Params = ()) -> int: ...

    async def fetch(self, sql: str, params: Params = ()) -> list[dict[str, Any]]: ...


class Database(Protocol):
    def tenant_tx(self, tenant_id: str) -> AbstractAsyncContextManager[Tx]: ...

    def system_tx(self) -> AbstractAsyncContextManager[Tx]: ...

    async def ping(self) -> None: ...


class PgTx:
    def __init__(self, conn: AsyncConnection[dict[str, Any]]) -> None:
        self._conn = conn

    async def execute(self, sql: str, params: Params = ()) -> int:
        cur = await self._conn.execute(sql, params)  # type: ignore[arg-type]
        return cur.rowcount

    async def fetch(self, sql: str, params: Params = ()) -> list[dict[str, Any]]:
        cur = await self._conn.execute(sql, params)  # type: ignore[arg-type]
        return await cur.fetchall()


class PgDatabase:
    """`app_role` (tests, or a pool that logs in as the owner) is assumed with SET LOCAL ROLE so
    RLS applies exactly as in production, where the pool already logs in as atlas_app."""

    def __init__(
        self, dsn: str, *, min_size: int = 1, max_size: int = 10, app_role: str | None = None
    ) -> None:
        self.pool: AsyncConnectionPool[AsyncConnection[dict[str, Any]]] = AsyncConnectionPool(
            dsn,
            min_size=min_size,
            max_size=max_size,
            open=False,
            kwargs={'row_factory': dict_row, 'autocommit': False},
        )
        self.app_role = app_role

    async def open(self) -> None:
        # Do not block start-up on the database: /readyz reports it until it is reachable.
        await self.pool.open(wait=False)

    async def close(self) -> None:
        await self.pool.close()

    @asynccontextmanager
    async def _tx(self, settings: dict[str, str]) -> AsyncIterator[PgTx]:
        async with self.pool.connection() as conn, conn.transaction():
            if self.app_role:
                await conn.execute(f'SET LOCAL ROLE {self.app_role}')  # type: ignore[arg-type]
            for key, value in settings.items():
                await conn.execute('SELECT set_config(%s, %s, true)', (key, value))
            yield PgTx(conn)

    def tenant_tx(self, tenant_id: str) -> AbstractAsyncContextManager[PgTx]:
        if not is_uuid(tenant_id):
            raise AppError('validation', 'INVALID_TENANT', 'tenant_id must be a UUID.')
        return self._tx({'app.tenant_id': tenant_id})

    def system_tx(self) -> AbstractAsyncContextManager[PgTx]:
        return self._tx({'app.system': 'on'})

    async def ping(self) -> None:
        async with self.pool.connection(timeout=2) as conn:
            await conn.execute('SELECT 1')
