/**
 * Capture real Ramp Router responses, scrubbing every capture as it is written.
 *
 * Router is an OpenAI-Responses-compatible gateway in front of OpenAI, Anthropic,
 * Google Vertex, Fireworks and xAI. Its docs describe the request surface but not the
 * billing-relevant response behaviour, so this script exists to MEASURE the seven
 * questions the adapter's mapping depends on rather than reason about them:
 *
 *   P1  GET /v1/models  — does the catalog publish per-model PRICING? If it does, price
 *                         mode reads Router's own authoritative rates and the opaque
 *                         model-id problem disappears.
 *   P2  buffered call   — does the Response's `model` report the requested alias or the
 *                         served `provider:provider-model[:service-tier]`?
 *   P3  models fallback — under a candidate list, does `model` name the SERVED candidate?
 *                         Billing the requested list is wrong.
 *   P4  stream: true    — do the SSE events carry usage and the resolved model where
 *                         `extractStreamUsage` already looks (`.response.usage`)?
 *   P5  prompt cache    — the money question. Does Router report PROVIDER-NATIVE token
 *                         semantics (Anthropic: cache_read ADDITIVE to input) or
 *                         OpenAI-normalized ones (cache_read INSIDE input)? `openai` is in
 *                         INPUT_INCLUDES_CACHE_READ and `anthropic` is not, so guessing
 *                         wrong misprices every cached call.
 *   P6  reasoning model — is `reasoning_tokens` inside `output_tokens`?
 *   P7  error families  — the envelope shape, and that a failure carries no usage.
 *
 * Raw `fetch`, not the OpenAI SDK, deliberately: this captures the wire JSON AND the
 * response headers, and no doc says whether Router signals service tier, cache state or
 * BYOK in a header. If it does, that is a billing signal we would otherwise never see.
 *
 * Reads RAMP_ROUTER_API_KEY from the environment and nothing else. Model ids are
 * account-specific ("Never invent one or reuse a provider's public model name"), so they
 * are DISCOVERED from P1 rather than hardcoded; override with RAMP_ROUTER_MODEL,
 * RAMP_ROUTER_ANTHROPIC_MODEL, RAMP_ROUTER_REASONING_MODEL if the heuristics pick badly.
 *
 * Run with: RAMP_ROUTER_API_KEY="..." npx tsx tests/unit/adapters/fixtures/capture_ramp_router.ts
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "ramp_router");
mkdirSync(OUT, { recursive: true });

const API_KEY = process.env.RAMP_ROUTER_API_KEY;
if (!API_KEY) {
  console.error("RAMP_ROUTER_API_KEY is not set. Put it in a gitignored .env and export it.");
  process.exit(1);
}
const BASE_URL = (process.env.RAMP_ROUTER_BASE_URL || "https://api.router.com/v1").replace(/\/+$/, "");

// Keep every probe to a few tokens. The whole run should cost cents, and the fixtures are
// read for their `usage` object, never for their prose.
const MAX_OUTPUT_TOKENS = 16;
const PROMPT = "Reply with exactly one word: pong.";

// ---------------------------------------------------------------------------
// Scrubbing. Runs on EVERY value before it reaches the tree, in the same step
// that writes it — there is no unscrubbed intermediate file to forget about.
//
// The bar is the one the Cloudflare fixtures and commit 6b3e720 set: remove
// credentials and anything account-identifying, keep opaque platform ids,
// timings, costs and token counts, because those are what the tests assert on.
// ---------------------------------------------------------------------------

/** Header names never written to a fixture, whatever their value. */
const DROP_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "set-cookie",
  "cookie",
  "proxy-authorization",
]);

