-- Per-twin speaking speed (ElevenLabs range 0.7–1.2; NULL = inherit the
-- global TWIN_VOICE_SPEED default).
ALTER TABLE twin_profiles ADD COLUMN voice_speed REAL;
