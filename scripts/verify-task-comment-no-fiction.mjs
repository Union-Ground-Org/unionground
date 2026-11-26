#!/usr/bin/env node
// Read-only/null-caller boundary probe over the task-comment surface — the
// required-CI replacement for the quarantined synthetic-identity verify:rpc
// lane. It creates no identity, tenant, chapter, or data row, so it is the
// only live-database behavior lane the binding no-fiction tenancy contract
// permits to run routinely.
//
// What it proves (and ONLY this):
//   1. Catalog grants: authenticated holds SELECT on chapter_task_comments
//      and EXECUTE on add_chapter_task_comment(uuid, text, uuid[]), and holds
//      no table-level or column-level write privilege (INSERT/UPDATE/DELETE/
//      TRUNCATE/REFERENCES/TRIGGER); anon holds neither SELECT nor EXECUTE.
//      Row-level security is enabled and both named comment policies exist.
//   2. A claims-less authenticated session (auth.uid() IS NULL) sees zero
//      rows of chapter_task_comments through RLS. Prelaunch the table is
//      empty, so the zero-row read is vacuously green on its own; the RLS
//      boundary is carried by the relrowsecurity/policy-presence checks, the
//      grant checks, and the RPC refusal until the post-launch
//      identity-backed proof runs.
//   3. The definer RPC refuses that null caller with exact SQLSTATE 42501 and
//      exact message 'authentication required'.
//
// It does NOT prove same-chapter persistence, cross-chapter denial, MFA, or
// role behavior — those need real identities and remain the post-launch
// record TEST-UNION-GROUND-TASK-COMMENT-POSTLAUNCH-PROOF-20260816.
//
// Discipline:
//   - SUPABASE_DB_URL unset -> SKIP, exit 0 (::warning under GitHub Actions;
//     REQUIRE_DB_VERIFY arms the skip into a hard failure).
//   - Exact-project guard runs before any connection.
//   - One BEGIN TRANSACTION READ ONLY; the RPC call sits inside a savepoint;
//     both unwind unconditionally. READ ONLY is defense in depth: SQLSTATE
//     25006 means the authorization guard regressed far enough to attempt a
//     write and is a lane FAILURE, never the expected refusal.
//   - No query argument begins with a SQL write verb; the table is read only
//     as count(*); identity rows are never queried.

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";
import { assertExactTarget, postgresSslForTarget, postgresConnectionStringForTarget } from "./lib/assert-exact-target.mjs";
import { requireDbVerify } from "./lib/require-db-verify.mjs";

const contract = JSON.parse(readFileSync(fileURLToPath(new URL("./db-contract.json", import.meta.url)), "utf8"));

const failures = [];
let checks = 0;
function check(name, ok, expected, observed) {
  checks += 1;
  if (!ok) failures.push({ name, expected, observed });
  console.log(`${ok ? "  ok " : "FAIL "} ${name}${ok ? "" : ` — expected ${expected}, observed ${observed}`}`);
}

