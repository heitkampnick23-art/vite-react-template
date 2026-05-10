// SandboxSession — wraps a Cloudflare Container exec session.
// Phase 2 feature. Skeleton — actual container binding wiring lands when CF Containers beta is enabled on the account.

import { DurableObject } from "cloudflare:workers";

export class SandboxSession extends DurableObject<Env> {
	async fetch(req: Request): Promise<Response> {
		const url = new URL(req.url);
		if (url.pathname === "/exec" && req.method === "POST") {
			const body = (await req.json()) as { cmd: string; cwd?: string };
			// TODO: forward to env.SANDBOX_CONTAINER once the binding is available.
			return Response.json({
				ok: false,
				message: "sandbox not yet provisioned; enable Cloudflare Containers in wrangler.json",
				cmd: body.cmd,
			});
		}
		return new Response("not found", { status: 404 });
	}
}
