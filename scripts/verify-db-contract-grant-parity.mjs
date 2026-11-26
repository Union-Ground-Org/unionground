#!/usr/bin/env node
// Offline EXECUTE-grantee parity between scripts/db-contract.json and the
// migrations (#7091, following #7071).
//
// scripts/verify-db-contract.mjs compares the contract to a live catalog. Under
// the disposable-application profile its effectiveExecGrantees() adds
// service_role back whenever the contract lists both authenticated and
// service_role, because the local substrate does not make service_role a member
// of authenticated the way hosted Supabase does. That normalization is what let
// a contract entry over-claim service_role on public.update_member_event (nine
// arguments) pass PR and merge-group CI while migration 20261104110000 granted
// only authenticated; the deployed-profile drift job on Main was the first to
// see it.
//
// This reads no database. It replays the function-level GRANT / REVOKE / CREATE
// / DROP statements in supabase/migrations in file order, ends up with the
// EXECUTE grantees each signature has when the last migration has run, and fails
// when the contract names a grantee the migrations leave without. The implied
// edge is not credited here on purpose: on hosted Supabase the explicit ACL is
// what the drift job reads, so a service_role claim needs a migration that
// grants service_role (directly, or through a grant to PUBLIC).
//
// The replay is conservative in one direction only. A new function starts with
// the widest default ACL (PUBLIC, anon, authenticated, service_role) and a
// statement it cannot read (a dynamic EXECUTE string) is invisible to it, so a
// claim is flagged only when no statement it can see could have produced it.
// It never claims a migration grants something the migrations do not say.
//
//   node scripts/verify-db-contract-grant-parity.mjs [--contract <file>] [--migrations <dir>]

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { maskSqlCommentsAndLiterals } from "./lib/sql-text.mjs";

const DEFAULT_CONTRACT = fileURLToPath(new URL("./db-contract.json", import.meta.url));
const DEFAULT_MIGRATIONS = fileURLToPath(new URL("../supabase/migrations", import.meta.url));

// What a freshly created function carries before any REVOKE: Postgres gives
// PUBLIC EXECUTE and Supabase's default privileges give the three API roles.
const NEW_FUNCTION_GRANTEES = ["public", "anon", "authenticated", "service_role"];

const TYPE_ALIASES = {
  timestamptz: "timestamp with time zone",
  timestamp: "timestamp without time zone",
  int: "integer",
  int4: "integer",
  int2: "smallint",
  int8: "bigint",
  bool: "boolean",
  varchar: "character varying",
  "extensions.vector": "vector",
};
const ARG_MODES = new Set(["in", "out", "inout", "variadic"]);

// Split on commas that are not inside parentheses (numeric(10,2)).
export function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") depth -= 1;
    else if (text[i] === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

function canonicalType(raw) {
  const type = raw.trim().replace(/\s+/g, " ").toLowerCase();
  const suffix = type.endsWith("[]") ? "[]" : "";
  const base = (suffix ? type.slice(0, -2) : type).replace(/^public\./, "");
  return (TYPE_ALIASES[base] || base) + suffix;
}

// Words that open a multi-word type, so an unnamed `double precision` argument
// is not read as a parameter called "double".
const TYPE_LEADING_WORDS = new Set(["double", "character", "timestamp", "time", "bit", "national"]);

// schema.name(type, ...) with parameter names, modes and defaults removed, so a
// contract sig, a CREATE FUNCTION header and a GRANT signature reduce alike.
// `named` is true where every argument may carry a parameter name (a CREATE
// header, a contract sig); a GRANT or DROP signature is types only, and there
// only the p_ / a prefixes the migrations use for row aliases are names.
export function signatureKey(signature, { named = false } = {}) {
  const text = signature.replace(/\s+/g, " ").trim();
  const open = text.indexOf("(");
  const name = text.slice(0, open).trim().toLowerCase();
  const args = text.slice(open + 1, text.lastIndexOf(")")).trim();
  const types = splitTopLevel(args).map((arg) => {
    const words = arg.replace(/\s+default\b.*$/i, "").replace(/\s*=\s*.*$/, "").replace(/\(\s*/g, "(").replace(/\s*,\s*/g, ",").replace(/\s*\)/g, ")").trim().split(" ");
    if (ARG_MODES.has(words[0].toLowerCase()) && words.length > 1) words.shift();
    const hasName = words.length > 1 && (named
      ? !TYPE_LEADING_WORDS.has(words[0].toLowerCase())
      : /^(?:p_[a-z0-9_]+|a)$/i.test(words[0]));
    return canonicalType((hasName ? words.slice(1) : words).join(" "));
  });
  return `${name}(${types.join(", ")})`;
}

// The text between the parenthesis at `open` and its partner, plus the index
// after it.
function balanced(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return { inner: text.slice(open + 1, i), end: i + 1 };
    }
  }
  return null;
}

const roleNames = (list) => list.split(",")
  .map((role) => role.trim().toLowerCase().replace(/^group\s+/, ""))
  .filter(Boolean);

