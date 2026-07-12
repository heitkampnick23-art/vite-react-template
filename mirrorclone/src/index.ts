// MirrorClone — a phone-callable digital twin.
//
// Inbound:  Twilio number → POST /voice/incoming → greeting in your cloned
//           voice → speech-gather loop → Claude replies in persona →
//           ElevenLabs TTS → <Play> → gather again.
// Outbound: POST /call/outbound {to} (password-protected) → Twilio places a
//           call from your number and runs the same conversation loop.
//
// Secrets (wrangler secret put …): TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
// TWILIO_NUMBER, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, ANTHROPIC_API_KEY,
// DASHBOARD_PASSWORD. See README.md for full setup.

export interface Env {
	MEMORY: KVNamespace;
	APP_NAME: string;
	PERSONA: string;
	TWILIO_ACCOUNT_SID: string;
	TWILIO_AUTH_TOKEN: string;
	TWILIO_NUMBER: string;
	ELEVENLABS_API_KEY: string;
	ELEVENLABS_VOICE_ID: string;
	ANTHROPIC_API_KEY: string;
	DASHBOARD_PASSWORD: string;
}

type Turn = { role: "user" | "assistant"; content: string };

const AUDIO_TTL = 600; // seconds a generated clip stays playable
const CONVO_TTL = 3600;
const MAX_TURNS = 20;

// Required by FCC rules for AI-generated voice calls: the twin must
// identify itself as an AI at the start of every call. Do not remove.
const DISCLOSURE = "Hey, it's Nick's AI twin speaking on his behalf.";

function xml(body: string) {
	return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`, {
		headers: { "content-type": "text/xml" },
	});
}

function escapeXml(s: string) {
	return s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);
}

// --- Twilio webhook signature validation (HMAC-SHA1 of URL + sorted params) ---
async function validTwilioSignature(req: Request, url: string, params: URLSearchParams, authToken: string) {
	const sig = req.headers.get("X-Twilio-Signature");
	if (!sig) return false;
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

// --- ElevenLabs: text → mp3 stored in KV, returns a playable URL ---
async function speak(env: Env, origin: string, text: string): Promise<string | null> {
	const res = await fetch(
		`https://api.elevenlabs.io/v1/text-to-speech/${env.ELEVENLABS_VOICE_ID}?output_format=mp3_22050_32`,
		{
			method: "POST",
			headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "content-type": "application/json" },
			body: JSON.stringify({
				text,
				model_id: "eleven_turbo_v2_5",
				voice_settings: { stability: 0.5, similarity_boost: 0.8 },
			}),
		},
	);
	if (!res.ok) return null;
	const id = crypto.randomUUID();
	await env.MEMORY.put(`audio:${id}`, await res.arrayBuffer(), { expirationTtl: AUDIO_TTL });
	return `${origin}/voice/audio/${id}`;
}

// --- Claude: persona reply ---
async function personaReply(env: Env, history: Turn[]): Promise<string> {
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
				env.PERSONA +
				" You are on a live phone call, so answer in 1-3 short conversational sentences — never lists, never markdown. If the caller says goodbye, say a warm goodbye.",
			messages: history,
		}),
	});
	if (!res.ok) return "Sorry, I glitched for a second there. Say that again?";
	const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
	return data.content?.find((b) => b.type === "text")?.text?.trim() || "Sorry, say that again?";
}

async function loadConvo(env: Env, callSid: string): Promise<Turn[]> {
	return (await env.MEMORY.get<Turn[]>(`convo:${callSid}`, "json")) ?? [];
}

async function saveConvo(env: Env, callSid: string, history: Turn[]) {
	await env.MEMORY.put(`convo:${callSid}`, JSON.stringify(history.slice(-MAX_TURNS)), {
		expirationTtl: CONVO_TTL,
	});
}

function gather(playUrl: string | null, fallbackText: string, origin: string) {
	const speech = playUrl ? `<Play>${escapeXml(playUrl)}</Play>` : `<Say>${escapeXml(fallbackText)}</Say>`;
	return (
		`${speech}<Gather input="speech" action="${origin}/voice/respond" method="POST" speechTimeout="auto" language="en-US"/>` +
		`<Say>Are you still there?</Say>` +
		`<Gather input="speech" action="${origin}/voice/respond" method="POST" speechTimeout="auto" language="en-US"/>` +
		`<Hangup/>`
	);
}

function unauthorized() {
	return new Response("unauthorized", { status: 401 });
}

