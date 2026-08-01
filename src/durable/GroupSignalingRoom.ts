import { Env } from "../controllers/apiController";
import { GroupSession, SessionState, Peer, PeerRole, ConnectionState } from "../types/models";
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

export class GroupSignalingRoom {
  private rateLimits = new Map<string, PeerRateLimit>();
  // In-memory queue for ICE candidates sent before the target peer is READY
  private pendingIceCandidates = new Map<string, MessageEnvelope[]>(); // targetPeerId -> messages
  private wsAttachments = new WeakMap<WebSocket, WsAttachment>();
  
  constructor(private state: DurableObjectState, private env: Env) {
    this.state.blockConcurrencyWhile(async () => {
      const storedIce = await this.state.storage.get<Record<string, MessageEnvelope[]>>("pendingIce");
      if (storedIce) {
        for (const [key, val] of Object.entries(storedIce)) {
          this.pendingIceCandidates.set(key, val);
        }
      }
      
      const session = await this.state.storage.get<GroupSession>("session");
      if (session && session.state !== SessionState.DESTROYED) {
        await this.ensureAlarm(session);
      }
    });
  }

  private async ensureAlarm(session: GroupSession) {
    const currentAlarm = await this.state.storage.getAlarm();
    let nextTick = session.expiresAt;

    for (const peer of session.members) {
      if (peer.connectionState === ConnectionState.DISCONNECTED) {
        const timeout = peer.lastHeartbeat + CONFIG.RECONNECT_WINDOW_MS;
        if (timeout < nextTick) nextTick = timeout;
      }
    }
    
    if (nextTick !== Infinity && (!currentAlarm || nextTick < currentAlarm)) {
      await this.state.storage.setAlarm(nextTick);
    }
  }

  async alarm() {
    const session = await this.state.storage.get<GroupSession>("session");
    if (!session || session.state === SessionState.DESTROYED) return;

    const now = Date.now();

    // 1. Check Session Expiry
    if (now >= session.expiresAt) {
      await this.destroySession(session, CLOSE_CODES.SESSION_EXPIRED, "Session expired");
      return;
    }

    // 2. Check Reconnect Timeouts
    let membersChanged = false;
    session.members = session.members.filter(peer => {
      if (peer.connectionState === ConnectionState.DISCONNECTED && (now - peer.lastHeartbeat >= CONFIG.RECONNECT_WINDOW_MS)) {
        membersChanged = true;
        this.notifyAll(session, {
          type: MessageType.GROUP_MEMBER_LEFT,
          protocolVersion: CONFIG.PROTOCOL_VERSION,
          sessionId: session.groupId,
          peerId: "SERVER",
          timestamp: Date.now(),
          payload: { peerId: peer.peerId, reason: "timeout" }
        }, [peer.peerId]);
        return false; // Remove timed out peer
      }
      return true;
    });

    // If host was removed or everyone is gone, we could keep the group alive for others.
    if (session.members.length === 0) {
      await this.destroySession(session, CLOSE_CODES.TIMEOUT, "All members left");
      return;
    }

    if (membersChanged) {
      await this.state.storage.put("session", session);
    }

    // Re-schedule alarm if session still alive
    await this.ensureAlarm(session);
  }

