// /projects/:slug/secrets — list/set/delete project secrets (AES-GCM encrypted with SECRETS_MASTER_KEY).

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { nanoid } from "nanoid";
import { requireUser, type AppEnv } from "../middleware/auth";
import { encryptSecret } from "../lib/crypto";

const secrets = new Hono<AppEnv>();

secrets.use("*", requireUser);

async function loadProjectId(c: import("hono").Context<AppEnv>, slug: string) {
	const u = c.get("user");
	const p = await c.env.DB
		.prepare("SELECT id FROM projects WHERE slug = ? AND owner_id = ?")
		.bind(slug, u.id)
		.first<{ id: string }>();
	return p?.id ?? null;
}

secrets.get("/:slug", async (c) => {
	const pid = await loadProjectId(c, c.req.param("slug"));
	if (!pid) return c.json({ error: "not_found" }, 404);
	const rows = await c.env.DB
		.prepare("SELECT id, key, created_at FROM secrets WHERE project_id = ? ORDER BY key")
		.bind(pid)
		.all();
	return c.json({ secrets: rows.results });
});

secrets.post(
	"/:slug",
	zValidator("json", z.object({ key: z.string().min(1).max(64), value: z.string().min(0).max(8192) })),
	async (c) => {
		const pid = await loadProjectId(c, c.req.param("slug"));
		if (!pid) return c.json({ error: "not_found" }, 404);
		const { key, value } = c.req.valid("json");
		const { ciphertext, iv } = await encryptSecret(value, c.env.SECRETS_MASTER_KEY);
		await c.env.DB
			.prepare(
				`INSERT INTO secrets (id, project_id, key, ciphertext, iv, created_at)
				 VALUES (?,?,?,?,?,?)
				 ON CONFLICT(project_id, key) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv`,
			)
			.bind("sec_" + nanoid(14), pid, key, ciphertext, iv, Date.now())
			.run();
		return c.json({ ok: true });
	},
);

secrets.delete("/:slug/:key", async (c) => {
	const pid = await loadProjectId(c, c.req.param("slug"));
	if (!pid) return c.json({ error: "not_found" }, 404);
	await c.env.DB
		.prepare("DELETE FROM secrets WHERE project_id = ? AND key = ?")
		.bind(pid, c.req.param("key"))
		.run();
	return c.json({ ok: true });
});

export default secrets;
