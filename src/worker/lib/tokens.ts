// Token accounting: atomic debit, ledger writes, monthly grants.
// This is the ONLY place that mutates users.token_balance. Every AI provider wrapper goes through this.

import { nanoid } from "nanoid";
import type { DB } from "./db";
import type { AiModelId } from "../../shared/types";
import { costInCredits, microUsdCost } from "./pricing";

export async function getBalance(db: DB, userId: string): Promise<number> {
	const row = await db
		.prepare("SELECT token_balance FROM users WHERE id = ?")
		.bind(userId)
		.first<{ token_balance: number }>();
	return row?.token_balance ?? 0;
}

// Atomic debit; returns true if successful, false if insufficient.
export async function debit(
	db: DB,
	args: {
		userId: string;
		projectId?: string | null;
		model: AiModelId;
		promptTokens: number;
		completionTokens: number;
		requestId: string;
		reason?: string;
	},
): Promise<boolean> {
	const credits = costInCredits(args.model, args.promptTokens, args.completionTokens);
	const microUsd = microUsdCost(args.model, args.promptTokens, args.completionTokens);
	const t = Date.now();

	// Atomic guard: only debit if balance >= credits.
	const res = await db
		.prepare(
			"UPDATE users SET token_balance = token_balance - ?, updated_at = ? WHERE id = ? AND token_balance >= ?",
		)
		.bind(credits, t, args.userId, credits)
		.run();

	if (!res.success || res.meta.changes === 0) return false;

	await db.batch([
		db
			.prepare(
				"INSERT INTO token_ledger (id, user_id, project_id, delta, reason, model, request_id, created_at) VALUES (?,?,?,?,?,?,?,?)",
			)
			.bind(
				nanoid(),
				args.userId,
				args.projectId ?? null,
				-credits,
				args.reason ?? "ai_call",
				args.model,
				args.requestId,
				t,
			),
		db
			.prepare(
				"INSERT OR IGNORE INTO token_usage (id, user_id, project_id, model, prompt_tokens, completion_tokens, cost_micro_usd, tokens_charged, request_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
			)
			.bind(
				nanoid(),
				args.userId,
				args.projectId ?? null,
				args.model,
				args.promptTokens,
				args.completionTokens,
				microUsd,
				credits,
				args.requestId,
				t,
			),
	]);
	return true;
}

export async function credit(
	db: DB,
	args: { userId: string; amount: number; reason: string; requestId?: string },
) {
	const t = Date.now();
	await db.batch([
		db
			.prepare(
				"UPDATE users SET token_balance = token_balance + ?, updated_at = ? WHERE id = ?",
			)
			.bind(args.amount, t, args.userId),
		db
			.prepare(
				"INSERT INTO token_ledger (id, user_id, project_id, delta, reason, model, request_id, created_at) VALUES (?,?,?,?,?,?,?,?)",
			)
			.bind(nanoid(), args.userId, null, args.amount, args.reason, null, args.requestId ?? null, t),
	]);
}
