// /billing — Stripe Checkout, Customer Portal, balance, top-ups.

import { Hono } from "hono";
import { z } from "zod";
import { zValidator } from "@hono/zod-validator";
import Stripe from "stripe";
import { requireUser, type AppEnv } from "../middleware/auth";
import { PLANS, TOPUPS } from "../lib/pricing";
import { getBalance } from "../lib/tokens";

const billing = new Hono<AppEnv>();

billing.use("*", requireUser);

function stripeClient(env: Env) {
	return new Stripe(env.STRIPE_SECRET, { apiVersion: "2025-02-24.acacia" });
}

async function ensureCustomer(env: Env, userId: string, email: string) {
	const u = await env.DB
		.prepare("SELECT stripe_customer_id FROM users WHERE id = ?")
		.bind(userId)
		.first<{ stripe_customer_id: string | null }>();
	if (u?.stripe_customer_id) return u.stripe_customer_id;
	const s = stripeClient(env);
	const cust = await s.customers.create({ email, metadata: { userId } });
	await env.DB
		.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?")
		.bind(cust.id, userId)
		.run();
	return cust.id;
}

billing.get("/balance", async (c) => {
	const u = c.get("user");
	const balance = await getBalance(c.env.DB, u.id);
	const recent = await c.env.DB
		.prepare(
			"SELECT delta, reason, model, created_at FROM token_ledger WHERE user_id = ? ORDER BY created_at DESC LIMIT 20",
		)
		.bind(u.id)
		.all<{ delta: number; reason: string; model: string | null; created_at: number }>();
	return c.json({ balance, plan: u.plan, recent: recent.results });
});

billing.get("/plans", (c) => {
	return c.json({ plans: PLANS, topups: TOPUPS });
});

billing.post(
	"/checkout",
	zValidator("json", z.object({ plan: z.enum(["pro", "team"]).optional(), topupId: z.string().optional() })),
	async (c) => {
		const u = c.get("user");
		const body = c.req.valid("json");
		const s = stripeClient(c.env);
		const customer = await ensureCustomer(c.env, u.id, u.email);

		let line_items: Stripe.Checkout.SessionCreateParams.LineItem[] = [];
		let mode: "subscription" | "payment" = "subscription";

		if (body.topupId) {
			const t = TOPUPS.find((x) => x.id === body.topupId);
			if (!t) return c.json({ error: "unknown_topup" }, 400);
			line_items = [{ price: t.stripePriceId, quantity: 1 }];
			mode = "payment";
		} else if (body.plan) {
			const p = PLANS[body.plan];
			if (!p.stripePriceId) return c.json({ error: "no_price" }, 400);
			line_items = [{ price: p.stripePriceId, quantity: 1 }];
			mode = "subscription";
		} else {
			return c.json({ error: "missing_plan_or_topup" }, 400);
		}

		const session = await s.checkout.sessions.create({
			customer,
			mode,
			line_items,
			success_url: `${c.env.APP_URL}/billing?success=1`,
			cancel_url: `${c.env.APP_URL}/billing?canceled=1`,
			client_reference_id: u.id,
			metadata: { userId: u.id, plan: body.plan ?? "", topupId: body.topupId ?? "" },
		});
		return c.json({ url: session.url });
	},
);

billing.post("/portal", async (c) => {
	const u = c.get("user");
	const customer = await ensureCustomer(c.env, u.id, u.email);
	const s = stripeClient(c.env);
	const portal = await s.billingPortal.sessions.create({
		customer,
		return_url: `${c.env.APP_URL}/billing`,
	});
	return c.json({ url: portal.url });
});

export default billing;
