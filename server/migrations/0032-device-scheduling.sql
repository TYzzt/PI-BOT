ALTER TABLE devices ADD COLUMN concurrency_limit integer NOT NULL DEFAULT 4 CHECK (concurrency_limit BETWEEN 1 AND 32);
ALTER TABLE bot_runs ADD COLUMN queue_reason text;
ALTER TABLE bot_runs ADD COLUMN dispatched_at timestamptz;
ALTER TABLE bot_runs ADD COLUMN device_received_at timestamptz;
ALTER TABLE bot_runs ADD COLUMN first_tool_started_at timestamptz;
ALTER TABLE bot_runs ADD COLUMN resource_waits jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX bot_runs_active_device ON bot_runs (device_id)
  WHERE executor='device' AND status IN ('running','waiting_approval') AND waiting_on_task_id IS NULL;
