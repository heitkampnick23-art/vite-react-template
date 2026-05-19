// Tiny API client wrapping fetch with credentials.

import type { UserPublic, Project, ProjectFile, AiModelId, Template } from "../../shared/types";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
	const r = await fetch(path, {
		credentials: "include",
		headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
		...init,
	});
	if (!r.ok) {
		const err = await r.json().catch(() => ({ error: r.statusText }));
		throw Object.assign(new Error((err as { message?: string }).message ?? "request_failed"), { status: r.status, body: err });
	}
	return (await r.json()) as T;
}

export const api = {
	me: () => req<{ user: UserPublic | null }>("/api/auth/me"),
	logout: () => req<{ ok: true }>("/api/auth/logout", { method: "POST" }),
	sendMagic: (email: string) =>
		req<{ ok: true; devUrl?: string }>("/api/auth/magic", { method: "POST", body: JSON.stringify({ email }) }),
	signup: (body: { email: string; password: string; name?: string }) =>
		req<{ user: UserPublic }>("/api/auth/signup", { method: "POST", body: JSON.stringify(body) }),
	signin: (body: { email: string; password: string }) =>
		req<{ user: UserPublic }>("/api/auth/signin", { method: "POST", body: JSON.stringify(body) }),
	projects: () => req<{ projects: Project[] }>("/api/projects"),
	createProject: (body: { name: string; template?: string; description?: string }) =>
		req<{ project: Project }>("/api/projects", { method: "POST", body: JSON.stringify(body) }),
	project: (slug: string) => req<{ project: Project }>(`/api/projects/${slug}`),
	files: (slug: string) => req<{ files: ProjectFile[] }>(`/api/projects/${slug}/files`),
	file: (slug: string, path: string) =>
		req<{ path: string; content: string }>(`/api/projects/${slug}/file?path=${encodeURIComponent(path)}`),
	saveFile: (slug: string, path: string, content: string) =>
		req<{ ok: true; size: number }>(`/api/projects/${slug}/file`, {
			method: "PUT",
			body: JSON.stringify({ path, content }),
		}),
	deploy: (slug: string) =>
		req<{ deploymentId: string; status: string; version: number }>(`/api/deploy/${slug}`, { method: "POST" }),
	models: () =>
		req<{ models: Array<{ id: AiModelId; displayName: string; provider: string; contextWindow: number; requiredPlan: string; available: boolean }> }>(
			"/api/ai/models",
		),
	balance: () =>
		req<{ balance: number; plan: string; recent: Array<{ delta: number; reason: string; model: string | null; created_at: number }> }>(
			"/api/billing/balance",
		),
	plans: () => req<{ plans: Record<string, { displayName: string; monthlyCredits: number; priceCents: number; features: string[] }>; topups: Array<{ id: string; credits: number; priceCents: number }> }>("/api/billing/plans"),
	checkout: (body: { plan?: "pro" | "team"; topupId?: string }) =>
		req<{ url: string }>("/api/billing/checkout", { method: "POST", body: JSON.stringify(body) }),
	portal: () => req<{ url: string }>("/api/billing/portal", { method: "POST" }),
	templates: () => req<{ templates: Template[] }>("/api/templates"),
	startCouncil: (prompt: string, projectId?: string) =>
		req<{ runId: string }>("/api/council/start", { method: "POST", body: JSON.stringify({ prompt, projectId }) }),
	healEvents: () => req<{ events: Array<{ id: string; error_signature: string; status: string; created_at: number }> }>("/api/heal/events"),
};

// SSE helper for AI chat.
export async function* streamChat(body: {
	messages: { role: "user" | "assistant"; content: string }[];
	model?: string;
	system?: string;
	projectId?: string;
}): AsyncGenerator<{ type: string; text?: string; message?: string; usage?: { promptTokens: number; completionTokens: number } }> {
	const res = await fetch("/api/ai/chat", {
		method: "POST",
		credentials: "include",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok || !res.body) {
		const err = await res.json().catch(() => ({ error: res.statusText }));
		throw Object.assign(new Error((err as { message?: string }).message ?? "chat_failed"), { status: res.status, body: err });
	}
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	while (true) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
		const lines = buf.split("\n\n");
		buf = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.startsWith("data: ")) continue;
			try {
				yield JSON.parse(line.slice(6));
			} catch {
				/* skip */
			}
		}
	}
}
