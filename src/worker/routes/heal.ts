// /heal — list heal events for the user's projects + approve/reject.

import { Hono } from "hono";
import { requireUser, type AppEnv } from "../middleware/auth";

const heal = new Hono<AppEnv>();

heal.use("*", requireUser);

heal.get("/events", async (c) => {
	const u = c.get("user");
	const rows = await c.env.DB
		.prepare(
			`SELECT h.* FROM heal_events h JOIN projects p ON p.id = h.project_id
			 WHERE p.owner_id = ? ORDER BY h.created_at DESC LIMIT 50`,
		)
		.bind(u.id)
		.all();
	return c.json({ events: rows.results });
});

heal.post("/:id/approve", async (c) => {
	const u = c.get("user");
	const id = c.req.param("id");
	const row = await c.env.DB
		.prepare(
			`SELECT h.*, p.owner_id FROM heal_events h JOIN projects p ON p.id = h.project_id
			 WHERE h.id = ? AND p.owner_id = ?`,
		)
		.bind(id, u.id)
		.first<{ project_id: string; deployment_id: string }>();
	if (!row) return c.json({ error: "not_found" }, 404);
	await c.env.DB
		.prepare("UPDATE heal_events SET status = 'approved', resolved_at = ? WHERE id = ?")
		.bind(Date.now(), id)
		.run();
	await c.env.JOBS.send({ kind: "deploy", projectId: row.project_id, fromHealId: id });
	return c.json({ ok: true });
});

heal.post("/:id/reject", async (c) => {
	const u = c.get("user");
	const id = c.req.param("id");
	const ok = await c.env.DB
		.prepare(
			`UPDATE heal_events SET status = 'rejected', resolved_at = ?
			 WHERE id = ? AND project_id IN (SELECT id FROM projects WHERE owner_id = ?)`,
		)
		.bind(Date.now(), id, u.id)
		.run();
	return c.json({ ok: ok.success });
});

export default heal;
