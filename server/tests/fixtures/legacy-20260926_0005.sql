

CREATE TABLE alembic_version (
    version_num VARCHAR(32) NOT NULL,
    CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num)
);

-- Running upgrade  -> 20260925_0001

CREATE TABLE users (
    user_id UUID NOT NULL,
    password_hash TEXT NOT NULL,
    singleton BOOLEAN NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    PRIMARY KEY (user_id),
    CONSTRAINT users_singleton_key UNIQUE (singleton)
);

CREATE TABLE pairing_codes (
    pairing_code_id UUID NOT NULL,
    code_hash TEXT NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    used_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    PRIMARY KEY (pairing_code_id),
    CONSTRAINT pairing_codes_code_hash_key UNIQUE (code_hash)
);

CREATE TABLE devices (
    device_id UUID NOT NULL,
    public_key TEXT NOT NULL,
    label TEXT NOT NULL,
    capabilities JSONB NOT NULL,
    last_seen_at TIMESTAMP WITH TIME ZONE,
    revoked_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    PRIMARY KEY (device_id)
);

CREATE UNIQUE INDEX devices_active_public_key ON devices (public_key) WHERE revoked_at IS NULL;

CREATE TABLE device_nonces (
    device_id UUID NOT NULL,
    nonce TEXT NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    PRIMARY KEY (device_id, nonce),
    FOREIGN KEY(device_id) REFERENCES devices (device_id)
);

CREATE INDEX device_nonces_expires_at ON device_nonces (expires_at);

CREATE TABLE projects (
    project_id UUID NOT NULL,
    device_id UUID NOT NULL,
    display_name TEXT NOT NULL,
    availability TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
    PRIMARY KEY (project_id),
    CONSTRAINT projects_availability_check CHECK (availability IN ('available', 'unavailable')),
    FOREIGN KEY(device_id) REFERENCES devices (device_id)
);

CREATE INDEX projects_device_id ON projects (device_id);

INSERT INTO alembic_version (version_num) VALUES ('20260925_0001') RETURNING alembic_version.version_num;

-- Running upgrade 20260925_0001 -> 20260925_0002

CREATE TABLE tasks (
    task_id UUID NOT NULL,
    project_id UUID NOT NULL,
    target_device_id UUID NOT NULL,
    requirement TEXT NOT NULL,
    status TEXT NOT NULL,
    cancel_requested_at TIMESTAMP WITH TIME ZONE,
    idempotency_key TEXT NOT NULL,
    latest_plan_id UUID,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
    PRIMARY KEY (task_id),
    CONSTRAINT tasks_status_check CHECK (status IN ('queued', 'waiting_for_device', 'planning', 'awaiting_review', 'approved', 'running', 'waiting_for_input', 'waiting_for_local_action', 'needs_replan', 'interrupted', 'completed', 'failed', 'cancelled', 'rejected')),
    CONSTRAINT tasks_idempotency_key_key UNIQUE (idempotency_key),
    FOREIGN KEY(project_id) REFERENCES projects (project_id),
    FOREIGN KEY(target_device_id) REFERENCES devices (device_id)
);

CREATE INDEX ix_tasks_project_id ON tasks (project_id);

CREATE INDEX ix_tasks_target_device_id ON tasks (target_device_id);

CREATE TABLE plans (
    plan_id UUID NOT NULL,
    task_id UUID NOT NULL,
    version INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    body JSONB NOT NULL,
    workspace_fingerprint TEXT NOT NULL,
    config_snapshot_id TEXT NOT NULL,
    device_id UUID NOT NULL,
    project_id UUID NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    superseded_at TIMESTAMP WITH TIME ZONE,
    PRIMARY KEY (plan_id),
    CONSTRAINT plans_task_version_key UNIQUE (task_id, version),
    FOREIGN KEY(task_id) REFERENCES tasks (task_id),
    FOREIGN KEY(device_id) REFERENCES devices (device_id),
    FOREIGN KEY(project_id) REFERENCES projects (project_id)
);

CREATE INDEX ix_plans_task_id ON plans (task_id);

CREATE TABLE approvals (
    approval_id UUID NOT NULL,
    plan_id UUID NOT NULL,
    task_id UUID NOT NULL,
    version INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    device_id UUID NOT NULL,
    project_id UUID NOT NULL,
    status TEXT NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE,
    idempotency_key TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    PRIMARY KEY (approval_id),
    CONSTRAINT approvals_status_check CHECK (status IN ('recorded', 'rejected', 'expired')),
    CONSTRAINT approvals_idempotency_key_key UNIQUE (idempotency_key),
    FOREIGN KEY(plan_id) REFERENCES plans (plan_id),
    FOREIGN KEY(task_id) REFERENCES tasks (task_id),
    FOREIGN KEY(device_id) REFERENCES devices (device_id),
    FOREIGN KEY(project_id) REFERENCES projects (project_id)
);

CREATE INDEX ix_approvals_task_id ON approvals (task_id);

CREATE UNIQUE INDEX approvals_active_plan ON approvals (plan_id) WHERE status IN ('recorded', 'rejected');

CREATE TABLE runs (
    run_id UUID NOT NULL,
    task_id UUID NOT NULL,
    phase TEXT NOT NULL,
    attempt INTEGER NOT NULL,
    approval_id UUID,
    state TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
    PRIMARY KEY (run_id),
    CONSTRAINT runs_state_check CHECK (state IN ('queued', 'running', 'waiting_for_input', 'waiting_for_local_action', 'needs_replan', 'interrupted', 'completed', 'failed', 'cancelled', 'expired')),
    CONSTRAINT runs_phase_check CHECK (phase IN ('plan', 'execute')),
    FOREIGN KEY(task_id) REFERENCES tasks (task_id),
    FOREIGN KEY(approval_id) REFERENCES approvals (approval_id)
);

