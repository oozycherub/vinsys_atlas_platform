"""Feast definitions of the attrition features (PRD §2.5(vi) "Features (Feast, computed nightly)").

The source is a view over attrition_feature_snapshots (the pipeline's nightly output), expanded
from JSON into columns. The feature list must equal intelligence_ml.attrition.features.FEATURES;
tests/test_attrition.py checks it. Protected attributes are never declared here.
"""

from datetime import timedelta

from feast import Entity, FeatureView, Field
from feast.infra.offline_stores.contrib.postgres_offline_store.postgres_source import PostgreSQLSource
from feast.types import Float32

employee = Entity(name='employee', join_keys=['employee_id'])

snapshots = PostgreSQLSource(
    name='attrition_feature_snapshots',
    query="""
        SELECT employee_id, as_of::timestamp AS event_timestamp,
               (features->>'tenure_months')::float AS tenure_months,
               (features->>'months_since_promotion')::float AS months_since_promotion,
               (features->>'months_in_role')::float AS months_in_role,
               (features->>'compa_ratio')::float AS compa_ratio,
               (features->>'manager_changed_6m')::float AS manager_changed_6m,
               (features->>'team_attrition_6m')::float AS team_attrition_6m,
               (features->>'peer_exits_6m')::float AS peer_exits_6m,
               (features->>'skill_gap')::float AS skill_gap,
               (features->>'skill_gap_trend')::float AS skill_gap_trend,
               (features->>'internal_applications_6m')::float AS internal_applications_6m,
               (features->>'marketplace_rejections_6m')::float AS marketplace_rejections_6m,
               (features->>'engagement_delta')::float AS engagement_delta,
               (features->>'overtime_hours_4w')::float AS overtime_hours_4w
        FROM attrition_feature_snapshots
    """,
    timestamp_field='event_timestamp',
)

attrition_features = FeatureView(
    name='attrition_features',
    entities=[employee],
    ttl=timedelta(days=2),
    schema=[
        Field(name='tenure_months', dtype=Float32),
        Field(name='months_since_promotion', dtype=Float32),
        Field(name='months_in_role', dtype=Float32),
        Field(name='compa_ratio', dtype=Float32),
        Field(name='manager_changed_6m', dtype=Float32),
        Field(name='team_attrition_6m', dtype=Float32),
        Field(name='peer_exits_6m', dtype=Float32),
        Field(name='skill_gap', dtype=Float32),
        Field(name='skill_gap_trend', dtype=Float32),
        Field(name='internal_applications_6m', dtype=Float32),
        Field(name='marketplace_rejections_6m', dtype=Float32),
        Field(name='engagement_delta', dtype=Float32),
        Field(name='overtime_hours_4w', dtype=Float32),
    ],
    source=snapshots,
)
