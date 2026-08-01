/** Gateway entrypoint: wire config → stores → outbox → pricing → server. */
import { join } from "node:path";

import {
  DEFAULT_COST_METRIC_CODE,
  DEFAULT_METRIC_CODES,
  HttpPricingFetcher,
  LagoClient,
  parseOpenRouter,
  PricingProvider,
  type PricingFetcher,
} from "@getlago/agent-sdk/core";

import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { KeyStore } from "./store.js";
import { DurableEventQueue } from "./outbox.js";
import { AllowAllBudgetChecker } from "./budget.js";
import { createMetrics } from "./metrics.js";
import { createGatewayServer } from "./server.js";

export async function start(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger();
  const onError = (err: unknown, where: string): void => {
    logger.error("billing error", { where, error: String(err) });
  };

  const store = new KeyStore(join(config.dataDir, "keys.db"), config.masterKey);
  const lagoClient = new LagoClient(config.lagoApiKey, config.lagoApiUrl);
  const outbox = new DurableEventQueue({
    path: join(config.dataDir, "outbox.db"),
    sender: (batch) => lagoClient.sendBatch(batch),
    maxDepth: config.outboxHardDepth,
    onError,
  });

  // Optional price-table override (harness/demo): same OpenRouter wire format,
  // different URL. Bedrock pricing keeps the real fetcher.
  const fetcher: PricingFetcher | undefined = config.openrouterUrl
    ? {
        fetchOpenRouter: async () => {
          const resp = await fetch(config.openrouterUrl as string);
          if (!resp.ok) throw new Error(`GET ${config.openrouterUrl} -> ${resp.status}`);
          return parseOpenRouter(await resp.json());
        },
        fetchBedrock: (region: string) => new HttpPricingFetcher().fetchBedrock(region),
      }
    : undefined;
  const pricing = new PricingProvider({ fetcher, ttlMs: config.pricingTtlMs, onError });
  if (config.pricingMode === "price") {
    pricing.prime();
    // Refresh off the hot path; lookups never block on HTTP.
    const refresh = setInterval(() => void pricing.maybeRefresh().catch(() => {}), 5_000);
    refresh.unref();
    await pricing.maybeRefresh().catch((err) => onError(err, "pricing.initial_refresh"));
  }

  const metrics = createMetrics(() => outbox.depth());
  const server = createGatewayServer({
    config,
    store,
    outbox,
    billing: {
      outbox,
      pricing,
      pricingMode: config.pricingMode,
      markup: config.markup,
      metricCodes: DEFAULT_METRIC_CODES,
      costMetricCode: DEFAULT_COST_METRIC_CODE,
      onError,
    },
    budget: new AllowAllBudgetChecker(),
    metrics,
    logger,
  });

  server.listen(config.port, () => {
    logger.info("gateway listening", {
      port: config.port,
      bifrost: config.bifrostUrl,
      pricing_mode: config.pricingMode,
      backpressure_depth: config.backpressureDepth,
    });
  });

  const stop = async (): Promise<void> => {
    logger.info("shutting down");
    server.close();
    await outbox.shutdown(10_000);
    store.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop());
  process.on("SIGINT", () => void stop());
}
