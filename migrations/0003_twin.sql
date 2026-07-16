-- Phone-twin configuration (Twilio + ElevenLabs credentials, persona).
-- Secret values are AES-GCM encrypted with SECRETS_MASTER_KEY (iv set); plain values have iv NULL.
CREATE TABLE IF NOT EXISTS twin_config (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL,
	iv TEXT,
	updated_at INTEGER NOT NULL
);
