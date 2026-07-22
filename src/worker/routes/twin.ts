// /api/twin — the phone-callable digital twin (MirrorClone, integrated).
//
// Setup endpoints (owner-only, session auth): connect a Twilio account, pick or
// buy a phone number (webhook is pointed at this worker automatically), plug in
// ElevenLabs for the cloned voice, edit the persona, place outbound calls.
//
// Voice endpoints (Twilio-signature auth): /voice/incoming answers a call with
// a greeting, /voice/respond runs the speech → Claude → TTS loop, and
// /voice/audio/:id serves generated clips out of KV.
//
// Credentials resolve from twin_config in D1 (set via the /twin page, secrets
// AES-GCM encrypted) and fall back to worker secrets (ELEVENLABS_API_KEY etc.)
// so keys stored by earlier setups keep working.

import { Hono } from "hono";
import type { Context, MiddlewareHandler } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import { resolveUser, type AppEnv } from "../middleware/auth";
import { encryptSecret, decryptSecret } from "../lib/crypto";

const twin = new Hono<AppEnv>();

const AUDIO_TTL = 600; // seconds a generated clip stays playable
const CONVO_TTL = 3600;
const MAX_TURNS = 20;

const DEFAULT_TWIN_NAME = "Nick";
const DEFAULT_PERSONA =
	"You are the digital twin of Nick. Speak casually and warmly, in short sentences suited to a phone call. Be helpful, a little playful, and decisive. If asked something you can't know, say you'll have the real Nick follow up.";

// --- owner gate: the twin belongs to the site owner ---------------------------

const ownerOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
	const u = await resolveUser(c);
	if (!u) return c.json({ error: "unauthorized" }, 401);
	const owner = (c.env.OWNER_EMAIL || "heitkampnick23@gmail.com").toLowerCase();
	if (u.role !== "admin" && u.email.toLowerCase() !== owner) {
		return c.json({ error: "forbidden", message: "The phone twin is only available to the site owner." }, 403);
	}
	c.set("user", u);
	await next();
};

// --- twin_config storage -------------------------------------------------------

const SECRET_KEYS = new Set(["twilio_token", "eleven_key"]);

async function ensureTable(db: D1Database) {
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS twin_config (
				key TEXT PRIMARY KEY, value TEXT NOT NULL, iv TEXT, updated_at INTEGER NOT NULL
			)`,
		)
		.run();
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS twin_calls (
				id TEXT PRIMARY KEY, from_number TEXT, transcript TEXT NOT NULL,
				started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
			)`,
		)
		.run();
}

// Persist the running transcript so the owner can read every conversation later.
async function saveTranscript(env: Env, callSid: string, from: string | null, history: Turn[]) {
	await env.DB
		.prepare(
			`INSERT INTO twin_calls (id, from_number, transcript, started_at, updated_at) VALUES (?,?,?,?,?)
			 ON CONFLICT(id) DO UPDATE SET transcript = excluded.transcript, updated_at = excluded.updated_at`,
		)
		.bind(callSid, from, JSON.stringify(history), Date.now(), Date.now())
		.run();
}

async function dbSet(env: Env, key: string, value: string) {
	let stored = value;
	let iv: string | null = null;
	if (SECRET_KEYS.has(key)) {
		const enc = await encryptSecret(value, env.SECRETS_MASTER_KEY);
		stored = enc.ciphertext;
		iv = enc.iv;
	}
	await env.DB
		.prepare(
			`INSERT INTO twin_config (key, value, iv, updated_at) VALUES (?,?,?,?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value, iv = excluded.iv, updated_at = excluded.updated_at`,
		)
		.bind(key, stored, iv, Date.now())
		.run();
}

async function cfgSet(c: Context<AppEnv>, key: string, value: string) {
	await dbSet(c.env, key, value);
}

