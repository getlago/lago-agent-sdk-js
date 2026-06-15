/** Thin HTTP client to Lago. */
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
  constructor(
    private apiKey: string,
    private apiUrl: string,
    private timeoutMs: number = 10_000,
  ) {
    this.apiUrl = apiUrl.replace(/\/$/, "");
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
