import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Lock } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { Logo } from "../components/Logo";
import { Button } from "../components/ui/Button";
import { Card } from "../components/ui/Card";
import { api } from "../lib/api";
import { useAuth } from "../stores/auth";

type Mode = "signin" | "signup";

function GoogleIcon() {
	return (
		<svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden>
			<path fill="#4285F4" d="M23.49 12.27c0-.85-.07-1.47-.22-2.11H12v3.84h6.6c-.13 1.07-.85 2.68-2.44 3.76l-.02.15 3.55 2.67.24.02c2.26-2.02 3.56-5 3.56-8.33" />
			<path fill="#34A853" d="M12 24c3.24 0 5.96-1.03 7.94-2.82l-3.78-2.85c-1.01.69-2.37 1.17-4.16 1.17-3.16 0-5.85-2.02-6.81-4.82l-.14.01-3.69 2.78-.05.13C3.28 21.3 7.31 24 12 24" />
			<path fill="#FBBC05" d="M5.19 14.68A7.2 7.2 0 0 1 4.79 12c0-.93.15-1.84.38-2.68l-.01-.18-3.73-2.82-.12.06A11.86 11.86 0 0 0 0 12c0 1.93.48 3.76 1.31 5.38l3.88-2.7" />
			<path fill="#EB4335" d="M12 4.5c2.24 0 3.76.94 4.62 1.73l3.38-3.21C17.95 1.15 15.24 0 12 0 7.31 0 3.28 2.69 1.31 6.62l3.87 2.92C6.15 6.74 8.84 4.5 12 4.5" />
		</svg>
	);
}

const OAUTH_ERRORS: Record<string, string> = {
	oauth: "Google sign-in was interrupted. Please try again.",
	oauth_state: "That sign-in link expired. Please try again.",
	oauth_token: "Google sign-in didn't complete. Please try again.",
	no_email: "We couldn't read an email address from your Google account.",
	unverified_email: "Your Google email isn't verified. Verify it with Google or sign up with email and password.",
};

export function Login() {
	const navigate = useNavigate();
	const [search] = useSearchParams();
	const { setUser } = useAuth();
	const queryClient = useQueryClient();
	const [mode, setMode] = useState<Mode>(search.get("mode") === "signup" ? "signup" : "signin");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [name, setName] = useState("");
	const [loading, setLoading] = useState(false);

	const oauthError = search.get("error");
	useEffect(() => {
		if (oauthError) toast.error(OAUTH_ERRORS[oauthError] ?? "Sign-in failed. Please try again.");
	}, [oauthError]);

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setLoading(true);
		try {
			let user;
			if (mode === "signup") {
				({ user } = await api.signup({ email, password, name: name || undefined }));
				toast.success("Welcome to Generate AI. Pick a plan to start building.");
			} else {
				({ user } = await api.signin({ email, password }));
				toast.success("Signed in.");
			}
			if (user) setUser(user);
			await queryClient.invalidateQueries({ queryKey: ["me"] });
			navigate(mode === "signup" ? "/billing" : "/dashboard");
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
							? "Sign up with Google or with your email and a password, then choose a plan."
							: "Sign in with Google or with your email and password."}
					</p>

					<a
						href="/auth/google"
						className="mt-6 flex w-full items-center justify-center gap-2 rounded-lg border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400"
					>
						<GoogleIcon />
						{mode === "signup" ? "Sign up with Google" : "Continue with Google"}
					</a>

					<div className="my-5 flex items-center gap-3 text-xs text-zinc-500">
						<span className="h-px flex-1 bg-white/10" />
						or use your email
						<span className="h-px flex-1 bg-white/10" />
					</div>

					<form onSubmit={submit} className="space-y-3">
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