const DASHBOARD_HTML = (configured: Record<string, boolean>, number: string) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MirrorClone</title>
<style>
body{font-family:system-ui;background:#0b0b10;color:#eee;max-width:560px;margin:40px auto;padding:0 16px}
h1{font-size:22px} .card{background:#17171f;border:1px solid #2a2a35;border-radius:12px;padding:16px;margin:12px 0}
input,button{font-size:16px;padding:10px;border-radius:8px;border:1px solid #333;width:100%;box-sizing:border-box}
button{background:#6d5cff;color:#fff;border:0;margin-top:8px;cursor:pointer}
.ok{color:#5dd88f}.bad{color:#ff7b7b} code{background:#222;padding:1px 5px;border-radius:4px}
</style></head><body>
<h1>MirrorClone — Nick's phone twin</h1>
<div class="card"><b>Setup status</b><br>
${Object.entries(configured)
	.map(([k, v]) => `<div class="${v ? "ok" : "bad"}">${v ? "✓" : "✗"} ${k}</div>`)
	.join("")}
<div style="margin-top:8px">Twin's number: <code>${number || "not set"}</code> — call it to talk to your twin.</div>
</div>
<div class="card"><b>Have your twin call someone</b>
<form method="POST" action="/call/outbound">
<input name="password" type="password" placeholder="Dashboard password" required>
<input name="to" type="tel" placeholder="+15551234567" required>
<button>Place call</button>
</form>
<div style="font-size:12px;color:#999;margin-top:8px">The twin opens every call by identifying itself as Nick's AI twin (required for AI voice calls).</div>
</div>
</body></html>`;

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);
		const origin = url.origin;

		// Serve generated voice clips to Twilio.
		if (req.method === "GET" && url.pathname.startsWith("/voice/audio/")) {
			const id = url.pathname.split("/").pop()!;
			const buf = await env.MEMORY.get(`audio:${id}`, "arrayBuffer");
			if (!buf) return new Response("gone", { status: 404 });
			return new Response(buf, { headers: { "content-type": "audio/mpeg" } });
		}

		// Twilio: call connected (inbound or outbound leg).
		if (req.method === "POST" && url.pathname === "/voice/incoming") {
			const params = new URLSearchParams(await req.text());
			if (!(await validTwilioSignature(req, origin + url.pathname, params, env.TWILIO_AUTH_TOKEN))) {
				return unauthorized();
			}
			const greeting = `${DISCLOSURE} What's up?`;
			const callSid = params.get("CallSid") ?? "unknown";
			await saveConvo(env, callSid, [{ role: "assistant", content: greeting }]);
			const audio = await speak(env, origin, greeting);
			return xml(gather(audio, greeting, origin));
		}

		// Twilio: caller said something.
		if (req.method === "POST" && url.pathname === "/voice/respond") {
			const params = new URLSearchParams(await req.text());
			if (!(await validTwilioSignature(req, origin + url.pathname, params, env.TWILIO_AUTH_TOKEN))) {
				return unauthorized();
			}
			const callSid = params.get("CallSid") ?? "unknown";
			const heard = (params.get("SpeechResult") ?? "").trim();
			if (!heard) return xml(gather(null, "Sorry, I didn't catch that. One more time?", origin));

			const history = await loadConvo(env, callSid);
			history.push({ role: "user", content: heard });
			const reply = await personaReply(env, history);
			history.push({ role: "assistant", content: reply });
			await saveConvo(env, callSid, history);

			const audio = await speak(env, origin, reply);
			const done = /\b(goodbye|bye|talk later|hang up)\b/i.test(heard);
			if (done) {
				return xml(audio ? `<Play>${escapeXml(audio)}</Play><Hangup/>` : `<Say>${escapeXml(reply)}</Say><Hangup/>`);
			}
			return xml(gather(audio, reply, origin));
		}

		// Dashboard: place an outbound call.
		if (req.method === "POST" && url.pathname === "/call/outbound") {
			const form = await req.formData();
			if (form.get("password") !== env.DASHBOARD_PASSWORD || !env.DASHBOARD_PASSWORD) return unauthorized();
			const to = String(form.get("to") ?? "");
			if (!/^\+\d{8,15}$/.test(to)) return new Response("Use E.164 format, e.g. +15551234567", { status: 400 });
			const res = await fetch(
				`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Calls.json`,
				{
					method: "POST",
					headers: {
						Authorization: "Basic " + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
						"content-type": "application/x-www-form-urlencoded",
					},
					body: new URLSearchParams({ To: to, From: env.TWILIO_NUMBER, Url: `${origin}/voice/incoming` }),
				},
			);
			if (!res.ok) {
				const err = await res.text();
				return new Response("Twilio rejected the call: " + err.slice(0, 400), { status: 502 });
			}
			return new Response("Calling " + to + " now — the twin is on its way. Go back and refresh.", {
				headers: { "content-type": "text/plain" },
			});
		}

		// Dashboard.
		if (req.method === "GET" && url.pathname === "/") {
			return new Response(
				DASHBOARD_HTML(
					{
						"Twilio account": !!env.TWILIO_ACCOUNT_SID && !!env.TWILIO_AUTH_TOKEN,
						"Twilio number": !!env.TWILIO_NUMBER,
						"ElevenLabs key": !!env.ELEVENLABS_API_KEY,
						"Cloned voice ID": !!env.ELEVENLABS_VOICE_ID,
						"Claude API key": !!env.ANTHROPIC_API_KEY,
						"Dashboard password": !!env.DASHBOARD_PASSWORD,
					},
					env.TWILIO_NUMBER ?? "",
				),
				{ headers: { "content-type": "text/html" } },
			);
		}

		return new Response("not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;
