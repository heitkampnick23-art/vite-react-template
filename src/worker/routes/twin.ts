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
	await db.batch([
		db.prepare(
			`CREATE TABLE IF NOT EXISTS twin_config (
				key TEXT PRIMARY KEY, value TEXT NOT NULL, iv TEXT, updated_at INTEGER NOT NULL
			)`,
		),
		db.prepare(
			`CREATE TABLE IF NOT EXISTS twin_calls (
				id TEXT PRIMARY KEY, from_number TEXT, transcript TEXT NOT NULL,
				started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
			)`,
		),
		db.prepare(
			`CREATE TABLE IF NOT EXISTS twin_contacts (
				id TEXT PRIMARY KEY, name TEXT NOT NULL COLLATE NOCASE UNIQUE, phone TEXT NOT NULL,
				notes TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
			)`,
		),
		db.prepare(
			`CREATE TABLE IF NOT EXISTS twin_texts (
				id TEXT PRIMARY KEY, direction TEXT NOT NULL, peer_number TEXT NOT NULL,
				body TEXT NOT NULL, created_at INTEGER NOT NULL
			)`,
		),
		db.prepare(
			`CREATE TABLE IF NOT EXISTS twin_callers (
				phone TEXT PRIMARY KEY, name TEXT, summary TEXT NOT NULL DEFAULT '',
				call_count INTEGER NOT NULL DEFAULT 0, last_call_at INTEGER,
				summarized_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
			)`,
		),
		db.prepare(
			`CREATE TABLE IF NOT EXISTS twin_facts (
				id TEXT PRIMARY KEY, fact TEXT NOT NULL, created_at INTEGER NOT NULL
			)`,
		),
		db.prepare(
			`CREATE TABLE IF NOT EXISTS twin_profiles (
				id TEXT PRIMARY KEY, name TEXT NOT NULL, persona TEXT NOT NULL,
				number TEXT UNIQUE, voice_id TEXT, voice_speed REAL,
				created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
			)`,
		),
	]);
	// Older deployments created twin_profiles without voice_speed; add it in
	// place (no-op error once it exists).
	await db.prepare("ALTER TABLE twin_profiles ADD COLUMN voice_speed REAL").run().catch(() => {});
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

// --- contacts + text log -------------------------------------------------------

type Contact = { id: string; name: string; phone: string; notes: string | null };

async function loadContacts(env: Env): Promise<Contact[]> {
	await ensureTable(env.DB);
	const rows = await env.DB
		.prepare("SELECT id, name, phone, notes FROM twin_contacts ORDER BY name")
		.all<Contact>();
	return rows.results ?? [];
}

async function upsertContact(env: Env, name: string, phone: string, notes?: string) {
	await ensureTable(env.DB);
	await env.DB
		.prepare(
			`INSERT INTO twin_contacts (id, name, phone, notes, created_at, updated_at) VALUES (?,?,?,?,?,?)
			 ON CONFLICT(name) DO UPDATE SET phone = excluded.phone,
				notes = COALESCE(excluded.notes, notes), updated_at = excluded.updated_at`,
		)
		.bind(crypto.randomUUID(), name.trim(), phone, notes ?? null, Date.now(), Date.now())
		.run();
}

// Normalize a US-ish phone string to E.164; null if it doesn't look like one.
function e164(raw: string): string | null {
	let d = raw.replace(/\D/g, "");
	if (d.length === 10) d = "1" + d;
	if (d.length < 8 || d.length > 15) return null;
	return "+" + d;
}

// Keep a log of real conversations (not owner↔twin control traffic) so the
// nightly digest and the dashboard can show them.
async function logText(env: Env, direction: "in" | "out", peer: string, body: string) {
	if (!peer || peer === env.TWIN_NOTIFY_CELL) return;
	await env.DB
		.prepare("INSERT INTO twin_texts (id, direction, peer_number, body, created_at) VALUES (?,?,?,?,?)")
		.bind(crypto.randomUUID(), direction, peer, body, Date.now())
		.run();
}

// --- "facts about the owner" memory --------------------------------------------
//
// Short owner-curated facts ("my address is …", "I'm out of town till Friday")
// the twin injects into every conversation so it can answer real questions.

type Fact = { id: string; fact: string; created_at: number };

async function loadFacts(env: Env): Promise<Fact[]> {
	await ensureTable(env.DB);
	const rows = await env.DB
		.prepare("SELECT id, fact, created_at FROM twin_facts ORDER BY created_at DESC LIMIT 60")
		.all<Fact>();
	return rows.results ?? [];
}

async function addFact(env: Env, fact: string) {
	await ensureTable(env.DB);
	await env.DB
		.prepare("INSERT INTO twin_facts (id, fact, created_at) VALUES (?,?,?)")
		.bind(crypto.randomUUID(), fact.trim().slice(0, 500), Date.now())
		.run();
}

// System-prompt block, capped so a long fact list can't crowd out the persona.
function factsBlock(twinName: string, facts: Fact[]): string {
	if (!facts.length) return "";
	let block = "";
	for (const f of facts) {
		if (block.length + f.fact.length > 3000) break;
		block += `\n- ${f.fact}`;
	}
	return ` Things you know about ${twinName} (use them to answer questions; don't volunteer private-sounding details unprompted):${block}`;
}

// --- caller memory -------------------------------------------------------------
//
// One row per phone number: how many times they've called, and a rolling
// Claude-written summary of past transcripts so the twin can greet repeat
// callers like it remembers them (it does).

type CallerMemory = {
	phone: string;
	name: string | null;
	summary: string;
	call_count: number;
	last_call_at: number | null;
	summarized_at: number;
};

async function getCaller(env: Env, phone: string): Promise<CallerMemory | null> {
	if (!phone) return null;
	return await env.DB
		.prepare("SELECT phone, name, summary, call_count, last_call_at, summarized_at FROM twin_callers WHERE phone = ?")
		.bind(phone)
		.first<CallerMemory>();
}

// Count a new call and fill in the name from contacts if we have it.
async function touchCaller(env: Env, phone: string) {
	const contact = (await loadContacts(env)).find((k) => k.phone === phone);
	await env.DB
		.prepare(
			`INSERT INTO twin_callers (phone, name, call_count, last_call_at, updated_at) VALUES (?,?,1,?,?)
			 ON CONFLICT(phone) DO UPDATE SET call_count = call_count + 1, last_call_at = excluded.last_call_at,
				name = COALESCE(name, excluded.name), updated_at = excluded.updated_at`,
		)
		.bind(phone, contact?.name ?? null, Date.now(), Date.now())
		.run();
}

