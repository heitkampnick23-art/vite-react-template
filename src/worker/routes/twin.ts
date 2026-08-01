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

// Clips are content-addressed, so a long TTL is what makes stock lines
// (greetings, retries, the transfer line) replay without re-synthesizing.
const AUDIO_TTL = 86_400;
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

// Schema setup costs six D1 round trips, and it ran on every webhook — pure
// dead time on a live call. Once per isolate is enough; a cold start redoes it.
let tablesReady = false;

async function ensureTable(db: D1Database) {
	if (tablesReady) return;
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
		db.prepare(
			`CREATE TABLE IF NOT EXISTS twin_answers (
				id TEXT PRIMARY KEY, payload TEXT NOT NULL, created_at INTEGER NOT NULL
			)`,
		),
	]);
	// Older deployments created twin_profiles without voice_speed; add it in
	// place (no-op error once it exists).
	await db.prepare("ALTER TABLE twin_profiles ADD COLUMN voice_speed REAL").run().catch(() => {});
	tablesReady = true;
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

// Find a voice by word-matching the query against the account's ElevenLabs
// voices, then the shared library (auto-adding a library match to the
// account). Every query word must appear in the voice name; if no library
// name matches, the search's top-ranked result is used.
async function resolveVoice(cfg: TwinCfg, voiceQuery: string): Promise<string | null> {
	if (!cfg.elevenKey) return null;
	const words = voiceQuery.toLowerCase().split(/\s+/).filter(Boolean);
	const matches = (name: string) => words.every((w) => name.toLowerCase().includes(w));
	const vr = await fetch("https://api.elevenlabs.io/v1/voices", { headers: { "xi-api-key": cfg.elevenKey } });
	if (vr.ok) {
		const vd = (await vr.json()) as { voices?: Array<{ voice_id: string; name: string }> };
		const hit = (vd.voices ?? []).find((v) => matches(v.name))?.voice_id;
		if (hit) return hit;
	}
	const sr = await fetch(
		`https://api.elevenlabs.io/v1/shared-voices?page_size=5&search=${encodeURIComponent(voiceQuery)}`,
		{ headers: { "xi-api-key": cfg.elevenKey } },
	);
	if (!sr.ok) return null;
	const sd = (await sr.json()) as { voices?: Array<{ public_owner_id: string; voice_id: string; name: string }> };
	const hit = (sd.voices ?? []).find((v) => matches(v.name)) ?? sd.voices?.[0];
	if (!hit) return null;
	const add = await fetch(`https://api.elevenlabs.io/v1/voices/add/${hit.public_owner_id}/${hit.voice_id}`, {
		method: "POST",
		headers: { "xi-api-key": cfg.elevenKey, "content-type": "application/json" },
		body: JSON.stringify({ new_name: hit.name }),
	});
	if (!add.ok) return null;
	return ((await add.json()) as { voice_id?: string }).voice_id ?? hit.voice_id;
}

