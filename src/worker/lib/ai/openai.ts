// OpenAI wrapper — single-shot + SSE streaming.

import OpenAI from "openai";
import type { AiModelId } from "../../../shared/types";
import { debit } from "../tokens";
import type { DB } from "../db";

type Msg = { role: "system" | "user" | "assistant"; content: string };

const MODEL_MAP: Record<string, string> = {
	"gpt-4o": "gpt-4o",
	"gpt-4o-mini": "gpt-4o-mini",
};

export async function completeOpenAI(args: {
	env: Env;
	db: DB;
	userId: string;
	projectId?: string | null;
	model: AiModelId;
	messages: Msg[];
	maxTokens?: number;
	requestId: string;
	apiKey?: string;
}) {
	const client = new OpenAI({ apiKey: args.apiKey ?? args.env.OPENAI_API_KEY });
	const realModel = MODEL_MAP[args.model] ?? "gpt-4o-mini";
	const resp = await client.chat.completions.create({
		model: realModel,
		max_tokens: args.maxTokens ?? 2048,
		messages: args.messages,
	});
	const text = resp.choices[0]?.message?.content ?? "";
	const promptTokens = resp.usage?.prompt_tokens ?? 0;
	const completionTokens = resp.usage?.completion_tokens ?? 0;
	await debit(args.db, {
		userId: args.userId,
		projectId: args.projectId,
		model: args.model,
		promptTokens,
		completionTokens,
		requestId: args.requestId,
	});
	return { text, promptTokens, completionTokens };
}

export async function streamOpenAI(args: {
	env: Env;
	db: DB;
	userId: string;
	projectId?: string | null;
	model: AiModelId;
	system?: string;
	messages: Msg[];
	maxTokens?: number;
	requestId: string;
	apiKey?: string;
}): Promise<ReadableStream<Uint8Array>> {
	const client = new OpenAI({ apiKey: args.apiKey ?? args.env.OPENAI_API_KEY });
	const realModel = MODEL_MAP[args.model] ?? "gpt-4o-mini";
	const fullMessages: Msg[] = args.system
		? [{ role: "system", content: args.system }, ...args.messages]
		: args.messages;

	const stream = await client.chat.completions.create({
		model: realModel,
		max_tokens: args.maxTokens ?? 4096,
		messages: fullMessages,
		stream: true,
		stream_options: { include_usage: true },
	});

	const encoder = new TextEncoder();
	const db = args.db;
	let promptTokens = 0;
	let completionTokens = 0;

	return new ReadableStream({
		async start(controller) {
			try {
				for await (const chunk of stream) {
					const delta = chunk.choices[0]?.delta?.content;
					if (delta) {
						controller.enqueue(
							encoder.encode(`data: ${JSON.stringify({ type: "delta", text: delta })}\n\n`),
						);
					}
					if (chunk.usage) {
						promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
						completionTokens = chunk.usage.completion_tokens ?? completionTokens;
					}
				}
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
