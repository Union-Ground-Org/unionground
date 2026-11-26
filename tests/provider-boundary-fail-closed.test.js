// @vitest-environment node
// SEC-UG-PROVIDER-BOUNDARY-FAIL-CLOSED-20261112 (#96): the API uses
// a configured production backend only when api/_lib/providerBoundary.js
// approves it, and the server and tool validators refuse every sibling-product
// project and application host from the one list in config/sample-backend.json.
// Every handler here runs with fetch intercepted and synthetic credentials.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FORBIDDEN as BUNDLE_FORBIDDEN,
  scanWebBundle,
} from "../scripts/verify-web-bundle-identity.mjs";
import { denyDigest, DENY_DIGEST_PATTERN } from "../scripts/lib/denied-identity.mjs";
import { siblingIdentityIn } from "../scripts/lib/sibling-deny-list.mjs";
import { PORTAL_ORIGIN, SUPABASE_ORIGIN, SUPABASE_REF } from "./helpers/fictional-provider.js";
import { DENIED_APP_HOSTS, DENIED_IDENTITY_TOKEN, DENIED_SUPABASE_REFS } from "./helpers/denied-identity-fixtures.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// The deny lists keep the sibling product's real projects and hosts only as
// digests. The fictional fixtures below are on the same lists, so every
// refusal is proven here without naming a real target; the list sizes are
// pinned so an entry cannot quietly disappear.
const SIBLING_REFS = [...DENIED_SUPABASE_REFS];
const SIBLING_APP_HOSTS = [...DENIED_APP_HOSTS];
const DENIED_HOSTS = SIBLING_APP_HOSTS;
const DENIED_REFS = SIBLING_REFS;
const [SIBLING_HOST, SIBLING_SAAS_HOST] = SIBLING_APP_HOSTS;
const SIBLING_APP_ORIGINS = [
  `https://${SIBLING_HOST}`,
  `https://www.${SIBLING_HOST}`,
  `https://${SIBLING_SAAS_HOST}`,
  `https://www.${SIBLING_SAAS_HOST}`,
  `https://app.${SIBLING_SAAS_HOST}`,
  `https://mesh.${SIBLING_SAAS_HOST}`,
  `https://${SIBLING_SAAS_HOST.toUpperCase()}`,
  `https://${SIBLING_SAAS_HOST}.`,
];

const CRON_SECRET = "c".repeat(40);
const PUBLISHABLE_KEY = "synthetic-publishable-key";
const SERVICE_ROLE_KEY = "synthetic-service-role-key-not-a-credential";
const PASSWORD = "synthetic-password-123";
const LOOPBACK = "http://127.0.0.1:54321";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.doUnmock("../src/lib/trustedBackends.js");
  vi.resetModules();
});

// Fresh modules per scenario. `approve` is the approval table the scenario runs
// under: `null` is the table Union Ground ships (empty), an array is a
// fictional table naming exactly those backend origins.
function useApprovalTable(approve) {
  vi.resetModules();
  if (approve === null) {
    vi.doUnmock("../src/lib/trustedBackends.js");
  } else {
    vi.doMock("../src/lib/trustedBackends.js", () => {
      const TRUSTED_BACKEND_PORTALS = Object.freeze(Object.fromEntries(approve.map((origin) => [origin, PORTAL_ORIGIN])));
      return {
        TRUSTED_BACKEND_PORTALS,
        isTrustedPortalOrigin: (origin) => Object.values(TRUSTED_BACKEND_PORTALS).includes(origin),
      };
    });
  }
}

async function loadApi(approve) {
  useApprovalTable(approve);
  return {
    boundary: await import("../api/_lib/providerBoundary.js"),
    backend: await import("../api/_lib/backend.js"),
    http: await import("../api/_lib/http.js"),
    handlers: {
      // The ordinary handler route: resolveSupabaseBackend(request).
      "password sign-in": (await import("../api/auth-password-signin.js")).default,
      // The separate provider preamble: unionGroundProvider().
      "calendar feed": (await import("../api/calendar.js")).default,
      // Scheduled ticks: one through the preamble, two that read production
      // directly through productionBackendFromEnv(), one through the cron
      // branch of resolveSupabaseBackend().
      "connect purge (scheduled)": (await import("../api/connect-purge.js")).default,
      "account deletion reconcile (scheduled)": (await import("../api/account-deletion-reconcile.js")).default,
      "upload currency canary (scheduled)": (await import("../api/private-upload-currency-canary.js")).default,
      "organization exports (scheduled)": (await import("../api/organization-exports.js")).default,
    },
  };
}

const cronHeaders = { host: "unionground-cron.vercel.app", "x-vercel-cron": "1", authorization: `Bearer ${CRON_SECRET}` };
const REQUESTS = {
  "password sign-in": () => ({
    method: "POST",
    headers: { host: "preview-unionground.vercel.app" },
    body: { email: "fictional@example.invalid", password: PASSWORD },
  }),
  "calendar feed": () => ({ method: "GET", headers: { host: "preview-unionground.vercel.app" }, query: { token: "t".repeat(40) } }),
  "connect purge (scheduled)": () => ({ method: "GET", headers: { ...cronHeaders } }),
  "account deletion reconcile (scheduled)": () => ({ method: "GET", headers: { ...cronHeaders } }),
  "upload currency canary (scheduled)": () => ({ method: "GET", headers: { ...cronHeaders } }),
  "organization exports (scheduled)": () => ({ method: "GET", headers: { ...cronHeaders } }),
};

