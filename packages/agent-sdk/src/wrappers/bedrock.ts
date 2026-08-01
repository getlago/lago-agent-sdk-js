/**
 * AWS SDK v3 BedrockRuntimeClient wrapper.
 *
 * Wraps `client.send(command)` in place. Dispatches by command constructor name:
 *   - ConverseCommand                       — non-streaming Converse
 *   - ConverseStreamCommand                 — streaming Converse (stream field)
 *   - InvokeModelCommand                    — non-streaming InvokeModel (body is Uint8Array)
 *   - InvokeModelWithResponseStreamCommand  — streaming InvokeModel (body iter of chunks)
 *
 * Per-call override: attach `__lago` to a command before sending:
 *   const cmd = new ConverseCommand({...});
 *   (cmd as any).__lago = { subscription: "sub_x", dimensions: { feature: "x" } };
 */
import { extractBedrockConverse, extractBedrockInvoke } from "../adapters/index.js";
import type { CanonicalUsage } from "../canonical.js";

const INSTRUMENTED = Symbol.for("lago_instrumented");
const LAGO_KEY = "__lago";

interface LagoOpts {
  subscription?: string;
  dimensions?: Record<string, unknown>;
  mode?: "tokens" | "price";
  markup?: number;
}

interface EmitOpts {
  subscription?: string;
  dimensions?: Record<string, unknown>;
  mode?: "tokens" | "price";
  markup?: number;
}

interface SDKLike {
  emit: (usage: CanonicalUsage, opts?: EmitOpts) => void;
}

interface CommandLike {
  constructor: { name: string };
  input?: { modelId?: string; [k: string]: unknown };
  [LAGO_KEY]?: LagoOpts;
}

function decodeJSON(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8").decode(bytes));
  } catch {
    return {};
  }
}

export interface WrapBedrockOptions {
  dimensions?: Record<string, unknown>;
  subscription?: string;
}

export function wrapBedrockClient(
  sdk: SDKLike,
  client: { send: (cmd: CommandLike, ...rest: unknown[]) => unknown },
  opts: WrapBedrockOptions = {},
): typeof client {
  const c = client as unknown as Record<symbol | string, unknown>;
  if (c[INSTRUMENTED]) return client;

  const baseDims = { ...(opts.dimensions || {}) };
  const baseSub = opts.subscription;
  const originalSend = client.send.bind(client);

  const send = async (command: CommandLike, ...rest: unknown[]) => {
    const lagoOpts: LagoOpts = command[LAGO_KEY] || {};
    if (LAGO_KEY in command) delete command[LAGO_KEY];

    const cmdName = command.constructor.name;
    const modelId = String(command.input?.modelId ?? "");
    const emitOpts: EmitOpts = {
      subscription: lagoOpts.subscription || baseSub,
      dimensions: { ...baseDims, ...(lagoOpts.dimensions || {}) },
      mode: lagoOpts.mode,
      markup: lagoOpts.markup,
    };

    const response = (await originalSend(command, ...rest)) as Record<string, unknown>;

    try {
      switch (cmdName) {
        case "ConverseCommand": {
          const usage = extractBedrockConverse(response, modelId);
          sdk.emit(usage, emitOpts);
          return response;
        }
        case "ConverseStreamCommand": {
          const stream = response.stream as AsyncIterable<unknown> | undefined;
          if (stream) {
            response.stream = wrapConverseStream(stream, sdk, modelId, emitOpts);
          }
          return response;
        }
        case "InvokeModelCommand": {
          const body = response.body;
          if (body instanceof Uint8Array) {
            const parsed = decodeJSON(body);
            const usage = extractBedrockInvoke(parsed, modelId);
            sdk.emit(usage, emitOpts);
            // Body is bytes already — no re-streaming needed for non-streaming InvokeModel.
          }
          return response;
        }
        case "InvokeModelWithResponseStreamCommand": {
          const body = response.body as AsyncIterable<unknown> | undefined;
          if (body) {
            response.body = wrapInvokeStream(body, sdk, modelId, emitOpts);
          }
          return response;
        }
        default:
          // Unknown command — let it through, no instrumentation.
          return response;
      }
    } catch (err) {
      // Instrumentation must never break the customer's call.
      if (typeof console !== "undefined" && console.warn) {
        console.warn("[lago] bedrock instrumentation failed:", (err as Error).message);
      }
      return response;
    }
  };

  client.send = send as unknown as typeof client.send;
  c[INSTRUMENTED] = true;
  return client;
}

// ---------- ConverseStream ----------
async function* wrapConverseStream(
  source: AsyncIterable<unknown>,
  sdk: SDKLike,
  modelId: string,
  emitOpts: EmitOpts,
): AsyncIterable<unknown> {
  let captured: { usage: Record<string, unknown> } | null = null;
  try {
    for await (const event of source) {
      const ev = event as Record<string, unknown>;
      if (ev && typeof ev === "object" && "metadata" in ev) {
        const meta = ev.metadata as Record<string, unknown>;
        if (meta && typeof meta === "object" && meta.usage) {
          captured = { usage: meta.usage as Record<string, unknown> };
        }
      }
      yield event;
    }
  } finally {
    if (captured) {
      try {
        const usage = extractBedrockConverse(captured, modelId);
        sdk.emit(usage, emitOpts);
      } catch {
        /* swallow */
      }
    }
  }
}

// ---------- InvokeModelWithResponseStream ----------
async function* wrapInvokeStream(
  source: AsyncIterable<unknown>,
  sdk: SDKLike,
  modelId: string,
  emitOpts: EmitOpts,
): AsyncIterable<unknown> {
  let usagePayload: Record<string, unknown> = {};
  let bedrockMetrics: Record<string, unknown> = {};
  try {
    for await (const event of source) {
      const ev = event as Record<string, unknown>;
      const chunk = ev?.chunk as Record<string, unknown> | undefined;
      const bytes = chunk?.bytes as Uint8Array | undefined;
      if (bytes) {
        try {
          const parsed = JSON.parse(new TextDecoder("utf-8").decode(bytes)) as Record<string, unknown>;
          if (parsed && typeof parsed === "object") {
            if (parsed.usage && typeof parsed.usage === "object") {
              usagePayload = { ...usagePayload, ...(parsed.usage as Record<string, unknown>) };
            }
            const metrics = parsed["amazon-bedrock-invocationMetrics"];
            if (metrics && typeof metrics === "object") {
              bedrockMetrics = metrics as Record<string, unknown>;
            }
          }
        } catch {
          /* not JSON */
        }
      }
      yield event;
    }
  } finally {
    try {
      let synthetic: Record<string, unknown> | null = null;
      if (Object.keys(usagePayload).length > 0) {
        synthetic = { usage: usagePayload };
      } else if (Object.keys(bedrockMetrics).length > 0) {
        synthetic = {
          usage: {
            prompt_tokens: bedrockMetrics.inputTokenCount ?? 0,
            completion_tokens: bedrockMetrics.outputTokenCount ?? 0,
          },
        };
      }
      if (synthetic) {
        const usage = extractBedrockInvoke(synthetic, modelId);
        sdk.emit(usage, emitOpts);
      }
    } catch {
      /* swallow */
    }
  }
}
