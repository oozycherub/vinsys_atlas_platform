-- Brick 12: requisitions matching-svc creates from other bricks' events, e.g. a fulfilment plan's
-- `intel.demand.recruit_required.v1` (ADR-0009 §5). One requisition per source record: replays and
-- later plans for the same demand update it instead of creating another.
CREATE TABLE requisition_sources (
  tenant_id       uuid NOT NULL,
  source          text NOT NULL CHECK (source IN ('intelligence_demand')),
  source_ref      uuid NOT NULL,
  requisition_id  uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, source, source_ref),
  FOREIGN KEY (tenant_id, requisition_id) REFERENCES job_requisitions (tenant_id, requisition_id) ON DELETE CASCADE
);
ALTER TABLE requisition_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE requisition_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON requisition_sources
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, DELETE ON requisition_sources TO atlas_app;
