// @vitest-environment node
//
// REQ-UG-DORMANT-62-ADMIN-MFA-RESET-LEGAL-HOLD-20260917 — live proofs in
// an owned disposable database (RUN_ADMIN_MFA_LEGAL_HOLD_DB_TESTS=1 plus a
// loopback SUPABASE_DB_URL in the 55000-59999 disposable port block).
//
// Text pins cannot show that begin_mfa_reset refuses the caller's own id at
// runtime, that the notice RPC really is bound to the audit row, or that the
// retention worker leaves a held body alone and destroys it after release.
// Each case runs inside one transaction and rolls back; nothing here touches
// a hosted database.
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { expect, it } from "vitest";

const live = process.env.RUN_ADMIN_MFA_LEGAL_HOLD_DB_TESTS === "1" ? it : it.skip;

async function connect() {
  const url = new URL(process.env.SUPABASE_DB_URL);
  expect(["localhost", "127.0.0.1"]).toContain(url.hostname);
  expect(Number(url.port)).toBeGreaterThanOrEqual(55000);
  expect(Number(url.port)).toBeLessThanOrEqual(59999);
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  await client.query("set statement_timeout = '10s'");
  return client;
}

// One organization + chapter, plus a member with a four-year-old conversation.
async function tenant(c) {
  const f = { org: randomUUID() };
  f.chapter = `proof-${f.org}`;
  await c.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [f.org, f.chapter]);
  await c.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,9900)", [f.chapter, f.org]);
  return f;
}

async function person(c, t, { language = "en" } = {}) {
  const id = randomUUID();
  await c.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
  // Isolate reset notices from the Union Ground account welcome.
  await c.query("delete from public.member_notifications where user_id=$1 and kind='general' and title='Welcome to your private organizing workspace'", [id]);
  await c.query("update public.member_profiles set chapter_id=$2, language=$3 where id=$1", [id, t.chapter, language]);
  await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [t.org, id]);
  await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [id, t.chapter]);
  return id;
}

async function conversation(c, userId) {
  const id = randomUUID();
  await c.query("insert into public.member_conversations(id,user_id,organization_id,title) values ($1,$2,private.member_organization_for($2),'Hold proof')", [id, userId]);
  await c.query("insert into public.member_messages(conversation_id,user_id,sender_kind,sender_name,body,created_at) values ($1,$2,'member','Proof','delivered evidence',now()-interval '4 years')", [id, userId]);
  return id;
}

// Grant a staff role and sign the caller in at aal2 with a verified factor, so
// member_has_role (which ANDs private.mfa_satisfied()) answers true.
async function staff(c, t, userId, role) {
  await c.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,$3) on conflict do nothing", [t.org, userId, role]);
  await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), userId]);
  // Old steward status reads keep their reach.
  if (role === "steward") await migrateLegacyStewardFixtures(c);
}

async function actAs(c, userId) {
  const session = randomUUID();
  await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, userId]);
  await c.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2", session_id: session })]);
}

async function refuses(c, sql, args, code = "42501") {
  await c.query("savepoint refuse");
  await expect(c.query(sql, args)).rejects.toMatchObject({ code });
  await c.query("rollback to refuse");
}

