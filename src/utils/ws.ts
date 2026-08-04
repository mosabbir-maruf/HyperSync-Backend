import { jsonError } from "./responseFormat";

export function requireWebSocketUpgrade(request: Request): Response | null {
  const upgradeHeader = request.headers.get("Upgrade")?.toLowerCase();
  if (!upgradeHeader || !upgradeHeader.includes("websocket")) {
    return jsonError("UpgradeRequired", "UPGRADE_REQUIRED", "Expected Upgrade: websocket", 426);
  }
  return null;
}

export function normalizeSessionCode(code: string | null): string | null {
  if (!code) return null;
  return code.replace(/[^A-Z0-9]/gi, "").toUpperCase();
}