// Stand up twins declared in TWIN_SEED_PROFILES without any UI interaction:
// attach the named number (swapping the primary onto another owned number if
// the seed wants the current primary), resolve the voice by name — from the
// account's voices or, failing that, the ElevenLabs shared library — and text
// the owner when the twin goes live. Returns "" when there is nothing to do.
async function seedProfiles(env: Env, cfg: TwinCfg): Promise<string> {
	let seeds: Array<{
		name?: string;
		number?: string;
		voiceQuery?: string;
		persona?: string;
		voiceSpeed?: number;
		rev?: number;
	}>;
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
			// Never overwrite an existing profile wholesale — but when the seed's
			// rev is bumped, re-resolve and apply its voice + speed exactly once,
			// so voice tuning can ship from a deploy. (Persona edits made in the
			// UI are preserved.)
			const rev = typeof seed.rev === "number" ? seed.rev : 0;
			const revKey = `seed_rev:${seed.name.toLowerCase()}`;
			const stored = Number(
				(await env.DB.prepare("SELECT value FROM twin_config WHERE key = ?").bind(revKey).first<{ value: string }>())
					?.value ?? 0,
			);
			if (rev > stored) {
				const voiceId = seed.voiceQuery ? await resolveVoice(cfg, seed.voiceQuery) : null;
				await env.DB
					.prepare(
						"UPDATE twin_profiles SET voice_id = COALESCE(?, voice_id), voice_speed = COALESCE(?, voice_speed), updated_at = ? WHERE id = ?",
					)
					.bind(
						voiceId,
						typeof seed.voiceSpeed === "number" ? clampSpeed(seed.voiceSpeed) : null,
						Date.now(),
						existing.id,
					)
					.run();
				await dbSet(env, revKey, String(rev));
				if (voiceId && env.TWIN_NOTIFY_CELL && existing.number) {
					await twilioApi(cfg.twilioSid, cfg.twilioToken, "/Messages.json", {
						To: env.TWIN_NOTIFY_CELL,
						From: existing.number,
						Body: `${seed.name} has a new voice — call ${existing.number} and hear it.`,
					});
				}
				return `seed: updated ${seed.name} rev ${rev}${voiceId ? "" : " (voice unresolved)"}`;
			}
			// Legacy path (no rev in the seed): apply a changed voiceSpeed.
			if (typeof seed.rev !== "number" && typeof seed.voiceSpeed === "number" && clampSpeed(seed.voiceSpeed) !== existing.voice_speed) {
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

		// Resolve the voice: account voices first, then the shared library.
		const voiceId = seed.voiceQuery ? await resolveVoice(cfg, seed.voiceQuery) : null;

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
		if (typeof seed.rev === "number") await dbSet(env, `seed_rev:${seed.name.toLowerCase()}`, String(seed.rev));
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

// --- A2P 10DLC registration (sole proprietor), driven via Twilio's API --------
//
// US carriers drop texts from unregistered local numbers (error 30034). This
// walks the whole Sole Proprietor registration server-side with the stored
// credentials: starter customer profile → sole-prop trust product → brand
// (Twilio texts the owner an OTP link) → messaging service with both twin
// numbers → campaign. Every created resource SID is persisted in twin_config,
// so the flow is resumable — rerun it after fixing an error or tapping the
// OTP link and it picks up where it left off.

async function twilioForm(
	sid: string,
	token: string,
	url: string,
	body?: Record<string, string | string[]>,
	method?: "GET" | "POST",
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
	const params = new URLSearchParams();
	for (const [k, v] of Object.entries(body ?? {})) {
		if (Array.isArray(v)) for (const item of v) params.append(k, item);
		else params.append(k, v);
	}
	const res = await fetch(url, {
		method: method ?? (body ? "POST" : "GET"),
		headers: {
			Authorization: twilioAuth(sid, token),
			...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
		},
		body: body ? params : undefined,
	});
	const data = ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
	return { ok: res.ok, status: res.status, data };
}

async function cfgGet(env: Env, key: string): Promise<string> {
	await ensureTable(env.DB);
	const row = await env.DB.prepare("SELECT value FROM twin_config WHERE key = ?").bind(key).first<{ value: string }>();
	return row?.value ?? "";
}

const TRUSTHUB = "https://trusthub.twilio.com/v1";
const MESSAGING = "https://messaging.twilio.com/v1";
// Twilio's published policy SIDs for the starter profile and sole-prop trust product.
const STARTER_PROFILE_POLICY = "RN806dd6cd175f314e1f96a9727ee271f4";
const SOLE_PROP_POLICY = "RNb0d4771c2c98518d916a3d4cd70a8f8b";

type A2pStep = { step: string; ok: boolean; note: string };

async function a2pRegister(
	env: Env,
	cfg: TwinCfg,
	info: { firstName: string; lastName: string; email: string; phone: string; street: string; city: string; region: string; postalCode: string },
): Promise<{ steps: A2pStep[]; done: boolean; next: string }> {
	const steps: A2pStep[] = [];
	const S = cfg.twilioSid;
	const T = cfg.twilioToken;
	const err = (d: Record<string, unknown>, status: number) => String(d.message ?? `HTTP ${status}`);
	// Runs one create-step: reuse the stored SID, otherwise call Twilio and
	// persist the returned SID. Returns "" on failure (recorded in steps).
	const ensure = async (key: string, label: string, make: () => Promise<{ ok: boolean; status: number; data: Record<string, unknown> }>, sidField = "sid"): Promise<string> => {
		const existing = await cfgGet(env, key);
		if (existing) {
			steps.push({ step: label, ok: true, note: "already done" });
			return existing;
		}
		const res = await make();
		const sid = String(res.data[sidField] ?? "");
		if (!res.ok || !sid) {
			steps.push({ step: label, ok: false, note: err(res.data, res.status) });
			return "";
		}
		await dbSet(env, key, sid);
		steps.push({ step: label, ok: true, note: sid });
		return sid;
	};

	// 1. Street address (carrier requirement).
	const addressSid = await ensure("a2p_address", "Street address", () =>
		twilioForm(S, T, `https://api.twilio.com/2010-04-01/Accounts/${S}/Addresses.json`, {
			CustomerName: `${info.firstName} ${info.lastName}`,
			Street: info.street,
			City: info.city,
			Region: info.region,
			PostalCode: info.postalCode,
			IsoCountry: "US",
			FriendlyName: "Twin owner address",
		}),
	);
	if (!addressSid) return { steps, done: false, next: "Fix the address fields and rerun." };

	// 2. Starter customer profile: person end-user + address doc, evaluated + submitted.
	const endUserSid = await ensure("a2p_enduser", "Owner identity", () =>
		twilioForm(S, T, `${TRUSTHUB}/EndUsers`, {
			FriendlyName: "Twin owner",
			Type: "starter_customer_profile_information",
			Attributes: JSON.stringify({
				first_name: info.firstName,
				last_name: info.lastName,
				email: info.email,
				phone_number: info.phone,
			}),
		}),
	);
	const docSid = endUserSid
		? await ensure("a2p_doc", "Address document", () =>
				// Twilio's TrustHub API expects address_sids as a single SID string
				// (despite the plural name) — an array gets "Unable to process JSON".
				twilioForm(S, T, `${TRUSTHUB}/SupportingDocuments`, {
					FriendlyName: "Twin owner address",
					Type: "customer_profile_address",
					Attributes: JSON.stringify({ address_sids: addressSid }),
				}),
			)
		: "";
	const profileSid = docSid
		? await ensure("a2p_profile", "Customer profile", () =>
				twilioForm(S, T, `${TRUSTHUB}/CustomerProfiles`, {
					FriendlyName: "Twin owner profile",
					Email: info.email,
					PolicySid: STARTER_PROFILE_POLICY,
				}),
			)
		: "";
	if (!profileSid) return { steps, done: false, next: "Fix the failed step above and rerun." };
	if (!(await cfgGet(env, "a2p_profile_submitted"))) {
		for (const objectSid of [endUserSid, docSid]) {
			const assign = await twilioForm(S, T, `${TRUSTHUB}/CustomerProfiles/${profileSid}/EntityAssignments`, {
				ObjectSid: objectSid,
			});
			if (!assign.ok && assign.status !== 409 && !/already/i.test(err(assign.data, assign.status))) {
				steps.push({ step: "Attach profile details", ok: false, note: err(assign.data, assign.status) });
				return { steps, done: false, next: "Rerun to retry." };
			}
		}
		const submit = await twilioForm(S, T, `${TRUSTHUB}/CustomerProfiles/${profileSid}`, { Status: "pending-review" });
		if (!submit.ok && !/already|in-review|approved/i.test(err(submit.data, submit.status))) {
			steps.push({ step: "Submit profile", ok: false, note: err(submit.data, submit.status) });
			return { steps, done: false, next: "Rerun to retry." };
		}
		await dbSet(env, "a2p_profile_submitted", "1");
		steps.push({ step: "Submit profile", ok: true, note: "submitted" });
	} else steps.push({ step: "Submit profile", ok: true, note: "already done" });

	// 3. Sole-proprietor trust product (brand identity + the OTP mobile number).
	const spEndUser = await ensure("a2p_sp_enduser", "Brand identity", () =>
		twilioForm(S, T, `${TRUSTHUB}/EndUsers`, {
			FriendlyName: "Twin sole prop",
			Type: "sole_proprietor_information",
			Attributes: JSON.stringify({
				brand_name: `${info.firstName} ${info.lastName}`,
				vertical: "TECHNOLOGY",
				mobile_phone_number: info.phone,
			}),
		}),
	);
	const trustSid = spEndUser
		? await ensure("a2p_trust", "Trust product", () =>
				twilioForm(S, T, `${TRUSTHUB}/TrustProducts`, {
					FriendlyName: "Twin A2P trust",
					Email: info.email,
					PolicySid: SOLE_PROP_POLICY,
				}),
			)
		: "";
	if (!trustSid) return { steps, done: false, next: "Fix the failed step above and rerun." };
	if (!(await cfgGet(env, "a2p_trust_submitted"))) {
		const assign = await twilioForm(S, T, `${TRUSTHUB}/TrustProducts/${trustSid}/EntityAssignments`, {
			ObjectSid: spEndUser,
		});
		if (!assign.ok && assign.status !== 409 && !/already/i.test(err(assign.data, assign.status))) {
			steps.push({ step: "Attach brand identity", ok: false, note: err(assign.data, assign.status) });
			return { steps, done: false, next: "Rerun to retry." };
		}
		const submit = await twilioForm(S, T, `${TRUSTHUB}/TrustProducts/${trustSid}`, { Status: "pending-review" });
		if (!submit.ok && !/already|in-review|approved/i.test(err(submit.data, submit.status))) {
			steps.push({ step: "Submit trust product", ok: false, note: err(submit.data, submit.status) });
			return { steps, done: false, next: "Rerun to retry." };
		}
		await dbSet(env, "a2p_trust_submitted", "1");
		steps.push({ step: "Submit trust product", ok: true, note: "submitted" });
	} else steps.push({ step: "Submit trust product", ok: true, note: "already done" });

	// 4. Brand registration — this is what texts the owner the OTP link.
	const brandSid = await ensure("a2p_brand", "Brand registration", () =>
		twilioForm(S, T, `${MESSAGING}/a2p/BrandRegistrations`, {
			CustomerProfileBundleSid: profileSid,
			A2PProfileBundleSid: trustSid,
			BrandType: "SOLE_PROPRIETOR",
		}),
	);
	if (!brandSid) return { steps, done: false, next: "Fix the failed step above and rerun." };
	const brand = await twilioForm(S, T, `${MESSAGING}/a2p/BrandRegistrations/${brandSid}`);
	const brandStatus = String(brand.data.status ?? "UNKNOWN").toUpperCase();
	const failureReason = String(brand.data.failure_reason ?? "");
	steps.push({
		step: "Brand status",
		ok: brandStatus === "APPROVED",
		note: brandStatus + (failureReason ? ` — ${failureReason}` : ""),
	});
	// FAILED brands (usually an expired verification link) get refiled for a
	// fresh OTP text — capped at two refiles since each may bill a small fee.
	if (brandStatus === "FAILED") {
		const attempts = Number((await cfgGet(env, "a2p_brand_attempts")) || 0);
		if (attempts >= 2) {
			return {
				steps,
				done: false,
				next: `Brand failed ${attempts + 1} times${failureReason ? ` (${failureReason})` : ""} — screenshot this to Claude before refiling again.`,
			};
		}
		const fresh = await twilioForm(S, T, `${MESSAGING}/a2p/BrandRegistrations`, {
			CustomerProfileBundleSid: profileSid,
			A2PProfileBundleSid: trustSid,
			BrandType: "SOLE_PROPRIETOR",
		});
		const freshSid = String(fresh.data.sid ?? "");
		if (!fresh.ok || !freshSid) {
			steps.push({ step: "Refile brand", ok: false, note: err(fresh.data, fresh.status) });
			return { steps, done: false, next: "Refile failed — screenshot this to Claude." };
		}
		await dbSet(env, "a2p_brand", freshSid);
		await dbSet(env, "a2p_brand_attempts", String(attempts + 1));
		steps.push({ step: "Refile brand", ok: true, note: freshSid });
		// Creating a brand does NOT send the verification text by itself — that
		// omission is why the owner never received one. Fire it explicitly.
		const otp = await twilioForm(S, T, `${MESSAGING}/a2p/BrandRegistrations/${freshSid}/SmsOtp`, {});
		steps.push({ step: "Verification text", ok: otp.ok, note: otp.ok ? "sent now" : err(otp.data, otp.status) });
		if (otp.ok) await dbSet(env, "a2p_otp_last", String(Date.now()));
		return {
			steps,
			done: false,
			next: otp.ok
				? "Brand refiled and the verification text was JUST sent to your cell — tap the link the moment it arrives (they expire), then rerun this."
				: "Brand refiled but the verification text failed to send — rerun this in a minute to retry it.",
		};
	}

	// 5. Messaging service holding both twin numbers. Per-number webhooks stay
	// in charge of inbound (UseInboundWebhookOnNumber).
	const msSid = await ensure("a2p_msgsvc", "Messaging service", () =>
		twilioForm(S, T, `${MESSAGING}/Services`, {
			FriendlyName: "Phone Twin",
			UseInboundWebhookOnNumber: "true",
		}),
	);
	if (msSid) {
		const owned = await twilioApi(S, T, "/IncomingPhoneNumbers.json?PageSize=50");
		const nums =
			(owned.data as { incoming_phone_numbers?: Array<{ sid: string; phone_number: string }> }).incoming_phone_numbers ??
			[];
		const profiles = await loadProfiles(env);
		const twinNums = new Set([cfg.twilioNumber, ...profiles.map((p) => p.number)].filter(Boolean) as string[]);
		for (const n of nums.filter((x) => twinNums.has(x.phone_number))) {
			const add = await twilioForm(S, T, `${MESSAGING}/Services/${msSid}/PhoneNumbers`, { PhoneNumberSid: n.sid });
			const ok = add.ok || add.status === 409 || /already/i.test(err(add.data, add.status));
			steps.push({ step: `Add ${n.phone_number}`, ok, note: ok ? "in service" : err(add.data, add.status) });
		}
	}

	// 6. Campaign — only possible once the brand is approved (OTP link tapped).
	if (brandStatus !== "APPROVED") {
		// Fire a fresh verification text on demand (30-min throttle) — iPhones
		// often filter the first one into Unknown Senders and the links expire.
		const lastOtp = Number((await cfgGet(env, "a2p_otp_last")) || 0);
		let otpNote = "";
		if (Date.now() - lastOtp > 30 * 60 * 1000) {
			const otp = await twilioForm(S, T, `${MESSAGING}/a2p/BrandRegistrations/${brandSid}/SmsOtp`, {});
			if (otp.ok) {
				await dbSet(env, "a2p_otp_last", String(Date.now()));
				otpNote = " A fresh verification text was just sent";
				steps.push({ step: "Verification text", ok: true, note: "re-sent just now" });
			}
		} else {
			otpNote = " A verification text was sent within the last half hour";
		}
		return {
			steps,
			done: false,
			next: `Waiting on your tap:${otpNote} to ${info.phone} — check Messages, INCLUDING the Unknown Senders/junk filter, and tap the link right away. Then rerun this; the campaign files automatically once the brand approves.`,
		};
	}
	const campaignDone = await cfgGet(env, "a2p_campaign");
	if (!campaignDone) {
		const campaign = await twilioForm(S, T, `${MESSAGING}/Services/${msSid}/Compliance/Usa2p`, {
			BrandRegistrationSid: brandSid,
			Description: "Personal AI phone assistant sending the account owner call summaries and notifications, and relaying personal messages the owner dictates to known contacts.",
			MessageFlow:
				"The account owner is the sole subscriber and opted in by configuring the assistant. Contacts receive only messages the owner explicitly dictates; replying STOP opts out.",
			MessageSamples: [
				"Twin digest: 2 calls today. Dennis wants a callback about Saturday.",
				"It's Nick - I'll be there at 6.",
			],
			UsAppToPersonUsecase: "SOLE_PROPRIETOR",
			HasEmbeddedLinks: "true",
			HasEmbeddedPhone: "true",
		});
		if (!campaign.ok) {
			steps.push({ step: "Campaign", ok: false, note: err(campaign.data, campaign.status) });
			return { steps, done: false, next: "Campaign creation failed — send me the note above and I'll adjust." };
		}
		await dbSet(env, "a2p_campaign", String(campaign.data.sid ?? "created"));
		steps.push({ step: "Campaign", ok: true, note: String(campaign.data.campaign_status ?? "submitted") });
	} else steps.push({ step: "Campaign", ok: true, note: "already done" });
	return {
		steps,
		done: true,
		next: "Registration submitted. Carrier approval usually lands within hours to a couple of days — texts start delivering the moment it does. Re-run System Check tomorrow to confirm.",
	};
}

// Self-driving wrapper around a2pRegister: once owner info is stored
// (a2p_info), every webhook/wire pass nudges the registration forward with a
// 10-minute cooldown — so after the owner taps Twilio's OTP link, the next
// call or text to any twin resumes the flow and files the campaign, no button
// pressing. When done, the twin texts the owner a completion message whose
// arrival itself proves delivery works (it can only land once carriers
// approve); it retries that notification a few times across days.
async function a2pAutoResume(env: Env): Promise<string> {
	const infoRaw = await cfgGet(env, "a2p_info");
	if (!infoRaw) return "no info stored";
	const cfg = await loadCfg(env);
	if (!cfg.twilioSid || !cfg.twilioToken) return "twilio not connected";
	if (await cfgGet(env, "a2p_done")) {
		const sent = Number((await cfgGet(env, "a2p_done_notified")) || 0);
		const last = Number((await cfgGet(env, "a2p_notify_last")) || 0);
		if (sent < 4 && Date.now() - last > 6 * 3600 * 1000 && env.TWIN_NOTIFY_CELL && cfg.twilioNumber) {
			await twilioApi(cfg.twilioSid, cfg.twilioToken, "/Messages.json", {
				To: env.TWIN_NOTIFY_CELL,
				From: cfg.twilioNumber,
				Body: "✅ Text delivery registration is complete — and this message arriving is the proof. Your twins can text now.",
			});
			await dbSet(env, "a2p_done_notified", String(sent + 1));
			await dbSet(env, "a2p_notify_last", String(Date.now()));
			return "sent completion notice";
		}
		return "done";
	}
	const lastTry = Number((await cfgGet(env, "a2p_last_try")) || 0);
	if (Date.now() - lastTry < 600_000) return "cooldown";
	await dbSet(env, "a2p_last_try", String(Date.now()));
	let info: Parameters<typeof a2pRegister>[2];
	try {
		info = JSON.parse(infoRaw) as Parameters<typeof a2pRegister>[2];
	} catch {
		return "bad stored info";
	}
	const result = await a2pRegister(env, cfg, info).catch(() => null);
	if (!result) return "error — will retry";
	if (result.done) await dbSet(env, "a2p_done", "1");
	return result.done ? "completed" : `in progress: ${result.next}`;
}

// --- Twilio webhook signature validation (HMAC-SHA1 of URL + sorted params) ----

async function signFor(url: string, params: URLSearchParams, authToken: string) {
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
	return btoa(String.fromCharCode(...new Uint8Array(mac)));
}

// Twilio signs the exact URL it called. Checking only the APP_URL-derived URL
// silently 401s every webhook whenever the two differ (www vs apex, a trailing
// query string, a proxied scheme) — the twin then looks "dead" with nothing in
// the logs. Accept the request's own URL too, and record misses so /syscheck
// can say "Twilio reached us but the signature didn't match".
async function validTwilioSignature(
	req: Request,
	url: string,
	params: URLSearchParams,
	authToken: string,
	env?: Env,
) {
	const sig = req.headers.get("X-Twilio-Signature");
	if (!sig || !authToken) return false;
	const candidates = [url, req.url, req.url.split("?")[0]];
	for (const candidate of new Set(candidates)) {
		if ((await signFor(candidate, params, authToken)) === sig) return true;
	}
	if (env) {
		await env.CACHE.put(
			"twin:sigfail",
			JSON.stringify({ at: Date.now(), expected: url, actual: req.url }),
			{ expirationTtl: 86400 },
		).catch(() => {});
	}
	return false;
}

// --- ElevenLabs TTS: text → mp3 in KV, returns playable URL (null → <Say>) -----

// Stable id for a clip: identical text in the same voice reuses the audio
// instead of paying for synthesis again (greetings, "say that again?", the
// transfer line — every call starts with one of these).
async function clipId(voice: string, speed: number, text: string) {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${voice}|${speed}|${text}`));
	return [...new Uint8Array(digest)].slice(0, 16).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function speak(env: Env, cfg: TwinCfg, text: string): Promise<string | null> {
	if (!cfg.elevenKey || !cfg.elevenVoice) return null;
	const id = await clipId(cfg.elevenVoice, cfg.voiceSpeed, text);
	const url = `${env.APP_URL}/api/twin/voice/audio/${id}`;
	// Already synthesized recently? Skip ElevenLabs entirely.
	if (await env.CACHE.get(`twin:audio:${id}`, "stream")) return url;
	const res = await fetch(
		// eleven_flash_v2_5 is ElevenLabs' low-latency model (~75ms vs turbo's
		// ~250ms+); optimize_streaming_latency trades a little prosody for a
		// faster first byte. Both are the right call on an 8kHz phone line.
		`https://api.elevenlabs.io/v1/text-to-speech/${cfg.elevenVoice}?output_format=mp3_22050_32&optimize_streaming_latency=3`,
		{
			method: "POST",
			headers: { "xi-api-key": cfg.elevenKey, "content-type": "application/json" },
			body: JSON.stringify({
				text,
				model_id: env.TWIN_TTS_MODEL || "eleven_flash_v2_5",
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
	await env.CACHE.put(`twin:audio:${id}`, await res.arrayBuffer(), { expirationTtl: AUDIO_TTL });
	return url;
}

// --- Claude persona reply ------------------------------------------------------

type Turn = { role: "user" | "assistant"; content: string };

// Streaming variant: reads Claude's SSE token stream and fires
// onFirstSentence as soon as the first complete sentence exists, so its audio
// can synthesize (and start playing) while the rest of the reply is still
// being written. Returns the full reply text.
async function claudeStream(
	env: Env,
	system: string,
	messages: Turn[],
	maxTokens: number,
	onFirstSentence: (sentence: string) => Promise<void>,
): Promise<string | null> {
	const res = await fetch("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: {
			"x-api-key": env.ANTHROPIC_API_KEY,
			"anthropic-version": "2023-06-01",
			"content-type": "application/json",
		},
		body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: maxTokens, system, messages, stream: true }),
	});
	if (!res.ok || !res.body) return null;
	const reader = res.body.getReader();
	const dec = new TextDecoder();
	let buf = "";
	let text = "";
	let firstFired: Promise<void> | null = null;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += dec.decode(value, { stream: true });
		const lines = buf.split("\n");
		buf = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.startsWith("data: ")) continue;
			try {
				const ev = JSON.parse(line.slice(6)) as { type?: string; delta?: { type?: string; text?: string } };
				if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") text += ev.delta.text ?? "";
			} catch {
				// partial JSON across chunks lands in buf next round
			}
		}
		if (!firstFired && text.length >= 20) {
			// A sentence boundary at least 15 chars in, followed by whitespace.
			const m = text.match(/^[\s\S]{15,}?[.!?]["')\]]*(?=\s)/);
			if (m) firstFired = onFirstSentence(m[0].trim()).catch(() => {});
		}
	}
	if (firstFired) await firstFired;
	return text.trim() || null;
}

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

