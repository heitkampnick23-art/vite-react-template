-- Call transcripts for the phone twin.
CREATE TABLE IF NOT EXISTS twin_calls (
	id TEXT PRIMARY KEY, from_number TEXT, transcript TEXT NOT NULL,
	started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