function response() {
  return {
    statusCode: 0,
    body: "",
    headers: {},
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; return this; },
    end(body = "") { this.body = String(body); return this; },
    json(payload) { this.body = JSON.stringify(payload); return this; },
    send(body = "") { this.body = String(body); return this; },
  };
}

function interceptTransport() {
  const calls = [];
  vi.stubGlobal("fetch", vi.fn(async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
  }));
  return calls;
}

// NODE_ENV defaults to Vitest's own `test`, which is positive evidence of local
// work; `deployment` sets the other Vercel variables and the explicit opt-in,
// plus any further deployment marker a scenario names.
function stubBackendEnv({ url, ref, vercelEnv = "", nodeEnv = "test", deployment = {} }) {
  vi.stubEnv("VITE_APP_SURFACE", "saas");
  vi.stubEnv("VITE_SUPABASE_URL", url);
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", ref);
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", PUBLISHABLE_KEY);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
  vi.stubEnv("CRON_SECRET", CRON_SECRET);
  vi.stubEnv("VERCEL_ENV", vercelEnv);
  vi.stubEnv("NODE_ENV", nodeEnv);
  for (const key of new Set(["VERCEL", "VERCEL_TARGET_ENV", "VERCEL_URL", "UNIONGROUND_LOCAL_BACKEND", ...Object.keys(deployment)])) {
    vi.stubEnv(key, deployment[key] ?? "");
  }
  for (const key of ["SAMPLE_SUPABASE_URL", "VITE_SAMPLE_SUPABASE_URL", "SAMPLE_SUPABASE_SERVICE_ROLE_KEY", "SAMPLE_PREVIEW_HOSTS"]) vi.stubEnv(key, "");
}

async function runEveryHandler(api) {
  const results = [];
  for (const [name, handler] of Object.entries(api.handlers)) {
    const calls = interceptTransport();
    const res = response();
    await handler(REQUESTS[name](), res);
    results.push({ name, calls, res });
  }
  return results;
}

// Deployment markers beyond VERCEL, VERCEL_ENV, VERCEL_TARGET_ENV and
// VERCEL_URL (#101 final review A-F01 / FB-01): each one alone, with the
// primary four absent, keeps the loopback seam shut under every kind of local
// evidence. VERCEL_FUTURE_MARKER stands for a variable Vercel adds later.
const EXTRA_DEPLOYMENT_MARKERS = [
  "VERCEL_REGION",
  "VERCEL_DEPLOYMENT_ID",
  "VERCEL_PROJECT_ID",
  "VERCEL_BRANCH_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
  "VERCEL_GIT_PROVIDER",
  "VERCEL_FUTURE_MARKER",
  "AWS_LAMBDA_FUNCTION_NAME",
  "AWS_LAMBDA_FUNCTION_VERSION",
  "LAMBDA_TASK_ROOT",
];
const LOCAL_EVIDENCE = [
  { evidence: "NODE_ENV=development", nodeEnv: "development", deployment: {} },
  { evidence: "NODE_ENV=test", nodeEnv: "test", deployment: {} },
  { evidence: "the production-preview opt-in", nodeEnv: "production", deployment: { UNIONGROUND_LOCAL_BACKEND: "1" } },
];
const MARKER_REFUSALS = EXTRA_DEPLOYMENT_MARKERS.flatMap((marker) => LOCAL_EVIDENCE.map(({ evidence, nodeEnv, deployment }) => ({
  name: `loopback with ${marker} alone and ${evidence}`,
  url: LOOPBACK,
  ref: "local",
  nodeEnv,
  deployment: { ...deployment, [marker]: "synthetic-deployment" },
  approve: [],
})));

