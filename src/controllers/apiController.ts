import { createSessionData } from "../services/sessionService";
import { SessionError, ValidationError } from "../types/errors";
import { jsonSuccess } from "../utils/responseFormat";

import { Env } from "../index";

export class ApiController {
  constructor(private env: Env) {}

  async handleHealth(): Promise<Response> {
    return jsonSuccess({
      status: "ok",
      version: "1.0.0",
      uptime: Date.now()
    });
  }

  async handleVersion(): Promise<Response> {
    return jsonSuccess({ version: "1.0.0" });
  }

  async createSession(): Promise<Response> {
    const sessionData = createSessionData();
    const id = this.env.SIGNALING_ROOM.idFromName(sessionData.sessionCode);
    const room = this.env.SIGNALING_ROOM.get(id);
    
    const initReq = new Request("http://do/internal/init", {
      method: "POST",
      body: JSON.stringify(sessionData)
    });
    
    const initRes = await room.fetch(initReq);
    if (!initRes.ok) {
      throw new SessionError(500, "Failed to initialize session");
    }

    return jsonSuccess(sessionData, 201);
  }

  async joinSession(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ValidationError("Invalid JSON body");
    }

    const b = body as Record<string, unknown>;

    if (!b || !b.sessionCode || typeof b.sessionCode !== "string") {
      throw new ValidationError("Missing or invalid sessionCode");
    }

    const sessionCode = b.sessionCode.replace(/[^A-Z0-9]/g, "").toUpperCase();
    if (!sessionCode.startsWith("P")) {
      throw new ValidationError("Invalid session code for 1-to-1 transfer. Group codes cannot be used here.");
    }
    const id = this.env.SIGNALING_ROOM.idFromName(sessionCode);
    const room = this.env.SIGNALING_ROOM.get(id);

    const joinReq = new Request("http://do/internal/join", {
      method: "POST",
      body: JSON.stringify({ sessionCode })
    });

    const joinRes = await room.fetch(joinReq);
    
    if (!joinRes.ok) {
      const errText = await joinRes.text();
      return new Response(errText, { status: joinRes.status, headers: joinRes.headers });
    }

    const joinData = await joinRes.json();
    return jsonSuccess(joinData, joinRes.status, joinRes.headers);
  }

  async createGroupSession(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ValidationError("Invalid JSON body");
    }

    const b = body as Record<string, unknown>;
    if (!b || !b.hostPeerId || typeof b.hostPeerId !== "string") {
      throw new ValidationError("Missing or invalid hostPeerId");
    }

    const sessionData = createSessionData(true);
    const groupSessionData = {
      ...sessionData,
      hostPeerId: b.hostPeerId,
      maxMembers: typeof b.maxMembers === "number" ? b.maxMembers : 8
    };

    const id = this.env.GROUP_SIGNALING_ROOM.idFromName(sessionData.sessionCode);
    const room = this.env.GROUP_SIGNALING_ROOM.get(id);
    
    const initReq = new Request("http://do/internal/init", {
      method: "POST",
      body: JSON.stringify(groupSessionData)
    });
    
    const initRes = await room.fetch(initReq);
    if (!initRes.ok) {
      throw new SessionError(500, "Failed to initialize group session");
    }

    return jsonSuccess(groupSessionData, 201);
  }

  async joinGroupSession(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new ValidationError("Invalid JSON body");
    }

    const b = body as Record<string, unknown>;

    if (!b || !b.sessionCode || typeof b.sessionCode !== "string") {
      throw new ValidationError("Missing or invalid sessionCode");
    }

    const sessionCode = b.sessionCode.replace(/[^A-Z0-9]/g, "").toUpperCase();
    if (!sessionCode.startsWith("G")) {
      throw new ValidationError("Invalid session code for Group transfer. 1-to-1 codes cannot be used here.");
    }
    const id = this.env.GROUP_SIGNALING_ROOM.idFromName(sessionCode);
    const room = this.env.GROUP_SIGNALING_ROOM.get(id);

    const joinReq = new Request("http://do/internal/join", {
      method: "POST",
      body: JSON.stringify({ sessionCode })
    });

    const joinRes = await room.fetch(joinReq);
    
    if (!joinRes.ok) {
      const errText = await joinRes.text();
      return new Response(errText, { status: joinRes.status, headers: joinRes.headers });
    }

    const joinData = await joinRes.json();
    return jsonSuccess(joinData, joinRes.status, joinRes.headers);
  }
}
