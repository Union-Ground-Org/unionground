import pg from "pg";
import { assertDisposableProofUrl } from "./run-required-db-proofs.mjs";
import { requireDatabaseUrl } from "./lib/required-database-url.mjs";

const { Client } = pg;
const databaseUrl = assertDisposableProofUrl(requireDatabaseUrl("SUPABASE_DB_URL", { aliases: ["DATABASE_URL"] }));

const ids = {
  worAdmin: "50900000-0000-4000-8000-000000000071",
  bosAdmin: "50900000-0000-4000-8000-000000000072",
  worMember: "50900000-0000-4000-8000-000000000073",
  bosMember: "50900000-0000-4000-8000-000000000074",
  dcfMember: "50900000-0000-4000-8000-000000000075",
  noChapter: "50900000-0000-4000-8000-000000000076",
};
const eventIds = ["evt-local-chapter", "evt-local-agency", "evt-local-cross", "evt-local-bos"];

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function asRole(client, role, userId = null) {
  await client.query("reset role");
  const claims = userId ? { sub: userId, role, aal: "aal2" } : { role };
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
  await client.query(`set local role ${role}`);
}

async function expectState(client, label, sql, values, state) {
  const savepoint = `sp_${label.replace(/[^a-z0-9]/gi, "_")}`;
  await client.query(`savepoint ${savepoint}`);
  try {
    await client.query(sql, values);
    throw new Error(`${label}: expected SQLSTATE ${state}`);
  } catch (error) {
    assert(error.code === state, `${label}: expected SQLSTATE ${state}, got ${error.code || error.message}`);
  } finally {
    await client.query(`rollback to savepoint ${savepoint}`);
    await client.query(`release savepoint ${savepoint}`);
  }
}

