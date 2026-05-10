// Generate AI — Worker entrypoint.
// Mounts all API routes, handles SPA fallback, exports Durable Object classes, queue consumer, scheduled jobs.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import auth from "./routes/auth";
import projects from "./routes/projects";
import ai from "./routes/ai";
import council from "./routes/council";
import billing from "./routes/billing";
import webhooks from "./routes/webhooks";
import deploy from "./routes/deploy";
import heal from "./routes/heal";
import templates from "./routes/templates";
import secrets from "./routes/secrets";
import type { AppEnv } from "./middleware/auth";

const app = new Hono<AppEnv>();

app.use("*", logger());
app.use(
	"/api/*",
	cors({
		origin: (origin) => origin ?? "*",
		credentials: true,
		allowHeaders: ["Content-Type", "Authorization"],
	}),
);

app.get("/api/health", (c) =>
	c.json({
		ok: true,
		app: c.env.APP_NAME,
		time: Date.now(),
	}),
);

app.route("/api/auth", auth);
app.route("/auth", auth); // also at /auth for redirect-based flows
app.route("/api/projects", projects);
app.route("/api/ai", ai);
app.route("/api/council", council);
app.route("/api/billing", billing);
app.route("/api/deploy", deploy);
app.route("/api/heal", heal);
app.route("/api/templates", templates);
app.route("/api/secrets", secrets);
app.route("/api/webhooks", webhooks);

app.onError((err, c) => {
	console.error("worker error", err);
	return c.json({ error: "server_error", message: err.message }, 500);
});

export { CouncilRoom } from "./do/CouncilRoom";
export { LiveDoc } from "./do/LiveDoc";
export { SandboxSession } from "./do/SandboxSession";

export default {
	fetch: app.fetch,
	async queue(batch: MessageBatch, env: Env, _ctx: ExecutionContext) {
		for (const msg of batch.messages) {
			try {
				await handleJob(msg.body as JobMessage, env);
				msg.ack();
			} catch (e) {
				console.error("queue job failed", e);
				msg.retry();
			}
		}
	},
	async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
		// Hourly: expire old sessions, KV cache cleanup.
		await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(Date.now()).run();
		await env.DB.prepare("DELETE FROM oauth_states WHERE expires_at < ?").bind(Date.now()).run();
		await env.DB.prepare("DELETE FROM magic_links WHERE expires_at < ?").bind(Date.now()).run();
	},
} satisfies ExportedHandler<Env>;

type JobMessage =
	| { kind: "deploy"; deploymentId?: string; projectId: string; fromHealId?: string }
	| { kind: "heal"; deploymentId: string; errorSignature: string; logKey: string };

async function handleJob(job: JobMessage, env: Env) {
	if (job.kind === "deploy") {
		// Phase 2: real build via Container. For now, mark as live with placeholder URL.
		if (!job.deploymentId) return;
		const project = await env.DB
			.prepare("SELECT subdomain FROM projects WHERE id = ?")
			.bind(job.projectId)
			.first<{ subdomain: string | null }>();
		const url = project?.subdomain ? `https://${project.subdomain}.generateai.build` : null;
		await env.DB
			.prepare(
				"UPDATE deployments SET status = 'live', url = ?, completed_at = ? WHERE id = ?",
			)
			.bind(url, Date.now(), job.deploymentId)
			.run();
		return;
	}
	if (job.kind === "heal") {
		// Phase 3: pull failing file, ask Claude for patch, write heal_events.
		// Skeleton — full implementation pending Logpush wiring.
		return;
	}
}
