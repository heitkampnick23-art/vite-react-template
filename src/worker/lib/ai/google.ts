// Google Gemini wrapper — used by Council Security role.

import { GoogleGenerativeAI } from "@google/generative-ai";
import type { AiModelId } from "../../../shared/types";
import { debit } from "../tokens";
import type { DB } from "../db";

export async function completeGemini(args: {
	env: Env;
	db: DB;
	userId: string;
	projectId?: string | null;
	model: AiModelId;
	system?: string;
	prompt: string;
	maxTokens?: number;
	requestId: string;
}) {
	const client = new GoogleGenerativeAI(args.env.GOOGLE_AI_KEY);
	const m = client.getGenerativeModel({
		model: "gemini-1.5-pro-latest",
		systemInstruction: args.system,
		generationConfig: { maxOutputTokens: args.maxTokens ?? 2048 },
	});
	const resp = await m.generateContent(args.prompt);
	const text = resp.response.text();
	// Gemini token usage in resp.response.usageMetadata
	const usage = resp.response.usageMetadata;
	const promptTokens = usage?.promptTokenCount ?? Math.ceil(args.prompt.length / 4);
	const completionTokens = usage?.candidatesTokenCount ?? Math.ceil(text.length / 4);
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
