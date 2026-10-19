DROP INDEX devices_one_active;
ALTER TABLE devices ADD COLUMN platform text NOT NULL DEFAULT 'darwin' CHECK (platform IN ('darwin','linux'));
CREATE INDEX devices_user_active ON devices(user_id) WHERE revoked_at IS NULL;
ALTER TABLE bots ADD COLUMN execution_device_id uuid REFERENCES devices(device_id);
UPDATE bots b SET execution_device_id=d.device_id FROM devices d WHERE b.user_id=d.user_id AND d.revoked_at IS NULL;
CREATE INDEX bots_execution_device ON bots(execution_device_id);

ALTER TABLE bot_runs DROP CONSTRAINT bot_runs_executor_check;
ALTER TABLE bot_messages DROP CONSTRAINT bot_messages_executor_check;
ALTER TABLE usage_logs DROP CONSTRAINT usage_logs_source_check;
ALTER TABLE bot_runs DROP CONSTRAINT bot_runs_execution_policy_check;
ALTER TABLE bot_automations DROP CONSTRAINT bot_automations_status_check;
UPDATE bot_runs SET executor='device' WHERE executor='mac';
UPDATE bot_messages SET executor='device' WHERE executor='mac';
UPDATE usage_logs SET source='device' WHERE source='mac';
UPDATE bot_runs SET execution_policy='device_only' WHERE execution_policy='mac_only';
UPDATE bot_automations SET status='waiting_device' WHERE status='waiting_mac';
ALTER TABLE bot_runs ADD CONSTRAINT bot_runs_executor_check CHECK (executor IN ('device','cloud'));
ALTER TABLE bot_messages ADD CONSTRAINT bot_messages_executor_check CHECK (executor IN ('device','cloud'));
ALTER TABLE usage_logs ADD CONSTRAINT usage_logs_source_check CHECK (source IN ('device','cloud','memory','test'));
ALTER TABLE bot_runs ADD CONSTRAINT bot_runs_execution_policy_check CHECK (execution_policy IN ('any','device_only'));
ALTER TABLE bot_automations ADD CONSTRAINT bot_automations_status_check CHECK (status IN ('enabled','paused','waiting_device','waiting_user','completed','stopped'));
DROP INDEX bot_automations_due;
CREATE INDEX bot_automations_due ON bot_automations(next_wake_at) WHERE status IN ('enabled','waiting_device');
ALTER TABLE agent_tasks ADD COLUMN execution text NOT NULL DEFAULT 'device' CHECK (execution IN ('device','cloud'));
ALTER TABLE agent_tasks ADD COLUMN device_id uuid REFERENCES devices(device_id);
UPDATE agent_tasks t SET execution=CASE WHEN r.executor='cloud' THEN 'cloud' ELSE 'device' END,
  device_id=coalesce(r.device_id,b.execution_device_id)
FROM bots b LEFT JOIN bot_runs r ON r.bot_id=b.bot_id
WHERE t.target_bot_id=b.bot_id AND t.child_run_id=r.run_id;
UPDATE agent_tasks t SET device_id=b.execution_device_id,
  execution=CASE WHEN b.execution_device_id IS NULL THEN 'cloud' ELSE 'device' END FROM bots b
WHERE t.target_bot_id=b.bot_id AND t.child_run_id IS NULL;
