// Live DB-contract verifier.
//
// The vitest suite reads supabase/migrations/*.sql as text. That is a tripwire:
// it asserts what a migration SAYS. Fifty migrations redefine the same handful
// of functions, so a pin on a superseded generation stays green forever while
// the live object has moved on -- and nothing in a text pin can see a policy
// that was never applied, a grant Supabase's default privileges handed out, or
// a restrictive policy a DO loop skipped because the table did not exist yet.
//
// This reads the catalog instead: pg_proc, pg_policy, has_*_privilege,
// pg_constraint, pg_indexes + pg_index, pg_trigger, pg_publication_tables,
// cron.job. Every expectation lives in scripts/db-contract.json.
//
// Transport is `pg`, not supabase-js, on purpose: PostgREST cannot read
// pg_proc or pg_policy, and has_function_privilege is not reachable through it.
//
//   SUPABASE_DB_URL='postgresql://...' npm run verify:db
//
// Semantics:
//   - SUPABASE_DB_URL unset  -> SKIP, exit 0. CI without the secret stays green.
//   - set, everything agrees -> PASS, exit 0.
//   - set, anything disagrees or the connection fails -> exit 1. A connection
//     error is a HARD FAIL, never a skip: "could not check" must not read as
//     "checked and fine".
//
// Read-only. Not one statement in this file writes.

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { assertExactTarget, postgresSslForTarget, postgresConnectionStringForTarget } from "./lib/assert-exact-target.mjs";
import { canonicaliseCatalogSql } from "./lib/sql-text.mjs";
import { requireDbVerify } from "./lib/require-db-verify.mjs";
import { readRlsTableInventory, assessRlsTables } from "./lib/db-contract-tables.mjs";

const contractPath = process.env.DB_CONTRACT_PATH
  || fileURLToPath(new URL("./db-contract.json", import.meta.url));
const contract = JSON.parse(readFileSync(contractPath, "utf8"));

export function checkRlsTableCoverage(selectedContract, selectedPath, rows) {
  return assessRlsTables(readRlsTableInventory(selectedContract, selectedPath), rows);
}

const failures = [];
const warnings = [];
let checks = 0;
let verificationProfile = "full";

export const DISPOSABLE_APPLICATION_PROFILE = "disposable-application";

export function readPolicyCatalogue(query, policyEntries) {
  // Keep the broad exposed-schema sweep and include explicitly contracted
  // tables elsewhere; a private policy pin must be observable too.
  return query(`select case when n.nspname = 'public' then c.relname else n.nspname || '.' || c.relname end as tbl,
              pol.polname as name, pol.polcmd as cmd, pol.polpermissive as permissive,
              array(select r.rolname::text from pg_roles r where r.oid = any(pol.polroles) order by r.rolname) as roles,
              coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') as qual,
              coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') as with_check
         from pg_policy pol
         join pg_class c on c.oid = pol.polrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('public', 'storage')
           or (n.nspname || '.' || c.relname) = any($1::text[])`,
  [[...new Set(policyEntries.map(entry => entry.table))]]);
}

export function resolveDbVerificationProfile(rawProfile, targetKind) {
  const profile = String(rawProfile || "").trim();
  if (!profile) return "full";
  if (profile !== DISPOSABLE_APPLICATION_PROFILE) {
    throw new Error(`Unsupported DB_VERIFY_PROFILE: ${profile}`);
  }
  if (targetKind !== "confirmed-loopback-disposable") {
    throw new Error(`${DISPOSABLE_APPLICATION_PROFILE} is allowed only on a confirmed loopback disposable target`);
  }
  return profile;
}

export function effectiveExecGrantees(expected, observed, profile) {
  const normalized = new Set(observed);
  // Hosted Supabase makes service_role a member of authenticated. The local
  // CLI substrate does not, even though the application-level EXECUTE surface
  // reachable by authenticated is identical. Normalize only that one implied
  // edge, and only when both contract and catalog independently prove the
  // authenticated grant. Missing authenticated, anon, or PUBLIC never hides.
  if (profile === DISPOSABLE_APPLICATION_PROFILE
      && expected.includes("authenticated")
      && expected.includes("service_role")
      && normalized.has("authenticated")) {
    normalized.add("service_role");
  }
  return [...normalized];
}

export function assessSurplusClientGrants(recordedEntries, liveEntries, profile) {
  const privilegesOf = (value) => String(value || "")
    .split(",")
    .map((privilege) => privilege.trim())
    .filter(Boolean);
  const recorded = new Map(recordedEntries.map((entry) => [
    `${entry.table}|${entry.role}`,
    new Set(privilegesOf(entry.privileges)),
  ]));
  const live = new Map(liveEntries.map((entry) => [
    `${entry.tbl}|${entry.role}`,
    new Set(privilegesOf(entry.privileges)),
  ]));

  if (profile !== DISPOSABLE_APPLICATION_PROFILE) {
    const recordedExact = new Set(recordedEntries.map((entry) =>
      `${entry.table}|${entry.role}|${sortedList(entry.privileges)}`));
    const liveExact = liveEntries.map((entry) =>
      `${entry.tbl}|${entry.role}|${sortedList(entry.privileges.join(","))}`);
    return {
      failures: liveExact.filter((key) => !recordedExact.has(key)),
      present: liveExact.filter((key) => recordedExact.has(key)),
      closed: [...recordedExact].filter((key) => !liveExact.includes(key)),
      narrowed: [],
    };
  }

  const failures = [];
  const present = [];
  const narrowed = [];
  for (const [key, privileges] of live) {
    const upperBound = recorded.get(key);
    if (!upperBound) {
      failures.push(`${key}|${sortedList([...privileges])}`);
      continue;
    }
    const widening = [...privileges].filter((privilege) => !upperBound.has(privilege));
    if (widening.length > 0) {
      failures.push(`${key}|unexpected:${sortedList(widening)}`);
      continue;
    }
    present.push(key);
    const removed = [...upperBound].filter((privilege) => !privileges.has(privilege));
    if (removed.length > 0) narrowed.push(`${key}|removed:${sortedList(removed)}`);
  }
  return {
    failures,
    present,
    narrowed,
    closed: [...recorded.keys()].filter((key) => !live.has(key)),
  };
}

// The grants section resolves each observed row to its pin with .find(), which
// returns the first match. A duplicated {table, role} (or {table, role,
// privilege}) key would leave the later entry unreachable, so a wrong pin could
// hide behind a correct one. Returns the duplicated keys, sorted, once each.
export function duplicateGrantPins(contract) {
  const repeated = (entries, keyOf) => {
    const seen = new Set();
    const duplicates = new Set();
    for (const entry of entries || []) {
      const key = keyOf(entry);
      if (seen.has(key)) duplicates.add(key);
      seen.add(key);
    }
    return [...duplicates].sort();
  };
  return {
    tableGrants: repeated(contract.tableGrants, (entry) => `${entry.table}|${entry.role}`),
    columnGrants: repeated(contract.columnGrants, (entry) => `${entry.table}|${entry.role}|${entry.privilege}`),
  };
}

