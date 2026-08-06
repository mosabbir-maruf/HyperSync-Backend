import { MessageEnvelope, MessageType } from "../protocol/messages";
import { ProtocolError, ValidationError } from "../types/errors";
import { CONFIG } from "../config";

export function parseAndValidateMessage(rawMessage: string | ArrayBuffer): MessageEnvelope {
  if (typeof rawMessage !== "string") {
    throw new ValidationError("Only string payloads are supported");
  }

  if (rawMessage.length > CONFIG.MAX_MESSAGE_SIZE) {
    throw new ValidationError("Payload too large");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawMessage);
  } catch (e) {
    throw new ValidationError("Malformed JSON");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new ValidationError("Invalid message envelope");
  }

  const p = parsed as Record<string, unknown>;

  if (typeof p.type !== "string" || !Object.values(MessageType).includes(p.type as MessageType)) {
    throw new ProtocolError(`Unknown message type: ${p.type}`);
  }

  if (p.protocolVersion !== CONFIG.PROTOCOL_VERSION) {
    throw new ProtocolError(`Unsupported protocol version: ${p.protocolVersion}`);
  }

  if (typeof p.sessionId !== "string" || !p.sessionId) {
    throw new ValidationError("Missing or invalid sessionId");
  }

  if (typeof p.peerId !== "string" || !p.peerId) {
    throw new ValidationError("Missing or invalid peerId");
  }

  if (typeof p.timestamp !== "number") {
    throw new ValidationError("Missing or invalid timestamp");
  }

  return parsed as MessageEnvelope;
}
