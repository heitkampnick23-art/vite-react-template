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
		// Phone-twin fallbacks — used only if not configured via the /twin page.
		TWILIO_ACCOUNT_SID: string;
		TWILIO_AUTH_TOKEN: string;
		TWILIO_NUMBER: string;
		ELEVENLABS_API_KEY: string;
		ELEVENLABS_VOICE_ID: string;
	}
}