  private async destroySession(session: GroupSession, closeCode: number, reason: string) {
    session.state = SessionState.DESTROYED;
    await this.state.storage.put("session", session);
    await this.state.storage.delete("pendingIce");
    this.pendingIceCandidates.clear();

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
        const data = await request.json() as Record<string, unknown>;
        
        const session: GroupSession = {
          groupId: data.sessionId as string,
          groupCode: data.sessionCode as string,
          hostPeerId: data.hostPeerId as string,
          members: [],
          maxMembers: (data.maxMembers as number) || 8,
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
        const session = await this.state.storage.get<GroupSession>("session");
        if (!session) return new Response(JSON.stringify({ error: "Group not found" }), { status: 404 });
        if (session.state === SessionState.EXPIRED || session.state === SessionState.DESTROYED) return new Response(JSON.stringify({ error: "Group is no longer valid" }), { status: 410 });
        if (session.members.length >= session.maxMembers) return new Response(JSON.stringify({ error: "Group is full" }), { status: 403 });
        
        return new Response(JSON.stringify({
          sessionId: session.groupId,
          sessionCode: session.groupCode,
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
    return rl.messagesInWindow <= (CONFIG.RATE_LIMIT.MAX_MESSAGES_PER_SEC * 3); // Slightly higher for group fan-out signaling
  }

  private async savePendingIce() {
    const obj: Record<string, MessageEnvelope[]> = {};
    for (const [key, val] of this.pendingIceCandidates.entries()) {
      obj[key] = val;
    }
    await this.state.storage.put("pendingIce", obj);
  }

  private getAttachment(ws: WebSocket): WsAttachment | null {
    if (typeof ws.deserializeAttachment === "function") {
      try {
        const att = ws.deserializeAttachment();
        if (att) return att as WsAttachment;
      } catch (e) {}
    }
    return this.wsAttachments.get(ws) || null;
  }

  private setAttachment(ws: WebSocket, attachment: WsAttachment) {
    this.wsAttachments.set(ws, attachment);
    if (typeof ws.serializeAttachment === "function") {
      try {
        ws.serializeAttachment(attachment);
      } catch (e) {}
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

    const session = await this.state.storage.get<GroupSession>("session");
    if (!session || session.state === SessionState.DESTROYED) {
      ws.close(CLOSE_CODES.SESSION_EXPIRED, "Session destroyed");
      return;
    }

    try {
      if (!this.checkRateLimit(msg.peerId)) {
        ws.close(CLOSE_CODES.RATE_LIMITED, "Rate Limit Exceeded");
        return;
      }

      let attachment = this.getAttachment(ws);
      if (!attachment && msg.type === MessageType.GROUP_JOIN) {
        return await this.handleJoin(ws, msg, session);
      }

      if (!attachment) {
        ws.close(CLOSE_CODES.UNAUTHORIZED, "Unauthenticated");
        return;
      }

      if (attachment.peerId !== msg.peerId) {
        ws.close(CLOSE_CODES.POLICY_VIOLATION, "Peer ID mismatch");
        return;
      }

      switch (msg.type) {
        case MessageType.PING:
          await this.handlePing(ws, msg, session, attachment);
          break;
        case MessageType.GROUP_SIGNAL:
          await this.handleSignaling(ws, msg, session, attachment);
          break;
        case MessageType.READY:
          await this.handleReady(ws, msg, session, attachment);
          break;
        case MessageType.GROUP_LEAVE:
          await this.handleLeave(ws, msg, session, attachment);
          break;
        default:
          this.sendError(ws, "Unsupported message type for group", CLOSE_CODES.UNSUPPORTED_DATA);
      }
    } catch (e: any) {
      console.error("Unhandled error in webSocketMessage:", e.stack || e.message || e);
      ws.close(1011, "Internal Server Error");
    }
  }

  private async handleJoin(ws: WebSocket, msg: MessageEnvelope, session: GroupSession) {
    const payload = msg.payload as any;
    
    // Check if peer is already in session (e.g. reconnect)
    let peer = session.members.find(p => p.peerId === msg.peerId);
    
    if (!peer) {
      if (session.members.length >= session.maxMembers) {
        this.sendError(ws, "Group is full", CLOSE_CODES.SESSION_FULL);
        return;
      }
      
      peer = {
        peerId: msg.peerId,
        role: msg.peerId === session.hostPeerId ? PeerRole.HOST : PeerRole.MEMBER,
        connectedAt: Date.now(),
        lastHeartbeat: Date.now(),
        connectionState: ConnectionState.CONNECTED
      };
      session.members.push(peer);
    } else {
      peer.connectionState = ConnectionState.CONNECTED;
      peer.lastHeartbeat = Date.now();
    }

    if (session.state === SessionState.CREATED) session.state = SessionState.PAIRING;

    this.setAttachment(ws, { peerId: msg.peerId, role: peer.role });
    await this.state.storage.put("session", session);

    // Reply with HELLO
    ws.send(JSON.stringify({
      type: MessageType.HELLO,
      protocolVersion: CONFIG.PROTOCOL_VERSION,
      sessionId: session.groupId,
      peerId: "SERVER",
      timestamp: Date.now(),
      payload: {
        role: peer.role,
        sessionState: session.state,
        members: session.members.map(m => ({ peerId: m.peerId, role: m.role }))
      }
    }));

    // Notify others that a member joined
    this.notifyAll(session, {
      type: MessageType.GROUP_MEMBER_JOINED,
      protocolVersion: CONFIG.PROTOCOL_VERSION,
      sessionId: session.groupId,
      peerId: "SERVER",
      timestamp: Date.now(),
      payload: {
        peerId: msg.peerId,
        role: peer.role
      }
    }, [msg.peerId]);
  }

  private notifyAll(session: GroupSession, msg: MessageEnvelope, excludePeerIds: string[] = []) {
    const serialized = JSON.stringify(msg);
    for (const s of this.state.getWebSockets()) {
      const att = this.getAttachment(s);
      if (att && !excludePeerIds.includes(att.peerId)) {
        s.send(serialized);
      }
    }
  }

  private async handlePing(ws: WebSocket, msg: MessageEnvelope, session: GroupSession, attachment: WsAttachment) {
    const peer = session.members.find(p => p.peerId === attachment.peerId);
    if (peer) {
      peer.lastHeartbeat = Date.now();
      await this.state.storage.put("session", session);
      await this.ensureAlarm(session);
    }
    
    ws.send(JSON.stringify({
      type: MessageType.PONG,
      protocolVersion: CONFIG.PROTOCOL_VERSION,
      sessionId: session.groupId,
      peerId: "SERVER",
      timestamp: Date.now(),
      payload: { timestamp: msg.timestamp }
    }));
  }

  private async handleReady(ws: WebSocket, msg: MessageEnvelope, session: GroupSession, attachment: WsAttachment) {
    const peer = session.members.find(p => p.peerId === attachment.peerId);
    if (peer) peer.connectionState = ConnectionState.CONNECTED;
    await this.state.storage.put("session", session);

    const pending = this.pendingIceCandidates.get(attachment.peerId);
    if (pending && pending.length > 0) {
      for (const iceMsg of pending) {
        ws.send(JSON.stringify(iceMsg));
      }
      this.pendingIceCandidates.delete(attachment.peerId);
      await this.savePendingIce();
    }
  }

  private async handleSignaling(ws: WebSocket, msg: MessageEnvelope, session: GroupSession, attachment: WsAttachment) {
    const payload = msg.payload as any;
    const targetPeerId = payload.targetPeerId;
    
    if (!targetPeerId) return;

    let targetWs: WebSocket | null = null;
    for (const s of this.state.getWebSockets()) {
      const att = this.getAttachment(s);
      if (att && att.peerId === targetPeerId) {
        targetWs = s;
        break;
      }
    }

    if (targetWs) {
      const targetPeer = session.members.find(p => p.peerId === targetPeerId);
      const innerSignal = payload.signal; // { kind: 'ice' | 'offer' | 'answer', ... }
      
      if (innerSignal && innerSignal.kind === 'ice' && targetPeer && targetPeer.connectionState !== ConnectionState.CONNECTED) {
        let queue = this.pendingIceCandidates.get(targetPeerId) || [];
        queue.push(msg);
        this.pendingIceCandidates.set(targetPeerId, queue);
        await this.savePendingIce();
      } else {
        targetWs.send(JSON.stringify(msg));
      }
    }
  }

  private async handleLeave(ws: WebSocket, msg: MessageEnvelope, session: GroupSession, attachment: WsAttachment) {
    session.members = session.members.filter(p => p.peerId !== attachment.peerId);
    await this.state.storage.put("session", session);

    this.notifyAll(session, {
      type: MessageType.GROUP_MEMBER_LEFT,
      protocolVersion: CONFIG.PROTOCOL_VERSION,
      sessionId: session.groupId,
      peerId: "SERVER",
      timestamp: Date.now(),
      payload: { peerId: attachment.peerId, reason: "left" }
    });

    if (session.members.length === 0) {
      await this.destroySession(session, CLOSE_CODES.NORMAL, "All members left");
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    const attachment = this.getAttachment(ws);
    if (!attachment) return;

    const session = await this.state.storage.get<GroupSession>("session");
    if (!session || session.state === SessionState.DESTROYED) return;

    const peer = session.members.find(p => p.peerId === attachment.peerId);
    if (peer) {
      peer.connectionState = ConnectionState.DISCONNECTED;
      peer.lastHeartbeat = Date.now();
      await this.state.storage.put("session", session);
      await this.ensureAlarm(session);

      this.notifyAll(session, {
        type: MessageType.ERROR,
        protocolVersion: CONFIG.PROTOCOL_VERSION,
        sessionId: session.groupId,
        peerId: "SERVER",
        timestamp: Date.now(),
        payload: { message: `Peer ${attachment.peerId} disconnected temporarily` }
      }, [attachment.peerId]);
    }
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    console.error("WebSocket Error:", error);
  }

  private sendError(ws: WebSocket, message: string, code: number) {
    ws.send(JSON.stringify({
      type: MessageType.ERROR,
      protocolVersion: CONFIG.PROTOCOL_VERSION,
      sessionId: "UNKNOWN",
      peerId: "SERVER",
      timestamp: Date.now(),
      payload: { success: false, error: "ProtocolError", code, message, timestamp: Date.now() }
    }));
    ws.close(code, message);
  }
}
