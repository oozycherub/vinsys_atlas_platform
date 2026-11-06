-- Runs once when the local Postgres container initialises (as atlas_owner, the DB owner).
-- atlas_owner: owns schema objects and runs migrations.
-- atlas_app:   used by services at runtime; NOT a superuser, NO BYPASSRLS, so RLS always applies.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'atlas_app') THEN
    CREATE ROLE atlas_app LOGIN PASSWORD 'atlas_app_dev' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

GRANT CONNECT ON DATABASE atlas TO atlas_app;
