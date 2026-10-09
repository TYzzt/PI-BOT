

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
