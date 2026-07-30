import { ApiController, Env } from "../controllers/apiController";
import { withErrorHandler } from "../middleware/errorHandler";
import { corsMiddleware } from "../middleware/cors";
import { jsonError } from "../utils/responseFormat";

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

      // Upgrade WebSocket route
      if (path === "/ws") {
        const upgradeHeader = request.headers.get("Upgrade");
        if (!upgradeHeader || upgradeHeader !== "websocket") {
          return jsonError("UpgradeRequired", "UPGRADE_REQUIRED", "Expected Upgrade: websocket", 426);
        }

        const sessionCode = url.searchParams.get("code");
        if (!sessionCode) {
          return jsonError("ValidationError", "MISSING_CODE", "Missing session code", 400);
        }

        const normalizedCode = sessionCode.replace(/[^A-Z0-9]/gi, "").toUpperCase();
        const id = this.env.SIGNALING_ROOM.idFromName(normalizedCode);
        const room = this.env.SIGNALING_ROOM.get(id);
        
        try {
          return await room.fetch(request.url, request);
        } catch (err: any) {
          console.error("Worker routing error to DO:", err.stack || err.message);
          return new Response(err.stack || err.message, { status: 500 });
        }
      }

      return jsonError("NotFound", "NOT_FOUND", "Endpoint not found", 404);
    });
  }
}
