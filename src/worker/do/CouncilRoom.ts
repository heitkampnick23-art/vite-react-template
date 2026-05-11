// CouncilRoom — Durable Object that orchestrates 3-model deliberation.
// Architect (Claude) → Critic (GPT) → Security (Gemini), up to 3 rounds.

import { DurableObject } from "cloudflare:workers";
import { nanoid } from "nanoid";
import { completeClaude } from "../lib/ai/anthropic";
import { completeOpenAI } from "../lib/ai/openai";
import { completeGemini } from "../lib/ai/google";

type StartPayload = { runId: string; prompt: string; userId: string; projectId?: string | null };

export class CouncilRoom extends DurableObject<Env> {
	subscribers: Set<WritableStreamDefaultWriter> = new Set();
	transcript: unknown[] = [];
	state: { status: "idle" | "running" | "done" | "error"; runId?: string } = { status: "idle" };

	async fetch(req: Request): Promise<Response> {
		const url = new URL(req.url);
		if (url.pathname === "/start" && req.method === "POST") {
			const payload = (await req.json()) as StartPayload;
			this.state = { status: "running", runId: payload.runId };
			this.transcript = [];
			this.ctx.waitUntil(this.runDeliberation(payload));
			return new Response("started");
		}
		if (url.pathname === "/stream") {
			const enc = new TextEncoder();
			const { readable, writable } = new TransformStream();
			const writer = writable.getWriter();
			// Replay buffered events so late subscribers don't miss earlier turns.
			for (const ev of this.transcript) {
				try {
					await writer.write(enc.encode(`data: ${JSON.stringify(ev)}\n\n`));
				} catch {
					/* writer closed mid-replay */
				}
			}
			if (this.state.status === "done" || this.state.status === "error") {
				try {
					await writer.close();
				} catch {
					/* noop */
				}
			} else {
				this.subscribers.add(writer);
			}
			return new Response(readable, {
				headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
			});
		}
		return new Response("not found", { status: 404 });
	}

	async broadcast(obj: unknown) {
		this.transcript.push(obj);
		const enc = new TextEncoder();
		const chunk = enc.encode(`data: ${JSON.stringify(obj)}\n\n`);
		const dead: WritableStreamDefaultWriter[] = [];
		for (const w of this.subscribers) {
			try {
				await w.write(chunk);
			} catch {
				dead.push(w);
			}
		}
		for (const w of dead) this.subscribers.delete(w);
	}

	async persistTurn(runId: string, idx: number, role: string, model: string, content: string, tokens: number) {
		await this.env.DB
			.prepare(
				"INSERT INTO council_turns (id, run_id, idx, role, model, content, tokens, created_at) VALUES (?,?,?,?,?,?,?,?)",
			)
			.bind("ct_" + nanoid(14), runId, idx, role, model, content, tokens, Date.now())
			.run();
	}

