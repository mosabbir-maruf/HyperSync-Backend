import { createSessionData } from "../services/sessionService";
import { SessionError, ValidationError } from "../types/errors";
import { jsonSuccess } from "../utils/responseFormat";

export interface Env {
  SIGNALING_ROOM: DurableObjectNamespace;
  LOBBY_ROOM: DurableObjectNamespace;
}

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
}
