CREATE TABLE agent_tasks (
  task_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  parent_run_id uuid NOT NULL REFERENCES bot_runs(run_id) ON DELETE CASCADE,
  parent_bot_id uuid NOT NULL REFERENCES bots(bot_id) ON DELETE CASCADE,
  target_bot_id uuid NOT NULL REFERENCES bots(bot_id) ON DELETE CASCADE,
  child_run_id uuid REFERENCES bot_runs(run_id) ON DELETE SET NULL,
  mode text NOT NULL CHECK (mode IN ('wait', 'report')),
  depth integer NOT NULL CHECK (depth >= 1),
  task text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  result text,
  error text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX agent_tasks_parent_run ON agent_tasks(parent_run_id);
CREATE INDEX agent_tasks_queued ON agent_tasks(target_bot_id, created_at) WHERE status = 'queued';
-- Finished hand-offs whose result has not yet been reported back to the delegating bot.
CREATE INDEX agent_tasks_undelivered ON agent_tasks(parent_bot_id, finished_at)
  WHERE mode = 'report' AND delivered_at IS NULL AND status IN ('completed', 'failed', 'cancelled');

ALTER TABLE bot_runs ADD COLUMN origin text NOT NULL DEFAULT 'user' CHECK (origin IN ('user', 'agent', 'report'));
ALTER TABLE bot_runs ADD COLUMN task_id uuid REFERENCES agent_tasks(task_id) ON DELETE SET NULL;
ALTER TABLE bot_messages ADD COLUMN from_bot_id uuid REFERENCES bots(bot_id) ON DELETE SET NULL;