const client = new Client({ connectionString: databaseUrl, application_name: "chapter-events-rollback-proof" });
try {
  await client.connect();
  await client.query("begin");

  const allUsers = Object.values(ids);
  for (const [index, id] of allUsers.entries()) {
    await client.query("insert into auth.users (id, email) values ($1, $2)", [id, `chapter-event-proof-${index}@example.invalid`]);
  }
  await client.query("update public.member_profiles set chapter_id = 'wor', full_name = 'Worcester event proof' where id = any($1::uuid[])", [[ids.worAdmin, ids.worMember]]);
  await client.query("update public.member_profiles set chapter_id = 'bos', full_name = 'Boston event proof' where id = any($1::uuid[])", [[ids.bosAdmin, ids.bosMember]]);
  await client.query("update public.member_profiles set chapter_id = 'dcf-bos', full_name = 'DCF event proof' where id = $1", [ids.dcfMember]);
  await client.query("update public.member_profiles set chapter_id = null, full_name = 'No chapter event proof' where id = $1", [ids.noChapter]);
  await client.query(`
    insert into public.member_roles (user_id, role, chapter_id)
    values ($1, 'admin', 'wor'), ($2, 'admin', 'bos')
  `, [ids.worAdmin, ids.bosAdmin]);

  const create = async (id, title, isPublic, cross) => client.query(
    "select public.create_member_event($1, $2, now() + interval '1 day', 'Local hall', 'Rollback-only scope proof', 'SG-LOCAL7', $3, $4)",
    [id, title, isPublic, cross],
  );

  await asRole(client, "authenticated", ids.worAdmin);
  await create(eventIds[0], "Chapter-only local proof", false, false);
  await create(eventIds[1], "Agency local proof", true, false);
  await create(eventIds[2], "Cross-agency local proof", true, true);
  const worRows = await client.query("select id, chapter_id, order_index from public.member_events where id = any($1::text[]) order by order_index", [eventIds]);
  assert(worRows.rows.length === 3, "publisher must read all three own-chapter events");
  assert(worRows.rows.every((row) => row.chapter_id === "wor"), "server must stamp the publisher chapter");
  assert(new Set(worRows.rows.map((row) => row.order_index)).size === 3, "chapter order indexes must be unique");

  await asRole(client, "authenticated", ids.bosAdmin);
  await create(eventIds[3], "Boston chapter local proof", false, false);

  const visible = async (userId) => {
    await asRole(client, "authenticated", userId);
    return (await client.query("select id from public.member_events where id = any($1::text[]) order by id", [eventIds])).rows.map((row) => row.id);
  };
  assert(JSON.stringify(await visible(ids.worMember)) === JSON.stringify(eventIds.slice(0, 3).sort()), "own chapter must see chapter/agency/cross events");
  assert(JSON.stringify(await visible(ids.bosMember)) === JSON.stringify([eventIds[1], eventIds[2], eventIds[3]].sort()), "same agency must see public and cross events, plus own chapter");
  assert(JSON.stringify(await visible(ids.dcfMember)) === JSON.stringify([eventIds[2]]), "different agency must see only cross-agency events");
  assert((await visible(ids.noChapter)).length === 0, "missing chapter identity must fail closed");

  await asRole(client, "authenticated", ids.bosMember);
  await expectState(client, "out_of_scope_rsvp", "select public.rsvp_to_event($1, 'going')", [eventIds[0]], "22023");

  await asRole(client, "authenticated", ids.dcfMember);
  await client.query("select public.rsvp_to_event($1, 'going')", [eventIds[2]]);
  const token = (await client.query("select public.rotate_calendar_feed_token() as value")).rows[0].value.token;

  await asRole(client, "authenticated", ids.worAdmin);
  const adminRows = (await client.query("select public.get_admin_events() as value")).rows[0].value;
  assert(adminRows.filter((row) => eventIds.includes(row.id)).length === 3, "admin list must stay in the admin's chapter");
  assert(adminRows.every((row) => row.chapterId === "wor"), "admin list must not include another chapter");
  await expectState(client, "cross_chapter_update", "select public.update_member_event($1, p_title => 'Forbidden')", [eventIds[3]], "22023");
  await expectState(client, "cross_chapter_cancel", "select public.cancel_member_event($1, 'Forbidden')", [eventIds[3]], "22023");
  await expectState(client, "cross_chapter_restore", "select public.restore_member_event($1)", [eventIds[3]], "22023");
  await expectState(client, "cross_chapter_delete", "select public.delete_member_event($1)", [eventIds[3]], "22023");
  await asRole(client, "authenticated", ids.bosAdmin);
  assert((await client.query("select count(*)::int as n from public.member_events where id = $1", [eventIds[3]])).rows[0].n === 1,
    "cross-chapter removal attempts must leave the foreign event intact");
  await asRole(client, "authenticated", ids.worAdmin);
  await client.query("select public.update_member_event($1, p_is_public => false, p_is_public_across_agencies => false)", [eventIds[2]]);

  await asRole(client, "authenticated", ids.dcfMember);
  assert((await client.query("select count(*)::int as n from public.member_event_rsvps where event_id = $1", [eventIds[2]])).rows[0].n === 0,
    "a stale RSVP must disappear when its parent event is narrowed");

  await asRole(client, "service_role");
  const feed = (await client.query("select public.get_calendar_feed_events($1) as value", [token])).rows[0].value;
  assert(feed.valid === true && feed.events.length === 0, "calendar feed must re-check current event scope");

  await client.query("rollback");
  const residue = await client.query("select count(*)::int as n from public.member_events where id = any($1::text[])", [eventIds]);
  assert(residue.rows[0].n === 0, "rollback must remove all event proof rows");
  const userResidue = await client.query("select count(*)::int as n from auth.users where id = any($1::uuid[])", [allUsers]);
  assert(userResidue.rows[0].n === 0, "rollback must remove all identity proof rows");
  console.log("PASS: chapter-scoped event RLS/RPC/feed behavior proved locally; fixture transaction rolled back cleanly.");
} catch (error) {
  await client.query("rollback").catch(() => {});
  throw error;
} finally {
  await client.end().catch(() => {});
}
