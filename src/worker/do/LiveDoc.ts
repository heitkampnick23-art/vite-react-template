// LiveDoc — Yjs-based collaborative document over WebSocket.
// Phase 3 feature. Skeleton DO that holds the doc in storage and rebroadcasts updates.

import { DurableObject } from "cloudflare:workers";

export class LiveDoc extends DurableObject<Env> {
	sockets: Set<WebSocket> = new Set();

	async fetch(req: Request): Promise<Response> {
		const upgrade = req.headers.get("Upgrade");
		if (upgrade !== "websocket") {
			return new Response("expected websocket", { status: 426 });
		}
		const pair = new WebSocketPair();
		this.ctx.acceptWebSocket(pair[1]);
		this.sockets.add(pair[1]);
		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	async webSocketMessage(ws: WebSocket, msg: ArrayBuffer | string) {
		// Broadcast Yjs update to all peers; full CRDT merge would happen client-side or via y-protocols.
		for (const s of this.sockets) {
			if (s !== ws && s.readyState === WebSocket.READY_STATE_OPEN) {
				try {
					s.send(msg);
				} catch {
					/* noop */
				}
			}
		}
	}

	async webSocketClose(ws: WebSocket) {
		this.sockets.delete(ws);
	}
}
