/** Boot a real gateway server against a fake Bifrost and a mock Lago,
 * fully wired, on ephemeral ports. Shared by the server tests and the WP4/5
 * suites. */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type http from "node:http";
import type { AddressInfo } from "node:net";

import {
  DEFAULT_COST_METRIC_CODE,
  DEFAULT_METRIC_CODES,
  LagoClient,
  parseOpenRouter,
  PricingProvider,
} from "@getlago/agent-sdk/core";

import type { GatewayConfig } from "../../src/config.js";
import { KeyStore } from "../../src/store.js";
import { DurableEventQueue } from "../../src/outbox.js";
import { AllowAllBudgetChecker, type BudgetChecker } from "../../src/budget.js";
import { createMetrics, type Metrics } from "../../src/metrics.js";
import { createLogger, type Logger } from "../../src/logger.js";
import { createGatewayServer } from "../../src/server.js";
import { startFakeBifrost, type FakeBifrost } from "./fake_bifrost.js";
import { startMockLago, type MockLago } from "./mock_lago.js";

export interface TestGateway {
  url: string;
  bifrost: FakeBifrost;
  lago: MockLago;
  store: KeyStore;
  outbox: DurableEventQueue;
  metrics: Metrics;
  config: GatewayConfig;
  logLines: string[];
  adminToken: string;
  close: () => Promise<void>;
}

export const TEST_PRICE_TABLE = {
  data: [
    {
      id: "openai/gpt-4o",
      pricing: { prompt: "0.0000025", completion: "0.00001", input_cache_read: "0.00000125" },
    },
    {
      id: "anthropic/claude-sonnet-4",
      pricing: {
        prompt: "0.000003",
        completion: "0.000015",
        input_cache_read: "0.0000003",
        input_cache_write: "0.00000375",
      },
    },
  ],
};

export async function startTestGateway(
  opts: {
    pricingMode?: "price" | "tokens";
    markup?: number;
    backpressureDepth?: number;
    budget?: BudgetChecker;
  } = {},
): Promise<TestGateway> {
  const dir = mkdtempSync(join(tmpdir(), "gw-"));
  const bifrost = await startFakeBifrost();
  const lago = await startMockLago();
  const adminToken = "admin-test-token-0123456789";
  const masterKey = randomBytes(32);

  const config: GatewayConfig = {
    port: 0,
    bifrostUrl: bifrost.url,
    lagoApiUrl: lago.url,
    lagoApiKey: "test-lago-key",
    adminToken,
    masterKey,
    dataDir: dir,
    pricingMode: opts.pricingMode ?? "price",
    markup: opts.markup ?? 1.0,
    backpressureDepth: opts.backpressureDepth ?? 1000,
    outboxHardDepth: (opts.backpressureDepth ?? 1000) + 100,
    pricingTtlMs: 3_600_000,
    budgetTtlMs: 100,
    upstreamTimeoutMs: 10_000,
  };

  const logLines: string[] = [];
  const logger: Logger = createLogger({
    write: (line: string) => {
      logLines.push(String(line));
      return true;
    },
  } as unknown as NodeJS.WritableStream);

  const onError = (err: unknown, where: string): void => {
    logger.error("billing error", { where, error: String(err) });
  };
  const store = new KeyStore(join(dir, "keys.db"), masterKey);
  const lagoClient = new LagoClient(config.lagoApiKey, config.lagoApiUrl, 2000);
  const outbox = new DurableEventQueue({
    path: join(dir, "outbox.db"),
    sender: (b) => lagoClient.sendBatch(b),
    maxDepth: config.outboxHardDepth,
    flushIntervalMs: 20,
    onError,
  });
  const pricing = new PricingProvider({
    fetcher: {
      fetchOpenRouter: async () => parseOpenRouter(TEST_PRICE_TABLE),
      fetchBedrock: async () => new Map(),
    },
    onError,
  });
  pricing.prime();
  await pricing.maybeRefresh();

  const metrics = createMetrics(() => outbox.depth());
  const server: http.Server = createGatewayServer({
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
    budget: opts.budget ?? new AllowAllBudgetChecker(),
    metrics,
    logger,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    bifrost,
    lago,
    store,
    outbox,
    metrics,
    config,
    logLines,
    adminToken,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
      await outbox.shutdown(3000);
      store.close();
      await bifrost.close();
      await lago.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