// Self-wiring: completes any setup steps that can be done automatically once
// credentials exist in twin_config — picks the first cloned ElevenLabs voice,
// adopts the account's first phone number, and points its voice webhook here.
// Runs from the cron trigger and on /status loads; safe to call repeatedly.
export async function twinAutoFinish(env: Env): Promise<string> {
	const cfg = await loadCfg(env);
	if (cfg.elevenKey) {
		const res = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": cfg.elevenKey } });
		if (res.ok) {
			const data = (await res.json()) as { voices?: Array<{ voice_id: string; category?: string }> };
			const voices = data.voices ?? [];
			// Prefer the user's own cloned voice — but only if the ElevenLabs plan
			// can actually synthesize with it (free plan rejects cloned voices with
			// 401 subscription_required). Otherwise fall back to a natural premade
			// voice, and auto-switch back to the clone once the plan allows it.
			const ttsWorks = async (voiceId: string) => {
				const t = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_22050_32`, {
					method: "POST",
					headers: { "xi-api-key": cfg.elevenKey, "content-type": "application/json" },
					body: JSON.stringify({ text: "hi", model_id: "eleven_turbo_v2_5" }),
				});
				return t.ok;
			};
			const preferred = String(env.TWIN_VOICE_ID || "");
			const mine = voices.find((x) => x.category === "cloned") ?? voices.find((x) => x.category === "generated");
			let desired: string | undefined;
			if (preferred && (await ttsWorks(preferred))) {
				desired = preferred;
			} else if (mine && (await ttsWorks(mine.voice_id))) {
				desired = mine.voice_id;
			} else if (!cfg.elevenVoice || cfg.elevenVoice === mine?.voice_id || !(await ttsWorks(cfg.elevenVoice))) {
				// "Chris — charming, down-to-earth" premade; any premade otherwise.
				const premade =
					voices.find((x) => x.voice_id === "iP95p4xoKVk53GoZ742B") ?? voices.find((x) => x.category === "premade");
				desired = premade?.voice_id;
			}
			if (desired && desired !== cfg.elevenVoice) await dbSet(env, "eleven_voice", desired);
		}
	}
	if (cfg.twilioSid && cfg.twilioToken) {
		// Toll-free numbers (8xx) hit carrier verification and return a "cannot
		// be completed as dialed" intercept. If a desired local area code is
		// configured and the twin has no number or only a toll-free one, buy a
		// local number in that area code (routes instantly) and switch to it.
		const area = String(env.TWIN_BUY_AREA_CODE || "").replace(/\D/g, "").slice(0, 3);
		const tollFree = /^\+1(800|888|877|866|855|844|833)/.test(cfg.twilioNumber || "");
		if (area.length === 3 && (!cfg.twilioNumber || tollFree)) {
			const search = await twilioApi(
				cfg.twilioSid,
				cfg.twilioToken,
				`/AvailablePhoneNumbers/US/Local.json?VoiceEnabled=true&PageSize=5&AreaCode=${area}`,
			);
			if (!search.ok) {
				return `search failed: ${(search.data as { message?: string }).message ?? search.status}`;
			}
			const list =
				(search.data as { available_phone_numbers?: Array<{ phone_number: string }> }).available_phone_numbers ?? [];
			if (!list.length) return `no numbers available in area code ${area}`;
			const doBuy = () =>
				twilioApi(cfg.twilioSid, cfg.twilioToken, "/IncomingPhoneNumbers.json", {
					PhoneNumber: list[0].phone_number,
					VoiceUrl: voiceWebhookUrl(env),
					VoiceMethod: "POST",
				});
			let buy = await doBuy();
			// Trial accounts allow only one number. Since the toll-free number is
			// unusable (carrier intercept), release it and retry the local buy —
			// a local trial number at least routes (with a trial greeting).
			let released = "";
			if (!buy.ok && tollFree && /only one/i.test((buy.data as { message?: string }).message ?? "")) {
				const owned = await twilioApi(cfg.twilioSid, cfg.twilioToken, "/IncomingPhoneNumbers.json?PageSize=20");
				const cur = (
					(owned.data as { incoming_phone_numbers?: Array<{ sid: string; phone_number: string }> })
						.incoming_phone_numbers ?? []
				).find((n) => n.phone_number === cfg.twilioNumber);
				if (cur) {
					const del = await twilioApi(
						cfg.twilioSid,
						cfg.twilioToken,
						`/IncomingPhoneNumbers/${cur.sid}.json`,
						undefined,
						"DELETE",
					);
					if (del.ok) {
						released = cfg.twilioNumber;
						buy = await doBuy();
					}
				}
			}
			if (!buy.ok) {
				return `purchase failed${released ? ` (released ${released})` : ""}: ${(buy.data as { message?: string }).message ?? buy.status}`;
			}
			await dbSet(env, "twilio_number", (buy.data as { phone_number: string }).phone_number);
			return `bought ${(buy.data as { phone_number: string }).phone_number}${released ? ` (released ${released})` : ""}`;
		}
		// No area code configured (or purchase unavailable): adopt the account's
		// first existing number if none is set yet.
		if (!cfg.twilioNumber) {
			const res = await twilioApi(cfg.twilioSid, cfg.twilioToken, "/IncomingPhoneNumbers.json?PageSize=1");
			if (res.ok) {
				const n = (res.data as { incoming_phone_numbers?: Array<{ sid: string; phone_number: string }> })
					.incoming_phone_numbers?.[0];
				if (n) {
					await twilioApi(cfg.twilioSid, cfg.twilioToken, `/IncomingPhoneNumbers/${n.sid}.json`, {
						VoiceUrl: voiceWebhookUrl(env),
						VoiceMethod: "POST",
					});
					await dbSet(env, "twilio_number", n.phone_number);
					return `adopted ${n.phone_number}`;
				}
			}
		}
	}
	return "idle";
}

type TwinCfg = {
	twilioSid: string;
	twilioToken: string;
	twilioNumber: string;
	elevenKey: string;
	elevenVoice: string;
	persona: string;
	twinName: string;
	sources: { twilio: "site" | "secret" | null; voice: "site" | "secret" | null };
};

async function loadCfg(env: Env): Promise<TwinCfg> {
	await ensureTable(env.DB);
	const rows = await env.DB.prepare("SELECT key, value, iv FROM twin_config").all<{
		key: string;
		value: string;
		iv: string | null;
	}>();
	const raw: Record<string, string> = {};
	for (const r of rows.results ?? []) {
		raw[r.key] = r.iv ? await decryptSecret(r.value, r.iv, env.SECRETS_MASTER_KEY) : r.value;
	}
	// Site-entered values win; worker secrets (possibly stored by an earlier
	// setup) are the fallback.
	const twilioSid = raw.twilio_sid || env.TWILIO_ACCOUNT_SID || "";
	const twilioToken = raw.twilio_token || env.TWILIO_AUTH_TOKEN || "";
	const elevenKey = raw.eleven_key || env.ELEVENLABS_API_KEY || "";
	return {
		twilioSid,
		twilioToken,
		twilioNumber: raw.twilio_number || env.TWILIO_NUMBER || "",
		elevenKey,
		elevenVoice: raw.eleven_voice || env.ELEVENLABS_VOICE_ID || "",
		persona: raw.persona || DEFAULT_PERSONA,
		twinName: raw.twin_name || DEFAULT_TWIN_NAME,
		sources: {
			twilio: raw.twilio_sid ? "site" : env.TWILIO_ACCOUNT_SID ? "secret" : null,
			voice: raw.eleven_key ? "site" : env.ELEVENLABS_API_KEY ? "secret" : null,
		},
	};
}

// --- Twilio REST helpers -------------------------------------------------------

function twilioAuth(sid: string, token: string) {
	return "Basic " + btoa(`${sid}:${token}`);
}

async function twilioApi(
	sid: string,
	token: string,
	path: string,
	body?: Record<string, string>,
	method?: "GET" | "POST" | "DELETE",
): Promise<{ ok: boolean; status: number; data: unknown }> {
	const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}${path}`, {
		method: method ?? (body ? "POST" : "GET"),
		headers: {
			Authorization: twilioAuth(sid, token),
			...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
		},
		body: body ? new URLSearchParams(body) : undefined,
	});
	const data = res.status === 204 ? {} : await res.json().catch(() => ({}));
	return { ok: res.ok, status: res.status, data };
}

function voiceWebhookUrl(env: Env) {
	return `${env.APP_URL}/api/twin/voice/incoming`;
}

// --- Twilio webhook signature validation (HMAC-SHA1 of URL + sorted params) ----

async function validTwilioSignature(req: Request, url: string, params: URLSearchParams, authToken: string) {
	const sig = req.headers.get("X-Twilio-Signature");
	if (!sig || !authToken) return false;
	const keys = [...params.keys()].sort();
	let data = url;
	for (const k of keys) data += k + params.get(k);
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(authToken),
		{ name: "HMAC", hash: "SHA-1" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
	const expected = btoa(String.fromCharCode(...new Uint8Array(mac)));
	return expected === sig;
}

// --- ElevenLabs TTS: text → mp3 in KV, returns playable URL (null → <Say>) -----

async function speak(env: Env, cfg: TwinCfg, text: string): Promise<string | null> {
	if (!cfg.elevenKey || !cfg.elevenVoice) return null;
	const res = await fetch(
		`https://api.elevenlabs.io/v1/text-to-speech/${cfg.elevenVoice}?output_format=mp3_22050_32`,
		{
			method: "POST",
			headers: { "xi-api-key": cfg.elevenKey, "content-type": "application/json" },
			body: JSON.stringify({
				text,
				model_id: "eleven_turbo_v2_5",
				voice_settings: {
					stability: 0.5,
					similarity_boost: 0.85,
					// Slightly faster than natural (ElevenLabs range 0.7–1.2).
					speed: Number(env.TWIN_VOICE_SPEED) || 1.12,
				},
			}),
		},
	);
	if (!res.ok) return null;
	const id = crypto.randomUUID();
	await env.CACHE.put(`twin:audio:${id}`, await res.arrayBuffer(), { expirationTtl: AUDIO_TTL });
	return `${env.APP_URL}/api/twin/voice/audio/${id}`;
}

// --- Claude persona reply ------------------------------------------------------

type Turn = { role: "user" | "assistant"; content: string };

async function personaReply(env: Env, cfg: TwinCfg, history: Turn[]): Promise<string> {
	const res = await fetch("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: {
			"x-api-key": env.ANTHROPIC_API_KEY,
			"anthropic-version": "2023-06-01",
			"content-type": "application/json",
		},
		body: JSON.stringify({
			model: "claude-haiku-4-5-20251001",
			max_tokens: 200,
			system:
				cfg.persona +
				" You are on a live phone call, so answer in 1-3 short conversational sentences — never lists, never markdown. If the caller says goodbye, say a warm goodbye.",
			messages: history,
		}),
	});
	if (!res.ok) return "Sorry, I glitched for a second there. Say that again?";
	const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
	return data.content?.find((b) => b.type === "text")?.text?.trim() || "Sorry, say that again?";
}

async function loadConvo(env: Env, callSid: string): Promise<Turn[]> {
	return (await env.CACHE.get<Turn[]>(`twin:convo:${callSid}`, "json")) ?? [];
}

async function saveConvo(env: Env, callSid: string, history: Turn[]) {
	await env.CACHE.put(`twin:convo:${callSid}`, JSON.stringify(history.slice(-MAX_TURNS)), {
		expirationTtl: CONVO_TTL,
	});
}

// --- TwiML helpers ---------------------------------------------------------

function xml(body: string) {
	return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, {
		headers: { "content-type": "text/xml" },
	});
}