// Every refused configuration: the operator names the project ref that matches
// the URL wherever one exists, and the fictional table even approves the
// refused origin where that makes sense, so only the rule itself stands between
// the handler and the transport.
const REFUSED = [
  ...SIBLING_REFS.map((ref) => ({
    name: `sibling project ${ref}, matching ref, even if approved`,
    url: `https://${ref}.supabase.co`, ref, approve: [`https://${ref}.supabase.co`, SUPABASE_ORIGIN],
  })),
  { name: "an arbitrary HTTPS origin", url: "https://backend.example.org", ref: "backend", approve: ["https://backend.example.org"] },
  { name: "a mismatching project ref", url: SUPABASE_ORIGIN, ref: "otherproject", approve: [SUPABASE_ORIGIN] },
  { name: "no project ref", url: SUPABASE_ORIGIN, ref: "", approve: [SUPABASE_ORIGIN] },
  { name: "an unapproved Supabase origin", url: "https://unapprovedproject.supabase.co", ref: "unapprovedproject", approve: [SUPABASE_ORIGIN] },
  { name: "a well-formed project under the shipped empty approval table", url: SUPABASE_ORIGIN, ref: SUPABASE_REF, approve: null },
  { name: "a URL with a path", url: `${SUPABASE_ORIGIN}/rest/v1`, ref: SUPABASE_REF, approve: [SUPABASE_ORIGIN] },
  { name: "a hosted origin on a port", url: `${SUPABASE_ORIGIN}:8443`, ref: SUPABASE_REF, approve: [SUPABASE_ORIGIN] },
  { name: "loopback on a production deployment", url: LOOPBACK, ref: "local", vercelEnv: "production", approve: [] },
  { name: "loopback on a preview deployment", url: LOOPBACK, ref: "local", vercelEnv: "preview", approve: [] },
  // The loopback seam needs positive evidence of local work and no sign of a
  // deployment; missing or unexpected deployment metadata is not local.
  { name: "loopback with VERCEL=1 and no VERCEL_ENV", url: LOOPBACK, ref: "local", deployment: { VERCEL: "1" }, approve: [] },
  { name: "loopback with NODE_ENV=production and no deployment metadata", url: LOOPBACK, ref: "local", nodeEnv: "production", approve: [] },
  { name: "loopback with neither NODE_ENV nor the opt-in", url: LOOPBACK, ref: "local", nodeEnv: "", approve: [] },
  { name: "loopback on a custom deployment environment (VERCEL_ENV)", url: LOOPBACK, ref: "local", vercelEnv: "staging", approve: [] },
  { name: "loopback on a custom deployment environment (VERCEL_TARGET_ENV)", url: LOOPBACK, ref: "local", vercelEnv: "preview", deployment: { VERCEL: "1", VERCEL_TARGET_ENV: "staging" }, approve: [] },
  { name: "loopback with a deployment URL only", url: LOOPBACK, ref: "local", deployment: { VERCEL_URL: "unionground-git-branch.vercel.app" }, approve: [] },
  { name: "loopback under Vercel's development environment", url: LOOPBACK, ref: "local", vercelEnv: "development", nodeEnv: "development", approve: [] },
  { name: "loopback with the opt-in on a Vercel deployment", url: LOOPBACK, ref: "local", nodeEnv: "production", deployment: { VERCEL: "1", UNIONGROUND_LOCAL_BACKEND: "1" }, approve: [] },
  { name: "loopback without the local ref", url: LOOPBACK, ref: "project", approve: [] },
  { name: "loopback over https", url: "https://localhost:54321", ref: "local", approve: [] },
  { name: "the IPv6 loopback", url: "http://[::1]:54321", ref: "local", approve: [] },
  { name: "another 127/8 address", url: "http://127.0.0.2:54321", ref: "local", approve: [] },
  ...MARKER_REFUSALS,
];

describe("the one production provider rule refuses before any transport call", () => {
  it.each(REFUSED)("$name: no URL, no key, zero calls from every handler", async ({ url, ref, vercelEnv, nodeEnv, deployment, approve }) => {
    stubBackendEnv({ url, ref, vercelEnv, nodeEnv, deployment });
    const api = await loadApi(approve);

    const decision = api.boundary.productionProviderDecision(process.env);
    expect(decision.ok).toBe(false);
    expect(decision.url).toBe("");
    expect(decision.reason).not.toContain(SERVICE_ROLE_KEY);
    const refusal = { surface: "saas", url: "", publishableKey: "", serviceRoleKey: "", refused: api.boundary.PROVIDER_NOT_APPROVED };
    expect(api.backend.productionBackendFromEnv(process.env)).toEqual(refusal);
    expect(api.backend.resolveSupabaseBackend({ headers: { host: "app.example.invalid" } }, process.env)).toEqual(refusal);
    expect(api.backend.resolveSupabaseBackend({ headers: { ...cronHeaders } }, process.env)).toEqual(refusal);
    const provider = api.http.unionGroundProvider(process.env);
    expect(provider).toMatchObject({ ok: false, supabaseUrl: "", publishableKey: "", serviceRoleKey: "" });

    for (const { name, calls, res } of await runEveryHandler(api)) {
      expect(calls, name).toEqual([]);
      expect(res.statusCode, name).toBeGreaterThanOrEqual(400);
      for (const secret of [SERVICE_ROLE_KEY, PUBLISHABLE_KEY, PASSWORD]) expect(res.body, name).not.toContain(secret);
    }
  });

  // U79-01's reproduction, kept as a regression: a sibling URL with a
  // mismatching ref once made the password handler send the service credential
  // and then the password to the sibling and answer 200.
  it("keeps the password handler off a sibling backend the preamble already refused (U79-01)", async () => {
    stubBackendEnv({ url: `https://${SIBLING_REFS[0]}.supabase.co`, ref: "dedicated-unionground" });
    const api = await loadApi(null);
    expect(api.http.unionGroundProvider().ok).toBe(false);
    expect(api.backend.productionBackendFromEnv().url).toBe("");
    const calls = interceptTransport();
    const res = response();
    await api.handlers["password sign-in"](REQUESTS["password sign-in"](), res);
    expect(calls).toEqual([]);
    expect(res.statusCode).not.toBe(200);
  });
});

