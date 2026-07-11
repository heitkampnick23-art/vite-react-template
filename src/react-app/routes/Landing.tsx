import { Link } from "react-router-dom";
import { Sparkles, ShieldCheck, Wand2, Bot, Rocket, GitBranch, Zap, Heart, Users, Globe2 } from "lucide-react";
import { Logo } from "../components/Logo";
import { Button } from "../components/ui/Button";

export function Landing() {
	return (
		<div className="min-h-screen">
			<header className="mx-auto flex max-w-7xl items-center justify-between px-6 py-5">
				<Logo />
				<nav className="hidden items-center gap-6 text-sm text-zinc-300 md:flex">
					<a href="#features" className="hover:text-white">Features</a>
					<a href="#council" className="hover:text-white">AI Council</a>
					<a href="#heal" className="hover:text-white">Self-Healing</a>
					<a href="#pricing" className="hover:text-white">Pricing</a>
				</nav>
				<div className="flex items-center gap-3">
					<Link to="/login" className="text-sm text-zinc-300 hover:text-white">Sign in</Link>
					<Link to="/login?mode=signup">
						<Button size="sm">Sign up</Button>
					</Link>
				</div>
			</header>

			<section className="mx-auto max-w-7xl px-6 py-24 text-center">
				<div className="mx-auto mb-6 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-zinc-300">
					<Sparkles className="h-3 w-3 text-brand-400" />
					Powered by Cloudflare · 100% edge-native
				</div>
				<h1 className="mx-auto max-w-4xl text-balance text-5xl font-bold leading-tight tracking-tight md:text-7xl">
					Build full apps by <span className="gradient-text">just chatting</span>.
				</h1>
				<p className="mx-auto mt-6 max-w-2xl text-lg text-zinc-300">
					Generate AI is the only app builder with a deliberating <strong>Multi-Model Council</strong> and
					<strong> Self-Healing deployments</strong>. Replit, Lovable, Manus — leveled up.
				</p>
				<div className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row">
					<Link to="/login?mode=signup">
						<Button size="lg">
							<Wand2 className="h-4 w-4" /> Start building
						</Button>
					</Link>
					<a href="#features">
						<Button size="lg" variant="outline">See how it works</Button>
					</a>
				</div>
				<p className="mt-4 text-xs text-zinc-500">Sign up in seconds with Google or your email, pick a plan, and ship today.</p>
			</section>

			<section id="features" className="mx-auto max-w-7xl px-6 py-16">
				<h2 className="mb-12 text-center text-3xl font-bold md:text-4xl">
					Everything top platforms offer, <span className="gradient-text">plus what they don't</span>
				</h2>
				<div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
					{features.map((f) => (
						<div key={f.title} className="glass rounded-2xl p-6 transition hover:border-white/15">
							<f.icon className="mb-3 h-6 w-6 text-brand-400" />
							<h3 className="mb-2 text-lg font-semibold">{f.title}</h3>
							<p className="text-sm text-zinc-400">{f.body}</p>
						</div>
					))}
				</div>
			</section>

			<section id="council" className="mx-auto max-w-5xl px-6 py-20">
				<div className="glass rounded-3xl p-10">
					<div className="mb-3 inline-flex items-center gap-2 rounded-full bg-accent-500/15 px-3 py-1 text-xs text-accent-500">
						<Bot className="h-3 w-3" /> Pro feature
					</div>
					<h2 className="text-3xl font-bold md:text-4xl">The Multi-Model AI Council</h2>
					<p className="mt-4 max-w-3xl text-zinc-300">
						Watch three different LLMs deliberate in real time before a single line of code ships: the
						<strong> Architect</strong> (Claude) proposes, the <strong>Critic</strong> (GPT-4o) finds
						weaknesses, and the <strong>Security Reviewer</strong> (Gemini) flags risks. Then the Architect
						synthesizes a final plan that's measurably better than any single model.
					</p>
					<div className="mt-8 grid gap-3 md:grid-cols-3">
						{["Architect — Claude Sonnet 4.6", "Critic — GPT-4o", "Security — Gemini 1.5 Pro"].map((r) => (
							<div key={r} className="rounded-xl border border-white/10 bg-black/30 p-4 text-sm">
								<span className="font-medium">{r}</span>
							</div>
						))}
					</div>
				</div>
			</section>

			<section id="heal" className="mx-auto max-w-5xl px-6 py-20">
				<div className="glass rounded-3xl p-10">
					<div className="mb-3 inline-flex items-center gap-2 rounded-full bg-emerald-500/15 px-3 py-1 text-xs text-emerald-400">
						<Heart className="h-3 w-3" /> Industry first
					</div>
					<h2 className="text-3xl font-bold md:text-4xl">Self-Healing Deployed Apps</h2>
					<p className="mt-4 max-w-3xl text-zinc-300">
						The other builders ship your app and walk away. We watch every deployment for runtime errors
						via Cloudflare Logpush. When something breaks in production, an agent reads the stack trace,
						proposes a minimal patch, and offers it for one-click approval — typically before your users
						even notice.
					</p>
					<ol className="mt-6 grid list-decimal gap-3 pl-5 text-sm text-zinc-300 md:grid-cols-2">
						<li>Production error captured by Logpush</li>
						<li>Signature deduplicated; root file pulled</li>
						<li>Claude proposes a minimal diff</li>
						<li>You tap Approve → redeploy is instant</li>
					</ol>
				</div>
			</section>

			<section id="pricing" className="mx-auto max-w-4xl px-6 py-20">
				<h2 className="mb-12 text-center text-3xl font-bold md:text-4xl">Simple, credit-based pricing</h2>
				<div className="grid gap-4 md:grid-cols-2">
					{pricing.map((p) => (
						<div key={p.name} className={"glass rounded-2xl p-6 " + (p.featured ? "ring-2 ring-brand-500/40" : "")}>
							<div className="mb-3 text-sm text-zinc-400">{p.name}</div>
							<div className="text-3xl font-bold">
								{p.price}
								<span className="text-base font-normal text-zinc-400">{p.suffix}</span>
							</div>
							<div className="mt-1 text-xs text-zinc-500">{p.credits} credits / month</div>
							<ul className="mt-6 space-y-2 text-sm text-zinc-300">
								{p.features.map((f) => (
									<li key={f} className="flex items-start gap-2">
										<Zap className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-brand-400" /> {f}
									</li>
								))}
							</ul>
							<Link to="/login?mode=signup" className="mt-6 block">
								<Button className="w-full" variant={p.featured ? "primary" : "outline"}>
									{p.cta}
								</Button>
							</Link>
						</div>
					))}
				</div>
				<p className="mt-6 text-center text-xs text-zinc-500">
					Need more? One-time credit top-ups are available from your billing page after you subscribe.
				</p>
			</section>

			<footer className="border-t border-white/5 px-6 py-10 text-center text-xs text-zinc-500">
				<Logo className="mb-4 justify-center" />
				<div className="mb-2 flex items-center justify-center gap-4">
					<Link to="/terms" className="hover:text-white">Terms</Link>
					<Link to="/privacy" className="hover:text-white">Privacy</Link>
					<Link to="/login" className="hover:text-white">Sign in</Link>
				</div>
				<div>© {new Date().getFullYear()} Generate AI · generateai.build</div>
			</footer>
		</div>
	);
}