const REDACTIONS: Array<[RegExp, string]> = [
  // Router's own key shape, plus the generic provider-key shapes, in case a key is ever
  // echoed back inside an error message or a request-context field.
  [/\bsk-[A-Za-z0-9_-]{10,}/g, "rr-test-key-REDACTED"],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{10,}=*/gi, "Bearer rr-test-key-REDACTED"],
  // Emails, except ones already in a reserved documentation domain (RFC 2606).
  [/\b[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "user@example.com"],
  // Dotted quads. RFC 5737 documentation address, matching 6b3e720's replacement.
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "203.0.113.10"],
  // Dashboard/console URLs carry account and key ids in the path.
  [/https:\/\/(?:app|dashboard|router)\.(?:router|ramp)\.com\/[^\s"']*/g, "https://app.router.com/REDACTED"],
];

/**
 * Redact one string.
 *
 * The live key is substituted by VALUE first, not only by pattern: a key whose shape the
 * patterns above do not anticipate would otherwise sail through. Pattern matching is the
 * backstop, not the primary defence.
 */
function scrubString(s: string): string {
  let out = s.split(API_KEY!).join("rr-test-key-REDACTED");
  for (const [pattern, replacement] of REDACTIONS) out = out.replace(pattern, replacement);
  return out;
}

/** Keys whose value is model-generated or caller-supplied CONTENT, blanked rather than published. */
const CONTENT_KEYS = new Set(["text", "input", "instructions", "output_text", "content", "refusal", "summary_text"]);

/**
 * Deep-scrub a captured payload.
 *
 * Content keys are blanked to "" rather than deleted, so the shape a test reads is the
 * shape Router really sent — `countResponsesToolCalls` walks `output[]` by item `type`,
 * and deleting entries would change what the fixture proves.
 */
function scrub(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    if (CONTENT_KEYS.has(key)) return "";
    return scrubString(value);
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, key));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (DROP_HEADERS.has(k.toLowerCase())) continue;
      out[k] = scrub(v, k);
    }
    return out;
  }
  return value;
}

// Provenance is derived, never asserted. A fixture captured against a mock or a staging
// host must not claim to be a real one — the whole point of the `NN_real_*` naming
// convention in this repo is that it means something.
const IS_PRODUCTION = new URL(BASE_URL).host === "api.router.com";
const PROVENANCE = IS_PRODUCTION
  ? "real capture against a live Ramp Router account"
  : `NOT a production capture — taken against ${new URL(BASE_URL).host}. Do not commit as NN_real_*.`;

/** Write one fixture. The only path that touches the tree, so the only scrub site needed. */
function save(name: string, probe: string, question: string, payload: unknown): void {
  const body = {
    _probe: probe,
    _question: question,
    _captured: PROVENANCE,
    _scrubbed: "credentials, emails, IPs, dashboard URLs; prompt and completion text blanked to \"\"",
    ...(scrub(payload) as Record<string, unknown>),
  };
  writeFileSync(join(OUT, name), JSON.stringify(body, null, 2) + "\n");
  console.log(`  wrote ${name}`);
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/** Response headers as a plain object, minus the ones DROP_HEADERS forbids. */
function headersOf(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    if (!DROP_HEADERS.has(k.toLowerCase())) out[k] = v;
  });
  return out;
}

interface Captured {
  _status: number;
  _headers: Record<string, string>;
  _body: unknown;
  _body_was_json: boolean;
}

/**
 * One request, captured whole.
 *
 * The body is parsed as JSON when it is JSON and kept as text when it is not. That is not
 * defensive padding: api.router.com sits behind Cloudflare bot management, and an
 * unrecognized client gets an HTML challenge page instead of Router's documented error
 * envelope. A capture script that assumed JSON would crash on exactly the case worth
 * recording.
 */
async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<Captured> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      "User-Agent": "lago-agent-sdk-capture/0.2.0",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed: unknown = text;
  let wasJson = false;
  try {
    parsed = JSON.parse(text);
    wasJson = true;
  } catch {
    /* left as text — see the docstring */
  }
  return { _status: res.status, _headers: headersOf(res), _body: parsed, _body_was_json: wasJson };
}

