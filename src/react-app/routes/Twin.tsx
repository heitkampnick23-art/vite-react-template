// /twin — set up and control the phone-callable digital twin.
// Guides the owner through: connect Twilio → pick/buy a number (webhook is set
// automatically) → plug in the ElevenLabs cloned voice → tune the persona →
// place outbound calls.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type TwinOwnedNumber, type TwinVoice } from "../lib/api";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Brain, CheckCircle2, Circle, MessageSquare, Phone, PhoneForwarded, PhoneOutgoing, Mic2, Sparkles, X } from "lucide-react";

function errMsg(e: unknown) {
	if (e instanceof Error) {
		const body = (e as Error & { body?: { message?: string; error?: string } }).body;
		return body?.message ?? body?.error ?? e.message;
	}
	return "Something went wrong.";
}

function StepBadge({ done, n }: { done: boolean; n: number }) {
	return done ? (
		<CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400" />
	) : (
		<span className="relative inline-flex h-5 w-5 shrink-0 items-center justify-center">
			<Circle className="h-5 w-5 text-zinc-600" />
			<span className="absolute text-[10px] text-zinc-400">{n}</span>
		</span>
	);
}

const inputCls =
	"w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none placeholder:text-zinc-600 focus:border-brand-400";

export function Twin() {
	const qc = useQueryClient();
	const status = useQuery({ queryKey: ["twin-status"], queryFn: api.twinStatus, retry: false });
	const calls = useQuery({ queryKey: ["twin-calls"], queryFn: api.twinCalls, retry: false, refetchInterval: 30_000 });

	const [sid, setSid] = useState("");
	const [token, setToken] = useState("");
	const [ownedNumbers, setOwnedNumbers] = useState<TwinOwnedNumber[] | null>(null);
	const [accountName, setAccountName] = useState("");
	const [area, setArea] = useState("");
	const [voiceKey, setVoiceKey] = useState("");
	const [voices, setVoices] = useState<TwinVoice[] | null>(null);
	const [persona, setPersona] = useState<string | null>(null);
	const [callTo, setCallTo] = useState("");
	const [callResult, setCallResult] = useState("");
	const [contactName, setContactName] = useState("");
	const [contactPhone, setContactPhone] = useState("");
	const [newFact, setNewFact] = useState("");

	const refresh = () => qc.invalidateQueries({ queryKey: ["twin-status"] });

	const connect = useMutation({
		mutationFn: () => api.twinConnectTwilio({ sid: sid.trim(), token: token.trim() }),
		onSuccess: (d) => {
			setOwnedNumbers(d.numbers);
			setAccountName(d.accountName);
			setToken("");
			refresh();
		},
	});
	const search = useMutation({ mutationFn: () => api.twinSearchNumbers(area.trim() || undefined) });
	const setNumber = useMutation({
		mutationFn: (body: { numberSid?: string; phoneNumber?: string }) => api.twinSetNumber(body),
		onSuccess: () => refresh(),
	});
	const saveVoiceKey = useMutation({
		mutationFn: () => api.twinVoiceConfig({ key: voiceKey.trim() }),
		onSuccess: (d) => {
			setVoices(d.voices ?? []);
			setVoiceKey("");
			refresh();
		},
	});
	const loadVoices = useMutation({
		mutationFn: api.twinVoices,
		onSuccess: (d) => setVoices(d.voices),
	});
	const pickVoice = useMutation({
		mutationFn: (voiceId: string) => api.twinVoiceConfig({ voiceId }),
		onSuccess: () => refresh(),
	});
	const savePersona = useMutation({
		mutationFn: () => api.twinPersona({ persona: persona ?? "" }),
		onSuccess: () => refresh(),
	});
	const call = useMutation({
		mutationFn: () => api.twinCall(callTo.trim()),
		onSuccess: (d) => setCallResult(`Calling ${d.to} now — pick up and say hi to your twin.`),
		onError: (e) => setCallResult(errMsg(e)),
	});
	const contacts = useQuery({ queryKey: ["twin-contacts"], queryFn: api.twinContacts, retry: false });
	const forwarding = useQuery({ queryKey: ["twin-forwarding"], queryFn: api.twinForwarding, retry: false });
	const facts = useQuery({ queryKey: ["twin-facts"], queryFn: api.twinFacts, retry: false });
	const addFact = useMutation({
		mutationFn: () => api.twinAddFact(newFact.trim()),
		onSuccess: () => {
			setNewFact("");
			qc.invalidateQueries({ queryKey: ["twin-facts"] });
		},
	});
	const deleteFact = useMutation({
		mutationFn: (id: string) => api.twinDeleteFact(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["twin-facts"] }),
	});
	const addContact = useMutation({
		mutationFn: () => api.twinAddContact({ name: contactName.trim(), phone: contactPhone.trim() }),
		onSuccess: () => {
			setContactName("");
			setContactPhone("");
			qc.invalidateQueries({ queryKey: ["twin-contacts"] });
		},
	});
	const deleteContact = useMutation({
		mutationFn: (id: string) => api.twinDeleteContact(id),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["twin-contacts"] }),
	});

	if (status.isLoading) {
		return <div className="grid min-h-[50vh] place-items-center text-sm text-zinc-500">Loading…</div>;
	}
	if (status.isError) {
		return (
			<div className="mx-auto max-w-3xl p-6 lg:p-10">
				<h1 className="text-2xl font-bold">Phone Twin</h1>
				<Card className="mt-6 text-sm text-zinc-400">{errMsg(status.error)}</Card>
			</div>
		);
	}
	const s = status.data!;
	const twilioDone = s.twilio.connected;
	const numberDone = !!s.twilio.number;
	const voiceDone = s.voice.hasKey && !!s.voice.voiceId;

	return (
		<div className="mx-auto max-w-3xl p-6 lg:p-10">
			<h1 className="flex items-center gap-2 text-2xl font-bold">
				<Sparkles className="h-6 w-6 text-brand-400" /> Phone Twin
			</h1>
			<p className="mt-2 text-sm text-zinc-400">
				Your AI clone on a real phone number: people call it and talk to you-the-AI, and it can call out for you.
				Every call opens by disclosing it's an AI twin (required by FCC rules for AI voice calls).
			</p>

			{numberDone && (
				<Card className="mt-6 border border-emerald-400/20">
					<div className="flex items-center gap-3">
						<Phone className="h-8 w-8 text-emerald-400" />
						<div>
							<div className="text-xs uppercase tracking-wide text-zinc-400">Your twin's number — call it</div>
							<div className="text-2xl font-bold tabular-nums">{s.twilio.number}</div>
						</div>
					</div>
					{!voiceDone && (
						<p className="mt-3 text-xs text-zinc-500">
							It's live with a standard voice. Finish step 3 to switch to your cloned voice.
						</p>
					)}
				</Card>
			)}

			{/* Step 1 — Twilio */}
			<Card className="mt-6">
				<div className="flex items-center gap-2 font-semibold">
					<StepBadge done={twilioDone} n={1} /> Connect Twilio
					{twilioDone && (
						<span className="ml-auto text-xs font-normal text-zinc-500">
							connected{accountName ? ` — ${accountName}` : ""}{s.twilio.source === "secret" ? " (from stored secret)" : ""}
						</span>
					)}
				</div>
				<p className="mt-2 text-xs text-zinc-500">
					Sign in at <span className="text-zinc-300">twilio.com/console</span>. On the home page, copy{" "}
					<b>Account SID</b> and <b>Auth Token</b> (click "show" to reveal it) and paste them here. They're stored
					encrypted and only used to run your twin.
				</p>
				<div className="mt-3 flex flex-col gap-2">
					<input className={inputCls} placeholder="Account SID — starts with AC…" value={sid} onChange={(e) => setSid(e.target.value)} />
					<input className={inputCls} placeholder="Auth Token" type="password" value={token} onChange={(e) => setToken(e.target.value)} />
					<Button size="sm" className="self-start" disabled={!sid.trim() || !token.trim() || connect.isPending} onClick={() => connect.mutate()}>
						{connect.isPending ? "Checking…" : twilioDone ? "Reconnect" : "Connect"}
					</Button>
					{connect.isError && <div className="text-xs text-red-400">{errMsg(connect.error)}</div>}
				</div>
			</Card>

			{/* Step 2 — Number */}
			<Card className="mt-4">
				<div className="flex items-center gap-2 font-semibold">
					<StepBadge done={numberDone} n={2} /> Phone number
					{numberDone && <span className="ml-auto text-xs font-normal text-zinc-500">{s.twilio.number}</span>}
				</div>
				{!twilioDone ? (
					<p className="mt-2 text-xs text-zinc-500">Connect Twilio first.</p>
				) : (
					<div className="mt-3 space-y-4 text-sm">
						{ownedNumbers && ownedNumbers.length > 0 && (
							<div>
								<div className="mb-1 text-xs text-zinc-400">Numbers already on your account — one click to use it for the twin:</div>
								{ownedNumbers.map((n) => (
									<div key={n.sid} className="flex items-center justify-between border-b border-white/5 py-2 last:border-0">
										<span className="tabular-nums">{n.phoneNumber}</span>
										<Button size="sm" variant="secondary" disabled={setNumber.isPending} onClick={() => setNumber.mutate({ numberSid: n.sid })}>
											Use for twin
										</Button>
									</div>
								))}
							</div>
						)}
						<div>
							<div className="mb-1 text-xs text-zinc-400">
								{ownedNumbers?.length ? "Or buy a new number" : "Buy a number"} (~$1.15/mo from your Twilio credits):
							</div>
							<div className="flex gap-2">
								<input className={inputCls + " max-w-40"} placeholder="Area code (optional)" value={area} onChange={(e) => setArea(e.target.value)} />
								<Button size="sm" variant="outline" disabled={search.isPending} onClick={() => search.mutate()}>
									{search.isPending ? "Searching…" : "Find numbers"}
								</Button>
							</div>
							{search.isError && <div className="mt-1 text-xs text-red-400">{errMsg(search.error)}</div>}
							{search.data?.numbers.map((n) => (
								<div key={n.phoneNumber} className="flex items-center justify-between border-b border-white/5 py-2 last:border-0">
									<span>
										<span className="tabular-nums">{n.name || n.phoneNumber}</span>
										<span className="ml-2 text-xs text-zinc-500">{[n.locality, n.region].filter(Boolean).join(", ")}</span>
									</span>
									<Button size="sm" disabled={setNumber.isPending} onClick={() => setNumber.mutate({ phoneNumber: n.phoneNumber })}>
										Buy &amp; connect
									</Button>
								</div>
							))}
							{search.data && search.data.numbers.length === 0 && (
								<div className="mt-1 text-xs text-zinc-500">Nothing found — try a different area code.</div>
							)}
						</div>
						{setNumber.isError && <div className="text-xs text-red-400">{errMsg(setNumber.error)}</div>}
						{setNumber.data && (
							<div className="text-xs text-emerald-400">
								{setNumber.data.purchased ? "Bought" : "Connected"} {setNumber.data.number} — the twin now answers it.
							</div>
						)}
					</div>
				)}
			</Card>

			{/* Step 3 — Voice */}
			<Card className="mt-4">
				<div className="flex items-center gap-2 font-semibold">
					<StepBadge done={voiceDone} n={3} /> <Mic2 className="h-4 w-4" /> Your cloned voice
					{s.voice.hasKey && (
						<span className="ml-auto text-xs font-normal text-zinc-500">
							key on file{s.voice.source === "secret" ? " (stored secret)" : ""}
							{s.voice.voiceId ? ` — voice set` : " — pick a voice below"}
						</span>
					)}
				</div>
				<p className="mt-2 text-xs text-zinc-500">
					Paste your ElevenLabs API key (elevenlabs.io → profile → API Keys). Then pick your cloned voice. Until
					then the twin uses a standard voice.
				</p>
				<div className="mt-3 flex flex-col gap-2">
					<div className="flex gap-2">
						<input className={inputCls} placeholder="ElevenLabs API key" type="password" value={voiceKey} onChange={(e) => setVoiceKey(e.target.value)} />
						<Button size="sm" disabled={!voiceKey.trim() || saveVoiceKey.isPending} onClick={() => saveVoiceKey.mutate()}>
							{saveVoiceKey.isPending ? "Checking…" : "Save key"}
						</Button>
					</div>
					{saveVoiceKey.isError && <div className="text-xs text-red-400">{errMsg(saveVoiceKey.error)}</div>}
					{s.voice.hasKey && !voices && (
						<Button size="sm" variant="outline" className="self-start" disabled={loadVoices.isPending} onClick={() => loadVoices.mutate()}>
							{loadVoices.isPending ? "Loading…" : "Show my voices"}
						</Button>
					)}
					{loadVoices.isError && <div className="text-xs text-red-400">{errMsg(loadVoices.error)}</div>}
					{voices?.map((v) => (
						<div key={v.id} className="flex items-center justify-between border-b border-white/5 py-2 last:border-0 text-sm">
							<span>
								{v.name}
								<span className="ml-2 text-xs text-zinc-500">{v.category}</span>
								{s.voice.voiceId === v.id && <span className="ml-2 text-xs text-emerald-400">✓ in use</span>}
							</span>
							<Button size="sm" variant={s.voice.voiceId === v.id ? "secondary" : "primary"} disabled={pickVoice.isPending} onClick={() => pickVoice.mutate(v.id)}>
								Use this voice
							</Button>
						</div>
					))}
				</div>
			</Card>

			{/* Persona */}
			<Card className="mt-4">
				<div className="font-semibold">Personality</div>
				<p className="mt-1 text-xs text-zinc-500">How the twin talks and behaves on calls. Paste a few of your own messages as style examples to make it sound more like you.</p>
				<textarea
					className={inputCls + " mt-3 min-h-28"}
					value={persona ?? s.persona}
					onChange={(e) => setPersona(e.target.value)}
				/>
				<Button size="sm" className="mt-2" disabled={persona === null || savePersona.isPending} onClick={() => savePersona.mutate()}>
					{savePersona.isPending ? "Saving…" : "Save personality"}
				</Button>
				{savePersona.isError && <div className="mt-1 text-xs text-red-400">{errMsg(savePersona.error)}</div>}
			</Card>

			{/* Outbound */}
			<Card className="mt-4">
				<div className="flex items-center gap-2 font-semibold">
					<PhoneOutgoing className="h-4 w-4" /> Have your twin call someone
				</div>
				<p className="mt-1 text-xs text-zinc-500">
					Only call people who expect it — robocall rules (TCPA) require consent, and the twin always introduces
					itself as your AI.
				</p>
				<div className="mt-3 flex gap-2">
					<input className={inputCls + " max-w-56"} placeholder="+15551234567" value={callTo} onChange={(e) => setCallTo(e.target.value)} />
					<Button size="sm" disabled={!numberDone || !/^\+\d{8,15}$/.test(callTo.trim()) || call.isPending} onClick={() => call.mutate()}>
						{call.isPending ? "Dialing…" : "Place call"}
					</Button>
				</div>
				{callResult && <div className="mt-2 text-xs text-zinc-400">{callResult}</div>}
			</Card>

			{/* Smart texting + contacts */}
			<Card className="mt-4">
				<div className="flex items-center gap-2 font-semibold">
					<MessageSquare className="h-4 w-4" /> Smart texting &amp; contacts
				</div>
				<p className="mt-1 text-xs text-zinc-500">
					Text your twin's number in plain English — <i>"tell Jake I'll be there at 6"</i> — and it figures out who you
					mean, writes the text in your style, and sends it. Save people here or by texting{" "}
					<i>"add Jake 9525551234"</i> to the twin.
				</p>
				<div className="mt-3 flex gap-2">
					<input className={inputCls + " max-w-44"} placeholder="Name" value={contactName} onChange={(e) => setContactName(e.target.value)} />
					<input className={inputCls + " max-w-48"} placeholder="9525551234" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} />
					<Button size="sm" disabled={!contactName.trim() || !contactPhone.trim() || addContact.isPending} onClick={() => addContact.mutate()}>
						{addContact.isPending ? "Saving…" : "Add"}
					</Button>
				</div>
				{addContact.isError && <div className="mt-1 text-xs text-red-400">{errMsg(addContact.error)}</div>}
				{contacts.data?.contacts.length === 0 && (
					<div className="mt-3 text-sm text-zinc-500">No contacts yet.</div>
				)}
				{contacts.data?.contacts.map((k) => (
					<div key={k.id} className="flex items-center justify-between border-b border-white/5 py-2 text-sm last:border-0">
						<span>
							{k.name} <span className="ml-2 tabular-nums text-xs text-zinc-500">{k.phone}</span>
							{k.notes && <span className="ml-2 text-xs text-zinc-600">{k.notes}</span>}
						</span>
						<button className="text-zinc-600 hover:text-red-400" title="Remove" onClick={() => deleteContact.mutate(k.id)}>
							<X className="h-4 w-4" />
						</button>
					</div>
				))}
			</Card>

			{/* Facts memory */}
			<Card className="mt-4">
				<div className="flex items-center gap-2 font-semibold">
					<Brain className="h-4 w-4" /> Facts about you
				</div>
				<p className="mt-1 text-xs text-zinc-500">
					Things your twin knows and uses to answer real questions on calls and texts. Add them here or text the twin{" "}
					<i>"remember I'm out of town until Friday"</i>.
				</p>
				<div className="mt-3 flex gap-2">
					<input
						className={inputCls}
						placeholder="e.g. The garage code for deliveries is 4482"
						value={newFact}
						onChange={(e) => setNewFact(e.target.value)}
						onKeyDown={(e) => e.key === "Enter" && newFact.trim().length >= 3 && addFact.mutate()}
					/>
					<Button size="sm" disabled={newFact.trim().length < 3 || addFact.isPending} onClick={() => addFact.mutate()}>
						{addFact.isPending ? "Saving…" : "Add"}
					</Button>
				</div>
				{addFact.isError && <div className="mt-1 text-xs text-red-400">{errMsg(addFact.error)}</div>}
				{facts.data?.facts.length === 0 && <div className="mt-3 text-sm text-zinc-500">Nothing yet — the twin only knows its persona.</div>}
				{facts.data?.facts.map((f) => (
					<div key={f.id} className="flex items-center justify-between border-b border-white/5 py-2 text-sm last:border-0">
						<span>{f.fact}</span>
						<button className="ml-3 shrink-0 text-zinc-600 hover:text-red-400" title="Forget" onClick={() => deleteFact.mutate(f.id)}>
							<X className="h-4 w-4" />
						</button>
					</div>
				))}
			</Card>

			{/* Missed-call forwarding */}
			{forwarding.data && (
				<Card className="mt-4">
					<div className="flex items-center gap-2 font-semibold">
						<PhoneForwarded className="h-4 w-4" /> Forward your missed calls to the twin
					</div>
					<p className="mt-1 text-xs text-zinc-500">
						Dial one code from your personal phone and every call you miss rings your twin (
						<span className="tabular-nums text-zinc-300">{forwarding.data.number}</span>) instead of voicemail. Calls
						you answer are untouched.
					</p>
					{forwarding.data.carriers.map((cr) => (
						<div key={cr.carrier} className="mt-3 text-sm">
							<div className="text-xs font-semibold text-zinc-400">{cr.carrier}</div>
							{cr.activate.map((a) => (
								<div key={a.code} className="flex items-center justify-between border-b border-white/5 py-1.5 last:border-0">
									<span className="text-xs text-zinc-500">{a.label}</span>
									<code className="ml-3 shrink-0 rounded bg-black/40 px-2 py-0.5 text-xs text-brand-300">{a.code}</code>
								</div>
							))}
							<div className="flex items-center justify-between py-1.5">
								<span className="text-xs text-zinc-600">Turn off</span>
								<code className="ml-3 shrink-0 rounded bg-black/40 px-2 py-0.5 text-xs text-zinc-400">{cr.deactivate}</code>
							</div>
						</div>
					))}
					<ul className="mt-3 list-disc pl-4 text-xs text-zinc-600">
						{forwarding.data.notes.map((n) => (
							<li key={n}>{n}</li>
						))}
					</ul>
				</Card>
			)}

			{/* Transcripts */}
			<Card className="mt-4">
				<div className="font-semibold">Recent conversations</div>
				<p className="mt-1 text-xs text-zinc-500">Everything your twin talks about, saved as text. Newest first.</p>
				{calls.data?.calls.length === 0 && <div className="mt-3 text-sm text-zinc-500">No calls yet — dial your number and say hi.</div>}
				{calls.data?.calls.map((call) => (
					<details key={call.id} className="mt-3 rounded-lg border border-white/5 bg-black/20 p-3 text-sm">
						<summary className="cursor-pointer">
							<span className="tabular-nums">{call.from ?? "unknown caller"}</span>
							<span className="ml-2 text-xs text-zinc-500">{new Date(call.startedAt).toLocaleString()}</span>
						</summary>
						<div className="mt-2 space-y-1">
							{call.turns.map((t, i) => (
								<div key={i} className={t.role === "assistant" ? "text-brand-300" : "text-zinc-200"}>
									<b>{t.role === "assistant" ? "Twin" : "Caller"}:</b> {t.content}
								</div>
							))}
						</div>
					</details>
				))}
			</Card>
		</div>
	);
}
