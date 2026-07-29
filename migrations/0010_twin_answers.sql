-- Handoff table for asynchronous call turns: /voice/respond computes the
-- reply in the background and stores it here; /voice/answer picks it up
-- after the filler line plays. Rows are pruned after 10 minutes.
CREATE TABLE IF NOT EXISTS twin_answers (
	id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL
);
