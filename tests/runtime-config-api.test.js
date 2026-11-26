// @vitest-environment node
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PORTAL_HOST, SAMPLE_HOST, SUPABASE_ORIGIN, SUPABASE_REF } from "./helpers/fictional-provider.js";
import { DENIED_APP_HOSTS } from "./helpers/denied-identity-fixtures.js";
import handler from "../api/runtime-config.js";
import { runtimeConfigForRequest, serializeRuntimeConfig } from "../api/_lib/runtimeConfig.js";
import { loadViteRuntimeEnv } from "../scripts/lib/vite-runtime-env.mjs";

// Union Ground ships no trusted backend pair, so the production surface
// only answers for a fictional pair substituted here.
vi.mock("../src/lib/trustedBackends.js", async () =>
  (await import("./helpers/fictional-provider.js")).trustedBackendsModule());

const env = {
  VITE_SUPABASE_URL: SUPABASE_ORIGIN,
  UNIONGROUND_SUPABASE_PROJECT_REF: SUPABASE_REF,
  VITE_SUPABASE_PUBLISHABLE_KEY: "production-public",
  SUPABASE_SERVICE_ROLE_KEY: "production-secret",
  VITE_SAMPLE_SUPABASE_URL: "https://psgsampleproject.supabase.co",
  VITE_SAMPLE_SUPABASE_PUBLISHABLE_KEY: "sample-public",
  SAMPLE_SUPABASE_SERVICE_ROLE_KEY: "sample-secret",
};

