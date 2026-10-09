CREATE TABLE IF NOT EXISTS roster_vault (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  salt TEXT NOT NULL,
  iv TEXT,
  ciphertext TEXT,
  updated_at TEXT
);
