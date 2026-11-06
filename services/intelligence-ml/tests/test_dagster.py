"""The Dagster definitions load, and the nightly job runs in-process against the test database."""

from __future__ import annotations

from intelligence_ml import dagster_defs


def test_definitions_load() -> None:
    defs = dagster_defs.defs
    assert {j.name for j in [defs.get_job_def('nightly'), defs.get_job_def('monthly_retrain')]} == {
        'nightly',
        'monthly_retrain',
    }
    crons = sorted(str(getattr(s, 'cron_schedule', '')) for s in defs.schedules or [])
    assert crons == ['0 2 * * *', '0 3 1 * *']


def test_jobs_run_in_process(postgres_uri: str) -> None:
    resources = {'database': dagster_defs.AtlasDatabase(dsn=postgres_uri, app_role='atlas_app')}
    nightly = dagster_defs.nightly.execute_in_process(
        resources=resources, tags={'as_of': '2026-11-06'}
    )
    assert nightly.success
    assert isinstance(nightly.output_for_node('fulfilment_queue'), int)
    assert isinstance(nightly.output_for_node('skill_gaps_nightly'), dict)
    retrain = dagster_defs.monthly_retrain.execute_in_process(resources=resources)
    assert retrain.success
