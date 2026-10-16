CREATE TABLE bot_skills (
  skill_id uuid PRIMARY KEY,
  bot_id uuid NOT NULL REFERENCES bots(bot_id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL,
  instructions text NOT NULL,
  refs jsonb NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  deleted boolean NOT NULL DEFAULT false,
  version integer NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bot_id, name)
);
CREATE TABLE bot_skill_versions (
  skill_id uuid NOT NULL REFERENCES bot_skills(skill_id) ON DELETE CASCADE,
  version integer NOT NULL,
  description text NOT NULL,
  instructions text NOT NULL,
  refs jsonb NOT NULL,
  enabled boolean NOT NULL,
  deleted boolean NOT NULL,
  operation text NOT NULL,
  run_id uuid REFERENCES bot_runs(run_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, version)
);
