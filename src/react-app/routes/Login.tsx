import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Lock } from "lucide-react";
import { toast } from "sonner";
import { Logo } from "../components/Logo";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { api } from "../lib/api";

type Mode = "signin" | "signup";

export function Login() {
	const navigate = useNavigate();
	const [mode, setMode] = useState<Mode>("signin");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [name, setName] = useState("");
	const [loading, setLoading] = useState(false);

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setLoading(true);
		try {
			if (mode === "signup") {
				await api.signup({ email, password, name: name || undefined });
				toast.success("Welcome to Generate AI.");
			} else {
				await api.signin({ email, password });
				toast.success("Signed in.");
			}
			navigate("/dashboard");
		} catch (err) {
			const status = (err as { status?: number }).status;
			if (status === 409) toast.error("That email is already registered. Try signing in.");
			else if (status === 401) toast.error("Wrong email or password.");
			else toast.error("Couldn't " + (mode === "signup" ? "create account" : "sign in") + ". Try again.");
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
					<div className="mb-4 flex rounded-lg border border-white/10 p-1 text-sm">
						<button
							type="button"
							onClick={() => setMode("signin")}
							className={`flex-1 rounded-md px-3 py-1.5 transition ${mode === "signin" ? "bg-white/10 text-white" : "text-zinc-400 hover:text-white"}`}
						>
							Sign in
						</button>
						<button
							type="button"
							onClick={() => setMode("signup")}
							className={`flex-1 rounded-md px-3 py-1.5 transition ${mode === "signup" ? "bg-white/10 text-white" : "text-zinc-400 hover:text-white"}`}
						>
							Sign up
						</button>
					</div>

					<h1 className="text-2xl font-semibold">
						{mode === "signup" ? "Create your account" : "Welcome back"}
					</h1>
					<p className="mt-1 text-sm text-zinc-400">
						{mode === "signup"
							? "Get 100k free tokens to start building."
							: "Sign in with your email and password."}
					</p>

					<form onSubmit={submit} className="mt-6 space-y-3">
						{mode === "signup" && (
							<div>
								<label className="block text-xs text-zinc-400">Name (optional)</label>
								<input
									type="text"
									autoComplete="name"
									value={name}
									onChange={(e) => setName(e.target.value)}
									placeholder="Jane Doe"
									className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm focus:border-brand-400 focus:outline-none"
								/>
							</div>
						)}
						<div>
							<label className="block text-xs text-zinc-400">Email</label>
							<input
								required
								type="email"
								autoComplete="email"
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								placeholder="you@example.com"
								className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm focus:border-brand-400 focus:outline-none"
							/>
						</div>
						<div>
							<label className="block text-xs text-zinc-400">Password</label>
							<input
								required
								type="password"
								autoComplete={mode === "signup" ? "new-password" : "current-password"}
								minLength={8}
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								placeholder={mode === "signup" ? "At least 8 characters" : "Your password"}
								className="mt-1 w-full rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm focus:border-brand-400 focus:outline-none"
							/>
						</div>
						<Button type="submit" disabled={loading} className="w-full">
							<Lock className="h-4 w-4" />
							{loading
								? mode === "signup" ? "Creating account..." : "Signing in..."
								: mode === "signup" ? "Create account" : "Sign in"}
						</Button>
					</form>
				</Card>
				<p className="mt-4 text-center text-xs text-zinc-500">
					By {mode === "signup" ? "creating an account" : "signing in"} you agree to our{" "}
					<Link to="/terms" className="underline">Terms</Link> and{" "}
					<Link to="/privacy" className="underline">Privacy</Link>.
				</p>
			</div>
		</div>
	);
}
