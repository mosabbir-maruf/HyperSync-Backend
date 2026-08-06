import { MessageEnvelope } from "../protocol/messages";

export enum SessionState {
  CREATED = "CREATED",
  WAITING = "WAITING",
  PAIRING = "PAIRING",
  NEGOTIATING = "NEGOTIATING",
  CONNECTED = "CONNECTED",
  DISCONNECTED = "DISCONNECTED",
  EXPIRED = "EXPIRED",
  DESTROYED = "DESTROYED"
}

export enum PeerRole {
  HOST = "HOST",
  GUEST = "GUEST",
  MEMBER = "MEMBER"
}

export enum ConnectionState {
  NEW = "NEW",
  CONNECTED = "CONNECTED",
  DISCONNECTED = "DISCONNECTED",
  FAILED = "FAILED",
  CLOSED = "CLOSED"
}

export interface Peer {
  peerId: string;
  role: PeerRole;
  connectedAt: number;
  lastHeartbeat: number;
  connectionState: ConnectionState;
  websocket?: WebSocket;
}

export interface Session {
  sessionId: string;
  sessionCode: string;
  host: Peer | null;
  guest: Peer | null;
  createdAt: number;
  expiresAt: number;
  state: SessionState;
  protocolVersion: number;
  pendingSignals: MessageEnvelope[];
}

export interface GroupSession {
  groupId: string;
  groupCode: string;
  hostPeerId: string;
  members: Peer[];
  maxMembers: number;
  createdAt: number;
  expiresAt: number;
  state: SessionState;
  protocolVersion: number;
  pendingSignals: MessageEnvelope[];
}