describe("what the rule admits", () => {
  // Positive controls: the same handlers and requests do reach the transport
  // when the rule approves, so the zero-call results above are the rule's doing.
  it("an approved origin with its matching ref reaches only that origin", async () => {
    stubBackendEnv({ url: `${SUPABASE_ORIGIN}/`, ref: SUPABASE_REF.toUpperCase() });
    const api = await loadApi([SUPABASE_ORIGIN]);
    expect(api.backend.productionBackendFromEnv()).toEqual({
      surface: "saas", url: SUPABASE_ORIGIN, publishableKey: PUBLISHABLE_KEY, serviceRoleKey: SERVICE_ROLE_KEY,
    });
    expect(api.http.unionGroundProvider()).toMatchObject({ ok: true, supabaseUrl: SUPABASE_ORIGIN, serviceRoleKey: SERVICE_ROLE_KEY });
    for (const { name, calls } of await runEveryHandler(api)) {
      expect(calls.length, name).toBeGreaterThan(0);
      for (const call of calls.filter(({ url }) => !url.startsWith("https://api."))) {
        expect(call.url.startsWith(`${SUPABASE_ORIGIN}/`), `${name}: ${call.url}`).toBe(true);
      }
    }
  });

  it.each([LOOPBACK, "http://localhost:54321", "http://127.0.0.1"])(
    "the loopback development backend %s with ref local, under Vitest and outside a Vercel deployment",
    async (url) => {
      stubBackendEnv({ url, ref: "local" });
      const api = await loadApi(null);
      const origin = new URL(url).origin;
      expect(api.backend.productionBackendFromEnv().url).toBe(origin);
      const { name, calls } = (await runEveryHandler(api)).find((result) => result.name === "password sign-in");
      expect(calls.length, name).toBeGreaterThan(0);
      expect(calls.every((call) => call.url.startsWith(`${origin}/`))).toBe(true);
    },
  );

  it.each([
    { evidence: "Vite's dev server (NODE_ENV=development)", nodeEnv: "development", deployment: {} },
    { evidence: "a local production preview that opts in (UNIONGROUND_LOCAL_BACKEND=1)", nodeEnv: "production", deployment: { UNIONGROUND_LOCAL_BACKEND: "1" } },
  ])("the loopback development backend for $evidence", async ({ nodeEnv, deployment }) => {
    stubBackendEnv({ url: LOOPBACK, ref: "local", nodeEnv, deployment });
    const api = await loadApi(null);
    expect(api.backend.productionBackendFromEnv().url).toBe(LOOPBACK);
    const { name, calls } = (await runEveryHandler(api)).find((result) => result.name === "password sign-in");
    expect(calls.length, name).toBeGreaterThan(0);
    expect(calls.every((call) => call.url.startsWith(`${LOOPBACK}/`))).toBe(true);
  });

  // The build SHA, branch and Vercel CLI token are what this repository's
  // tooling and a developer's shell supply locally, and AWS_REGION,
  // AWS_EXECUTION_ENV and CI are set on developer machines and CI hosts; none
  // of them closes the seam.
  it.each([
    "VERCEL_GIT_COMMIT_SHA",
    "VERCEL_GIT_COMMIT_REF",
    "VERCEL_TOKEN",
    "AWS_REGION",
    "AWS_EXECUTION_ENV",
    "CI",
  ])("the loopback development backend with %s set locally", async (name) => {
    stubBackendEnv({ url: LOOPBACK, ref: "local", nodeEnv: "development", deployment: { [name]: "synthetic-local-value" } });
    const api = await loadApi(null);
    expect(api.boundary.deploymentSignalsIn(process.env)).toEqual([]);
    expect(api.backend.productionBackendFromEnv().url).toBe(LOOPBACK);
    const { name: handler, calls } = (await runEveryHandler(api)).find((result) => result.name === "password sign-in");
    expect(calls.length, handler).toBeGreaterThan(0);
    expect(calls.every((call) => call.url.startsWith(`${LOOPBACK}/`))).toBe(true);
  });
});

describe("the deployment veto list", () => {
  it("names each marker it vetoes on and ignores blank values", async () => {
    const { deploymentSignalsIn } = await import("../api/_lib/providerBoundary.js");
    expect(deploymentSignalsIn({ VERCEL_REGION: "iad1", VERCEL_GIT_COMMIT_SHA: "a".repeat(40), AWS_LAMBDA_FUNCTION_NAME: "fn", NODE_ENV: "development" }))
      .toEqual(["VERCEL_REGION", "AWS_LAMBDA_FUNCTION_NAME"]);
    expect(deploymentSignalsIn({ VERCEL: " ", VERCEL_DEPLOYMENT_ID: "", LAMBDA_TASK_ROOT: "   " })).toEqual([]);
    expect(deploymentSignalsIn({ VERCEL: "0" })).toEqual(["VERCEL"]);
    expect(deploymentSignalsIn({ VERCEL_ENV: "preview" })).toEqual(["VERCEL_ENV"]);
  });

  // Every VERCEL_* name a script or workflow here reads or sets runs outside a
  // deployment too, so each one must be on the reviewed local list in
  // api/_lib/providerBoundary.js; a new one fails here until it is classified.
  it("exempts exactly the VERCEL_* names this repository's scripts and workflows use locally", () => {
    const listed = spawnSync("git", ["ls-files", "scripts", ".github", "vite.config.mjs", "package.json"], { encoding: "utf8" }).stdout.split("\n");
    const texts = listed.filter((path) => /\.(mjs|js|cjs|json|ya?ml|sh)$/.test(path)).map((path) => {
      const source = read(path);
      // Asset carry reads this deployment signal to require a hosted build.
      return path === "scripts/carry-previous-assets.mjs" ? source.replaceAll(/\bVERCEL_ENV\b/g, "") : source;
    });
    // A name declared as a constant (scripts/lib/demo-site.mjs has a few) is
    // code, not an environment variable.
    const constants = new Set(texts.flatMap((text) => [...text.matchAll(/\bconst (VERCEL_[A-Z0-9_]+)\b/g)].map((match) => match[1])));
    const used = new Set(texts.flatMap((text) => [...text.matchAll(/\bVERCEL_[A-Z0-9_]+\b/g)].map((match) => match[0])).filter((name) => !constants.has(name)));
    const source = read("api/_lib/providerBoundary.js");
    const exempt = JSON.parse(source.match(/const LOCAL_VERCEL_NAMES = new Set\((\[[^\]]*\])\);/)[1]);
    expect([...used].sort()).toEqual(["VERCEL_GIT_COMMIT_REF", "VERCEL_GIT_COMMIT_SHA"]);
    for (const name of used) expect(exempt, name).toContain(name);
    expect(exempt.sort()).toEqual(["VERCEL_GIT_COMMIT_REF", "VERCEL_GIT_COMMIT_SHA", "VERCEL_TOKEN"]);
  });
});