CREATE INDEX ix_runs_task_id ON runs (task_id);

CREATE TABLE plan_feedback (
    feedback_id UUID NOT NULL,
    task_id UUID NOT NULL,
    plan_id UUID NOT NULL,
    run_id UUID NOT NULL,
    feedback TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    PRIMARY KEY (feedback_id),
    CONSTRAINT plan_feedback_idempotency_key_key UNIQUE (idempotency_key),
    FOREIGN KEY(task_id) REFERENCES tasks (task_id),
    FOREIGN KEY(plan_id) REFERENCES plans (plan_id)
);

CREATE INDEX ix_plan_feedback_task_id ON plan_feedback (task_id);

CREATE TABLE commands (
    command_id UUID NOT NULL,
    device_id UUID NOT NULL,
    task_id UUID NOT NULL,
    run_id UUID,
    type TEXT NOT NULL,
    payload JSONB NOT NULL,
    status TEXT NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    delivered_at TIMESTAMP WITH TIME ZONE,
    acked_at TIMESTAMP WITH TIME ZONE,
    PRIMARY KEY (command_id),
    CONSTRAINT commands_type_check CHECK (type IN ('plan_request', 'plan_revise', 'execute', 'cancel')),
    CONSTRAINT commands_status_check CHECK (status IN ('pending', 'delivered', 'acked', 'expired', 'superseded')),
    FOREIGN KEY(device_id) REFERENCES devices (device_id),
    FOREIGN KEY(task_id) REFERENCES tasks (task_id),
    FOREIGN KEY(run_id) REFERENCES runs (run_id)
);

CREATE INDEX ix_commands_task_id ON commands (task_id);

CREATE INDEX commands_device_status ON commands (device_id, status);

CREATE TABLE events (
    event_id UUID NOT NULL,
    server_cursor BIGINT GENERATED ALWAYS AS IDENTITY,
    task_id UUID,
    run_id UUID,
    producer_id TEXT NOT NULL,
    producer_seq BIGINT,
    type TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    occurred_at TIMESTAMP WITH TIME ZONE NOT NULL,
    recorded_at TIMESTAMP WITH TIME ZONE NOT NULL,
    payload JSONB NOT NULL,
    PRIMARY KEY (event_id),
    CONSTRAINT events_server_cursor_key UNIQUE (server_cursor),
    FOREIGN KEY(task_id) REFERENCES tasks (task_id)
);

CREATE INDEX ix_events_task_id ON events (task_id);

CREATE TABLE device_event_sequences (
    device_id UUID NOT NULL,
    last_seq BIGINT NOT NULL,
    PRIMARY KEY (device_id),
    FOREIGN KEY(device_id) REFERENCES devices (device_id)
);

UPDATE alembic_version SET version_num='20260925_0002' WHERE alembic_version.version_num = '20260925_0001';

-- Running upgrade 20260925_0002 -> 20260926_0003

ALTER TABLE approvals ADD COLUMN actor TEXT DEFAULT 'user' NOT NULL;

ALTER TABLE approvals ADD CONSTRAINT approvals_actor_check CHECK (actor IN ('user', 'device'));

ALTER TABLE plan_feedback ADD COLUMN actor TEXT DEFAULT 'user' NOT NULL;

ALTER TABLE plan_feedback ADD CONSTRAINT plan_feedback_actor_check CHECK (actor IN ('user', 'device'));

UPDATE alembic_version SET version_num='20260926_0003' WHERE alembic_version.version_num = '20260925_0002';

-- Running upgrade 20260926_0003 -> 20260926_0004

CREATE TABLE shared_documents (
    id UUID NOT NULL,
    position BIGINT GENERATED BY DEFAULT AS IDENTITY,
    kind TEXT NOT NULL,
    device_id UUID,
    version INTEGER NOT NULL,
    data JSONB NOT NULL,
    PRIMARY KEY (id),
    FOREIGN KEY(device_id) REFERENCES devices (device_id)
);

CREATE INDEX ix_shared_documents_device_id ON shared_documents (device_id);

CREATE TABLE shared_revisions (
    id BIGINT GENERATED BY DEFAULT AS IDENTITY,
    document_id UUID NOT NULL,
    version INTEGER NOT NULL,
    data JSONB NOT NULL,
    PRIMARY KEY (id),
    UNIQUE (document_id, version),
    FOREIGN KEY(document_id) REFERENCES shared_documents (id)
);

CREATE TABLE shared_changes (
    cursor BIGINT GENERATED BY DEFAULT AS IDENTITY,
    device_id UUID,
    kind TEXT NOT NULL,
    entity_id UUID NOT NULL,
    version INTEGER NOT NULL,
    PRIMARY KEY (cursor),
    FOREIGN KEY(device_id) REFERENCES devices (device_id)
);

CREATE INDEX ix_shared_changes_device_id ON shared_changes (device_id);

CREATE TABLE shared_receipts (
    id TEXT NOT NULL,
    digest TEXT NOT NULL,
    result JSONB NOT NULL,
    PRIMARY KEY (id)
);

UPDATE alembic_version SET version_num='20260926_0004' WHERE alembic_version.version_num = '20260926_0003';

-- Running upgrade 20260926_0004 -> 20260926_0005

ALTER TABLE shared_documents ALTER COLUMN device_id DROP NOT NULL;

ALTER TABLE shared_changes ALTER COLUMN device_id DROP NOT NULL;

CREATE INDEX shared_documents_cloud_runs ON shared_documents (kind) WHERE device_id IS NULL AND kind = 'chat_run';

UPDATE alembic_version SET version_num='20260926_0005' WHERE alembic_version.version_num = '20260926_0004';
