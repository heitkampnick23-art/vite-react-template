// Session-based auth. Cookie holds signed session-id; lookup goes through KV first, D1 fallback.

import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { verifyCookie } from "../lib/crypto";
import type { UserRow } from "../lib/db";

export type AppEnv = { Bindings: Env; Variables: { user: UserRow; sessionId: string } };

const SESSION_COOKIE = "gai_session";

export async function resolveUser(c: Context<AppEnv>): Promise<UserRow | null> {
	const signed = getCookie(c, SESSION_COOKIE);
	if (!signed) return null;
	const sessionId = await verifyCookie(signed, c.env.JWT_SECRET);
	if (!sessionId) return null;

	// KV first.
	const cached = await c.env.SESSIONS.get(`s:${sessionId}`, "json");
	if (cached) {
		c.set("sessionId", sessionId);
		return cached as UserRow;
	}

	// D1 fallback.
	const row = await c.env.DB
		.prepare(
			`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
			 WHERE s.id = ? AND s.expires_at > ?`,
		)
		.bind(sessionId, Date.now())
		.first<UserRow>();
	if (!row) return null;

	// Backfill KV for 24h.
	await c.env.SESSIONS.put(`s:${sessionId}`, JSON.stringify(row), { expirationTtl: 86_400 });
	c.set("sessionId", sessionId);
	return row;
}

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
	const u = await resolveUser(c);
	if (!u) return c.json({ error: "unauthorized" }, 401);
	c.set("user", u);
	await next();
};

export const optionalUser: MiddlewareHandler<AppEnv> = async (c, next) => {
	const u = await resolveUser(c);
	if (u) c.set("user", u);
	await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
	const u = await resolveUser(c);
	if (!u || u.role !== "admin") return c.json({ error: "forbidden" }, 403);
	c.set("user", u);
	await next();
};
