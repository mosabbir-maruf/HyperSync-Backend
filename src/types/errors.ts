export class BaseError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ValidationError extends BaseError {
  constructor(message: string) {
    super(400, message);
  }
}

export class SessionError extends BaseError {
  constructor(status: number = 404, message: string) {
    super(status, message);
  }
}

export class PeerError extends BaseError {
  constructor(status: number = 403, message: string) {
    super(status, message);
  }
}

export class ProtocolError extends BaseError {
  constructor(message: string) {
    super(400, message);
  }
}

export class ConnectionError extends BaseError {
  constructor(message: string) {
    super(500, message);
  }
}
