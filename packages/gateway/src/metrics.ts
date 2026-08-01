/** Hand-rolled Prometheus text-exposition metrics. Counters and histograms
 * only, no external dependency. Label sets are small and bounded (provider,
 * model, status), so a Map keyed by serialized labels is enough. */

type Labels = Record<string, string>;

function labelKey(labels: Labels): string {
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}="${escapeLabel(labels[k])}"`).join(",");
}

function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export class Counter {
  private values = new Map<string, number>();
  constructor(
    public name: string,
    public help: string,
  ) {}

  inc(labels: Labels = {}, by: number = 1): void {
    const key = labelKey(labels);
    this.values.set(key, (this.values.get(key) ?? 0) + by);
  }

  /** Sum across all label sets (for assertions and gauges-of-counters). */
  total(): number {
    let t = 0;
    for (const v of this.values.values()) t += v;
    return t;
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    if (this.values.size === 0) lines.push(`${this.name} 0`);
    for (const [key, v] of this.values) {
      lines.push(key ? `${this.name}{${key}} ${v}` : `${this.name} ${v}`);
    }
    return lines.join("\n");
  }
}

export class Histogram {
  private buckets: number[];
  private counts = new Map<string, number[]>();
  private sums = new Map<string, number>();
  private totals = new Map<string, number>();
  constructor(
    public name: string,
    public help: string,
    buckets: number[],
  ) {
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(labels: Labels, value: number): void {
    const key = labelKey(labels);
    let counts = this.counts.get(key);
    if (!counts) {
      counts = new Array(this.buckets.length).fill(0);
      this.counts.set(key, counts);
    }
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]) counts[i]++;
    }
    this.sums.set(key, (this.sums.get(key) ?? 0) + value);
    this.totals.set(key, (this.totals.get(key) ?? 0) + 1);
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const [key, counts] of this.counts) {
      const prefix = key ? `${key},` : "";
      for (let i = 0; i < this.buckets.length; i++) {
        lines.push(`${this.name}_bucket{${prefix}le="${this.buckets[i]}"} ${counts[i]}`);
      }
      lines.push(`${this.name}_bucket{${prefix}le="+Inf"} ${this.totals.get(key) ?? 0}`);
      lines.push(`${this.name}_sum{${key}} ${this.sums.get(key) ?? 0}`);
      lines.push(`${this.name}_count{${key}} ${this.totals.get(key) ?? 0}`);
    }
    return lines.join("\n");
  }
}

export class Gauge {
  constructor(
    public name: string,
    public help: string,
    private read: () => number,
  ) {}

  render(): string {
    return [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} gauge`,
      `${this.name} ${this.read()}`,
    ].join("\n");
  }
}

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

export function createMetrics(readOutboxDepth: () => number) {
  return {
    requestsTotal: new Counter("gw_requests_total", "LLM requests by provider, model, status"),
    requestDuration: new Histogram(
      "gw_request_duration_seconds",
      "End-to-end request duration",
      LATENCY_BUCKETS,
    ),
    ttfb: new Histogram("gw_ttfb_seconds", "Time to first upstream byte", LATENCY_BUCKETS),
    tokensTotal: new Counter("gw_tokens_total", "Billed tokens by dimension"),
    eventsEmitted: new Counter("gw_billing_events_emitted_total", "Billing events accepted by the outbox"),
    eventsDropped: new Counter(
      "gw_billing_events_dropped_total",
      "Billing events accepted then lost. Must be 0 in gateway mode",
    ),
    budgetDenials: new Counter("gw_budget_denials_total", "Requests rejected by budget enforcement"),
    providerErrors: new Counter("gw_provider_errors_total", "Upstream provider/proxy errors"),
    backpressureRejections: new Counter(
      "gw_backpressure_rejections_total",
      "Requests rejected because the outbox is full (fail-closed)",
    ),
    outboxDepth: new Gauge(
      "gw_billing_outbox_depth",
      "Undelivered events in the durable outbox",
      readOutboxDepth,
    ),
  };
}

export type Metrics = ReturnType<typeof createMetrics>;

export function renderMetrics(m: Metrics): string {
  return (
    [
      m.requestsTotal.render(),
      m.requestDuration.render(),
      m.ttfb.render(),
      m.tokensTotal.render(),
      m.eventsEmitted.render(),
      m.eventsDropped.render(),
      m.budgetDenials.render(),
      m.providerErrors.render(),
      m.backpressureRejections.render(),
      m.outboxDepth.render(),
    ].join("\n") + "\n"
  );
}
