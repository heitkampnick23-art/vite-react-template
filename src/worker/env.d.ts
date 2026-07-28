// Secrets are set via `wrangler secret put` — not declared in wrangler.json.
// Augment the auto-generated Env type so TypeScript sees them.

declare namespace Cloudflare {
	interface Env {
		JWT_SECRET: string;
		SECRETS_MASTER_KEY: string;
		ANTHROPIC_API_KEY: string;
		OPENAI_API_KEY: string;
		GOOGLE_AI_KEY: string;
		RESEND_KEY: string;
		GITHUB_CLIENT_ID: string;
		GITHUB_CLIENT_SECRET: string;
		GOOGLE_OAUTH_ID: string;
		GOOGLE_OAUTH_SECRET: string;
		STRIPE_SECRET: string;
		STRIPE_WEBHOOK_SECRET: string;
		OWNER_EMAIL: string;
		// Desired local area code for auto-provisioning the twin's number.
		TWIN_BUY_AREA_CODE: string;
		// Comma-separated area codes, in preference order, for keeping one extra
		// number on the account for additional twins (e.g. "952,651,612").
		TWIN_EXTRA_AREA_CODES: string;
		// JSON array of twins to stand up automatically on deploy:
		// [{name, number, voiceQuery, persona}]. Skipped once the name exists.
		TWIN_SEED_PROFILES: string;
		// Twin voice playback speed (ElevenLabs range 0.7–1.2; default 1.12).
		TWIN_VOICE_SPEED: string;
		// Owner's preferred ElevenLabs voice id — used when synthesizable.
		TWIN_VOICE_ID: string;
		// Owner's cell for after-call SMS summaries (E.164).
		TWIN_NOTIFY_CELL: string;
		// Nightly digest: owner's IANA timezone (default America/Chicago) and the
		// local hour after which the digest may send (default 21).
		TWIN_TZ: string;
		TWIN_DIGEST_HOUR: string;
		// Phone-twin fallbacks — used only if not configured via the /twin page.
		TWILIO_ACCOUNT_SID: string;
		TWILIO_AUTH_TOKEN: string;
		TWILIO_NUMBER: string;
		ELEVENLABS_API_KEY: string;
		ELEVENLABS_VOICE_ID: string;
	}
}