// Operator tools that send a service key to a backend take it from the same
// rule. Each refusal happens before any transport call.
describe("operator tools refuse every unapproved backend through the same rule", () => {
  const FOUNDER_ENV = {
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
    RESEND_API_KEY: "synthetic-resend-key",
    NOTIFY_FROM_ADDRESS: "notify@example.invalid",
    INVITATION_APP_ORIGIN: PORTAL_ORIGIN,
  };
  const FOUNDER_COMMANDS = {
    create: ["create", "--organization", "Fictional Organizing Group", "--email", "founder@example.invalid", "--name", "Fictional Founder"],
    resend: ["resend", "--invitation", "22222222-2222-4222-8222-222222222222"],
  };
  const DENIED_BACKENDS = [
    ...SIBLING_REFS.flatMap((ref) => ["VITE_SUPABASE_URL", "SUPABASE_URL"].map((key) => ({
      name: `sibling project ${ref} in ${key}, matching ref`,
      env: { [key]: `https://${ref}.supabase.co`, UNIONGROUND_SUPABASE_PROJECT_REF: ref },
    }))),
    { name: "an arbitrary HTTPS origin", env: { VITE_SUPABASE_URL: "https://backend.example.org", UNIONGROUND_SUPABASE_PROJECT_REF: "backend" } },
    { name: "a well-formed project", env: { SUPABASE_URL: SUPABASE_ORIGIN, UNIONGROUND_SUPABASE_PROJECT_REF: SUPABASE_REF } },
    { name: "loopback with a Vercel variable", env: { VITE_SUPABASE_URL: LOOPBACK, UNIONGROUND_SUPABASE_PROJECT_REF: "local", NODE_ENV: "development", VERCEL: "1" } },
    { name: "loopback with no evidence of local work", env: { VITE_SUPABASE_URL: LOOPBACK, UNIONGROUND_SUPABASE_PROJECT_REF: "local" } },
  ];
  const founderCases = Object.keys(FOUNDER_COMMANDS).flatMap((command) => DENIED_BACKENDS.map((denied) => ({ command, ...denied })));

  it.each(founderCases)("founder $command refuses $name under the shipped empty approval table, zero calls", async ({ command, env }) => {
    useApprovalTable(null);
    const { run } = await import("../scripts/invite-organization-founder.mjs");
    const calls = interceptTransport();
    const lines = [];
    await expect(run(FOUNDER_COMMANDS[command], { ...FOUNDER_ENV, ...env }, (line) => lines.push(line)))
      .rejects.toThrow(/^backend refused before any request: /);
    expect(calls).toEqual([]);
    expect(lines.join("\n")).not.toContain(SERVICE_ROLE_KEY);
  });

  it.each(Object.keys(FOUNDER_COMMANDS))("founder %s refuses URL aliases that disagree, even when one is approved", async (command) => {
    useApprovalTable([SUPABASE_ORIGIN]);
    const { run } = await import("../scripts/invite-organization-founder.mjs");
    const calls = interceptTransport();
    for (const [first, second] of [[SUPABASE_ORIGIN, `https://${SIBLING_REFS[0]}.supabase.co`], [`https://${SIBLING_REFS[0]}.supabase.co`, SUPABASE_ORIGIN]]) {
      const env = { ...FOUNDER_ENV, VITE_SUPABASE_URL: first, SUPABASE_URL: second, UNIONGROUND_SUPABASE_PROJECT_REF: SUPABASE_REF };
      await expect(run(FOUNDER_COMMANDS[command], env, () => {})).rejects.toThrow(/name different backends/);
    }
    expect(calls).toEqual([]);
  });

  it.each(Object.keys(FOUNDER_COMMANDS))("founder %s reaches only an approved backend (positive control)", async (command) => {
    useApprovalTable([SUPABASE_ORIGIN]);
    const { run } = await import("../scripts/invite-organization-founder.mjs");
    const calls = interceptTransport();
    const env = { ...FOUNDER_ENV, SUPABASE_URL: `${SUPABASE_ORIGIN}/`, VITE_SUPABASE_URL: SUPABASE_ORIGIN, UNIONGROUND_SUPABASE_PROJECT_REF: SUPABASE_REF };
    // The intercepted transport answers [], which the command treats as a
    // refusal or an unexpected response; only the destination matters here.
    await run(FOUNDER_COMMANDS[command], env, () => {}).catch(() => {});
    expect(calls).toHaveLength(1);
    expect(calls[0].url.startsWith(`${SUPABASE_ORIGIN}/rest/v1/rpc/`)).toBe(true);
  });

  const maintenanceTarget = (storage, ref) => ({
    SENSITIVE_MAINTENANCE_DB_URL: "postgresql://maintenance@db.example.org:5432/postgres?sslmode=verify-full",
    SENSITIVE_MAINTENANCE_STORAGE_URL: storage,
    SENSITIVE_MAINTENANCE_SERVICE_KEY: SERVICE_ROLE_KEY,
    UNIONGROUND_SUPABASE_PROJECT_REF: ref,
  });

  it.each([
    ...SIBLING_REFS.map((ref) => [`https://${ref}.supabase.co`, ref]),
    ["https://backend.example.org", "backend"],
    [SUPABASE_ORIGIN, SUPABASE_REF],
    [SUPABASE_ORIGIN, "otherproject"],
  ])("sensitive-data maintenance refuses Storage at %s (ref %s) under the shipped empty approval table", async (origin, ref) => {
    useApprovalTable(null);
    const { sensitiveMaintenanceTarget } = await import("../scripts/sensitive-data-rollout.mjs");
    expect(() => sensitiveMaintenanceTarget(maintenanceTarget(origin, ref))).toThrow("sensitive-maintenance-provider-refused");
  });

  it("sensitive-data maintenance accepts an approved pair and a loopback-only lab (positive controls)", async () => {
    useApprovalTable([SUPABASE_ORIGIN]);
    const { sensitiveMaintenanceTarget } = await import("../scripts/sensitive-data-rollout.mjs");
    expect(sensitiveMaintenanceTarget(maintenanceTarget(SUPABASE_ORIGIN, SUPABASE_REF)).origin).toBe(SUPABASE_ORIGIN);
    expect(() => sensitiveMaintenanceTarget(maintenanceTarget(SUPABASE_ORIGIN, "otherproject"))).toThrow("sensitive-maintenance-provider-refused");
    const lab = {
      ...maintenanceTarget("http://127.0.0.1:54321", ""),
      SENSITIVE_MAINTENANCE_DB_URL: "postgresql://postgres@127.0.0.1:54322/postgres",
    };
    expect(sensitiveMaintenanceTarget(lab).origin).toBe("http://127.0.0.1:54321");
  });
});