// A same-name index can exist in both public and private, so a pin resolves to
// the row on its own table first; the first same-name row is kept only so a
// wrong table still reports as a table mismatch. A matching name and
// definition is not enough: a failed CREATE INDEX CONCURRENTLY leaves an index
// that is invalid (the planner never uses it) or unready (writes do not
// maintain it), and pg_indexes lists it all the same. A missing pg_index row
// reads as null and fails too.
export function assessContractIndexes(entries, rows) {
  const results = [];
  const record = (name, ok, expected, observed) => results.push({ name, ok, expected, observed });
  for (const entry of entries || []) {
    const sameName = (rows || []).filter((row) => row.name === entry.name);
    const row = sameName.find((candidate) => candidate.tbl === entry.table) ?? sameName[0];
    record(`index ${entry.name} exists`, Boolean(row), "present", row ? "present" : "NOT FOUND");
    if (!row) continue;
    record(`index ${entry.name} table`, String(entry.table) === String(row.tbl), entry.table, row.tbl);
    for (const needle of entry.defContains) {
      record(`index ${entry.name} definition contains ${needle}`, row.def.includes(needle), needle, row.def);
    }
    record(`index ${entry.name} is valid (pg_index.indisvalid)`, row.valid === true, true, row.valid ?? "MISSING");
    record(`index ${entry.name} is ready (pg_index.indisready)`, row.ready === true, true, row.ready ?? "MISSING");
  }
  return results;
}

function check(name, ok, expected, observed) {
  checks += 1;
  if (!ok) failures.push({ name, expected, observed });
}

function eq(name, expected, observed) {
  check(name, String(expected) === String(observed), expected, observed);
}

