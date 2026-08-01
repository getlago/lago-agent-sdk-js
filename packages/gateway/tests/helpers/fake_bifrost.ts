/** Fake Bifrost: emits the exact response shapes the ADR-001 spike captured
 * (extra_fields.provider / raw_response; per-chunk raw_response strings on
 * streams; synthesized final chunk carrying normalized usage, no raw).
 * Failure modes switchable per test. Also records request headers so BYOK
 * direct-key forwarding can be asserted. */
import http from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeBifrost {
  url: string;
  requests: Array<{ headers: http.IncomingHttpHeaders; body: Record<string, unknown> }>;
  setMode: (mode: BifrostMode) => void;
  close: () => Promise<void>;
}

export type BifrostMode = "ok" | "http_500" | "http_429" | "malformed_sse" | "truncated_sse" | "slow_stream";

const OPENAI_RAW_USAGE = {
  prompt_tokens: 120,
  completion_tokens: 45,
  total_tokens: 165,
  prompt_tokens_details: { cached_tokens: 80 },
  completion_tokens_details: { reasoning_tokens: 17 },
};

const ANTHROPIC_START_USAGE = {
  input_tokens: 10,
  output_tokens: 1,
  cache_creation_input_tokens: 44,
  cache_read_input_tokens: 200,
  cache_creation: { ephemeral_5m_input_tokens: 33, ephemeral_1h_input_tokens: 11 },
};

function providerOf(model: string): string {
  const i = model.indexOf("/");
  return i === -1 ? "openai" : model.slice(0, i);
}

function bareModel(model: string): string {
  const i = model.indexOf("/");
  return i === -1 ? model : model.slice(i + 1);
}

export async function startFakeBifrost(): Promise<FakeBifrost> {
  let mode: BifrostMode = "ok";
  const requests: FakeBifrost["requests"] = [];

  const server = http.createServer((req, res) => {
    let text = "";
    req.on("data", (c) => (text += c));
    req.on("end", async () => {
      const body = JSON.parse(text || "{}") as Record<string, unknown>;
      requests.push({ headers: req.headers, body });
      const model = String(body.model ?? "openai/gpt-4o");
      const provider = providerOf(model);
      const bare = bareModel(model);

      if (mode === "http_500" || mode === "http_429") {
        const status = mode === "http_500" ? 500 : 429;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            is_bifrost_error: false,
            status_code: status,
            error: { type: "provider_error", message: `induced ${status}` },
            extra_fields: { provider },
          }),
        );
        return;
      }

      if (body.stream === true) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (mode === "malformed_sse") {
          res.write("data: {this is not json\n\n");
          res.write("data: neither is this\n\n");
          res.end();
          return;
        }
        const chunks = provider === "anthropic" ? anthropicChunks(bare) : openaiChunks(bare);
        if (mode === "truncated_sse") {
          // Connection dies before any usage frame arrives.
          res.write(chunks[0]);
          res.destroy();
          return;
        }
        for (const c of chunks) {
          res.write(c);
          if (mode === "slow_stream") await new Promise((r) => setTimeout(r, 120));
        }
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }

      // Non-streaming.
      const raw =
        provider === "anthropic"
          ? {
              id: "msg_fake",
              type: "message",
              role: "assistant",
              model: bare,
              content: [{ type: "text", text: "Hello world" }],
              usage: { ...ANTHROPIC_START_USAGE, output_tokens: 45 },
            }
          : {
              id: "chatcmpl-fake",
              object: "chat.completion",
              model: bare,
              choices: [
                { index: 0, message: { role: "assistant", content: "Hello world" }, finish_reason: "stop" },
              ],
              usage: OPENAI_RAW_USAGE,
            };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-fake",
          model: bare,
          object: "chat.completion",
          choices: [
            { index: 0, message: { role: "assistant", content: "Hello world" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 254, completion_tokens: 45, total_tokens: 299 },
          extra_fields: { provider, request_type: "chat_completion", raw_response: raw },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setMode: (m) => (mode = m),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function openaiChunks(model: string): string[] {
  const base = { id: "chatcmpl-fake", object: "chat.completion.chunk", model };
  const rawOf = (o: unknown): string => JSON.stringify(o);
  const c1 = { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Hello" } }] };
  const c2 = { ...base, choices: [{ index: 0, delta: { content: " world" } }] };
  const cUsage = { ...base, choices: [], usage: OPENAI_RAW_USAGE };
  return [
    `data: ${JSON.stringify({ ...c1, usage: null, extra_fields: { provider: "openai", chunk_index: 0, raw_response: rawOf(c1) } })}\n\n`,
    `data: ${JSON.stringify({ ...c2, usage: null, extra_fields: { provider: "openai", chunk_index: 1, raw_response: rawOf(c2) } })}\n\n`,
    // Final chunk: synthesized by Bifrost, normalized usage, NO raw_response.
    `data: ${JSON.stringify({
      ...base,
      choices: [{ index: 0, finish_reason: "stop", delta: {} }],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 45,
        prompt_tokens_details: { cached_read_tokens: 80, cached_tokens: 80 },
        completion_tokens_details: { reasoning_tokens: 17 },
      },
      extra_fields: { provider: "openai", chunk_index: 2 },
    })}\n\n`,
  ];
}

function anthropicChunks(model: string): string[] {
  const base = { id: "msg_fake", object: "chat.completion.chunk", model: "" };
  const start = { type: "message_start", message: { id: "msg_fake", model, usage: ANTHROPIC_START_USAGE } };
  const delta = { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello world" } };
  const msgDelta = {
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 45 },
  };
  return [
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant" } }], usage: null, extra_fields: { provider: "anthropic", chunk_index: 0, raw_response: JSON.stringify(start) } })}\n\n`,
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: "Hello world" } }], usage: null, extra_fields: { provider: "anthropic", chunk_index: 1, raw_response: JSON.stringify(delta) } })}\n\n`,
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {} }], usage: null, extra_fields: { provider: "anthropic", chunk_index: 2, raw_response: JSON.stringify(msgDelta) } })}\n\n`,
    // Synthesized final chunk with normalized usage incl. TTL split, no raw.
    `data: ${JSON.stringify({
      ...base,
      model,
      choices: [{ index: 0, finish_reason: "stop", delta: {} }],
      usage: {
        prompt_tokens: 254,
        completion_tokens: 45,
        prompt_tokens_details: {
          cached_read_tokens: 200,
          cached_write_tokens: 44,
          cached_write_token_details: { cached_write_tokens_5m: 33, cached_write_tokens_1h: 11 },
          cached_tokens: 200,
        },
      },
      extra_fields: { provider: "anthropic", chunk_index: 3 },
    })}\n\n`,
  ];
}