function callSystem(cfg: TwinCfg, extraContext: string) {
	return (
		cfg.persona +
		extraContext +
		" You are on a live phone call, so answer in 1-3 short conversational sentences — never lists, never markdown. If the caller says goodbye, say a warm goodbye."
	);
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

// The listening tail every answer ends with: gather speech, nudge once, hang up.
function gatherTail(env: Env) {
	const action = `${env.APP_URL}/api/twin/voice/respond`;
	return (
		`<Gather input="speech" action="${action}" method="POST" speechTimeout="1" speechModel="experimental_conversations" language="en-US" actionOnEmptyResult="true"/>` +
		`${SAY}Are you still there?</Say>` +
		`<Gather input="speech" action="${action}" method="POST" speechTimeout="1" speechModel="experimental_conversations" language="en-US" actionOnEmptyResult="true"/>` +
		`<Hangup/>`
	);
}

function gather(env: Env, playUrl: string | null, fallbackText: string) {
	const speech = playUrl ? `<Play>${escapeXml(playUrl)}</Play>` : `${SAY}${escapeXml(fallbackText)}</Say>`;
	return speech + gatherTail(env);
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
	if (!(await validTwilioSignature(c.req.raw, voiceWebhookUrl(c.env), params, cfg.twilioToken, c.env))) {
		return c.text("unauthorized", 401);
	}
	cfg = await overlayProfile(c.env, cfg, [params.get("To"), params.get("From")]);
	const from = params.get("From") ?? "";
	// A call from one of our own twin numbers is the owner's carrier bouncing a
	// transfer back at us. Answering it would strand the caller talking to the
	// twin again; rejecting lets the transfer's no-answer fallback run.
	const ownNumbers = new Set(
		[cfg.twilioNumber, ...(await loadProfiles(c.env)).map((p) => p.number)].filter(Boolean) as string[],
	);
	if (from && ownNumbers.has(from)) return xml("<Reject/>");
	// A ForwardedFrom matching the owner's cell proves the carrier forwarding
	// code is live — record it so System Check can verify instead of guessing,
	// and greet as the answering service the caller actually reached.
	const fwd = params.get("ForwardedFrom") ?? "";
	const missedOwner =
		!!fwd &&
		!!c.env.TWIN_NOTIFY_CELL &&
		fwd.replace(/\D/g, "").endsWith(c.env.TWIN_NOTIFY_CELL.replace(/\D/g, "").slice(-10));
	if (missedOwner) c.executionCtx.waitUntil(dbSet(c.env, "last_forwarded_at", String(Date.now())).catch(() => {}));
	// Repeat callers get greeted like the twin remembers them — because it does.
	const mem = await getCaller(c.env, from).catch(() => null);
	const greeting = missedOwner
		? `Hey${mem?.name ? ` ${mem.name}` : ""}, ${cfg.twinName} can't grab the phone right now — you've got his AI twin. What's up?`
		: mem && mem.call_count > 0
			? `Hey${mem.name ? ` ${mem.name}` : ""}, it's ${cfg.twinName}'s AI twin again — good to hear from you. What's up?`
			: `Hey, it's ${cfg.twinName}'s AI twin speaking on his behalf. What's up?`;
	const callSid = params.get("CallSid") ?? "unknown";
	c.executionCtx.waitUntil(saveConvo(c.env, callSid, [{ role: "assistant", content: greeting }]));
	c.executionCtx.waitUntil(saveTranscript(c.env, callSid, params.get("From"), [{ role: "assistant", content: greeting }]));
	if (from) {
		// Count the call and fold any not-yet-summarized past transcripts into
		// memory (helps the /respond turns of this very call, and the next one).
		c.executionCtx.waitUntil(touchCaller(c.env, from).catch(() => {}));
		c.executionCtx.waitUntil(refreshCallerSummary(c.env, from).catch(() => {}));
	}
	c.executionCtx.waitUntil(twinNightlyDigest(c.env).then(() => undefined, () => {}));
	c.executionCtx.waitUntil(a2pAutoResume(c.env).then(() => undefined, () => {}));
	const audio = await speak(c.env, cfg, greeting);
	return xml(gather(c.env, audio, greeting));
});