function sortedList(value) {
  return String(value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .sort()
    .join(",");
}

// Assigned by runCli() once the target guard has passed; main() reads it. The
// declaration stays at module scope so main() keeps the shape it had when the
// connection was built here.
let client;

async function main() {
  await client.connect();

  const q = (text, values) => client.query(text, values).then((r) => r.rows);

  // The Production drift login reads cron.job through the definer function
  // 20261110021827 adds (it has no cron schema access or BYPASSRLS). Where the
  // function is absent (before that migration) or this login cannot execute it
  // (a role created after the migration got no grant), cron.job is read directly.
  const [cronRoute] = await q(`select coalesce(pg_catalog.has_schema_privilege(current_user, 'private', 'USAGE')
      and pg_catalog.has_function_privilege(current_user, pg_catalog.to_regprocedure('private.ci_drift_cron_jobs()'), 'EXECUTE'), false) as via_function`);
  const cronViaFunction = cronRoute?.via_function === true;

  const [
    functions,
    schemaUsage,
    policies,
    rlsTables,
    grants,
    columns,
    constraints,
    indexes,
    triggers,
    publication,
    cronJobs,
    controls,
    controlColumns,
    surplusGrants,
    vendorGrants,
    roleSettings,
  ] = await Promise.all([
    q(`select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as sig_named,
              n.nspname || '.' || p.proname || '(' || pg_catalog.oidvectortypes(p.proargtypes) || ')' as sig_types,
              p.prosecdef, p.provolatile,
              coalesce(p.proconfig, '{}'::text[]) as cfg,
              array(select r from unnest(array['anon','authenticated','service_role']) r
                    where has_function_privilege(r, p.oid, 'EXECUTE')) as grantees,
              has_function_privilege('supabase_auth_admin', p.oid, 'EXECUTE') as auth_admin_execute,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                      where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_execute,
              md5(pg_get_functiondef(p.oid)) as def_md5,
              md5(p.prosrc) as source_md5,
              lower(pg_get_functiondef(p.oid)) as def
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = any($1::text[]) and p.prokind = 'f'`,
      [contract.functionSweeps.schemas]),

    q(`select s.schema, s.role, has_schema_privilege(s.role, s.schema, 'USAGE') as usage
         from jsonb_to_recordset($1::jsonb) as s(schema text, role text)`,
      [JSON.stringify(contract.schemaUsage)]),

    readPolicyCatalogue(q, contract.policies),

    q(`select c.relname as tbl, c.relrowsecurity as rls
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'r'`),

    q(`select g.tbl, g.role,
              array(select p from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p
                    where has_table_privilege(g.role, g.tbl, p)) as privileges
         from jsonb_to_recordset($1::jsonb) as g(tbl text, role text)`,
      [JSON.stringify((contract.tableGrants || []).map((e) => ({ tbl: e.table, role: e.role })))]),

    q(`select g.tbl, g.role, g.privilege,
              array(select col.attname::text from pg_attribute col
                     where col.attrelid = g.tbl::regclass and col.attnum > 0 and not col.attisdropped
                       and has_column_privilege(g.role, g.tbl, col.attname, g.privilege)
                     order by col.attnum) as columns
         from jsonb_to_recordset($1::jsonb) as g(tbl text, role text, privilege text)`,
      [JSON.stringify((contract.columnGrants || []).map((e) => ({ tbl: e.table, role: e.role, privilege: e.privilege })))]),

    q(`select case when n.nspname = 'public' then c.relname else n.nspname || '.' || c.relname end as tbl,
              con.conname as name, con.convalidated, pg_get_constraintdef(con.oid) as def
         from pg_constraint con
         join pg_class c on c.oid = con.conrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname in ('public', 'private')`),

    q(`select indexname as name,
              case when schemaname = 'public' then tablename else schemaname || '.' || tablename end as tbl,
              indexdef as def,
              x.indisvalid as valid,
              x.indisready as ready
         from pg_indexes
         left join pg_catalog.pg_index x
           on x.indexrelid = (quote_ident(schemaname) || '.' || quote_ident(indexname))::regclass
        where schemaname in ('public', 'private')`),

    q(`select n.nspname as schema, c.relname as tbl, t.tgname as name,
              p.pronamespace::regnamespace::text || '.' || p.proname as fn,
              case when (t.tgtype & 2) > 0 then 'BEFORE'
                   when (t.tgtype & 64) > 0 then 'INSTEAD OF' else 'AFTER' end as timing,
              array(select e from unnest(array['INSERT','DELETE','UPDATE','TRUNCATE']) with ordinality as x(e, i)
                     where (t.tgtype & (1 << (i + 1)::integer)) > 0) as events,
              (t.tgtype & 1) > 0 as for_each_row,
              t.tgenabled as enabled,
              t.tgqual is not null as when_clause
         from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
         join pg_namespace n on n.oid = c.relnamespace
         join pg_proc p on p.oid = t.tgfoid
        where not t.tgisinternal and n.nspname in ('public','auth','private','storage')`),

    q(`select pt.schemaname as schema, pt.tablename as tbl,
              p.pubinsert as insert, p.pubupdate as update, p.pubdelete as delete, p.pubtruncate as truncate
         from pg_publication p
         join pg_publication_tables pt on pt.pubname = p.pubname
        where p.pubname = $1`, [contract.publication.name]),

    q(cronViaFunction
      ? "select jobname, schedule, active, command from private.ci_drift_cron_jobs()"
      : "select jobname, schedule, active, command from cron.job"),

    q(`select count(*)::int as rows, bool_or(outbound_enabled) as outbound_enabled from ${contract.controlPlane.table}`),

    q(`select array(select col.attname::text from pg_attribute col
                     where col.attrelid = $1::regclass and col.attnum > 0 and not col.attisdropped
                     order by col.attnum) as cols`,
      [contract.controlPlane.table]),

    q(`select c.relname as tbl, r.role,
              array(select p from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p
                    where has_table_privilege(r.role, c.oid, p)) as privileges
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        cross join (select unnest(array['anon','authenticated']) as role) r
        where n.nspname = 'public' and c.relkind = 'r'
          and (has_table_privilege(r.role, c.oid, 'INSERT') or has_table_privilege(r.role, c.oid, 'UPDATE')
               or has_table_privilege(r.role, c.oid, 'DELETE') or has_table_privilege(r.role, c.oid, 'TRUNCATE')
               or has_table_privilege(r.role, c.oid, 'REFERENCES') or has_table_privilege(r.role, c.oid, 'TRIGGER')
               or has_table_privilege(r.role, c.oid, 'MAINTAIN'))`),

    // Vendor schemas. Deliberately UNBOUNDED across non-system schemas rather
    // than filtered to a declared list, so a brand-new Supabase schema carrying
    // client grants cannot hide; the declared list is ASSERTED against what this
    // finds. `!~ '^pg_'` and not `not like 'pg\\_%'`: in a JS template literal the
    // backslash-underscore collapses to a bare underscore, which LIKE then reads
    // as a single-char wildcard and silently swallows pgbouncer / pgsodium.
    // relkind covers 'p' (realtime.messages is partitioned) and 'v' (the
    // extensions views) as well as ordinary and materialised tables.
    q(`select * from (
         select n.nspname as schema, n.nspname || '.' || c.relname as tbl, r.role,
                c.relrowsecurity as rls, c.relowner::regrole::text as owner,
                array(select p from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p
                      where has_table_privilege(r.role, c.oid, p)) as privileges
           from pg_class c
           join pg_namespace n on n.oid = c.relnamespace
          cross join (select unnest(array['anon','authenticated']) as role) r
          where n.nspname not in ('public','pg_catalog','information_schema')
            and n.nspname !~ '^pg_'
            and c.relkind in ('r','p','v','m')
       ) t
       where privileges <> '{}'`),

    q(`select want.rolname as role,
              coalesce((select array_agg(x order by x)
                          from pg_db_role_setting s, unnest(s.setconfig) x
                         where s.setrole = r.oid
                           and s.setdatabase in (0, (select oid from pg_database where datname = current_database()))
                       ), '{}'::text[]) as settings
         from unnest($1::text[]) as want(rolname)
         join pg_roles r on r.rolname = want.rolname`,
      [contract.roleSettings.map((e) => e.role)]),
  ]);

  // ---------------------------------------------------------------- functions
  const byNamedSig = new Map(functions.map((row) => [row.sig_named, row]));
  const byTypedSig = new Map(functions.map((row) => [row.sig_types, row]));
  const expectedSearchPath = contract.functionSweeps.searchPathLiteral;

  // Match needles/terms over CODE, not comments: a `-- calls member_has_role`
  // line (or any prose that happens to name a guard) must never satisfy a
  // load-bearing assertion. Same discipline as the vitest text pins. Verified
  // against the live catalog that stripping breaks no existing needle — every
  // bodyContains needle matches real code identically with or without comments.
  // Block comments are stripped too: pg_get_functiondef preserves /* */
  // verbatim, so without this a `/* private.mfa_satisfied() */` husk could
  // satisfy a needle after the real guard was deleted (batch-3 review).
  // Live-verified zero functions currently contain '/*', so this is inert.
  const codeOf = (def) => def.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

  for (const entry of contract.functions) {
    const row = byNamedSig.get(entry.sig);
    check(`function ${entry.sig} resolves`, Boolean(row), "present", row ? "present" : "NOT FOUND");
    if (!row) continue;

    eq(`function ${entry.sig} security definer`, entry.secdef, row.prosecdef);
    if (Object.hasOwn(entry, "volatility")) {
      eq(`function ${entry.sig} volatility`, entry.volatility, row.provolatile);
    }
    if (Object.hasOwn(entry, "authAdminExecute")) {
      eq(`function ${entry.sig} Auth hook EXECUTE`, entry.authAdminExecute, row.auth_admin_execute);
    }
    eq(`function ${entry.sig} search_path pin`, expectedSearchPath,
      row.cfg.find((setting) => setting.startsWith("search_path=")) || "(unpinned)");

    const observedExec = effectiveExecGrantees(
      entry.exec.split(",").filter(Boolean),
      [...row.grantees, ...(row.public_execute ? ["public"] : [])],
      verificationProfile,
    );
    eq(`function ${entry.sig} EXECUTE grantees`, sortedList(entry.exec), sortedList(observedExec.join(",")));

    const extraConfig = row.cfg.filter((setting) => !setting.startsWith("search_path="));
    eq(`function ${entry.sig} extra proconfig`, sortedList((entry.config || []).join(",")), sortedList(extraConfig.join(",")));

    for (const needle of entry.bodyContains || []) {
      check(`function ${entry.sig} body contains ${needle}`, codeOf(row.def).includes(needle.toLowerCase()), needle, "not in the live definition (comments stripped)");
    }

    // The negative twin of bodyContains, for statements a function must NEVER
    // regain. Needles prove a guard is present; forbids prove a hazard stayed
    // out — e.g. remove_chapter_task_file deleting storage.objects in SQL
    // would strand the object's backing bytes invisibly, and every positive
    // needle would still pass.
    for (const needle of entry.bodyForbids || []) {
      check(`function ${entry.sig} body forbids ${needle}`, !codeOf(row.def).includes(needle.toLowerCase()), `absent: ${needle}`, "present in the live definition");
    }

    // bodyMd5 pins the ENTIRE live definition (original case, comments and
    // all): any body change — or→and guard flips and dead-raise edits included
    // — fails until the migration that made it updates the contract md5 in the
    // same commit. Needles prove a guard is PRESENT; the md5 proves nothing
    // else moved.
    if (entry.bodyMd5) {
      eq(`function ${entry.sig} body md5`, entry.bodyMd5, row.def_md5);
    }
    // sourceMd5 pins the exact stored routine body without depending on
    // pg_get_functiondef's header formatting. Use it for trigger functions
    // whose full executable body is the contract, not merely a few needles.
    if (entry.sourceMd5) {
      eq(`function ${entry.sig} source md5`, entry.sourceMd5, row.source_md5);
    }
  }

  for (const entry of contract.functionsAbsent) {
    const present = byTypedSig.has(entry.sig) || byNamedSig.has(entry.sig);
    check(`function ${entry.sig} is absent`, !present, "absent", present ? "RESOLVES — a dropped signature came back" : "absent");
  }

  // Repo-wide sweeps. These replace ~45 per-migration text pins and, unlike
  // them, also cover functions no test file has ever heard of.
  const unpinned = functions
    .filter((row) => row.prosecdef && !row.cfg.includes(expectedSearchPath))
    .map((row) => row.sig_named);
  check("every security definer function pins search_path = ''", unpinned.length === 0, "none", unpinned.join(", ") || "none");

  const publicExecutable = functions
    .filter((row) => row.public_execute && contract.functionSweeps.noPublicExecuteInSchemas.some((s) => row.sig_named.startsWith(`${s}.`)))
    .map((row) => row.sig_named);
  check(`no function in ${contract.functionSweeps.noPublicExecuteInSchemas.join("/")} grants EXECUTE to PUBLIC`,
    publicExecutable.length === 0, "none", publicExecutable.join(", ") || "none");

  const uncontracted = functions
    .filter((row) => !contract.functions.some((entry) => entry.sig === row.sig_named))
    .map((row) => row.sig_named);
  check("every live function in public/private has a contract entry", uncontracted.length === 0,
    "none", uncontracted.join(", ") || "none");

  // --------------------------------------------------------- mfa coverage
  // REQ-UG-DEFINER-MFA-AUDIT. Every SECURITY DEFINER function in public
  // reachable by authenticated bypasses RLS, so each must force MFA step-up
  // itself (private.mfa_satisfied(), or transitively via member_has_role) or be
  // listed exempt. A public function that is neither is a FAILURE — a member RPC
  // added later cannot ship unguarded. `pending` is the staged-rollout ratchet:
  // it WARNs and must shrink to empty as the later batches land.
  const mfaCov = contract.mfaCoverage;
  if (mfaCov) {
    const exemptNames = new Set(Object.keys(mfaCov.exempt || {}));
    const pendingNames = new Set(Object.keys(mfaCov.pending || {}));
    const directGuards = new Set();
    const guardedDelegates = new Map();
    const pronameOf = (sig) => sig.slice(sig.indexOf(".") + 1, sig.indexOf("("));
    for (const [sig, guard] of Object.entries(mfaCov.directGuards || {})) {
      const guarded = byNamedSig.get(sig);
      check(`MFA direct guard ${sig} resolves`, Boolean(guarded), "present", guarded ? "present" : "NOT FOUND");
      if (!guarded) continue;
      const guardedCode = codeOf(guarded.def);
      for (const needle of guard.bodyContains) {
        check(`MFA direct guard ${sig} contains ${needle} — ${guard.reason}`,
          guardedCode.includes(needle.toLowerCase()), needle, "not found");
      }
      directGuards.add(sig);
    }
    for (const [sig, reason] of Object.entries(mfaCov.guardedDelegates || {})) {
      const delegate = byNamedSig.get(sig);
      check(`MFA guard delegate ${sig} resolves`, Boolean(delegate), "present", delegate ? "present" : "NOT FOUND");
      if (!delegate) continue;
      const delegateCode = codeOf(delegate.def);
      check(`MFA guard delegate ${sig} contains a direct assurance proof`,
        mfaCov.termNeedles.some((needle) => delegateCode.includes(needle.toLowerCase())),
        `one of: ${mfaCov.termNeedles.join(", ")}`, "no direct assurance proof found");
      const delegateExec = [...delegate.grantees, ...(delegate.public_execute ? ["public"] : [])];
      check(`MFA guard delegate ${sig} is not directly executable by API roles — ${reason}`,
        delegateExec.length === 0, "no API-role EXECUTE", delegateExec.join(", ") || "none");
      guardedDelegates.set(`${sig.slice(0, sig.indexOf("("))}(`.toLowerCase(), sig);
    }
    for (const [sig, guard] of Object.entries(mfaCov.executableGuardedDelegates || {})) {
      const delegate = byNamedSig.get(sig);
      check(`MFA executable guard delegate ${sig} resolves`, Boolean(delegate), "present", delegate ? "present" : "NOT FOUND");
      if (!delegate) continue;
      const delegateCode = codeOf(delegate.def);
      check(`MFA executable guard delegate ${sig} contains a direct assurance proof`,
        mfaCov.termNeedles.some((needle) => delegateCode.includes(needle.toLowerCase())),
        `one of: ${mfaCov.termNeedles.join(", ")}`, "no direct assurance proof found");
      const expectedExec = [...new Set(guard.roles || [])].sort();
      const delegateExec = [...new Set([
        ...delegate.grantees,
        ...(delegate.public_execute ? ["public"] : []),
      ])].sort();
      check(`MFA executable guard delegate ${sig} has exact API-role EXECUTE — ${guard.reason}`,
        JSON.stringify(delegateExec) === JSON.stringify(expectedExec),
        expectedExec.join(", ") || "none", delegateExec.join(", ") || "none");
      guardedDelegates.set(`${sig.slice(0, sig.indexOf("("))}(`.toLowerCase(), sig);
    }
    // codeOf (comment-strip) is defined once above and shared with the
    // per-function bodyContains loop, so both the term sweep and the needle
    // checks read guards from code only, never from a `-- ...` comment.
    const definerAuthPublic = functions.filter(
      (row) => row.prosecdef && row.sig_named.startsWith("public.") && row.grantees.includes("authenticated"),
    );
    const unguarded = [];
    const seenPending = new Set();
    const seenExempt = new Set();
    for (const row of definerAuthPublic) {
      const defCode = codeOf(row.def);
      if (mfaCov.termNeedles.some((needle) => defCode.includes(needle.toLowerCase()))) continue;
      if (directGuards.has(row.sig_named)) continue;
      if ([...guardedDelegates.keys()].some((needle) => defCode.includes(needle))) continue;
      const proname = pronameOf(row.sig_named);
      if (pendingNames.has(proname)) {
        seenPending.add(proname);
        warnings.push(`mfa coverage PENDING (unguarded, scheduled): ${proname} — ${mfaCov.pending[proname]}`);
        continue;
      }
      if (exemptNames.has(proname)) { seenExempt.add(proname); continue; }
      unguarded.push(proname);
    }
    check("every SECURITY DEFINER public RPC reachable by authenticated forces MFA or is exempt — REQ-UG-DEFINER-MFA-AUDIT",
      unguarded.length === 0, "none unguarded", unguarded.join(", ") || "none");
    // Ratchet hygiene: a pending OR exempt entry that is now guarded (or gone)
    // lingers unless flagged. Both escape lists can only shrink.
    const stalePending = [...pendingNames].filter((name) => !seenPending.has(name));
    if (stalePending.length > 0) {
      warnings.push(`mfaCoverage.pending lists ${stalePending.length} entr${stalePending.length === 1 ? "y" : "ies"} that are now guarded or absent — delete from the contract: ${stalePending.join(", ")}`);
    }
    const staleExempt = [...exemptNames].filter((name) => !seenExempt.has(name));
    if (staleExempt.length > 0) {
      warnings.push(`mfaCoverage.exempt lists ${staleExempt.length} entr${staleExempt.length === 1 ? "y" : "ies"} that are now guarded or absent — re-review and delete from the contract: ${staleExempt.join(", ")}`);
    }
    // The escape lists are keyed by bare proname, so an entry would also cover
    // any FUTURE overload of the same name (a new verify_ballot_receipt(text,
    // uuid) would inherit the old exemption unreviewed). Refuse ambiguity
    // outright: an escape name matching more than one live definer signature
    // fails until the lists are re-reviewed against both.
    const overloads = new Map();
    for (const row of definerAuthPublic) {
      const name = pronameOf(row.sig_named);
      overloads.set(name, (overloads.get(name) || 0) + 1);
    }
    const ambiguous = [...new Set([...exemptNames, ...pendingNames])].filter((name) => (overloads.get(name) || 0) > 1);
    check("no mfaCoverage escape entry matches more than one live signature — name-keyed exemptions must be unambiguous",
      ambiguous.length === 0, "none", ambiguous.join(", ") || "none");
  }

  // --------------------------------------------------------------- schema ACL
  for (const row of schemaUsage) {
    const entry = contract.schemaUsage.find((e) => e.schema === row.schema && e.role === row.role);
    eq(`schema ${row.schema} USAGE for ${row.role}`, entry.usage, row.usage);
  }

  // ----------------------------------------------------------------- policies
  const policyKey = (tbl, name) => `${tbl}.${name}`;
  // pg_get_expr keyword/identifier case differs between cloud and local PG
  // builds. Canonicalisation preserves quoted literal bytes while removing
  // only SQL spelling noise (comments, whitespace, semicolons, identifier
  // case), so a changed literal remains a hard mismatch.
  const policyExpressionContains = (expression, needle) =>
    canonicaliseCatalogSql(expression).includes(canonicaliseCatalogSql(needle));
  const liveByKey = new Map(policies.map((row) => [policyKey(row.tbl, row.name), row]));
  const cmdWord = { r: "SELECT", a: "INSERT", w: "UPDATE", d: "DELETE", "*": "ALL" };

  for (const entry of contract.policies) {
    const key = policyKey(entry.table, entry.name);
    const row = liveByKey.get(key);
    check(`policy ${key} exists`, Boolean(row), "present", row ? "present" : "NOT FOUND");
    if (!row) continue;

    check(`policy ${key} command`, entry.cmd === row.cmd, `${cmdWord[entry.cmd]} (${entry.cmd})`, `${cmdWord[row.cmd]} (${row.cmd})`);
    eq(`policy ${key} permissive`, entry.permissive === undefined ? true : entry.permissive, row.permissive);
    eq(`policy ${key} roles`, sortedList(entry.roles), sortedList(row.roles.join(",")));
    if (entry.qual !== undefined) {
      eq(`policy ${key} qual`, canonicaliseCatalogSql(entry.qual), canonicaliseCatalogSql(row.qual));
    }
    if (entry.withCheck !== undefined) {
      eq(
        `policy ${key} with_check`,
        canonicaliseCatalogSql(entry.withCheck),
        canonicaliseCatalogSql(row.with_check),
      );
    }
    for (const needle of entry.qualContains || []) {
      check(`policy ${key} qual contains ${needle}`, policyExpressionContains(row.qual, needle), needle, row.qual);
    }
    for (const needle of entry.qualExcludes || []) {
      check(`policy ${key} qual excludes ${needle}`, !policyExpressionContains(row.qual, needle), `no ${needle}`, row.qual);
    }
    for (const needle of entry.withCheckContains || []) {
      check(`policy ${key} with_check contains ${needle}`, policyExpressionContains(row.with_check, needle), needle, row.with_check);
    }
    for (const needle of entry.withCheckExcludes || []) {
      check(`policy ${key} with_check excludes ${needle}`, !policyExpressionContains(row.with_check, needle), `no ${needle}`, row.with_check);
    }
  }

  for (const entry of contract.policiesForbidden) {
    const pattern = new RegExp(entry.namePattern);
    const offenders = policies.filter((row) => row.tbl === entry.table && pattern.test(row.name)).map((row) => row.name);
    check(`no ${entry.namePattern} policy on ${entry.table}${entry.why ? ` — ${entry.why}` : ""}`,
      offenders.length === 0, "none", offenders.join(", ") || "none");
  }

  // The mfa_assurance restrictive policy is installed by a DO loop at migration
  // time. A table created by a LATER migration silently misses it, and no text
  // pin anywhere can see that — only this sweep can.
  const coverage = contract.policyCoverage;
  const rlsOn = rlsTables.filter((row) => row.rls).map((row) => row.tbl);
  const noRls = rlsTables.filter((row) => !row.rls).map((row) => row.tbl);
  if (coverage.everyPublicTableHasRls) {
    check("every table in public has row level security enabled", noRls.length === 0, "none without RLS", noRls.join(", ") || "none");
  }
  for (const result of checkRlsTableCoverage(contract, contractPath, rlsTables)) {
    check(result.name, result.ok, result.expected, result.observed);
  }
  console.log(`RLS coverage compared against the public catalog (${rlsOn.length} RLS-enabled tables).`);

  const restrictive = coverage.restrictiveOnEveryRlsTable;
  const missingRestrictive = rlsOn.filter((tbl) => {
    const row = liveByKey.get(policyKey(tbl, restrictive.name));
    return !row || row.permissive || row.cmd !== restrictive.cmd
      || sortedList(row.roles.join(",")) !== sortedList(restrictive.roles)
      || row.qual !== restrictive.qual || row.with_check !== restrictive.withCheck;
  });
  check(`every RLS table carries the ${restrictive.name} restrictive policy — ${restrictive.note}`,
    missingRestrictive.length === 0, "none missing", missingRestrictive.join(", ") || "none");

  for (const tbl of coverage.noPermissivePolicies) {
    const permissive = policies.filter((row) => row.tbl === tbl && row.permissive).map((row) => row.name);
    check(`${tbl} has zero permissive policies`, permissive.length === 0, "none", permissive.join(", ") || "none");
  }

  const allowlist = new Set(coverage.unconditionalPolicyAllowlist);
  const unconditional = policies
    .filter((row) => row.permissive && (row.qual === "true" || row.with_check === "true"))
    .map((row) => policyKey(row.tbl, row.name))
    .filter((key) => !allowlist.has(key));
  check(`no unlisted permissive policy is unconditional — ${coverage.unconditionalAllowlistNote}`,
    unconditional.length === 0, "none", unconditional.join(", ") || "none");

  const smuggled = policies
    .filter((row) => coverage.qualForbiddenSubstrings.some((s) => row.qual.includes(s) || row.with_check.includes(s)))
    .map((row) => policyKey(row.tbl, row.name));
  check("no policy widens itself with an ' or true' escape hatch", smuggled.length === 0, "none", smuggled.join(", ") || "none");

  const protectedPolicyReferences = coverage.protectedRelationPolicyReferences;
  // Deployed-drift jobs intentionally run this head verifier against an older
  // pinned baseline contract. New coverage keys therefore have to be optional
  // until that baseline advances, just like the optional MFA coverage below.
  if (protectedPolicyReferences) {
    const protectedReferenceOffenders = policies
      .filter((row) => row.tbl === protectedPolicyReferences.table)
      .filter((row) => protectedPolicyReferences.forbiddenSubstrings.some((needle) =>
        policyExpressionContains(row.qual, needle) || policyExpressionContains(row.with_check, needle)))
      .map((row) => policyKey(row.tbl, row.name));
    check(`no ${protectedPolicyReferences.table} policy directly references a protected relation — ${protectedPolicyReferences.note}`,
      protectedReferenceOffenders.length === 0, "none", protectedReferenceOffenders.join(", ") || "none");
  }

  // ------------------------------------------------------------------- grants
  // Duplicate keys would leave one entry silently unverified.
  const duplicatePins = duplicateGrantPins(contract);
  check("tableGrants {table, role} keys are unique",
    duplicatePins.tableGrants.length === 0, "none", duplicatePins.tableGrants.join(", ") || "none");
  check("columnGrants {table, role, privilege} keys are unique",
    duplicatePins.columnGrants.length === 0, "none", duplicatePins.columnGrants.join(", ") || "none");

  for (const row of grants) {
    const entry = contract.tableGrants.find((e) => e.table === row.tbl && e.role === row.role);
    eq(`table privileges ${row.tbl} → ${row.role}`, sortedList(entry.privileges), sortedList(row.privileges.join(",")));
  }

  for (const row of columns) {
    const entry = contract.columnGrants.find((e) => e.table === row.tbl && e.role === row.role && e.privilege === row.privilege);
    eq(`${row.privilege} columns ${row.tbl} → ${row.role}`, sortedList(entry.columns), sortedList(row.columns.join(",")));
    for (const denied of entry.denied || []) {
      check(`${row.tbl}.${denied} is NOT ${row.privilege}-able by ${row.role}`,
        !row.columns.includes(denied), `${denied} denied`, row.columns.join(","));
    }
  }

  // -------------------------------------------------------------- constraints
  const constraintByKey = new Map(constraints.map((row) => [`${row.tbl}.${row.name}`, row]));
  for (const entry of contract.constraints) {
    const row = constraintByKey.get(`${entry.table}.${entry.name}`);
    check(`constraint ${entry.table}.${entry.name} exists`, Boolean(row), "present", row ? "present" : "NOT FOUND");
    if (!row) continue;
    // NOT VALID lets existing rows violate the rule forever. A migration that
    // adds a constraint NOT VALID and never validates it reads identically in
    // the SQL text; only convalidated tells them apart.
    eq(`constraint ${entry.table}.${entry.name} is validated`, entry.convalidated, row.convalidated);
    for (const needle of entry.defContains) {
      check(`constraint ${entry.table}.${entry.name} contains ${needle}`, row.def.includes(needle), needle, row.def);
    }
  }
  for (const entry of contract.constraintsAbsent) {
    const present = constraintByKey.has(`${entry.table}.${entry.name}`);
    check(`constraint ${entry.table}.${entry.name} is absent — ${entry.why}`, !present, "absent", present ? "PRESENT" : "absent");
  }

  // ------------------------------------------------------------------ indexes
  for (const result of assessContractIndexes(contract.indexes, indexes)) {
    check(result.name, result.ok, result.expected, result.observed);
  }

  // ----------------------------------------------------------------- triggers
  for (const entry of contract.triggersAbsent || []) {
    const present = triggers.some((t) => t.schema === entry.schema && t.tbl === entry.table && t.name === entry.name);
    check(`trigger ${entry.schema}.${entry.table}.${entry.name} is absent — ${entry.why}`,
      !present, "absent", present ? "PRESENT" : "absent");
  }
  for (const entry of contract.triggers) {
    const row = triggers.find((t) => t.schema === entry.schema && t.tbl === entry.table && t.name === entry.name);
    check(`trigger ${entry.schema}.${entry.table}.${entry.name} exists`, Boolean(row), "present", row ? "present" : "NOT FOUND");
    if (!row) continue;
    eq(`trigger ${entry.name} function`, entry.function, row.fn);
    eq(`trigger ${entry.name} timing`, entry.timing, row.timing);
    eq(`trigger ${entry.name} events`, sortedList(entry.events), sortedList(row.events.join(",")));
    eq(`trigger ${entry.name} for each row`, entry.forEachRow, row.for_each_row);
    eq(`trigger ${entry.name} enabled`, entry.enabled, row.enabled);
    eq(`trigger ${entry.name} has WHEN clause`, entry.whenClause, row.when_clause);
    if (entry.exclusive) {
      const siblings = triggers.filter((t) => t.schema === entry.schema && t.tbl === entry.table).map((t) => t.name);
      check(`trigger ${entry.name} is the only trigger on ${entry.table} — ${entry.note}`,
        siblings.length === 1, entry.name, siblings.join(", "));
    }
    if (entry.exclusiveWith) {
      const siblings = triggers
        .filter((t) => t.schema === entry.schema && t.tbl === entry.table)
        .map((t) => t.name).sort().join(", ");
      const allowed = [entry.name, ...entry.exclusiveWith].sort().join(", ");
      check(`trigger set on ${entry.table} is closed — ${entry.note}`,
        siblings === allowed, allowed, siblings);
    }
  }

  // -------------------------------------------------- publication and pg_cron
  for (const entry of contract.publication.tables) {
    const row = publication.find((p) => p.schema === entry.schema && p.tbl === entry.table);
    check(`${contract.publication.name} publishes ${entry.schema}.${entry.table}`, Boolean(row), "present", row ? "present" : "NOT FOUND");
    if (!row) continue;
    for (const op of ["insert", "update", "delete", "truncate"]) {
      eq(`${contract.publication.name} ${entry.table} pub${op}`, entry[op], row[op]);
    }
  }
  if (contract.publication.exclusive) {
    const extra = publication
      .filter((row) => !contract.publication.tables.some((e) => e.schema === row.schema && e.table === row.tbl))
      .map((row) => `${row.schema}.${row.tbl}`);
    check(`${contract.publication.name} publishes nothing else — ${contract.publication.exclusiveNote}`,
      extra.length === 0, "none", extra.join(", ") || "none");
  }

  for (const entry of contract.cron) {
    const row = cronJobs.find((j) => j.jobname === entry.jobname);
    check(`cron job ${entry.jobname} exists`, Boolean(row), "present", row ? "present" : "NOT FOUND");
    if (!row) continue;
    eq(`cron job ${entry.jobname} schedule`, entry.schedule, row.schedule);
    eq(`cron job ${entry.jobname} active`, entry.active, row.active);
    // Name, schedule and active say nothing about what the job DOES; a job
    // that kept its slot but swapped its command — say, pointing the Vault
    // bearer somewhere else — would pass every check above.
    for (const needle of entry.commandContains || []) {
      check(`cron job ${entry.jobname} command contains ${needle}`,
        String(row.command || "").toLowerCase().includes(needle.toLowerCase()),
        needle, "not in the live command");
    }
  }

  if (contract.controlPlane.expectExactlyOneRow) {
    eq(`${contract.controlPlane.table} row count`, 1, controls[0].rows);
  }
  // The column list was recorded from day one but never consumed, which made
  // it exactly the quietly-untrue artifact the _readme warns about: a dropped
  // files_reconcile_url (or a type-swapped dispatch_url) left verify:db green.
  eq(`${contract.controlPlane.table} columns`, sortedList(contract.controlPlane.columns.join(",")),
    sortedList(controlColumns[0].cols.join(",")));

  // ---------------------------------------------------------------- knownGaps
  // Recorded, not approved. The set may shrink; anything NEW is a failure.
  const gaps = contract.knownGaps;
  const liveGrantRows = surplusGrants
    // Anything with an explicit tableGrants entry is asserted exactly above;
    // it is a contract, not a gap, even when it legitimately includes DELETE.
    .filter((row) => !contract.tableGrants.some((e) => e.table === `public.${row.tbl}` && e.role === row.role));
  const grantAssessment = assessSurplusClientGrants(
    gaps.surplusClientTableGrants.entries,
    liveGrantRows,
    verificationProfile,
  );
  check(`no NEW surplus client table grant — ${gaps.surplusClientTableGrants.why}`,
    grantAssessment.failures.length === 0, "no unrecorded or widened surplus grants", grantAssessment.failures.join(", ") || "none");
  for (const key of grantAssessment.present) {
    warnings.push(`surplus client grant still present: ${key.replaceAll("|", " ")}`);
  }
  for (const key of grantAssessment.narrowed) {
    warnings.push(`surplus client grant narrowed inside its recorded upper bound: ${key.replaceAll("|", " ")}`);
  }
  if (grantAssessment.closed.length > 0) {
    warnings.push(`knownGaps.surplusClientTableGrants lists ${grantAssessment.closed.length} entr${grantAssessment.closed.length === 1 ? "y" : "ies"} that production no longer has — delete them from the contract: ${grantAssessment.closed.join(", ")}`);
  }

  const recordedExec = new Set(gaps.publicExecuteOnPrivateFunctions.entries);
  const livePrivatePublicExec = functions.filter((row) => row.public_execute && row.sig_named.startsWith("private.")).map((row) => row.sig_named);
  const newExec = livePrivatePublicExec.filter((sig) => !recordedExec.has(sig));
  check(`no NEW PUBLIC EXECUTE inside schema private — ${gaps.publicExecuteOnPrivateFunctions.why}`,
    newExec.length === 0, "no unrecorded PUBLIC grants", newExec.join(", ") || "none");
  for (const sig of livePrivatePublicExec.filter((s) => recordedExec.has(s))) {
    warnings.push(`private function still carries the default PUBLIC EXECUTE: ${sig}`);
  }

  // ------------------------------------------- vendor-schema client grants
  // Schemas Supabase owns. Recorded EXACTLY and never ratcheted like the
  // surplus bucket: postgres cannot revoke any of these (their grantor is
  // supabase_admin / supabase_storage_admin / supabase_realtime_admin), so a
  // NEW-key-fails sweep would redden this lane on every platform release with
  // no fix available. What IS worth failing on is a change to a pair already
  // recorded — a privilege widening, an RLS on→off flip, or an ownership
  // change, which would mean a revoke had just become possible.
  const vendor = gaps.vendorSchemaClientGrants;
  if (verificationProfile === DISPOSABLE_APPLICATION_PROFILE) {
    warnings.push("disposable-application profile: hosted vendor schema/grant/owner inventory is intentionally evaluated only by the full deployed-baseline lane");
  } else {
    const vendorLive = new Map(vendorGrants.map((row) => [`${row.tbl}|${row.role}`, row]));
    const vendorSeen = new Set();
    for (const entry of vendor.entries) {
      const key = `${entry.table}|${entry.role}`;
      vendorSeen.add(key);
      const row = vendorLive.get(key);
      const label = `${entry.table} → ${entry.role}`;
      check(`vendor grant ${label} is still live`, Boolean(row), "present", row ? "present" : "NOT FOUND — production dropped it; delete the entry");
      if (!row) continue;
      eq(`vendor grant ${label} privileges`, sortedList(entry.privileges), sortedList(row.privileges.join(",")));
      eq(`vendor grant ${label} RLS`, entry.rls, row.rls);
      eq(`vendor grant ${label} owner — a change to postgres would make a revoke possible`, entry.owner, row.owner);
    }
    // Duplicate keys would leave one entry silently unverified.
    eq("vendorSchemaClientGrants keys are unique", vendor.entries.length, vendorSeen.size);
    // The declared schema list is ASSERTED, not used as a filter: the sweep above
    // is unbounded, so a NEW vendor schema with client grants cannot hide.
    const declaredSchemas = new Set(vendor.schemas);
    const undeclaredSchemas = [...new Set(vendorGrants.map((row) => row.schema))].filter((s) => !declaredSchemas.has(s));
    check(`no client table grant outside the declared vendor schemas (${vendor.schemas.join(", ")})`,
      undeclaredSchemas.length === 0, "none", undeclaredSchemas.join(", ") || "none");
    const unrecordedVendor = [...vendorLive.keys()].filter((key) => !vendorSeen.has(key)).sort();
    if (unrecordedVendor.length > 0) {
      warnings.push(`${unrecordedVendor.length} client grant(s) in a vendor schema are not recorded — a Supabase release added them. Review and record (WARN, not FAIL: we cannot revoke them): ${unrecordedVendor.join(", ")}`);
    }
  }

  // -------------------------------------------------------- role settings
  // PostgREST reads pgrst.db_schemas / db_pre_request / db_anon_role from the
  // authenticator role's pg_db_role_setting when present, and supautils
  // allowlists `pgrst.*` for supabase_privileged_role — which postgres belongs
  // to. So one `alter role authenticator set pgrst.db_schemas = 'public, net'`
  // in a migration would expose net.http_request_queue (INSERT for anon, RLS
  // OFF) and nothing else in this repo would see it. Exact set, both directions.
  //
  // BOUNDARY, written down deliberately: this does NOT cover the Supabase
  // dashboard's "Exposed schemas" field, which is service config leaving no
  // catalog trace — pg_db_role_setting is empty of pgrst.* precisely because the
  // live value lives outside the database, so a dashboard change keeps this
  // green. Seeing that would need an HTTP probe, which does not belong in a lane
  // keyed to a single database credential.
  //
  // join(" | ") rather than sortedList: `session_preload_libraries=supautils,
  // safeupdate` contains a comma that sortedList would split mid-value. The SQL
  // already returns array_agg(... order by x), so both sides are canonically
  // ordered and the contract arrays must be stored in that same order.
  eq("role setconfig rows resolved — a vanished role must not skip its pin", contract.roleSettings.length, roleSettings.length);
  for (const row of roleSettings) {
    const entry = contract.roleSettings.find((e) => e.role === row.role);
    eq(`role ${row.role} setconfig`, entry.settings.join(" | "), row.settings.join(" | "));
  }

  console.log(`outbound dispatch is currently ${controls[0].outbound_enabled ? "ENABLED" : "DISABLED"} (operational state, not contract)`);
}

async function runCli() {
  try {
    readRlsTableInventory(contract, contractPath);
  } catch (error) {
    console.error(`FAIL: invalid RLS table contract: ${error.message}`);
    process.exit(1);
  }
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    // REQUIRE_DB_VERIFY turns the skip into a hard failure. Set it on any CI
    // lane that is SUPPOSED to have the secret, so a silently-empty secret reads
    // as red instead of green (batch-3 review: the PR lane's SUPABASE_DB_URL was
    // empty and every run skipped while looking like a pass). Any non-empty
    // value except "0"/"false" arms it — the flag that guards against
    // misconfiguration must not itself fail open on `true` or `yes`. Every
    // verifier reads it through the one shared helper so that contract cannot
    // drift script by script.
    if (requireDbVerify()) {
      console.error("FAIL: SUPABASE_DB_URL not set but REQUIRE_DB_VERIFY=1 — this lane must verify the live contract.");
      process.exit(1);
    }
    if (process.env.GITHUB_ACTIONS === "true") {
      // Annotate the workflow run: a green check that verified nothing should
      // at least say so where reviewers look.
      console.log("::warning title=verify:db skipped::SUPABASE_DB_URL is not set, so the live DB contract was NOT verified in this run.");
    }
    console.log("SKIP: SUPABASE_DB_URL not set — the DB contract was not verified.");
    console.log("      Set it to the project's pooler/direct connection string to run this check.");
    process.exit(0);
  }

  try {
    const targetKind = assertExactTarget(contract.target, connectionString, {
      disposableConfirm: process.env.DB_VERIFY_DISPOSABLE_CONFIRM,
    });
    verificationProfile = resolveDbVerificationProfile(process.env.DB_VERIFY_PROFILE, targetKind);
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exit(1);
  }

  client = new pg.Client({
    connectionString: postgresConnectionStringForTarget(connectionString),
    // An exact-target loopback alias reaches Supabase's plaintext local port;
    // remote pooler/direct targets stay TLS. The project guard above runs first.
    ssl: postgresSslForTarget(connectionString),
    application_name: "verify-db-contract",
  });

  let exitCode = 0;
  try {
    await main();
  } catch (error) {
    // A connection or query failure with SUPABASE_DB_URL set is a hard failure.
    // "Could not check" must never be reported as "checked and fine".
    console.error(`FAIL: the DB contract could not be verified: ${error.message}`);
    exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }

  if (exitCode === 0) {
    if (warnings.length > 0) {
      console.log("");
      console.log(`WARN — ${warnings.length} recorded gap${warnings.length === 1 ? "" : "s"} still open (see knownGaps in scripts/db-contract.json):`);
      for (const warning of warnings) console.log(`  · ${warning}`);
    }
    if (failures.length > 0) {
      console.error("");
      console.error(`FAIL — ${failures.length} of ${checks} contract checks disagree with ${contract.target.projectRef ?? "the disposable loopback database"}:`);
      for (const failure of failures) {
        console.error(`  ✗ ${failure.name}`);
        console.error(`      expected: ${failure.expected}`);
        console.error(`      observed: ${failure.observed}`);
      }
      console.error("");
      console.error("If a migration deliberately changed one of these, update scripts/db-contract.json in the same commit.");
      console.error("If nothing in supabase/migrations explains it, that is drift — investigate before editing the contract.");
      exitCode = 1;
    } else {
      console.log(`PASS — ${checks} contract checks agree with ${contract.target.projectRef ?? "the disposable loopback database"}.`);
    }
  }

  process.exit(exitCode);
}

// CLI entry behind a main guard. This file used to run the whole verifier —
// process.exit included — at import time, so the sibling verify:rpc lane could
// not import anything from it and kept its own copy of the target guard.
// Everything above is declaration only; importing this module now does nothing.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
