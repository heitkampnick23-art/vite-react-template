import { useAuth } from "../stores/auth";

export function Account() {
	const { user } = useAuth();
	if (!user) return null;
	return (
		<div className="mx-auto max-w-3xl p-6 lg:p-10">
			<h1 className="text-2xl font-bold">Account</h1>
			<div className="glass mt-6 space-y-4 rounded-2xl p-6 text-sm">
				<Row label="Email" value={user.email} />
				<Row label="Name" value={user.name ?? "—"} />
				<Row label="Plan" value={user.plan === "free" ? "None — choose one in Billing" : user.plan} />
				<Row label="Credits" value={user.tokenBalance.toLocaleString()} />
				<Row label="Role" value={user.role} />
			</div>
		</div>
	);
}

function Row({ label, value }: { label: string; value: string | number }) {
	return (
		<div className="grid grid-cols-3 gap-4 border-b border-white/5 pb-3 last:border-0 last:pb-0">
			<div className="text-zinc-400">{label}</div>
			<div className="col-span-2 font-medium">{value}</div>
		</div>
	);
}
