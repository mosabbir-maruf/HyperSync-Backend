import { Env } from "../index";

interface DevicePresence {
  peerId: string;
  name: string;
  platform: string;
  color: string;
  lastSeen: number;
}

/**
 * Global discovery lobby using the CF Durable Object Hibernation WebSocket API.
 * Using `this.state.acceptWebSocket()` (not `server.accept()`) is critical:
 * it lets the DO hibernate between messages without losing registered sockets,
 * and getWebSockets() correctly returns all live connections across wake-ups.
 *
 * In-memory roster is fine — if the DO restarts, clients reconnect automatically.
 */
export class LobbyRoom {
  private roster = new Map<string, DevicePresence>();

  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }

    const { 0: client, 1: server } = new WebSocketPair();

    this.state.acceptWebSocket(server);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;

    let msg: any;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    if (msg.type === "ANNOUNCE") {
      const peerId: string = msg.peerId;
      if (!peerId) return;

      const profile = msg.payload?.profile;
      if (!profile) return;

      ws.serializeAttachment({ peerId });

      this.roster.set(peerId, {
        peerId,
        name: profile.name ?? "Unknown",
        platform: profile.platform ?? "Unknown",
        color: profile.color ?? "#888",
        lastSeen: Date.now(),
      });

      this.broadcastRoster();
    } else if (msg.type === "INVITE") {
      const targetPeerId: string = msg.payload?.targetPeerId;
      const code: string = msg.payload?.code;
      if (!targetPeerId || !code) return;

      for (const s of this.state.getWebSockets()) {
        const att = this.getAttachment(s);
        if (att?.peerId === targetPeerId) {
          s.send(JSON.stringify({ type: "INVITE", payload: { code } }));
          break;
        }
      }
    } else if (msg.type === "PING") {
      const att = this.getAttachment(ws);
      if (att?.peerId) {
        const entry = this.roster.get(att.peerId);
        if (entry) entry.lastSeen = Date.now();
      }
      ws.send(JSON.stringify({ type: "PONG" }));
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const att = this.getAttachment(ws);
    if (att?.peerId) {
      this.roster.delete(att.peerId);
      this.broadcastRoster();
    }
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    await this.webSocketClose(ws, 1011, "error");
  }

  private getAttachment(ws: WebSocket): { peerId: string } | null {
    try {
      const att = ws.deserializeAttachment();
      return att as { peerId: string } | null;
    } catch {
      return null;
    }
  }

  private broadcastRoster() {
    const allSockets = this.state.getWebSockets();


    const liveIds = new Set<string>();
    for (const s of allSockets) {
      const att = this.getAttachment(s);
      if (att?.peerId) liveIds.add(att.peerId);
    }
    for (const [id] of this.roster) {
      if (!liveIds.has(id)) this.roster.delete(id);
    }

    const devices = Array.from(this.roster.values()).map((d) => ({
      peerId: d.peerId,
      name: d.name,
      platform: d.platform,
      color: d.color,
    }));

    for (const s of allSockets) {
      const att = this.getAttachment(s);
      const filtered = att?.peerId
        ? devices.filter((d) => d.peerId !== att.peerId)
        : devices;

      try {
        s.send(JSON.stringify({ type: "ROSTER", payload: { devices: filtered } }));
      } catch {
      }
    }
  }
}
