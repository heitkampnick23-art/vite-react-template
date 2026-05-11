// Cloudflare Workers AI wrapper — cheap fallback model for free tier.

import { debit } from "../tokens";
import type { DB } from "../db";

export async function completeWorkersAI(args: {
	env: Env;
	db: DB;
	userId: string;
	projectId?: string | null;
	system?: string;
	prompt: string;
	requestId: string;
}) {
	const ai = args.env.AI as unknown as {
		run: (
			model: string,
			input: { messages: { role: string; content: string }[] },
		) => Promise<{ response: string }>;
	};
	const res = await ai.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
		messages: [
			...(args.system ? [{ role: "system", content: args.system }] : []),
			{ role: "user", content: args.prompt },
		],
	});
	const text = res.response;
	const promptTokens = Math.ceil((args.system?.length ?? 0 + args.prompt.length) / 4);
	const completionTokens = Math.ceil(text.length / 4);
	await debit(args.db, {
		userId: args.userId,
		projectId: args.projectId,
		model: "workers-ai-llama",
		promptTokens,
		completionTokens,
		requestId: args.requestId,
	});
	return { text, promptTokens, completionTokens };
}
