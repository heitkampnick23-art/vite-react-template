// Token pricing & plan definitions.
// All amounts are platform "credits" — 1 credit = 1 model-token (input or output, weighted by markup).
// Provider cost in micro-USD (1e-6 USD) is tracked separately for analytics.

import type { AiModelId, Plan } from "../../shared/types";

export const PLATFORM_MARKUP = 1.4; // 40% markup over provider cost.

type Price = {
	provider: "anthropic" | "openai" | "google" | "workers-ai";
	// micro-USD per 1k tokens.
	input: number;
	output: number;
	displayName: string;
	contextWindow: number;
	requiredPlan: Plan;
};

export const MODELS: Record<AiModelId, Price> = {
	"claude-sonnet-4-6": {
		provider: "anthropic",
		input: 3000,
		output: 15000,
		displayName: "Claude Sonnet 4.6",
		contextWindow: 200_000,
		requiredPlan: "free",
	},
	"claude-opus-4-7": {
		provider: "anthropic",
		input: 15000,
		output: 75000,
		displayName: "Claude Opus 4.7",
		contextWindow: 200_000,
		requiredPlan: "pro",
	},
	"claude-haiku-4-5": {
		provider: "anthropic",
		input: 800,
		output: 4000,
		displayName: "Claude Haiku 4.5",
		contextWindow: 200_000,
		requiredPlan: "free",
	},
	"gpt-4o": {
		provider: "openai",
		input: 2500,
		output: 10000,
		displayName: "GPT-4o",
		contextWindow: 128_000,
		requiredPlan: "pro",
	},
	"gpt-4o-mini": {
		provider: "openai",
		input: 150,
		output: 600,
		displayName: "GPT-4o mini",
		contextWindow: 128_000,
		requiredPlan: "free",
	},
	"gemini-1.5-pro": {
		provider: "google",
		input: 1250,
		output: 5000,
		displayName: "Gemini 1.5 Pro",
		contextWindow: 1_000_000,
		requiredPlan: "pro",
	},
	"workers-ai-llama": {
		provider: "workers-ai",
		input: 100,
		output: 200,
		displayName: "Llama 3.3 (Workers AI)",
		contextWindow: 32_000,
		requiredPlan: "free",
	},
};

// Cost in credits (= weighted tokens) for a single AI call.
// We charge prompt + output tokens but apply a per-model weight derived from price + markup.
export function costInCredits(
	model: AiModelId,
	promptTokens: number,
	completionTokens: number,
): number {
	const p = MODELS[model];
	const microUsd = (p.input * promptTokens + p.output * completionTokens) / 1000;
	// 1 credit = 0.5 micro-USD provider cost (i.e. 1 USD = 2M credits at-cost). Markup applied.
	const credits = Math.ceil((microUsd / 0.5) * PLATFORM_MARKUP);
	return credits;
}

export function microUsdCost(
	model: AiModelId,
	promptTokens: number,
	completionTokens: number,
): number {
	const p = MODELS[model];
	return Math.ceil((p.input * promptTokens + p.output * completionTokens) / 1000);
}

// Conservative pre-call estimate (used by tokenGuard before the actual call).
export function estimateCredits(
	model: AiModelId,
	promptTokens: number,
	maxOutputTokens: number,
): number {
	return costInCredits(model, promptTokens, maxOutputTokens);
}

export const PLANS: Record<Plan, {
	displayName: string;
	monthlyCredits: number;
	priceCents: number;
	stripePriceId: string | null;
	features: string[];
	councilEnabled: boolean;
	seats: number;
}> = {
	free: {
		displayName: "Free",
		monthlyCredits: 100_000,
		priceCents: 0,
		stripePriceId: null,
		features: [
			"100k credits / month",
			"3 active projects",
			"Claude Haiku & GPT-4o-mini",
			"Community templates",
			"Public deployments",
		],
		councilEnabled: false,
		seats: 1,
	},
	pro: {
		displayName: "Pro",
		monthlyCredits: 2_000_000,
		priceCents: 2000,
		stripePriceId: "price_1TVvlBQu1YpWmfU0T0BJoAwR",
		features: [
			"2M credits / month",
			"Unlimited projects",
			"All models (Claude Opus, GPT-4o, Gemini Pro)",
			"AI Council deliberation mode",
			"Private deployments + custom domains",
			"Self-Healing Apps",
			"GitHub two-way sync",
		],
		councilEnabled: true,
		seats: 1,
	},
	team: {
		displayName: "Team",
		monthlyCredits: 3_000_000,
		priceCents: 6000,
		stripePriceId: "price_1TVxDdQu1YpWmfU0a22w2Enk",
		features: [
			"3M credits / seat / month",
			"Everything in Pro",
			"Real-time collaboration",
			"Team workspaces & roles",
			"Shared secrets vault",
			"Priority support",
		],
		councilEnabled: true,
		seats: 1, // multiplied per-subscription
	},
	enterprise: {
		displayName: "Enterprise",
		monthlyCredits: 50_000_000,
		priceCents: 0, // manual billing
		stripePriceId: null,
		features: [
			"Unlimited credits (custom pool)",
			"SSO / SAML",
			"Audit logs & DPA",
			"Dedicated support",
			"Region pinning",
			"On-prem sandbox option",
		],
		councilEnabled: true,
		seats: 999,
	},
};

export const TOPUPS = [
	{ id: "topup_small", credits: 500_000, priceCents: 500, stripePriceId: "price_1TVxDjQu1YpWmfU0Ql70D49u" },
	{ id: "topup_medium", credits: 2_500_000, priceCents: 2000, stripePriceId: "price_1TVxDpQu1YpWmfU0mB8vNG2G" },
	{ id: "topup_large", credits: 10_000_000, priceCents: 7500, stripePriceId: "price_1TVxDvQu1YpWmfU048XouhTe" },
];