const features = [
	{ icon: Wand2, title: "Chat → App, instantly", body: "Describe what you want. We write the code, run the preview, and deploy when ready." },
	{ icon: Bot, title: "Multi-Model Council", body: "3 LLMs debate every spec — Architect, Critic, Security — for measurably better output." },
	{ icon: Heart, title: "Self-Healing Apps", body: "Production errors auto-generate one-click fix PRs. Sleep through the page." },
	{ icon: Rocket, title: "Instant deployments", body: "Every save deploys to your own *.generateai.build subdomain on Cloudflare's edge." },
	{ icon: GitBranch, title: "GitHub two-way sync", body: "Push, pull, and PR straight from the editor. Or use it as your only IDE." },
	{ icon: ShieldCheck, title: "Encrypted secrets vault", body: "AES-GCM-encrypted per-project secrets. Never leaked into chat context." },
	{ icon: Users, title: "Real-time collaboration", body: "CRDT-backed multi-cursor editing for teams. Pair-build with humans or AI." },
	{ icon: Globe2, title: "Custom domains", body: "Bring your own. Wildcard TLS handled. Edge-cached globally." },
	{ icon: Zap, title: "Token meter you can trust", body: "Atomic, audited, never-bypassable. See exactly where every credit went." },
];

const pricing = [
	{
		name: "Pro",
		price: "$20",
		suffix: "/mo",
		credits: "2,000,000",
		features: [
			"All models incl. Claude Opus, GPT-4o, Gemini Pro",
			"AI Council deliberation mode",
			"Self-Healing Apps",
			"GitHub two-way sync",
			"Private deploys + custom domains",
		],
		cta: "Go Pro",
		featured: true,
	},
	{
		name: "Team",
		price: "$60",
		suffix: "/seat/mo",
		credits: "3,000,000",
		features: [
			"Everything in Pro",
			"Real-time collaboration",
			"Team workspaces",
			"Shared secrets vault",
			"Priority support",
		],
		cta: "Choose Team",
		featured: false,
	},
];
