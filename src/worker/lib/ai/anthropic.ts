// Anthropic Claude wrapper. Streams via SSE, debits tokens on stream-close.
// Goes through tokenGuard — never call Anthropic directly from routes.

import Anthropic from "@anthropic-ai/sdk";
import type { AiModelId } from "../../../shared/types";
import { debit } from "../tokens";
import type { DB } from "../db";

type Msg = { role: "user" | "assistant"; content: string };

export async function streamClaude(args: {
	env: Env;
	db: DB;
	userId: string;
	projectId?: string | null;
	model: AiModelId;
	system?: string;
	messages: Msg[];
	maxTokens?: number;
	requestId: string;
}): Promise<ReadableStream<Uint8Array>> {
	const client = new Anthropic({ apiKey: args.env.ANTHROPIC_API_KEY });
	const modelMap: Record<string, string> = {
		"claude-sonnet-4-6": "claude-sonnet-4-6",
		"claude-opus-4-7": "claude-opus-4-7",
		"claude-haiku-4-5": "claude-haiku-4-5-20251001",
	};
	const realModel = modelMap[args.model] ?? "claude-sonnet-4-6";

	const stream = await client.messages.stream({
		model: realModel,
		max_tokens: args.maxTokens ?? 4096,
		system: args.system,
		messages: args.messages,
	});

	const encoder = new TextEncoder();
	let promptTokens = 0;
	let completionTokens = 0;
	const db = args.db;

	return new ReadableStream({
		async start(controller) {
			try {
				for await (const event of stream) {
					if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
						controller.enqueue(
							encoder.encode(
								`data: ${JSON.stringify({ type: "delta", text: event.delta.text })}\n\n`,
							),
						);
					} else if (event.type === "message_delta" && event.usage) {
						completionTokens = event.usage.output_tokens ?? completionTokens;
					} else if (event.type === "message_start" && event.message.usage) {
						promptTokens = event.message.usage.input_tokens;
					}
				}
				const final = await stream.finalMessage();
				promptTokens = final.usage.input_tokens;
				completionTokens = final.usage.output_tokens;

				const ok = await debit(db, {
					userId: args.userId,
					projectId: args.projectId,
					model: args.model,
					promptTokens,
					completionTokens,
					requestId: args.requestId,
				});
				controller.enqueue(
					encoder.encode(
						`data: ${JSON.stringify({
							type: "done",
							usage: { promptTokens, completionTokens },
							debited: ok,
						})}\n\n`,
					),
				);
				controller.close();
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				controller.enqueue(
					encoder.encode(`data: ${JSON.stringify({ type: "error", message: msg })}\n\n`),
				);
				controller.close();
			}
		},
	});
}

// Non-streaming variant for Council turns.
export async function completeClaude(args: {
	env: Env;
	db: DB;
	userId: string;
	projectId?: string | null;
	model: AiModelId;
	system?: string;
	messages: Msg[];
	maxTokens?: number;
	requestId: string;
}): Promise<{ text: string; promptTokens: number; completionTokens: number }> {
	const client = new Anthropic({ apiKey: args.env.ANTHROPIC_API_KEY });
	const modelMap: Record<string, string> = {
		"claude-sonnet-4-6": "claude-sonnet-4-6",
		"claude-opus-4-7": "claude-opus-4-7",
		"claude-haiku-4-5": "claude-haiku-4-5-20251001",
	};
	const realModel = modelMap[args.model] ?? "claude-sonnet-4-6";
	const resp = await client.messages.create({
		model: realModel,
		max_tokens: args.maxTokens ?? 2048,
		system: args.system,
		messages: args.messages,
	});
	const text = resp.content
		.filter((b) => b.type === "text")
		.map((b) => (b as { text: string }).text)
		.join("");
	await debit(args.db, {
		userId: args.userId,
		projectId: args.projectId,
		model: args.model,
		promptTokens: resp.usage.input_tokens,
		completionTokens: resp.usage.output_tokens,
		requestId: args.requestId,
	});
	return {
		text,
		promptTokens: resp.usage.input_tokens,
		completionTokens: resp.usage.output_tokens,
	};
}
