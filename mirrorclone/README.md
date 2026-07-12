# MirrorClone — your phone-callable digital twin

A tiny Cloudflare Worker that answers your dedicated phone number **in your own
cloned voice**, chats like you (Claude + a persona prompt), and can place
outbound calls from a one-page dashboard.

- **You call it:** dial your Twilio number → the twin answers in your voice.
- **It calls others:** open the dashboard, enter a number, press "Place call".
- **Disclosure built in:** the twin opens every call with "it's Nick's AI
  twin" — FCC rules prohibit AI-voice calls that pretend to be a human, and
  this line keeps you on the right side of them. Don't remove it.

## One-time setup (~20 minutes)

You need three accounts. Collect six values as you go.

### 1. ElevenLabs — your voice clone
1. Sign in at elevenlabs.io (Starter plan or up for instant voice cloning).
2. **Voices → Add voice → Instant Voice Clone** → record or upload 1–2 minutes
   of you speaking naturally → save. Copy the **Voice ID**.
3. Profile → **API Keys** → create one. Copy the **API key**.

### 2. Twilio — the phone number
1. Sign in at twilio.com → buy a **local phone number** with Voice capability.
2. From the Console dashboard copy: **Account SID**, **Auth Token**, and the
   **phone number** (in +1… format).

### 3. Anthropic — the brain
Create an API key at console.anthropic.com. Copy the **API key**.

## Deploy

From this `mirrorclone/` folder:

```sh
# 1. Create the KV store it uses for conversation memory + audio clips,
#    then paste the returned id into wrangler.json where marked.
npx wrangler kv namespace create MEMORY

# 2. Store your six secrets (each command prompts you to paste the value):
npx wrangler secret put TWILIO_ACCOUNT_SID
npx wrangler secret put TWILIO_AUTH_TOKEN
npx wrangler secret put TWILIO_NUMBER
npx wrangler secret put ELEVENLABS_API_KEY
npx wrangler secret put ELEVENLABS_VOICE_ID
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put DASHBOARD_PASSWORD   # invent one; guards outbound calls

# 3. Ship it:
npx wrangler deploy
```

Wrangler prints your worker URL, e.g. `https://mirrorclone.<you>.workers.dev`.

### Point your Twilio number at it
Twilio Console → Phone Numbers → your number → **Voice Configuration** →
"A call comes in" → Webhook → `https://mirrorclone.<you>.workers.dev/voice/incoming`
(HTTP POST) → Save.

## How to use it

- **Talk to your twin:** call your Twilio number from any phone. It answers in
  your cloned voice. Just talk — it listens after each reply. Say "goodbye" to
  end the call.
- **Have it call someone:** open your worker URL in a browser, check that all
  setup rows show green ✓, then enter your dashboard password and the person's
  number (+1 format) and press **Place call**.
- **Change its personality:** edit the `PERSONA` text in `wrangler.json` and
  run `npx wrangler deploy` again. To make it talk more like you, paste a few
  of your own tweets/messages into the persona as style examples. (A Twitter
  archive import can be added later — export yours at X → Settings → Download
  an archive of your data.)

## Notes
- Costs: Twilio ~$1/mo + ~$0.014/min; ElevenLabs from ~$5/mo; Claude usage is
  pennies per call.
- Only place outbound calls to people who expect them; robocall laws
  (TCPA/FCC) require consent for automated calls, and the AI self-disclosure
  at the start of each call is mandatory, not decorative.
- The dashboard password only protects call placement; don't share the URL
  publicly anyway.