async function main(client) {
  const [tableGrants] = (await client.query(
    `select has_table_privilege('authenticated', 'public.chapter_task_comments', 'select') as can_select,
            has_table_privilege('authenticated', 'public.chapter_task_comments', 'insert') as can_insert,
            has_table_privilege('authenticated', 'public.chapter_task_comments', 'update') as can_update,
            has_table_privilege('authenticated', 'public.chapter_task_comments', 'delete') as can_delete,
            has_table_privilege('authenticated', 'public.chapter_task_comments', 'truncate') as can_truncate,
            has_table_privilege('authenticated', 'public.chapter_task_comments', 'references') as can_references,
            has_table_privilege('authenticated', 'public.chapter_task_comments', 'trigger') as can_trigger,
            has_any_column_privilege('authenticated', 'public.chapter_task_comments', 'insert') as any_column_insert,
            has_any_column_privilege('authenticated', 'public.chapter_task_comments', 'update') as any_column_update,
            has_function_privilege('authenticated', 'public.add_chapter_task_comment(uuid, text, uuid[])', 'execute') as can_execute,
            has_table_privilege('anon', 'public.chapter_task_comments', 'select') as anon_select,
            has_function_privilege('anon', 'public.add_chapter_task_comment(uuid, text, uuid[])', 'execute') as anon_execute`,
  )).rows;
  check("authenticated holds SELECT on chapter_task_comments", tableGrants.can_select === true, "true", String(tableGrants.can_select));
  check("authenticated holds EXECUTE on add_chapter_task_comment", tableGrants.can_execute === true, "true", String(tableGrants.can_execute));
  check("authenticated holds no INSERT table privilege", tableGrants.can_insert === false, "false", String(tableGrants.can_insert));
  check("authenticated holds no UPDATE table privilege", tableGrants.can_update === false, "false", String(tableGrants.can_update));
  check("authenticated holds no DELETE table privilege", tableGrants.can_delete === false, "false", String(tableGrants.can_delete));
  check("authenticated holds no TRUNCATE table privilege", tableGrants.can_truncate === false, "false", String(tableGrants.can_truncate));
  check("authenticated holds no REFERENCES table privilege", tableGrants.can_references === false, "false", String(tableGrants.can_references));
  check("authenticated holds no TRIGGER table privilege", tableGrants.can_trigger === false, "false", String(tableGrants.can_trigger));
  check("authenticated holds no column-level INSERT privilege", tableGrants.any_column_insert === false, "false", String(tableGrants.any_column_insert));
  check("authenticated holds no column-level UPDATE privilege", tableGrants.any_column_update === false, "false", String(tableGrants.any_column_update));
  check("anon holds no SELECT on chapter_task_comments", tableGrants.anon_select === false, "false", String(tableGrants.anon_select));
  check("anon holds no EXECUTE on add_chapter_task_comment", tableGrants.anon_execute === false, "false", String(tableGrants.anon_execute));

  const [rowSecurity] = (await client.query(
    `select c.relrowsecurity as rls_enabled,
            (select count(*) from pg_catalog.pg_policies p
              where p.schemaname = 'public'
                and p.tablename = 'chapter_task_comments'
                and p.policyname in ('chapter_task_comments_select_board', 'mfa_assurance')) as named_policies
       from pg_catalog.pg_class c
      where c.oid = 'public.chapter_task_comments'::regclass`,
  )).rows;
  check("row-level security is enabled on chapter_task_comments", rowSecurity.rls_enabled === true, "true", String(rowSecurity.rls_enabled));
  check(
    "both named comment policies exist (select_board + restrictive mfa_assurance)",
    Number(rowSecurity.named_policies) === 2, "2", String(rowSecurity.named_policies),
  );

  await client.query("begin transaction read only");
  await client.query("select set_config('request.jwt.claims', '{}', true)");
  await client.query("set local role authenticated");

  const [visible] = (await client.query("select count(*) from public.chapter_task_comments")).rows;
  check("null caller sees zero task comments through RLS", Number(visible.count) === 0, "0", String(visible.count));

  await client.query("savepoint probe");
  let refusal = null;
  try {
    await client.query("select public.add_chapter_task_comment(null::uuid, 'no-fiction-boundary-probe', '{}'::uuid[])");
  } catch (error) {
    refusal = error;
  } finally {
    await client.query("rollback to savepoint probe");
  }
  check("null caller RPC is refused, not resolved", refusal !== null, "an error", "the call succeeded");
  if (refusal !== null) {
    check(
      "the refusal is not a read-only violation (25006 means the auth guard regressed)",
      refusal.code !== "25006", "any SQLSTATE except 25006", String(refusal.code),
    );
    check("the refusal SQLSTATE is exactly 42501", refusal.code === "42501", "42501", String(refusal.code));
    check(
      "the refusal message is exactly 'authentication required'",
      refusal.message === "authentication required", "authentication required", String(refusal.message),
    );
  }
}

async function runCli() {
  const connectionString = process.env.SUPABASE_DB_URL;
  if (!connectionString) {
    if (requireDbVerify()) {
      console.error("FAIL: SUPABASE_DB_URL not set but REQUIRE_DB_VERIFY=1 — this lane must run the live boundary probe.");
      process.exit(1);
    }
    if (process.env.GITHUB_ACTIONS === "true") {
      console.log("::warning title=verify:task-comment:no-fiction skipped::SUPABASE_DB_URL is not set, so the task-comment no-fiction boundary was NOT verified in this run.");
    }
    console.log("SKIP: SUPABASE_DB_URL not set — the task-comment no-fiction boundary was not verified.");
    process.exit(0);
  }

  try {
    assertExactTarget(contract.target, connectionString, {
      disposableConfirm: process.env.DB_VERIFY_DISPOSABLE_CONFIRM,
    });
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exit(1);
  }

  const client = new pg.Client({
    connectionString: postgresConnectionStringForTarget(connectionString),
    ssl: postgresSslForTarget(connectionString),
    application_name: "verify-task-comment-no-fiction",
  });

  let exitCode = 0;
  try {
    await client.connect();
    await main(client);
  } catch (error) {
    failures.push({
      name: "run",
      expected: "completes",
      observed: [error.message, error.detail, error.where].filter(Boolean).join(" — "),
    });
  } finally {
    try { await client.query("rollback"); } catch { /* never began or already unwound */ }
    await client.end().catch(() => {});
  }

  if (failures.length > 0) {
    console.error(`FAIL — ${failures.length} of ${checks} task-comment boundary probes disagree with ${contract.target.projectRef ?? "the disposable loopback database"}.`);
    for (const f of failures) console.error(`  ${f.name}: expected ${f.expected}, observed ${f.observed}`);
    exitCode = 1;
  } else {
    console.log(`PASS — ${checks} task-comment boundary probes agree with ${contract.target.projectRef ?? "the disposable loopback database"}.`);
  }
  process.exit(exitCode);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
