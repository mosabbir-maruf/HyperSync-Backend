import { Env } from "../index";
import { Session, SessionState, Peer, PeerRole, ConnectionState } from "../types/models";
import { MessageEnvelope, MessageType } from "../protocol/messages";
import { parseAndValidateMessage } from "../validation/messageValidator";
import { CONFIG, CLOSE_CODES } from "../config";

interface WsAttachment {
  peerId: string;
  role: PeerRole;
}

interface PeerRateLimit {
  messagesInWindow: number;
  windowStart: number;
  reconnects: number;
}

export class SignalingRoom {
  private rateLimits = new Map<string, PeerRateLimit>();
  // In-memory queue for ICE candidates sent before the target peer is READY
  private pendingIceCandidates = new Map<string, MessageEnvelope[]>(); // targetPeerId -> messages
  // Fallback for local miniflare which might lack serializeAttachment
  private wsAttachments = new WeakMap<WebSocket, WsAttachment>();
  
  constructor(private state: DurableObjectState, private env: Env) {
    this.state.blockConcurrencyWhile(async () => {
      // Setup alarms for session expiration and timeout handling
      const session = await this.state.storage.get<Session>("session");
      if (session && session.state !== SessionState.DESTROYED) {
        await this.ensureAlarm(session);
      }
    });
  }

  private async ensureAlarm(session: Session) {
    const currentAlarm = await this.state.storage.getAlarm();
    const nextTick = Math.min(
      session.expiresAt,
      session.host?.connectionState === ConnectionState.DISCONNECTED ? session.host.lastHeartbeat + CONFIG.RECONNECT_WINDOW_MS : Infinity,
      session.guest?.connectionState === ConnectionState.DISCONNECTED ? session.guest.lastHeartbeat + CONFIG.RECONNECT_WINDOW_MS : Infinity
    );
    
    if (nextTick !== Infinity && (!currentAlarm || nextTick < currentAlarm)) {
      await this.state.storage.setAlarm(nextTick);
    }
  }

  async alarm() {
    const session = await this.state.storage.get<Session>("session");
    if (!session || session.state === SessionState.DESTROYED) return;

    const now = Date.now();

    // 1. Check Session Expiry
    if (now >= session.expiresAt) {
      await this.destroySession(session, CLOSE_CODES.SESSION_EXPIRED, "Session expired");
      return;
    }

    // 2. Check Reconnect Timeouts
    let hostTimeout = false;
    let guestTimeout = false;

    if (session.host && session.host.connectionState === ConnectionState.DISCONNECTED) {
      if (now - session.host.lastHeartbeat >= CONFIG.RECONNECT_WINDOW_MS) {
        hostTimeout = true;
      }
    }

    if (session.guest && session.guest.connectionState === ConnectionState.DISCONNECTED) {
      if (now - session.guest.lastHeartbeat >= CONFIG.RECONNECT_WINDOW_MS) {
        guestTimeout = true;
      }
    }

    if (hostTimeout || guestTimeout) {
      await this.destroySession(session, CLOSE_CODES.TIMEOUT, "Reconnect timeout exceeded");
      return;
    }

    // Re-schedule alarm if session still alive
    await this.ensureAlarm(session);
  }

  private async destroySession(session: Session, closeCode: number, reason: string) {
    session.state = SessionState.DESTROYED;
    await this.state.storage.put("session", session);
    this.pendingIceCandidates.clear();

    // Close all websockets
    const websockets = this.state.getWebSockets();
    for (const ws of websockets) {
      ws.close(closeCode, reason);
    }
    
    await this.state.storage.deleteAlarm();
  }

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (url.pathname === "/internal/init") {
        // Init session
        const data = await request.json() as Record<string, unknown>;
        
        const session: Session = {
          sessionId: data.sessionId as string,
          sessionCode: data.sessionCode as string,
          host: null,
          guest: null,
          createdAt: Date.now(),
          expiresAt: data.expiresAt as number,
          state: SessionState.CREATED,
          protocolVersion: data.protocolVersion as number,
          pendingSignals: []
        };
        await this.state.storage.put("session", session);
        await this.ensureAlarm(session);
        return new Response("OK", { status: 200 });
      }

