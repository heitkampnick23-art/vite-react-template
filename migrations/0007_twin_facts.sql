-- Owner-curated facts the twin injects into calls and texts so it can answer
-- real questions ("what's Nick's address for the party?").
CREATE TABLE IF NOT EXISTS twin_facts (
	id TEXT PRIMARY KEY, fact TEXT NOT NULL, created_at INTEGER NOT NULL
);
