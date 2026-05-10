// Shared types between worker and react-app.

export type Plan = "free" | "pro" | "team" | "enterprise";

export type UserPublic = {
	id: string;
	email: string;
	name: string | null;
	avatarUrl: string | null;
	plan: Plan;
	tokenBalance: number;
	role: "user" | "admin";
};

export type Project = {
	id: string;
	slug: string;
	name: string;
	description: string | null;
	template: string | null;
	visibility: "private" | "public";
	subdomain: string | null;
	framework: string | null;
	createdAt: number;
	updatedAt: number;
};

export type ProjectFile = {
	id: string;
	path: string;
	size: number;
	mime: string | null;
	updatedAt: number;
};

export type Deployment = {
	id: string;
	projectId: string;
	version: number;
	status: "queued" | "building" | "deploying" | "live" | "failed";
	url: string | null;
	error: string | null;
	createdAt: number;
	completedAt: number | null;
};

export type HealEvent = {
	id: string;
	deploymentId: string;
	projectId: string;
	errorSignature: string;
	fixDiff: string | null;
	status: "pending" | "approved" | "rejected" | "applied";
	createdAt: number;
};

export type AiModelId =
	| "claude-sonnet-4-6"
	| "claude-opus-4-7"
	| "claude-haiku-4-5"
	| "gpt-4o"
	| "gpt-4o-mini"
	| "gemini-1.5-pro"
	| "workers-ai-llama";

export type CouncilRole = "architect" | "critic" | "security";

export type CouncilTurn = {
	idx: number;
	role: CouncilRole;
	model: string;
	content: string;
	tokens: number;
};

export type Template = {
	id: string;
	slug: string;
	name: string;
	description: string | null;
	tags: string[];
	featured: boolean;
};

export type ApiError = { error: string; message?: string; code?: string };
