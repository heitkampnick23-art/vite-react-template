// /ai — chat builder endpoint. SSE streams responses through tokenGuard.
// Dispatches on MODELS[id].provider so Claude / OpenAI / Workers AI all share one client API.

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { nanoid } from "nanoid";
import { requireUser, type AppEnv } from "../middleware/auth";
import { tokenGuard } from "../middleware/tokens";
import { streamClaude } from "../lib/ai/anthropic";
import { streamOpenAI } from "../lib/ai/openai";
import { completeWorkersAI } from "../lib/ai/workersai";
import { resolveProviderKey } from "../lib/ai/byok";
import { MODELS } from "../lib/pricing";
import { debit } from "../lib/tokens";
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
		const modelId = body.model as AiModelId;
		const meta = MODELS[modelId];
		if (!meta) return c.json({ error: "unknown_model" }, 400);

		const apiKey = await resolveProviderKey(c.env, body.projectId, meta.provider);
		const sseHeaders = {
			"content-type": "text/event-stream",
			"cache-control": "no-cache",
			"x-request-id": requestId,
		};
		const system = body.system ?? defaultSystem();

		if (meta.provider === "anthropic") {
			const stream = await streamClaude({
				env: c.env,
				db: c.env.DB,
				userId: u.id,
				projectId: body.projectId ?? null,
				model: modelId,
				system,
				messages: body.messages,
				maxTokens: body.maxTokens,
				requestId,
				apiKey,
			});
			return new Response(stream, { headers: sseHeaders });
		}

		if (meta.provider === "openai") {
			const stream = await streamOpenAI({
				env: c.env,
				db: c.env.DB,
				userId: u.id,
				projectId: body.projectId ?? null,
				model: modelId,
				system,
				messages: body.messages,
				maxTokens: body.maxTokens,
				requestId,
				apiKey,
			});
			return new Response(stream, { headers: sseHeaders });
		}

		if (meta.provider === "workers-ai") {
			// Workers AI binding doesn't expose true SSE; fake-stream the completion in one chunk.
			const promptText = body.messages.map((m) => `${m.role}: ${m.content}`).join("\n");
			const result = await completeWorkersAI({
				env: c.env,
				db: c.env.DB,
				userId: u.id,
				projectId: body.projectId ?? null,
				system,
				prompt: promptText,
				requestId,
			});
			const enc = new TextEncoder();
			const stream = new ReadableStream({
				start(controller) {
					controller.enqueue(
						enc.encode(`data: ${JSON.stringify({ type: "delta", text: result.text })}\n\n`),
					);
					controller.enqueue(
						enc.encode(
							`data: ${JSON.stringify({
								type: "done",
								usage: { promptTokens: result.promptTokens, completionTokens: result.completionTokens },
								debited: true,
							})}\n\n`,
						),
					);
					controller.close();
				},
			});
			return new Response(stream, { headers: sseHeaders });
		}

		// Gemini falls through here — no streaming endpoint yet; refuse so we don't silently swap models.
		void debit; // (intentionally unused — kept for future Gemini streaming)
		return c.json({ error: "streaming_unsupported", message: `${meta.provider} streaming not yet implemented` }, 400);
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
