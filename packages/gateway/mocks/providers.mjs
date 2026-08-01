#!/usr/bin/env node
/** Mock LLM providers for the integration harness and demo.
 *
 * One process, three surfaces:
 *   POST /openai/v1/chat/completions      OpenAI wire shape, stream + non-stream
 *   POST /anthropic/v1/messages           Anthropic wire shape, stream + non-stream
 *   GET  /pricing/openrouter              OpenRouter-format price table
 *
 * Failure modes are triggered by model name so they survive translation:
 *   *-flaky-429      first attempt per process returns 429, then succeeds
 *   *-always-500     always 500
 *   *-malformed      streams garbage SSE
 *
 * Usage numbers are fixed and documented so tests can hand-recompute costs.
 */
import http from "node:http";

const PORT = process.env.PORT ? Number(process.env.PORT) : 8081;

export const OPENAI_USAGE = {
  prompt_tokens: 120,
  completion_tokens: 45,
  total_tokens: 165,
  prompt_tokens_details: { cached_tokens: 80, audio_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 17, audio_tokens: 0 },
};

export const ANTHROPIC_USAGE = {
  input_tokens: 10,
  output_tokens: 45,
  cache_creation_input_tokens: 44,
  cache_read_input_tokens: 200,
  cache_creation: { ephemeral_5m_input_tokens: 33, ephemeral_1h_input_tokens: 11 },
};

export const PRICE_TABLE = {
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

const flakyHits = new Map();

function sse(res, blocks) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  for (const b of blocks) res.write(b);
  res.end();
}

function failureFor(model, res) {
  if (model.endsWith("-always-500")) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "mock induced 500", type: "server_error" } }));
    return true;
  }
  if (model.endsWith("-flaky-429")) {
    const hits = (flakyHits.get(model) ?? 0) + 1;
    flakyHits.set(model, hits);
    if (hits === 1) {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
      res.end(JSON.stringify({ error: { message: "mock rate limited", type: "rate_limit_error" } }));
      return true;
    }
  }
  return false;
}

function handleOpenAI(body, res) {
  const model = body.model ?? "gpt-4o";
  if (failureFor(model, res)) return;
  const id = "chatcmpl-mock-" + Math.random().toString(36).slice(2, 10);
  if (body.stream) {
    if (model.endsWith("-malformed")) {
      sse(res, ["data: {broken json\n\n", "data: still broken\n\n"]);
      return;
    }
    const base = { id, object: "chat.completion.chunk", created: 1722400000, model };
    sse(res, [
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { content: " from mock openai" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      `data: ${JSON.stringify({ ...base, choices: [], usage: OPENAI_USAGE })}\n\n`,
      "data: [DONE]\n\n",
    ]);
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id,
      object: "chat.completion",
      created: 1722400000,
      model,
      choices: [
        { index: 0, message: { role: "assistant", content: "Hello from mock openai" }, finish_reason: "stop" },
      ],
      usage: OPENAI_USAGE,
    }),
  );
}

function handleAnthropic(body, res) {
  const model = body.model ?? "claude-sonnet-4";
  if (failureFor(model, res)) return;
  const id = "msg_mock_" + Math.random().toString(36).slice(2, 10);
  if (body.stream) {
    if (model.endsWith("-malformed")) {
      sse(res, ["event: message_start\ndata: {broken\n\n"]);
      return;
    }
    const ev = (name, obj) => `event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`;
    sse(res, [
      ev("message_start", {
        type: "message_start",
        message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, usage: ANTHROPIC_USAGE },
      }),
      ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      ev("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello from mock anthropic" },
      }),
      ev("content_block_stop", { type: "content_block_stop", index: 0 }),
      ev("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 45 } }),
      ev("message_stop", { type: "message_stop" }),
    ]);
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(
    JSON.stringify({
      id,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: "Hello from mock anthropic" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { ...ANTHROPIC_USAGE, output_tokens: 45 },
    }),
  );
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/pricing/openrouter") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(PRICE_TABLE));
    return;
  }
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200).end("ok");
    return;
  }
  let text = "";
  req.on("data", (c) => (text += c));
  req.on("end", () => {
    let body;
    try {
      body = JSON.parse(text || "{}");
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (req.url?.includes("/openai/") && req.url.includes("/chat/completions")) {
      handleOpenAI(body, res);
    } else if (req.url?.includes("/anthropic/") && req.url.includes("/messages")) {
      handleAnthropic(body, res);
    } else {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `no mock for ${req.url}` } }));
    }
  });
});

server.listen(PORT, () => console.log(`mock-providers listening on :${PORT}`));
