// @vitest-environment node
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { requestHost, requestHostname, validateMutationOrigin } from "../api/_lib/http.js";
import { isVercelCron, resolveSupabaseBackend } from "../api/_lib/backend.js";
import { runtimeConfigForRequest } from "../api/_lib/runtimeConfig.js";
import { PORTAL_HOST, SAMPLE_HOST, SUPABASE_ORIGIN, SUPABASE_REF } from "./helpers/fictional-provider.js";
import { SAMPLE_SUPABASE_ORIGIN } from "./helpers/b00-pinned-sample-backend.js";

// Union Ground trusts no portal and pins no SAMPLE project, so this suite
// substitutes the fictional trusted pair and a fictional pinned SAMPLE project.
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());
vi.mock("../src/lib/sampleBackend.js", async (importOriginal) =>
  (await import("./helpers/b00-pinned-sample-backend.js")).pinnedSampleBackendModule(await importOriginal()));

const repository = fileURLToPath(new URL("..", import.meta.url));
const apiRoot = join(repository, "api");

async function javascriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return javascriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".js") ? [path] : [];
  }));
  return nested.flat();
}

function hasDirectHostReader(source) {
  return /x-forwarded-host/i.test(source)
    || /(?:request\.)?headers\??\.host\b/.test(source)
    || /\[\s*["']host["']\s*\]/.test(source)
    || /\b(?:header|headerValue|requestHeader)\([^,\n]+,\s*["']host["']\)/i.test(source)
    || /\.get\(\s*["']host["']\s*\)/i.test(source);
}

describe("shared API host oracle", () => {
  it("is the only module under api that reads Host or X-Forwarded-Host", async () => {
    const violations = [];
    for (const path of await javascriptFiles(apiRoot)) {
      const repoPath = relative(repository, path).replaceAll("\\", "/");
      if (repoPath === "api/_lib/http.js") continue;
      const source = await readFile(path, "utf8");
      if (hasDirectHostReader(source)) violations.push(repoPath);
    }
    expect(violations.sort()).toEqual([]);
  });

  it("recognizes Fetch Headers Host readers as a second host oracle", () => {
    expect(hasDirectHostReader('request.headers.get("host")')).toBe(true);
    expect(hasDirectHostReader("request.headers.get( 'Host' )")).toBe(true);
  });

  it("uses Host first and falls back to X-Forwarded-Host through one normalized reader", () => {
    expect(requestHost({ headers: { host: `${SAMPLE_HOST.toUpperCase()}.:443`, "x-forwarded-host": PORTAL_HOST } }))
      .toBe(`${SAMPLE_HOST}:443`);
    expect(requestHostname({ headers: { host: `${SAMPLE_HOST.toUpperCase()}.:443`, "x-forwarded-host": PORTAL_HOST } }))
      .toBe(SAMPLE_HOST);
    expect(requestHostname({ headers: { "x-forwarded-host": PORTAL_HOST } }))
      .toBe(PORTAL_HOST);
    // The cron check reads only the raw Authorization string; an array value
    // never authorizes, even when its first entry is the exact bearer.
    expect(isVercelCron({
      headers: { authorization: ["Bearer exact-secret"] },
    }, { CRON_SECRET: "exact-secret" })).toBe(false);
    expect(isVercelCron({
      headers: { authorization: "Bearer exact-secret-0123456789abcdef0123456789" },
    }, { CRON_SECRET: "exact-secret-0123456789abcdef0123456789" })).toBe(true);
  });

  it("BUG-UG-DEMO-SURFACE-PREVIEW-RESOLVES-PRODUCTION-BACKEND-20260908 refuses Host values that are not a bare authority", () => {
    const malformed = [
      `preview.vercel.app@${PORTAL_HOST}`, `${PORTAL_HOST}/x`, `${PORTAL_HOST}?x`, `${PORTAL_HOST}#f`, `u:p@${SAMPLE_HOST}`,
      "a b.com", `${PORTAL_HOST}\\evil`, "[abc]", "[::1", "-bad.example", `${PORTAL_HOST}:443:443`,
      // Pre-normalization forms: the complete raw value is validated before any split, trim, lowercase or dot removal.
      `${PORTAL_HOST},unlisted.vercel.app`, `unlisted.vercel.app,${PORTAL_HOST}`, `${PORTAL_HOST}..`, `${PORTAL_HOST}:443.`,
      ` ${PORTAL_HOST}`, `${PORTAL_HOST} `, `${PORTAL_HOST}\t`, "\u212a.vercel.app", `${PORTAL_HOST}.:443.`,
      `${"a".repeat(64)}.${PORTAL_HOST}`, `${"a.".repeat(127)}com`, `${PORTAL_HOST}:4433333`,
    ];
    for (const host of malformed) {
      expect(requestHost({ headers: { host } }), JSON.stringify(host)).toBe("");
      expect(requestHostname({ headers: { host } }), JSON.stringify(host)).toBe("");
      expect(requestHostname({ headers: { "x-forwarded-host": host } }), JSON.stringify(host)).toBe("");
      // Fetch Headers normalizes away surrounding whitespace (so that case cannot be
      // observed through it) and its ByteString conversion throws for code points
      // above U+00FF; every other form must also be refused through a Headers object.
      if (!/[\s\u0100-\uffff]/.test(host)) expect(requestHostname({ headers: new Headers({ Host: host }) }), JSON.stringify(host)).toBe("");
    }
    // Latin-1 text survives Headers construction and is refused by the parser as non-ASCII.
    expect(requestHostname({ headers: new Headers({ Host: "caf\u00e9.example" }) })).toBe("");
    expect(requestHostname({ headers: { host: "caf\u00e9.example" } })).toBe("");
    // Multi-value array headers are refused before any value is read, for both authority names,
    // and a present-but-invalid Host never falls back to X-Forwarded-Host.
    for (const name of ["host", "x-forwarded-host"]) {
      expect(requestHost({ headers: { [name]: [PORTAL_HOST, "unlisted.vercel.app"] } }), name).toBe("");
      expect(requestHostname({ headers: { [name]: [PORTAL_HOST, "unlisted.vercel.app"] } }), name).toBe("");
      expect(requestHostname({ headers: { [name]: [] } }), name).toBe("");
      expect(requestHostname({ headers: { [name]: [null] } }), name).toBe("");
      expect(requestHostname({ headers: { [name]: [undefined] } }), name).toBe("");
      expect(requestHostname({ headers: { [name]: ["  "] } }), name).toBe("");
      expect(requestHostname({ headers: { [name]: [SAMPLE_HOST] } }), name).toBe(SAMPLE_HOST);
    }
    expect(requestHostname({ headers: { host: [PORTAL_HOST, "unlisted.vercel.app"], "x-forwarded-host": PORTAL_HOST } })).toBe("");
    expect(requestHostname({ headers: { host: "bad host", "x-forwarded-host": PORTAL_HOST } })).toBe("");
    expect(requestHostname({ headers: { host: "", "x-forwarded-host": PORTAL_HOST } })).toBe("");
    expect(requestHostname({ headers: { host: null, "x-forwarded-host": PORTAL_HOST } })).toBe(PORTAL_HOST);
    expect(requestHostname({ headers: { host: undefined, "x-forwarded-host": PORTAL_HOST } })).toBe(PORTAL_HOST);
    expect(requestHostname({ headers: { "x-forwarded-host": [PORTAL_HOST] } })).toBe(PORTAL_HOST);
    expect(requestHostname({ headers: { "x-forwarded-host": null } })).toBe("");
    expect(requestHostname({ headers: new Headers({ "X-Forwarded-Host": PORTAL_HOST }) })).toBe(PORTAL_HOST);
    expect(requestHostname({ headers: new Headers({ Host: SAMPLE_HOST, "X-Forwarded-Host": PORTAL_HOST }) })).toBe(SAMPLE_HOST);
    expect(requestHostname({})).toBe("");
    // DNS name length: 253 characters are accepted with or without the trailing dot or a port; 254 are not.
    const label = "a".repeat(63);
    const name253 = [label, label, label, "a".repeat(61)].join(".");
    expect(name253.length).toBe(253);
    for (const host of [name253, `${name253}.`, `${name253}:443`, `${name253}.:443`]) expect(requestHostname({ headers: { host } }), host.length).toBe(name253);
    for (const host of [`${name253}a`, `${name253}a.`, `${name253}a:443`]) expect(requestHostname({ headers: { host } }), host.length).toBe("");
    // Runtime configuration and the mutation-Origin check share the reader, so an
    // array Host cannot select production for either of them.
    const arrayHost = { host: [PORTAL_HOST, "unlisted.vercel.app"], origin: `https://${PORTAL_HOST}` };
    expect(runtimeConfigForRequest({ headers: arrayHost }, { VITE_APP_SURFACE: "demo" })).toEqual({ schema: 1, surface: null, configured: false });
    expect(validateMutationOrigin({ method: "POST", headers: arrayHost }, {})).toBe(false);
    expect(validateMutationOrigin({ method: "POST", headers: { host: [PORTAL_HOST], origin: `https://${PORTAL_HOST}` } }, {})).toBe(true);
    // Duplicate Host headers arrive comma-joined from Fetch Headers and are refused as a list.
    const duplicated = new Headers(); duplicated.append("Host", PORTAL_HOST); duplicated.append("Host", "unlisted.vercel.app");
    expect(requestHostname({ headers: duplicated })).toBe("");
    expect(requestHost({ headers: { host: `www.${PORTAL_HOST.toUpperCase()}.` } })).toBe(`www.${PORTAL_HOST}`);
    expect(requestHost({ headers: { host: `${SAMPLE_HOST.toUpperCase()}.:443` } })).toBe(`${SAMPLE_HOST}:443`);
    for (const [host, expected] of [[`${PORTAL_HOST.toUpperCase()}.:443`, PORTAL_HOST], ["[::1]:4173", "[::1]"], ["127.0.0.1:5173", "127.0.0.1"], ["localhost", "localhost"], ["my-preview.vercel.app", "my-preview.vercel.app"]]) {
      expect(requestHostname({ headers: { host } }), host).toBe(expected);
    }
  });

  it("keeps backend and runtime-config selection aligned when host headers conflict", () => {
    const env = {
      VITE_SUPABASE_URL: SUPABASE_ORIGIN,
      UNIONGROUND_SUPABASE_PROJECT_REF: SUPABASE_REF,
      VITE_SUPABASE_PUBLISHABLE_KEY: "production-public",
      SUPABASE_SERVICE_ROLE_KEY: "production-service",
      SAMPLE_SUPABASE_URL: SAMPLE_SUPABASE_ORIGIN,
      SAMPLE_SUPABASE_PUBLISHABLE_KEY: "sample-public",
      SAMPLE_SUPABASE_SERVICE_ROLE_KEY: "sample-service",
    };
    const productionRequest = {
      headers: { host: PORTAL_HOST, "x-forwarded-host": SAMPLE_HOST },
    };
    const sampleRequest = {
      headers: { host: SAMPLE_HOST, "x-forwarded-host": PORTAL_HOST },
    };

    expect(resolveSupabaseBackend(productionRequest, env).surface).toBe("saas");
    expect(runtimeConfigForRequest(productionRequest, env).surface).toBe("saas");
    expect(resolveSupabaseBackend(sampleRequest, env).surface).toBe("demo");
    expect(runtimeConfigForRequest(sampleRequest, env).surface).toBe("demo");
  });

  it("SEC-UG-API-HOST-ORACLE-DIVERGENCE-20260907 keeps Fetch Headers origin trust and exact backend credentials aligned", () => {
    const productionUrl = SUPABASE_ORIGIN;
    const sampleUrl = SAMPLE_SUPABASE_ORIGIN;
    const env = {
      VITE_SUPABASE_URL: productionUrl,
      UNIONGROUND_SUPABASE_PROJECT_REF: SUPABASE_REF,
      VITE_SUPABASE_PUBLISHABLE_KEY: "production-public",
      SUPABASE_SERVICE_ROLE_KEY: "production-service",
      SAMPLE_SUPABASE_URL: sampleUrl,
      SAMPLE_SUPABASE_PUBLISHABLE_KEY: "sample-public",
      SAMPLE_SUPABASE_SERVICE_ROLE_KEY: "sample-service",
    };
    const cases = [
      {
        host: SAMPLE_HOST,
        forwardedHost: PORTAL_HOST,
        origin: `https://${SAMPLE_HOST}`,
        // Only a paired portal is a trusted browser Origin; the SAMPLE host is not.
        originTrusted: false,
        surface: "demo",
        url: sampleUrl,
        publishableKey: "sample-public",
      },
      {
        host: PORTAL_HOST,
        forwardedHost: SAMPLE_HOST,
        origin: `https://${PORTAL_HOST}`,
        originTrusted: true,
        surface: "saas",
        url: productionUrl,
        publishableKey: "production-public",
      },
    ];

    for (const expected of cases) {
      const request = {
        method: "POST",
        headers: new Headers({
          Host: expected.host,
          Origin: expected.origin,
          "X-Forwarded-Host": expected.forwardedHost,
        }),
      };
      const forwardedOriginRequest = {
        ...request,
        headers: new Headers(request.headers),
      };
      forwardedOriginRequest.headers.set("Origin", `https://${expected.forwardedHost}`);

      expect(validateMutationOrigin(request, env)).toBe(expected.originTrusted);
      expect(validateMutationOrigin(forwardedOriginRequest, env)).toBe(false);
      expect(resolveSupabaseBackend(request, env)).toMatchObject({
        surface: expected.surface,
        url: expected.url,
        publishableKey: expected.publishableKey,
      });
      expect(runtimeConfigForRequest(request, env)).toMatchObject({
        configured: true,
        surface: expected.surface,
        supabaseUrl: expected.url,
        supabasePublishableKey: expected.publishableKey,
      });
    }
  });
});
