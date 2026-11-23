CREATE TABLE image_generation_config (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled boolean NOT NULL DEFAULT false,
  base_url text NOT NULL DEFAULT '',
  models jsonb NOT NULL DEFAULT '["grok-imagine-image-2.0","gpt-image-2.6-sunburst","gemini-3.1-flash-image"]',
  default_model text NOT NULL DEFAULT 'gpt-image-2.6-sunburst',
  secret jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO image_generation_config(singleton) VALUES (true);

-- A durable reservation precedes the external call, including across API restarts.
CREATE TABLE image_generation_jobs (
  run_id uuid NOT NULL REFERENCES bot_runs(run_id) ON DELETE CASCADE,
  call_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  request_hash text NOT NULL,
  model text NOT NULL,
  status text NOT NULL CHECK (status IN ('accepted','completed','unknown')),
  artifact_id uuid REFERENCES report_artifacts(artifact_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id,call_id)
);
CREATE INDEX image_generation_jobs_active ON image_generation_jobs(user_id,created_at) WHERE status='accepted';