// Whisper played to the owner when a transfer reaches them: press any key to
// accept. No key (voicemail, or the call forwarded back into the twin) hangs
// this leg up so the caller gets the take-a-message fallback.
twin.post("/voice/screen", async (c) => {
	const cfg = await loadCfg(c.env);
	const params = new URLSearchParams(await c.req.text());
	if (!(await validTwilioSignature(c.req.raw, `${c.env.APP_URL}/api/twin/voice/screen`, params, cfg.twilioToken, c.env))) {
		return c.text("unauthorized", 401);
	}
	const accept = `${c.env.APP_URL}/api/twin/voice/screen/accept`;
	return xml(
		`<Gather numDigits="1" timeout="8" action="${escapeXml(accept)}" method="POST">` +
			`${SAY}Your A I twin has a caller for you. Press any key to take the call.</Say></Gather><Hangup/>`,
	);
});

// A key was pressed: end the whisper with no further TwiML so Twilio bridges
// the caller through.
twin.post("/voice/screen/accept", async (c) => {
	const cfg = await loadCfg(c.env);
	const params = new URLSearchParams(await c.req.text());
	if (
		!(await validTwilioSignature(
			c.req.raw,
			`${c.env.APP_URL}/api/twin/voice/screen/accept`,
			params,
			cfg.twilioToken,
			c.env,
		))
	) {
		return c.text("unauthorized", 401);
	}
	return xml("");
});

