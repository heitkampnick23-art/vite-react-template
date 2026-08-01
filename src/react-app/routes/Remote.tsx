// /app — the phone-first twin remote. One screen, big touch targets: your
// twins with tap-to-call/text, tap-to-dial forwarding codes, quick add for
// facts and contacts, digest-now, and the latest conversations. The
// home-screen app (manifest start_url) opens here; /twin remains the full
// setup page.

import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Card } from "../components/ui/Card";
import { Button } from "../components/ui/Button";
import { Brain, MessageSquare, Moon, Phone, PhoneForwarded, PhoneOutgoing, Settings, Stethoscope, UserPlus } from "lucide-react";

function errMsg(e: unknown) {
	if (e instanceof Error) {
		const body = (e as Error & { body?: { message?: string; error?: string } }).body;
		return body?.message ?? body?.error ?? e.message;
	}
	return "Something went wrong.";
}

const inputCls =
	"w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm outline-none placeholder:text-zinc-600 focus:border-brand-400";

// tel: needs * and # percent-encoded to survive iOS dialing.
const telHref = (code: string) => `tel:${code.replace(/\*/g, "%2A").replace(/#/g, "%23")}`;

export function Remote() {
	const qc = useQueryClient();
	const status = useQuery({ queryKey: ["twin-status"], queryFn: api.twinStatus, retry: false });
	const profiles = useQuery({ queryKey: ["twin-profiles"], queryFn: api.twinProfiles, retry: false });
	const calls = useQuery({ queryKey: ["twin-calls"], queryFn: api.twinCalls, retry: false, refetchInterval: 30_000 });
	const [fwdTarget, setFwdTarget] = useState("");
	const forwarding = useQuery({
		queryKey: ["twin-forwarding", fwdTarget],
		queryFn: () => api.twinForwarding(fwdTarget || undefined),
		retry: false,
	});

	const contactsList = useQuery({ queryKey: ["twin-contacts"], queryFn: api.twinContacts, retry: false });
	const [callTo, setCallTo] = useState("");
	const [callAs, setCallAs] = useState("");
	const placeCall = useMutation({
		mutationFn: () => {
			const digits = callTo.replace(/\D/g, "");
			const to = digits.length === 10 ? `+1${digits}` : `+${digits}`;
			return api.twinCall(to, callAs || undefined);
		},
	});
	const [fact, setFact] = useState("");
	const addFact = useMutation({
		mutationFn: () => api.twinAddFact(fact.trim()),
		onSuccess: () => setFact(""),
	});
	const [cName, setCName] = useState("");
	const [cPhone, setCPhone] = useState("");
	const addContact = useMutation({
		mutationFn: () => api.twinAddContact({ name: cName.trim(), phone: cPhone.trim() }),
		onSuccess: () => {
			setCName("");
			setCPhone("");
			qc.invalidateQueries({ queryKey: ["twin-contacts"] });
		},
	});
	const digest = useMutation({ mutationFn: api.twinDigestNow });
	const syscheck = useMutation({ mutationFn: api.twinSysCheck });
	const [a2p, setA2p] = useState({
		firstName: "Nick",
		lastName: "",
		email: "heitkampnick23@gmail.com",
		phone: "9525641126",
		street: "",
		city: "",
		region: "MN",
		postalCode: "",
	});
	const a2pReady =
		a2p.firstName.trim() && a2p.lastName.trim() && a2p.email.trim() && a2p.phone.trim() && a2p.street.trim() && a2p.city.trim() && a2p.region.trim() && a2p.postalCode.trim();
	const registerA2p = useMutation({ mutationFn: () => api.twinA2pRegister(a2p) });

	if (status.isLoading) {
		return <div className="grid min-h-[50vh] place-items-center text-sm text-zinc-500">Loading…</div>;
	}
	if (status.isError) {
		return (
			<div className="mx-auto max-w-md p-4">
				<Card className="text-sm text-zinc-400">{errMsg(status.error)}</Card>
			</div>
		);
	}
	const s = status.data!;
	const twins = [
		{ id: "", name: s.twinName, number: s.twilio.number },
		...(profiles.data?.profiles.filter((p) => p.number).map((p) => ({ id: p.id, name: p.name, number: p.number })) ?? []),
	].filter((t): t is { id: string; name: string; number: string } => !!t.number);

	return (
		<div className="mx-auto max-w-md p-4" style={{ paddingBottom: "calc(2.5rem + env(safe-area-inset-bottom))" }}>
			{/* Twins */}
			{twins.map((t) => (
				<Card key={t.id || "main"} className="mb-3">
					<div className="flex items-center justify-between">
						<div>
							<div className="font-semibold">{t.name}</div>
							<div className="tabular-nums text-sm text-zinc-400">{t.number}</div>
						</div>
						<div className="flex gap-2">
							<a href={`tel:${t.number}`} className="rounded-lg bg-emerald-500/15 p-3 text-emerald-300" aria-label={`Call ${t.name}`}>
								<Phone className="h-5 w-5" />
							</a>
							<a href={`sms:${t.number}`} className="rounded-lg bg-sky-500/15 p-3 text-sky-300" aria-label={`Text ${t.name}`}>
								<MessageSquare className="h-5 w-5" />
							</a>
						</div>
					</div>
				</Card>
			))}

			{/* Have a twin place a call */}
			<Card className="mb-3">
				<div className="flex items-center gap-2 text-sm font-semibold">
					<PhoneOutgoing className="h-4 w-4" /> Have a twin call someone
				</div>
				<p className="mt-1 text-xs text-zinc-500">
					Pick a contact or type a number — the twin dials them and handles the conversation. It always introduces
					itself as your AI; only call people who expect it.
				</p>
				{(contactsList.data?.contacts.length ?? 0) > 0 && (
					<select
						className={inputCls + " mt-2"}
						value=""
						onChange={(e) => e.target.value && setCallTo(e.target.value)}
					>
						<option value="">Pick a contact…</option>
						{contactsList.data!.contacts.map((k) => (
							<option key={k.id} value={k.phone}>
								{k.name} ({k.phone})
							</option>
						))}
					</select>
				)}
				<div className="mt-2 flex gap-2">
					<input
						className={inputCls}
						placeholder="9525551234"
						inputMode="tel"
						value={callTo}
						onChange={(e) => setCallTo(e.target.value)}
					/>
					{(profiles.data?.profiles.filter((p) => p.number).length ?? 0) > 0 && (
						<select className={inputCls + " max-w-36"} value={callAs} onChange={(e) => setCallAs(e.target.value)}>
							<option value="">As: {s.twinName}</option>
							{profiles.data!.profiles.filter((p) => p.number).map((p) => (
								<option key={p.id} value={p.id}>
									As: {p.name}
								</option>
							))}
						</select>
					)}
					<Button
						size="sm"
						disabled={callTo.replace(/\D/g, "").length < 10 || placeCall.isPending}
						onClick={() => placeCall.mutate()}
					>
						{placeCall.isPending ? "Dialing…" : "Call"}
					</Button>
				</div>
				{placeCall.isSuccess && <div className="mt-1 text-xs text-emerald-400">Dialing {placeCall.data.to} now.</div>}
				{placeCall.isError && <div className="mt-1 text-xs text-red-400">{errMsg(placeCall.error)}</div>}
			</Card>

			{/* Forwarding */}
			{forwarding.data && (
				<Card className="mb-3">
					<div className="flex items-center gap-2 text-sm font-semibold">
						<PhoneForwarded className="h-4 w-4" /> Missed calls go to…
					</div>
					{forwarding.data.targets.length > 1 && (
						<select className={inputCls + " mt-2"} value={forwarding.data.number} onChange={(e) => setFwdTarget(e.target.value)}>
							{forwarding.data.targets.map((t) => (
								<option key={t.number} value={t.number}>
									{t.name} ({t.number})
								</option>
							))}
						</select>
					)}
					<p className="mt-2 text-xs text-zinc-500">Tap your carrier's code to dial it — that turns forwarding on.</p>
					<div className="mt-2 flex flex-col gap-1.5">
						{forwarding.data.carriers.slice(0, 1).flatMap((cr) => cr.activate).map((a) => (
							<a key={a.code} href={telHref(a.code)} className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-2.5 text-sm">
								<span className="text-zinc-400">AT&amp;T / T-Mobile</span>
								<code className="text-brand-300">{a.code}</code>
							</a>
						))}
						{forwarding.data.carriers.slice(2, 3).flatMap((cr) => cr.activate).map((a) => (
							<a key={a.code} href={telHref(a.code)} className="flex items-center justify-between rounded-lg bg-white/5 px-3 py-2.5 text-sm">
								<span className="text-zinc-400">Verizon</span>
								<code className="text-brand-300">{a.code}</code>
							</a>
						))}
						<div className="flex gap-1.5">
							<a href={telHref("##004#")} className="flex-1 rounded-lg bg-white/5 px-3 py-2 text-center text-xs text-zinc-500">
								Off (AT&amp;T/T-Mob): ##004#
							</a>
							<a href={telHref("*73")} className="flex-1 rounded-lg bg-white/5 px-3 py-2 text-center text-xs text-zinc-500">
								Off (Verizon): *73
							</a>
						</div>
					</div>
				</Card>
			)}

			{/* Quick add fact */}
			<Card className="mb-3">
				<div className="flex items-center gap-2 text-sm font-semibold">
					<Brain className="h-4 w-4" /> Tell your twins something
				</div>
				<div className="mt-2 flex gap-2">
					<input
						className={inputCls}
						placeholder="e.g. I'm out of town until Friday"
						value={fact}
						onChange={(e) => setFact(e.target.value)}
						onKeyDown={(e) => e.key === "Enter" && fact.trim().length >= 3 && addFact.mutate()}
					/>
					<Button size="sm" disabled={fact.trim().length < 3 || addFact.isPending} onClick={() => addFact.mutate()}>
						{addFact.isPending ? "…" : "Save"}
					</Button>
				</div>
				{addFact.isSuccess && <div className="mt-1 text-xs text-emerald-400">Saved — both twins know it now.</div>}
				{addFact.isError && <div className="mt-1 text-xs text-red-400">{errMsg(addFact.error)}</div>}
			</Card>

			{/* Quick add contact */}
			<Card className="mb-3">
				<div className="flex items-center gap-2 text-sm font-semibold">
					<UserPlus className="h-4 w-4" /> Add a contact
				</div>
				<div className="mt-2 flex gap-2">
					<input className={inputCls} placeholder="Name" value={cName} onChange={(e) => setCName(e.target.value)} />
					<input className={inputCls} placeholder="9525551234" value={cPhone} onChange={(e) => setCPhone(e.target.value)} />
					<Button size="sm" disabled={!cName.trim() || !cPhone.trim() || addContact.isPending} onClick={() => addContact.mutate()}>
						{addContact.isPending ? "…" : "Add"}
					</Button>
				</div>
				{addContact.isSuccess && <div className="mt-1 text-xs text-emerald-400">Saved.</div>}
				{addContact.isError && <div className="mt-1 text-xs text-red-400">{errMsg(addContact.error)}</div>}
			</Card>

			{/* Digest now */}
			<Card className="mb-3">
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-2 text-sm font-semibold">
						<Moon className="h-4 w-4" /> Today's digest
					</div>
					<Button size="sm" variant="outline" disabled={digest.isPending} onClick={() => digest.mutate()}>
						{digest.isPending ? "Sending…" : "Text it to me now"}
					</Button>
				</div>
				{digest.data && <div className="mt-1 text-xs text-zinc-500">{digest.data.ok ? "Sent — check your messages." : digest.data.note}</div>}
			</Card>

			{/* System check */}
			<Card className="mb-3">
				<div className="flex items-center justify-between">
					<div className="flex items-center gap-2 text-sm font-semibold">
						<Stethoscope className="h-4 w-4" /> System check
					</div>
					<Button size="sm" variant="outline" disabled={syscheck.isPending} onClick={() => syscheck.mutate()}>
						{syscheck.isPending ? "Checking…" : "Run check"}
					</Button>
				</div>
				<p className="mt-1 text-xs text-zinc-500">
					Verifies both twins' wiring (auto-fixes it), then reads Twilio's own delivery log to explain any failed
					texts or transfers.
				</p>
				{syscheck.isError && <div className="mt-2 text-xs text-red-400">{errMsg(syscheck.error)}</div>}
				{syscheck.data && (
					<div className="mt-2 space-y-1.5">
						{syscheck.data.findings.map((f, i) => (
							<div
								key={i}
								className={
									"rounded-lg px-2.5 py-1.5 text-xs " +
									(f.startsWith("✗")
										? "bg-red-500/10 text-red-300"
										: f.startsWith("✓")
											? "bg-emerald-500/10 text-emerald-300"
											: "bg-white/5 text-zinc-400")
								}
							>
								{f}
							</div>
						))}
						{(syscheck.data.recentMessages?.length ?? 0) > 0 && (
							<details className="rounded-lg border border-white/5 bg-black/20 p-2 text-xs text-zinc-400">
								<summary className="cursor-pointer">Raw message log</summary>
								{syscheck.data.recentMessages!.map((m, i) => (
									<div key={i} className="mt-1 border-b border-white/5 pb-1 last:border-0">
										{m.dir.includes("inbound") ? "→ in" : "← out"} {m.from} → {m.to}: <b>{m.status}</b>
										{m.errorCode ? <span className="text-red-400"> (err {m.errorCode})</span> : null}
										<div className="text-zinc-600">{m.body}</div>
									</div>
								))}
							</details>
						)}
						{(syscheck.data.recentCalls?.length ?? 0) > 0 && (
							<details className="rounded-lg border border-white/5 bg-black/20 p-2 text-xs text-zinc-400">
								<summary className="cursor-pointer">Raw call log</summary>
								{syscheck.data.recentCalls!.map((cl, i) => (
									<div key={i} className="mt-1 border-b border-white/5 pb-1 last:border-0">
										{cl.dir} {cl.from} → {cl.to}: <b>{cl.status}</b> {cl.seconds ? `${cl.seconds}s` : ""}
									</div>
								))}
							</details>
						)}
					</div>
				)}
			</Card>

			{/* A2P text-delivery registration */}
			<Card className="mb-3">
				<div className="flex items-center gap-2 text-sm font-semibold">
					<MessageSquare className="h-4 w-4" /> Fix text delivery (carrier registration)
				</div>
				<p className="mt-1 text-xs text-zinc-500">
					US carriers delete texts from unregistered numbers (that's your error 30034). Fill this in once and tap
					Register — your server runs the whole registration with Twilio. Mid-way, Twilio texts your cell a
					verification link: tap it, then tap Register again to finish. Costs ~$4 once + ~$2/mo, billed to your
					Twilio balance.
				</p>
				<div className="mt-3 grid grid-cols-2 gap-2">
					<input className={inputCls} placeholder="First name" value={a2p.firstName} onChange={(e) => setA2p({ ...a2p, firstName: e.target.value })} />
					<input className={inputCls} placeholder="Last name" value={a2p.lastName} onChange={(e) => setA2p({ ...a2p, lastName: e.target.value })} />
					<input className={inputCls + " col-span-2"} placeholder="Email" value={a2p.email} onChange={(e) => setA2p({ ...a2p, email: e.target.value })} />
					<input className={inputCls} placeholder="Cell (for the OTP text)" value={a2p.phone} onChange={(e) => setA2p({ ...a2p, phone: e.target.value })} />
					<input className={inputCls} placeholder="ZIP" value={a2p.postalCode} onChange={(e) => setA2p({ ...a2p, postalCode: e.target.value })} />
					<input className={inputCls + " col-span-2"} placeholder="Street address" value={a2p.street} onChange={(e) => setA2p({ ...a2p, street: e.target.value })} />
					<input className={inputCls} placeholder="City" value={a2p.city} onChange={(e) => setA2p({ ...a2p, city: e.target.value })} />
					<input className={inputCls} placeholder="State (e.g. MN)" value={a2p.region} onChange={(e) => setA2p({ ...a2p, region: e.target.value })} />
				</div>
				<Button size="sm" className="mt-2" disabled={!a2pReady || registerA2p.isPending} onClick={() => registerA2p.mutate()}>
					{registerA2p.isPending ? "Registering…" : registerA2p.data ? "Register / resume" : "Register"}
				</Button>
				{registerA2p.isError && <div className="mt-1 text-xs text-red-400">{errMsg(registerA2p.error)}</div>}
				{registerA2p.data && (
					<div className="mt-2 space-y-1">
						{registerA2p.data.steps.map((s, i) => (
							<div key={i} className={"rounded px-2 py-1 text-xs " + (s.ok ? "bg-emerald-500/10 text-emerald-300" : "bg-red-500/10 text-red-300")}>
								{s.ok ? "✓" : "✗"} {s.step}: {s.note}
							</div>
						))}
						<div className="rounded bg-white/5 px-2 py-1.5 text-xs text-zinc-300">{registerA2p.data.next}</div>
					</div>
				)}
			</Card>

			{/* Recent conversations */}
			<Card className="mb-3">
				<div className="text-sm font-semibold">Latest conversations</div>
				{calls.data?.calls.length === 0 && <div className="mt-2 text-sm text-zinc-500">Nothing yet.</div>}
				{calls.data?.calls.slice(0, 3).map((call) => (
					<details key={call.id} className="mt-2 rounded-lg border border-white/5 bg-black/20 p-2.5 text-sm">
						<summary className="cursor-pointer">
							<span className="tabular-nums">{call.from ?? "unknown"}</span>
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

			<Link to="/twin" className="flex items-center justify-center gap-2 py-2 text-sm text-zinc-500">
				<Settings className="h-4 w-4" /> Full twin setup
			</Link>
		</div>
	);
}