live("both MFA authorities refuse self-targets and non-admins without installing a boundary", async () => {
  const c = await connect(); await c.query("begin");
  try {
    const t = await tenant(c);
    const admin = await person(c, t); await staff(c, t, admin, "admin");
    const member = await person(c, t);
    expect((await c.query("select pg_catalog.to_regprocedure('public.authorize_mfa_reset(uuid)') as f")).rows[0].f).not.toBeNull();

    await actAs(c, admin);
    // SELF-RESET IS REFUSED — the security-critical line.
    await refuses(c, "select public.begin_mfa_reset($1)", [admin]);
    await refuses(c, "select public.authorize_mfa_reset($1)", [admin]);
    // A non-admin cannot reset anyone, including an admin.
    await actAs(c, member);
    await refuses(c, "select public.begin_mfa_reset($1)", [admin]);
    await refuses(c, "select public.authorize_mfa_reset($1)", [admin]);
    await refuses(c, "select public.begin_mfa_reset($1)", [member]);
    // The legitimate direction still authorizes and records the boundary.
    await actAs(c, admin);
    expect((await c.query("select public.authorize_mfa_reset($1) as v", [member])).rows[0].v).toMatchObject({ authorized: true });
    expect((await c.query("select count(*)::int as n from private.member_mfa_reset_boundaries where user_id=$1", [member])).rows[0].n).toBe(0);
    const ok = (await c.query("select public.begin_mfa_reset($1) as v", [member])).rows[0].v;
    expect(ok).toMatchObject({ userId: member, authorized: true, staleSessionsBlocked: true });
    expect((await c.query("select count(*)::int as n from private.member_mfa_reset_boundaries where user_id=$1", [member])).rows[0].n).toBe(1);
    expect((await c.query("select count(*)::int as n from private.member_mfa_reset_boundaries where user_id=$1", [admin])).rows[0].n).toBe(0);
  } finally { await c.query("rollback"); await c.end(); }
});

live("notify_member_mfa_reset is bound to the recorded reset and writes exactly one localized notice", async () => {
  const c = await connect(); await c.query("begin");
  try {
    const t = await tenant(c);
    const admin = await person(c, t); await staff(c, t, admin, "admin");
    const other = await person(c, t); await staff(c, t, other, "admin");
    const member = await person(c, t, { language: "es" });
    await actAs(c, admin);

    // No reset recorded yet: refused, flatly.
    await refuses(c, "select public.notify_member_mfa_reset($1)", [member]);
    // Never yourself, even with an audit row that names you as the target.
    await refuses(c, "select public.notify_member_mfa_reset($1)", [admin]);

    await c.query("select public.begin_mfa_reset($1)", [member]);
    await c.query("select public.record_mfa_reset($1, 1)", [member]);

    // A DIFFERENT admin cannot ride on this admin's audit row.
    await actAs(c, other);
    await refuses(c, "select public.notify_member_mfa_reset($1)", [member]);

    await actAs(c, admin);
    const first = (await c.query("select public.notify_member_mfa_reset($1) as v", [member])).rows[0].v;
    expect(first).toEqual({ userId: member, notified: true });
    const rows = (await c.query("select title, body, kind from public.member_notifications where user_id=$1 order by created_at", [member])).rows;
    expect(rows).toEqual([{
      title: "Un administrador restableció la verificación en dos pasos",
      body: expect.stringContaining("Si no lo pediste"),
      kind: "general",
    }]);
    // Idempotent per recorded reset: the retry is a no-op, not a second row.
    const again = (await c.query("select public.notify_member_mfa_reset($1) as v", [member])).rows[0].v;
    expect(again).toEqual({ userId: member, notified: false, duplicate: true });
    expect((await c.query("select count(*)::int as n from public.member_notifications where user_id=$1", [member])).rows[0].n).toBe(1);
    // The body never carries the removed factor, the admin's id, or a session.
    expect(rows[0].body).not.toContain(admin);
  } finally { await c.query("rollback"); await c.end(); }
});