twin.post("/voice/respond", async (c) => {
	let cfg = await loadCfg(c.env);
	const params = new URLSearchParams(await c.req.text());
	if (!(await validTwilioSignature(c.req.raw, `${c.env.APP_URL}/api/twin/voice/respond`, params, cfg.twilioToken, c.env))) {
		return c.text("unauthorized", 401);
	}
	cfg = await overlayProfile(c.env, cfg, [params.get("To"), params.get("From")]);
	const callSid = params.get("CallSid") ?? "unknown";
	const heard = (params.get("SpeechResult") ?? "").trim();
	if (!heard) {
		// Stock line — synthesized once, then served from cache in the twin's
		// own voice instead of falling back to the robotic <Say>.
		const retry = "Sorry, I didn't catch that. One more time?";
		return xml(gather(c.env, await speak(c.env, cfg, retry), retry));
	}

	// These three are independent — fetching them one after another added a
	// round trip each to every spoken turn.
	const [history, mem, facts] = await Promise.all([
		loadConvo(c.env, callSid),
		getCaller(c.env, params.get("From") ?? "").catch(() => null),
		loadFacts(c.env).catch(() => [] as Fact[]),
	]);
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
		/(real (nick|person|human|one|him)|speak (to|with) (nick|him)|talk (to|with) (nick|him)|is nick (there|around|available|in)|put (him|nick) on|get (him|nick)( on| for me)?\b|where('| i)s nick|reach (him|nick)|transfer|connect me|a (human|person|real person)|urgent|emergency|right away)/i.test(
			heard,
		)
	) {
		const msg = "You got it — connecting you to the real Nick right now. Hang tight.";
		history.push({ role: "assistant", content: `${msg} [transferring call]` });
		await saveConvo(c.env, callSid, history);
		await saveTranscript(c.env, callSid, params.get("From"), history);
		const lead = (await speak(c.env, cfg, msg).then((u) => (u ? `<Play>${escapeXml(u)}</Play>` : null))) ??
			`${SAY}${escapeXml(msg)}</Say>`;
		const action = `${c.env.APP_URL}/api/twin/voice/respond`;
		// Screened transfer: the answering side must press a key to accept. If
		// the owner's carrier forwards this very call back to the twin (what
		// **004* forwarding does), nothing presses a key, so the leg hangs up
		// and we fall through to taking a message instead of looping.
		const screen = `${c.env.APP_URL}/api/twin/voice/screen`;
		return xml(
			`${lead}<Dial callerId="${escapeXml(cfg.twilioNumber)}" timeout="25" answerOnBridge="true">` +
				`<Number url="${escapeXml(screen)}" method="POST">${escapeXml(c.env.TWIN_NOTIFY_CELL)}</Number></Dial>` +
				`${SAY}Looks like he could not pick up. I can take a message instead.</Say>` +
				`<Gather input="speech" action="${action}" method="POST" speechTimeout="1" speechModel="experimental_conversations" language="en-US" actionOnEmptyResult="true"/>`,
		);
	}

	// Answer asynchronously: reply computation (Claude + TTS) runs in the
	// background while the caller immediately hears a short acknowledgment —
	// no silent void. The result lands in D1 (strongly consistent, unlike KV
	// across colos) and /voice/answer picks it up.
	const ticket = crypto.randomUUID();
	c.executionCtx.waitUntil(
		computeAnswer(c.env, cfg, {
			ticket,
			callSid,
			from: params.get("From"),
			heard,
			history,
			extraContext: factsBlock(cfg.twinName, facts) + callerContext(mem),
		}),
	);
	// Straight to /voice/answer — the redirect round trip itself is the only
	// gap. Fillers only play when the answer genuinely isn't ready yet.
	const answerUrl = `${c.env.APP_URL}/api/twin/voice/answer?t=${ticket}`;
	return xml(`<Redirect method="POST">${escapeXml(answerUrl)}</Redirect>`);
});

// Spoken only when a turn is genuinely slow, rotated so it never becomes the
// twin's catchphrase. Clips are content-cached after first synthesis.
const FILLERS = ["Mm-hm.", "Right — hang on.", "Let me think.", "Okay, one sec."];
function pickFiller(seed: string) {
	let h = 0;
	for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) | 0;
	return FILLERS[Math.abs(h) % FILLERS.length];
}

// Answers are delivered in segments: [0] is the reply's first sentence,
// synthesized while Claude is still writing the rest; done=false means more
// segments are coming. Empty clips with done=true → fall back to <Say>.
type AnswerPayload = { clips: string[]; text: string; done: boolean; hangup: boolean };

