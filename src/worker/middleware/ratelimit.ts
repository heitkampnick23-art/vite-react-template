// KV-backed sliding-window rate limiter.

import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./auth";

export function rateLimit(opts: {
	key: (c: Parameters<MiddlewareHandler<AppEnv>>[0]) => string;
	limit: number;
	windowSec: number;
}): MiddlewareHandler<AppEnv> {
	return async (c, next) => {
		const k = `rl:${opts.key(c)}`;
		const raw = (await c.env.CACHE.get(k)) ?? "0";
		const n = parseInt(raw, 10);
		if (n >= opts.limit) {
			return c.json({ error: "rate_limited", retryAfter: opts.windowSec }, 429);
		}
		await c.env.CACHE.put(k, String(n + 1), { expirationTtl: opts.windowSec });
		await next();
	};
}
