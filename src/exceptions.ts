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

/**
 * Price mode could not resolve a price (table not warm yet, or model not
 * matched). Surfaced via onError; the SDK falls back to emitting token events.
 */
export class PricingUnavailableError extends LagoSDKError {
  provider: string;
  model: string;
  api: string;
  constructor(provider: string, model: string, api: string) {
    super(`no price for provider=${provider} model=${model} api=${api}`);
    this.name = "PricingUnavailableError";
    this.provider = provider;
    this.model = model;
    this.api = api;
  }
}