/** A streamed request, captured as the ordered list of SSE events. */
async function callStream(body: unknown): Promise<Captured & { _events: unknown[] }> {
  const res = await fetch(`${BASE_URL}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
      "User-Agent": "lago-agent-sdk-capture/0.2.0",
    },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  const events: unknown[] = [];
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      events.push(JSON.parse(payload));
    } catch {
      events.push({ _unparseable: payload });
    }
  }
  return { _status: res.status, _headers: headersOf(res), _body: null, _body_was_json: false, _events: events };
}

// ---------------------------------------------------------------------------
// Model discovery. Ids are account-specific, so nothing here is hardcoded.
// ---------------------------------------------------------------------------

interface ModelEntry {
  id: string;
  owned_by?: string;
  [k: string]: unknown;
}

function pickModel(models: ModelEntry[], vendorHints: string[], nameHints: string[]): string | null {
  const byVendor = models.filter((m) => vendorHints.some((h) => String(m.owned_by ?? "").toLowerCase().includes(h)));
  const pool = byVendor.length ? byVendor : models;
  for (const hint of nameHints) {
    const hit = pool.find((m) => m.id.toLowerCase().includes(hint));
    if (hit) return hit.id;
  }
  return pool[0]?.id ?? null;
}

async function main(): Promise<void> {
  // ---- P1: the catalog. Does it publish prices? -------------------------------------
  console.log("[P1] GET /v1/models");
  const p1 = await call("GET", "/models");
  save("01_real_models_catalog.json", "P1", "does GET /v1/models publish per-model pricing?", p1);

  const catalog: ModelEntry[] = Array.isArray((p1._body as { data?: unknown })?.data)
    ? ((p1._body as { data: ModelEntry[] }).data ?? [])
    : [];
  console.log(`  ${catalog.length} models visible to this key`);
  if (!catalog.length) {
    console.error("  no models — cannot run P2-P7. Check the key's catalog in the dashboard.");
    return;
  }

  // Report, loudly, whether P1 answered the pricing question. This is the single finding
  // that decides whether price mode reads Router's rates or OpenRouter's.
  const priceKeys = new Set<string>();
  for (const m of catalog) {
    for (const [k, v] of Object.entries(m)) {
      if (/(pric|cost|rate|per_m|per_million)/i.test(k)) priceKeys.add(k);
      if (v && typeof v === "object") {
        for (const nk of Object.keys(v as Record<string, unknown>)) {
          if (/(pric|cost|rate|per_m|per_million)/i.test(nk)) priceKeys.add(`${k}.${nk}`);
        }
      }
    }
  }
  console.log(
    priceKeys.size
      ? `  P1 ANSWER: catalog carries price-shaped fields: ${[...priceKeys].join(", ")}`
      : "  P1 ANSWER: no price-shaped field in the catalog — price mode must go through OpenRouter",
  );
  console.log(`  entry keys observed: ${[...new Set(catalog.flatMap((m) => Object.keys(m)))].join(", ")}`);

  const cheap = process.env.RAMP_ROUTER_MODEL ?? pickModel(catalog, ["openai"], ["nano", "mini", "4o-mini"]);
  const anthropic = process.env.RAMP_ROUTER_ANTHROPIC_MODEL ?? pickModel(catalog, ["anthropic"], ["haiku", "sonnet"]);
  const reasoning = process.env.RAMP_ROUTER_REASONING_MODEL ?? pickModel(catalog, ["openai"], ["o3", "gpt-5", "mini"]);
  console.log(`  using: cheap=${cheap} anthropic=${anthropic} reasoning=${reasoning}`);

  // ---- P2: requested alias, or served candidate? ------------------------------------
  if (cheap) {
    console.log("[P2] buffered call, plain `model`");
    const p2 = await call("POST", "/responses", {
      model: cheap,
      input: PROMPT,
      max_output_tokens: MAX_OUTPUT_TOKENS,
      metadata: { lago_subscription: "rr_gateway_test_sub" },
    });
    save("02_real_buffered_plain_model.json", "P2", "does response.model echo the requested id or the served candidate?", {
      _requested_model: cheap,
      ...p2,
    });
    console.log(`  P2 ANSWER: requested "${cheap}" -> response.model "${(p2._body as { model?: string })?.model}"`);
  }

  // ---- P3: which candidate answered? ------------------------------------------------
  if (cheap && anthropic && cheap !== anthropic) {
    console.log("[P3] models fallback list");
    // A deliberately unroutable first candidate would 404 the whole request rather than
    // fall back (the docs are explicit: "Invalid requests and unauthorized models fail
    // immediately without touching the rest of the list"), so both candidates are real
    // and the question is only which one Router names in the response.
    const p3 = await call("POST", "/responses", {
      models: [cheap, anthropic],
      input: PROMPT,
      max_output_tokens: MAX_OUTPUT_TOKENS,
    });
    save("03_real_models_fallback.json", "P3", "under a candidate list, does response.model name the served candidate?", {
      _requested_models: [cheap, anthropic],
      ...p3,
    });
    console.log(`  P3 ANSWER: candidates [${cheap}, ${anthropic}] -> response.model "${(p3._body as { model?: string })?.model}"`);
  }

  // ---- P4: streaming ----------------------------------------------------------------
  if (cheap) {
    console.log("[P4] stream: true");
    const p4 = await callStream({ model: cheap, input: PROMPT, max_output_tokens: MAX_OUTPUT_TOKENS, stream: true });
    save("04_real_streamed.json", "P4", "do SSE events carry usage and the resolved model under .response?", p4);
    const withUsage = p4._events.filter(
      (e) => (e as { response?: { usage?: unknown } })?.response?.usage || (e as { usage?: unknown })?.usage,
    );
    console.log(`  P4 ANSWER: ${p4._events.length} events, ${withUsage.length} carrying usage`);
  }

  // ---- P5: the money question -------------------------------------------------------
  if (anthropic) {
    console.log("[P5] prompt cache on an Anthropic-served model (two calls)");
    // Long enough to clear the providers' minimum cacheable prefix (1024 tokens on both
    // OpenAI and Anthropic), and stable across the two calls so the second can hit.
    const filler = "You are a careful billing assistant. Answer in one word. ".repeat(120);
    const cacheBody = {
      model: anthropic,
      instructions: filler,
      input: PROMPT,
      max_output_tokens: MAX_OUTPUT_TOKENS,
      prompt_cache_key: "lago-capture-p5",
    };
    const write = await call("POST", "/responses", cacheBody);
    save("05_real_cache_write.json", "P5", "first call — does it report cache_write/creation tokens?", write);
    // Providers need a moment before the prefix is warm.
    await new Promise((r) => setTimeout(r, 3000));
    const read = await call("POST", "/responses", cacheBody);
    save("06_real_cache_read.json", "P5", "second call — is cache_read INSIDE input_tokens or additive to it?", read);
    const u = (read._body as { usage?: Record<string, unknown> })?.usage ?? {};
    console.log(`  P5 ANSWER: usage on the warm call = ${JSON.stringify(u)}`);
    console.log("  Compare input_tokens against the cold call's: unchanged => cache_read is INSIDE input");
    console.log("  (OpenAI semantics); dropped by the cached amount => ADDITIVE (Anthropic semantics).");
  }

  // ---- P6: reasoning ----------------------------------------------------------------
  if (reasoning) {
    console.log("[P6] reasoning model");
    const p6 = await call("POST", "/responses", {
      model: reasoning,
      input: "What is 17 * 23? Answer with the number only.",
      max_output_tokens: 256,
      reasoning: { effort: "low" },
    });
    save("07_real_reasoning.json", "P6", "is reasoning_tokens inside output_tokens?", p6);
    console.log(`  P6 ANSWER: usage = ${JSON.stringify((p6._body as { usage?: unknown })?.usage)}`);
  }

  // ---- P7: error families -----------------------------------------------------------
  console.log("[P7] error families");
  const errors: Array<[string, string, unknown]> = [
    ["08_real_error_404_model_not_found.json", "an id not in this key's catalog", { model: "definitely-not-a-model-id", input: PROMPT, max_output_tokens: MAX_OUTPUT_TOKENS }],
    ["09_real_error_400_both_selectors.json", "both route selectors at once", { model: cheap, models: [cheap], input: PROMPT, max_output_tokens: MAX_OUTPUT_TOKENS }],
    ["10_real_error_400_no_selector.json", "neither route selector", { input: PROMPT, max_output_tokens: MAX_OUTPUT_TOKENS }],
  ];
  for (const [name, what, body] of errors) {
    const captured = await call("POST", "/responses", body);
    save(name, "P7", `error envelope for: ${what}`, captured);
    console.log(`  ${name}: HTTP ${captured._status} json=${captured._body_was_json}`);
  }

  console.log("\nDone. Inspect tests/unit/adapters/fixtures/ramp_router/*.json");
  console.log("Then grep the directory for the key value, Bearer, non-example emails and routable IPs before committing.");
}

main().catch((err: unknown) => {
  // Deliberately not dumping the error object whole: a fetch failure can carry the
  // request — headers included — and this script holds a live credential.
  console.error(`capture failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