// The form-filing concurrency proof checked that its database was the owned
// disposable stack but sent its service key to whatever SUPABASE_URL named,
// including from the cleanup it runs after a failure (#101 final review
// FB-02). Here PostgreSQL is simulated as unavailable, so the proof fails and
// runs that cleanup, and fetch is intercepted.
describe("the form-filing concurrency proof sends its service key only to the paired disposable API", () => {
  const DISPOSABLE_DB = "postgresql://postgres:synthetic@127.0.0.1:55999/postgres";
  const PAIRED_API = "http://127.0.0.1:55998";

  afterEach(() => vi.restoreAllMocks());

  async function runProof(apiUrl) {
    vi.resetModules();
    vi.stubEnv("SUPABASE_DB_URL", DISPOSABLE_DB);
    vi.stubEnv("SUPABASE_URL", apiUrl);
    vi.stubEnv("SUPABASE_ANON_KEY", PUBLISHABLE_KEY);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", SERVICE_ROLE_KEY);
    vi.stubEnv("SUPABASE_JWT_SECRET", "j".repeat(40));
    const { default: pg } = await import("pg");
    const connect = vi.spyOn(pg.Client.prototype, "connect").mockRejectedValue(new Error("synthetic-database-unavailable"));
    vi.spyOn(pg.Client.prototype, "query").mockRejectedValue(new Error("synthetic-no-connection"));
    vi.spyOn(pg.Client.prototype, "end").mockResolvedValue(undefined);
    const calls = interceptTransport();
    const error = await import("../scripts/verify-form-filing-concurrency-local.mjs").then(() => null, (failure) => failure);
    return { calls, connect, error };
  }

  it.each([
    ["an unapproved hosted project", "https://unapprovedreview.supabase.co"],
    ["a sibling project", `https://${DENIED_REFS[0]}.supabase.co`],
    ["an arbitrary HTTPS origin", "https://backend.example.org"],
    ["the shared local stack's API, not paired with the database", "http://127.0.0.1:54321"],
    ["a loopback API on the database's own port", "http://127.0.0.1:55999"],
  ])("refuses %s before any client or connection, zero calls", async (_label, apiUrl) => {
    const { calls, connect, error } = await runProof(apiUrl);
    expect(error?.message).toMatch(/owned disposable loopback Supabase API origin/);
    expect(connect).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(error.message).not.toContain(SERVICE_ROLE_KEY);
  });

  it("reaches only the paired disposable API, from the failure cleanup (positive control)", async () => {
    const { calls, connect, error } = await runProof(PAIRED_API);
    expect(error?.message).toBe("synthetic-database-unavailable");
    expect(connect).toHaveBeenCalled();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.url.startsWith(`${PAIRED_API}/storage/v1/object/member-form-files`), call.url).toBe(true);
  });
});

