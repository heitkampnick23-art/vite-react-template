// /auth — magic link, GitHub OAuth, Google OAuth, /me, logout.
// Sessions: signed cookie holding session-id; record in D1 + KV.

import { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { nanoid } from "nanoid";
import { Resend } from "resend";
import { signCookie } from "../lib/crypto";
import { rowToUserPublic, getUserByEmail } from "../lib/db";
import { credit } from "../lib/tokens";
import { resolveUser, requireUser, type AppEnv } from "../middleware/auth";
import { PLANS } from "../lib/pricing";

const auth = new Hono<AppEnv>();

const SESSION_COOKIE = "gai_session";
const SESSION_TTL_DAYS = 30;

const PBKDF2_ITERS = 100_000;
const PBKDF2_KEY_LEN = 32;
const PBKDF2_SALT_LEN = 16;

function b64(bytes: ArrayBuffer | Uint8Array) {
	const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let s = "";
	for (const b of arr) s += String.fromCharCode(b);
	return btoa(s);
}
function b64decode(s: string) {
	const bin = atob(s);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

async function hashPassword(password: string): Promise<string> {
	const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_LEN));
	const key = await derive(password, salt);
	return `pbkdf2$${PBKDF2_ITERS}$${b64(salt)}$${b64(key)}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const parts = stored.split("$");
	if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
	const iters = Number(parts[1]);
	const salt = b64decode(parts[2]);
	const expected = b64decode(parts[3]);
	const key = await derive(password, salt, iters);
	if (key.byteLength !== expected.byteLength) return false;
	let diff = 0;
	const a = new Uint8Array(key);
	for (let i = 0; i < a.length; i++) diff |= a[i] ^ expected[i];
	return diff === 0;
}

async function derive(password: string, salt: Uint8Array, iters = PBKDF2_ITERS) {
	const baseKey = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(password),
		{ name: "PBKDF2" },
		false,
		["deriveBits"],
	);
	return crypto.subtle.deriveBits(
		{ name: "PBKDF2", salt, iterations: iters, hash: "SHA-256" },
		baseKey,
		PBKDF2_KEY_LEN * 8,
	);
}

async function createSession(c: Parameters<typeof auth.fetch>[0] extends never ? never : import("hono").Context<AppEnv>, userId: string) {
	const sessionId = nanoid(32);
	const expires = Date.now() + SESSION_TTL_DAYS * 86_400_000;
	const ip = c.req.header("CF-Connecting-IP") ?? null;
	const ua = c.req.header("User-Agent") ?? null;
	await c.env.DB
		.prepare(
			"INSERT INTO sessions (id, user_id, expires_at, ip, ua, created_at) VALUES (?,?,?,?,?,?)",
		)
		.bind(sessionId, userId, expires, ip, ua, Date.now())
		.run();
	const signed = await signCookie(sessionId, c.env.JWT_SECRET);
	setCookie(c, SESSION_COOKIE, signed, {
		httpOnly: true,
		secure: true,
		sameSite: "Lax",
		path: "/",
		maxAge: SESSION_TTL_DAYS * 86_400,
	});
	return sessionId;
}

async function findOrCreateUser(c: import("hono").Context<AppEnv>, email: string, name?: string | null, opts?: { githubId?: string; googleId?: string; avatar?: string }) {
	const existing = await getUserByEmail(c.env.DB, email);
	if (existing) return existing;
	const id = "u_" + nanoid(16);
	const now = Date.now();
	const plan = "free" as const;
	const tokens = PLANS.free.monthlyCredits;
	await c.env.DB
		.prepare(
			"INSERT INTO users (id, email, name, avatar_url, github_id, google_id, plan, token_balance, role, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
		)
		.bind(
			id,
			email.toLowerCase(),
			name ?? null,
			opts?.avatar ?? null,
			opts?.githubId ?? null,
			opts?.googleId ?? null,
			plan,
			tokens,
			"user",
			now,
			now,
		)
		.run();
	// Welcome ledger entry.
	await credit(c.env.DB, { userId: id, amount: 0, reason: "signup_grant", requestId: nanoid() });
	return (await getUserByEmail(c.env.DB, email))!;
}

// GET /auth/me
auth.get("/me", async (c) => {
	const u = await resolveUser(c);
	if (!u) return c.json({ user: null });
	return c.json({ user: rowToUserPublic(u) });
});

// POST /auth/signup { email, password, name? } -> create user + session
auth.post(
	"/signup",
	zValidator(
		"json",
		z.object({
			email: z.string().email(),
			password: z.string().min(8).max(200),
			name: z.string().min(1).max(80).optional(),
		}),
	),
	async (c) => {
		const { email, password, name } = c.req.valid("json");
		const normalized = email.toLowerCase();
		const existing = await getUserByEmail(c.env.DB, normalized);
		if (existing) return c.json({ error: "email_taken" }, 409);
		const hash = await hashPassword(password);
		const id = "u_" + nanoid(16);
		const now = Date.now();
		await c.env.DB
			.prepare(
				"INSERT INTO users (id, email, name, password_hash, plan, token_balance, role, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
			)
			.bind(id, normalized, name ?? null, hash, "free", PLANS.free.monthlyCredits, "user", now, now)
			.run();
		await credit(c.env.DB, { userId: id, amount: 0, reason: "signup_grant", requestId: nanoid() });
		await createSession(c, id);
		const u = await getUserByEmail(c.env.DB, normalized);
		return c.json({ user: u ? rowToUserPublic(u) : null });
	},
);

// POST /auth/signin { email, password }
auth.post(
	"/signin",
	zValidator(
		"json",
		z.object({ email: z.string().email(), password: z.string().min(1).max(200) }),
	),
	async (c) => {
		const { email, password } = c.req.valid("json");
		const u = await getUserByEmail(c.env.DB, email.toLowerCase());
		if (!u || !u.password_hash) return c.json({ error: "invalid_credentials" }, 401);
		const ok = await verifyPassword(password, u.password_hash);
		if (!ok) return c.json({ error: "invalid_credentials" }, 401);
		await createSession(c, u.id);
		return c.json({ user: rowToUserPublic(u) });
	},
);

// POST /auth/magic { email } -> sends magic link email
auth.post(
	"/magic",
	zValidator("json", z.object({ email: z.string().email() })),
	async (c) => {
		const { email } = c.req.valid("json");
		const token = nanoid(48);
		const expires = Date.now() + 15 * 60_000;
		await c.env.DB
			.prepare("INSERT INTO magic_links (token, email, expires_at) VALUES (?,?,?)")
			.bind(token, email.toLowerCase(), expires)
			.run();
		const url = `${c.env.APP_URL}/auth/callback?token=${token}`;
		if (c.env.RESEND_KEY) {
			const resend = new Resend(c.env.RESEND_KEY);
			await resend.emails.send({
				from: "Generate AI <noreply@generateai.build>",
				to: email,
				subject: "Sign in to Generate AI",
				html: `<p>Click to sign in:</p><p><a href="${url}">${url}</a></p><p>This link expires in 15 minutes.</p>`,
			});
		}
		return c.json({ ok: true, devUrl: c.env.APP_URL.startsWith("http://localhost") ? url : undefined });
	},
);

// GET /auth/callback?token=...
auth.get("/callback", async (c) => {
	const token = c.req.query("token");
	if (!token) return c.redirect("/login?error=missing_token");
	const row = await c.env.DB
		.prepare("SELECT * FROM magic_links WHERE token = ? AND used = 0 AND expires_at > ?")
		.bind(token, Date.now())
		.first<{ email: string }>();
	if (!row) return c.redirect("/login?error=invalid_or_expired");
	await c.env.DB
		.prepare("UPDATE magic_links SET used = 1 WHERE token = ?")
		.bind(token)
		.run();
	const user = await findOrCreateUser(c, row.email);
	await createSession(c, user.id);
	return c.redirect("/dashboard");
});

// POST /auth/logout
auth.post("/logout", requireUser, async (c) => {
	const sid = c.get("sessionId");
	if (sid) {
		await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sid).run();
		await c.env.SESSIONS.delete(`s:${sid}`);
	}
	deleteCookie(c, SESSION_COOKIE, { path: "/" });
	return c.json({ ok: true });
});

auth.get("/google", (c) => {
	const clientId = c.env.GOOGLE_OAUTH_ID;
	const state = nanoid(24);
	c.executionCtx.waitUntil(
		c.env.DB
			.prepare("INSERT INTO oauth_states (state, provider, expires_at) VALUES (?,?,?)")
			.bind(state, "google", Date.now() + 600_000)
			.run(),
	);
	const redirect = `${c.env.APP_URL}/auth/google/callback`;
	const url =
		`https://accounts.google.com/o/oauth2/v2/auth?` +
		new URLSearchParams({
			client_id: clientId,
			redirect_uri: redirect,
			response_type: "code",
			scope: "openid email profile",
			state,
			access_type: "online",
			prompt: "select_account",
		}).toString();
	return c.redirect(url);
});

