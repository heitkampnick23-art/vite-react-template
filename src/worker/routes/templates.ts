import { Hono } from "hono";
import type { AppEnv } from "../middleware/auth";

const templates = new Hono<AppEnv>();

templates.get("/", async (c) => {
	const rows = await c.env.DB
		.prepare("SELECT * FROM templates ORDER BY featured DESC, name")
		.all<{ id: string; slug: string; name: string; description: string | null; tags: string | null; featured: number }>();
	return c.json({
		templates: (rows.results ?? []).map((t) => ({
			id: t.id,
			slug: t.slug,
			name: t.name,
			description: t.description,
			tags: (t.tags ?? "").split(",").filter(Boolean),
			featured: !!t.featured,
		})),
	});
});

export default templates;
