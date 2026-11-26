#!/usr/bin/env node
// Operator-only: read and work the public "Request to join" requests
// (REQ-UG-REQUEST-TO-JOIN-PAGE-20261017).
//
// An organization asks for an invitation on https://unionground.net/join. The
// request lands in public.public_interest_submissions with source
// 'request-to-join', readable by no tenant. This command is the owner's read
// and status path: every list and every status change writes one row to
// private.join_request_access_events.
//
//   node --env-file=<production env file> scripts/join-requests.mjs list \
//     [--status new|contacted|closed] [--before <timestamp> --before-id <request id>] [--actor <your name>] [--dry-run]
//   node --env-file=<production env file> scripts/join-requests.mjs status \
//     --id <request id> --to new|contacted|closed [--actor <your name>] [--dry-run]
//
// Needs SUPABASE_URL (or VITE_SUPABASE_URL). With SUPABASE_SERVICE_ROLE_KEY
// empty or unset, the server key is the project's secret key read through the
// Management API (scripts/lib/supabase-server-key.mjs; SUPABASE_SERVER_KEY_NAME
// picks one during a rotation). A dry run resolves the key, prints its
// fingerprint and reads or records nothing. The actor defaults to the operating-system user name. A page holds at most 500
// requests, newest first; when more exist the command prints the exact
// --before and --before-id pair that reads the next, older page (the cursor is
// forwarded as printed, never re-parsed, so no precision is lost). It prints
// the requests to the terminal; it never prints a key, and it never emails
// anyone.
import { userInfo } from "node:os";
import { pathToFileURL } from "node:url";
import { supabaseRpc } from "../api/_lib/http.js";
import { describeServerKey, resolveServerKey } from "./lib/supabase-server-key.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ["new", "contacted", "closed"];

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--dry-run") { flags.dryRun = true; continue; }
    // A flag never takes another flag as its value: "--actor --dry-run" must
    // not turn a dry run into a real one.
    if (!arg.startsWith("--") || i + 1 >= rest.length || rest[i + 1].startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    flags[arg.slice(2)] = rest[i + 1];
    i += 1;
  }
  return { command, flags };
}

export function readConfig(env) {
  const config = {
    supabaseUrl: String(env.SUPABASE_URL || env.VITE_SUPABASE_URL || "").replace(/\/$/, ""),
    serviceKey: String(env.SUPABASE_SERVICE_ROLE_KEY || ""),
    serviceKeyName: String(env.SUPABASE_SERVER_KEY_NAME || ""),
  };
  const missing = Object.entries({
    "SUPABASE_URL or VITE_SUPABASE_URL": config.supabaseUrl,
  }).filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`missing environment: ${missing.join(", ")}`);
  return config;
}

// The configuration with its server key resolved; logs only the fingerprint.
export async function resolveConfig(env, log, { token, fetchImpl } = {}) {
  const config = readConfig(env);
  const resolved = await resolveServerKey({
    supabaseUrl: config.supabaseUrl, envKey: config.serviceKey, keyName: config.serviceKeyName, token, fetchImpl,
  });
  log(describeServerKey(resolved));
  return { ...config, serviceKey: resolved.key };
}

function actorFrom(flags, fallback) {
  const actor = String(flags.actor || fallback || "").trim();
  if (actor.length < 2 || actor.length > 80) throw new Error("--actor must be 2-80 characters");
  return actor;
}

function osUser() {
  try { return userInfo().username; } catch { return ""; }
}

const serviceRpc = (config, name, body) => supabaseRpc(config.supabaseUrl, config.serviceKey, config.serviceKey, name, body);

const SIZE_BANDS = {
  "under-100": "under 100", "100-499": "100-499", "500-1999": "500-1,999", "2000-9999": "2,000-9,999", "10000-plus": "10,000+",
};

