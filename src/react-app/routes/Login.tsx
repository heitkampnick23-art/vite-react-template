import { useState } from "react";
import { Link } from "react-router-dom";
import { Mail } from "lucide-react";
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
						No password — we email you a link. Or use Google.
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
					<a href="/auth/google" className="block">
						<Button variant="outline" className="w-full">
							<svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
								<path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.56c2.08-1.92 3.28-4.74 3.28-8.09z"/>
								<path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.56-2.76c-.99.66-2.25 1.06-3.72 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"/>
								<path fill="#FBBC05" d="M5.84 14.11A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.44.34-2.11V7.05H2.18A11 11 0 0 0 1 12c0 1.77.42 3.45 1.18 4.95l3.66-2.84z"/>
								<path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.05l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"/>
							</svg>
							Continue with Google
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
