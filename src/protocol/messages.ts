export enum MessageType {
  HELLO = "HELLO",
  JOIN = "JOIN",
  READY = "READY",
  OFFER = "OFFER",
  ANSWER = "ANSWER",
  ICE = "ICE",
  PING = "PING",
  PONG = "PONG",
  LEAVE = "LEAVE",
  ERROR = "ERROR",
  SESSION_EXPIRED = "SESSION_EXPIRED",
  SESSION_FULL = "SESSION_FULL",
  INVALID_MESSAGE = "INVALID_MESSAGE",
  UNKNOWN_MESSAGE = "UNKNOWN_MESSAGE"
}

export interface MessageEnvelope {
  type: MessageType;
  protocolVersion: number;
  sessionId: string;
  peerId: string;
  timestamp: number;
  payload: unknown;
}