auth.get("/google/callback", async (c) => {
	const code = c.req.query("code");
	const state = c.req.query("state");
	if (!code || !state) return c.redirect("/login?error=oauth");
	const row = await c.env.DB
		.prepare("SELECT * FROM oauth_states WHERE state = ? AND provider = 'google' AND expires_at > ?")
		.bind(state, Date.now())
		.first();
	if (!row) return c.redirect("/login?error=oauth_state");
	const redirect = `${c.env.APP_URL}/auth/google/callback`;
	const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: c.env.GOOGLE_OAUTH_ID,
			client_secret: c.env.GOOGLE_OAUTH_SECRET,
			code,
			grant_type: "authorization_code",
			redirect_uri: redirect,
		}).toString(),
	}).then((r) => r.json() as Promise<{ access_token?: string }>);
	if (!tokenRes.access_token) return c.redirect("/login?error=oauth_token");
	const profile = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
		headers: { Authorization: `Bearer ${tokenRes.access_token}` },
	}).then(
		(r) =>
			r.json() as Promise<{
				id: string;
				email: string;
				verified_email?: boolean;
				name?: string;
				picture?: string;
			}>,
	);
	if (!profile.email) return c.redirect("/login?error=no_email");
	const user = await findOrCreateUser(c, profile.email, profile.name ?? null, {
		googleId: profile.id,
		avatar: profile.picture,
	});
	await createSession(c, user.id);
	return c.redirect("/dashboard");
});

