CREATE TABLE scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level_id INTEGER NOT NULL REFERENCES levels(id),
  name TEXT NOT NULL,
  time_ms INTEGER NOT NULL,
  lives_left INTEGER NOT NULL CHECK (lives_left BETWEEN 0 AND 3),
  ip_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX scores_level_rank ON scores (level_id, time_ms, lives_left);
