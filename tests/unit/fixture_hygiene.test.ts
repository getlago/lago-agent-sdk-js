/**
 * Committed fixtures must carry no personal or real-account data.
 *
 * These fixtures are captured from live provider and gateway calls, and both repos
 * publish to a PUBLIC package registry. A capture therefore arrives carrying whatever
 * the provider chose to log about the operator who made it — `system.ai_gateway.usage`
 * records the caller's account email and source IP on every row, and Snowflake's Cortex
 * views name the caller in ROLE_NAMES and carry a customer-controlled QUERY_TAG — none of
 * which any adapter reads. Twenty-two Databricks fixtures shipped with a personal Gmail address,
 * a residential IP, a real workspace subdomain and one live Lago subscription id before
 * this test existed.
 *
 * There is no capture script for the gateway fixtures (they come out of a SQL warehouse
 * query), so there is nowhere to put a scrub step a future recapture would run. This
 * test is the guard instead: it fails on the way back in.
 *
 * Kept in step with `test_fixture_hygiene.py` in the Python port.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const FIXTURE_ROOT = path.resolve(__dirname);

// Only the RFC 2606 reserved names are acceptable.
const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
// A Databricks workspace subdomain is a real, addressable host.
const DBX_HOST = /\bdbc-[0-9a-f]{4,}-[0-9a-f]{4,}\b/g;

// Snowflake's ACCOUNT_USAGE views name the caller in ROLE_NAMES as `USER$<login>`, and
// a Snowflake account hostname is a real, addressable host. No adapter reads either.
const SF_USER_ROLE = /\bUSER\$[A-Za-z0-9_]+/g;
const SF_HOST = /\b[A-Za-z0-9][A-Za-z0-9-]*\.snowflakecomputing\.com\b/g;

const ALLOWED_EMAIL_DOMAINS = new Set(["example.com", "example.org", "example.net"]);
const PLACEHOLDER_DBX_HOST = "dbc-00000000-0000";
const PLACEHOLDER_SF_USER = "USER$EXAMPLE_USER";
const PLACEHOLDER_SF_HOST = "example-account.snowflakecomputing.com";

function fixtures(dir: string = FIXTURE_ROOT): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return fixtures(p);
    return e.isFile() && e.name.endsWith(".json") ? [p] : [];
  });
}

/** True only for a globally routable address — a real host somewhere. Mirrors
 *  Python's `ipaddress.ip_address(...).is_global` for the ranges that occur here. */
function isPublicIp(text: string): boolean {
  const parts = text.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  // RFC 5737 documentation ranges — the intended replacements.
  if (a === 192 && b === 0 && parts[2] === 2) return false;
  if (a === 198 && b === 51 && parts[2] === 100) return false;
  if (a === 203 && b === 0 && parts[2] === 113) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  return true;
}

function scan(re: RegExp, keep: (m: RegExpMatchArray) => string | null): string[] {
  const offenders: string[] = [];
  for (const file of fixtures()) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(re)) {
      const bad = keep(m);
      if (bad !== null) offenders.push(`${path.relative(FIXTURE_ROOT, file)}: ${bad}`);
    }
  }
  return [...new Set(offenders)];
}

describe("fixture hygiene", () => {
  it("contains no real email addresses", () => {
    const offenders = scan(EMAIL, (m) => (ALLOWED_EMAIL_DOMAINS.has(m[1].toLowerCase()) ? null : m[1]));
    expect(
      offenders,
      "fixtures carry email addresses outside the RFC 2606 reserved domains — replace with an example.com address",
    ).toEqual([]);
  });

  it("contains no publicly routable IP addresses", () => {
    const offenders = scan(IPV4, (m) => (isPublicIp(m[0]) ? m[0] : null));
    expect(
      offenders,
      "fixtures carry globally routable IP addresses — replace with an RFC 5737 documentation address such as 203.0.113.10",
    ).toEqual([]);
  });

  it("names no real Databricks workspace hosts", () => {
    const offenders = scan(DBX_HOST, (m) => (m[0] === PLACEHOLDER_DBX_HOST ? null : m[0]));
    expect(offenders, `fixtures name a real Databricks workspace — use ${PLACEHOLDER_DBX_HOST}`).toEqual([]);
  });

  it("names no real Snowflake users", () => {
    const offenders = scan(SF_USER_ROLE, (m) => (m[0] === PLACEHOLDER_SF_USER ? null : m[0]));
    expect(offenders, `fixtures name a real Snowflake user — use ${PLACEHOLDER_SF_USER}`).toEqual([]);
  });

  it("names no real Snowflake account hosts", () => {
    const offenders = scan(SF_HOST, (m) => (m[0] === PLACEHOLDER_SF_HOST ? null : m[0]));
    expect(offenders, `fixtures name a real Snowflake account — use ${PLACEHOLDER_SF_HOST}`).toEqual([]);
  });
});