	async runDeliberation(p: StartPayload) {
		const transcript: { role: string; model: string; content: string }[] = [];
		let totalTokens = 0;
		let idx = 0;

		try {
			// Round 1: Architect proposes
			const arch1 = await completeClaude({
				env: this.env,
				db: this.env.DB,
				userId: p.userId,
				projectId: p.projectId,
				model: "claude-sonnet-4-6",
				system: ARCH_SYSTEM,
				messages: [{ role: "user", content: p.prompt }],
				requestId: nanoid(),
			});
			transcript.push({ role: "architect", model: "claude-sonnet-4-6", content: arch1.text });
			totalTokens += arch1.promptTokens + arch1.completionTokens;
			await this.persistTurn(p.runId, idx, "architect", "claude-sonnet-4-6", arch1.text, totalTokens);
			await this.broadcast({ type: "turn", idx: idx++, role: "architect", model: "claude-sonnet-4-6", content: arch1.text });

			// Round 1: Critic
			const crit1 = await completeOpenAI({
				env: this.env,
				db: this.env.DB,
				userId: p.userId,
				projectId: p.projectId,
				model: "gpt-4o-mini",
				messages: [
					{ role: "system", content: CRITIC_SYSTEM },
					{ role: "user", content: `User request: ${p.prompt}\n\nArchitect proposal:\n${arch1.text}` },
				],
				requestId: nanoid(),
			});
			transcript.push({ role: "critic", model: "gpt-4o-mini", content: crit1.text });
			totalTokens += crit1.promptTokens + crit1.completionTokens;
			await this.persistTurn(p.runId, idx, "critic", "gpt-4o-mini", crit1.text, totalTokens);
			await this.broadcast({ type: "turn", idx: idx++, role: "critic", model: "gpt-4o-mini", content: crit1.text });

			// Round 1: Security
			const sec1 = await completeGemini({
				env: this.env,
				db: this.env.DB,
				userId: p.userId,
				projectId: p.projectId,
				model: "gemini-1.5-pro",
				system: SECURITY_SYSTEM,
				prompt: `User request: ${p.prompt}\n\nArchitect:\n${arch1.text}\n\nCritic:\n${crit1.text}`,
				requestId: nanoid(),
			});
			transcript.push({ role: "security", model: "gemini-1.5-pro", content: sec1.text });
			totalTokens += sec1.promptTokens + sec1.completionTokens;
			await this.persistTurn(p.runId, idx, "security", "gemini-1.5-pro", sec1.text, totalTokens);
			await this.broadcast({ type: "turn", idx: idx++, role: "security", model: "gemini-1.5-pro", content: sec1.text });

			// Round 2: Architect synthesizes final plan
			const synth = await completeClaude({
				env: this.env,
				db: this.env.DB,
				userId: p.userId,
				projectId: p.projectId,
				model: "claude-sonnet-4-6",
				system: SYNTH_SYSTEM,
				messages: [
					{
						role: "user",
						content: `User request: ${p.prompt}\n\nYour original proposal:\n${arch1.text}\n\nCritic feedback:\n${crit1.text}\n\nSecurity review:\n${sec1.text}\n\nProduce a final, revised implementation plan addressing the feedback.`,
					},
				],
				maxTokens: 4096,
				requestId: nanoid(),
			});
			transcript.push({ role: "architect", model: "claude-sonnet-4-6", content: synth.text });
			totalTokens += synth.promptTokens + synth.completionTokens;
			await this.persistTurn(p.runId, idx, "architect", "claude-sonnet-4-6", synth.text, totalTokens);
			await this.broadcast({ type: "turn", idx: idx++, role: "architect", model: "claude-sonnet-4-6", content: synth.text });

			await this.env.DB
				.prepare(
					"UPDATE council_runs SET status = 'done', final_plan = ?, tokens_used = ?, completed_at = ? WHERE id = ?",
				)
				.bind(synth.text, totalTokens, Date.now(), p.runId)
				.run();
			await this.broadcast({ type: "done", finalPlan: synth.text, tokensUsed: totalTokens });
			this.state = { status: "done", runId: p.runId };
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			await this.env.DB
				.prepare("UPDATE council_runs SET status = 'error', completed_at = ? WHERE id = ?")
				.bind(Date.now(), p.runId)
				.run();
			await this.broadcast({ type: "error", message: msg });
			this.state = { status: "error", runId: p.runId };
		} finally {
			for (const w of this.subscribers) {
				try {
					await w.close();
				} catch {
					/* noop */
				}
			}
			this.subscribers.clear();
		}
	}
}

const ARCH_SYSTEM =
	"You are the Architect on the Generate AI Council. Propose a clean, pragmatic implementation plan for the user's request. Be specific about files, data models, and the user-facing flow. ~300 words.";

const CRITIC_SYSTEM =
	"You are the Critic on the Generate AI Council. Aggressively but fairly find weaknesses in the Architect's plan: hidden complexity, missing edge cases, scope creep, over-engineering, brittle assumptions. Be specific and concise. ~250 words.";

const SECURITY_SYSTEM =
	"You are the Security Reviewer on the Generate AI Council. Identify auth, data exposure, injection, secrets handling, and dependency-supply-chain risks in the proposed plan. Flag anything that would fail an OWASP review. ~250 words.";

const SYNTH_SYSTEM =
	"You are the Architect again. Revise your plan addressing the Critic and Security feedback. Output the FINAL implementation plan in clear markdown sections: Overview, Files to change, Data, UX, Risks addressed. ~500 words.";
