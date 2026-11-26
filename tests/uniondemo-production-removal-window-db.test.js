import { installRetiredSeedUpgradeFixture } from './helpers/retired-seed-upgrade-fixture.mjs';
// @vitest-environment node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.REQUIRE_DB_REPAIR_PROOFS === "1" ? describe : describe.skip;
const productionRef = "productionprojectref";
const sampleRef = "sampledemoprojectref";
const runId = "109141a8-bb29-4b02-af4f-f00ff45ba2ea";
const fixtureConfirmation = "disposable-owner-attended-window-proof";
const fixtureDigest = createHash("sha256").update(fixtureConfirmation).digest("hex");
const guardName = "private.uniondemo_production_removal_authorize";
const guardSignature = `${guardName}(text,uuid,text,text)`;
const actorGuardName = "private.uniondemo_production_removal_actors_owned";
const actorGuardSignature = `${actorGuardName}(uuid,jsonb,boolean)`;
const stampSignature = "private.uniondemo_production_removal_stamp_window()";
const routed = [
  "public.remove_mi1_knowledge_sample(text,uuid,text,text)",
  "public.uniondemo_remove_function_parity(uuid,text,text)",
  "public.uniondemo_begin_remove(uuid,text,text)",
  "public.uniondemo_remove_batch(uuid,integer,text,text)",
];

function migrationBody(name) {
  const source = readFileSync(new URL(`../supabase/migrations/${name}`, import.meta.url), "utf8");
  const body = source.replace(/^([\s\S]*?\n)begin;\n/, "$1").replace(/\ncommit;\s*$/, "\n");
  expect(body).not.toMatch(/(^|\n)\s*(begin|commit)\s*;/i);
  return body;
}

const unlockBody = migrationBody("20260927110000_uniondemo_production_removal_window_unlock.sql");
const relockBody = migrationBody("20260927110100_uniondemo_production_removal_window_relock.sql");

async function inRollback(operation) {
  const client = new pg.Client({
    connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
    application_name: "uniondemo-production-removal-window-proof",
  });
  await client.connect();
  await client.query("begin");
  try {
    await installRetiredSeedUpgradeFixture(client);
    await operation(client);
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
  }
}

async function catalogue(client) {
  return (await client.query(`select p.oid::regprocedure::text signature,
      pg_catalog.encode(extensions.digest(pg_catalog.convert_to(pg_catalog.pg_get_functiondef(p.oid),'UTF8'),'sha256'),'hex') definition,
      p.proacl,p.proowner,p.proconfig,p.prosecdef
    from pg_catalog.pg_proc p where p.oid=any($1::regprocedure[]) order by 1`, [routed])).rows;
}

async function objects(client) {
  return (await client.query(`select
    pg_catalog.to_regprocedure('${guardSignature}')::text guard_object,
    pg_catalog.to_regprocedure('${actorGuardSignature}')::text actor_guard_object,
    pg_catalog.to_regprocedure('${stampSignature}')::text stamp_object,
    pg_catalog.to_regclass('private.uniondemo_production_removal_windows')::text window_object,
    pg_catalog.encode(extensions.digest(pg_catalog.convert_to(pg_catalog.pg_get_functiondef('private.uniondemo_authorize(text,text)'::regprocedure),'UTF8'),'sha256'),'hex') sample_guard`)).rows[0];
}

async function installFixtureGuard(client) {
  const identity = (await client.query(`select control.system_identifier::text system_identifier,
    database.oid::text database_oid from pg_catalog.pg_control_system() control
    cross join pg_catalog.pg_database database where database.datname=pg_catalog.current_database()`)).rows[0];
  const installed = (await client.query(`select pg_catalog.pg_get_functiondef('${guardSignature}'::regprocedure) definition`)).rows[0].definition;
  const replacements = [
    ["7662742571317219726", identity.system_identifier],
    ["pinned_database_oid constant oid := 5", `pinned_database_oid constant oid := ${identity.database_oid}`],
    ["5155e1a3ed12485fe08548293aa3c12c49bf16bf0e0fbce8a4072914d7688a20", fixtureDigest],
  ];
  let fixture = installed;
  for (const [before, after] of replacements) {
    expect(fixture.split(before)).toHaveLength(2);
    fixture = fixture.replace(before, after);
  }
  await client.query(fixture.replace(/^CREATE FUNCTION/i, "CREATE OR REPLACE FUNCTION"));
  await client.query("drop trigger uniondemo_production_removal_stamp_window on private.uniondemo_production_removal_windows");
  await client.query("alter table private.uniondemo_production_removal_windows drop constraint uniondemo_production_removal_window_eastern_interval");
  return identity;
}

async function setServiceRole(client) {
  await client.query("select set_config('request.jwt.claim.role','service_role',true)");
  await client.query("select set_config('request.jwt.claims','{\"role\":\"service_role\"}',true)");
}

async function establishBlankProductionEnvironment(client) {
  await client.query(`truncate table
    private.demo_seed_installation_bindings,
    public.organizations,
    storage.objects
    cascade`);
  const blank = (await client.query(`select
    (select count(*)::integer from private.demo_seed_installation_bindings) bindings,
    (select count(*)::integer from public.organizations) organizations,
    (select count(*)::integer from storage.objects) objects`)).rows[0];
  expect(blank).toEqual({ bindings: 0, organizations: 0, objects: 0 });
}

