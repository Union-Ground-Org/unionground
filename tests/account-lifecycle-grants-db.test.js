// @vitest-environment node
import pg from "pg";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, loadMigrationSql } from "./helpers/migration.js";

const databaseIt = process.env.RUN_ACCOUNT_LIFECYCLE_DB_TESTS === "1" ? it : it.skip;

databaseIt("keeps UUID-equivalent retained grants and removes every former identity path", async () => {
  const client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL) });
  await client.connect();
  const id = "abcdef01-2345-4678-9abc-0123456789ab";
  const other = "abcdef01-2345-4678-9abc-0123456789ac";
  const variants = [id, id.toUpperCase(), `{${id}}`, id.replaceAll("-", ""),
    "abcd-ef01-2345-4678-9abc-0123-4567-89ab"];
  try {
    await client.query("begin");
    await client.query("set local statement_timeout = '90s'");
    const acl = await client.query(`select has_function_privilege(role,
      'private.account_lifecycle_grant_lookup(jsonb)','EXECUTE') as allowed
      from unnest(array['anon','authenticated','service_role']) role`);
    expect(acl.rows.every(r => !r.allowed)).toBe(true);
    const projections = await client.query(`select
      exists(select 1 from jsonb_array_elements(g) e where (e->>'grantee_user_id')::uuid = $2::uuid) as old_match,
      private.account_lifecycle_grant_lookup(g) @> jsonb_build_array(jsonb_build_object('grantee_user_id',$2::text)) as new_match
      from jsonb_array_elements($1::jsonb) g`, [JSON.stringify([
      [], ...variants.map(grantee_user_id => [{ grantee_user_id, reason: "Tamarack retained grant" }]),
      [{ grantee_user_id: other }], [{ grantee_user_id: null }], [{ reason: "no identity" }],
      [{ grantee_user_id: id }, { grantee_user_id: id }, { grantee_user_id: other }],
    ]), id]);
    expect(projections.rows.every(r => r.old_match === r.new_match)).toBe(true);
    expect(projections.rows.filter(r => r.new_match)).toHaveLength(6);
    await client.query("insert into auth.users(id,email) values ($1,'tamarack-grants@example.invalid')", [id]);
    const grants = [...variants.map(grantee_user_id => ({ grantee_user_id, reason: "Tamarack fixture" })),
      { grantee_user_id: other, reason: "keep unrelated", revoked_at: null }];
    await client.query(`insert into private.account_lifecycle_case_scope
      (case_id,owner_id,steward_user_id,coordinator_user_id,is_restricted,grants)
      values ($1,$1,$1,$1,true,$2), ($3,null,null,null,true,$2), ($4,$1,null,null,true,'[]')`,
    [id, JSON.stringify(grants), other, "abcdef01-2345-4678-9abc-0123456789ad"]);
    await client.query("delete from auth.users where id=$1", [id]);
    const rows = (await client.query(`select owner_id,steward_user_id,coordinator_user_id,grants
      from private.account_lifecycle_case_scope where case_id=any($1::uuid[]) order by case_id`,
    [[id, other, "abcdef01-2345-4678-9abc-0123456789ad"]])).rows;
    expect(rows).toEqual([
      { owner_id: null, steward_user_id: null, coordinator_user_id: null, grants: [grants.at(-1)] },
      { owner_id: null, steward_user_id: null, coordinator_user_id: null, grants: [grants.at(-1)] },
      { owner_id: null, steward_user_id: null, coordinator_user_id: null, grants: [] },
    ]);
    await client.query("insert into auth.users(id,email) values ($1,'tamarack-reprovision@example.invalid')", [id]);
    expect((await client.query(`select count(*)::integer as n from private.account_lifecycle_case_scope
      where owner_id=$1 or steward_user_id=$1 or coordinator_user_id=$1
      or private.account_lifecycle_grant_lookup(grants) @> jsonb_build_array(jsonb_build_object('grantee_user_id',$1::text))`, [id])).rows[0].n).toBe(0);
    await client.query("savepoint invalid_uuid");
    await expect(client.query("select private.account_lifecycle_grant_lookup('[{\"grantee_user_id\":\"invalid\"}]')"))
      .rejects.toMatchObject({ code: "22P02" });
    await client.query("rollback to savepoint invalid_uuid");
  } finally {
    await client.query("rollback");
    await client.end();
  }
}, 120_000);