live("the retention engine skips a held conversation and destroys the body only after release", async () => {
  const c = await connect(); await c.query("begin");
  try {
    const t = await tenant(c);
    const admin = await person(c, t); await staff(c, t, admin, "admin");
    const member = await person(c, t);
    const held = await conversation(c, member);
    await actAs(c, admin);
    await c.query("select public.upsert_organization_retention_policy('member_message_bodies',1095,true,'ENABLE member_message_bodies')");

    expect((await c.query("select private.retention_eligible_count($1,'member_message_bodies',1095) as n", [t.org])).rows[0].n).toBe(1);
    expect((await c.query("select public.place_member_message_legal_hold($1,'arbitration') as v", [held])).rows[0].v).toEqual({ held: true, reasonCode: "arbitration" });
    expect((await c.query("select private.retention_eligible_count($1,'member_message_bodies',1095) as n", [t.org])).rows[0].n).toBe(0);

    const heldRun = (await c.query("select public.preview_organization_retention_run('member_message_bodies') as v")).rows[0].v;
    expect(heldRun.eligibleCount).toBe(0);
    await c.query("select public.authorize_organization_retention_run($1,'AUTHORIZE member_message_bodies')", [heldRun.id]);
    expect((await c.query("select private.perform_organization_retention_run($1) as v", [heldRun.id])).rows[0].v).toMatchObject({ status: "completed", deletedCount: 0 });
    expect((await c.query("select body, redacted_at from public.member_messages where conversation_id=$1", [held])).rows).toEqual([{ body: "delivered evidence", redacted_at: null }]);

    expect((await c.query("select public.release_member_message_legal_hold($1) as v", [held])).rows[0].v).toEqual({ released: true });
    const freeRun = (await c.query("select public.preview_organization_retention_run('member_message_bodies') as v")).rows[0].v;
    expect(freeRun.eligibleCount).toBe(1);
    await c.query("select public.authorize_organization_retention_run($1,'AUTHORIZE member_message_bodies')", [freeRun.id]);
    expect((await c.query("select private.perform_organization_retention_run($1) as v", [freeRun.id])).rows[0].v).toMatchObject({ status: "completed", deletedCount: 1 });
    expect((await c.query("select body, redaction_reason from public.member_messages where conversation_id=$1", [held])).rows).toEqual([{ body: "", redaction_reason: "retention_expired" }]);
  } finally { await c.query("rollback"); await c.end(); }
});

live("place and release are audited and the status RPC discloses only what each caller may see", async () => {
  const c = await connect(); await c.query("begin");
  try {
    const t = await tenant(c);
    const admin = await person(c, t); await staff(c, t, admin, "admin");
    const steward = await person(c, t); await staff(c, t, steward, "steward");
    const member = await person(c, t);
    const target = await conversation(c, member);
    const ledger = (id) => c.query("select event_type, actor_user_id, metadata from public.organization_audit_ledger where organization_id=$1 and entity_type='message_legal_hold' and entity_id=$2 order by event_type", [t.org, id]);

    // A plain member holds no staff role: the read is refused, not empty.
    await actAs(c, member);
    await refuses(c, "select * from public.get_member_conversation_legal_holds($1)", [[target]]);
    // A steward may read but not write.
    await actAs(c, steward);
    expect((await c.query("select * from public.get_member_conversation_legal_holds($1)", [[target]])).rows)
      .toEqual([{ conversation_id: target, held: false, reason_code: null, placed_at: null, can_manage: false }]);
    await refuses(c, "select public.place_member_message_legal_hold($1,'litigation')", [target]);
    // More than 100 ids is refused rather than silently truncated.
    await actAs(c, admin);
    await refuses(c, "select * from public.get_member_conversation_legal_holds($1)", [Array.from({ length: 101 }, () => randomUUID())], "22023");

    await c.query("select public.place_member_message_legal_hold($1,'litigation')", [target]);
    const adminView = (await c.query("select * from public.get_member_conversation_legal_holds($1)", [[target, randomUUID()]])).rows;
    expect(adminView).toHaveLength(1);
    expect(adminView[0]).toMatchObject({ conversation_id: target, held: true, reason_code: "litigation", can_manage: true });
    expect(adminView[0].placed_at).toBeInstanceOf(Date);
    await actAs(c, steward);
    expect((await c.query("select * from public.get_member_conversation_legal_holds($1)", [[target]])).rows)
      .toEqual([{ conversation_id: target, held: true, reason_code: null, placed_at: null, can_manage: false }]);
    await refuses(c, "select public.release_member_message_legal_hold($1)", [target]);

    await actAs(c, admin);
    expect((await c.query("select public.release_member_message_legal_hold($1) as v", [target])).rows[0].v).toEqual({ released: true });
    expect((await c.query("select public.release_member_message_legal_hold($1) as v", [target])).rows[0].v).toEqual({ released: false });
    expect((await c.query("select * from public.get_member_conversation_legal_holds($1)", [[target]])).rows[0]).toMatchObject({ held: false, reason_code: null, can_manage: true });
    expect((await ledger(target)).rows).toEqual([
      { event_type: "message.legal_hold_placed", actor_user_id: admin, metadata: { reasonCode: "litigation", operation: "hold" } },
      { event_type: "message.legal_hold_released", actor_user_id: admin, metadata: { operation: "release" } },
    ]);
  } finally { await c.query("rollback"); await c.end(); }
});

