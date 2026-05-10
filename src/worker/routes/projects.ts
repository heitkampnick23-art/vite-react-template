// /projects — CRUD + file ops. Files stored inline in D1 if <32KB, R2 otherwise.

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { nanoid } from "nanoid";
import { requireUser, type AppEnv } from "../middleware/auth";
import { rowToProject, type ProjectRow } from "../lib/db";

const projects = new Hono<AppEnv>();

projects.use("*", requireUser);

const slugify = (name: string) =>
	name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) +
	"-" +
	nanoid(6).toLowerCase();

// GET /projects
projects.get("/", async (c) => {
	const u = c.get("user");
	const rows = await c.env.DB
		.prepare(
			"SELECT * FROM projects WHERE owner_id = ? ORDER BY updated_at DESC LIMIT 100",
		)
		.bind(u.id)
		.all<ProjectRow>();
	return c.json({ projects: (rows.results ?? []).map(rowToProject) });
});

// POST /projects { name, template?, description? }
projects.post(
	"/",
	zValidator(
		"json",
		z.object({
			name: z.string().min(1).max(80),
			template: z.string().optional(),
			description: z.string().optional(),
			visibility: z.enum(["private", "public"]).optional(),
		}),
	),
	async (c) => {
		const u = c.get("user");
		const body = c.req.valid("json");
		const id = "p_" + nanoid(16);
		const slug = slugify(body.name);
		const subdomain = slug;
		const now = Date.now();
		await c.env.DB
			.prepare(
				"INSERT INTO projects (id, owner_id, name, slug, description, template, visibility, subdomain, framework, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
			)
			.bind(
				id,
				u.id,
				body.name,
				slug,
				body.description ?? null,
				body.template ?? null,
				body.visibility ?? "private",
				subdomain,
				"vite-react",
				now,
				now,
			)
			.run();
		const row = await c.env.DB
			.prepare("SELECT * FROM projects WHERE id = ?")
			.bind(id)
			.first<ProjectRow>();
		return c.json({ project: rowToProject(row!) }, 201);
	},
);

async function loadProject(c: import("hono").Context<AppEnv>, slug: string) {
	const u = c.get("user");
	return c.env.DB
		.prepare(
			`SELECT p.* FROM projects p
			 LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = ?
			 WHERE p.slug = ? AND (p.owner_id = ? OR m.user_id IS NOT NULL OR p.visibility = 'public')`,
		)
		.bind(u.id, slug, u.id)
		.first<ProjectRow>();
}

// GET /projects/:slug
projects.get("/:slug", async (c) => {
	const row = await loadProject(c, c.req.param("slug"));
	if (!row) return c.json({ error: "not_found" }, 404);
	return c.json({ project: rowToProject(row) });
});

// GET /projects/:slug/files
projects.get("/:slug/files", async (c) => {
	const row = await loadProject(c, c.req.param("slug"));
	if (!row) return c.json({ error: "not_found" }, 404);
	const files = await c.env.DB
		.prepare("SELECT id, path, size, mime, updated_at FROM files WHERE project_id = ? ORDER BY path")
		.bind(row.id)
		.all<{ id: string; path: string; size: number; mime: string | null; updated_at: number }>();
	return c.json({
		files: (files.results ?? []).map((f) => ({
			id: f.id,
			path: f.path,
			size: f.size,
			mime: f.mime,
			updatedAt: f.updated_at,
		})),
	});
});

// GET /projects/:slug/files/*  (raw file content)
projects.get("/:slug/file", async (c) => {
	const row = await loadProject(c, c.req.param("slug"));
	if (!row) return c.json({ error: "not_found" }, 404);
	const path = c.req.query("path");
	if (!path) return c.json({ error: "missing_path" }, 400);
	const f = await c.env.DB
		.prepare("SELECT * FROM files WHERE project_id = ? AND path = ?")
		.bind(row.id, path)
		.first<{ content_inline: string | null; content_r2_key: string | null; mime: string | null }>();
	if (!f) return c.json({ error: "not_found" }, 404);
	if (f.content_inline !== null) return c.json({ path, content: f.content_inline });
	if (f.content_r2_key) {
		const obj = await c.env.FILES.get(f.content_r2_key);
		const content = obj ? await obj.text() : "";
		return c.json({ path, content });
	}
	return c.json({ path, content: "" });
});

// PUT /projects/:slug/file { path, content }
projects.put(
	"/:slug/file",
	zValidator("json", z.object({ path: z.string().min(1), content: z.string() })),
	async (c) => {
		const row = await loadProject(c, c.req.param("slug"));
		if (!row) return c.json({ error: "not_found" }, 404);
		const { path, content } = c.req.valid("json");
		const size = new TextEncoder().encode(content).length;
		const inline = size < 32_000;
		const id = "f_" + nanoid(14);
		const key = inline ? null : `${row.id}/${path}`;
		if (!inline) await c.env.FILES.put(key!, content);
		const hash = await sha256(content);
		const now = Date.now();
		await c.env.DB
			.prepare(
				`INSERT INTO files (id, project_id, path, content_inline, content_r2_key, size, hash, mime, updated_at)
				 VALUES (?,?,?,?,?,?,?,?,?)
				 ON CONFLICT(project_id, path) DO UPDATE SET
				   content_inline = excluded.content_inline,
				   content_r2_key = excluded.content_r2_key,
				   size = excluded.size,
				   hash = excluded.hash,
				   updated_at = excluded.updated_at`,
			)
			.bind(id, row.id, path, inline ? content : null, key, size, hash, mimeOf(path), now)
			.run();
		await c.env.DB
			.prepare("UPDATE projects SET updated_at = ? WHERE id = ?")
			.bind(now, row.id)
			.run();
		return c.json({ ok: true, path, size });
	},
);

// DELETE /projects/:slug
projects.delete("/:slug", async (c) => {
	const u = c.get("user");
	const slug = c.req.param("slug");
	const row = await c.env.DB
		.prepare("SELECT * FROM projects WHERE slug = ? AND owner_id = ?")
		.bind(slug, u.id)
		.first<ProjectRow>();
	if (!row) return c.json({ error: "not_found" }, 404);
	await c.env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(row.id).run();
	return c.json({ ok: true });
});

async function sha256(s: string) {
	const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function mimeOf(path: string): string {
	const ext = path.split(".").pop()?.toLowerCase();
	const map: Record<string, string> = {
		ts: "text/typescript",
		tsx: "text/typescript",
		js: "text/javascript",
		jsx: "text/javascript",
		json: "application/json",
		html: "text/html",
		css: "text/css",
		md: "text/markdown",
		svg: "image/svg+xml",
	};
	return (ext && map[ext]) || "text/plain";
}

export default projects;