// Ordered function-level events in one migration. Comments and quoted literals
// are blanked first, so a statement inside a comment or a string is not read.
export function functionGrantEvents(sql) {
  const text = maskSqlCommentsAndLiterals(sql);
  const events = [];

  const create = /\bcreate\s+(?:or\s+replace\s+)?function\s+([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)\s*\(/gi;
  for (let match = create.exec(text); match; match = create.exec(text)) {
    const open = match.index + match[0].length - 1;
    const args = balanced(text, open);
    if (!args) continue;
    events.push({ offset: match.index, kind: "create", key: signatureKey(`${match[1]}(${args.inner})`, { named: true }) });
  }

  const drop = /\bdrop\s+function\s+(?:if\s+exists\s+)?([^;]+?)\s*(?:cascade|restrict)?\s*;/gi;
  for (let match = drop.exec(text); match; match = drop.exec(text)) {
    for (const signature of splitTopLevel(match[1])) {
      if (signature.includes("(")) events.push({ offset: match.index, kind: "drop", key: signatureKey(signature) });
    }
  }

  const grant = /\bgrant\s+(?:execute|all(?:\s+privileges)?)\s+on\s+function\s+([^;]+?)\s+to\s+([^;]+?)(?:\s+with\s+grant\s+option)?\s*;/gi;
  for (let match = grant.exec(text); match; match = grant.exec(text)) {
    for (const signature of splitTopLevel(match[1])) {
      events.push({ offset: match.index, kind: "grant", key: signatureKey(signature), roles: roleNames(match[2]) });
    }
  }

  // REVOKE GRANT OPTION FOR leaves the privilege in place, so it is not matched.
  const revoke = /\brevoke\s+(?:execute|all(?:\s+privileges)?)\s+on\s+function\s+([^;]+?)\s+from\s+([^;]+?)(?:\s+(?:cascade|restrict))?\s*;/gi;
  for (let match = revoke.exec(text); match; match = revoke.exec(text)) {
    for (const signature of splitTopLevel(match[1])) {
      events.push({ offset: match.index, kind: "revoke", key: signatureKey(signature), roles: roleNames(match[2]) });
    }
  }

  return events.sort((a, b) => a.offset - b.offset);
}

// Replay every migration (callers pass them in apply order) and return
// Map<signatureKey, Set<grantee>> for the functions that still exist.
export function finalFunctionGrantees(migrations) {
  const state = new Map();
  for (const { sql } of migrations) {
    for (const event of functionGrantEvents(sql)) {
      if (event.kind === "create") {
        if (!state.has(event.key)) state.set(event.key, new Set(NEW_FUNCTION_GRANTEES));
      } else if (event.kind === "drop") {
        state.delete(event.key);
      } else {
        // A grant or revoke on a signature no CREATE introduced (an extension
        // function, a baseline object) starts from nothing it can see.
        if (!state.has(event.key)) state.set(event.key, new Set());
        const grantees = state.get(event.key);
        for (const role of event.roles) {
          if (event.kind === "grant") grantees.add(role);
          else grantees.delete(role);
        }
      }
    }
  }
  return state;
}

// Contract entries that name a grantee the migrations leave without. An entry
// whose signature no migration mentions is reported separately: it cannot be
// compared, which is not the same as being wrong.
export function assessGrantParity(contractFunctions, finalGrantees) {
  const overClaims = [];
  const unresolved = [];
  let compared = 0;
  for (const entry of contractFunctions) {
    const claimed = String(entry.exec || "").split(",").map((role) => role.trim()).filter(Boolean);
    const granted = finalGrantees.get(signatureKey(entry.sig, { named: true }));
    if (!granted) {
      if (claimed.length > 0) unresolved.push(entry.sig);
      continue;
    }
    compared += 1;
    const missing = claimed.filter((role) => !granted.has(role));
    if (missing.length > 0) overClaims.push({ sig: entry.sig, claimed, granted: [...granted].sort(), missing });
  }
  return { compared, overClaims, unresolved };
}

export function readMigrations(directory) {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(directory, name), "utf8") }));
}

export function main(argv = process.argv.slice(2)) {
  const option = (flag, fallback) => {
    const index = argv.indexOf(flag);
    return index === -1 ? fallback : argv[index + 1];
  };
  const contract = JSON.parse(readFileSync(option("--contract", DEFAULT_CONTRACT), "utf8"));
  const grantees = finalFunctionGrantees(readMigrations(option("--migrations", DEFAULT_MIGRATIONS)));
  const { compared, overClaims, unresolved } = assessGrantParity(contract.functions, grantees);

  if (overClaims.length > 0) {
    console.error(`DB contract grant parity FAILED: ${overClaims.length} function entr${overClaims.length === 1 ? "y names" : "ies name"} an EXECUTE grantee the migrations never grant.`);
    for (const claim of overClaims) {
      console.error(`  ${claim.sig}\n    contract exec: ${claim.claimed.join(",") || "(none)"}\n    migrations leave: ${claim.granted.join(",") || "(none)"}\n    not granted: ${claim.missing.join(",")}`);
    }
    console.error("Fix the contract entry (or add the migration that grants the role). The disposable-profile normalization in scripts/verify-db-contract.mjs hides this until Main's deployed drift job.");
    return 1;
  }
  console.log(`DB contract grant parity OK: ${compared} function entries compared with the migrations' final EXECUTE grants; ${unresolved.length} name no migration statement and were not compared.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
