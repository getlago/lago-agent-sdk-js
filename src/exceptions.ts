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
  detail?: string;
  constructor(provider: string, model: string, api: string, detail?: string) {
    // `detail` is for the miss that is NOT "table cold / model unknown" — a Ramp Router
    // call served at a non-default tier is unpriced by decision, and the customer needs
    // to read that off the error rather than chase a model name.
    const message = `no price for provider=${provider} model=${model} api=${api}`;
    super(detail ? `${message}: ${detail}` : message);
    this.name = "PricingUnavailableError";
    this.provider = provider;
    this.model = model;
    this.api = api;
    this.detail = detail;
  }
}