describe("server and tool validators refuse every sibling target from one list", () => {
  it("reads both deny lists from config/sample-backend.json, complete and as digests only", async () => {
    const { FORBIDDEN_APP_HOST_DIGESTS, FORBIDDEN_SUPABASE_REF_DIGESTS } = await import("../src/lib/providerContract.js");
    const sample = JSON.parse(read("config/sample-backend.json"));
    expect([...FORBIDDEN_SUPABASE_REF_DIGESTS]).toEqual(sample.forbiddenSupabaseRefSha256);
    expect([...FORBIDDEN_APP_HOST_DIGESTS]).toEqual(sample.forbiddenAppHostSha256);
    // Five sibling projects, four sibling hosts and nine sibling identifiers
    // and names, plus the fixtures.
    expect(sample.forbiddenSupabaseRefSha256).toHaveLength(5 + SIBLING_REFS.length);
    expect(sample.forbiddenAppHostSha256).toHaveLength(4 + SIBLING_APP_HOSTS.length);
    expect(sample.forbiddenIdentityTokenSha256).toHaveLength(9 + 1);
    for (const digest of [...sample.forbiddenSupabaseRefSha256, ...sample.forbiddenAppHostSha256, ...sample.forbiddenIdentityTokenSha256]) {
      expect(digest).toMatch(DENY_DIGEST_PATTERN);
    }
    for (const ref of SIBLING_REFS) expect(sample.forbiddenSupabaseRefSha256).toContain(denyDigest(ref));
    for (const host of SIBLING_APP_HOSTS) expect(sample.forbiddenAppHostSha256).toContain(denyDigest(host));
    expect(sample.forbiddenIdentityTokenSha256).toContain(denyDigest(DENIED_IDENTITY_TOKEN));
    // The bundle scanner lists names only; projects and hosts come from the digests.
    expect(BUNDLE_FORBIDDEN.filter((value) => /^[a-z]{20}$/.test(value))).toEqual([]);
    // The database contract's deny list stays in lockstep with this one.
    expect([...JSON.parse(read("scripts/db-contract.json")).target.forbiddenProjectRefSha256].sort())
      .toEqual([...sample.forbiddenSupabaseRefSha256].sort());
  });

  it.each(SIBLING_REFS)("refuses the sibling Supabase project %s even with its own ref supplied", async (ref) => {
    const { validateUnionGroundSupabase, validateBrowserProviderEnvironment } = await import("../src/lib/providerContract.js");
    for (const url of [`https://${ref}.supabase.co`, `https://${ref}.supabase.co/`, `https://${ref.toUpperCase()}.supabase.co`]) {
      expect(() => validateUnionGroundSupabase(url, ref), url).toThrow(/Sibling product Supabase project is forbidden/);
      expect(() => validateUnionGroundSupabase(url, ref.toUpperCase(), { allowLocal: true }), url).toThrow(/forbidden/);
    }
    expect(() => validateBrowserProviderEnvironment({
      VITE_SUPABASE_URL: `https://${ref}.supabase.co`,
      VITE_SUPABASE_PUBLISHABLE_KEY: ["sb", "publishable", "fixture", "key0001"].join("_"),
      VITE_UNIONGROUND_SUPABASE_REF: ref,
    })).toThrow(/forbidden/);
  });

  it.each(SIBLING_APP_ORIGINS)("refuses the sibling application origin %s", async (origin) => {
    const { validateUnionGroundAppUrl } = await import("../src/lib/providerContract.js");
    expect(() => validateUnionGroundAppUrl(`${origin}/`)).toThrow(/Sibling product host is forbidden/);
    expect(() => validateUnionGroundAppUrl(`${origin}/`, { allowLocal: true })).toThrow(/forbidden/);
  });

  it("refuses a sibling host only on a label boundary", async () => {
    const { isForbiddenAppHost, validateUnionGroundAppUrl } = await import("../src/lib/providerContract.js");
    for (const host of ["unionground.app", `not${SIBLING_SAAS_HOST}`, `${SIBLING_SAAS_HOST}s`, `${SIBLING_HOST}.example.org`, "other.vercel.app"]) {
      expect(isForbiddenAppHost(host), host).toBe(false);
    }
    expect(validateUnionGroundAppUrl("https://unionground.example.org/").origin).toBe("https://unionground.example.org");
  });

  it("keeps the deny lists out of the modules the browser bundle imports", () => {
    const browserSources = ["src/lib/providerShape.js", "src/lib/supabase.js"].map(read).join("\n");
    const sample = JSON.parse(read("config/sample-backend.json"));
    for (const digest of [...sample.forbiddenSupabaseRefSha256, ...sample.forbiddenAppHostSha256]) expect(browserSources).not.toContain(digest);
    expect(siblingIdentityIn(browserSources)).toEqual([]);
    expect(read("src/lib/supabase.js")).not.toMatch(/from "\.\/providerContract\.js"/);
    expect(read("src/lib/providerContract.js")).not.toMatch(/"[a-z]{20}"/);
  });
});

