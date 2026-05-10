// OpenAI wrapper — single-shot completion used by Council Critic role.
// Streaming variant can be added similarly.

import OpenAI from "openai";
import type { AiModelId } from "../../../shared/types";
import { debit } from "../tokens";
import type { DB } from "../db";

type Msg = { role: "system" | "user" | "assistant"; content: string };

export async function completeOpenAI(args: {
	env: Env;
	db: DB;
	userId: string;
	projectId?: string | null;
	model: AiModelId;
	messages: Msg[];
	maxTokens?: number;
	requestId: string;
}) {
	const client = new OpenAI({ apiKey: args.env.OPENAI_API_KEY });
	const modelMap: Record<string, string> = {
		"gpt-4o": "gpt-4o",
		"gpt-4o-mini": "gpt-4o-mini",
	};
	const realModel = modelMap[args.model] ?? "gpt-4o-mini";
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
