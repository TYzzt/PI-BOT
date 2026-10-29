CREATE TABLE push_installations (
  installation_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  fcm_token text NOT NULL UNIQUE,
  binding_id uuid NOT NULL,
  session_expires_at timestamptz NOT NULL,
  session_issued_at bigint NOT NULL,
  disabled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX push_installations_user ON push_installations(user_id);

-- A delivery captures a binding, never follows an installation into a new login.
CREATE TABLE push_deliveries (
  event_id text NOT NULL,
  installation_id uuid NOT NULL REFERENCES push_installations(installation_id) ON DELETE CASCADE,
  binding_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  bot_id uuid NOT NULL REFERENCES bots(bot_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('message','approval')),
  source_id uuid NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_id uuid,
  lease_until timestamptz,
  finished_at timestamptz,
  outcome text,
  PRIMARY KEY(event_id, installation_id)
);
CREATE INDEX push_deliveries_pending ON push_deliveries(available_at) WHERE finished_at IS NULL;
