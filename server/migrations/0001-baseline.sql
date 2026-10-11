CREATE TABLE users (
  user_id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE CHECK (username ~ '^[A-Za-z0-9_.@-]{1,64}$'),
  display_name text NOT NULL DEFAULT '',
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'user')),
  disabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE devices (
  device_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  public_key text NOT NULL,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  revoked_at timestamptz
);
-- Each user binds exactly one Mac as the harness computer.
CREATE UNIQUE INDEX devices_one_active ON devices(user_id) WHERE revoked_at IS NULL;

CREATE TABLE device_nonces (
  device_id uuid NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  nonce text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (device_id, nonce)
);
CREATE INDEX device_nonces_expiry ON device_nonces(expires_at);

CREATE TABLE models (
  model_id uuid PRIMARY KEY,
  name text NOT NULL,
  base_url text NOT NULL,
  provider_model text NOT NULL,
  context_window integer NOT NULL CHECK (context_window >= 1024),
  max_tokens integer NOT NULL CHECK (max_tokens >= 16 AND max_tokens < context_window),
  secret jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX models_one_default ON models(is_default) WHERE is_default;

CREATE TABLE bots (
  bot_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  persona text NOT NULL DEFAULT '',
  model_id uuid REFERENCES models(model_id) ON DELETE SET NULL,
  avatar jsonb NOT NULL,
  next_seq bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
-- Library folder names stay reserved after archive so files are never mixed.
CREATE UNIQUE INDEX bots_slug ON bots(user_id, slug);
CREATE INDEX bots_user ON bots(user_id, archived_at);

CREATE TABLE bot_runs (
  run_id uuid PRIMARY KEY,
  bot_id uuid NOT NULL REFERENCES bots(bot_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  request_id text NOT NULL,
  executor text NOT NULL CHECK (executor IN ('mac', 'cloud')),
  device_id uuid REFERENCES devices(device_id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled')),
  error text,
  cancel_requested boolean NOT NULL DEFAULT false,
  user_message_id uuid NOT NULL,
  assistant_message_id uuid NOT NULL,
  worker_id uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  UNIQUE (bot_id, request_id)
);
-- A bot works on one message at a time.
CREATE UNIQUE INDEX bot_runs_one_active ON bot_runs(bot_id) WHERE status IN ('queued', 'running', 'waiting_approval');
CREATE INDEX bot_runs_cloud_queue ON bot_runs(created_at) WHERE executor = 'cloud' AND status = 'queued';

CREATE TABLE bot_messages (
  message_id uuid PRIMARY KEY,
  bot_id uuid NOT NULL REFERENCES bots(bot_id) ON DELETE CASCADE,
  run_id uuid REFERENCES bot_runs(run_id) ON DELETE SET NULL,
  seq bigint NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('completed', 'running', 'failed', 'cancelled')),
  executor text CHECK (executor IN ('mac', 'cloud')),
  tools jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bot_id, seq)
);

CREATE TABLE bot_memories (
  bot_id uuid PRIMARY KEY REFERENCES bots(bot_id) ON DELETE CASCADE,
  summary text NOT NULL DEFAULT '',
  through_seq bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE approvals (
  approval_id uuid PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES bot_runs(run_id) ON DELETE CASCADE,
  bot_id uuid NOT NULL REFERENCES bots(bot_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('outside_access')),
  detail jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);
CREATE INDEX approvals_run ON approvals(run_id);

CREATE TABLE usage_logs (
  usage_id bigserial PRIMARY KEY,
  user_id uuid REFERENCES users(user_id) ON DELETE SET NULL,
  bot_id uuid REFERENCES bots(bot_id) ON DELETE SET NULL,
  model_id uuid REFERENCES models(model_id) ON DELETE SET NULL,
  source text NOT NULL CHECK (source IN ('mac', 'cloud', 'memory', 'test')),
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_logs_time ON usage_logs(created_at);