// The built-bundle identity scanners take both lists from the same source, so a
// target added to config/sample-backend.json is scanned for on both platforms.
describe("the web and native bundle identity scanners cover every maintained sibling target", () => {
  const NATIVE_SCANNER = fileURLToPath(new URL("../apps/mobile/scripts/verify-bundle-identity.mjs", import.meta.url));
  const LEAKS = [
    ...SIBLING_REFS,
    ...SIBLING_APP_HOSTS.flatMap((host) => [`https://${host}/`, `https://www.${host}`, host.toUpperCase(), `team@${host}`]),
  ];
  // Union Ground's own identifiers share letters with a sibling host.
  const OWN = ["org.unionground.app.offline.v1", "https://unionground.app/", `https://my${SIBLING_HOST}`];

  function withBundle(content, check) {
    const dir = mkdtempSync(join(tmpdir(), "unionground-identity-canary-"));
    try {
      mkdirSync(join(dir, "assets"));
      writeFileSync(join(dir, "assets", "leak.js"), `const canary=${JSON.stringify(content)};`);
      return check(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const nativeScan = (dir) => spawnSync(process.execPath, [NATIVE_SCANNER, "--bundle-dir", dir], { encoding: "utf8" });

  it("reads both lists from config/sample-backend.json on both platforms", () => {
    expect(read("scripts/verify-web-bundle-identity.mjs")).toContain('from "./lib/sibling-deny-list.mjs"');
    expect(read("apps/mobile/scripts/verify-bundle-identity.mjs")).toContain("from '../../../scripts/lib/sibling-deny-list.mjs'");
    expect(read("scripts/lib/sibling-deny-list.mjs")).toContain("config/sample-backend.json");
  });

  it.each(LEAKS)("the web scanner flags %s", (leak) => {
    withBundle(leak, (dir) => expect(scanWebBundle(dir).hits.length).toBeGreaterThan(0));
  });

  it.each(LEAKS)("the native scanner flags %s", (leak) => {
    withBundle(leak, (dir) => {
      const result = nativeScan(dir);
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain("names the official app");
    });
  });

  // Forms a URL parser reads as a denied host or project, built from the deny
  // list at run time (#101 final reviews A-F02 / FB-03): a percent-encoded
  // host character, an upper-case project label, a percent-encoded project
  // character, full-width letters and the trailing DNS dot.
  const percent = (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`;
  const fullWidth = (value) => value.replace(/[a-z]/g, (character) => String.fromCharCode(character.charCodeAt(0) + 0xfee0));
  const NORMALIZED_LEAKS = [
    ...DENIED_HOSTS.flatMap((host) => [
      `https://${percent(host[0])}${host.slice(1)}/`,
      `https://${host.slice(0, 2)}${percent(host[2])}${host.slice(3)}/`,
      `https://${fullWidth(host)}/`,
      `https://${host}./`,
    ]),
    ...DENIED_REFS.flatMap((ref) => [
      `https://${ref.toUpperCase()}.supabase.co`,
      `https://${ref[0].toUpperCase()}${ref.slice(1)}.supabase.co`,
      `https://${percent(ref[0])}${ref.slice(1)}.supabase.co`,
    ]),
  ];
  // Hosts that only start with a denied name are someone else's (FB-04). The
  // scanners also deny some hosts as plain text in any context (FORBIDDEN in
  // each scanner); those stay denied, so the control covers the hosts only the
  // host matcher decides.
  const MATCHER_ONLY_HOSTS = DENIED_HOSTS.filter((host) => !BUNDLE_FORBIDDEN.some((value) => value.includes(host)));
  // A denied identifier token (an account id or a private machine name) is
  // flagged wherever it stands as whole words.
  it("both scanners flag a denied identifier token", () => {
    withBundle(`host=${DENIED_IDENTITY_TOKEN}.local`, (dir) => {
      expect(scanWebBundle(dir).hits.join("\n")).toContain(DENIED_IDENTITY_TOKEN);
      expect(nativeScan(dir).status).toBe(1);
    });
  });
  const UNRELATED = MATCHER_ONLY_HOSTS.flatMap((host) => [`https://${host}.example.org/`, `https://${host}.example.org./`, `${host}-mirror.example.org`]);

  it("canaries are well formed: each normalized leak parses to a denied host, each unrelated host does not", () => {
    expect(MATCHER_ONLY_HOSTS.length).toBeGreaterThanOrEqual(2);
    for (const leak of NORMALIZED_LEAKS) {
      const hostname = new URL(leak).hostname.replace(/\.$/, "");
      expect(DENIED_HOSTS.some((host) => hostname === host) || DENIED_REFS.some((ref) => hostname === `${ref}.supabase.co`), leak).toBe(true);
    }
    for (const value of UNRELATED.filter((entry) => entry.startsWith("https://"))) {
      const hostname = new URL(value).hostname.replace(/\.$/, "");
      expect(DENIED_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`)), value).toBe(false);
    }
  });

  it.each(NORMALIZED_LEAKS)("the web scanner flags the normalized form %s", (leak) => {
    withBundle(leak, (dir) => expect(scanWebBundle(dir).hits.length).toBeGreaterThan(0));
  });

  it.each(NORMALIZED_LEAKS)("the native scanner flags the normalized form %s", (leak) => {
    withBundle(leak, (dir) => {
      const result = nativeScan(dir);
      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain("names the official app");
    });
  });

  it.each(UNRELATED)("neither scanner flags the unrelated host %s", (value) => {
    withBundle(value, (dir) => {
      expect(scanWebBundle(dir).hits).toEqual([]);
      const result = nativeScan(dir);
      expect(result.status, result.stdout + result.stderr).toBe(0);
    });
  });

  it.each(OWN)("neither scanner flags Union Ground's own %s", (value) => {
    withBundle(value, (dir) => {
      expect(scanWebBundle(dir).hits).toEqual([]);
      const result = nativeScan(dir);
      expect(result.status, result.stdout + result.stderr).toBe(0);
    });
  });
});
