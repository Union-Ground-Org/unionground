// The one rule that decides whether the API may use the configured production
// backend. Every production URL and key the API hands out passes through
// approvedProductionBackend(): resolveSupabaseBackend() and
// productionBackendFromEnv() in ./backend.js (the ordinary handler route and
// the scheduled jobs that read the environment directly), and
// unionGroundProvider() in ./http.js. No caller reads VITE_SUPABASE_URL or a
// key from the environment on its own.
//
// A configured backend is used only when one of these holds; anything else is
// refused and yields no URL and no key:
//
// 1. Source-approved. VITE_SUPABASE_URL is a bare https://<ref>.supabase.co
//    origin, UNIONGROUND_SUPABASE_PROJECT_REF is exactly that <ref>, the ref
//    is not a sibling product's project (config/sample-backend.json), and the
//    origin is a backend of an owner-approved pair in src/lib/trustedBackends.js.
//    That table is empty until the owner approves a dedicated Union Ground
//    project, so today every hosted backend is refused.
// 2. Loopback development. VITE_SUPABASE_URL is a bare http:// origin on
//    127.0.0.1 or localhost (any port; no path, credentials, query or fragment),
//    UNIONGROUND_SUPABASE_PROJECT_REF is exactly `local`, and the process
//    shows positive evidence of local work and no sign of a deployment
//    (localDevelopmentSeamOpen below). Nothing else counts as loopback: not
//    [::1], not another 127.x address, not https, not a name that resolves to
//    loopback.
import { validateUnionGroundSupabase } from "../../src/lib/providerContract.js";
import { TRUSTED_BACKEND_PORTALS } from "../../src/lib/trustedBackends.js";

export const PROVIDER_NOT_APPROVED = "provider-not-approved";

// Signs of a deployment. Any one of them, with any non-blank value, keeps the
// loopback seam shut: a missing, custom or unexpected value is a deployment we
// cannot classify, not local development. This list and its reasoning live
// here only.
//
// - `VERCEL` and every `VERCEL_*` variable. A deployed function carries VERCEL,
//   VERCEL_ENV, VERCEL_URL, VERCEL_REGION, VERCEL_DEPLOYMENT_ID,
//   VERCEL_PROJECT_ID and others, and Vercel may add more; matching the whole
//   prefix covers the ones not named here. This repository's local work never
//   runs under `vercel dev`.
// - except LOCAL_VERCEL_NAMES: the only `VERCEL_*` names this repository's
//   tooling reads or a developer supplies outside a deployment. Each is
//   build-time or operator input and none is proof of a running deployment;
//   a deployed function also carries VERCEL and the rest, so exempting them
//   opens nothing there. VERCEL_GIT_COMMIT_SHA is the build SHA vite.config.mjs
//   and scripts/build-demo-site.mjs read (an operator may pin it locally);
//   VERCEL_GIT_COMMIT_REF is the branch scripts/demo-ignored-build-step.mjs
//   reads; VERCEL_TOKEN is the Vercel CLI's own credential in a developer's
//   shell. No workflow under .github/ sets a `VERCEL_*` name. Tests stub
//   VERCEL_URL, VERCEL_ENV, VERCEL_BRANCH_URL and VERCEL_PROJECT_PRODUCTION_URL
//   only to model a deployment, so they veto.
// - The serverless runtime underneath (Vercel's Node functions run on AWS
//   Lambda), which sets these on every invocation whatever the project's
//   environment settings say: AWS_LAMBDA_FUNCTION_NAME and the rest of
//   LAMBDA_RUNTIME_SIGNALS, all three Lambda-only. AWS_REGION and
//   AWS_EXECUTION_ENV are not: a developer's AWS CLI sets the first, and
//   container CI hosts set the second.
const LOCAL_VERCEL_NAMES = new Set(["VERCEL_GIT_COMMIT_SHA", "VERCEL_GIT_COMMIT_REF", "VERCEL_TOKEN"]);
const LAMBDA_RUNTIME_SIGNALS = ["AWS_LAMBDA_FUNCTION_NAME", "AWS_LAMBDA_FUNCTION_VERSION", "LAMBDA_TASK_ROOT"];

export function deploymentSignalsIn(env) {
  return Object.keys(env || {}).filter((key) => envValue(env, key) && (
    ((key === "VERCEL" || key.startsWith("VERCEL_")) && !LOCAL_VERCEL_NAMES.has(key))
    || LAMBDA_RUNTIME_SIGNALS.includes(key)
  ));
}

// Positive evidence of local work. Vite's dev server sets NODE_ENV=development
// (`npm run dev`) and Vitest sets NODE_ENV=test. A local production preview has
// neither (`vite preview` sets NODE_ENV=production), so the browser-assurance
// harness (scripts/lib/web-performance-budget.mjs) opts in with
// UNIONGROUND_LOCAL_BACKEND=1. A missing NODE_ENV is not evidence.
const LOCAL_NODE_ENVS = new Set(["development", "test"]);

function envValue(env, key) {
  return String(env?.[key] || "").trim();
}

export function localDevelopmentSeamOpen(env) {
  if (deploymentSignalsIn(env).length > 0) return false;
  return LOCAL_NODE_ENVS.has(envValue(env, "NODE_ENV").toLowerCase())
    || envValue(env, "UNIONGROUND_LOCAL_BACKEND") === "1";
}

function approvedOrigins() {
  return Object.keys(TRUSTED_BACKEND_PORTALS).map((origin) => String(origin).trim().replace(/\/$/, ""));
}

// `reason` is for operator logs only: it names environment variables and the
// rule that refused them, never a URL or a key.
export function productionProviderDecision(env = process.env) {
  const configuredUrl = envValue(env, "VITE_SUPABASE_URL");
  if (!configuredUrl) return { ok: false, url: "", reason: "VITE_SUPABASE_URL is not configured" };
  const allowLocal = localDevelopmentSeamOpen(env);
  let url;
  try {
    url = validateUnionGroundSupabase(configuredUrl, envValue(env, "UNIONGROUND_SUPABASE_PROJECT_REF"), { allowLocal });
  } catch (error) {
    return { ok: false, url: "", reason: String(error?.message || "provider contract rejected the configured Supabase target") };
  }
  if (url.protocol === "http:") return { ok: true, url: url.origin, reason: "" };
  if (!approvedOrigins().includes(url.origin)) {
    return {
      ok: false,
      url: "",
      reason: "VITE_SUPABASE_URL is not a source-approved Union Ground backend (src/lib/trustedBackends.js)",
    };
  }
  return { ok: true, url: url.origin, reason: "" };
}

export function approvedProductionBackend(env = process.env) {
  const decision = productionProviderDecision(env);
  if (!decision.ok) {
    return { surface: "saas", url: "", publishableKey: "", serviceRoleKey: "", refused: PROVIDER_NOT_APPROVED };
  }
  return {
    surface: "saas",
    url: decision.url,
    publishableKey: envValue(env, "VITE_SUPABASE_PUBLISHABLE_KEY"),
    serviceRoleKey: envValue(env, "SUPABASE_SERVICE_ROLE_KEY"),
  };
}
