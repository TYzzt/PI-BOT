ALTER TABLE bot_memories ADD COLUMN lease_owner uuid;
ALTER TABLE bot_memories ADD COLUMN lease_until timestamptz;
ALTER TABLE bot_memories ADD COLUMN retry_after timestamptz NOT NULL DEFAULT now();
ALTER TABLE bot_memories ADD COLUMN failures integer NOT NULL DEFAULT 0;
ALTER TABLE bot_memories ADD COLUMN learned_seq bigint NOT NULL DEFAULT 0;
ALTER TABLE bot_memories ADD COLUMN learn_retry_after timestamptz NOT NULL DEFAULT now();
ALTER TABLE bot_memories ADD COLUMN learn_lease_until timestamptz;
ALTER TABLE bot_memories ADD COLUMN learn_lease_owner uuid;
ALTER TABLE bots ADD COLUMN knowledge_topics text[] NOT NULL DEFAULT '{}';
ALTER TABLE bots ADD COLUMN knowledge_updated_at timestamptz;
ALTER TABLE bots ADD COLUMN knowledge_dirty boolean NOT NULL DEFAULT false;
ALTER TABLE bots ADD COLUMN knowledge_revision bigint NOT NULL DEFAULT 0;

CREATE TABLE memory_entries (
  memory_id uuid PRIMARY KEY,
  bot_id uuid NOT NULL REFERENCES bots(bot_id) ON DELETE CASCADE,
  memory_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('fact','conclusion')),
  content text NOT NULL,
  certainty text NOT NULL CHECK (certainty IN ('explicit','inference')),
  source_message_id uuid REFERENCES bot_messages(message_id) ON DELETE SET NULL,
  source_task_id uuid REFERENCES agent_tasks(task_id) ON DELETE SET NULL,
  source_run_id uuid REFERENCES bot_runs(run_id) ON DELETE SET NULL,
  revision integer NOT NULL DEFAULT 1,
  deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(bot_id,memory_key)
);
CREATE INDEX memory_entries_bot ON memory_entries(bot_id,updated_at DESC);
ALTER TABLE agent_tasks ADD COLUMN checkpoint jsonb NOT NULL DEFAULT '{}';
ALTER TABLE agent_tasks ADD COLUMN checkpoint_version integer NOT NULL DEFAULT 0;
ALTER TABLE agent_tasks ADD COLUMN resumed_from uuid REFERENCES agent_tasks(task_id) ON DELETE SET NULL;
ALTER TABLE bot_runs ADD COLUMN trace_id uuid;
ALTER TABLE bot_runs ADD COLUMN observation_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE bot_runs ADD COLUMN parent_run_id uuid REFERENCES bot_runs(run_id) ON DELETE SET NULL;
UPDATE bot_runs SET trace_id=run_id;
ALTER TABLE bot_runs ALTER COLUMN trace_id SET NOT NULL;

CREATE TABLE observation_outbox (
  event_id uuid PRIMARY KEY,
  payload jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours'
);
CREATE INDEX observation_outbox_ready ON observation_outbox(next_attempt_at);
CREATE TABLE observation_tool_receipts (
  run_id uuid NOT NULL REFERENCES bot_runs(run_id) ON DELETE CASCADE,
  tool_call_id text NOT NULL,
  terminal boolean NOT NULL DEFAULT false,
  payload jsonb NOT NULL,
  PRIMARY KEY(run_id,tool_call_id)
);
