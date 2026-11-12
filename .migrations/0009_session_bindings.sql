CREATE TABLE session_bindings (
  session_key TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  item_kind TEXT NOT NULL,
  bound_at INTEGER NOT NULL,
  released_at INTEGER
);
--> statement-breakpoint
CREATE INDEX idx_session_bindings_item ON session_bindings (item_id);
