ALTER TABLE report_artifacts ALTER COLUMN run_id DROP NOT NULL;
CREATE TABLE document_uploads (
 upload_id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
 bot_id uuid NOT NULL REFERENCES bots(bot_id) ON DELETE CASCADE, name text NOT NULL,
 size integer NOT NULL CHECK(size>0 AND size<=10485760), artifact_id uuid REFERENCES report_artifacts(artifact_id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE document_chunks (
 upload_id uuid NOT NULL REFERENCES document_uploads(upload_id) ON DELETE CASCADE,
 part integer NOT NULL CHECK(part>=0 AND part<40), body bytea NOT NULL CHECK(octet_length(body)<=262144),
 PRIMARY KEY(upload_id,part)
);
