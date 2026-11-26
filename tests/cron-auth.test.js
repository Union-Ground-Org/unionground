// @vitest-environment node
// The one cron rule (api/_lib/cronAuth.js) and the shared secret-strength rule
// (api/_lib/secretStrength.js). A copy of this project that kept a value from
// .env.example must not let anyone run its scheduled jobs.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  constantTimeEqual,
  cronAuthorization,
  cronBearer,
  cronRefusalBody,
  hasVercelCronHeader,
} from "../api/_lib/cronAuth.js";
import { isPlaceholderSecret, secretProblem, usableSecret } from "../api/_lib/secretStrength.js";
import { authorizeCronRequest } from "../api/_lib/http.js";
import { isVercelCron } from "../api/_lib/backend.js";

const GOOD = "0123456789abcdef".repeat(4);
const OLD_EXAMPLE = ["replace", "with", "long", "random", "cron", "secret"].join("-");
const PLACEHOLDERS = [
  OLD_EXAMPLE,
  "REPLACE-WITH-a-value-that-is-easily-long-enough-to-pass",
  "  replace-with-leading-space-and-long-enough-to-pass  ",
  "changeme-changeme-changeme-changeme-changeme",
  "change-me-change-me-change-me-change-me",
  "example-secret-that-is-more-than-thirty-two-characters",
];

const req = (headers = {}) => ({ method: "GET", headers });

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("secret strength", () => {
  it.each(PLACEHOLDERS)("treats %j as a placeholder", (value) => {
    expect(isPlaceholderSecret(value)).toBe(true);
    expect(secretProblem(value)).toBe("placeholder");
    expect(usableSecret(value)).toBe(false);
  });

  it("names missing and short secrets", () => {
    expect(secretProblem(undefined)).toBe("missing");
    expect(secretProblem("")).toBe("missing");
    expect(secretProblem("   ")).toBe("missing");
    expect(secretProblem("a".repeat(31))).toBe("too_short");
    expect(secretProblem("a".repeat(32))).toBe("");
    expect(usableSecret(GOOD)).toBe(true);
  });

  it("refuses every replace-with value .env.example still carries for a secret the server checks", () => {
    const example = readFileSync(new URL("../.env.example", import.meta.url), "utf8");
    const checked = [
      "CRON_SECRET", "INTEGRATION_DISPATCH_SECRET", "SAMPLE_INTEGRATION_DISPATCH_SECRET",
      "SAMPLE_NOTIFICATION_DISPATCH_SECRET", "INVITATION_RATE_LIMIT_SECRET", "OPEN_SIGNUP_SECRET",
      "PUBLIC_INTEREST_RATE_LIMIT_SECRET", "ORGANIZATION_CLAIM_RATE_LIMIT_SECRET",
    ];
    for (const name of checked) {
      const match = new RegExp(`^${name}=(.*)$`, "m").exec(example);
      expect(match, `${name} stays documented`).not.toBeNull();
      // Shipped empty, so a copy that forgets it fails closed instead of
      // running on a well-known value.
      expect(match[1], `${name} ships empty`).toBe("");
    }
    expect(example).toContain("openssl rand -hex 32");
    for (const [, value] of example.matchAll(/^[A-Z0-9_]+=(replace-with[^\s]*)$/gm)) {
      expect(usableSecret(value)).toBe(false);
    }
  });
});

