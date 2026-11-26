import assert from "node:assert/strict";
import { fnBody, loadMigrationSql } from "./migration.js";

// Replay the historical migration on its own reviewed definitions. Never
// commit an older function over a newer repair in the shared proof database.
// insideTransaction replays under a savepoint, so a caller's open transaction
// (and the fixtures it holds) survives the replay's rollback.
export async function verifyHistoricalEventModelReplay(client, { insideTransaction = false } = {}) {
  const model = loadMigrationSql("20261009002000_event_model");
  const transactionalModel = model.replace(/^begin;\s*$/m, "").replace(/^commit;\s*$/m, "");
  const names = ["get_admin_events", "get_calendar_feed_events", "rsvp_to_event", "create_member_event_model", "update_member_event_model"];
  const installed = async () => (await client.query(`
    select p.oid::regprocedure::text as name, pg_get_functiondef(p.oid) as definition
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = any($1::text[])
    order by 1`, [names])).rows;
  const current = await installed();
  assert.equal(current.length, names.length);
  await client.query(insideTransaction ? "savepoint event_model_replay" : "begin");
  try {
    for (const name of names) await client.query(fnBody(model, `public.${name}(`));
    const historical = await installed();
    for (let application = 0; application < 2; application += 1) {
      await client.query(transactionalModel);
      assert.deepEqual(await installed(), historical);
      // The original COMMIT drops this reference table after each application.
      await client.query("drop table pg_temp.event_model_expected");
    }
  } finally {
    await client.query(insideTransaction ? "rollback to savepoint event_model_replay" : "rollback");
  }
  assert.deepEqual(await installed(), current, "historical replay must preserve every current definition");
}