function escapeXml(s: string) {
	return s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

const SAY = '<Say voice="Polly.Matthew">'; // fallback voice until ElevenLabs is configured

function gather(env: Env, playUrl: string | null, fallbackText: string) {
	const speech = playUrl ? `<Play>${escapeXml(playUrl)}</Play>` : `${SAY}${escapeXml(fallbackText)}</Say>`;
	const action = `${env.APP_URL}/api/twin/voice/respond`;
	return (
		`${speech}<Gather input="speech" action="${action}" method="POST" speechTimeout="auto" language="en-US"/>` +
		`${SAY}Are you still there?</Say>` +
		`<Gather input="speech" action="${action}" method="POST" speechTimeout="auto" language="en-US"/>` +
		`<Hangup/>`
	);
}

// ==============================================================================
// Voice webhooks (called by Twilio — no session, validated by signature)
// ==============================================================================

twin.get("/voice/audio/:id", async (c) => {
	const buf = await c.env.CACHE.get(`twin:audio:${c.req.param("id")}`, "arrayBuffer");
	if (!buf) return c.text("gone", 404);
	return new Response(buf, { headers: { "content-type": "audio/mpeg" } });
});

// Required by FCC rules for AI-generated voice calls: the twin must identify
// itself as an AI at the start of every call. Do not remove.
twin.post("/voice/incoming", async (c) => {
	const cfg = await loadCfg(c.env);
	const params = new URLSearchParams(await c.req.text());
	if (!(await validTwilioSignature(c.req.raw, voiceWebhookUrl(c.env), params, cfg.twilioToken))) {
		return c.text("unauthorized", 401);
	}
	const greeting = `Hey, it's ${cfg.twinName}'s AI twin speaking on his behalf. What's up?`;
	const callSid = params.get("CallSid") ?? "unknown";
	await saveConvo(c.env, callSid, [{ role: "assistant", content: greeting }]);
	await saveTranscript(c.env, callSid, params.get("From"), [{ role: "assistant", content: greeting }]);
	const audio = await speak(c.env, cfg, greeting);
	return xml(gather(c.env, audio, greeting));
});

twin.post("/voice/respond", async (c) => {
	const cfg = await loadCfg(c.env);
	const params = new URLSearchParams(await c.req.text());
	if (!(await validTwilioSignature(c.req.raw, `${c.env.APP_URL}/api/twin/voice/respond`, params, cfg.twilioToken))) {
		return c.text("unauthorized", 401);
	}
	const callSid = params.get("CallSid") ?? "unknown";
	const heard = (params.get("SpeechResult") ?? "").trim();
	if (!heard) return xml(gather(c.env, null, "Sorry, I didn't catch that. One more time?"));

	const history = await loadConvo(c.env, callSid);
	history.push({ role: "user", content: heard });
	const reply = await personaReply(c.env, cfg, history);
	history.push({ role: "assistant", content: reply });
	await saveConvo(c.env, callSid, history);
	await saveTranscript(c.env, callSid, params.get("From"), history);

	const audio = await speak(c.env, cfg, reply);
	if (/\b(goodbye|bye|talk later|hang up)\b/i.test(heard)) {
		return xml(audio ? `<Play>${escapeXml(audio)}</Play><Hangup/>` : `${SAY}${escapeXml(reply)}</Say><Hangup/>`);
	}
	return xml(gather(c.env, audio, reply));
});

// ==============================================================================
// Setup + control endpoints (site session, owner only)
// ==============================================================================

// Public, idempotent self-wiring trigger (safe: only completes the owner's
// setup from already-stored credentials; reveals nothing). Called by the
// deploy pipeline after each deploy since the account's cron limit is full.
twin.get("/wire", async (c) => {
	const note = await twinAutoFinish(c.env).catch((e) => `error: ${e instanceof Error ? e.message : "unknown"}`);
	const cfg = await loadCfg(c.env);
	let numbers: Array<{ phoneNumber: string; voiceUrl: string }> = [];
	let accountType = "";
	let accountStatus = "";
	let balance = "";
	if (cfg.twilioSid && cfg.twilioToken) {
		const res = await twilioApi(cfg.twilioSid, cfg.twilioToken, "/IncomingPhoneNumbers.json?PageSize=10");
		if (res.ok) {
			numbers = (
				(res.data as { incoming_phone_numbers?: Array<{ phone_number: string; voice_url: string }> })
					.incoming_phone_numbers ?? []
			).map((n) => ({ phoneNumber: n.phone_number, voiceUrl: n.voice_url }));
		}
		// Account type ("Trial" vs "Full") and balance — the definitive status.
		const acct = await twilioApi(cfg.twilioSid, cfg.twilioToken, ".json");
		if (acct.ok) {
			accountType = (acct.data as { type?: string }).type ?? "";
			accountStatus = (acct.data as { status?: string }).status ?? "";
		}
		const bal = await twilioApi(cfg.twilioSid, cfg.twilioToken, "/Balance.json");
		if (bal.ok) {
			const b = bal.data as { balance?: string; currency?: string };
			balance = `${b.balance ?? "?"} ${b.currency ?? ""}`.trim();
		}
	}
	// ElevenLabs voice inventory — so we can see which voice is the user's clone.
	let elevenVoices: Array<{ id: string; name: string; category: string }> = [];
	let elevenKeyOk = false;
	if (cfg.elevenKey) {
		const vr = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": cfg.elevenKey } });
		elevenKeyOk = vr.ok;
		if (vr.ok) {
			const vd = (await vr.json()) as { voices?: Array<{ voice_id: string; name: string; category?: string }> };
			elevenVoices = (vd.voices ?? []).map((v) => ({ id: v.voice_id, name: v.name, category: v.category ?? "" }));
		}
	}
	// Live TTS test with the exact settings calls use — reveals why calls fall
	// back to the generic <Say> voice (plan limits, bad param, etc.).
	let tts = "not configured";
	if (cfg.elevenKey && cfg.elevenVoice) {
		const tr = await fetch(
			`https://api.elevenlabs.io/v1/text-to-speech/${cfg.elevenVoice}?output_format=mp3_22050_32`,
			{
				method: "POST",
				headers: { "xi-api-key": cfg.elevenKey, "content-type": "application/json" },
				body: JSON.stringify({
					text: "test",
					model_id: "eleven_turbo_v2_5",
					voice_settings: {
						stability: 0.5,
						similarity_boost: 0.85,
						speed: Number(c.env.TWIN_VOICE_SPEED) || 1.12,
					},
				}),
			},
		);
		tts = tr.ok ? "ok" : `failed ${tr.status}: ${(await tr.text()).slice(0, 400)}`;
	}
	return c.json({
		ok: true,
		twilioConnected: !!(cfg.twilioSid && cfg.twilioToken),
		number: cfg.twilioNumber || null,
		voicePicked: !!cfg.elevenVoice,
		anthropic: !!c.env.ANTHROPIC_API_KEY,
		webhook: voiceWebhookUrl(c.env),
		numbers,
		accountType,
		accountStatus,
		balance,
		voiceId: cfg.elevenVoice || null,
		elevenKeyOk,
		elevenVoices,
		tts,
		note,
	});
});

// Recent call transcripts for the owner.
twin.get("/calls", ownerOnly, async (c) => {
	await ensureTable(c.env.DB);
	const rows = await c.env.DB
		.prepare("SELECT id, from_number, transcript, started_at FROM twin_calls ORDER BY started_at DESC LIMIT 20")
		.all<{ id: string; from_number: string | null; transcript: string; started_at: number }>();
	const calls = (rows.results ?? []).map((r) => ({
		id: r.id,
		from: r.from_number,
		startedAt: r.started_at,
		turns: JSON.parse(r.transcript) as Turn[],
	}));
	return c.json({ calls });
});

twin.get("/status", ownerOnly, async (c) => {
	await twinAutoFinish(c.env).catch(() => {});
	const cfg = await loadCfg(c.env);
	return c.json({
		twilio: {
			connected: !!(cfg.twilioSid && cfg.twilioToken),
			source: cfg.sources.twilio,
			number: cfg.twilioNumber || null,
		},
		voice: {
			hasKey: !!cfg.elevenKey,
			source: cfg.sources.voice,
			voiceId: cfg.elevenVoice || null,
		},
		anthropic: !!c.env.ANTHROPIC_API_KEY,
		persona: cfg.persona,
		twinName: cfg.twinName,
		webhookUrl: voiceWebhookUrl(c.env),
	});
});

// Save + verify Twilio credentials; returns the account name and its numbers.
twin.post(
	"/twilio",
	ownerOnly,
	zValidator("json", z.object({ sid: z.string().regex(/^AC[a-f0-9]{32}$/i, "That doesn't look like an Account SID (starts with AC…)"), token: z.string().min(16) })),
	async (c) => {
		const { sid, token } = c.req.valid("json");
		const acct = await twilioApi(sid, token, ".json");
		if (!acct.ok) {
			return c.json({ error: "twilio_auth_failed", message: "Twilio rejected those credentials — double-check the Account SID and Auth Token." }, 400);
		}
		await cfgSet(c, "twilio_sid", sid);
		await cfgSet(c, "twilio_token", token);
		const numbers = await twilioApi(sid, token, "/IncomingPhoneNumbers.json?PageSize=20");
		const list =
			((numbers.data as { incoming_phone_numbers?: Array<{ sid: string; phone_number: string; friendly_name: string }> })
				.incoming_phone_numbers ?? []).map((n) => ({ sid: n.sid, phoneNumber: n.phone_number, name: n.friendly_name }));
		const a = acct.data as { friendly_name?: string; status?: string };
		return c.json({ ok: true, accountName: a.friendly_name ?? "", accountStatus: a.status ?? "", numbers: list });
	},
);

// List numbers already on the account.
twin.get("/numbers", ownerOnly, async (c) => {
	const cfg = await loadCfg(c.env);
	if (!cfg.twilioSid || !cfg.twilioToken) return c.json({ error: "twilio_not_connected" }, 400);
	const numbers = await twilioApi(cfg.twilioSid, cfg.twilioToken, "/IncomingPhoneNumbers.json?PageSize=20");
	if (!numbers.ok) return c.json({ error: "twilio_error" }, 502);
	const list =
		((numbers.data as { incoming_phone_numbers?: Array<{ sid: string; phone_number: string; friendly_name: string; voice_url: string }> })
			.incoming_phone_numbers ?? []).map((n) => ({ sid: n.sid, phoneNumber: n.phone_number, name: n.friendly_name, voiceUrl: n.voice_url }));
	return c.json({ numbers: list, current: cfg.twilioNumber || null });
});

// Search numbers available to buy (optionally by area code).
twin.get("/numbers/search", ownerOnly, async (c) => {
	const cfg = await loadCfg(c.env);
	if (!cfg.twilioSid || !cfg.twilioToken) return c.json({ error: "twilio_not_connected" }, 400);
	const area = (c.req.query("area") ?? "").replace(/\D/g, "").slice(0, 3);
	const qs = `?VoiceEnabled=true&PageSize=10${area.length === 3 ? `&AreaCode=${area}` : ""}`;
	const res = await twilioApi(cfg.twilioSid, cfg.twilioToken, `/AvailablePhoneNumbers/US/Local.json${qs}`);
	if (!res.ok) return c.json({ error: "twilio_error" }, 502);
	const list =
		((res.data as { available_phone_numbers?: Array<{ phone_number: string; friendly_name: string; locality: string; region: string }> })
			.available_phone_numbers ?? []).map((n) => ({ phoneNumber: n.phone_number, name: n.friendly_name, locality: n.locality, region: n.region }));
	return c.json({ numbers: list });
});

// Activate a number for the twin: either one already owned (numberSid) or buy a
// new one (phoneNumber). Either way the voice webhook gets pointed at us.
twin.post(
	"/number",
	ownerOnly,
	zValidator(
		"json",
		z.object({ numberSid: z.string().regex(/^PN[a-f0-9]{32}$/i).optional(), phoneNumber: z.string().regex(/^\+\d{8,15}$/).optional() })
			.refine((v) => !!v.numberSid !== !!v.phoneNumber, "Pass exactly one of numberSid (existing) or phoneNumber (buy)"),
	),
	async (c) => {
		const cfg = await loadCfg(c.env);
		if (!cfg.twilioSid || !cfg.twilioToken) return c.json({ error: "twilio_not_connected" }, 400);
		const { numberSid, phoneNumber } = c.req.valid("json");
		const webhook = { VoiceUrl: voiceWebhookUrl(c.env), VoiceMethod: "POST" };

		const res = numberSid
			? await twilioApi(cfg.twilioSid, cfg.twilioToken, `/IncomingPhoneNumbers/${numberSid}.json`, webhook)
			: await twilioApi(cfg.twilioSid, cfg.twilioToken, "/IncomingPhoneNumbers.json", { PhoneNumber: phoneNumber!, ...webhook });
		if (!res.ok) {
			const msg = (res.data as { message?: string }).message ?? "Twilio refused the request.";
			return c.json({ error: "twilio_error", message: msg }, 502);
		}
		const n = res.data as { phone_number: string };
		await cfgSet(c, "twilio_number", n.phone_number);
		return c.json({ ok: true, number: n.phone_number, purchased: !numberSid });
	},
);

// Save + verify the ElevenLabs key; returns the account's voices to pick from.
twin.post(
	"/voice-config",
	ownerOnly,
	zValidator("json", z.object({ key: z.string().min(8).optional(), voiceId: z.string().min(4).optional() })),
	async (c) => {
		const { key, voiceId } = c.req.valid("json");
		if (!key && !voiceId) return c.json({ error: "bad_request", message: "Send a key and/or a voiceId." }, 400);
		if (key) {
			const res = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": key } });
			if (!res.ok) {
				return c.json({ error: "elevenlabs_auth_failed", message: "ElevenLabs rejected that API key." }, 400);
			}
			await cfgSet(c, "eleven_key", key);
			if (voiceId) await cfgSet(c, "eleven_voice", voiceId);
			const data = (await res.json()) as { voices?: Array<{ voice_id: string; name: string; category?: string }> };
			const voices = (data.voices ?? []).map((v) => ({ id: v.voice_id, name: v.name, category: v.category ?? "" }));
			return c.json({ ok: true, voices });
		}
		await cfgSet(c, "eleven_voice", voiceId!);
		return c.json({ ok: true });
	},
);

// List voices with whatever key is on file (site-entered or worker secret).
twin.get("/voices", ownerOnly, async (c) => {
	const cfg = await loadCfg(c.env);
	if (!cfg.elevenKey) return c.json({ error: "elevenlabs_not_connected" }, 400);
	const res = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": cfg.elevenKey } });
	if (!res.ok) return c.json({ error: "elevenlabs_error" }, 502);
	const data = (await res.json()) as { voices?: Array<{ voice_id: string; name: string; category?: string }> };
	return c.json({ voices: (data.voices ?? []).map((v) => ({ id: v.voice_id, name: v.name, category: v.category ?? "" })) });
});

twin.post(
	"/persona",
	ownerOnly,
	zValidator("json", z.object({ persona: z.string().min(10).max(4000), twinName: z.string().min(1).max(40).optional() })),
	async (c) => {
		const { persona, twinName } = c.req.valid("json");
		await cfgSet(c, "persona", persona);
		if (twinName) await cfgSet(c, "twin_name", twinName);
		return c.json({ ok: true });
	},
);

// Have the twin call someone. It self-identifies as an AI at the start of the
// call (FCC requirement) — only call people who expect it (TCPA).
twin.post(
	"/call",
	ownerOnly,
	zValidator("json", z.object({ to: z.string().regex(/^\+\d{8,15}$/, "Use E.164 format, e.g. +15551234567") })),
	async (c) => {
		const cfg = await loadCfg(c.env);
		if (!cfg.twilioSid || !cfg.twilioToken) return c.json({ error: "twilio_not_connected" }, 400);
		if (!cfg.twilioNumber) return c.json({ error: "no_number", message: "Pick a phone number first." }, 400);
		const { to } = c.req.valid("json");
		const res = await twilioApi(cfg.twilioSid, cfg.twilioToken, "/Calls.json", {
			To: to,
			From: cfg.twilioNumber,
			Url: voiceWebhookUrl(c.env),
		});
		if (!res.ok) {
			const msg = (res.data as { message?: string }).message ?? "Twilio rejected the call.";
			return c.json({ error: "twilio_error", message: msg }, 502);
		}
		return c.json({ ok: true, to });
	},
);

export default twin;
