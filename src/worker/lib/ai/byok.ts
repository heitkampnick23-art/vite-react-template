// Resolve a per-project API key for a given provider.
// If the project has a secret named e.g. ANTHROPIC_API_KEY, use it; otherwise return null
// and the caller falls back to the platform key in env.

import { decryptSecret } from "../crypto";

const SECRET_NAME: Record<string, string> = {
	anthropic: "ANTHROPIC_API_KEY",
	openai: "OPENAI_API_KEY",
	google: "GOOGLE_AI_KEY",
};

export async function resolveProviderKey(
	env: Env,
	projectId: string | null | undefined,
	provider: "anthropic" | "openai" | "google" | "workers-ai",
): Promise<string | undefined> {
	if (!projectId || provider === "workers-ai") return undefined;
	const name = SECRET_NAME[provider];
	if (!name) return undefined;
	const row = await env.DB
		.prepare("SELECT ciphertext, iv FROM secrets WHERE project_id = ? AND key = ?")
		.bind(projectId, name)
		.first<{ ciphertext: string; iv: string }>();
	if (!row) return undefined;
	try {
		return await decryptSecret(row.ciphertext, row.iv, env.SECRETS_MASTER_KEY);
	} catch {
		return undefined;
	}
}
