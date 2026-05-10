// tokenGuard — checks balance before AI calls, enforces hard cap at zero.
// Routes wrap this around any AI provider call. Actual debit happens inside the provider wrapper.

import type { MiddlewareHandler } from "hono";
import type { AiModelId } from "../../shared/types";
import { estimateCredits } from "../lib/pricing";
import { getBalance } from "../lib/tokens";
import { MODELS } from "../lib/pricing";
import type { AppEnv } from "./auth";

export type TokenEstimate = {
	model: AiModelId;
	promptTokens: number;
	maxOutputTokens: number;
};

export function tokenGuard(estimateFn: (c: Parameters<MiddlewareHandler<AppEnv>>[0]) => Promise<TokenEstimate>): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		const user = c.get("user");
		if (!user) return c.json({ error: "unauthorized" }, 401);
		const est = await estimateFn(c);

		// Plan gating: model availability.
		const planRank = { free: 0, pro: 1, team: 1, enterprise: 2 } as const;
		const required = MODELS[est.model]?.requiredPlan ?? "free";
		if (planRank[user.plan] < planRank[required]) {
			return c.json(
				{
					error: "plan_required",
					message: `Model ${est.model} requires the ${required} plan or higher.`,
					code: "UPGRADE_REQUIRED",
				},
				402,
			);
		}

		const credits = estimateCredits(est.model, est.promptTokens, est.maxOutputTokens);
		const balance = await getBalance(c.env.DB, user.id);
		if (balance < credits) {
			return c.json(
				{
					error: "insufficient_credits",
					message: `This request needs ~${credits} credits, you have ${balance}.`,
					estimate: credits,
					balance,
				},
				402,
			);
		}
		await next();
	};
}
