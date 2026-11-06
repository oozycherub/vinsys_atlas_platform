# Outbox relay (Debezium)

Every service writes events to `outbox_events` in the same transaction as its business change
(MASTER_ORCHESTRATION_PROMPT §4.4). This connector streams those inserts to Kafka/Redpanda with
the Debezium **outbox EventRouter**:

| Outbox column    | Kafka record                                    |
| ---------------- | ----------------------------------------------- |
| `topic`          | topic name (e.g. `tenant.tenant.suspended.v1`)  |
| `aggregate_id`   | message key, so one aggregate stays in order    |
| `payload`        | value (JSON)                                    |
| `event_id`       | header `event_id` (consumer de-duplication key) |
| `tenant_id`      | header `tenant_id`                              |
| `aggregate_type` | header `aggregate_type`                         |

Consumers turn records into events with `parseOutboxRecord()` and process them with
`createConsumer()` from `@atlas/platform`, which de-duplicates on `processed_events`.

## Setup

1. The CDC user needs `REPLICATION` and `SELECT` on `outbox_events`, and Postgres needs
   `wal_level=logical` (not enabled in `infra/docker-compose.yml` yet).
2. Register: `curl -X PUT -H 'Content-Type: application/json' --data @outbox-connector.json http://connect:8083/connectors/atlas-outbox/config` (send only the `config` object).
3. Outbox rows are append-only; a retention job (not built yet) deletes rows older than 7 days
   once Debezium has committed its offset past them.

## Status

Config only; not yet run against Kafka Connect in this repository. Services subscribe with
`runKafkaSource()` from `@atlas/platform` (identity-svc does when
`ATLAS_IDENTITY_EVENT_SOURCE=kafka`); poison records go to `dlq.<service>`.