// Fold any transcripts newer than the stored summary into it (runs in
// waitUntil — never on the caller's clock).
async function refreshCallerSummary(env: Env, phone: string) {
	if (!phone) return;
	const row = await getCaller(env, phone);
	const since = row?.summarized_at ?? 0;
	const calls = await env.DB
		.prepare(
			"SELECT transcript FROM twin_calls WHERE from_number = ? AND updated_at > ? ORDER BY started_at DESC LIMIT 5",
		)
		.bind(phone, since)
		.all<{ transcript: string }>();
	const fresh = calls.results ?? [];
	if (!fresh.length) return;
	const transcripts = fresh
		.map((r) => (JSON.parse(r.transcript) as Turn[]).map((t) => `${t.role === "user" ? "Caller" : "Twin"}: ${t.content}`).join("\n"))
		.join("\n---\n")
		.slice(0, 8000);
	const raw = await claude(
		env,
		`You maintain the caller-memory file for an AI phone twin. Merge the existing memory with the new call transcripts into an updated memory. ` +
			`Respond with ONLY JSON: {"name": "<caller's first name if they said or confirmed it, else null>", "summary": "<max 500 chars: who they are, what they've called about, anything promised or unresolved>"}`,
		[
			{
				role: "user",
				content: `Existing memory${row?.name ? ` (name: ${row.name})` : ""}: ${row?.summary || "(none)"}\n\nNew transcripts:\n${transcripts}`,
			},
		],
		400,
	);
	const m = raw?.match(/\{[\s\S]*\}/);
	if (!m) return;
	let parsed: { name?: string | null; summary?: string };
	try {
		parsed = JSON.parse(m[0]) as { name?: string | null; summary?: string };
	} catch {
		return;
	}
	if (!parsed.summary) return;
	await env.DB
		.prepare(
			`INSERT INTO twin_callers (phone, name, summary, summarized_at, updated_at) VALUES (?,?,?,?,?)
			 ON CONFLICT(phone) DO UPDATE SET summary = excluded.summary, name = COALESCE(excluded.name, name),
				summarized_at = excluded.summarized_at, updated_at = excluded.updated_at`,
		)
		.bind(phone, parsed.name ?? null, parsed.summary.slice(0, 600), Date.now(), Date.now())
		.run();
}

// Extra system-prompt context for a call from a known number.
function callerContext(mem: CallerMemory | null): string {
	if (!mem || (!mem.summary && !mem.name)) return "";
	return (
		` This caller has phoned ${mem.call_count} time(s) before.` +
		(mem.name ? ` Their name is ${mem.name}.` : "") +
		(mem.summary ? ` What you remember about them from past calls: ${mem.summary}` : "") +
		" Use this memory naturally — don't recite it."
	);
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
		// Keep the active number's SMS webhook pointed at the twin.
		if (cfg.twilioNumber) {
			const owned = await twilioApi(cfg.twilioSid, cfg.twilioToken, "/IncomingPhoneNumbers.json?PageSize=20");
			const cur = (
				(owned.data as { incoming_phone_numbers?: Array<{ sid: string; phone_number: string; sms_url?: string }> })
					.incoming_phone_numbers ?? []
			).find((n) => n.phone_number === cfg.twilioNumber);
			const smsUrl = `${env.APP_URL}/api/twin/sms/incoming`;
			if (cur && cur.sms_url !== smsUrl) {
				await twilioApi(cfg.twilioSid, cfg.twilioToken, `/IncomingPhoneNumbers/${cur.sid}.json`, {
					SmsUrl: smsUrl,
					SmsMethod: "POST",
				});
			}
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
		// Seed declared twins (TWIN_SEED_PROFILES, JSON: [{name, number,
		// voiceQuery, persona}]) so a twin can be stood up hands-free from a
		// deploy. Idempotent: a seed whose name already exists is skipped.
		const seeded = await seedProfiles(env, cfg).catch((e) => `seed error: ${e instanceof Error ? e.message : "unknown"}`);
		if (seeded) return seeded;
		// Keep at least one extra (non-primary) number on hand for extra twins
		// when TWIN_EXTRA_AREA_CODES is configured — tries the codes in order.
		// Idempotent: once any second number exists, this never buys again.
		const extraAreas = String(env.TWIN_EXTRA_AREA_CODES || "")
			.split(",")
			.map((s) => s.replace(/\D/g, ""))
			.filter((s) => s.length === 3);
		if (extraAreas.length && cfg.twilioNumber) {
			const owned = await twilioApi(cfg.twilioSid, cfg.twilioToken, "/IncomingPhoneNumbers.json?PageSize=50");
			if (owned.ok) {
				const nums =
					(owned.data as { incoming_phone_numbers?: Array<{ phone_number: string }> }).incoming_phone_numbers ?? [];
				if (!nums.some((n) => n.phone_number !== cfg.twilioNumber)) {
					const res = await buyExtraNumber(env, cfg, extraAreas);
					if (res.ok && res.number && env.TWIN_NOTIFY_CELL) {
						await twilioApi(cfg.twilioSid, cfg.twilioToken, "/Messages.json", {
							To: env.TWIN_NOTIFY_CELL,
							From: cfg.twilioNumber,
							Body: `Bought ${res.number} for your next twin. Attach it in the "More twins" card at generateai.build/twin.`,
						});
					}
					return res.ok ? `bought extra ${res.number}` : `extra number: ${res.note}`;
				}
			}
		}
	}
	return "idle";
}

// --- nightly digest ------------------------------------------------------------
//
// Once per local day, after TWIN_DIGEST_HOUR (default 9pm America/Chicago),
// text the owner a Claude-written summary of everything the twin handled in
// the last 24h. Idempotent — safe to call from cron, webhooks, and /wire; the
// digest_last config key gates it to one send per day.