      if (url.pathname === "/internal/join") {
        const session = await this.state.storage.get<Session>("session");
        if (!session) return new Response(JSON.stringify({ error: "Session not found" }), { status: 404 });
        if (session.state === SessionState.EXPIRED || session.state === SessionState.DESTROYED) return new Response(JSON.stringify({ error: "Session is no longer valid" }), { status: 410 });
        if (session.host && session.guest) return new Response(JSON.stringify({ error: "Session is full" }), { status: 403 });
        
        return new Response(JSON.stringify({
          sessionId: session.sessionId,
          sessionCode: session.sessionCode,
          protocolVersion: session.protocolVersion,
          expiresAt: session.expiresAt
        }), { status: 200 });
      }

      const upgrade = request.headers.get("Upgrade")?.toLowerCase();
      if (upgrade && upgrade.includes("websocket")) {
        const pair = new WebSocketPair();
        const client = pair[0];
        const server = pair[1];
        
        this.state.acceptWebSocket(server);
        return new Response(null, { status: 101, webSocket: client });
      }

      return new Response("Not Found", { status: 404 });
    } catch (err: any) {
      console.error("DO fetch error:", err.stack || err.message);
      return new Response(err.stack || err.message, { status: 500 });
    }
  }

  private checkRateLimit(peerId: string): boolean {
    const now = Date.now();
    let rl = this.rateLimits.get(peerId);
    if (!rl) {
      rl = { messagesInWindow: 0, windowStart: now, reconnects: 0 };
      this.rateLimits.set(peerId, rl);
    }

    if (now - rl.windowStart > 1000) {
      rl.windowStart = now;
      rl.messagesInWindow = 0;
    }

    rl.messagesInWindow++;
    return rl.messagesInWindow <= CONFIG.RATE_LIMIT.MAX_MESSAGES_PER_SEC;
  }

  private async savePendingIce() {
    // Pending ICE queue is now purely in-memory
  }

  private isValidTransition(oldState: ConnectionState, newState: ConnectionState): boolean {
    // NEVER ALLOW Invalid Transitions
    if (oldState === ConnectionState.CLOSED) return false;
    if (oldState === ConnectionState.FAILED && newState !== ConnectionState.CLOSED) return false;
    return true; // Simplistic state transition validation; implement strict graph if needed
  }

  private getAttachment(ws: WebSocket): WsAttachment | null {
    if (typeof ws.deserializeAttachment === "function") {
      try {
        const att = ws.deserializeAttachment();
        if (att) return att as WsAttachment;
      } catch (e) {
        // ignore
      }
    }
    return this.wsAttachments.get(ws) || null;
  }

  private setAttachment(ws: WebSocket, attachment: WsAttachment) {
    this.wsAttachments.set(ws, attachment);
    if (typeof ws.serializeAttachment === "function") {
      try {
        ws.serializeAttachment(attachment);
      } catch (e) {
        // ignore
      }
    }
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    let msg: MessageEnvelope;
    try {
      msg = parseAndValidateMessage(message);
    } catch (err) {
      ws.close(CLOSE_CODES.INVALID_PAYLOAD, "Invalid Payload");
      return;
    }

    const session = await this.state.storage.get<Session>("session");
    if (!session || session.state === SessionState.DESTROYED) {
      ws.close(CLOSE_CODES.SESSION_EXPIRED, "Session destroyed");
      return;
    }

    try {
      // Replay protection & Rate limiting
      if (!this.checkRateLimit(msg.peerId)) {
        ws.close(CLOSE_CODES.RATE_LIMITED, "Rate Limit Exceeded");
        return;
      }

      // Initial Registration (JOIN)
      let attachment = this.getAttachment(ws);
      if (!attachment && msg.type === MessageType.JOIN) {
        return await this.handleJoin(ws, msg, session);
      }

      if (!attachment) {
        ws.close(CLOSE_CODES.UNAUTHORIZED, "Unauthenticated");
        return;
      }

      // Validate Peer identity
      if (attachment.peerId !== msg.peerId) {
        ws.close(CLOSE_CODES.POLICY_VIOLATION, "Peer ID mismatch");
        return;
      }

      // Handle messages
      switch (msg.type) {
        case MessageType.PING:
          await this.handlePing(ws, msg, session, attachment);
          break;
        case MessageType.OFFER:
        case MessageType.ANSWER:
        case MessageType.ICE:
          await this.handleSignaling(ws, msg, session, attachment);
          break;
        case MessageType.READY:
          await this.handleReady(ws, msg, session, attachment);
          break;
        case MessageType.LEAVE:
          await this.handleLeave(ws, msg, session, attachment);
          break;
        default:
          // Respond with structured error for unknown types handled post-validation
          this.sendError(ws, "Unsupported message type", CLOSE_CODES.UNSUPPORTED_DATA);
      }
    } catch (e: any) {
      console.error("Unhandled error in webSocketMessage:", e.stack || e.message || e);
      ws.close(1011, "Internal Server Error");
    }
  }

  private async handleJoin(ws: WebSocket, msg: MessageEnvelope, session: Session) {
    const payload = msg.payload as any;
    const rawRole = payload?.role;
    const role = (typeof rawRole === "string" ? rawRole.toUpperCase() : "") as PeerRole;
    
    if (role !== PeerRole.HOST && role !== PeerRole.GUEST) {
      this.sendError(ws, "Invalid role", CLOSE_CODES.POLICY_VIOLATION);
      return;
    }

    // Check if slot is taken by a DIFFERENT peer
    if (role === PeerRole.HOST && session.host && session.host.peerId !== msg.peerId) {
      this.sendError(ws, "Host already exists", CLOSE_CODES.SESSION_FULL);
      return;
    }
    if (role === PeerRole.GUEST && session.guest && session.guest.peerId !== msg.peerId) {
      this.sendError(ws, "Guest already exists", CLOSE_CODES.SESSION_FULL);
      return;
    }

    // Assign Peer
    const peer: Peer = {
      peerId: msg.peerId,
      role: role,
      connectedAt: Date.now(),
      lastHeartbeat: Date.now(),
      connectionState: ConnectionState.CONNECTED
    };

    if (role === PeerRole.HOST) session.host = peer;
    else session.guest = peer;

    // Session State logic
    if (session.state === SessionState.CREATED) session.state = SessionState.WAITING;
    if (session.host && session.guest && session.state === SessionState.WAITING) {
      session.state = SessionState.PAIRING;
    }

    this.setAttachment(ws, { peerId: msg.peerId, role: role });
    await this.state.storage.put("session", session);

    // Reply with HELLO to confirm successful join
    ws.send(JSON.stringify({
      type: MessageType.HELLO,
      protocolVersion: CONFIG.PROTOCOL_VERSION,
      sessionId: session.sessionId,
      peerId: "SERVER",
      timestamp: Date.now(),
      payload: {
        role: role,
        sessionState: session.state
      }
    }));

    // If both are present, notify both peers that the session is ready for negotiation.
    // Include the role of the peer that just joined so the host knows to initiate the offer.
    if (session.state === SessionState.PAIRING) {
      for (const s of this.state.getWebSockets()) {
        const att = this.getAttachment(s);
        s.send(JSON.stringify({
          type: MessageType.READY,
          protocolVersion: CONFIG.PROTOCOL_VERSION,
          sessionId: session.sessionId,
          peerId: "SERVER",
          timestamp: Date.now(),
          payload: {
            joinedRole: role,       // role of the peer that just joined
            joinedPeerId: msg.peerId, // peerId of the peer that just joined
            yourRole: att?.role ?? role // tell each peer their own role
          }
        }));
      }
    }
  }

  private async handlePing(ws: WebSocket, msg: MessageEnvelope, session: Session, attachment: WsAttachment) {
    const peer = attachment.role === PeerRole.HOST ? session.host : session.guest;
    if (peer) {
      peer.lastHeartbeat = Date.now();
      // purely in-memory heartbeat
      await this.ensureAlarm(session);
    }
    
    // Reply PONG
    ws.send(JSON.stringify({
      type: MessageType.PONG,
      protocolVersion: CONFIG.PROTOCOL_VERSION,
      sessionId: session.sessionId,
      peerId: "SERVER",
      timestamp: Date.now(),
      payload: { timestamp: msg.timestamp }
    }));
  }

  private async handleReady(ws: WebSocket, msg: MessageEnvelope, session: Session, attachment: WsAttachment) {
    const peer = attachment.role === PeerRole.HOST ? session.host : session.guest;
    if (peer) peer.connectionState = ConnectionState.CONNECTED;
    session.state = SessionState.NEGOTIATING;
    await this.state.storage.put("session", session);

    // Flush any pending ICE candidates for this peer
    const pending = this.pendingIceCandidates.get(attachment.peerId);
    if (pending && pending.length > 0) {
      for (const iceMsg of pending) {
        ws.send(JSON.stringify(iceMsg));
      }
      this.pendingIceCandidates.delete(attachment.peerId);
      await this.savePendingIce();
    }
  }

  private async handleSignaling(ws: WebSocket, msg: MessageEnvelope, session: Session, attachment: WsAttachment) {
    // Find target peer websocket
    const targetRole = attachment.role === PeerRole.HOST ? PeerRole.GUEST : PeerRole.HOST;
    const targetPeer = targetRole === PeerRole.HOST ? session.host : session.guest;

    if (!targetPeer) {
      // If no target yet, and it's ICE, maybe queue it (though usually they shouldn't send until READY)
      return;
    }

    let targetWs: WebSocket | null = null;
    for (const s of this.state.getWebSockets()) {
      const att = this.getAttachment(s);
      if (att && att.peerId === targetPeer.peerId) {
        targetWs = s;
        break;
      }
    }

    if (targetWs) {
      if (msg.type === MessageType.ICE && targetPeer.connectionState !== ConnectionState.CONNECTED) {
        // Queue ICE if target isn't READY
        let queue = this.pendingIceCandidates.get(targetPeer.peerId) || [];
        queue.push(msg);
        this.pendingIceCandidates.set(targetPeer.peerId, queue);
        await this.savePendingIce();
      } else {
        // Forward exactly without modification
        targetWs.send(JSON.stringify(msg));
      }
    }
  }

  private async handleLeave(ws: WebSocket, msg: MessageEnvelope, session: Session, attachment: WsAttachment) {
    // Notify other peer if exists
    const targetRole = attachment.role === PeerRole.HOST ? PeerRole.GUEST : PeerRole.HOST;
    const targetPeer = targetRole === PeerRole.HOST ? session.host : session.guest;
    
    if (targetPeer) {
      for (const s of this.state.getWebSockets()) {
        const att = this.getAttachment(s);
        if (att && att.peerId === targetPeer.peerId) {
          s.send(JSON.stringify(msg));
          break;
        }
      }
    }

    await this.destroySession(session, CLOSE_CODES.NORMAL, "Peer left");
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    const attachment = this.getAttachment(ws);
    if (!attachment) return;

    const session = await this.state.storage.get<Session>("session");
    if (!session || session.state === SessionState.DESTROYED) return;

    // Ignore an old socket closing after the same peer has already rejoined.
    // Without this guard, the old close callback marks the replacement socket
    // disconnected and starts an unnecessary reconnect timeout.
    for (const socket of this.state.getWebSockets()) {
      const current = this.getAttachment(socket);
      if (socket !== ws && current?.peerId === attachment.peerId) return;
    }

    const peer = attachment.role === PeerRole.HOST ? session.host : session.guest;
    if (peer && peer.peerId === attachment.peerId) {
      peer.connectionState = ConnectionState.DISCONNECTED;
      peer.lastHeartbeat = Date.now(); // Start timeout clock
      await this.state.storage.put("session", session);
      await this.ensureAlarm(session);

      // Notify other peer
      const otherPeer = attachment.role === PeerRole.HOST ? session.guest : session.host;
      if (otherPeer) {
        for (const s of this.state.getWebSockets()) {
          const att = this.getAttachment(s);
          if (att && att.peerId === otherPeer.peerId) {
            s.send(JSON.stringify({
              type: MessageType.ERROR,
              protocolVersion: CONFIG.PROTOCOL_VERSION,
              sessionId: session.sessionId,
              peerId: "SERVER",
              timestamp: Date.now(),
              payload: { message: "Peer disconnected temporarily" }
            }));
          }
        }
      }
    }
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    // Automatically calls webSocketClose; logging for diagnostics
    console.error("WebSocket Error:", error);
  }

  private sendError(ws: WebSocket, message: string, code: number) {
    ws.send(JSON.stringify({
      type: MessageType.ERROR,
      protocolVersion: CONFIG.PROTOCOL_VERSION,
      sessionId: "UNKNOWN",
      peerId: "SERVER",
      timestamp: Date.now(),
      payload: {
        success: false,
        error: "ProtocolError",
        code: code,
        message: message,
        timestamp: Date.now()
      }
    }));
    ws.close(code, message);
  }
}
