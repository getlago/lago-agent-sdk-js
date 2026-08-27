/** The suite's network guard is wired, and wired the way the tests need it.
 *
 * Not a test of `undici` — that it can block an origin is its own business. This tests
 * OUR decision: that the guard is actually installed for every file in this suite, and
 * that loopback stays exempt so the tests whose subject IS socket behaviour can still
 * stand up a real server. Delete `setupFiles` from `vitest.config.ts` and the first case
 * here fails; over-tighten the exemption and the second does.
 *
 * It matters because the failure it prevents is invisible: `npm test` was making live
 * requests to `openrouter.ai`, and every test still reported green.
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

describe("unit tests cannot reach the network", () => {
  it("refuses a request to a remote origin", async () => {
    // A real URL the SDK really fetches (`OPENROUTER_URL`), so this fails for the
    // honest reason if the guard is ever removed.
    await expect(fetch("https://openrouter.ai/api/v1/models")).rejects.toThrow();
  });

  it("still allows a real loopback server", async () => {
    const server = createServer((req, res) => {
      req.resume();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/events/batch`, { method: "POST" });
      expect(resp.status).toBe(200);
      expect(await resp.json()).toEqual({ ok: true });
    } finally {
      server.close();
    }
  });
});
