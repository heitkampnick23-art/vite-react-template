-- Caller memory: one row per phone number with a rolling Claude-written
-- summary of past call transcripts, so the twin greets repeat callers with
-- context.
CREATE TABLE IF NOT EXISTS twin_callers (
	phone TEXT PRIMARY KEY, name TEXT, summary TEXT NOT NULL DEFAULT '',
	call_count INTEGER NOT NULL DEFAULT 0, last_call_at INTEGER,
	summarized_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
);
