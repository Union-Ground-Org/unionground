import pg from "pg";
import { assertDisposableProofUrl } from "./run-required-db-proofs.mjs";
import { requireDatabaseUrl } from "./lib/required-database-url.mjs";

const { Client } = pg;
const databaseUrl = assertDisposableProofUrl(requireDatabaseUrl("SUPABASE_DB_URL", { aliases: ["DATABASE_URL"] }));

const ids = {
  revoker: "50900000-0000-4000-8000-000000000301",
  writer: "50900000-0000-4000-8000-000000000302",
  reserve: "50900000-0000-4000-8000-000000000303",
};
const allIds = Object.values(ids);

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function asAdmin(client, userId) {
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
    sub: userId,
    role: "authenticated",
    aal: "aal2",
  })]);
  await client.query("set local role authenticated");
}

async function cleanup(client, originalChapter) {
  await client.query("reset role");
  await client.query("delete from public.member_admin_audit where actor = any($1::uuid[]) or target_user = any($1::uuid[])", [allIds]);
  await client.query("delete from auth.users where id = any($1::uuid[])", [allIds]);
  if (originalChapter) {
    await client.query(`
      update public.chapters set name = $2, region = $3, order_index = $4 where id = $1
    `, [originalChapter.id, originalChapter.name, originalChapter.region, originalChapter.order_index]);
  }
}

const setup = new Client({ connectionString: databaseUrl, application_name: "admin-command-proof-setup" });
const revoker = new Client({ connectionString: databaseUrl, application_name: "admin-command-proof-revoker" });
const writer = new Client({ connectionString: databaseUrl, application_name: "admin-command-proof-writer" });
let originalChapter;
let writerOpen = false;
let revokerOpen = false;
let setupConnected = false;

try {
  await Promise.all([setup.connect(), revoker.connect(), writer.connect()]);
  setupConnected = true;
  originalChapter = (await setup.query("select id, name, region, order_index from public.chapters where id = 'wor'")).rows[0];
  assert(originalChapter, "local database needs the wor chapter fixture");
  await cleanup(setup, originalChapter);

  await setup.query(`
    insert into auth.users (id, email) values
      ($1, 'admin-command-revoker@example.invalid'),
      ($2, 'admin-command-writer@example.invalid'),
      ($3, 'admin-command-reserve@example.invalid')
  `, [ids.revoker, ids.writer, ids.reserve]);
  await setup.query(`
    update public.member_profiles
    set chapter_id = 'wor', full_name = case id
      when $1::uuid then 'Admin command revoker'
      when $2::uuid then 'Admin command writer'
      else 'Admin command reserve' end,
      -- New profiles have no join year (20261004030000); the proof member's is
      -- entered, as a member would on their card, so the directory check below
      -- still proves the server returns a bare year.
      member_since = case when id = $2::uuid then 2019 else member_since end
    where id = any($3::uuid[])
  `, [ids.revoker, ids.writer, allIds]);
  await setup.query(`
    insert into public.member_roles (user_id, role, chapter_id) values
      ($1, 'admin', null), ($2, 'admin', 'wor'), ($3, 'admin', null)
  `, [ids.revoker, ids.writer, ids.reserve]);
  await setup.query(`
    insert into auth.mfa_factors
      (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
    select extensions.gen_random_uuid(), id, 'admin-command-proof', 'totp', 'verified', now(), now()
    from auth.users where id = any($1::uuid[])
  `, [allIds]);

  await setup.query("begin");
  await asAdmin(setup, ids.writer);
  const directory = (await setup.query(
    "select public.get_admin_member_directory('', null, null, 50) as value",
  )).rows[0].value;
  await setup.query("rollback");
  const proofMember = directory.items.find((item) => item.userId === ids.writer);
  assert(proofMember?.memberSince === 2019, "directory memberSince must be the entered, server-minimized year");
  for (const forbidden of ["email", "phone", "address", "cases", "forms", "messages"]) {
    assert(!JSON.stringify(directory).toLowerCase().includes(forbidden), `directory leaked ${forbidden}`);
  }
  await setup.query("begin");
  await asAdmin(setup, ids.writer);
  const organization = (await setup.query("select public.get_admin_org_structure() as value")).rows[0].value;
  assert(organization.scope === "chapter" && organization.chapters.length === 1,
    "scoped admin must receive only their current chapter");
  assert(Object.keys(organization.chapters[0].roleCounts).sort().join(",") === "admin,advisor,coordinator,steward,vp",
    "organization roleCounts must be deterministic and zero-filled for supported hats");
  assert(Object.values(organization.chapters[0].roleCounts).every(Number.isInteger),
    "organization roleCounts must contain only integer aggregates");
  await setup.query("savepoint scoped_structure");
  let structureDenied = false;
  try {
    await setup.query(
      "select public.update_admin_chapter('wor', $1, 'Unauthorized region', $2)",
      [originalChapter.name, originalChapter.order_index],
    );
  } catch (error) {
    structureDenied = error.code === "42501";
  }
  assert(structureDenied, "scoped admin must not change chapter region or ordering");
  await setup.query("rollback to savepoint scoped_structure");
  const renamed = (await setup.query(
    "select public.update_admin_chapter('wor', 'Scoped rename proof', $1, $2) as value",
    [originalChapter.region, originalChapter.order_index],
  )).rows[0].value;
  assert(renamed.updated === true && renamed.name === "Scoped rename proof",
    "scoped admin must be able to rename their own chapter");
  await setup.query("rollback");

  await revoker.query("begin");
  revokerOpen = true;
  await asAdmin(revoker, ids.revoker);
  // The role command under test was retired. This proof still needs the
  // competing role-row delete so it can verify the command-center write
  // reauthorizes after that exact lock is released.
  await revoker.query("reset role");
  const revoked = await revoker.query("delete from public.member_roles where user_id = $1 and role = 'admin'", [ids.writer]);
  assert(revoked.rowCount === 1, "revoker must stage the scoped admin removal");

  await writer.query("begin");
  writerOpen = true;
  await asAdmin(writer, ids.writer);
  const writePromise = writer.query(
    "select public.update_admin_chapter('wor', 'Unauthorized concurrent rename', $1, $2)",
    [originalChapter.region, originalChapter.order_index],
  );

  let waited = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const activity = await setup.query(`
      select wait_event_type from pg_catalog.pg_stat_activity
      where application_name = 'admin-command-proof-writer'
    `);
    if (activity.rows.some((row) => row.wait_event_type === "Lock")) {
      waited = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert(waited, "chapter writer did not wait behind the exact admin-role removal");

  await revoker.query("commit");
  revokerOpen = false;
  let denied = false;
  try {
    await writePromise;
  } catch (error) {
    denied = error.code === "22023" && error.message === "chapter unavailable";
  }
  assert(denied, "writer must fail closed after the concurrent admin-role removal commits");
  await writer.query("rollback");
  writerOpen = false;

  const chapter = (await setup.query("select name, region, order_index from public.chapters where id = 'wor'")).rows[0];
  assert(chapter.name === originalChapter.name
    && chapter.region === originalChapter.region
    && chapter.order_index === originalChapter.order_index,
  "revoked concurrent writer mutated the chapter");

  console.log("PASS: year-minimal directory, scoped role counts/name-only updates, exact-role removal/write serialization, and no mutation proved locally.");
} finally {
  if (writerOpen) await writer.query("rollback").catch(() => {});
  if (revokerOpen) await revoker.query("rollback").catch(() => {});
  if (setupConnected) await cleanup(setup, originalChapter).catch(() => {});
  await Promise.all([setup, revoker, writer].map((client) => client.end().catch(() => {})));
}
