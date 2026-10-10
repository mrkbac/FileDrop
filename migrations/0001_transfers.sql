CREATE TABLE transfers (
  code TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);
CREATE INDEX transfers_owner ON transfers(owner, created_at);
CREATE TABLE files (
  id TEXT PRIMARY KEY,
  transfer_code TEXT NOT NULL REFERENCES transfers(code) ON DELETE CASCADE,
  name TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size BETWEEN 0 AND 100000000000),
  fingerprint TEXT NOT NULL,
  upload_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('uploading', 'complete', 'deleting')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (transfer_code, fingerprint)
);
CREATE INDEX files_transfer ON files(transfer_code);
CREATE TABLE parts (
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL,
  etag TEXT NOT NULL,
  PRIMARY KEY (file_id, part_number)
);
