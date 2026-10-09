

-- Running upgrade 20260926_0004 -> 20260926_0005

ALTER TABLE shared_documents ALTER COLUMN device_id DROP NOT NULL;

ALTER TABLE shared_changes ALTER COLUMN device_id DROP NOT NULL;

CREATE INDEX shared_documents_cloud_runs ON shared_documents (kind) WHERE device_id IS NULL AND kind = 'chat_run';

UPDATE alembic_version SET version_num='20260926_0005' WHERE alembic_version.version_num = '20260926_0004';
