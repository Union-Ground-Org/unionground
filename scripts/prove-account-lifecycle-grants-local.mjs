// Offline scale proof. Only the owned disposable loopback port range is allowed.
// Run after applying the repository migrations; all fixture writes roll back.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import pg from "pg";
import { assertDisposableProofUrl } from "./run-required-db-proofs.mjs";
import { fnBody, loadMigrationSql } from "../tests/helpers/migration.js";

const output = process.argv[2];
if (!output) throw new Error("Pass an output JSON path for retained measurements");
const oldSql = loadMigrationSql("account_lifecycle_manifest");
const newSql = loadMigrationSql("account_lifecycle_grants_lookup");
const bodyOf = sql => fnBody(sql, "private.capture_account_lifecycle_auth_scope()")
  .split("$function$")[1];
const oldBody = bodyOf(oldSql);
const newBody = bodyOf(newSql);
const client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL) });
const stats = async () => (await client.query(`select seq_scan,seq_tup_read,idx_scan,idx_tup_fetch
  from pg_stat_xact_user_tables where schemaname='private' and relname='account_lifecycle_case_scope'`)).rows[0];
const difference = (a, b) => Object.fromEntries(Object.keys(a).map(k => [k, Number(b[k]) - Number(a[k])]));
const report = { fixture: "Tamarack fictional retained scope", rows: 171357, accountsPerCall: 200, calls: 5,
  migrationSha256: createHash("sha256").update(newSql).digest("hex"),
  driverSha256: createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex"), results: {} };
await client.connect();
try {
  await client.query("begin; set local statement_timeout='600s'; set local lock_timeout='5s'");
  // Real Auth users exercise the complete deletion trigger and FK graph.
  await client.query(`create temporary table grants_proof_users as
    select n, ('a17e0000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid id from generate_series(1,1000) n`);
  await client.query(`insert into auth.users(id,email)
    select id,'tamarack-grants-'||n||'@example.invalid' from grants_proof_users`);
  // Match the recorded live cardinality. Most rows carry two grantees; a
  // quarter have no grants. Actor-only rows and duplicate/historic grants
  // exercise all OR branches without modifying any public case contents.
  await client.query(`insert into private.account_lifecycle_case_scope
    (case_id,owner_id,steward_user_id,coordinator_user_id,is_restricted,grants)
    select md5('tamarack-retained-'||source.n)::uuid,
      case when source.n%7=0 then u.id end, case when source.n%11=0 then u.id end,
      case when source.n%13=0 then u.id end, true,
      case when source.n%4=0 then '[]'::jsonb else jsonb_build_array(
        jsonb_build_object('grantee_user_id',case when source.n%5=0 then upper(u.id::text)
          when source.n%5=1 then '{'||u.id::text||'}' when source.n%5=2 then replace(u.id::text,'-','') else u.id::text end,
          'reason','Tamarack retained grant','revoked_at',null),
        jsonb_build_object('grantee_user_id',u.id::text,'reason','Tamarack duplicate grant'),
        jsonb_build_object('grantee_user_id','b17e0000-0000-4000-8000-000000000001','reason','Unrelated retained grant')) end
    from generate_series(1,171357) source(n) join grants_proof_users u on u.n=(source.n-1)%1000+1`);
  await client.query("analyze private.account_lifecycle_case_scope");
  report.postgres = (await client.query("select version() as v")).rows[0].v;
  report.initialRows = Number((await client.query("select count(*) as n from private.account_lifecycle_case_scope")).rows[0].n);
  assert.equal(report.initialRows, report.rows, "Use an otherwise empty disposable scope table");
  for (const [name, body] of [["before", oldBody], ["after", newBody]]) {
    await client.query("savepoint phase");
    if (name === "before") {
      await client.query("drop index private.account_lifecycle_case_scope_grants_lookup_idx");
      await client.query(`create or replace function private.capture_account_lifecycle_auth_scope()
        returns trigger language plpgsql security definer set search_path='' as $proof$${body}$proof$`);
      await client.query(`update private.account_lifecycle_trigger_review r
        set definition_hash=md5(pg_get_functiondef('private.capture_account_lifecycle_auth_scope()'::regprocedure))
        where r.kind='function' and r.schema_name='private' and r.object_name='capture_account_lifecycle_auth_scope()'`);
    }
    await client.query("savepoint explain_plan");
    const update = body.slice(body.indexOf("update private.account_lifecycle_case_scope retained"), body.lastIndexOf("return old;"))
      .trim().replaceAll("old.id", "$1::uuid");
    const plan = (await client.query(`explain (analyze, buffers, format json) ${update}`,
      ["a17e0000-0000-4000-8000-000000000001"])).rows[0]["QUERY PLAN"];
    await client.query("rollback to savepoint explain_plan; release savepoint explain_plan");
    const planText = JSON.stringify(plan);
    assert(planText.includes(name === "after" ? "account_lifecycle_case_scope_grants_lookup_idx" : "Seq Scan"));
    const calls = [];
    for (let call = 0; call < 5; call++) {
      const before = await stats();
      const start = performance.now();
      const deleted = await client.query(`delete from auth.users where id in
        (select id from grants_proof_users where n > $1 and n <= $2)`, [call * 200, (call + 1) * 200]);
      const milliseconds = performance.now() - start;
      assert.equal(deleted.rowCount, 200);
      const delta = difference(before, await stats());
      // Include all retained bytes and order, not just counts, in equivalence.
      const digest = (await client.query(`select md5(string_agg(row_to_json(s)::text,'' order by case_id)) as digest
        from private.account_lifecycle_case_scope s`)).rows[0].digest;
      const observation = { call: call + 1, milliseconds, ...delta, digest };
      calls.push(observation);
      console.log(JSON.stringify({ phase: name, ...observation }));
    }
    report.results[name] = { plan, calls, medianMs: calls.map(c => c.milliseconds).sort((a,b) => a-b)[2] };
    await client.query("rollback to savepoint phase; release savepoint phase");
  }
  assert.deepEqual(report.results.before.calls.map(c => c.digest), report.results.after.calls.map(c => c.digest));
  // One retained-table scan remains in the unchanged AFTER STATEMENT finalizer.
  assert(report.results.after.calls.every(c => c.seq_scan <= 1));
  assert(report.results.before.calls.every(c => c.seq_scan >= 201));
  assert(report.results.after.medianMs < report.results.before.medianMs);
  report.equivalent = true;
  report.observedAtEt = new Date().toLocaleString("en-US", { timeZone: "America/New_York" }) + " ET";
  writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
} finally {
  await client.query("rollback");
  await client.end();
}
