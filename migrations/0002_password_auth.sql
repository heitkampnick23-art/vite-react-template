-- Add password_hash for email+password auth.
ALTER TABLE users ADD COLUMN password_hash TEXT;
