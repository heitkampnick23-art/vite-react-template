-- Extra twins: each with its own phone number, name, persona, and optional
-- voice. Inbound calls/texts route to the matching twin by number; the
-- primary twin (twin_config) stays the default.
CREATE TABLE IF NOT EXISTS twin_profiles (
	id TEXT PRIMARY KEY, name TEXT NOT NULL, persona TEXT NOT NULL,
	number TEXT UNIQUE, voice_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
