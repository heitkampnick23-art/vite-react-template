-- Contacts for smart texting ("tell Jake I'll be there at 6") and a log of
-- real SMS conversations through the twin's number (owner control traffic is
-- not logged).
CREATE TABLE IF NOT EXISTS twin_contacts (
	id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, phone TEXT NOT NULL,
	notes TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS twin_texts (
	id TEXT PRIMARY KEY, direction TEXT NOT NULL, peer_number TEXT NOT NULL,
	body TEXT NOT NULL, created_at INTEGER NOT NULL
);
