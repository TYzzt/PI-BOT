-- Conversation turns and background executions have independent capacity.
ALTER TABLE bot_runs ADD COLUMN lane text NOT NULL DEFAULT 'conversation'
  CHECK (lane IN ('conversation', 'task'));
UPDATE bot_runs SET lane='task' WHERE origin='agent';
ALTER TABLE bot_runs ADD COLUMN waiting_on_task_id uuid REFERENCES agent_tasks(task_id) ON DELETE SET NULL;
DROP INDEX bot_runs_one_active;
CREATE UNIQUE INDEX bot_runs_one_conversation ON bot_runs(bot_id)
  WHERE lane='conversation' AND status IN ('running', 'waiting_approval');

ALTER TABLE bot_messages ADD COLUMN visibility text NOT NULL DEFAULT 'public'
  CHECK (visibility IN ('public', 'task', 'internal'));
CREATE INDEX bot_messages_public ON bot_messages(bot_id, seq) WHERE visibility='public';

ALTER TABLE agent_tasks ADD COLUMN kind text NOT NULL DEFAULT 'delegation'
  CHECK (kind IN ('background', 'delegation'));
ALTER TABLE agent_tasks ADD COLUMN title text NOT NULL DEFAULT '';
ALTER TABLE agent_tasks ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE agent_tasks ADD COLUMN report_run_id uuid REFERENCES bot_runs(run_id) ON DELETE SET NULL;
ALTER TABLE agent_tasks ADD COLUMN request_id text;
ALTER TABLE agent_tasks DROP CONSTRAINT agent_tasks_depth_check;
ALTER TABLE agent_tasks ADD CONSTRAINT agent_tasks_depth_check CHECK (depth >= 0);
ALTER TABLE agent_tasks DROP CONSTRAINT agent_tasks_status_check;
ALTER TABLE agent_tasks ADD CONSTRAINT agent_tasks_status_check
  CHECK (status IN ('queued', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled'));
CREATE UNIQUE INDEX agent_tasks_request ON agent_tasks(parent_run_id, request_id) WHERE request_id IS NOT NULL;

CREATE TABLE agent_task_instructions (
  instruction_id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES agent_tasks(task_id) ON DELETE CASCADE,
  request_id text NOT NULL,
  text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  UNIQUE(task_id, request_id)
);
CREATE INDEX agent_task_instructions_pending ON agent_task_instructions(task_id, created_at)
  WHERE delivered_at IS NULL;
