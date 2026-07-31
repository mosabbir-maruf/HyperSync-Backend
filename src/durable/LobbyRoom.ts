import { Env } from "../index";

interface DevicePresence {
  peerId: string;
  name: string;
  platform: string;
  color: string;
  lastSeen: number;
}

export class LobbyRoom {
  private roster = new Map<string, DevicePresence>();
  private sockets = new Map<string, WebSocket>();
  private wsToPeerId = new WeakMap<WebSocket, string>();

  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected Upgrade: websocket", { status: 426 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    
    server.accept();

    server.addEventListener("message", async (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        await this.handleMessage(server, msg);
      } catch (err) {
        console.error("Lobby message error:", err);
      }
    });

    server.addEventListener("close", () => this.handleClose(server));
    server.addEventListener("error", () => this.handleClose(server));

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private async handleMessage(ws: WebSocket, msg: any) {
    if (msg.type === "ANNOUNCE") {
      const peerId = msg.peerId;
      if (!peerId) return;

      const profile = msg.payload?.profile;
      if (!profile) return;

      this.wsToPeerId.set(ws, peerId);
      this.sockets.set(peerId, ws);
      
      this.roster.set(peerId, {
        peerId,
        name: profile.name,
        platform: profile.platform,
        color: profile.color,
        lastSeen: Date.now(),
      });

      this.broadcastRoster();
    } else if (msg.type === "INVITE") {
      const targetPeerId = msg.payload?.targetPeerId;
      const code = msg.payload?.code;
      if (!targetPeerId || !code) return;

      const targetWs = this.sockets.get(targetPeerId);
      if (targetWs && targetWs.readyState === WebSocket.OPEN) {
        targetWs.send(JSON.stringify({
          type: "INVITE",
          payload: { code }
        }));
      }
    } else if (msg.type === "PING") {
      ws.send(JSON.stringify({ type: "PONG" }));
    }
  }

  private handleClose(ws: WebSocket) {
    const peerId = this.wsToPeerId.get(ws);
    if (peerId) {
      this.sockets.delete(peerId);
      this.roster.delete(peerId);
      this.broadcastRoster();
    }
  }

  private broadcastRoster() {
    const devices = Array.from(this.roster.values()).map(d => ({
      peerId: d.peerId,
      name: d.name,
      platform: d.platform,
      color: d.color
    }));

    const rosterMsg = JSON.stringify({
      type: "ROSTER",
      payload: { devices }
    });

    for (const ws of this.sockets.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(rosterMsg);
        } catch {
          // ignore
        }
      }
    }
  }
}