databaseIt("builds the migration index on populated retained scope without changing stored inputs", async () => {
  const client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL) });
  const migration = loadMigrationSql("account_lifecycle_grants_lookup");
  const baseline = fnBody(loadMigrationSql("account_lifecycle_manifest"), "private.capture_account_lifecycle_auth_scope()")
    .replace("create function", "create or replace function");
  await client.connect();
  try {
    await client.query("begin; set local statement_timeout='120s'");
    await client.query("drop index private.account_lifecycle_case_scope_grants_lookup_idx");
    await client.query(baseline);
    await client.query("drop function private.account_lifecycle_grant_lookup(jsonb)");
    await client.query(`delete from private.account_lifecycle_trigger_review
      where kind='function' and schema_name='private' and table_name=''
      and object_name='account_lifecycle_grant_lookup(p_grants jsonb)'`);
    await client.query(`insert into private.account_lifecycle_case_scope(case_id,is_restricted,grants)
      select md5('tamarack-build-'||n)::uuid,true,jsonb_build_array(jsonb_build_object(
        'grantee_user_id',case when n%2=0 then upper(md5('tamarack-grantee-'||(n%1000))::uuid::text)
          else md5('tamarack-grantee-'||(n%1000))::uuid::text end,'reason','Tamarack build fixture'))
      from generate_series(1,171357) n`);
    await client.query("analyze private.account_lifecycle_case_scope");
    const digest = async () => (await client.query(`select md5(string_agg(row_to_json(s)::text,'' order by case_id)) as hash
      from private.account_lifecycle_case_scope s`)).rows[0].hash;
    const before = await digest();
    const started = performance.now();
    // Keep the fixture transaction rollback-only; execute every migration
    // statement apart from its outer transaction boundaries.
    await client.query(migration.replace(/^begin;\s*$/m, "").replace(/^commit;\s*$/m, ""));
    const buildMs = performance.now() - started;
    expect(await digest()).toBe(before);
    const index = (await client.query(`select indisvalid,indisready,pg_relation_size(indexrelid)::integer as bytes
      from pg_index where indexrelid='private.account_lifecycle_case_scope_grants_lookup_idx'::regclass`)).rows[0];
    expect(index.indisvalid && index.indisready && index.bytes > 0).toBe(true);
    const plan = (await client.query(`explain (analyze,buffers,format json) select case_id
      from private.account_lifecycle_case_scope retained
      where owner_id=$1 or steward_user_id=$1 or coordinator_user_id=$1
        or private.account_lifecycle_grant_lookup(grants) @> jsonb_build_array(jsonb_build_object('grantee_user_id',$1::text))`,
    [(await client.query("select md5('tamarack-grantee-1')::uuid as id")).rows[0].id])).rows[0]["QUERY PLAN"];
    expect(JSON.stringify(plan)).toContain("account_lifecycle_case_scope_grants_lookup_idx");
    if (process.env.GRANTS_MIGRATION_PROOF_FILE) {
      writeFileSync(process.env.GRANTS_MIGRATION_PROOF_FILE, JSON.stringify({ rows: 171357, buildMs, index, plan,
        storedInputsUnchanged: true, analyzedAfterBuild: false,
        migrationSha256: createHash("sha256").update(migration).digest("hex"),
        testSha256: createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex"),
        observedAtEt: new Date().toLocaleString("en-US", { timeZone: "America/New_York" }) + " ET",
      }, null, 2) + "\n");
    }
  } finally {
    await client.query("rollback");
    await client.end();
  }
}, 120_000);