async function putAnswer(env: Env, ticket: string, payload: AnswerPayload) {
	await env.DB
		.prepare("INSERT OR REPLACE INTO twin_answers (id, payload, created_at) VALUES (?,?,?)")
		.bind(ticket, JSON.stringify(payload), Date.now())
		.run();
}

async function computeAnswer(
	env: Env,
	cfg: TwinCfg,
	job: { ticket: string; callSid: string; from: string | null; heard: string; history: Turn[]; extraContext: string },
) {
	const hangup = /\b(goodbye|bye|talk later|hang up)\b/i.test(job.heard);
	const clips: string[] = [];
	let first = "";
	let reply: string | null = null;
	try {
		// Stream the reply: the first complete sentence gets voiced and handed
		// to /voice/answer immediately, so the caller hears the twin start
		// talking while the rest of the reply is still being generated.
		reply = await claudeStream(env, callSystem(cfg, job.extraContext), job.history, 150, async (sentence) => {
			const url = await speak(env, cfg, sentence);
			if (url) {
				first = sentence;
				clips.push(url);
				await putAnswer(env, job.ticket, { clips: [...clips], text: sentence, done: false, hangup });
			}
		});
	} catch {
		reply = null;
	}
	if (!reply) {
		const text = first || "Sorry, I glitched for a second there. Say that again?";
		await putAnswer(env, job.ticket, { clips: [...clips], text, done: true, hangup: false });
		return;
	}
	// Voice whatever follows the already-spoken first sentence.
	const idx = first ? reply.indexOf(first) : -1;
	const rest = idx >= 0 ? reply.slice(idx + first.length).trim() : first ? "" : reply;
	if (rest) {
		const url = await speak(env, cfg, rest);
		if (url) clips.push(url);
		else clips.length = 0; // partial audio would truncate the reply — Say it all instead
	}
	await putAnswer(env, job.ticket, { clips: [...clips], text: reply, done: true, hangup });

	job.history.push({ role: "assistant", content: reply });
	await saveConvo(env, job.callSid, job.history);
	await saveTranscript(env, job.callSid, job.from, job.history);
	if (hangup) {
		if (job.from) await refreshCallerSummary(env, job.from).catch(() => {});
		if (env.TWIN_NOTIFY_CELL && cfg.twilioNumber) {
			await twilioApi(cfg.twilioSid, cfg.twilioToken, "/Messages.json", {
				To: env.TWIN_NOTIFY_CELL,
				From: cfg.twilioNumber,
				Body: `Your twin just finished a call with ${job.from ?? "unknown"}. Last thing they said: "${job.heard.slice(0, 200)}". Full transcript: generateai.build/twin`,
			});
		}
	}
	await env.DB.prepare("DELETE FROM twin_answers WHERE created_at < ?").bind(Date.now() - 600_000).run();
}