function recorder() {
  const out = { status: 0, headers: {}, body: undefined };
  return {
    out,
    setHeader(name, value) { out.headers[name] = value; },
    status(code) { out.status = code; return this; },
    end(body) { out.body = body; },
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("host-scoped runtime configuration", () => {
  it("returns no backend to the SAMPLE host, which pins no project", () => {
    const config = runtimeConfigForRequest({ headers: { host: SAMPLE_HOST } }, env);
    expect(config).toEqual({ schema: 1, surface: "demo", configured: false });
    expect(JSON.stringify(config)).not.toContain(env.VITE_SUPABASE_URL);
    expect(JSON.stringify(config)).not.toContain(env.VITE_SUPABASE_PUBLISHABLE_KEY);
    expect(JSON.stringify(config)).not.toContain(env.SUPABASE_SERVICE_ROLE_KEY);
    expect(JSON.stringify(config)).not.toContain(env.VITE_SAMPLE_SUPABASE_URL);
    expect(JSON.stringify(config)).not.toContain(env.VITE_SAMPLE_SUPABASE_PUBLISHABLE_KEY);
    expect(JSON.stringify(config)).not.toContain(env.SAMPLE_SUPABASE_SERVICE_ROLE_KEY);
  });

  it("never hands a browser a server-only key configured in the publishable slot", () => {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const serviceJwt = `${encode({ alg: "HS256" })}.${encode({ role: "service_role" })}.signature`;
    const secretKey = ["sb", "secret", "runtime", "fixture"].join("_");
    for (const key of [serviceJwt, secretKey, ` ${secretKey} `]) {
      const config = runtimeConfigForRequest({ headers: { host: PORTAL_HOST } }, { ...env, VITE_SUPABASE_PUBLISHABLE_KEY: key });
      expect(config).toEqual({ schema: 1, surface: "saas", configured: false });
      expect(serializeRuntimeConfig(config)).not.toContain(key.trim());
    }
  });

  it("returns only production public configuration to a trusted portal host", () => {
    const config = runtimeConfigForRequest({ headers: { host: PORTAL_HOST } }, env);
    expect(config).toEqual({
      schema: 1,
      surface: "saas",
      configured: true,
      supabaseUrl: env.VITE_SUPABASE_URL,
      supabasePublishableKey: env.VITE_SUPABASE_PUBLISHABLE_KEY,
    });
    expect(JSON.stringify(config)).not.toContain(env.VITE_SAMPLE_SUPABASE_URL);
    expect(JSON.stringify(config)).not.toContain(env.VITE_SAMPLE_SUPABASE_PUBLISHABLE_KEY);
    expect(JSON.stringify(config)).not.toContain(env.SUPABASE_SERVICE_ROLE_KEY);
  });

  it("refuses the retired sibling-product domains", () => {
    for (const host of DENIED_APP_HOSTS) {
      expect(runtimeConfigForRequest({ headers: { host } }, env))
        .toEqual({ schema: 1, surface: null, configured: false });
    }
  });

  it("fails closed for unknown hosts and mismatched project refs", () => {
    expect(runtimeConfigForRequest({ headers: { host: "unknown.example" } }, env))
      .toEqual({ schema: 1, surface: null, configured: false });
    expect(runtimeConfigForRequest({ headers: { host: SAMPLE_HOST } }, {
      ...env,
      VITE_SAMPLE_SUPABASE_URL: env.VITE_SUPABASE_URL,
    })).toEqual({ schema: 1, surface: "demo", configured: false });
    expect(runtimeConfigForRequest({ headers: { host: PORTAL_HOST } }, {
      ...env,
      VITE_SUPABASE_URL: env.VITE_SAMPLE_SUPABASE_URL,
    })).toEqual({ schema: 1, surface: "saas", configured: false });
  });

  it("does not let a forwarding header override the actual host", () => {
    expect(runtimeConfigForRequest({
      headers: { host: PORTAL_HOST, "x-forwarded-host": SAMPLE_HOST },
    }, env).surface).toBe("saas");
    expect(runtimeConfigForRequest({
      headers: { host: SAMPLE_HOST, "x-forwarded-host": PORTAL_HOST },
    }, env).surface).toBe("demo");
  });

  it("uses an explicit surface only on Vercel preview hosts", () => {
    expect(runtimeConfigForRequest({ headers: { host: "preview.vercel.app" } }, {
      ...env,
      VITE_APP_SURFACE: "demo",
    }).surface).toBe("demo");
    expect(runtimeConfigForRequest({ headers: { host: PORTAL_HOST } }, {
      ...env,
      VITE_APP_SURFACE: "demo",
    }).surface).toBe("saas");
  });

  it("permits only an explicit loopback E2E harness to use a dead local backend", () => {
    const harness = {
      VITE_SUPABASE_URL: "http://127.0.0.1:65535",
      UNIONGROUND_SUPABASE_PROJECT_REF: "local",
      // The harness serves a production build (`vite preview`), so it opts in
      // to the loopback seam explicitly (api/_lib/providerBoundary.js).
      NODE_ENV: "production",
      UNIONGROUND_LOCAL_BACKEND: "1",
      VITE_SUPABASE_PUBLISHABLE_KEY: "assurance-public-key",
      VITE_E2E_HARNESS: "1",
    };
    expect(runtimeConfigForRequest({ headers: { host: "127.0.0.1:4173" } }, harness))
      .toMatchObject({ surface: "saas", configured: true, supabaseUrl: harness.VITE_SUPABASE_URL });
    for (const change of [{ UNIONGROUND_LOCAL_BACKEND: "" }, { VERCEL: "1" }, { VERCEL_ENV: "development" }]) {
      expect(runtimeConfigForRequest({ headers: { host: "127.0.0.1:4173" } }, { ...harness, ...change }), JSON.stringify(change))
        .toEqual({ schema: 1, surface: "saas", configured: false });
    }
    expect(runtimeConfigForRequest({ headers: { host: "127.0.0.1:4173" } }, {
      ...harness,
      VITE_E2E_HARNESS: "",
    })).toEqual({ schema: 1, surface: "saas", configured: false });
    expect(runtimeConfigForRequest({ headers: { host: "preview.vercel.app" } }, harness))
      .toEqual({ schema: 1, surface: "saas", configured: false });
    expect(runtimeConfigForRequest({ headers: { host: "127.0.0.1:4173" } }, {
      ...harness,
      VITE_SUPABASE_URL: "https://example.com",
    })).toEqual({ schema: 1, surface: "saas", configured: false });
  });

  it("loads standard Vite mode files for the local preview middleware", () => {
    vi.stubEnv("VITE_SUPABASE_URL", undefined);
    const root = mkdtempSync(join(tmpdir(), "union-ground-runtime-env-"));
    try {
      writeFileSync(join(root, ".env.production"), [
        `VITE_SUPABASE_URL=${env.VITE_SUPABASE_URL}`,
        "VITE_SUPABASE_PUBLISHABLE_KEY=file-public",
      ].join("\n"));
      const loaded = loadViteRuntimeEnv("production", root, {
        VITE_SUPABASE_PUBLISHABLE_KEY: "ambient-public",
        UNIONGROUND_SUPABASE_PROJECT_REF: SUPABASE_REF,
      });
      expect(loaded.VITE_SUPABASE_URL).toBe(env.VITE_SUPABASE_URL);
      expect(loaded.VITE_SUPABASE_PUBLISHABLE_KEY).toBe("ambient-public");
      expect(runtimeConfigForRequest({ headers: { host: PORTAL_HOST } }, loaded))
        .toMatchObject({ surface: "saas", configured: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lets the ambient environment win over a mode file value", () => {
    vi.stubEnv("VITE_SUPABASE_URL", undefined);
    const root = mkdtempSync(join(tmpdir(), "union-ground-runtime-env-"));
    try {
      writeFileSync(join(root, ".env.production"), [
        `VITE_SUPABASE_URL=${env.VITE_SAMPLE_SUPABASE_URL}`,
        "VITE_SUPABASE_PUBLISHABLE_KEY=file-public",
      ].join("\n"));
      const loaded = loadViteRuntimeEnv("production", root, {
        VITE_SUPABASE_URL: env.VITE_SUPABASE_URL,
        VITE_SUPABASE_PUBLISHABLE_KEY: "ambient-public",
        UNIONGROUND_SUPABASE_PROJECT_REF: SUPABASE_REF,
      });
      expect(loaded.VITE_SUPABASE_URL).toBe(env.VITE_SUPABASE_URL);
      expect(runtimeConfigForRequest({ headers: { host: PORTAL_HOST } }, loaded))
        .toMatchObject({ surface: "saas", configured: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("serializes without executable markup separators", () => {
    const script = serializeRuntimeConfig({ surface: "saas", configured: false, value: "</script>\u2028" });
    expect(script).not.toContain("</script>");
    expect(script).not.toContain("\u2028");
    expect(script).toContain("\\u003c/script>");
  });

  it("serves blocking JavaScript with no-store and host variance", async () => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    const response = recorder();
    await handler({ method: "GET", headers: { host: SAMPLE_HOST } }, response);
    expect(response.out.status).toBe(200);
    expect(response.out.headers["Cache-Control"]).toBe("private, no-store, max-age=0");
    expect(response.out.headers["Content-Type"]).toBe("application/javascript; charset=utf-8");
    expect(response.out.headers.Vary).toBe("Host");
    expect(response.out.body).toContain("__UNIONGROUND_RUNTIME_CONFIG__");
    expect(response.out.body).not.toContain(env.VITE_SUPABASE_URL);
  });
});
