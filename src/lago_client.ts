/** Thin HTTP client to Lago. */
import { Agent } from "undici";

import { LagoApiError } from "./exceptions.js";

export interface LagoEvent {
  transaction_id: string;
  external_subscription_id: string;
  code: string;
  timestamp: number;
  /** Amount in cents for Lago's dynamic charge model (price mode only). */
  precise_total_amount_cents?: string;
  properties: Record<string, unknown>;
}

export class LagoClient {
  /**
   * TLS verification for requests to `apiUrl`. Defaults to true; the one legitimate
   * reason to disable is a local dev Lago behind a self-signed cert.
   *
   * Scoped via undici's `Agent`, passed as `dispatcher` on the affected requests only —
   * NOT `NODE_TLS_REJECT_UNAUTHORIZED`, which would weaken TLS process-wide rather than
   * just for calls to `apiUrl`.
   */
  readonly verifySsl: boolean;
  private insecureAgent: Agent | undefined;

  constructor(
    private apiKey: string,
    private apiUrl: string,
    private timeoutMs: number = 10_000,
    verifySsl: boolean = true,
  ) {
    this.apiUrl = apiUrl.replace(/\/$/, "");
    this.verifySsl = verifySsl;
    this.insecureAgent = verifySsl ? undefined : new Agent({ connect: { rejectUnauthorized: false } });
  }

  async sendBatch(events: LagoEvent[]): Promise<void> {
    if (events.length === 0) return;
    const url = `${this.apiUrl}/events/batch`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ events }),
        signal: ctrl.signal,
        ...(this.insecureAgent ? { dispatcher: this.insecureAgent } : {}),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => "");
        throw new LagoApiError(resp.status, body);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
