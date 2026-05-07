/** Error types for the Lago Agent SDK. */

export class LagoSDKError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LagoSDKError";
  }
}

export class LagoConfigError extends LagoSDKError {
  constructor(message: string) {
    super(message);
    this.name = "LagoConfigError";
  }
}

export class LagoApiError extends LagoSDKError {
  status: number;
  body: string;
  constructor(status: number, body: string) {
    super(`Lago API error ${status}: ${body.slice(0, 200)}`);
    this.name = "LagoApiError";
    this.status = status;
    this.body = body;
  }
}

export class UnknownClientError extends LagoConfigError {
  constructor(message: string) {
    super(message);
    this.name = "UnknownClientError";
  }
}
