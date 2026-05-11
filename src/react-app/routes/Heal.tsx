import { useQuery } from "@tanstack/react-query";
import { Heart, AlertCircle } from "lucide-react";
import { api } from "../lib/api";

export function Heal() {
	const events = useQuery({ queryKey: ["heal"], queryFn: api.healEvents });
	return (
		<div className="mx-auto max-w-5xl p-6 lg:p-10">
			<div className="mb-6 flex items-center gap-3">
				<Heart className="h-5 w-5 text-emerald-400" />
				<div>
					<h1 className="text-2xl font-bold">Self-Healing Events</h1>
					<p className="mt-1 text-sm text-zinc-400">
						Production errors caught by Cloudflare Logpush. Each has a one-click AI fix.
					</p>
				</div>
			</div>
			{(events.data?.events ?? []).length === 0 ? (
				<div className="glass grid place-items-center rounded-2xl p-16 text-center">
					<AlertCircle className="h-8 w-8 text-zinc-600" />
					<p className="mt-3 text-sm text-zinc-400">
						No incidents detected. Your deployed apps are healthy.
					</p>
				</div>
			) : (
				<div className="space-y-3">
					{(events.data?.events ?? []).map((e) => (
						<div key={e.id} className="glass rounded-xl p-4">
							<div className="flex items-start justify-between gap-3">
								<div>
									<div className="font-medium">{e.error_signature}</div>
									<div className="text-xs text-zinc-500">
										{new Date(e.created_at).toLocaleString()}
									</div>
								</div>
								<span
									className={
										"rounded px-2 py-0.5 text-[10px] uppercase tracking-wider " +
										(e.status === "pending"
											? "bg-amber-500/15 text-amber-400"
											: e.status === "approved"
												? "bg-emerald-500/15 text-emerald-400"
												: "bg-zinc-500/15 text-zinc-400")
									}
								>
									{e.status}
								</span>
							</div>
						</div>
					))}
				</div>
			)}
		</div>
	);
}