async function seedExactRun(client) {
  await client.query(`insert into private.uniondemo_runs
    (id,dataset_version,target_ref,member_count,steward_count,login_count,config_hash,state,protected_snapshot)
    values($1,'production-removal-window-proof',$2,30000,60,0,repeat('a',64),'verified',private.uniondemo_protected_snapshot($1))`,
  [runId, productionRef]);
  await client.query(`insert into private.uniondemo_ledger
    (run_id,ordinal,user_id,email,chapter_index,chapter_id,steward,login_capable)
    select $1,ordinal,md5('window-proof-'||ordinal)::uuid,
      'window-proof-'||ordinal||'@example.invalid',1,'window-proof',false,false
    from pg_catalog.generate_series(1,30000) ordinal`, [runId]);
}

async function insertWindow(client, identity, interval) {
  await client.query(`insert into private.uniondemo_production_removal_windows
    (project_ref,run_id,system_identifier,database_oid,authorization_reference,backup_reference,opened_at,expires_at)
    values($1,$2,$3,$4,'disposable-proof','disposable-restore-point',
      pg_catalog.statement_timestamp() + $5::interval,
      pg_catalog.statement_timestamp() + $6::interval)`,
  [productionRef, runId, identity.system_identifier, identity.database_oid, interval[0], interval[1]]);
}

async function refusal(client, query, values, message) {
  await client.query("savepoint refusal");
  await expect(client.query(query, values)).rejects.toMatchObject({ message });
  await client.query("rollback to savepoint refusal");
}

live("production uniondemo removal attended window", () => {
  it("is a catalogue no-op on its historical predecessor baseline", async () => inRollback(async (client) => {
    // This superseded pair preserves its own historical definitions. F3 now
    // restores the production-matched canonical bodies (without the older
    // leading LF); that exact current-state roundtrip has its own seed-lane proof.
    // Establish the historical baseline only inside this rolled-back fixture.
    await client.query(unlockBody);
    await client.query(relockBody);
    const before = await catalogue(client);
    const objectsBefore = await objects(client);
    expect(objectsBefore).toMatchObject({ guard_object: null, actor_guard_object: null, stamp_object: null, window_object: null });
    await client.query(unlockBody);
    expect(await objects(client)).toMatchObject({
      guard_object: guardSignature,
      actor_guard_object: actorGuardSignature,
      stamp_object: stampSignature,
      window_object: "private.uniondemo_production_removal_windows",
      sample_guard: objectsBefore.sample_guard,
    });
    expect(await catalogue(client)).not.toEqual(before);
    await client.query(relockBody);
    expect(await objects(client)).toEqual(objectsBefore);
    expect(await catalogue(client)).toEqual(before);
  }));

  it("refuses absent, expired and overlong owner-attended windows", async () => inRollback(async (client) => {
    await setServiceRole(client);
    await client.query(unlockBody);
    const identity = await installFixtureGuard(client);
    await refusal(client, `select ${guardName}($1,$2,$3,$4)`, ["begin-remove", runId, productionRef, fixtureConfirmation],
      "production removal window is not active");
    await insertWindow(client, identity, ["-2 hours", "-1 hour"]);
    await refusal(client, `select ${guardName}($1,$2,$3,$4)`, ["begin-remove", runId, productionRef, fixtureConfirmation],
      "production removal window is not active");
    await client.query("delete from private.uniondemo_production_removal_windows");
    await expect(insertWindow(client, identity, ["0 seconds", "5 hours"]))
      .rejects.toMatchObject({ code: "23514" });
  }));

  it("admits only the exact operation, scope, secret and live active window", async () => inRollback(async (client) => {
    await setServiceRole(client);
    await client.query(unlockBody);
    const identity = await installFixtureGuard(client);
    await insertWindow(client, identity, ["0 seconds", "1 hour"]);
    await establishBlankProductionEnvironment(client);
    await seedExactRun(client);
    await expect(client.query(`select ${guardName}($1,$2,$3,$4)`,
      ["begin-remove", runId, productionRef, fixtureConfirmation])).resolves.toBeDefined();
    const ownedUser = (await client.query("select user_id::text from private.uniondemo_ledger where run_id=$1 order by ordinal limit 1", [runId])).rows[0].user_id;
    await expect(client.query(`select ${actorGuardName}($1,jsonb_build_object('created_by',$2::text),true) owned`, [runId, ownedUser]))
      .resolves.toMatchObject({ rows: [{ owned: true }] });
    await expect(client.query(`select ${actorGuardName}($1,jsonb_build_object('created_by',$2::text),true) owned`, [runId, "11111111-1111-4111-8111-111111111111"]))
      .resolves.toMatchObject({ rows: [{ owned: false }] });
    for (const [operation, target, confirmation, message] of [
      ["seed", productionRef, fixtureConfirmation, "production removal operation refused"],
      ["begin-remove", sampleRef, fixtureConfirmation, "production removal scope refused"],
      ["begin-remove", productionRef, "wrong", "production removal confirmation refused"],
    ]) await refusal(client, `select ${guardName}($1,$2,$3,$4)`, [operation, runId, target, confirmation], message);
  }));

  it("keeps SAMPLE unchanged and restores production refusal after re-lock", async () => inRollback(async (client) => {
    await setServiceRole(client);
    const sampleBefore = (await objects(client)).sample_guard;
    await client.query(unlockBody);
    expect((await objects(client)).sample_guard).toBe(sampleBefore);
    await refusal(client, "select public.uniondemo_begin_remove($1,$2,'wrong')", [runId, sampleRef],
      "union demo database identity is not bound to SAMPLE");
    await client.query(relockBody);
    expect(await objects(client)).toMatchObject({ guard_object: null, actor_guard_object: null, stamp_object: null, window_object: null, sample_guard: sampleBefore });
    await refusal(client, "select public.uniondemo_begin_remove($1,$2,'wrong')", [runId, productionRef],
      "union demo target mismatch");
  }));
});
