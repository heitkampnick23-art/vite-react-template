import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { useEffect } from "react";
import { Zap, CreditCard, ExternalLink, Check } from "lucide-react";
import { Button } from "../components/ui/Button";
import { api } from "../lib/api";

export function Billing() {
	const balance = useQuery({ queryKey: ["balance"], queryFn: api.balance });
	const plans = useQuery({ queryKey: ["plans"], queryFn: api.plans });
	const [search] = useSearchParams();

	useEffect(() => {
		if (search.get("success")) toast.success("Thanks — your account is being updated.");
		if (search.get("canceled")) toast("Checkout canceled.");
	}, [search]);

	async function go(plan?: "pro" | "team", topupId?: string) {
		try {
			const { url } = await api.checkout({ plan, topupId });
			window.location.href = url;
		} catch (e) {
			toast.error((e as Error).message);
		}
	}

	async function portal() {
		try {
			const { url } = await api.portal();
			window.location.href = url;
		} catch (e) {
			toast.error((e as Error).message);
		}
	}

	return (
		<div className="mx-auto max-w-5xl p-6 lg:p-10">
			<h1 className="text-2xl font-bold">Billing & credits</h1>
			<p className="mt-1 text-sm text-zinc-400">All AI usage is metered. Hard cap at zero — no surprises.</p>

			<div className="mt-6 grid gap-4 md:grid-cols-3">
				<div className="glass rounded-2xl p-6 md:col-span-2">
					<div className="flex items-center gap-2 text-xs text-zinc-400">
						<Zap className="h-3.5 w-3.5 text-brand-400" /> Balance
					</div>
					<div className="mt-2 font-mono text-4xl tabular-nums">
						{(balance.data?.balance ?? 0).toLocaleString()}
					</div>
					<div className="text-xs text-zinc-500">credits · {balance.data?.plan ?? "free"} plan</div>
					<Button variant="outline" size="sm" onClick={portal} className="mt-4">
						<CreditCard className="h-3.5 w-3.5" /> Manage subscription <ExternalLink className="h-3 w-3" />
					</Button>
				</div>
				<div className="glass rounded-2xl p-6">
					<h3 className="text-sm font-semibold">Top up</h3>
					<p className="mt-1 text-xs text-zinc-500">One-time credit packs. No subscription required.</p>
					<div className="mt-3 space-y-2">
						{(plans.data?.topups ?? []).map((t) => (
							<button
								key={t.id}
								onClick={() => go(undefined, t.id)}
								className="flex w-full items-center justify-between rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm transition hover:bg-white/5"
							>
								<span>{t.credits.toLocaleString()} credits</span>
								<span className="font-mono">${(t.priceCents / 100).toFixed(2)}</span>
							</button>
						))}
					</div>
				</div>
			</div>

			<h2 className="mt-10 text-lg font-semibold">Plans</h2>
			<div className="mt-4 grid gap-4 md:grid-cols-3">
				{plans.data &&
					(["free", "pro", "team"] as const).map((key) => {
						const p = plans.data!.plans[key];
						return (
							<div key={key} className="glass rounded-2xl p-6">
								<div className="text-sm text-zinc-400">{p.displayName}</div>
								<div className="mt-2 text-3xl font-bold">
									${(p.priceCents / 100).toFixed(0)}
									<span className="text-base text-zinc-400">{p.priceCents ? "/mo" : ""}</span>
								</div>
								<div className="mt-1 text-xs text-zinc-500">
									{p.monthlyCredits.toLocaleString()} credits / month
								</div>
								<ul className="mt-4 space-y-2 text-sm">
									{p.features.map((f) => (
										<li key={f} className="flex items-start gap-2 text-zinc-300">
											<Check className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-emerald-400" />
											{f}
										</li>
									))}
								</ul>
								{key !== "free" && (
									<Button onClick={() => go(key)} className="mt-5 w-full">
										{balance.data?.plan === key ? "Current plan" : `Switch to ${p.displayName}`}
									</Button>
								)}
							</div>
						);
					})}
			</div>

			<h2 className="mt-10 text-lg font-semibold">Recent activity</h2>
			<div className="glass mt-4 overflow-hidden rounded-2xl">
				<table className="w-full text-sm">
					<thead className="bg-white/5 text-left text-xs uppercase tracking-wider text-zinc-400">
						<tr>
							<th className="px-4 py-2">When</th>
							<th className="px-4 py-2">Reason</th>
							<th className="px-4 py-2">Model</th>
							<th className="px-4 py-2 text-right">Δ Credits</th>
						</tr>
					</thead>
					<tbody>
						{(balance.data?.recent ?? []).map((e, i) => (
							<tr key={i} className="border-t border-white/5">
								<td className="px-4 py-2 text-xs text-zinc-500">{new Date(e.created_at).toLocaleString()}</td>
								<td className="px-4 py-2">{e.reason}</td>
								<td className="px-4 py-2 text-zinc-400">{e.model ?? "—"}</td>
								<td
									className={
										"px-4 py-2 text-right font-mono " +
										(e.delta < 0 ? "text-red-400" : "text-emerald-400")
									}
								>
									{e.delta > 0 ? "+" : ""}
									{e.delta.toLocaleString()}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}
