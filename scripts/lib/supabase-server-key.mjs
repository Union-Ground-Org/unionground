// Server-key source for operator tooling that calls a Supabase project's
// server APIs (Auth admin, PostgREST as service role), record
// OPS-UG-GOTRUE-ADMIN-401-WITH-MANAGEMENT-SERVICE-ROLE-KEY-20261016.
//
// Legacy API keys (the anon and service_role JWTs) were disabled on both
// projects on October 16, 2026, but the Management API still lists the
// legacy service_role entry. Auth answers it with 401 "Legacy API keys are
// disabled", which is the 401 the October 16 hosted window hit. The usable
// server credential is the project's secret key (type "secret",
// sb_secret_...), sent in the apikey header; Auth also accepts it repeated
// as the bearer token. This module never selects the legacy entry, and it
// never prints, logs or returns key material in an error.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

export const MANAGEMENT_API = "https://api.supabase.com";
const PROJECT_REF = /^[a-z]{20}$/u;
const SECRET_KEY = /^sb_secret_[A-Za-z0-9_-]+$/u;

function refuse(code) {
  throw new Error(`supabase-server-key: ${code}`);
}

// The one secret key in a Management API api-keys listing, or the one named
// keyName when a rotation briefly leaves two. Legacy entries are ignored.
export function selectServerKey(keys, { keyName = "" } = {}) {
  if (!Array.isArray(keys)) refuse("key-list-invalid");
  const secrets = keys.filter(key => key?.type === "secret" && typeof key.api_key === "string" && SECRET_KEY.test(key.api_key));
  const chosen = keyName ? secrets.filter(key => key.name === keyName) : secrets;
  if (chosen.length === 0) refuse(keyName ? "named-secret-key-missing" : "secret-key-missing");
  if (chosen.length > 1) refuse("secret-key-ambiguous; pass the key name");
  return { name: chosen[0].name, key: chosen[0].api_key };
}

export function serverKeyHeaders(key) {
  if (typeof key !== "string" || !SECRET_KEY.test(key)) refuse("secret-key-required");
  // Supabase refuses a secret key presented with a browser-shaped User-Agent;
  // pin the same server agent api/_lib/http.js sends.
  return { apikey: key, Authorization: `Bearer ${key}`, "User-Agent": "UnionBase-Server/1.0" };
}

// The Supabase CLI keeps its Management API token in the OS keyring.
export function managementToken({ exec = execFileSync } = {}) {
  let token;
  try {
    token = exec("secret-tool", ["lookup", "service", "Supabase CLI", "username", "supabase"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    token = "";
  }
  if (!token) refuse("supabase-cli-token-missing");
  return token;
}

export async function fetchServerKey(projectRef, { token, keyName = "", fetchImpl = fetch } = {}) {
  if (!PROJECT_REF.test(String(projectRef))) refuse("project-ref-invalid");
  if (!token) refuse("management-token-required");
  const response = await fetchImpl(`${MANAGEMENT_API}/v1/projects/${projectRef}/api-keys?reveal=true`, {
    headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(30000) });
  if (!response.ok) refuse(`api-keys-http-${response.status}`);
  // A parser diagnostic can quote the revealed body, so it never escapes.
  let keys;
  try { keys = await response.json(); } catch { refuse("key-list-invalid"); }
  return selectServerKey(keys, { keyName });
}

// Operator commands that act on a hosted project (founder invitations, join
// requests) take their key from here, record
// BUG-UG-FOUNDER-JOIN-SERVER-KEY-SOURCE-20261022. A Vercel env pull
// returns sensitive variables empty, so an empty SUPABASE_SERVICE_ROLE_KEY
// means "read it from the Management API" for the project the Supabase URL
// names. A non-empty one is used as given (local stacks, tests), except that a
// hosted project only accepts a secret key. Callers print the fingerprint,
// never the key.
const HOSTED = /^https:\/\/([a-z]{20})\.supabase\.co$/u;

export function projectRefFromUrl(supabaseUrl) {
  return HOSTED.exec(String(supabaseUrl).replace(/\/$/u, ""))?.[1] ?? "";
}

export function keyFingerprint(key) {
  return `sha256:${createHash("sha256").update(String(key)).digest("hex").slice(0, 12)}`;
}

export async function resolveServerKey({ supabaseUrl, envKey = "", keyName = "", token = managementToken, fetchImpl = fetch } = {}) {
  const projectRef = projectRefFromUrl(supabaseUrl);
  if (envKey) {
    if (projectRef && !SECRET_KEY.test(envKey)) refuse("environment-key-not-secret; leave SUPABASE_SERVICE_ROLE_KEY empty to read the project's secret key");
    return { key: envKey, source: "environment", name: "", projectRef, fingerprint: keyFingerprint(envKey) };
  }
  if (!projectRef) refuse("no-key-source; set SUPABASE_SERVICE_ROLE_KEY or use a https://<ref>.supabase.co URL");
  const { name, key } = await fetchServerKey(projectRef, { token: token(), keyName, fetchImpl });
  return { key, source: "management-api", name, projectRef, fingerprint: keyFingerprint(key) };
}

export function describeServerKey({ source, name, projectRef, fingerprint }) {
  const where = source === "management-api" ? `secret key "${name}" from the Management API` : "SUPABASE_SERVICE_ROLE_KEY from the environment";
  return `Server key: ${where}${projectRef ? ` for project ${projectRef}` : ""}, fingerprint ${fingerprint}.`;
}
