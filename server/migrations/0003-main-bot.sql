ALTER TABLE bots ADD COLUMN is_main boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX bots_main_per_user ON bots(user_id) WHERE is_main;
