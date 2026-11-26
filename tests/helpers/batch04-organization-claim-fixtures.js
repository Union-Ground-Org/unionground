// Batch 04 copy of organization-claim-fixtures.js pointed at the fictional
// Union Ground provider pair. Shared fixtures for the organization-claim route tests. Fictional values
// only: example.invalid hosts, Fixtureperson people, olms-9000000NN keys.
import { vi } from "vitest";
import { PORTAL_HOST, PORTAL_ORIGIN, SUPABASE_ORIGIN } from "./fictional-provider.js";

export const SUPABASE = SUPABASE_ORIGIN;
export const HOST = PORTAL_HOST;
export const ORIGIN = PORTAL_ORIGIN;
export const USER_ID = "11111111-1111-4111-8111-111111111111";
export const ORG_ID = "22222222-2222-4222-8222-222222222222";
export const CLAIM_ID = "33333333-3333-4333-8333-333333333333";
export const IDEMPOTENCY_KEY = "44444444-4444-4444-8444-444444444444";
export const VERIFIER_EMAIL = "verifier@example.invalid";
export const RATE_SECRET = "r".repeat(48);

export function stubClaimEnv(overrides = {}) {
  const env = {
    VITE_SUPABASE_URL: SUPABASE,
    VITE_SUPABASE_PUBLISHABLE_KEY: "publishable-key",
    SUPABASE_SERVICE_ROLE_KEY: "server-secret-key",
    SAMPLE_SUPABASE_URL: "https://sample.supabase.co",
    SAMPLE_SUPABASE_PUBLISHABLE_KEY: "sample-publishable",
    SAMPLE_SUPABASE_SERVICE_ROLE_KEY: "sample-service",
    PUBLIC_SITE_APP_ORIGIN: ORIGIN,
    ORGANIZATION_CLAIM_RATE_LIMIT_SECRET: RATE_SECRET,
    RESEND_API_KEY: "resend-key",
    NOTIFY_FROM_ADDRESS: "Union Ground <alerts@example.invalid>",
    CLAIM_VERIFIER_EMAIL: VERIFIER_EMAIL,
    ...overrides,
  };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
}

export function jwt(payload) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "HS256", typ: "JWT" })}.${part(payload)}.signature`;
}

export function reply(payload, status = 200) {
  const text = payload === null ? "" : JSON.stringify(payload);
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}

// A fetch double routed by URL. `routes` maps an RPC name, "user" (GoTrue) or
// "resend" to a reply, a function returning one, or an Error to throw.
export function fetchRouter(routes = {}) {
  const fetcher = vi.fn(async (url, init = {}) => {
    const target = String(url);
    let key;
    if (target === `${SUPABASE}/auth/v1/user`) key = "user";
    else if (target === "https://api.resend.com/emails") key = "resend";
    else if (target.startsWith(`${SUPABASE}/rest/v1/rpc/`)) key = target.slice(`${SUPABASE}/rest/v1/rpc/`.length);
    else throw new Error(`unexpected fetch ${target}`);
    let route = routes[key];
    if (route === undefined && key === "resend") route = reply({ id: "email-1" });
    if (typeof route === "function") route = await route(init);
    if (route instanceof Error) throw route;
    if (!route) throw new Error(`no route for ${key}`);
    return route;
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

export function callsTo(fetcher, key) {
  return fetcher.mock.calls.filter(([url]) => {
    const target = String(url);
    if (key === "resend") return target === "https://api.resend.com/emails";
    if (key === "user") return target.endsWith("/auth/v1/user");
    return target.endsWith(`/rest/v1/rpc/${key}`);
  });
}

export function bodyOf(call) {
  return JSON.parse(call[1].body);
}

export function recorder() {
  const out = { status: 0, headers: {}, body: null };
  return {
    out,
    status(code) { out.status = code; return this; },
    setHeader(name, value) { out.headers[name] = value; return this; },
    end(body) { out.body = body ? JSON.parse(body) : null; return this; },
  };
}

export async function run(handler, req) {
  const res = recorder();
  await handler(req, res);
  return res.out;
}

export function captureConsole() {
  const lines = [];
  for (const level of ["log", "info", "warn", "error", "debug"]) {
    vi.spyOn(console, level).mockImplementation((...args) => {
      lines.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
    });
  }
  return lines;
}
