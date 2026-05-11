// /deploy — enqueue a build job. Real build runs in a Container worker (Phase 2).

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { nanoid } from "nanoid";
import { requireUser, type AppEnv } from "../middleware/auth";

const deploy = new Hono<AppEnv>();

deploy.use("*", requireUser);

deploy.post(
	"/:projectSlug",
	zValidator("json", z.object({ commitMessage: z.string().optional() }).optional()),
	async (c) => {
		const u = c.get("user");
		const slug = c.req.param("projectSlug");
		const project = await c.env.DB
			.prepare("SELECT * FROM projects WHERE slug = ? AND owner_id = ?")
			.bind(slug, u.id)
			.first<{ id: string; subdomain: string | null }>();
		if (!project) return c.json({ error: "not_found" }, 404);

		const lastVersion = await c.env.DB
			.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM deployments WHERE project_id = ?")
			.bind(project.id)
			.first<{ v: number }>();
		const version = (lastVersion?.v ?? 0) + 1;
		const id = "d_" + nanoid(14);
		const now = Date.now();
		await c.env.DB
			.prepare(
				"INSERT INTO deployments (id, project_id, version, status, url, created_at) VALUES (?,?,?,?,?,?)",
			)
			.bind(id, project.id, version, "queued", null, now)
			.run();

		await c.env.JOBS.send({ kind: "deploy", deploymentId: id, projectId: project.id });
		return c.json({ deploymentId: id, status: "queued", version });
	},
);

deploy.get("/status/:deploymentId", async (c) => {
	const u = c.get("user");
	const d = await c.env.DB
		.prepare(
			`SELECT d.* FROM deployments d JOIN projects p ON p.id = d.project_id
			 WHERE d.id = ? AND p.owner_id = ?`,
		)
		.bind(c.req.param("deploymentId"), u.id)
		.first();
	if (!d) return c.json({ error: "not_found" }, 404);
	return c.json({ deployment: d });
});

export default deploy;
