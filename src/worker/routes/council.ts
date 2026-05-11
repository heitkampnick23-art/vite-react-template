// /council — orchestrates 3-model debate via Durable Object.

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { nanoid } from "nanoid";
import { requireUser, type AppEnv } from "../middleware/auth";
import { PLANS } from "../lib/pricing";

const council = new Hono<AppEnv>();

council.use("*", requireUser);

// POST /council/start { prompt, projectId? } -> { runId }
council.post(
	"/start",
	zValidator("json", z.object({ prompt: z.string().min(1).max(10_000), projectId: z.string().optional() })),
	async (c) => {
		const u = c.get("user");
		if (!PLANS[u.plan].councilEnabled) {
			return c.json({ error: "plan_required", message: "Council requires Pro+." }, 402);
		}
		const { prompt, projectId } = c.req.valid("json");
		const runId = "cr_" + nanoid(14);
		const now = Date.now();
		await c.env.DB
			.prepare(
				"INSERT INTO council_runs (id, project_id, user_id, prompt, status, tokens_used, created_at) VALUES (?,?,?,?,?,?,?)",
			)
			.bind(runId, projectId ?? null, u.id, prompt, "running", 0, now)
			.run();
		// Kick off the DO asynchronously
		const id = c.env.COUNCIL.idFromName(runId);
		const stub = c.env.COUNCIL.get(id);
		c.executionCtx.waitUntil(
			stub.fetch(
				new Request("https://do/start", {
					method: "POST",
					body: JSON.stringify({ runId, prompt, userId: u.id, projectId }),
				}),
			),
		);
		return c.json({ runId });
	},
);

// GET /council/:id/stream — SSE relay from DO
council.get("/:id/stream", async (c) => {
	const id = c.env.COUNCIL.idFromName(c.req.param("id"));
	const stub = c.env.COUNCIL.get(id);
	return stub.fetch(new Request("https://do/stream"));
});

// GET /council/:id — current state from D1
council.get("/:id", async (c) => {
	const u = c.get("user");
	const run = await c.env.DB
		.prepare("SELECT * FROM council_runs WHERE id = ? AND user_id = ?")
		.bind(c.req.param("id"), u.id)
		.first<{ id: string; status: string; final_plan: string | null; tokens_used: number }>();
	if (!run) return c.json({ error: "not_found" }, 404);
	const turns = await c.env.DB
		.prepare("SELECT idx, role, model, content, tokens FROM council_turns WHERE run_id = ? ORDER BY idx")
		.bind(run.id)
		.all<{ idx: number; role: string; model: string; content: string; tokens: number }>();
	return c.json({ run, turns: turns.results });
});

export default council;
