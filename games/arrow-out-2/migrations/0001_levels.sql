CREATE TABLE levels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seed TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  payload TEXT NOT NULL
);

CREATE TABLE current_level (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  level_id INTEGER NOT NULL REFERENCES levels(id)
);
