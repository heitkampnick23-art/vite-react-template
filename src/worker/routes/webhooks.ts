// /webhooks — Stripe webhook + GitHub webhook + Logpush webhook.
// All require idempotency (KV) + signature verification.

import { Hono } from "hono";
import Stripe from "stripe";
import { nanoid } from "nanoid";
import { credit } from "../lib/tokens";
import { PLANS, TOPUPS } from "../lib/pricing";
import type { AppEnv } from "../middleware/auth";

const webhooks = new Hono<AppEnv>();

webhooks.post("/stripe", async (c) => {
	const sig = c.req.header("stripe-signature");
	if (!sig) return c.json({ error: "missing_signature" }, 400);
	const body = await c.req.text();
	const s = new Stripe(c.env.STRIPE_SECRET, { apiVersion: "2025-02-24.acacia" });

	let event: Stripe.Event;
	try {
		event = await s.webhooks.constructEventAsync(body, sig, c.env.STRIPE_WEBHOOK_SECRET);
	} catch (e) {
		return c.json({ error: "bad_signature", message: String(e) }, 400);
	}

	// Idempotency: 30-day KV record on event.id
	const seen = await c.env.CACHE.get(`stripe:${event.id}`);
	if (seen) return c.json({ ok: true, dedup: true });
	await c.env.CACHE.put(`stripe:${event.id}`, "1", { expirationTtl: 30 * 86_400 });

	switch (event.type) {
		case "checkout.session.completed": {
			const session = event.data.object as Stripe.Checkout.Session;
			const userId = session.metadata?.userId;
			if (!userId) break;
			const planKey = session.metadata?.plan;
			const topupId = session.metadata?.topupId;
			if (topupId) {
				const t = TOPUPS.find((x) => x.id === topupId);
				if (t) {
					await credit(c.env.DB, {
						userId,
						amount: t.credits,
						reason: `topup:${t.id}`,
						requestId: event.id,
					});
				}
			} else if (planKey && planKey in PLANS) {
				const p = PLANS[planKey as keyof typeof PLANS];
				await c.env.DB
					.prepare("UPDATE users SET plan = ?, updated_at = ? WHERE id = ?")
					.bind(planKey, Date.now(), userId)
					.run();
				await credit(c.env.DB, {
					userId,
					amount: p.monthlyCredits,
					reason: `plan_grant:${planKey}`,
					requestId: event.id,
				});
			}
			break;
		}
		case "customer.subscription.created":
		case "customer.subscription.updated": {
			const sub = event.data.object as Stripe.Subscription;
			const userId = await userIdFromCustomer(c.env, sub.customer as string);
			if (!userId) break;
			const priceId = sub.items.data[0]?.price.id;
			const plan = priceToPlan(priceId);
			if (plan) {
				await c.env.DB
					.prepare("UPDATE users SET plan = ?, updated_at = ? WHERE id = ?")
					.bind(plan, Date.now(), userId)
					.run();
				await c.env.DB
					.prepare(
						`INSERT INTO subscriptions (id, user_id, stripe_sub_id, plan, status, current_period_end, seats, created_at, updated_at)
						 VALUES (?,?,?,?,?,?,?,?,?)
						 ON CONFLICT(stripe_sub_id) DO UPDATE SET
						   plan = excluded.plan, status = excluded.status,
						   current_period_end = excluded.current_period_end, updated_at = excluded.updated_at`,
					)
					.bind(
						"sub_" + nanoid(14),
						userId,
						sub.id,
						plan,
						sub.status,
						sub.current_period_end * 1000,
						sub.items.data[0]?.quantity ?? 1,
						Date.now(),
						Date.now(),
					)
					.run();
			}
			break;
		}
		case "customer.subscription.deleted": {
			const sub = event.data.object as Stripe.Subscription;
			const userId = await userIdFromCustomer(c.env, sub.customer as string);
			if (userId) {
				await c.env.DB
					.prepare("UPDATE users SET plan = 'free', updated_at = ? WHERE id = ?")
					.bind(Date.now(), userId)
					.run();
			}
			break;
		}
		case "invoice.paid": {
			const inv = event.data.object as Stripe.Invoice;
			const userId = await userIdFromCustomer(c.env, inv.customer as string);
			if (userId) {
				await c.env.DB
					.prepare(
						"INSERT OR IGNORE INTO invoices (id, user_id, stripe_invoice_id, amount_cents, currency, status, hosted_url, created_at) VALUES (?,?,?,?,?,?,?,?)",
					)
					.bind(
						"inv_" + nanoid(14),
						userId,
						inv.id,
						inv.amount_paid,
						inv.currency,
						inv.status ?? "paid",
						inv.hosted_invoice_url ?? null,
						Date.now(),
					)
					.run();
			}
			break;
		}
	}
	return c.json({ ok: true });
});

async function userIdFromCustomer(env: Env, customerId: string) {
	const row = await env.DB
		.prepare("SELECT id FROM users WHERE stripe_customer_id = ?")
		.bind(customerId)
		.first<{ id: string }>();
	return row?.id ?? null;
}

function priceToPlan(priceId?: string): "pro" | "team" | null {
	if (!priceId) return null;
	if (priceId === PLANS.pro.stripePriceId) return "pro";
	if (priceId === PLANS.team.stripePriceId) return "team";
	return null;
}

export default webhooks;
