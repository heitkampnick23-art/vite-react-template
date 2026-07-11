import { Zap } from "lucide-react";
import { Link } from "react-router-dom";
import { cn } from "../lib/cn";

export function TokenMeter({ balance, plan, compact = false }: { balance: number; plan: string; compact?: boolean }) {
	const pct = Math.min(100, (balance / 2_000_000) * 100);
	const low = balance < 50_000;
	return (
		<Link
			to="/billing"
			className={cn(
				"flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs transition hover:bg-white/10",
				low && "border-amber-500/30 bg-amber-500/10",
			)}
		>
			<Zap className={cn("h-3.5 w-3.5", low ? "text-amber-400" : "text-brand-400")} />
			<span className="font-mono tabular-nums">{balance.toLocaleString()}</span>
			{!compact && (
				<>
					<span className="text-zinc-500">credits</span>
					<span className="ml-1 rounded bg-white/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-zinc-300">
						{plan === "free" ? "no plan" : plan}
					</span>
				</>
			)}
			<span className="sr-only">Balance bar</span>
			<span
				className="ml-2 hidden h-1 w-12 overflow-hidden rounded-full bg-white/10 sm:block"
				aria-hidden
			>
				<span
					className="block h-full bg-gradient-to-r from-brand-500 to-accent-500"
					style={{ width: `${pct}%` }}
				/>
			</span>
		</Link>
	);
}
