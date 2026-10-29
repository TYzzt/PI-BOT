-- Additive compatibility migration; do not edit the already deployed 0010 migration.
-- PostgreSQL assigns this name to the inline CHECK in 0010. Fail if schema drifted.
ALTER TABLE devices DROP CONSTRAINT devices_platform_check;
ALTER TABLE devices ADD CONSTRAINT devices_platform_check CHECK (platform IN ('darwin', 'linux', 'win32'));
