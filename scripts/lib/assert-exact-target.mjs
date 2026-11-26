// Shared target guard for the live-database verification lane
// (scripts/verify-db-contract.mjs and scripts/verify-rpc-behaviour.mjs). Both
// are handed production by a single credential, so both refuse to run until
// they know exactly which project that credential opens.
//
// A direct
// connection carries the project ref in the hostname (db.<ref>.supabase.co);
// the pooler carries it in the username
// (postgres.<ref>@aws-N-region.pooler.supabase.com). Either is fine; neither
// present is not. Required CI may also use a fresh, runner-owned loopback
// database, but only behind an exact confirmation token and never on either
// shared developer port.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deniedTokensIn, digestSet } from "./denied-identity.mjs";

// The contract's forbiddenProjectRefSha256 lists the sibling product's
// projects by digest (scripts/lib/denied-identity.mjs). Returns the first
// forbidden project ref the text names as a whole word (a host label or a
// pooler user suffix), or null.
export function forbiddenProjectRefIn(target, text) {
  return deniedTokensIn(String(text).toLowerCase(), digestSet(target?.forbiddenProjectRefSha256))[0] ?? null;
}

export const DISPOSABLE_DB_CONFIRM = "pr-ci-disposable";
const SHARED_LOCAL_PORTS = new Set(["54322", "54422"]);

export function isLoopbackPostgresUrl(suppliedUrl) {
  const parsed = new URL(suppliedUrl);
  return parsed.hostname === "127.0.0.1"
    || parsed.hostname === "localhost"
    || parsed.hostname.endsWith(".localhost")
    || parsed.hostname === "::1";
}

// The one TLS posture for every Postgres session opened under scripts/.
// Loopback (only reachable behind the disposable confirmation token above) is
// plaintext; everything else must present a certificate chain that validates,
// so the server is authenticated, not just encrypted. Supabase's direct and
// pooler endpoints chain to Supabase's own root, which is not in Node's store,
// so that root is pinned here (same bytes as the 2026-09-14 hosted-window
// evidence copy).
export const SUPABASE_ROOT_CA = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "supabase-root-2021-ca.crt"),
  "utf8",
);

export function postgresSslForTarget(suppliedUrl) {
  return isLoopbackPostgresUrl(suppliedUrl) ? false : { ca: SUPABASE_ROOT_CA, rejectUnauthorized: true };
}

// pg reparses connectionString after the explicit client options and lets URL
// SSL parameters replace the entire ssl object. Remove those overrides so the
// shared posture above remains authoritative, including its pinned root and
// certificate validation. Preserve credentials, target and unrelated options.
export function postgresConnectionStringForTarget(suppliedUrl) {
  const parsed = new URL(suppliedUrl);
  for (const key of [...parsed.searchParams.keys()]) {
    const normalized = key.toLowerCase();
    if (normalized.startsWith("ssl") || normalized === "uselibpqcompat") {
      parsed.searchParams.delete(key);
    }
  }
  return parsed.toString();
}

export function assertExactTarget(target, suppliedUrl, options = {}) {
  if (!suppliedUrl) throw new Error("SUPABASE_DB_URL is required");
  let parsed;
  try {
    parsed = new URL(suppliedUrl);
  } catch {
    throw new Error("SUPABASE_DB_URL is not a valid connection URL");
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) {
    throw new Error(`SUPABASE_DB_URL must be a postgres:// URL, got ${parsed.protocol}//`);
  }
  if (isLoopbackPostgresUrl(suppliedUrl)) {
    if (options.disposableConfirm !== DISPOSABLE_DB_CONFIRM) {
      throw new Error(`Loopback database verification requires DB_VERIFY_DISPOSABLE_CONFIRM=${DISPOSABLE_DB_CONFIRM}`);
    }
    if (!parsed.port) {
      throw new Error("Disposable loopback database verification requires an explicit port");
    }
    if (SHARED_LOCAL_PORTS.has(parsed.port)) {
      throw new Error(`Refusing shared local Supabase database port ${parsed.port}`);
    }
    return "confirmed-loopback-disposable";
  }
  const haystack = `${parsed.hostname}|${decodeURIComponent(parsed.username)}`;
  const forbidden = forbiddenProjectRefIn(target, haystack);
  if (forbidden) throw new Error(`Forbidden legacy Supabase project: ${forbidden}`);
  // Union Ground has no provisioned database yet, so the contract carries no
  // project ref. Without one there is nothing a hosted URL could be checked
  // against, and every hosted target is refused rather than matched loosely.
  if (typeof target.projectRef !== "string" || !/^[a-z]{20}$/.test(target.projectRef)) {
    throw new Error(
      "No Union Ground database target is provisioned: scripts/db-contract.json names no project, "
      + "so only the confirmed disposable loopback database can be verified.",
    );
  }
  if (!haystack.includes(target.projectRef)) {
    throw new Error(
      `Target mismatch: the contract is written against project ${target.projectRef} `
      + `(${target.hostForm}) and SUPABASE_DB_URL points somewhere else. Verifying a `
      + "different database against this contract would produce meaningless diffs.",
    );
  }
  return target.projectRef;
}
