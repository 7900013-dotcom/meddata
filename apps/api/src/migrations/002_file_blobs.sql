-- Encrypted file bodies, used when STORAGE_BACKEND=db (hosts without a persistent disk).
CREATE TABLE file_blobs (
  key text PRIMARY KEY,
  body bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
