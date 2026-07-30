import { generateSessionId, generateSessionCode } from "../utils/crypto";
import { CONFIG } from "../config";

export interface SessionCreationResult {
  sessionId: string;
  sessionCode: string;
  expiresAt: number;
  protocolVersion: number;
}

export function createSessionData(): SessionCreationResult {
  const sessionId = generateSessionId();
  const sessionCode = generateSessionCode();
  const expiresAt = Date.now() + CONFIG.SESSION_TIMEOUT_MS;

  return {
    sessionId,
    sessionCode,
    expiresAt,
    protocolVersion: CONFIG.PROTOCOL_VERSION
  };
}
