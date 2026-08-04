import { ApiController } from "../controllers/apiController";
import { Env } from "../index";
import { withErrorHandler } from "../middleware/errorHandler";
import { corsMiddleware } from "../middleware/cors";
import { jsonError } from "../utils/responseFormat";
import { requireWebSocketUpgrade, normalizeSessionCode } from "../utils/ws";

export class Router {
  constructor(private env: Env) {}

  async route(request: Request): Promise<Response> {
    return corsMiddleware(request, async () => {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;

      const controller = new ApiController(this.env);

      if (method === "GET" && path === "/health") {
        return withErrorHandler(() => controller.handleHealth());
      }

      if (method === "GET" && path === "/version") {
        return withErrorHandler(() => controller.handleVersion());
      }

      if (method === "POST" && path === "/session") {
        return withErrorHandler(() => controller.createSession());
      }

      if (method === "POST" && path === "/join") {
        return withErrorHandler(() => controller.joinSession(request));
      }

      if (method === "POST" && path === "/group/session") {
        return withErrorHandler(() => controller.createGroupSession(request));
      }

      if (method === "POST" && path === "/group/join") {
        return withErrorHandler(() => controller.joinGroupSession(request));
      }

      // Lobby WebSocket route
      if (path === "/lobby") {
        const upgradeError = requireWebSocketUpgrade(request);
        if (upgradeError) return upgradeError;

        const id = this.env.LOBBY_ROOM.idFromName("GLOBAL_LOBBY");
        const room = this.env.LOBBY_ROOM.get(id);
        
        try {
          return await room.fetch(request.url, request);
        } catch (err: any) {
          console.error("Worker routing error to Lobby DO:", err.stack || err.message);
          return new Response(err.stack || err.message, { status: 500 });
        }
      }

      // Upgrade WebSocket route
      if (path === "/ws") {
        const upgradeError = requireWebSocketUpgrade(request);
        if (upgradeError) return upgradeError;

        const sessionCode = url.searchParams.get("code");
        const normalizedCode = normalizeSessionCode(sessionCode);
        if (!normalizedCode) {
          return jsonError("ValidationError", "MISSING_CODE", "Missing session code", 400);
        }

        if (!normalizedCode.startsWith("P")) {
          return jsonError("ValidationError", "INVALID_CODE", "Invalid session code for 1-to-1 transfer", 400);
        }
        const id = this.env.SIGNALING_ROOM.idFromName(normalizedCode);
        const room = this.env.SIGNALING_ROOM.get(id);
        
        try {
          return await room.fetch(request.url, request);
        } catch (err: any) {
          console.error("Worker routing error to DO:", err.stack || err.message);
          return new Response(err.stack || err.message, { status: 500 });
        }
      }

      // Group WebSocket route
      if (path === "/group/ws") {
        const upgradeError = requireWebSocketUpgrade(request);
        if (upgradeError) return upgradeError;

        const sessionCode = url.searchParams.get("code");
        const normalizedCode = normalizeSessionCode(sessionCode);
        if (!normalizedCode) {
          return jsonError("ValidationError", "MISSING_CODE", "Missing session code", 400);
        }

        if (!normalizedCode.startsWith("G")) {
          return jsonError("ValidationError", "INVALID_CODE", "Invalid session code for Group transfer", 400);
        }
        const id = this.env.GROUP_SIGNALING_ROOM.idFromName(normalizedCode);
        const room = this.env.GROUP_SIGNALING_ROOM.get(id);
        
        try {
          return await room.fetch(request.url, request);
        } catch (err: any) {
          console.error("Worker routing error to Group DO:", err.stack || err.message);
          return new Response(err.stack || err.message, { status: 500 });
        }
      }

      return jsonError("NotFound", "NOT_FOUND", "Endpoint not found", 404);
    });
  }
}
