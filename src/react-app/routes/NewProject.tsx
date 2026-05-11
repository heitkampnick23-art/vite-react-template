import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Wand2, Sparkles } from "lucide-react";
import { Button } from "../components/ui/Button";
import { api } from "../lib/api";

export function NewProject() {
	const navigate = useNavigate();
	const templates = useQuery({ queryKey: ["templates"], queryFn: api.templates });
	const [name, setName] = useState("");
	const [prompt, setPrompt] = useState("");
	const [template, setTemplate] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);

	async function create() {
		if (!name.trim()) return toast.error("Give your project a name.");
		setCreating(true);
		try {
			const res = await api.createProject({
				name,
				description: prompt || undefined,
				template: template ?? undefined,
			});
			navigate(`/p/${res.project.slug}?initial=${encodeURIComponent(prompt)}`);
		} catch (e) {
			toast.error((e as Error).message);
		} finally {
			setCreating(false);
		}
	}

	return (
		<div className="mx-auto max-w-4xl p-6 lg:p-10">
			<div className="mb-8">
				<h1 className="text-3xl font-bold">Start a new build</h1>
				<p className="mt-1 text-sm text-zinc-400">
					Describe what you want. Pick a template if you have one in mind. We'll handle the rest.
				</p>
			</div>
			<div className="glass rounded-2xl p-6">
				<label className="text-xs text-zinc-400">Project name</label>
				<input
					value={name}
					onChange={(e) => setName(e.target.value)}
					placeholder="My next big idea"
					className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm focus:border-brand-400 focus:outline-none"
				/>
				<label className="mt-4 block text-xs text-zinc-400">Describe what you want to build</label>
				<textarea
					rows={6}
					value={prompt}
					onChange={(e) => setPrompt(e.target.value)}
					placeholder="A SaaS that lets users upload meeting recordings and get a searchable summary with timestamps."
					className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm focus:border-brand-400 focus:outline-none"
				/>
				<Button onClick={create} disabled={creating} className="mt-4">
					<Wand2 className="h-4 w-4" /> {creating ? "Spinning up..." : "Create project"}
				</Button>
			</div>

			<div className="mt-10">
				<h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-300">
					<Sparkles className="h-3.5 w-3.5 text-brand-400" /> Or start from a template
				</h2>
				<div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
					{(templates.data?.templates ?? []).map((t) => (
						<button
							key={t.id}
							onClick={() => setTemplate(t.slug)}
							className={
								"glass rounded-xl p-4 text-left transition " +
								(template === t.slug ? "ring-2 ring-brand-500" : "hover:border-white/15")
							}
						>
							<div className="font-medium">{t.name}</div>
							{t.description && <div className="mt-1 text-xs text-zinc-400">{t.description}</div>}
							<div className="mt-3 flex flex-wrap gap-1">
								{t.tags.map((tag) => (
									<span key={tag} className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-zinc-400">
										{tag}
									</span>
								))}
							</div>
						</button>
					))}
				</div>
			</div>
		</div>
	);
}
