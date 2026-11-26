// @vitest-environment node
import { readFileSync } from "node:fs";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.REQUIRE_DB_REPAIR_PROOFS === "1" ? describe : describe.skip;
const migration = readFileSync(new URL("../supabase/migrations/20260913031500_native_push_enqueue_repair.sql", import.meta.url), "utf8")
  .replace("\nbegin;\n", "\n").replace(/commit;\s*$/, "");
const automationMigration = readFileSync(new URL("../supabase/migrations/20260910045839_connected_automation_v2.sql", import.meta.url), "utf8");
const start = automationMigration.indexOf("CREATE OR REPLACE FUNCTION private.enqueue_notification_deliveries()");
const oldCanonical = automationMigration.slice(start, automationMigration.indexOf("$function$;", start) + "$function$;".length);
const recipient = "50961700-0000-4000-8000-000000000001";
const installation = "50961700-0000-4000-8000-000000000002";

async function inRollback(operation) {
  const client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL) });
  await client.connect();
  await client.query("begin");
  try { await operation(client); }
  finally { await client.query("rollback"); await client.end(); }
}

async function installPredecessor(client, source, expectedHash) {
  await client.query(source);
  const definition = (await client.query("select md5(pg_get_functiondef('private.enqueue_notification_deliveries()'::regprocedure)) as hash")).rows[0];
  expect(definition.hash).toBe(expectedHash);
  const update = await client.query(`update private.account_lifecycle_trigger_review set definition_hash=$1
    where kind='function' and schema_name='private' and table_name='' and object_name='enqueue_notification_deliveries()'`, [expectedHash]);
  expect(update.rowCount).toBe(1);
}

async function seedRecipient(client) {
  await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,'native-enqueue-proof@example.invalid','{}')", [recipient]);
  await client.query("update public.member_profiles set notification_prefs='{}' where id=$1", [recipient]);
  await client.query("update private.notification_controls set outbound_enabled=true where id");
}

async function nativeTarget(client) {
  await client.query(`insert into public.member_native_push_installations
    (user_id,installation_id,provider,environment,device_token,session_handle)
    values($1,$2,'fcm','production','native-enqueue-local-fixture-token',repeat('a',64))`, [recipient, installation]);
}

async function webTarget(client) {
  await client.query(`insert into public.member_push_subscriptions(user_id,endpoint,p256dh,auth_key)
    values($1,'https://fcm.googleapis.com/native-enqueue-local-proof','fixture-public','fixture-auth')`, [recipient]);
}

async function enqueue(client, expectedPush, kind = "cases", expectedEmail = 1) {
  const result = await client.query(`insert into public.member_notifications(user_id,kind,title,body)
    values($1,$2,'Local queue proof','No provider request is made.') returning id`, [recipient, kind]);
  const rows = (await client.query(`select channel,count(*)::int as count from public.member_notification_deliveries
    where notification_id=$1 group by channel`, [result.rows[0].id])).rows;
  expect(rows.find((row) => row.channel === "push")?.count ?? 0).toBe(expectedPush);
  expect(rows.find((row) => row.channel === "email")?.count ?? 0).toBe(expectedEmail);
}

live("native-only notification enqueue and exact predecessor repair", () => {
  for (const [name, source, before, after, repair] of [
    ["current automation", oldCanonical, "758e6af4274350b85114e660338228b9", "2ec5c00743fcd7bf5eec7b4af512fc48", migration],
  ]) {
    it(`repairs ${name} without weakening target, preference, outbound or topic gates`, async () => inRollback(async (client) => {
      await installPredecessor(client, source, before);
      await client.query(repair);
      expect((await client.query("select md5(pg_get_functiondef('private.enqueue_notification_deliveries()'::regprocedure)) as hash")).rows[0].hash).toBe(after);
      await seedRecipient(client);
      await enqueue(client, 0); // No target: ordinary email semantics remain.
      await nativeTarget(client);
      await enqueue(client, 1); // The regression: native-only now gets a queue row.
      await webTarget(client);
      await enqueue(client, 1); // Both target types share one delivery row.
      await client.query("delete from public.member_native_push_installations where user_id=$1", [recipient]);
      await enqueue(client, 1); // Web-only behavior remains.
      await client.query("update private.notification_controls set outbound_enabled=false where id");
      await enqueue(client, 0, "cases", 0);
      await client.query("update private.notification_controls set outbound_enabled=true where id");
      await client.query("update public.member_profiles set notification_prefs=$2::jsonb where id=$1", [recipient, JSON.stringify({ cases: false })]);
      await enqueue(client, 0, "cases", 0);
      await enqueue(client, 0, "general", 0);
      await client.query("update public.member_profiles set notification_prefs='{}' where id=$1", [recipient]);
      await client.query(`insert into private.member_stress_runs
        (id,dataset_version,target_ref,member_count,login_count,config_hash,state,protected_snapshot)
        values($1,'native-enqueue-proof','local-disposable',1,0,repeat('a',64),'ledgered','{}')`, [installation]);
      await client.query(`insert into private.member_stress_ledger(run_id,ordinal,user_id,email,login_capable)
        values($1,1,$2,'native-enqueue-proof@example.invalid',false)`, [installation, recipient]);
      await enqueue(client, 0, "cases", 0);
    }));

    it(`refuses an unexpected lifecycle pin for ${name} without changing the function`, async () => inRollback(async (client) => {
      await installPredecessor(client, source, before);
      await client.query(`update private.account_lifecycle_trigger_review set definition_hash=repeat('0',32)
        where kind='function' and schema_name='private' and table_name='' and object_name='enqueue_notification_deliveries()'`);
      await client.query("savepoint refused_repair");
      await expect(client.query(repair)).rejects.toThrow("lifecycle predecessor is not reviewed");
      await client.query("rollback to savepoint refused_repair");
      expect((await client.query("select md5(pg_get_functiondef('private.enqueue_notification_deliveries()'::regprocedure)) as hash")).rows[0].hash).toBe(before);
    }));
  }

  it("refuses an unknown function definition", async () => inRollback(async (client) => {
    await client.query("create or replace function private.enqueue_notification_deliveries() returns trigger language plpgsql security definer set search_path='' as $$begin return new;end$$");
    await client.query("savepoint refused_unknown");
    await expect(client.query(migration)).rejects.toThrow("unreviewed notification enqueue predecessor");
    await client.query("rollback to savepoint refused_unknown");
    expect((await client.query("select prosrc from pg_proc where oid='private.enqueue_notification_deliveries()'::regprocedure")).rows[0].prosrc).toBe("begin return new;end");
  }));
});
