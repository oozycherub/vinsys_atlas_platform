"""The fulfilment-plan worker process (`python -m intelligence_ml.main`): claims queued plans as
intelligence-svc queues them, so on-demand plans do not wait for the nightly Dagster run."""

from __future__ import annotations

import asyncio
import contextlib
import os
import signal
import socket

from atlas_platform.db import PgDatabase
from atlas_platform.logs import configure_logging

from intelligence_ml.plans import PlanWorker


async def run() -> None:  # pragma: no cover - process loop
    db = PgDatabase(
        os.environ['ATLAS_INTELLIGENCE_DATABASE_URL'], app_role=os.environ.get('ATLAS_DB_APP_ROLE')
    )
    await db.open()
    worker = PlanWorker(
        db,
        os.environ.get('HOSTNAME', socket.gethostname()),
        time_limit_s=float(os.environ.get('ATLAS_FULFILMENT_TIME_LIMIT_S', '600')),
    )
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    while not stop.is_set():
        if await worker.run_once() is None:
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(stop.wait(), timeout=2.0)
    await db.close()


def main() -> None:  # pragma: no cover - entry point
    configure_logging('intelligence-ml')
    asyncio.run(run())


if __name__ == '__main__':  # pragma: no cover
    main()
