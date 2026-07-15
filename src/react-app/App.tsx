import { useEffect } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Landing } from "./routes/Landing";
import { Login } from "./routes/Login";
import { Dashboard } from "./routes/Dashboard";
import { NewProject } from "./routes/NewProject";
import { Workspace } from "./routes/Workspace";
import { Billing } from "./routes/Billing";
import { Heal } from "./routes/Heal";
import { Account } from "./routes/Account";
import { Twin } from "./routes/Twin";
import { Terms, Privacy } from "./routes/Legal";
import { AppLayout } from "./components/AppLayout";
import { api } from "./lib/api";
import { useAuth } from "./stores/auth";

function App() {
	const { setUser, setLoading } = useAuth();
	const me = useQuery({ queryKey: ["me"], queryFn: api.me, staleTime: 60_000 });

	useEffect(() => {
		setLoading(me.isLoading);
		if (me.data) setUser(me.data.user);
	}, [me.data, me.isLoading, setUser, setLoading]);

	return (
		<Routes>
			<Route path="/" element={<Landing />} />
			<Route path="/login" element={<Login />} />
			<Route path="/terms" element={<Terms />} />
			<Route path="/privacy" element={<Privacy />} />
			<Route element={<AppLayout />}>
				<Route path="/dashboard" element={<Dashboard />} />
				<Route path="/new" element={<NewProject />} />
				<Route path="/p/:slug" element={<Workspace />} />
				<Route path="/billing" element={<Billing />} />
				<Route path="/heal" element={<Heal />} />
				<Route path="/twin" element={<Twin />} />
				<Route path="/account" element={<Account />} />
			</Route>
			<Route path="*" element={<Navigate to="/" replace />} />
		</Routes>
	);
}

export default App;
