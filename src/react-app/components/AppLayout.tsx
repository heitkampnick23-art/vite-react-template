import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Logo } from "./Logo";
import { TokenMeter } from "./TokenMeter";
import { api } from "../lib/api";
import { useAuth } from "../stores/auth";
import { Button } from "./ui/Button";
import { LayoutGrid, Settings, CreditCard, LogOut, Wand2, FlaskConical } from "lucide-react";
import { cn } from "../lib/cn";

export function AppLayout() {
	const { user, setUser } = useAuth();
	const navigate = useNavigate();
	const balance = useQuery({
		queryKey: ["balance"],
		queryFn: api.balance,
		enabled: !!user,
		refetchInterval: 30_000,
	});

	useEffect(() => {
		if (!user) navigate("/login");
	}, [user, navigate]);

	if (!user) return null;

	const nav = [
		{ to: "/dashboard", label: "Projects", icon: LayoutGrid },
		{ to: "/new", label: "New Build", icon: Wand2 },
		{ to: "/heal", label: "Self-Heal", icon: FlaskConical },
		{ to: "/billing", label: "Billing", icon: CreditCard },
		{ to: "/account", label: "Account", icon: Settings },
	];

	return (
		<div className="flex h-screen">
			<aside className="hidden w-60 flex-col border-r border-white/5 bg-black/30 p-4 lg:flex">
				<Link to="/dashboard" className="mb-6">
					<Logo />
				</Link>
				<nav className="flex flex-col gap-1">
					{nav.map((n) => (
						<NavLink
							key={n.to}
							to={n.to}
							className={({ isActive }) =>
								cn(
									"flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition",
									isActive ? "bg-white/10 text-white" : "text-zinc-400 hover:bg-white/5 hover:text-white",
								)
							}
						>
							<n.icon className="h-4 w-4" />
							{n.label}
						</NavLink>
					))}
				</nav>
				<div className="mt-auto flex flex-col gap-3 pt-4">
					<div className="rounded-lg border border-white/10 bg-white/5 p-3 text-xs">
						<div className="text-zinc-400">Signed in as</div>
						<div className="truncate font-medium">{user.email}</div>
					</div>
					<Button
						variant="ghost"
						size="sm"
						onClick={async () => {
							await api.logout();
							setUser(null);
							navigate("/login");
						}}
					>
						<LogOut className="h-3.5 w-3.5" /> Sign out
					</Button>
				</div>
			</aside>
			<main className="flex flex-1 flex-col overflow-hidden">
				<header className="flex h-14 items-center justify-between border-b border-white/5 bg-black/20 px-4 backdrop-blur">
					<div className="lg:hidden">
						<Logo />
					</div>
					<div className="ml-auto flex items-center gap-3">
						<TokenMeter balance={balance.data?.balance ?? user.tokenBalance} plan={user.plan} />
					</div>
				</header>
				<div className="flex-1 overflow-auto scrollbar-thin">
					<Outlet />
				</div>
			</main>
		</div>
	);
}
