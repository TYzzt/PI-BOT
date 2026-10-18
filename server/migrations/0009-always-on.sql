CREATE TABLE bot_automations (
  automation_id uuid PRIMARY KEY,
  bot_id uuid NOT NULL REFERENCES bots(bot_id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('patrol','commission')),
  title text NOT NULL,
  goal text NOT NULL,
  authorization_scope text NOT NULL DEFAULT '',
  source_run_id uuid REFERENCES bot_runs(run_id) ON DELETE SET NULL,
  request_id text,
  schedule jsonb NOT NULL DEFAULT '{"type":"adaptive"}',
  timezone text NOT NULL DEFAULT 'Asia/Shanghai',
  dependency_task_id uuid REFERENCES agent_tasks(task_id) ON DELETE SET NULL,
  dependency_seen_at timestamptz,
  status text NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled','paused','waiting_mac','waiting_user','completed','stopped')),
  next_wake_at timestamptz,
  event_wake_at timestamptz,
  checkpoint jsonb NOT NULL DEFAULT '{}',
  checkpoint_version integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1,
  wake_generation bigint NOT NULL DEFAULT 0,
  idle_count integer NOT NULL DEFAULT 0,
  failures integer NOT NULL DEFAULT 0,
  last_result text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_run_id,request_id)
);
CREATE UNIQUE INDEX bot_automations_patrol ON bot_automations(bot_id) WHERE kind='patrol';
CREATE INDEX bot_automations_due ON bot_automations(next_wake_at) WHERE status IN ('enabled','waiting_mac');

ALTER TABLE bot_runs DROP CONSTRAINT bot_runs_origin_check;
ALTER TABLE bot_runs ADD CONSTRAINT bot_runs_origin_check CHECK (origin IN ('user','agent','report','automation'));
ALTER TABLE bot_runs ADD COLUMN automation_id uuid REFERENCES bot_automations(automation_id) ON DELETE SET NULL;
ALTER TABLE bot_runs ADD COLUMN execution_policy text NOT NULL DEFAULT 'any' CHECK (execution_policy IN ('any','mac_only'));
ALTER TABLE bot_runs ADD COLUMN automation_readonly boolean NOT NULL DEFAULT false;
ALTER TABLE bot_runs ADD COLUMN automation_calls integer NOT NULL DEFAULT 0;
ALTER TABLE bot_runs ADD COLUMN effect_pending boolean NOT NULL DEFAULT false;
ALTER TABLE bot_runs ADD COLUMN deadline_at timestamptz;

CREATE TABLE automation_rounds (
  round_id uuid PRIMARY KEY,
  automation_id uuid NOT NULL REFERENCES bot_automations(automation_id) ON DELETE CASCADE,
  run_id uuid NOT NULL UNIQUE REFERENCES bot_runs(run_id) ON DELETE CASCADE,
  version integer NOT NULL,
  wake_key text NOT NULL,
  decision jsonb,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','failed','cancelled')),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE(automation_id,wake_key)
);
CREATE UNIQUE INDEX automation_rounds_active ON automation_rounds(automation_id) WHERE status='active';

-- Write-ahead tool journal: disconnection cannot erase an operation that may have happened.
CREATE TABLE automation_effects (
  run_id uuid NOT NULL REFERENCES bot_runs(run_id) ON DELETE CASCADE,
  tool_call_id text NOT NULL,
  tool_name text NOT NULL DEFAULT 'unknown',
  summary text NOT NULL DEFAULT '',
  result text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','uncertain')),
  PRIMARY KEY(run_id,tool_call_id)
);

CREATE TABLE automation_reports (
  report_id uuid PRIMARY KEY,
  automation_id uuid NOT NULL REFERENCES bot_automations(automation_id) ON DELETE CASCADE,
  round_id uuid REFERENCES automation_rounds(round_id) ON DELETE SET NULL,
  version integer NOT NULL,
  event_key text NOT NULL,
  category text NOT NULL,
  content text NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  report_run_id uuid REFERENCES bot_runs(run_id) ON DELETE SET NULL,
  delivered_at timestamptz,
  discarded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(automation_id,event_key)
);
CREATE INDEX automation_reports_pending ON automation_reports(available_at) WHERE delivered_at IS NULL AND discarded_at IS NULL;

-- Existing Bots get the same default as newly created Bots. No model call is made by migration.
INSERT INTO bot_automations(automation_id,bot_id,user_id,kind,title,goal,next_wake_at)
SELECT gen_random_uuid(),bot_id,user_id,'patrol','自主巡检',
  '检查自己的历史、记忆、资料库和已有授权的未完成工作，整理值得关注的发现；新目标先提出建议，无重要变化保持静默。',now()+interval '1 hour'
FROM bots WHERE archived_at IS NULL;
