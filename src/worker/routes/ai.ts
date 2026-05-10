// /ai — chat builder endpoint. SSE streams Claude responses through tokenGuard.

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { nanoid } from "nanoid";
import { requireUser, type AppEnv } from "../middleware/auth";
import { tokenGuard } from "../middleware/tokens";
import { streamClaude } from "../lib/ai/anthropic";
import { MODELS } from "../lib/pricing";
import type { AiModelId } from "../../shared/types";

const ai = new Hono<AppEnv>();

ai.use("*", requireUser);

ai.get("/models", (c) => {
	const u = c.get("user");
	const planRank = { free: 0, pro: 1, team: 1, enterprise: 2 } as const;
	const items = (Object.keys(MODELS) as AiModelId[]).map((id) => {
		const m = MODELS[id];
		return {
			id,
			displayName: m.displayName,
			provider: m.provider,
			contextWindow: m.contextWindow,
			requiredPlan: m.requiredPlan,
			available: planRank[u.plan] >= planRank[m.requiredPlan],
		};
	});
	return c.json({ models: items });
});

const chatSchema = z.object({
	projectId: z.string().optional(),
	model: z.string().default("claude-sonnet-4-6"),
	messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })).min(1),
	system: z.string().optional(),
	maxTokens: z.number().int().min(64).max(8192).default(4096),
});

ai.post(
	"/chat",
	zValidator("json", chatSchema),
	tokenGuard(async (c) => {
		const body = chatSchema.parse(await c.req.json());
		const promptText = body.messages.map((m) => m.content).join("\n");
		return {
			model: body.model as AiModelId,
			promptTokens: Math.ceil(promptText.length / 4),
			maxOutputTokens: body.maxTokens,
		};
	}),
	async (c) => {
		const u = c.get("user");
		const body = c.req.valid("json");
		const requestId = nanoid();
		const stream = await streamClaude({
			env: c.env,
			db: c.env.DB,
			userId: u.id,
			projectId: body.projectId ?? null,
			model: body.model as AiModelId,
			system: body.system ?? defaultSystem(),
			messages: body.messages,
			maxTokens: body.maxTokens,
			requestId,
		});
		return new Response(stream, {
			headers: {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				"x-request-id": requestId,
			},
		});
	},
);

function defaultSystem() {
	return [
		"You are the Generate AI app-builder assistant.",
		"You help users build web applications by writing code, explaining concepts, and proposing file changes.",
		"When you propose a file change, output a fenced code block with ```language and the file path on the opening line: ```ts:src/foo.ts",
		"Be concise and pragmatic. Prefer editing existing files over creating new ones.",
	].join(" ");
}

export default ai;
