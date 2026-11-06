"""The nightly skill-gap rebuild (PRD §2.5(a) "pre-aggregated nightly and incrementally").
intelligence-svc refreshes the affected groups as employees change; this recomputes every
group of the current month, which also starts the month's row (the history gives the trend)."""

from __future__ import annotations

from atlas_platform.db import Database

from intelligence_ml.attrition.pipeline import tenants

DIMENSIONS = ('department', 'job_profile', 'location')


async def rebuild(db: Database) -> dict[str, int]:
    out: dict[str, int] = {}
    for t in await tenants(db):
        async with db.tenant_tx(t) as tx:
            n = 0
            for d in DIMENSIONS:
                rows = await tx.fetch('SELECT intel_refresh_skill_gaps(%s, NULL) AS n', (d,))
                n += int(rows[0]['n'])
        out[t] = n
    return out