/** One request as the lines the operator reads. */
export function formatRequest(request) {
  const when = request.lastSubmittedAt
    ? `${new Date(request.lastSubmittedAt).toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" })} ET`
    : "(unknown time)";
  return [
    `${request.id}  [${request.status}]  ${when}`,
    `  Organization: ${request.organizationName}  (${request.role}, ${request.sizeBand ? `${SIZE_BANDS[request.sizeBand] ?? request.sizeBand} members` : "size not given"}, ${request.state === "outside-us" ? "outside the US" : request.state || "state not given"})`,
    `  Email: ${request.email}${request.phone ? `  Phone: ${request.phone}` : ""}${request.campaignCode ? `  Campaign: ${request.campaignCode}` : ""}`,
    ...(request.note ? [`  Note: ${String(request.note).replace(/\s*\n\s*/g, " / ")}`] : []),
  ];
}

export async function run(argv, env, log = console.log, keySource = {}) {
  const { command, flags } = parseArgs(argv);
  if (command === "list") {
    const status = flags.status ? String(flags.status) : "";
    if (status && !STATUSES.includes(status)) throw new Error("--status must be new, contacted or closed");
    const before = String(flags.before || "").trim();
    const beforeId = String(flags["before-id"] || "").trim();
    if (Boolean(before) !== Boolean(beforeId)) throw new Error("--before and --before-id go together, exactly as a previous page printed them");
    if (before && (before.length > 64 || Number.isNaN(new Date(before).getTime()))) throw new Error("--before must be the timestamp printed by a previous page");
    if (beforeId && !UUID.test(beforeId)) throw new Error("--before-id must be the request id printed by a previous page");
    const actor = actorFrom(flags, osUser());
    const config = await resolveConfig(env, log, keySource);
    if (flags.dryRun) { log("Dry run: would list requests to join. Nothing was read or recorded."); return 0; }
    // The cursor is forwarded exactly as printed: PostgreSQL keeps microseconds
    // that a JavaScript Date would drop, and a rounded cursor could skip a row.
    const result = await serviceRpc(config, "list_join_requests", {
      p_status: status || null, p_actor: actor, p_before: before || null, p_before_id: beforeId || null,
    });
    const requests = Array.isArray(result?.requests) ? result.requests : null;
    if (!requests) throw new Error("unexpected response from list_join_requests");
    log(`${requests.length} request${requests.length === 1 ? "" : "s"}${status ? ` with status ${status}` : ""}${before ? ` before ${before}` : ""} (read recorded for ${actor}).`);
    for (const request of requests) for (const line of formatRequest(request)) log(line);
    if (result.hasMore === true && result.cursorSubmittedAt && result.cursorId) {
      log(`More requests exist. Read the next page with --before ${result.cursorSubmittedAt} --before-id ${result.cursorId}`);
    }
    return 0;
  }
  if (command === "status") {
    const id = String(flags.id || "").trim();
    const to = String(flags.to || "").trim();
    if (!UUID.test(id)) throw new Error("--id must be the request id printed by list");
    if (!STATUSES.includes(to)) throw new Error("--to must be new, contacted or closed");
    const actor = actorFrom(flags, osUser());
    const config = await resolveConfig(env, log, keySource);
    if (flags.dryRun) { log(`Dry run: would set request ${id} to ${to}. Nothing changed.`); return 0; }
    const result = await serviceRpc(config, "set_join_request_status", { p_id: id, p_status: to, p_actor: actor });
    if (result?.updated === true) {
      log(`Request ${id}: ${result.from} -> ${result.status} (recorded for ${actor}).`);
      return 0;
    }
    if (result?.refusal === "not-found") { log(`Refused: no request to join has id ${id}. Nothing changed.`); return 2; }
    if (result?.refusal === "unchanged") { log(`Request ${id} is already ${result.status}. Nothing changed.`); return 2; }
    throw new Error("unexpected response from set_join_request_status");
  }
  throw new Error("usage: join-requests.mjs list|status [flags] (see the file header)");
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  run(process.argv.slice(2), process.env).then(
    (code) => { process.exitCode = code; },
    (error) => { console.error(error.message); process.exitCode = 1; },
  );
}