export async function twinNightlyDigest(env: Env, force = false): Promise<string> {
	if (!env.TWIN_NOTIFY_CELL) return "no notify cell configured";
	const cfg = await loadCfg(env);
	if (!cfg.twilioSid || !cfg.twilioToken || !cfg.twilioNumber) return "twilio not ready";

	const tz = env.TWIN_TZ || "America/Chicago";
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone: tz,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		hour12: false,
	}).formatToParts(new Date());
	const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
	const today = `${get("year")}-${get("month")}-${get("day")}`;
	const hourNow = Number(get("hour"));
	const digestHour = Number(env.TWIN_DIGEST_HOUR) || 21;

	if (!force) {
		if (hourNow < digestHour) return `before ${digestHour}:00 ${tz}`;
		const last = await env.DB
			.prepare("SELECT value FROM twin_config WHERE key = 'digest_last'")
			.first<{ value: string }>();
		if (last?.value === today) return "already sent today";
	}

	const since = Date.now() - 24 * 3600 * 1000;
	const calls = await env.DB
		.prepare("SELECT from_number, transcript, started_at FROM twin_calls WHERE started_at > ? ORDER BY started_at")
		.bind(since)
		.all<{ from_number: string | null; transcript: string; started_at: number }>();
	const texts = await env.DB
		.prepare("SELECT direction, peer_number, body, created_at FROM twin_texts WHERE created_at > ? ORDER BY created_at")
		.bind(since)
		.all<{ direction: string; peer_number: string; body: string; created_at: number }>();
	const callRows = calls.results ?? [];
	const textRows = texts.results ?? [];
	if (!force && !callRows.length && !textRows.length) {
		await dbSet(env, "digest_last", today);
		return "no activity — skipped";
	}

	// Map numbers to names from contacts and caller memory.
	const names = new Map<string, string>();
	for (const k of await loadContacts(env)) names.set(k.phone, k.name);
	const callers = await env.DB.prepare("SELECT phone, name FROM twin_callers WHERE name IS NOT NULL").all<{ phone: string; name: string }>();
	for (const r of callers.results ?? []) if (!names.has(r.phone)) names.set(r.phone, r.name);
	const who = (n: string | null) => (n ? names.get(n) ?? n : "unknown");

	const fmtTime = (ts: number) =>
		new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(ts));
	const material = [
		...callRows.map((r) => {
			const turns = (JSON.parse(r.transcript) as Turn[])
				.map((t) => `${t.role === "user" ? "Caller" : "Twin"}: ${t.content}`)
				.join("\n");
			return `CALL at ${fmtTime(r.started_at)} from ${who(r.from_number)}:\n${turns}`;
		}),
		...textRows.map(
			(r) => `TEXT ${r.direction === "in" ? "from" : "to"} ${who(r.peer_number)} at ${fmtTime(r.created_at)}: ${r.body}`,
		),
	]
		.join("\n---\n")
		.slice(0, 12000);

	const summary = callRows.length || textRows.length
		? (await claude(
				env,
				`Write tonight's SMS digest for ${cfg.twinName} covering everything his AI phone twin handled today. ` +
					`Plain text only, no markdown, max 550 characters. Lead with anything that needs his follow-up, ` +
					`then one short line per call/conversation (who + gist). Use names, not numbers, where given.`,
				[{ role: "user", content: material || "(no activity)" }],
				400,
			)) ?? null
		: "Quiet day — your twin handled no calls or texts.";
	if (!summary) return "summarization failed";

	const res = await twilioApi(cfg.twilioSid, cfg.twilioToken, "/Messages.json", {
		To: env.TWIN_NOTIFY_CELL,
		From: cfg.twilioNumber,
		Body: `🌙 Twin digest: ${summary}`.slice(0, 1500),
	});
	if (!res.ok) return `send failed: ${(res.data as { message?: string }).message ?? res.status}`;
	await dbSet(env, "digest_last", today);
	return "sent";
}

type TwinCfg = {
	twilioSid: string;
	twilioToken: string;
	twilioNumber: string;
	elevenKey: string;
	elevenVoice: string;
	persona: string;
	twinName: string;
	voiceSpeed: number;
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
		voiceSpeed: Number(env.TWIN_VOICE_SPEED) || 1.12,
		sources: {
			twilio: raw.twilio_sid ? "site" : env.TWILIO_ACCOUNT_SID ? "secret" : null,
			voice: raw.eleven_key ? "site" : env.ELEVENLABS_API_KEY ? "secret" : null,
		},
	};
}

// --- multiple twins ------------------------------------------------------------
//
// Extra twins live in twin_profiles, each with its own number, name, persona,
// and (optionally) voice. Inbound webhooks resolve which twin a call/text is
// for by the numbers on the wire; everything else (contacts, facts, caller
// memory, credentials, the owner's cell) is shared.

type TwinProfile = {
	id: string;
	name: string;
	persona: string;
	number: string | null;
	voice_id: string | null;
	voice_speed: number | null;
};

async function loadProfiles(env: Env): Promise<TwinProfile[]> {
	await ensureTable(env.DB);
	const rows = await env.DB
		.prepare("SELECT id, name, persona, number, voice_id, voice_speed FROM twin_profiles ORDER BY created_at")
		.all<TwinProfile>();
	return rows.results ?? [];
}

function applyProfile(cfg: TwinCfg, p: TwinProfile): TwinCfg {
	return {
		...cfg,
		twinName: p.name,
		persona: p.persona,
		twilioNumber: p.number ?? cfg.twilioNumber,
		elevenVoice: p.voice_id || cfg.elevenVoice,
		voiceSpeed: p.voice_speed ?? cfg.voiceSpeed,
	};
}

// Resolve the twin a webhook belongs to. Inbound: To is the twin's number.
// Outbound (twin-initiated calls): From is the twin's number. The primary
// twin_config twin stays the default when nothing matches.
async function overlayProfile(env: Env, cfg: TwinCfg, nums: Array<string | null>): Promise<TwinCfg> {
	const candidates = nums.filter((n): n is string => !!n && n !== cfg.twilioNumber);
	if (!candidates.length) return cfg;
	const profiles = await loadProfiles(env);
	const hit = profiles.find((p) => p.number && candidates.includes(p.number));
	return hit ? applyProfile(cfg, hit) : cfg;
}