// Delivers the computed answer segment by segment as it materializes: plays
// clip i, then redirects for clip i+1 until done. Only speaks a (rotating)
// filler when nothing is ready yet; rare long thinks get a beat of silence
// instead of a dropped call.
twin.post("/voice/answer", async (c) => {
	let cfg = await loadCfg(c.env);
	const params = new URLSearchParams(await c.req.text());
	if (!(await validTwilioSignature(c.req.raw, `${c.env.APP_URL}/api/twin/voice/answer`, params, cfg.twilioToken, c.env))) {
		return c.text("unauthorized", 401);
	}
	cfg = await overlayProfile(c.env, cfg, [params.get("To"), params.get("From")]);
	const ticket = c.req.query("t") ?? "";
	const round = Number(c.req.query("n") ?? 0);
	const seg = Number(c.req.query("i") ?? 0);
	const next = (n: number, i: number) => `${c.env.APP_URL}/api/twin/voice/answer?t=${ticket}&n=${n}&i=${i}`;
	const cleanup = () =>
		c.executionCtx.waitUntil(
			c.env.DB.prepare("DELETE FROM twin_answers WHERE id = ?").bind(ticket).run().then(() => undefined),
		);

	// First visit polls briefly (the first sentence usually lands fast);
	// follow-ups wait longer before conceding another filler/pause.
	const beats = round === 0 && seg === 0 ? 4 : 8;
	for (let k = 0; k < beats; k++) {
		const row = await c.env.DB
			.prepare("SELECT payload FROM twin_answers WHERE id = ?")
			.bind(ticket)
			.first<{ payload: string }>();
		if (row) {
			const a = JSON.parse(row.payload) as AnswerPayload;
			if (a.clips.length > seg) {
				const play = `<Play>${escapeXml(a.clips[seg])}</Play>`;
				if (a.done && seg === a.clips.length - 1) {
					cleanup();
					return xml(a.hangup ? `${play}<Hangup/>` : play + gatherTail(c.env));
				}
				return xml(`${play}<Redirect method="POST">${escapeXml(next(round, seg + 1))}</Redirect>`);
			}
			if (a.done) {
				cleanup();
				if (seg > 0) return xml(a.hangup ? "<Hangup/>" : gatherTail(c.env));
				return xml(a.hangup ? `${SAY}${escapeXml(a.text)}</Say><Hangup/>` : gather(c.env, null, a.text));
			}
		}
		await new Promise((r) => setTimeout(r, 600));
	}
	if (round >= 3) return xml(gather(c.env, null, "Sorry, that took me too long. Say that again?"));
	// Not ready: one spoken filler the first time, silence after that.
	const filler = round === 0 ? await speak(c.env, cfg, pickFiller(ticket)) : null;
	const wait = filler ? `<Play>${escapeXml(filler)}</Play>` : '<Pause length="1"/>';
	return xml(`${wait}<Redirect method="POST">${escapeXml(next(round + 1, seg))}</Redirect>`);
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
	c.executionCtx.waitUntil(a2pAutoResume(c.env).then(() => undefined, () => {}));
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
	if (!(await validTwilioSignature(c.req.raw, `${c.env.APP_URL}/api/twin/sms/incoming`, params, cfg.twilioToken, c.env))) {
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
		// One-text carrier registration: "register First Last, Street, City, ST 55322".
		// Stores the info and kicks the self-driving A2P flow; from here every
		// webhook nudges it forward and the twin texts back once delivery works.
		const regCmd = body.match(/^register\s+([\s\S]+)$/i);
		if (regCmd) {
			const parts = regCmd[1].split(",").map((s) => s.trim());
			const name = (parts[0] ?? "").split(/\s+/);
			const stateZip = (parts[3] ?? "").match(/^([A-Za-z]{2})[\s,]+(\d{5})(?:-\d{4})?$/);
			if (parts.length >= 4 && name.length >= 2 && parts[1] && parts[2] && stateZip) {
				await dbSet(
					c.env,
					"a2p_info",
					JSON.stringify({
						firstName: name[0],
						lastName: name.slice(1).join(" "),
						email: c.env.OWNER_EMAIL || "heitkampnick23@gmail.com",
						phone: c.env.TWIN_NOTIFY_CELL || from,
						street: parts[1],
						city: parts[2],
						region: stateZip[1].toUpperCase(),
						postalCode: stateZip[2],
					}),
				);
				await dbSet(c.env, "a2p_last_try", "0"); // run immediately
				c.executionCtx.waitUntil(a2pAutoResume(c.env).then(() => undefined, () => {}));
				await send(from, "Got it — filing your carrier registration now. Tap the link Twilio texts you; I'll text you when everything's done.");
			} else {
				await send(from, 'Format: "register First Last, Street, City, ST 55322"');
			}
		} else if (buyCmd) {
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
	c.executionCtx.waitUntil(a2pAutoResume(c.env).then(() => undefined, () => {}));
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
		// No-answer-only (**61*) is the recommended code. The catch-all **004*
		// also forwards "unreachable", which swallows the twin's own transfer
		// call back to the owner — dial that one and asking for the real person
		// stops working.
		carriers: [
			{
				carrier: "AT&T, T-Mobile & most GSM carriers",
				activate: [{ label: "When you don't answer (recommended)", code: `**61*${digits}#` }],
				deactivate: "##004#",
			},
			{
				carrier: "AT&T / T-Mobile — also forward these",
				activate: [
					{ label: "When you're on the other line", code: `**67*${digits}#` },
					{ label: "Phone off / no signal — breaks call transfers", code: `**62*${digits}#` },
					{ label: "Everything at once — breaks call transfers", code: `**004*${digits}#` },
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
			"Only unanswered/busy calls forward; calls you pick up are untouched.",
			'Use the "don\'t answer" code. The catch-all **004* also forwards when your phone is unreachable, which sends the twin\'s own transfer call back to the twin — so callers asking for the real you never get through.',
			"Switching codes? Dial the off code first (##004# or *73), then the new one.",
			"Test it: have someone call your personal number and don't answer — your twin should pick up.",
			"Forwarded minutes may bill against your carrier plan.",
		],
	});
});

// Full system check: pulls delivery evidence straight from Twilio and turns it
// into plain-English findings. Also repairs any twin number whose webhooks
// don't point at this worker.
twin.get("/syscheck", ownerOnly, async (c) => {
	const cfg = await loadCfg(c.env);
	const findings: string[] = [];
	if (!cfg.twilioSid || !cfg.twilioToken) {
		return c.json({ findings: ["✗ Twilio isn't connected — calls and texts are down. Reconnect it on Twin Setup."] });
	}
	const profiles = await loadProfiles(c.env);
	const cell = c.env.TWIN_NOTIFY_CELL || "";
	const voiceUrl = voiceWebhookUrl(c.env);
	const smsUrl = `${c.env.APP_URL}/api/twin/sms/incoming`;

	// Account
	const acct = await twilioApi(cfg.twilioSid, cfg.twilioToken, ".json");
	const acctType = (acct.data as { type?: string }).type ?? "unknown";
	findings.push(
		acctType.toLowerCase() === "trial"
			? "✗ Twilio account is a TRIAL: texts/calls only reach verified numbers and get a trial notice. Upgrade it in the Twilio console."
			: `✓ Twilio account is ${acctType} (${(acct.data as { status?: string }).status ?? "?"}).`,
	);
	findings.push(cell ? `✓ Your cell on file: ${cell}.` : "✗ TWIN_NOTIFY_CELL isn't set — transfers and notifications have nowhere to go.");

	// Which carrier is the owner's cell on? Forwarding dial codes are
	// carrier-family-specific — GSM codes (**61*) silently do nothing on
	// Verizon and vice versa, which reads as "forwarding just doesn't work".
	if (cell && cfg.twilioNumber) {
		const lookup = await twilioForm(
			cfg.twilioSid,
			cfg.twilioToken,
			`https://lookups.twilio.com/v2/PhoneNumbers/${encodeURIComponent(cell)}?Fields=line_type_intelligence`,
		);
		const carrier = String(
			(lookup.data as { line_type_intelligence?: { carrier_name?: string } }).line_type_intelligence?.carrier_name ?? "",
		);
		const digits = cfg.twilioNumber.replace(/\D/g, "");
		const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
		// The definitive forwarding test: has a call forwarded from the owner's
		// cell ever actually reached the twin?
		const lastFwd = Number((await cfgGet(c.env, "last_forwarded_at")) || 0);
		if (lastFwd) {
			findings.push(
				`✓ Missed-call forwarding VERIFIED working — a call forwarded from your cell reached the twin at ${new Date(lastFwd).toLocaleString()}.`,
			);
		} else {
			findings.push(
				`✗ FORWARDING NOT ACTIVE: no call forwarded from your cell has EVER reached the twin — that's why missed calls still hit voicemail. Dial the code below, then test by calling your cell from another phone and letting it ring out; rerun this and this line flips green.`,
			);
		}
		if (/verizon|cellco|visible|straight talk|tracfone/i.test(carrier)) {
			findings.push(
				`${lastFwd ? "•" : "✗"} Your cell is on ${carrier} — a Verizon-family network. The **61*/##004# codes DO NOTHING there. Dial exactly: *71${ten} to forward missed calls to the twin, and *73 to turn it off.`,
			);
		} else if (/t-mobile|tmobile|metro|sprint|mint|at&t|att|cingular|cricket/i.test(carrier)) {
			findings.push(
				`✓ Your cell is on ${carrier} (GSM family) — the right code is **61*${digits}# (off: ##004#). Dial it and watch for a "forwarding enabled" confirmation banner; an error banner means the carrier blocks it and their support has the variant.`,
			);
		} else if (carrier) {
			findings.push(
				`• Your cell is on ${carrier} — couldn't classify it. Try *71${ten} (Verizon-style) first, then **61*${digits}# (GSM-style); whichever shows a confirmation banner is the one.`,
			);
		}
	}
	findings.push(c.env.ANTHROPIC_API_KEY ? "✓ Claude brain connected." : "✗ ANTHROPIC_API_KEY missing — twins can't think.");

	// Did Twilio reach us but get rejected? That looks exactly like "nothing
	// happens" from the outside.
	const sigFail = await c.env.CACHE.get<{ at: number; expected: string; actual: string }>("twin:sigfail", "json");
	if (sigFail) {
		findings.push(
			`✗ A Twilio webhook was rejected for a bad signature (${new Date(sigFail.at).toLocaleString()}). It called ${sigFail.actual} while the twin expected ${sigFail.expected}. Both URLs are now accepted, so re-test — if it recurs, the number's webhook URL needs correcting.`,
		);
	}

	// Carrier (A2P) registration progress — and running the check itself
	// nudges the self-driving flow forward.
	if (await cfgGet(c.env, "a2p_info")) {
		c.executionCtx.waitUntil(a2pAutoResume(c.env).then(() => undefined, () => {}));
		if (await cfgGet(c.env, "a2p_campaign")) {
			findings.push(
				"✓ Carrier registration: campaign filed — waiting on carrier approval (hours to ~2 days). Texts start delivering the moment it lands, and your twin will text you the ✅ proof.",
			);
		} else {
			const brandSid = await cfgGet(c.env, "a2p_brand");
			if (brandSid) {
				const brand = await twilioForm(cfg.twilioSid, cfg.twilioToken, `${MESSAGING}/a2p/BrandRegistrations/${brandSid}`);
				const st = String((brand.data as { status?: string }).status ?? "UNKNOWN").toUpperCase();
				if (st === "APPROVED") {
					findings.push("✓ Carrier registration: brand approved — the campaign files itself within minutes (this check just nudged it).");
				} else if (st === "FAILED") {
					const reason = String((brand.data as { failure_reason?: string }).failure_reason ?? "");
					findings.push(
						`✗ Carrier registration: brand FAILED${reason ? ` — ${reason}` : ""}. Tap "Register / resume" on the registration card: it refiles the brand and Twilio texts you a fresh verification link — tap that link quickly, they expire.`,
					);
				} else {
					findings.push(
						`• Carrier registration: brand is ${st}. If Twilio texted you a verification link, tap it — the flow resumes on its own afterward.`,
					);
				}
			} else {
				findings.push("• Carrier registration: profile steps in progress — this check just nudged them along. Re-run in a few minutes.");
			}
		}
	}

	// Numbers + webhook repair
	const twinNumbers = new Map<string, string>(); // number -> twin name
	if (cfg.twilioNumber) twinNumbers.set(cfg.twilioNumber, cfg.twinName);
	for (const p of profiles) if (p.number) twinNumbers.set(p.number, p.name);
	const ownedRes = await twilioApi(cfg.twilioSid, cfg.twilioToken, "/IncomingPhoneNumbers.json?PageSize=20");
	const owned =
		(ownedRes.data as {
			incoming_phone_numbers?: Array<{ sid: string; phone_number: string; voice_url?: string; sms_url?: string }>;
		}).incoming_phone_numbers ?? [];
	for (const [num, name] of twinNumbers) {
		const row = owned.find((n) => n.phone_number === num);
		if (!row) {
			findings.push(`✗ ${name}'s number ${num} is not on the Twilio account anymore.`);
			continue;
		}
		if (row.voice_url !== voiceUrl || row.sms_url !== smsUrl) {
			const fix = await twilioApi(cfg.twilioSid, cfg.twilioToken, `/IncomingPhoneNumbers/${row.sid}.json`, {
				VoiceUrl: voiceUrl,
				VoiceMethod: "POST",
				SmsUrl: smsUrl,
				SmsMethod: "POST",
			});
			findings.push(
				fix.ok
					? `✓ ${name} (${num}): webhooks were wrong — repaired just now. Texts to this number should work again.`
					: `✗ ${name} (${num}): webhooks are wrong and repair failed.`,
			);
		} else {
			findings.push(`✓ ${name} (${num}): call + text webhooks wired correctly.`);
		}
	}

	// Recent messages — the delivery truth, with error decoding
	type Msg = {
		to?: string;
		from?: string;
		status?: string;
		error_code?: number | null;
		error_message?: string | null;
		date_created?: string;
		direction?: string;
		body?: string;
	};
	const msgsRes = await twilioApi(cfg.twilioSid, cfg.twilioToken, "/Messages.json?PageSize=15");
	const msgs = ((msgsRes.data as { messages?: Msg[] }).messages ?? []).map((m) => ({
		when: m.date_created ?? "",
		dir: m.direction ?? "",
		from: m.from ?? "",
		to: m.to ?? "",
		status: m.status ?? "",
		errorCode: m.error_code ?? null,
		body: (m.body ?? "").slice(0, 80),
	}));
	const explainSms = (code: number, to: string, from: string): string => {
		if (code === 21610)
			return `✗ TEXTS BLOCKED: ${to} previously replied STOP to ${from}, so Twilio refuses all texts to it from that number. Fix: from that phone, text START to ${from}.`;
		if (code === 30034)
			return `✗ TEXTS FILTERED: ${from} isn't A2P-registered, so US carriers drop its texts. Fix: Twilio Console → Messaging → Regulatory Compliance → register A2P 10DLC (sole-proprietor works for personal use).`;
		if (code === 30007) return `✗ Text from ${from} to ${to} was filtered by the carrier as spam (error 30007).`;
		if (code === 30003 || code === 30005) return `✗ Text to ${to} failed — phone unreachable or number doesn't exist (error ${code}).`;
		return `✗ Text from ${from} to ${to} failed with Twilio error ${code}.`;
	};
	const badMsgs = msgs.filter((m) => m.errorCode || m.status === "failed" || m.status === "undelivered");
	if (!msgsRes.ok) findings.push("✗ Couldn't read the message log from Twilio.");
	else if (!msgs.length) findings.push("• No texts in the log yet — text one of the twin numbers and re-run this check.");
	else if (!badMsgs.length) findings.push(`✓ Texts: last ${msgs.length} messages show no delivery failures.`);
	else {
		const seen = new Set<string>();
		for (const m of badMsgs) {
			const line = m.errorCode
				? explainSms(m.errorCode, m.to, m.from)
				: `✗ Text from ${m.from} to ${m.to} is "${m.status}".`;
			if (!seen.has(line)) {
				seen.add(line);
				findings.push(line);
			}
		}
	}

	// Recent calls — did transfers to the owner's cell actually ring?
	type Call = {
		to?: string;
		from?: string;
		status?: string;
		duration?: string;
		direction?: string;
		start_time?: string;
	};
	const callsRes = await twilioApi(cfg.twilioSid, cfg.twilioToken, "/Calls.json?PageSize=20");
	const calls = ((callsRes.data as { calls?: Call[] }).calls ?? []).map((cl) => ({
		when: cl.start_time ?? "",
		dir: cl.direction ?? "",
		from: cl.from ?? "",
		to: cl.to ?? "",
		status: cl.status ?? "",
		seconds: Number(cl.duration ?? 0),
	}));
	if (callsRes.ok && cell) {
		const transfers = calls.filter((cl) => cl.to === cell && cl.dir.startsWith("outbound"));
		if (!transfers.length) {
			findings.push(
				"• No transfer attempts to your cell in the recent call log. If a caller asked for the real you and no call reached your phone, ask them to say it plainly (\"transfer me\" / \"speak to Nick\") and re-run this check.",
			);
		} else {
			const t = transfers[0];
			if (t.status === "completed" && t.seconds > 0) {
				findings.push(`✓ Latest transfer to your cell (${t.when}) connected for ${t.seconds}s.`);
			} else if (t.status === "no-answer" || (t.status === "completed" && t.seconds === 0)) {
				findings.push(
					`✗ TRANSFER LOOP LIKELY: the twin DID dial your cell (${t.when}) but the call wasn't answered. If your phone never rang, your carrier's missed-call forwarding is sending the twin's transfer straight back to the twin. Fix: forward with the no-answer-only code (**61* on AT&T/T-Mobile) instead of **004*, or Verizon *71 — and avoid the "unreachable" variant when your phone is often on Do Not Disturb.`,
				);
			} else {
				findings.push(`✗ Latest transfer to your cell ended "${t.status}" — the carrier refused or dropped it.`);
			}
		}
	}

	return c.json({ findings, account: { type: acctType }, recentMessages: msgs.slice(0, 10), recentCalls: calls.slice(0, 10) });
});

// Run (or resume) the carrier text-delivery registration. Idempotent: done
// steps are skipped, failures report Twilio's own message and can be rerun.
twin.post(
	"/a2p/register",
	ownerOnly,
	zValidator(
		"json",
		z.object({
			firstName: z.string().min(1).max(50),
			lastName: z.string().min(1).max(50),
			email: z.string().email(),
			phone: z.string().min(10).max(20),
			street: z.string().min(3).max(100),
			city: z.string().min(2).max(50),
			region: z.string().min(2).max(30),
			postalCode: z.string().min(5).max(10),
		}),
	),
	async (c) => {
		const cfg = await loadCfg(c.env);
		if (!cfg.twilioSid || !cfg.twilioToken) return c.json({ error: "twilio_not_connected" }, 400);
		const info = c.req.valid("json");
		const phone = e164(info.phone);
		if (!phone) return c.json({ error: "bad_phone", message: "Use a 10-digit US number." }, 400);
		await dbSet(c.env, "a2p_info", JSON.stringify({ ...info, phone }));
		const result = await a2pRegister(c.env, cfg, { ...info, phone }).catch((e) => ({
			steps: [{ step: "Registration", ok: false, note: e instanceof Error ? e.message : "unknown error" }],
			done: false,
			next: "Send me the error above.",
		}));
		if (result.done) await dbSet(c.env, "a2p_done", "1");
		return c.json(result);
	},
);

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
	// Opening the app counts as a nudge for the self-driving registration.
	c.executionCtx.waitUntil(a2pAutoResume(c.env).then(() => undefined, () => {}));
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
