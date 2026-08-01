/** Gateway configuration, loaded from env. Fails fast on anything invalid:
 * a misconfigured billing gateway must refuse to boot, not guess. */

export interface GatewayConfig {
  port: number;
  bifrostUrl: string;
  lagoApiUrl: string;
  lagoApiKey: string;
  adminToken: string;
  /** 32-byte master key for BYOK envelope encryption (base64). */
  masterKey: Buffer;
  dataDir: string;
  pricingMode: "price" | "tokens";
  markup: number;
  /** Soft gate: reject new LLM requests when outbox depth reaches this. */
  backpressureDepth: number;
  /** Hard outbox bound (soft gate + headroom for in-flight requests). */
  outboxHardDepth: number;
  /** Optional OpenRouter-format price table override (harness/demo). */
  openrouterUrl?: string;
  pricingTtlMs: number;
  budgetTtlMs: number;
  /** Lago unreachable during a budget check: allow (default) unless the key is strict. */
  upstreamTimeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const required = (name: string): string => {
    const v = env[name];
    if (!v) throw new Error(`missing required env ${name}`);
    return v;
  };
  const num = (name: string, dflt: number): number => {
    const v = env[name];
    if (v === undefined) return dflt;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid ${name}=${v}`);
    return n;
  };

  const masterKey = Buffer.from(required("GW_MASTER_KEY"), "base64");
  if (masterKey.length !== 32) {
    throw new Error("GW_MASTER_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)");
  }
  const adminToken = required("GW_ADMIN_TOKEN");
  if (adminToken.length < 16) throw new Error("GW_ADMIN_TOKEN must be at least 16 characters");

  const pricingMode = env.GW_PRICING_MODE ?? "price";
  if (pricingMode !== "price" && pricingMode !== "tokens") {
    throw new Error(`invalid GW_PRICING_MODE=${pricingMode} (price | tokens)`);
  }
  const backpressureDepth = num("GW_BACKPRESSURE_DEPTH", 50_000);

  return {
    port: num("GW_PORT", 8090),
    bifrostUrl: (env.GW_BIFROST_URL ?? "http://127.0.0.1:8080").replace(/\/$/, ""),
    lagoApiUrl: (env.LAGO_API_URL ?? "https://api.getlago.com/api/v1").replace(/\/$/, ""),
    lagoApiKey: required("LAGO_API_KEY"),
    adminToken,
    masterKey,
    dataDir: env.GW_DATA_DIR ?? "./data",
    pricingMode,
    markup: num("GW_MARKUP", 1.0),
    backpressureDepth,
    outboxHardDepth: backpressureDepth + num("GW_BACKPRESSURE_HEADROOM", 10_000),
    openrouterUrl: env.GW_OPENROUTER_URL,
    pricingTtlMs: num("GW_PRICING_TTL_MS", 3_600_000),
    budgetTtlMs: num("GW_BUDGET_TTL_MS", 5_000),
    upstreamTimeoutMs: num("GW_UPSTREAM_TIMEOUT_MS", 120_000),
  };
}