// Stand up twins declared in TWIN_SEED_PROFILES without any UI interaction:
// attach the named number (swapping the primary onto another owned number if
// the seed wants the current primary), resolve the voice by name — from the
// account's voices or, failing that, the ElevenLabs shared library — and text
// the owner when the twin goes live. Returns "" when there is nothing to do.
async function seedProfiles(env: Env, cfg: TwinCfg): Promise<string> {
	let seeds: Array<{ name?: string; number?: string; voiceQuery?: string; persona?: string; voiceSpeed?: number }>;
	try {
		seeds = JSON.parse(String(env.TWIN_SEED_PROFILES || "[]"));
	} catch {
		return "seed: invalid TWIN_SEED_PROFILES JSON";
	}
	if (!Array.isArray(seeds) || !seeds.length) return "";
	if (!cfg.twilioSid || !cfg.twilioToken) return "";
	const profiles = await loadProfiles(env);
	const clampSpeed = (s: number) => Math.min(1.2, Math.max(0.7, s));

	for (const seed of seeds) {
		if (!seed?.name || !seed.persona) continue;
		const existing = profiles.find((p) => p.name.toLowerCase() === seed.name!.toLowerCase());
		if (existing) {
			// The profile itself is never overwritten, but a changed seed
			// voiceSpeed is applied so voice tuning can ship from a deploy.
			if (typeof seed.voiceSpeed === "number" && clampSpeed(seed.voiceSpeed) !== existing.voice_speed) {
				await env.DB
					.prepare("UPDATE twin_profiles SET voice_speed = ?, updated_at = ? WHERE id = ?")
					.bind(clampSpeed(seed.voiceSpeed), Date.now(), existing.id)
					.run();
				return `seed: set ${seed.name} voice speed to ${clampSpeed(seed.voiceSpeed)}`;
			}
			continue;
		}
		const wanted = seed.number ? e164(seed.number) : null;

		const ownedRes = await twilioApi(cfg.twilioSid, cfg.twilioToken, "/IncomingPhoneNumbers.json?PageSize=50");
		if (!ownedRes.ok) return "seed: could not list numbers";
		const owned =
			(ownedRes.data as { incoming_phone_numbers?: Array<{ sid: string; phone_number: string }> })
				.incoming_phone_numbers ?? [];
		const target = wanted ? owned.find((n) => n.phone_number === wanted) : undefined;
		if (wanted && !target) return `seed: ${seed.name} wants ${wanted} but the account doesn't own it`;

		const webhook = {
			VoiceUrl: voiceWebhookUrl(env),
			VoiceMethod: "POST",
			SmsUrl: `${env.APP_URL}/api/twin/sms/incoming`,
			SmsMethod: "POST",
		};

		// Resolve the voice: account voices first, then the shared library. A
		// voice matches when its name contains every word of the query.
		let voiceId: string | null = null;
		if (seed.voiceQuery && cfg.elevenKey) {
			const words = seed.voiceQuery.toLowerCase().split(/\s+/).filter(Boolean);
			const matches = (name: string) => words.every((w) => name.toLowerCase().includes(w));
			const vr = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": cfg.elevenKey } });
			if (vr.ok) {
				const vd = (await vr.json()) as { voices?: Array<{ voice_id: string; name: string }> };
				voiceId = (vd.voices ?? []).find((v) => matches(v.name))?.voice_id ?? null;
			}
			if (!voiceId) {
				const sr = await fetch(
					`https://api.elevenlabs.io/v1/shared-voices?page_size=5&search=${encodeURIComponent(seed.voiceQuery)}`,
					{ headers: { "xi-api-key": cfg.elevenKey } },
				);
				if (sr.ok) {
					const sd = (await sr.json()) as {
						voices?: Array<{ public_owner_id: string; voice_id: string; name: string }>;
					};
					const hit = (sd.voices ?? []).find((v) => matches(v.name)) ?? sd.voices?.[0];
					if (hit) {
						const add = await fetch(`https://api.elevenlabs.io/v1/voices/add/${hit.public_owner_id}/${hit.voice_id}`, {
							method: "POST",
							headers: { "xi-api-key": cfg.elevenKey, "content-type": "application/json" },
							body: JSON.stringify({ new_name: hit.name }),
						});
						if (add.ok) voiceId = ((await add.json()) as { voice_id?: string }).voice_id ?? hit.voice_id;
					}
				}
			}
		}

		// The seed wants the current primary number: hand the primary role to
		// another owned number first, or — if there is none — turn the primary
		// twin itself into this persona instead of creating a profile.
		if (wanted && wanted === cfg.twilioNumber) {
			const alt = owned.find(
				(n) => n.phone_number !== wanted && !profiles.some((p) => p.number === n.phone_number),
			);
			if (alt) {
				await twilioApi(cfg.twilioSid, cfg.twilioToken, `/IncomingPhoneNumbers/${alt.sid}.json`, webhook);
				await dbSet(env, "twilio_number", alt.phone_number);
			} else {
				await dbSet(env, "persona", seed.persona);
				await dbSet(env, "twin_name", seed.name);
				if (voiceId) await dbSet(env, "eleven_voice", voiceId);
				return `seed: made ${seed.name} the primary twin on ${wanted}`;
			}
		}
		if (target) await twilioApi(cfg.twilioSid, cfg.twilioToken, `/IncomingPhoneNumbers/${target.sid}.json`, webhook);

		await env.DB
			.prepare(
				`INSERT INTO twin_profiles (id, name, persona, number, voice_id, voice_speed, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
			)
			.bind(
				crypto.randomUUID(),
				seed.name,
				seed.persona,
				wanted,
				voiceId,
				typeof seed.voiceSpeed === "number" ? clampSpeed(seed.voiceSpeed) : null,
				Date.now(),
				Date.now(),
			)
			.run();
		if (env.TWIN_NOTIFY_CELL && cfg.twilioNumber) {
			await twilioApi(cfg.twilioSid, cfg.twilioToken, "/Messages.json", {
				To: env.TWIN_NOTIFY_CELL,
				From: wanted ?? cfg.twilioNumber,
				Body: `${seed.name} is live${wanted ? ` on ${wanted}` : ""}${voiceId ? " with its own voice" : " (voice not found — pick one on /twin)"}. Call it and say hi.`,
			});
		}
		return `seeded ${seed.name}${wanted ? ` on ${wanted}` : ""}${voiceId ? "" : " (voice unresolved)"}`;
	}
	return "";
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

// Buy one local number, trying area codes in order, with both webhooks pointed
// here. The number is NOT made the primary twin's — it sits on the account
// ready to attach to an extra twin. Used by auto-wiring, the owner SMS command
// ("buy 651 number"), and the More-twins UI.
async function buyExtraNumber(
	env: Env,
	cfg: TwinCfg,
	areas: string[],
): Promise<{ ok: boolean; note: string; number?: string }> {
	if (!cfg.twilioSid || !cfg.twilioToken) return { ok: false, note: "Twilio isn't connected." };
	let lastNote = "no numbers available";
	for (const raw of areas) {
		const area = raw.replace(/\D/g, "").slice(0, 3);
		if (area.length !== 3) continue;
		const search = await twilioApi(
			cfg.twilioSid,
			cfg.twilioToken,
			`/AvailablePhoneNumbers/US/Local.json?VoiceEnabled=true&SmsEnabled=true&PageSize=5&AreaCode=${area}`,
		);
		const list =
			(search.data as { available_phone_numbers?: Array<{ phone_number: string }> }).available_phone_numbers ?? [];
		if (!search.ok || !list.length) {
			lastNote = `no numbers available in ${area}`;
			continue;
		}
		const buy = await twilioApi(cfg.twilioSid, cfg.twilioToken, "/IncomingPhoneNumbers.json", {
			PhoneNumber: list[0].phone_number,
			VoiceUrl: voiceWebhookUrl(env),
			VoiceMethod: "POST",
			SmsUrl: `${env.APP_URL}/api/twin/sms/incoming`,
			SmsMethod: "POST",
		});
		if (buy.ok) {
			return { ok: true, note: "bought", number: (buy.data as { phone_number: string }).phone_number };
		}
		const msg = (buy.data as { message?: string }).message ?? `error ${buy.status}`;
		// Account-level refusals (trial one-number limit, billing) fail for every
		// area code — stop instead of retrying the rest.
		if (/only one|upgrade|balance|billing/i.test(msg)) return { ok: false, note: msg };
		lastNote = msg;
	}
	return { ok: false, note: lastNote };
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
					// Per-twin speed; default slightly faster than natural
					// (ElevenLabs range 0.7–1.2).
					speed: cfg.voiceSpeed,
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

async function claude(env: Env, system: string, messages: Turn[], maxTokens = 300): Promise<string | null> {
	const res = await fetch("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: {
			"x-api-key": env.ANTHROPIC_API_KEY,
			"anthropic-version": "2023-06-01",
			"content-type": "application/json",
		},
		body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: maxTokens, system, messages }),
	});
	if (!res.ok) return null;
	const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
	return data.content?.find((b) => b.type === "text")?.text?.trim() || null;
}

async function personaReply(env: Env, cfg: TwinCfg, history: Turn[], extraContext = ""): Promise<string> {
	const reply = await claude(
		env,
		cfg.persona +
			extraContext +
			" You are on a live phone call, so answer in 1-3 short conversational sentences — never lists, never markdown. If the caller says goodbye, say a warm goodbye.",
		history,
		200,
	);
	return reply ?? "Sorry, I glitched for a second there. Say that again?";
}

// --- smart texting: owner texts the twin in plain English ----------------------
//
// "tell Jake I'll be there at 6" → looks Jake up in contacts, writes the text
// the way the owner would, sends it from the twin's number, confirms back.

type OwnerSmsAction =
	| { action: "send"; to?: string; toName?: string; message?: string }
	| { action: "add_contact"; name?: string; phone?: string }
	| { action: "remember"; fact?: string }
	| { action: "forget"; id?: string }
	| { action: "reply"; reply?: string };

function parseAction(raw: string | null): OwnerSmsAction | null {
	if (!raw) return null;
	const m = raw.match(/\{[\s\S]*\}/); // tolerate prose or code fences around the JSON
	if (!m) return null;
	try {
		return JSON.parse(m[0]) as OwnerSmsAction;
	} catch {
		return null;
	}
}

// Interpret an owner text and perform it. Returns the confirmation to text back.
async function smartOwnerSms(env: Env, cfg: TwinCfg, body: string): Promise<string> {
	const contacts = await loadContacts(env);
	const facts = await loadFacts(env);
	const send = (to: string, text: string) =>
		twilioApi(cfg.twilioSid, cfg.twilioToken, "/Messages.json", { To: to, From: cfg.twilioNumber, Body: text });

	const system =
		`You are the SMS command interpreter for ${cfg.twinName}'s AI phone twin. ` +
		`${cfg.twinName} (the owner) just texted the twin's number; work out what they want and respond with ONLY one JSON object, no other text.\n` +
		`Contacts:\n${contacts.map((c) => `- ${c.name}: ${c.phone}${c.notes ? ` (${c.notes})` : ""}`).join("\n") || "(none yet)"}\n` +
		`Stored facts about ${cfg.twinName} (id: fact):\n${facts.map((f) => `- ${f.id.slice(0, 8)}: ${f.fact}`).join("\n") || "(none yet)"}\n` +
		`Actions:\n` +
		`1. Relay a message to someone — {"action":"send","to":"+15551234567","toName":"Jake","message":"..."}. ` +
		`Resolve "to" from the contacts above or from a phone number written in the text. ` +
		`Write "message" exactly as ${cfg.twinName} would text it: first person, casual, brief, no signature. ` +
		`Since it comes from the twin's number, open with a short identifier like "It's ${cfg.twinName} — " unless the text already makes that obvious.\n` +
		`2. Save a contact — {"action":"add_contact","name":"Jake","phone":"+15551234567"}.\n` +
		`3. Remember a fact for future calls/texts ("remember I moved to unit 4B") — {"action":"remember","fact":"..."} with the fact rewritten as a clean standalone statement.\n` +
		`4. Forget a stored fact — {"action":"forget","id":"<8-char id from the list>"}.\n` +
		`5. Anything else (question, chat, unknown contact, ambiguous) — {"action":"reply","reply":"..."} with a short SMS answer, using the stored facts when relevant. ` +
		`If they want to message someone who isn't in contacts and gave no number, say you don't have that person yet and to text: add <name> <number>.\n` +
		`Owner's persona, for message style: ${cfg.persona.slice(0, 600)}`;

	const act = parseAction(await claude(env, system, [{ role: "user", content: body }], 400));
	if (!act) return "Hmm, I couldn't process that. Try: \"tell Jake I'll be there at 6\" or \"add Jake 9525551234\".";

	if (act.action === "remember") {
		if (!act.fact) return 'To store a fact, text: "remember <the fact>".';
		await addFact(env, act.fact);
		return `Got it, I'll remember: ${act.fact}`;
	}
	if (act.action === "forget") {
		const hit = act.id ? facts.find((f) => f.id.startsWith(act.id!)) : undefined;
		if (!hit) return "I couldn't tell which fact to forget — check the list on the /twin page.";
		await env.DB.prepare("DELETE FROM twin_facts WHERE id = ?").bind(hit.id).run();
		return `Forgotten: ${hit.fact}`;
	}
	if (act.action === "add_contact") {
		const phone = act.phone ? e164(act.phone) : null;
		if (!act.name || !phone) return 'To save a contact, text: "add Jake 9525551234".';
		await upsertContact(env, act.name, phone);
		return `Saved ${act.name} → ${phone}.`;
	}
	if (act.action === "send") {
		const to = act.to ? e164(act.to) : null;
		if (!to || !act.message) {
			return act.toName
				? `I don't have a number for ${act.toName}. Text: "add ${act.toName} 9525551234" and I'll remember them.`
				: "I couldn't figure out who to text. Include a name from contacts or a phone number.";
		}
		const res = await send(to, act.message);
		if (!res.ok) {
			const msg = (res.data as { message?: string }).message ?? `error ${res.status}`;
			return `Couldn't send to ${act.toName ?? to}: ${msg}`;
		}
		await logText(env, "out", to, act.message);
		return `Texted ${act.toName ?? to}${act.toName ? ` (${to})` : ""}: "${act.message}"`;
	}
	return act.reply || 'I can relay texts ("tell Jake I\'ll be there at 6") and save contacts ("add Jake 9525551234").';
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
	let cfg = await loadCfg(c.env);
	const params = new URLSearchParams(await c.req.text());
	if (!(await validTwilioSignature(c.req.raw, voiceWebhookUrl(c.env), params, cfg.twilioToken))) {
		return c.text("unauthorized", 401);
	}
	cfg = await overlayProfile(c.env, cfg, [params.get("To"), params.get("From")]);
	const from = params.get("From") ?? "";
	// Repeat callers get greeted like the twin remembers them — because it does.
	const mem = await getCaller(c.env, from).catch(() => null);
	const greeting =
		mem && mem.call_count > 0
			? `Hey${mem.name ? ` ${mem.name}` : ""}, it's ${cfg.twinName}'s AI twin again — good to hear from you. What's up?`
			: `Hey, it's ${cfg.twinName}'s AI twin speaking on his behalf. What's up?`;
	const callSid = params.get("CallSid") ?? "unknown";
	await saveConvo(c.env, callSid, [{ role: "assistant", content: greeting }]);
	await saveTranscript(c.env, callSid, params.get("From"), [{ role: "assistant", content: greeting }]);
	if (from) {
		// Count the call and fold any not-yet-summarized past transcripts into
		// memory (helps the /respond turns of this very call, and the next one).
		c.executionCtx.waitUntil(touchCaller(c.env, from).catch(() => {}));
		c.executionCtx.waitUntil(refreshCallerSummary(c.env, from).catch(() => {}));
	}
	c.executionCtx.waitUntil(twinNightlyDigest(c.env).then(() => undefined, () => {}));
	const audio = await speak(c.env, cfg, greeting);
	return xml(gather(c.env, audio, greeting));
});

twin.post("/voice/respond", async (c) => {
	let cfg = await loadCfg(c.env);
	const params = new URLSearchParams(await c.req.text());
	if (!(await validTwilioSignature(c.req.raw, `${c.env.APP_URL}/api/twin/voice/respond`, params, cfg.twilioToken))) {
		return c.text("unauthorized", 401);
	}
	cfg = await overlayProfile(c.env, cfg, [params.get("To"), params.get("From")]);
	const callSid = params.get("CallSid") ?? "unknown";
	const heard = (params.get("SpeechResult") ?? "").trim();
	if (!heard) return xml(gather(c.env, null, "Sorry, I didn't catch that. One more time?"));

	const history = await loadConvo(c.env, callSid);
	history.push({ role: "user", content: heard });

	// The moment a caller asks to be contacted or leaves a message, text the
	// owner immediately (once per call) — don't wait for a formal goodbye.
	if (
		c.env.TWIN_NOTIFY_CELL &&
		/(call me|text me|contact (me|him)|reach (me|him)|get back to me|leave .{0,15}message|message for|tell (him|nick)|have (him|nick) (call|text)|call.?back|pass (this|it|that) along)/i.test(heard) &&
		!(await c.env.CACHE.get(`twin:notified:${callSid}`))
	) {
		await c.env.CACHE.put(`twin:notified:${callSid}`, "1", { expirationTtl: 3600 });
		c.executionCtx.waitUntil(
			twilioApi(cfg.twilioSid, cfg.twilioToken, "/Messages.json", {
				To: c.env.TWIN_NOTIFY_CELL,
				From: cfg.twilioNumber,
				Body: `Someone wants you to contact them: ${params.get("From") ?? "unknown"}. They said: "${heard.slice(0, 200)}". Full transcript: generateai.build/twin`,
			}).then(() => undefined),
		);
	}

	// Escape hatch: caller urgently needs the real owner — bridge the call to
	// their cell (caller sees the twin's number so they know it's a transfer).
	if (
		c.env.TWIN_NOTIFY_CELL &&
		/(real (nick|person|human)|speak to nick|talk to nick|transfer me|urgent|emergency|actual (person|human)|right away)/i.test(heard)
	) {
		const msg = "You got it — connecting you to the real Nick right now. Hang tight.";
		history.push({ role: "assistant", content: `${msg} [transferring call]` });
		await saveConvo(c.env, callSid, history);
		await saveTranscript(c.env, callSid, params.get("From"), history);
		const lead = (await speak(c.env, cfg, msg).then((u) => (u ? `<Play>${escapeXml(u)}</Play>` : null))) ??
			`${SAY}${escapeXml(msg)}</Say>`;
		const action = `${c.env.APP_URL}/api/twin/voice/respond`;
		return xml(
			`${lead}<Dial callerId="${escapeXml(cfg.twilioNumber)}" timeout="25">${escapeXml(c.env.TWIN_NOTIFY_CELL)}</Dial>` +
				`${SAY}Looks like he could not pick up. I can take a message instead.</Say>` +
				`<Gather input="speech" action="${action}" method="POST" speechTimeout="auto" language="en-US"/>`,
		);
	}

	const mem = await getCaller(c.env, params.get("From") ?? "").catch(() => null);
	const facts = await loadFacts(c.env).catch(() => [] as Fact[]);
	const reply = await personaReply(c.env, cfg, history, factsBlock(cfg.twinName, facts) + callerContext(mem));
	history.push({ role: "assistant", content: reply });
	await saveConvo(c.env, callSid, history);
	await saveTranscript(c.env, callSid, params.get("From"), history);

	const audio = await speak(c.env, cfg, reply);
	if (/\b(goodbye|bye|talk later|hang up)\b/i.test(heard)) {
		// Fold this finished call into the caller's memory right away.
		const caller = params.get("From");
		if (caller) c.executionCtx.waitUntil(refreshCallerSummary(c.env, caller).catch(() => {}));
		// Text the owner a summary of the finished call.
		if (c.env.TWIN_NOTIFY_CELL && cfg.twilioNumber) {
			const from = caller ?? "unknown";
			const body = `Your twin just finished a call with ${from}. Last thing they said: "${heard.slice(0, 200)}". Full transcript: generateai.build/twin`;
			c.executionCtx.waitUntil(
				twilioApi(cfg.twilioSid, cfg.twilioToken, "/Messages.json", {
					To: c.env.TWIN_NOTIFY_CELL,
					From: cfg.twilioNumber,
					Body: body,
				}).then(() => undefined),
			);
		}
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
	c.executionCtx.waitUntil(twinNightlyDigest(c.env).then(() => undefined, () => {}));
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

// Inbound SMS to the twin's number. The owner texts it in plain English —
// "tell Jake I'll be there at 6" resolves the contact and writes the message
// in the owner's style; "add Jake 9525551234" saves a contact; the explicit
// "text <number>: <message>" form still works. Anyone else's text is
// forwarded to the owner's cell.
twin.post("/sms/incoming", async (c) => {
	let cfg = await loadCfg(c.env);
	const params = new URLSearchParams(await c.req.text());
	if (!(await validTwilioSignature(c.req.raw, `${c.env.APP_URL}/api/twin/sms/incoming`, params, cfg.twilioToken))) {
		return c.text("unauthorized", 401);
	}
	cfg = await overlayProfile(c.env, cfg, [params.get("To")]);
	const from = params.get("From") ?? "";
	const body = (params.get("Body") ?? "").trim();
	const send = (to: string, text: string) =>
		twilioApi(cfg.twilioSid, cfg.twilioToken, "/Messages.json", { To: to, From: cfg.twilioNumber, Body: text });
	if (from === c.env.TWIN_NOTIFY_CELL) {
		// Deterministic fast paths first; Claude handles everything else.
		const explicit = body.match(/^text\s+(\+?[\d\s().-]{10,16})\s*[:,-]\s*([\s\S]+)$/i);
		const addCmd = body.match(/^(?:add|save)(?:\s+contact)?\s+(.{1,40}?)\s+(\+?[\d\s().-]{10,16})$/i);
		const rememberCmd = body.match(/^remember[:,]?\s+([\s\S]{3,})$/i);
		const buyCmd = body.match(/^buy\s+(?:a\s+|me\s+)?(\d{3})\s*(?:number)?$/i);
		if (buyCmd) {
			const res = await buyExtraNumber(c.env, cfg, [buyCmd[1]]);
			await send(
				from,
				res.ok
					? `Bought ${res.number}. Attach it to a twin in the "More twins" card at generateai.build/twin.`
					: `Couldn't buy a ${buyCmd[1]} number: ${res.note}`,
			);
		} else if (rememberCmd) {
			await addFact(c.env, rememberCmd[1].trim());
			await send(from, `Got it, I'll remember: ${rememberCmd[1].trim().slice(0, 300)}`);
		} else if (explicit) {
			const to = e164(explicit[1]);
			if (to) {
				await send(to, explicit[2].trim());
				await logText(c.env, "out", to, explicit[2].trim());
				await send(from, `Sent to ${to}.`);
			} else {
				await send(from, "That number doesn't look right — use 10 digits or +E.164.");
			}
		} else if (addCmd && e164(addCmd[2])) {
			await upsertContact(c.env, addCmd[1], e164(addCmd[2])!);
			await send(from, `Saved ${addCmd[1].trim()} → ${e164(addCmd[2])}.`);
		} else if (body) {
			await send(from, await smartOwnerSms(c.env, cfg, body));
		}
	} else if (c.env.TWIN_NOTIFY_CELL) {
		await logText(c.env, "in", from, body);
		const contacts = await loadContacts(c.env);
		const known = contacts.find((k) => k.phone === from);
		await send(c.env.TWIN_NOTIFY_CELL, `Text to your twin from ${known ? `${known.name} (${from})` : from}: ${body.slice(0, 500)}`);
	}
	c.executionCtx.waitUntil(twinNightlyDigest(c.env).then(() => undefined, () => {}));
	return c.body("<Response></Response>", 200, { "content-type": "text/xml" });
});

// --- facts (owner) -------------------------------------------------------------

twin.get("/facts", ownerOnly, async (c) => {
	return c.json({ facts: await loadFacts(c.env) });
});

twin.post("/facts", ownerOnly, zValidator("json", z.object({ fact: z.string().min(3).max(500) })), async (c) => {
	await addFact(c.env, c.req.valid("json").fact);
	return c.json({ ok: true });
});

twin.delete("/facts/:id", ownerOnly, async (c) => {
	await ensureTable(c.env.DB);
	await c.env.DB.prepare("DELETE FROM twin_facts WHERE id = ?").bind(c.req.param("id")).run();
	return c.json({ ok: true });
});

// --- contacts (owner) ----------------------------------------------------------

twin.get("/contacts", ownerOnly, async (c) => {
	return c.json({ contacts: await loadContacts(c.env) });
});

twin.post(
	"/contacts",
	ownerOnly,
	zValidator(
		"json",
		z.object({ name: z.string().min(1).max(60), phone: z.string().min(7).max(20), notes: z.string().max(200).optional() }),
	),
	async (c) => {
		const { name, phone, notes } = c.req.valid("json");
		const normalized = e164(phone);
		if (!normalized) return c.json({ error: "bad_phone", message: "Use a 10-digit US number or +E.164." }, 400);
		await upsertContact(c.env, name, normalized, notes);
		return c.json({ ok: true, phone: normalized });
	},
);

twin.delete("/contacts/:id", ownerOnly, async (c) => {
	await ensureTable(c.env.DB);
	await c.env.DB.prepare("DELETE FROM twin_contacts WHERE id = ?").bind(c.req.param("id")).run();
	return c.json({ ok: true });
});

// Carrier dial codes to forward the owner's personal number's missed calls to
// a twin, prefilled with that twin's number. Dialed from the personal phone.
// ?number= picks which twin receives the calls (default: the main twin);
// only the main number or a profile's number is accepted.
twin.get("/forwarding", ownerOnly, async (c) => {
	const cfg = await loadCfg(c.env);
	if (!cfg.twilioNumber) return c.json({ error: "no_number", message: "Pick a phone number for the twin first." }, 400);
	const profiles = await loadProfiles(c.env);
	const requested = c.req.query("number") ?? "";
	const twinNumbers = [
		{ name: cfg.twinName, number: cfg.twilioNumber },
		...profiles.filter((p) => p.number).map((p) => ({ name: p.name, number: p.number! })),
	];
	const chosen = twinNumbers.find((t) => t.number === requested) ?? twinNumbers[0];
	const digits = chosen.number.replace(/\D/g, ""); // 13205551234
	const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
	return c.json({
		number: chosen.number,
		twinName: chosen.name,
		targets: twinNumbers,
		carriers: [
			{
				carrier: "AT&T, T-Mobile & most GSM carriers",
				activate: [{ label: "Forward missed + busy + unreachable calls", code: `**004*${digits}#` }],
				deactivate: "##004#",
			},
			{
				carrier: "AT&T / T-Mobile — pick conditions individually",
				activate: [
					{ label: "When you don't answer", code: `**61*${digits}#` },
					{ label: "When your phone is off / no signal", code: `**62*${digits}#` },
					{ label: "When you're on the other line", code: `**67*${digits}#` },
				],
				deactivate: "##004#",
			},
			{
				carrier: "Verizon",
				activate: [{ label: "Forward missed + busy calls", code: `*71${ten}` }],
				deactivate: "*73",
			},
		],
		notes: [
			"Dial the code from your personal phone (the one being forwarded), then press call — the carrier confirms with a tone or banner.",
			"Only unanswered/busy/unreachable calls forward; calls you pick up are untouched.",
			"Test it: have someone call your personal number and don't answer — your twin should pick up.",
			"Forwarded minutes may bill against your carrier plan.",
		],
	});
});

// Public, idempotent digest trigger (like /wire): sends at most one digest per
// local day, only after the digest hour, and reveals nothing. Point any
// external scheduler at this URL for a guaranteed nightly send.
twin.get("/digest/run", async (c) => {
	const note = await twinNightlyDigest(c.env).catch((e) => `error: ${e instanceof Error ? e.message : "unknown"}`);
	return c.json({ ok: true, note });
});

// Owner-only: send the digest right now regardless of the daily gate.
twin.post("/digest/send", ownerOnly, async (c) => {
	const note = await twinNightlyDigest(c.env, true).catch((e) => `error: ${e instanceof Error ? e.message : "unknown"}`);
	return c.json({ ok: note === "sent", note });
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

// Buy an extra number (not made primary) for use with extra twins. Tries the
// given area code, falling back through TWIN_EXTRA_AREA_CODES.
twin.post(
	"/numbers/buy",
	ownerOnly,
	zValidator("json", z.object({ area: z.string().regex(/^\d{3}$/, "Three-digit area code") })),
	async (c) => {
		const cfg = await loadCfg(c.env);
		if (!cfg.twilioSid || !cfg.twilioToken) return c.json({ error: "twilio_not_connected" }, 400);
		const fallbacks = String(c.env.TWIN_EXTRA_AREA_CODES || "").split(",");
		const res = await buyExtraNumber(c.env, cfg, [c.req.valid("json").area, ...fallbacks]);
		if (!res.ok) return c.json({ error: "twilio_error", message: res.note }, 502);
		return c.json({ ok: true, number: res.number });
	},
);

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

// Search the public ElevenLabs voice library (shared voices) by name/keyword.
twin.get("/voices/search", ownerOnly, async (c) => {
	const cfg = await loadCfg(c.env);
	if (!cfg.elevenKey) return c.json({ error: "elevenlabs_not_connected" }, 400);
	const q = (c.req.query("q") ?? "").slice(0, 80);
	const res = await fetch(`https://api.elevenlabs.io/v1/shared-voices?page_size=10&search=${encodeURIComponent(q)}`, {
		headers: { "xi-api-key": cfg.elevenKey },
	});
	if (!res.ok) return c.json({ error: "elevenlabs_error", message: (await res.text()).slice(0, 300) }, 502);
	const data = (await res.json()) as {
		voices?: Array<{ public_owner_id: string; voice_id: string; name: string; category?: string; description?: string }>;
	};
	return c.json({
		voices: (data.voices ?? []).map((v) => ({
			publicOwnerId: v.public_owner_id,
			voiceId: v.voice_id,
			name: v.name,
			category: v.category ?? "",
			description: (v.description ?? "").slice(0, 140),
		})),
	});
});

// Add a library voice to the account so it shows up in /voices and can be
// assigned to a twin.
twin.post(
	"/voices/add",
	ownerOnly,
	zValidator("json", z.object({ publicOwnerId: z.string().min(8), voiceId: z.string().min(4), name: z.string().min(1).max(80) })),
	async (c) => {
		const cfg = await loadCfg(c.env);
		if (!cfg.elevenKey) return c.json({ error: "elevenlabs_not_connected" }, 400);
		const { publicOwnerId, voiceId, name } = c.req.valid("json");
		const res = await fetch(`https://api.elevenlabs.io/v1/voices/add/${publicOwnerId}/${voiceId}`, {
			method: "POST",
			headers: { "xi-api-key": cfg.elevenKey, "content-type": "application/json" },
			body: JSON.stringify({ new_name: name }),
		});
		if (!res.ok) return c.json({ error: "elevenlabs_error", message: (await res.text()).slice(0, 300) }, 502);
		const data = (await res.json()) as { voice_id?: string };
		return c.json({ ok: true, voiceId: data.voice_id ?? voiceId });
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
// call (FCC requirement) — only call people who expect it (TCPA). Pass
// profileId to place the call as one of the extra twins (its number/persona).
twin.post(
	"/call",
	ownerOnly,
	zValidator(
		"json",
		z.object({
			to: z.string().regex(/^\+\d{8,15}$/, "Use E.164 format, e.g. +15551234567"),
			profileId: z.string().optional(),
		}),
	),
	async (c) => {
		let cfg = await loadCfg(c.env);
		if (!cfg.twilioSid || !cfg.twilioToken) return c.json({ error: "twilio_not_connected" }, 400);
		const { to, profileId } = c.req.valid("json");
		if (profileId) {
			const p = (await loadProfiles(c.env)).find((x) => x.id === profileId);
			if (!p) return c.json({ error: "profile_not_found" }, 404);
			if (!p.number) return c.json({ error: "no_number", message: "That twin has no phone number yet." }, 400);
			cfg = applyProfile(cfg, p);
		}
		if (!cfg.twilioNumber) return c.json({ error: "no_number", message: "Pick a phone number first." }, 400);
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

// --- multiple twins (owner) ----------------------------------------------------

twin.get("/profiles", ownerOnly, async (c) => {
	const profiles = await loadProfiles(c.env);
	return c.json({
		profiles: profiles.map((p) => ({
			id: p.id,
			name: p.name,
			persona: p.persona,
			number: p.number,
			voiceId: p.voice_id,
			voiceSpeed: p.voice_speed,
		})),
	});
});

// Create or update an extra twin. Attach a number either from the account
// (numberSid) or by buying one (phoneNumber); its voice + SMS webhooks are
// pointed at this worker, and inbound traffic routes to this twin's persona.
twin.post(
	"/profiles",
	ownerOnly,
	zValidator(
		"json",
		z.object({
			id: z.string().optional(),
			name: z.string().min(1).max(40),
			persona: z.string().min(10).max(4000),
			voiceId: z.string().min(4).optional(),
			voiceSpeed: z.number().min(0.7).max(1.2).optional(),
			numberSid: z.string().regex(/^PN[a-f0-9]{32}$/i).optional(),
			phoneNumber: z.string().regex(/^\+\d{8,15}$/).optional(),
		}),
	),
	async (c) => {
		const cfg = await loadCfg(c.env);
		const { id, name, persona, voiceId, voiceSpeed, numberSid, phoneNumber } = c.req.valid("json");
		if ((numberSid || phoneNumber) && (!cfg.twilioSid || !cfg.twilioToken)) {
			return c.json({ error: "twilio_not_connected" }, 400);
		}
		let number: string | null = null;
		if (numberSid || phoneNumber) {
			const webhook = {
				VoiceUrl: voiceWebhookUrl(c.env),
				VoiceMethod: "POST",
				SmsUrl: `${c.env.APP_URL}/api/twin/sms/incoming`,
				SmsMethod: "POST",
			};
			const res = numberSid
				? await twilioApi(cfg.twilioSid, cfg.twilioToken, `/IncomingPhoneNumbers/${numberSid}.json`, webhook)
				: await twilioApi(cfg.twilioSid, cfg.twilioToken, "/IncomingPhoneNumbers.json", { PhoneNumber: phoneNumber!, ...webhook });
			if (!res.ok) {
				const msg = (res.data as { message?: string }).message ?? "Twilio refused the request.";
				return c.json({ error: "twilio_error", message: msg }, 502);
			}
			number = (res.data as { phone_number: string }).phone_number;
			if (number === cfg.twilioNumber) {
				return c.json({ error: "number_in_use", message: "That's the primary twin's number — pick a different one." }, 400);
			}
		}
		const profileId = id ?? crypto.randomUUID();
		try {
			await c.env.DB
				.prepare(
					`INSERT INTO twin_profiles (id, name, persona, number, voice_id, voice_speed, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)
					 ON CONFLICT(id) DO UPDATE SET name = excluded.name, persona = excluded.persona,
						number = COALESCE(excluded.number, number), voice_id = COALESCE(excluded.voice_id, voice_id),
						voice_speed = COALESCE(excluded.voice_speed, voice_speed), updated_at = excluded.updated_at`,
				)
				.bind(profileId, name, persona, number, voiceId ?? null, voiceSpeed ?? null, Date.now(), Date.now())
				.run();
		} catch {
			return c.json({ error: "number_in_use", message: "Another twin already uses that number." }, 400);
		}
		return c.json({ ok: true, id: profileId, number });
	},
);

// Remove an extra twin. Its Twilio number stays on the account (release it
// from the Twilio console if it's no longer wanted).
twin.delete("/profiles/:id", ownerOnly, async (c) => {
	await ensureTable(c.env.DB);
	await c.env.DB.prepare("DELETE FROM twin_profiles WHERE id = ?").bind(c.req.param("id")).run();
	return c.json({ ok: true });
});

export default twin;
