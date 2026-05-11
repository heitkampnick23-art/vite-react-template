import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Plus, ArrowRight, Clock } from "lucide-react";
import { Button } from "../components/ui/Button";
import { api } from "../lib/api";

export function Dashboard() {
	const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
	return (
		<div className="mx-auto max-w-6xl p-6 lg:p-10">
			<div className="mb-8 flex items-center justify-between">
				<div>
					<h1 className="text-2xl font-bold">Your projects</h1>
					<p className="mt-1 text-sm text-zinc-400">Pick up where you left off or start something new.</p>
				</div>
				<Link to="/new">
					<Button>
						<Plus className="h-4 w-4" /> New project
					</Button>
				</Link>
			</div>
			{projects.isLoading ? (
				<div className="text-sm text-zinc-500">Loading…</div>
			) : (projects.data?.projects.length ?? 0) === 0 ? (
				<div className="glass grid place-items-center rounded-2xl p-16 text-center">
					<h2 className="text-xl font-semibold">No projects yet</h2>
					<p className="mt-2 max-w-md text-sm text-zinc-400">
						Describe an app, pick a template, or fork from a GitHub repo. Your first build is on the house.
					</p>
					<Link to="/new" className="mt-6">
						<Button>
							<Plus className="h-4 w-4" /> Build your first app
						</Button>
					</Link>
				</div>
			) : (
				<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
					{projects.data!.projects.map((p) => (
						<Link
							key={p.id}
							to={`/p/${p.slug}`}
							className="glass group rounded-2xl p-5 transition hover:border-white/15 hover:bg-white/5"
						>
							<div className="flex items-start justify-between">
								<h3 className="font-semibold">{p.name}</h3>
								<ArrowRight className="h-4 w-4 text-zinc-500 transition group-hover:translate-x-1 group-hover:text-white" />
							</div>
							{p.description && <p className="mt-1 text-sm text-zinc-400">{p.description}</p>}
							<div className="mt-4 flex items-center gap-2 text-xs text-zinc-500">
								<Clock className="h-3 w-3" />
								Updated {timeAgo(p.updatedAt)}
								{p.subdomain && (
									<span className="ml-auto rounded bg-white/5 px-2 py-0.5 font-mono text-[10px]">
										{p.subdomain}.generateai.build
									</span>
								)}
							</div>
						</Link>
					))}
				</div>
			)}
		</div>
	);
}

function timeAgo(ts: number) {
	const s = Math.round((Date.now() - ts) / 1000);
	if (s < 60) return `${s}s ago`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.round(h / 24);
	return `${d}d ago`;
}
