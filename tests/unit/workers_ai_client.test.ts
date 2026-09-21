/** WorkersAI client tests — stubbed fetch, no live API. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { LagoSDK, WorkersAIError } from "../../src/index.js";
import type { LagoEvent } from "../../src/lago_client.js";

const ACCT = "acct_test";
const GW = "gw_test";
const LLAMA = "@cf/meta/llama-3.2-3b-instruct";
// `@cf/...` ids take the gateway host's path route (cache + log headers, model logged);
// partner ids take the unified `/ai/run` path with `cf-aig-gateway-id`, the only route
// where the gateway's BYOK key is consulted. See the workers_ai module comment.
const DIRECT_RUN = `https://api.cloudflare.com/client/v4/accounts/${ACCT}/ai/run`;
const DIRECT_LLAMA = `${DIRECT_RUN}/${LLAMA}`;
const GATEWAY_BASE = `https://gateway.ai.cloudflare.com/v1/${ACCT}/${GW}/workers-ai`;
const GATEWAY_LLAMA = `${GATEWAY_BASE}/${LLAMA}`;

const CHAT_BODY = {
  result: {
    response: "Hello there!",
    model: "@cf/meta/llama-3.2-3b-instruct-v2",
    usage: { prompt_tokens: 41, completion_tokens: 34, total_tokens: 75, neurons: 1.22 },
  },
  success: true,
  errors: [],
  messages: [],
};
const JEV_INPUT = { state: "charged twice", questions: { is_urgent: { type: "noul", instructions: "?" } } };
const JEV_BODY = {
  // the partner-model envelope: the model's object one level down (fixture 05)
  result: {
    state: "Completed",
    result: {
      model: "jev-1.13.0",
      answers: { is_urgent: { type: "noul", noul: 0.97 } },
      usage: { input_tokens: 446, output_tokens: 73 },
    },
    gatewayMetadata: { keySource: "BYOK" },
  },
  success: true,
  errors: [],
  messages: [],
};
const JEV_402 = {
  errors: [{ message: "Insufficient balance; add money to your gateway or use BYOK", code: 2021 }],
  success: false,
  result: {},
  messages: [],
};

interface Call {
  url: string;
  headers: Record<string, string>;
  body: any;
}

function stubFetch(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
  raw?: string,
): { calls: Call[] } {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const h = Object.fromEntries(Object.entries((init.headers as Record<string, string>) ?? {}));
    calls.push({ url, headers: h, body: init.body ? JSON.parse(String(init.body)) : undefined });
    return new Response(raw ?? JSON.stringify(body), { status, headers });
  });
  return { calls };
}

function newSdk(defaultSub: string | null = "sub_test") {
  const received: LagoEvent[] = [];
  const errors: string[] = [];
  const sdk = new LagoSDK({
    apiKey: "x",
    defaultSubscriptionId: defaultSub,
    config: { onError: (e: unknown, where: string) => errors.push(`${where}: ${String(e)}`) },
  });
  sdk._setSender(async (b) => {
    received.push(...b);
  });
  return { sdk, received, errors };
}

function byCode(received: LagoEvent[]): Record<string, number> {
  return Object.fromEntries(received.map((e) => [e.code, parseInt(String(e.properties.value), 10)]));
}

afterEach(() => vi.unstubAllGlobals());

describe("WorkersAI client — catalog models (gateway host path route)", () => {
  it("bills tokens with model, provider, api and cf_log_id", async () => {
    const { sdk, received, errors } = newSdk();
    stubFetch(200, CHAT_BODY, { "cf-aig-cache-status": "MISS", "cf-aig-log-id": "01LOG" });
    const ai = sdk.workersAI(ACCT, "tok", { gatewayId: GW, gatewayAuth: "gwtok" });
    const out = (await ai.run(LLAMA, { messages: [{ role: "user", content: "hi" }] })) as any;
    expect(out.result.response).toBe("Hello there!"); // envelope returned unchanged
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(errors).toEqual([]);
    expect(byCode(received)).toEqual({ llm_input_tokens: 41, llm_output_tokens: 34 });
    const props = received[0].properties;
    expect(props.model).toBe(LLAMA); // requested id = catalog key; served "-v2" name stays in extras
    expect(props.provider).toBe("workers-ai");
    expect(props.api).toBe("workers_ai_run");
    expect(props.cf_log_id).toBe("01LOG");
    expect(received[0].external_subscription_id).toBe("sub_test");
  });

  it("takes the gateway host with gateway auth, body is the input", async () => {
    const { sdk } = newSdk("sub_acme");
    const { calls } = stubFetch(200, CHAT_BODY);
    const ai = sdk.workersAI(ACCT, "tok", { gatewayId: GW, gatewayAuth: "gwtok" });
    expect(ai.urlFor(LLAMA)).toBe(GATEWAY_LLAMA);
    await ai.run(LLAMA, { messages: [] }, { extraHeaders: { "cf-aig-cache-ttl": "300" } });
    await sdk.shutdown(1000);
    expect(calls[0].url).toBe(GATEWAY_LLAMA);
    expect(calls[0].body).toEqual({ messages: [] });
    expect(calls[0].headers.Authorization).toBe("Bearer tok");
    expect(calls[0].headers["cf-aig-authorization"]).toBe("Bearer gwtok");
    expect(calls[0].headers["cf-aig-cache-ttl"]).toBe("300");
    expect("cf-aig-gateway-id" in calls[0].headers).toBe(false);
    expect("cf-aig-skip-cache" in calls[0].headers).toBe(false);
    // The resolved subscription rides along, so the Logs API backfill attributes the same way.
    expect(JSON.parse(calls[0].headers["cf-aig-metadata"])).toEqual({ lago_subscription: "sub_acme" });
  });

  it("direct route when no gateway sets no gateway headers", async () => {
    const { sdk, received } = newSdk();
    const { calls } = stubFetch(200, CHAT_BODY);
    const ai = sdk.workersAI(ACCT, "tok");
    expect(ai.urlFor(LLAMA)).toBe(DIRECT_LLAMA);
    expect(ai.urlFor("typesafe/jev")).toBe(DIRECT_RUN);
    await ai.run(LLAMA, { messages: [] });
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(calls[0].url).toBe(DIRECT_LLAMA);
    for (const h of ["cf-aig-authorization", "cf-aig-gateway-id", "cf-aig-skip-cache", "cf-aig-metadata"]) {
      expect(h in calls[0].headers).toBe(false); // nothing stores or reads these without a gateway
    }
    expect(byCode(received)).toEqual({ llm_input_tokens: 41, llm_output_tokens: 34 });
    expect("cf_log_id" in received[0].properties).toBe(false);
  });

  it("a gateway cache HIT is not billed", async () => {
    // The gateway replays the identical body, usage included (fixtures 06/07). Only the
    // header says the model never ran — so only the header can stop the bill.
    const { sdk, received, errors } = newSdk();
    stubFetch(200, CHAT_BODY, { "cf-aig-cache-status": "HIT", "cf-aig-log-id": "01HIT" });
    const ai = sdk.workersAI(ACCT, "tok", { gatewayId: GW, gatewayAuth: "gwtok" });
    const out = (await ai.run(LLAMA, { messages: [] })) as any;
    expect(out.result.usage.prompt_tokens).toBe(41); // the caller still gets the body
    await sdk.shutdown(1000);
    expect(received).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe("WorkersAI client — partner models (unified path through the BYOK gateway)", () => {
  it("model in the body, gateway named in a header, cache skipped, nested usage bills", async () => {
    const { sdk, received, errors } = newSdk("sub_acme");
    const { calls } = stubFetch(200, JEV_BODY);
    const ai = sdk.workersAI(ACCT, "tok", { gatewayId: GW, gatewayAuth: "gwtok" });
    expect(ai.urlFor("typesafe/jev")).toBe(DIRECT_RUN);
    const out = (await ai.run("typesafe/jev", JEV_INPUT)) as any;
    expect(out.result.result.answers.is_urgent.noul).toBe(0.97);
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(calls[0].url).toBe(DIRECT_RUN);
    expect(calls[0].body).toEqual({ model: "typesafe/jev", input: JEV_INPUT });
    expect(calls[0].headers.Authorization).toBe("Bearer tok");
    expect(calls[0].headers["cf-aig-gateway-id"]).toBe(GW);
    expect(calls[0].headers["cf-aig-skip-cache"]).toBe("true");
    expect("cf-aig-authorization" in calls[0].headers).toBe(false); // gateway auth belongs to the gateway host only
    expect(JSON.parse(calls[0].headers["cf-aig-metadata"])).toEqual({ lago_subscription: "sub_acme" });
    expect(errors).toEqual([]);
    expect(byCode(received)).toEqual({ llm_input_tokens: 446, llm_output_tokens: 73 });
    expect(received[0].properties.model).toBe("typesafe/jev");
    expect(received[0].properties.provider).toBe("workers-ai");
    expect("cf_log_id" in received[0].properties).toBe(false); // the unified path returns no log id
  });

  it("extra headers win over the client defaults", async () => {
    const { sdk } = newSdk();
    const { calls } = stubFetch(200, JEV_BODY);
    const ai = sdk.workersAI(ACCT, "tok", { gatewayId: GW });
    await ai.run("typesafe/jev", JEV_INPUT, { extraHeaders: { "cf-aig-skip-cache": "false" } });
    await sdk.shutdown(1000);
    expect(calls[0].headers["cf-aig-skip-cache"]).toBe("false");
  });

  it("a 402 rejects with WorkersAIError and bills nothing", async () => {
    const { sdk, received, errors } = newSdk();
    stubFetch(402, JEV_402);
    const ai = sdk.workersAI(ACCT, "tok", { gatewayId: GW, gatewayAuth: "gwtok" });
    const err = await ai.run("typesafe/jev", JEV_INPUT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkersAIError);
    expect((err as WorkersAIError).statusCode).toBe(402);
    expect((err as WorkersAIError).errors[0].code).toBe(2021);
    expect(String(err)).toContain("Insufficient balance");
    await sdk.shutdown(1000);
    expect(received).toEqual([]);
    expect(errors).toEqual([]); // the customer's error, not an instrumentation failure
  });

  it("success:false with a 200 is still an error", async () => {
    const { sdk, received } = newSdk();
    stubFetch(200, JEV_402);
    const ai = sdk.workersAI(ACCT, "tok");
    await expect(ai.run("typesafe/jev", JEV_INPUT)).rejects.toBeInstanceOf(WorkersAIError);
    await sdk.shutdown(1000);
    expect(received).toEqual([]);
  });
});

describe("WorkersAI client — options, attribution, failure isolation", () => {
  it("per-call lago options override the subscription and add dimensions", async () => {
    const { sdk, received } = newSdk("sub_default");
    const { calls } = stubFetch(200, CHAT_BODY);
    const ai = sdk.workersAI(ACCT, "tok", {
      gatewayId: GW,
      gatewayAuth: "gwtok",
      dimensions: { team: "billing" },
    });
    await ai.run(
      LLAMA,
      { messages: [] },
      { lago: { subscription: "sub_override", dimensions: { ticket: "T-1" } } },
    );
    expect(await sdk.flush(2000)).toBe(true);
    await sdk.shutdown(1000);
    expect(received.every((e) => e.external_subscription_id === "sub_override")).toBe(true);
    expect(received[0].properties.team).toBe("billing");
    expect(received[0].properties.ticket).toBe("T-1");
    expect(JSON.parse(calls[0].headers["cf-aig-metadata"])).toEqual({ lago_subscription: "sub_override" });
  });

  it("no resolvable subscription drops with onError", async () => {
    const { sdk, received, errors } = newSdk(null); // `undefined` would take the default parameter
    stubFetch(200, CHAT_BODY);
    const ai = sdk.workersAI(ACCT, "tok");
    await ai.run(LLAMA, { messages: [] });
    await sdk.shutdown(1000);
    expect(received).toEqual([]);
    expect(errors.some((e) => e.includes("no subscription resolved"))).toBe(true);
  });

  it("stream is refused before any request", async () => {
    const { sdk } = newSdk();
    const { calls } = stubFetch(200, CHAT_BODY);
    const ai = sdk.workersAI(ACCT, "tok");
    await expect(ai.run(LLAMA, { messages: [], stream: true })).rejects.toThrow(/stream: true/);
    await sdk.shutdown(1000);
    expect(calls).toEqual([]);
  });

  it("an instrumentation failure does not break the call", async () => {
    const { sdk, received, errors } = newSdk();
    stubFetch(200, CHAT_BODY);
    const ai = sdk.workersAI(ACCT, "tok");
    const emitSpy = vi.spyOn(sdk, "emit").mockImplementation(() => {
      throw new Error("adapter bug");
    });
    const out = (await ai.run(LLAMA, { messages: [] })) as any;
    expect(out.result.response).toBe("Hello there!");
    emitSpy.mockRestore();
    await sdk.shutdown(1000);
    expect(received).toEqual([]);
    expect(errors[0]).toContain("adapter bug");
  });

  it("a non-JSON error body still rejects cleanly", async () => {
    const { sdk, received } = newSdk();
    stubFetch(502, undefined, {}, "<html>bad gateway</html>");
    const ai = sdk.workersAI(ACCT, "tok");
    const err = (await ai.run(LLAMA, { messages: [] }).catch((e: unknown) => e)) as WorkersAIError;
    expect(err).toBeInstanceOf(WorkersAIError);
    expect(err.statusCode).toBe(502);
    expect(err.errors).toEqual([]);
    await sdk.shutdown(1000);
    expect(received).toEqual([]);
  });
});
