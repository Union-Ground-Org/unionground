// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { DENIED_APP_HOST, DENIED_SUPABASE_REFS } from "./helpers/denied-identity-fixtures.js";
import {
  browserExposedServerKeys,
  isBrowserSafeSupabaseKey,
  isServerOnlySupabaseKey,
  validateBrowserEnvironmentKeys,
  validateBrowserProviderEnvironment,
  validateUnionGroundAppUrl,
  validateUnionGroundSupabase,
} from "../src/lib/providerContract.js";

describe("Union Ground provider contract", () => {
  it("accepts only the explicitly named hosted Supabase project", () => {
    expect(
      validateUnionGroundSupabase(
        "https://uniongrounddemo.supabase.co/",
        "uniongrounddemo",
      ).origin,
    ).toBe("https://uniongrounddemo.supabase.co");
    expect(() => validateUnionGroundSupabase(
      "https://another.supabase.co/",
      "uniongrounddemo",
    )).toThrow(/does not match/);
    expect(() => validateUnionGroundSupabase(
      "https://uniongrounddemo.supabase.co/",
      "",
    )).toThrow(/project ref is required/);
  });

  it("rejects every sibling-product Supabase project", () => {
    // The real projects are listed by digest; the fixtures are on the same list.
    for (const ref of DENIED_SUPABASE_REFS) {
      expect(() => validateUnionGroundSupabase(
        `https://${ref}.supabase.co/`,
        ref,
      )).toThrow(/Sibling product Supabase project/);
    }
  });

  it("allows local Supabase only through the explicit local contract", () => {
    expect(
      validateUnionGroundSupabase(
        "http://127.0.0.1:55421/",
        "local",
        { allowLocal: true },
      ).origin,
    ).toBe("http://127.0.0.1:55421");
    expect(() => validateUnionGroundSupabase(
      "http://127.0.0.1:55421/",
      "remote",
      { allowLocal: true },
    )).toThrow(/requires project ref local/);
  });

  it("rejects legacy app hosts and URL claim smuggling", () => {
    expect(() => validateUnionGroundAppUrl(`https://${DENIED_APP_HOST}/`)).toThrow(/forbidden/);
    expect(() => validateUnionGroundAppUrl(`https://www.${DENIED_APP_HOST}/`)).toThrow(/forbidden/);
    expect(() => validateUnionGroundAppUrl("https://user:pass@example.org/")).toThrow(/credentials/);
    expect(() => validateUnionGroundAppUrl("https://example.org/?next=sibling")).toThrow(/query/);
    // HTTPS alone does not make an origin a deployed target: without this the
    // runner would happily drive https://localhost and report it as deployed.
    expect(() => validateUnionGroundAppUrl("https://localhost:5173/")).toThrow(/not an allowed deployed target/);
    expect(() => validateUnionGroundAppUrl("https://127.0.0.1:5173/")).toThrow(/not an allowed deployed target/);
    expect(validateUnionGroundAppUrl("https://unionground.example.org/").origin)
      .toBe("https://unionground.example.org");
  });

  it("still admits an explicitly opted-in local app URL", () => {
    expect(validateUnionGroundAppUrl("http://127.0.0.1:5173/", { allowLocal: true }).origin)
      .toBe("http://127.0.0.1:5173");
    expect(validateUnionGroundAppUrl("https://localhost:5173/", { allowLocal: true }).origin)
      .toBe("https://localhost:5173");
  });

  it("allows only browser-safe publishable or legacy anon keys", () => {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const anonJwt = `${encode({ alg: "HS256" })}.${encode({ role: "anon" })}.signature`;
    const serviceJwt = `${encode({ alg: "HS256" })}.${encode({ role: "service_role" })}.signature`;
    expect(isBrowserSafeSupabaseKey(["sb", "publishable", "public", "fixture", "key"].join("_"))).toBe(true);
    expect(isBrowserSafeSupabaseKey(anonJwt)).toBe(true);
    expect(isBrowserSafeSupabaseKey(["sb", "secret", "server_only"].join("_"))).toBe(false);
    expect(isBrowserSafeSupabaseKey(serviceJwt)).toBe(false);
    expect(isBrowserSafeSupabaseKey("publishable-looking-but-invalid")).toBe(false);
  });

  it("validates browser provider variables together before Vite can embed them", () => {
    expect(validateBrowserProviderEnvironment({})).toBe(false);
    expect(() => validateBrowserProviderEnvironment({
      VITE_SUPABASE_URL: "https://uniongrounddemo.supabase.co/",
    })).toThrow(/configured together/);
    expect(validateBrowserProviderEnvironment({
      VITE_SUPABASE_URL: "https://uniongrounddemo.supabase.co/",
      VITE_SUPABASE_PUBLISHABLE_KEY: ["sb", "publishable", "public", "fixture", "key"].join("_"),
      VITE_UNIONGROUND_SUPABASE_REF: "uniongrounddemo",
    })).toBe(true);
    expect(() => validateBrowserProviderEnvironment({
      VITE_SUPABASE_URL: "https://uniongrounddemo.supabase.co/",
      VITE_SUPABASE_PUBLISHABLE_KEY: ["sb", "secret", "server", "only"].join("_"),
      VITE_UNIONGROUND_SUPABASE_REF: "uniongrounddemo",
    })).toThrow(/publishable or legacy anon/);
  });

  it("finds a server-only Supabase key under any VITE_ name, and names only the variable", () => {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const jwt = (role) => `${encode({ alg: "HS256" })}.${encode({ role })}.signature`;
    const secret = ["sb", "secret", "fixture"].join("_");
    expect(isServerOnlySupabaseKey(secret)).toBe(true);
    expect(isServerOnlySupabaseKey(jwt("service_role"))).toBe(true);
    expect(isServerOnlySupabaseKey(jwt("supabase_admin"))).toBe(true);
    expect(isServerOnlySupabaseKey(jwt("anon"))).toBe(false);
    expect(isServerOnlySupabaseKey(["sb", "publishable", "fixture", "key"].join("_"))).toBe(false);
    expect(isServerOnlySupabaseKey("not.a.jwt")).toBe(false);
    expect(isServerOnlySupabaseKey("")).toBe(false);
    const env = {
      VITE_SUPABASE_ANON_KEY: jwt("service_role"),
      VITE_SOMETHING_ELSE: secret,
      VITE_SENTRY_DSN: "https://public@example.invalid/1",
      SUPABASE_SERVICE_ROLE_KEY: jwt("service_role"),
    };
    expect(browserExposedServerKeys(env)).toEqual(["VITE_SOMETHING_ELSE", "VITE_SUPABASE_ANON_KEY"]);
    let message = "";
    try { validateBrowserEnvironmentKeys(env); } catch (error) { message = error.message; }
    expect(message).toMatch(/VITE_SOMETHING_ELSE, VITE_SUPABASE_ANON_KEY must not hold/);
    expect(message).not.toContain(secret);
    expect(validateBrowserEnvironmentKeys({ SUPABASE_SERVICE_ROLE_KEY: secret })).toBe(true);
  });

  it("refuses a SAMPLE browser key that is not publishable or legacy anon", () => {
    expect(() => validateBrowserEnvironmentKeys({ VITE_SAMPLE_SUPABASE_PUBLISHABLE_KEY: "not-a-publishable-key" }))
      .toThrow(/VITE_SAMPLE_SUPABASE_PUBLISHABLE_KEY must contain only/);
    expect(validateBrowserEnvironmentKeys({
      VITE_SAMPLE_SUPABASE_PUBLISHABLE_KEY: ["sb", "publishable", "sample", "fixture"].join("_"),
    })).toBe(true);
    expect(validateBrowserEnvironmentKeys({})).toBe(true);
  });

  it("fails the build when a service_role key rides in under another VITE_ name", () => {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const sentinel = `${encode({ alg: "HS256" })}.${encode({ role: "service_role", sentinel: "BUILD_SENTINEL_TWO" })}.signature`;
    const output = mkdtempSync(join(tmpdir(), "unionground-provider-build-"));
    try {
      const run = spawnSync(
        process.execPath,
        [join(process.cwd(), "node_modules", "vite", "bin", "vite.js"), "build", "--outDir", output],
        { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, VITE_SUPABASE_ANON_KEY: sentinel } },
      );
      expect(run.status).not.toBe(0);
      expect(`${run.stdout}${run.stderr}`).toContain("VITE_SUPABASE_ANON_KEY must not hold");
      expect(`${run.stdout}${run.stderr}`).not.toContain(sentinel);
      expect(existsSync(output) ? readdirSync(output) : []).toEqual([]);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });

  it("fails the production build before a server-only key reaches an artifact", () => {
    const output = mkdtempSync(join(tmpdir(), "unionground-provider-build-"));
    const secret = ["sb", "secret", "BUILD_SENTINEL", "not", "a", "credential"].join("_");
    try {
      const run = spawnSync(
        process.execPath,
        [join(process.cwd(), "node_modules", "vite", "bin", "vite.js"), "build", "--outDir", output],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            VITE_SUPABASE_URL: "https://uniongrounddemo.supabase.co/",
            VITE_SUPABASE_PUBLISHABLE_KEY: secret,
            VITE_UNIONGROUND_SUPABASE_REF: "uniongrounddemo",
          },
        },
      );
      expect(run.status).not.toBe(0);
      const files = existsSync(output)
        ? readdirSync(output, { recursive: true })
          .map((entry) => join(output, String(entry)))
          .filter((path) => existsSync(path))
        : [];
      const leaked = files.some((path) => {
        try {
          return readFileSync(path, "utf8").includes(secret);
        } catch {
          return false;
        }
      });
      expect(leaked).toBe(false);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  });
});
