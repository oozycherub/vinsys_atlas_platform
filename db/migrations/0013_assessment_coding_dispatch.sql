-- Brick 9 integration (ADR-0006): when a session ends, coding answers that were never submitted
-- to the judge are auto-submitted by assessment-svc's sweeper (PRD §2.2d, "the last
-- server-acknowledged draft is auto-submitted"). The flag lets the sweeper find those sessions
-- in its system transaction; sessions are already readable there (0011).
ALTER TABLE assessment_sessions
  ADD COLUMN coding_dispatch_pending boolean NOT NULL DEFAULT false;
CREATE INDEX ix_sessions_coding_dispatch ON assessment_sessions (tenant_id, session_id)
  WHERE coding_dispatch_pending;