auth.get("/github", (c) => {
	const clientId = c.env.GITHUB_CLIENT_ID;
	const state = nanoid(24);
	c.executionCtx.waitUntil(
		c.env.DB
			.prepare(
				"INSERT INTO oauth_states (state, provider, expires_at) VALUES (?,?,?)",
			)
			.bind(state, "github", Date.now() + 600_000)
			.run(),
	);
	const redirect = `${c.env.APP_URL}/auth/github/callback`;
	const url = `https://github.com/login/oauth/authorize?client_id=${clientId}&state=${state}&redirect_uri=${encodeURIComponent(redirect)}&scope=user:email`;
	return c.redirect(url);
});

auth.get("/github/callback", async (c) => {
	const { code, state } = { code: c.req.query("code"), state: c.req.query("state") };
	if (!code || !state) return c.redirect("/login?error=oauth");
	const row = await c.env.DB
		.prepare("SELECT * FROM oauth_states WHERE state = ? AND provider = 'github' AND expires_at > ?")
		.bind(state, Date.now())
		.first();
	if (!row) return c.redirect("/login?error=oauth_state");
	// Exchange code for access token
	const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/json" },
		body: JSON.stringify({
			client_id: c.env.GITHUB_CLIENT_ID,
			client_secret: c.env.GITHUB_CLIENT_SECRET,
			code,
		}),
	}).then((r) => r.json() as Promise<{ access_token?: string }>);
	if (!tokenRes.access_token) return c.redirect("/login?error=oauth_token");
	const profile = await fetch("https://api.github.com/user", {
		headers: { Authorization: `Bearer ${tokenRes.access_token}`, "User-Agent": "GenerateAI" },
	}).then((r) => r.json() as Promise<{ id: number; email: string | null; login: string; avatar_url: string; name: string | null }>);
	let email = profile.email;
	if (!email) {
		const emails = await fetch("https://api.github.com/user/emails", {
			headers: { Authorization: `Bearer ${tokenRes.access_token}`, "User-Agent": "GenerateAI" },
		}).then((r) => r.json() as Promise<Array<{ email: string; primary: boolean; verified: boolean }>>);
		email = emails.find((e) => e.primary && e.verified)?.email ?? null;
	}
	if (!email) return c.redirect("/login?error=no_email");
	const user = await findOrCreateUser(c, email, profile.name ?? profile.login, {
		githubId: String(profile.id),
		avatar: profile.avatar_url,
	});
	await createSession(c, user.id);
	return c.redirect("/dashboard");
});

export default auth;