describe("cronAuthorization", () => {
  it("answers 503 with an operator message, never the value, for a bad configuration", () => {
    for (const value of [undefined, "", "short", ...PLACEHOLDERS]) {
      const decision = cronAuthorization(req({ authorization: `Bearer ${value}` }), { env: { CRON_SECRET: value } });
      expect(decision).toMatchObject({ ok: false, status: 503, error: "cron_secret_not_configured" });
      expect(decision.message).toContain("CRON_SECRET");
      expect(decision.message).toContain("openssl rand -hex 32");
      if (value && value.length > 5) expect(decision.message).not.toContain(value.trim());
    }
  });

  it("answers 401 for a caller without the exact bearer", () => {
    const env = { CRON_SECRET: GOOD };
    expect(cronAuthorization(req(), { env })).toEqual({ ok: false, status: 401, error: "unauthorized" });
    expect(cronAuthorization(req({ authorization: "Bearer wrong" }), { env }).status).toBe(401);
    expect(cronAuthorization(req({ authorization: `Bearer ${GOOD}x` }), { env }).status).toBe(401);
    expect(cronAuthorization(req({ authorization: GOOD }), { env }).status).toBe(401);
  });

  it("accepts the exact bearer and, when asked, also requires the Vercel cron marker", () => {
    const env = { CRON_SECRET: GOOD };
    expect(cronAuthorization(req({ authorization: `Bearer ${GOOD}` }), { env })).toEqual({ ok: true });
    expect(cronAuthorization(req({ authorization: `bearer ${GOOD}` }), { env })).toEqual({ ok: true });
    expect(cronAuthorization(req({ authorization: `Bearer ${GOOD}` }), { env, requireVercelCronHeader: true }).status).toBe(401);
    expect(cronAuthorization(req({ authorization: `Bearer ${GOOD}`, "x-vercel-cron": "1" }), { env, requireVercelCronHeader: true }))
      .toEqual({ ok: true });
  });

  it("reads a named secret and process.env by default", () => {
    vi.stubEnv("CRON_SECRET", GOOD);
    vi.stubEnv("INTEGRATION_DISPATCH_SECRET", OLD_EXAMPLE);
    expect(cronAuthorization(req({ authorization: `Bearer ${GOOD}` }))).toEqual({ ok: true });
    const dispatch = cronAuthorization(req({ authorization: `Bearer ${OLD_EXAMPLE}` }), { secretName: "INTEGRATION_DISPATCH_SECRET" });
    expect(dispatch).toMatchObject({ status: 503 });
    expect(dispatch.message).toContain("INTEGRATION_DISPATCH_SECRET");
  });

  it("builds refusal bodies in the route's shape", () => {
    expect(cronRefusalBody({ status: 401, error: "unauthorized" }, { ok: false })).toEqual({ ok: false, error: "unauthorized" });
    expect(cronRefusalBody({ status: 503, error: "cron_secret_not_configured", message: "m" }))
      .toEqual({ error: "cron_secret_not_configured", message: "m" });
  });

  it("compares in constant time over hashed values and parses headers in both shapes", () => {
    expect(constantTimeEqual("a", "a")).toBe(true);
    expect(constantTimeEqual("a", "ab")).toBe(false);
    expect(cronBearer({ headers: { authorization: ["Bearer x"] } })).toBe("x");
    expect(cronBearer({ headers: new Headers({ authorization: "Bearer y" }) })).toBe("y");
    expect(hasVercelCronHeader({ headers: { "x-vercel-cron": "1" } })).toBe(true);
    expect(hasVercelCronHeader({ headers: {} })).toBe(false);
  });

  it("keeps the boolean helpers on the same rule", () => {
    vi.stubEnv("CRON_SECRET", OLD_EXAMPLE);
    expect(authorizeCronRequest(req({ authorization: `Bearer ${OLD_EXAMPLE}` }))).toBe(false);
    expect(isVercelCron(req({ authorization: `Bearer ${OLD_EXAMPLE}`, "x-vercel-cron": "1" }), { CRON_SECRET: OLD_EXAMPLE })).toBe(false);
    expect(isVercelCron(req({ authorization: `Bearer ${GOOD}`, "x-vercel-cron": "1" }), { CRON_SECRET: GOOD })).toBe(true);
  });
});

// Every scheduled route Vercel calls refuses a copied placeholder before any
// network request, whatever else it checks first.
const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
const cronPaths = vercel.crons.map((cron) => cron.path);

describe("every scheduled route", () => {
  let fetcher;
  beforeEach(() => {
    fetcher = vi.fn(() => { throw new Error("no network in this test"); });
    vi.stubGlobal("fetch", fetcher);
    vi.stubEnv("CRON_SECRET", OLD_EXAMPLE);
    vi.stubEnv("INTEGRATION_DISPATCH_SECRET", "");
    vi.stubEnv("SAMPLE_INTEGRATION_DISPATCH_SECRET", "");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("lists the scheduled routes this test covers", () => {
    expect(cronPaths.length).toBeGreaterThanOrEqual(11);
  });

  it.each(cronPaths)("%s uses the shared rule and refuses the placeholder", async (path) => {
    const file = `../api${path.replace(/^\/api/, "")}.js`;
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    expect(source).toMatch(/from "\.\/_lib\/cronAuth\.js"/);
    expect(source).not.toMatch(/process\.env\.CRON_SECRET/);
    const { default: handler } = await import(file);
    let status = 0;
    let body;
    const response = {
      statusCode: 200,
      setHeader() {},
      getHeader() {},
      status(code) { status = code; this.statusCode = code; return this; },
      json(payload) { body = payload; if (!status) status = this.statusCode; return this; },
      send(payload) { body = payload; if (!status) status = this.statusCode; return this; },
      end(payload) { if (payload !== undefined) body = payload; if (!status) status = this.statusCode; return this; },
    };
    await handler({
      method: "GET",
      url: path,
      query: {},
      headers: { "x-vercel-cron": "1", authorization: `Bearer ${OLD_EXAMPLE}` },
    }, response);
    expect(status || response.statusCode).toBe(503);
    expect(fetcher).not.toHaveBeenCalled();
    const text = typeof body === "string" ? body : JSON.stringify(body ?? {});
    expect(text).not.toContain(OLD_EXAMPLE);
  });
});
