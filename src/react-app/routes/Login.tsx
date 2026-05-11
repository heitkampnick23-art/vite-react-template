import { useState } from "react";
import { Link } from "react-router-dom";
import { Mail, Github } from "lucide-react";
import { toast } from "sonner";
import { Logo } from "../components/Logo";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { api } from "../lib/api";

export function Login() {
	const [email, setEmail] = useState("");
	const [sent, setSent] = useState(false);
	const [loading, setLoading] = useState(false);

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setLoading(true);
		try {
			const res = await api.sendMagic(email);
			setSent(true);
			if (res.devUrl) toast("Dev mode: " + res.devUrl);
			else toast.success("Magic link sent — check your inbox.");
		} catch {
			toast.error("Couldn't send link. Try again.");
		} finally {
			setLoading(false);
		}
	}

	return (
		<div className="grid min-h-screen place-items-center px-4">
			<div className="w-full max-w-md">
				<Link to="/" className="mb-8 flex justify-center">
					<Logo />
				</Link>
				<Card>
					<h1 className="text-2xl font-semibold">Sign in to Generate AI</h1>
					<p className="mt-1 text-sm text-zinc-400">
						No password — we email you a link. Or use GitHub.
					</p>
					{sent ? (
						<div className="mt-6 rounded-lg border border-emerald-500/20 bg-emerald-500/10 p-4 text-sm">
							✓ Sent a sign-in link to <strong>{email}</strong>. Open it on this device to continue.
						</div>
					) : (
						<form onSubmit={submit} className="mt-6 space-y-3">
							<label className="block text-xs text-zinc-400">Email</label>
							<input
								required
								type="email"
								autoComplete="email"
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								placeholder="you@example.com"
								className="w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm focus:border-brand-400 focus:outline-none"
							/>
							<Button type="submit" disabled={loading} className="w-full">
								<Mail className="h-4 w-4" />
								{loading ? "Sending..." : "Email me a magic link"}
							</Button>
						</form>
					)}
					<div className="my-4 flex items-center gap-3 text-xs text-zinc-500">
						<div className="h-px flex-1 bg-white/10" />
						or
						<div className="h-px flex-1 bg-white/10" />
					</div>
					<a href="/auth/github" className="block">
						<Button variant="outline" className="w-full">
							<Github className="h-4 w-4" /> Continue with GitHub
						</Button>
					</a>
				</Card>
				<p className="mt-4 text-center text-xs text-zinc-500">
					By signing in you agree to our <Link to="/terms" className="underline">Terms</Link> and{" "}
					<Link to="/privacy" className="underline">Privacy</Link>.
				</p>
			</div>
		</div>
	);
}