live("list_member_message_legal_holds lists active holds for the admin's own tenant only", async () => {
  const c = await connect(); await c.query("begin");
  try {
    const home = await tenant(c);
    const away = await tenant(c);
    const admin = await person(c, home); await staff(c, home, admin, "admin");
    const awayAdmin = await person(c, away); await staff(c, away, awayAdmin, "admin");
    const steward = await person(c, home); await staff(c, home, steward, "steward");
    const member = await person(c, home);
    await c.query("update public.member_profiles set full_name='Renata Cole', initials='RC' where id=$1", [member]);
    const held = await conversation(c, member);
    const released = await conversation(c, member);

    await actAs(c, admin);
    await c.query("select public.place_member_message_legal_hold($1,'agency_charge')", [held]);
    await c.query("select public.place_member_message_legal_hold($1,'litigation')", [released]);
    await c.query("select public.release_member_message_legal_hold($1)", [released]);

    const searchable = (await c.query("select * from public.list_legal_hold_conversations('Renata',0)")).rows;
    expect(searchable.map((row) => row.conversation_id).sort()).toEqual([held, released].sort());
    const rows = (await c.query("select * from public.list_member_message_legal_holds()")).rows;
    expect(rows).toEqual([{
      conversation_id: held,
      conversation_title: "Hold proof",
      member_name: "Renata Cole",
      member_initials: "RC",
      reason_code: "agency_charge",
      placed_at: expect.any(Date),
    }]);

    await actAs(c, awayAdmin);
    expect((await c.query("select * from public.get_member_conversation_legal_holds($1)", [[held]])).rows).toEqual([]);
    await refuses(c, "select public.place_member_message_legal_hold($1,'litigation')", [held]);
    expect((await c.query("select public.release_member_message_legal_hold($1) as v", [held])).rows[0].v).toEqual({ released: false });
    await refuses(c, "select public.authorize_mfa_reset($1)", [member], "22023");
    // record_mfa_reset is tenant-scoped too (20260917130000), so the foreign
    // admin is refused here rather than minting the audit row the notice
    // looks for; a target that leaves the organization after a recorded reset
    // still leaves one behind, so seed that row directly — the notice itself
    // must still refuse a member outside the caller's organization.
    await refuses(c, "select public.record_mfa_reset($1, 0)", [member]);
    await c.query("insert into public.member_admin_audit(actor,action,target_user,detail) values ($1,'reset_mfa',$2,'{\"factorsRemoved\":0}'::jsonb)", [awayAdmin, member]);
    await refuses(c, "select public.notify_member_mfa_reset($1)", [member]);
    expect((await c.query("select count(*)::int as n from public.member_notifications where user_id=$1", [member])).rows[0].n).toBe(0);
    expect((await c.query("select * from public.list_legal_hold_conversations('',0)")).rows).toEqual([]);
    expect((await c.query("select * from public.list_member_message_legal_holds()")).rows).toEqual([]);
    await actAs(c, steward);
    await refuses(c, "select * from public.list_member_message_legal_holds()", []);
  } finally { await c.query("rollback"); await c.end(); }
});
