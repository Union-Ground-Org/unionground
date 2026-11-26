// @vitest-environment node
//
// BUG-UG-MFA-RESET-PARTIAL-NO-MEMBER-NOTICE-20260917 — live proofs in an
// owned disposable database (RUN_MFA_RESET_PENDING_NOTICE_DB_TESTS=1 plus a
// loopback SUPABASE_DB_URL in the 55000-59999 disposable port block).
//
// Text pins cannot show that the owed notice really outlives the fifteen-minute
// member_admin_audit window public.notify_member_mfa_reset is bound to, that
// the drain writes the member's notice when no audit row exists or ever will,
// or that a reset already notified can never be notified twice — all three are
// behaviour of rows and clocks, not of statements. Each case runs inside one
// transaction and rolls back; nothing here touches a hosted database.
//
// TWO CLOCKS, ONE TRANSACTION. begin_mfa_reset stamps invalid_before with
// clock_timestamp(), which ADVANCES inside a transaction, while
// member_notifications.created_at and member_admin_audit.created_at default to
// now(), which is frozen at the transaction's start. In production those
// writers are separate transactions and now() moves; in one test transaction it
// does not, so a notice written here would compare as older than the reset it
// discharges. Every case therefore back-dates the boundary row it just created,
// which is also the honest fixture: the defect is about a notice owed for a
// reset that happened a while ago.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { expect, it } from "vitest";

const live = process.env.RUN_MFA_RESET_PENDING_NOTICE_DB_TESTS === "1" ? it : it.skip;

const EN_TITLE = "Two-step sign-in was reset by an administrator";
const ES_TITLE = "Un administrador restableció la verificación en dos pasos";

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

async function tenant(c) {
  const f = { org: randomUUID() };
  f.chapter = `notice-${f.org}`;
  await c.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [f.org, f.chapter]);
  await c.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,9901)", [f.chapter, f.org]);
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

// Grant a staff role and sign the caller in at aal2 with a verified factor, so
// member_has_role (which ANDs private.mfa_satisfied()) answers true.
async function staff(c, t, userId, role) {
  await c.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,$3) on conflict do nothing", [t.org, userId, role]);
  await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), userId]);
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

// See TWO CLOCKS above. Moves the reset (and its owed notice) into the past by
// the requested interval, the way a real reset sits in the past by the time a
// later request drains it.
async function ageReset(c, userId, interval) {
  await c.query(
    `update private.member_mfa_reset_boundaries
     set invalid_before = invalid_before - $2::interval,
         created_at = created_at - $2::interval,
         notice_owed_at = notice_owed_at - $2::interval
     where user_id = $1`,
    [userId, interval],
  );
}

async function boundary(c, userId) {
  return (await c.query(
    `select invalid_before, notice_owed_at, notice_sent_at,
            (notice_owed_at is not null
             and (notice_sent_at is null or notice_sent_at < notice_owed_at)) as pending
     from private.member_mfa_reset_boundaries where user_id = $1`,
    [userId],
  )).rows[0];
}

async function notices(c, userId) {
  return (await c.query(
    "select title, body, kind, created_at from public.member_notifications where user_id=$1 order by created_at, title",
    [userId],
  )).rows;
}

live("the owed notice outlives the audit window and the drain delivers it exactly once", async () => {
  const c = await connect(); await c.query("begin");
  try {
    const t = await tenant(c);
    const admin = await person(c, t); await staff(c, t, admin, "admin");
    const member = await person(c, t, { language: "es" });
    await actAs(c, admin);

    // The reset happened: begin_mfa_reset wrote the boundary, closed the
    // member's sessions and removed their push targets. This is path 1 or 2 of
    // the defect — the factor delete failed partway, or record_mfa_reset threw
    // — so no audit row for this caller exists, and the endpoint used to
    // return with nothing owed and nothing to retry.
    await c.query("select public.begin_mfa_reset($1)", [member]);
    expect(await boundary(c, member)).toMatchObject({ notice_owed_at: null, notice_sent_at: null });

    const queued = (await c.query("select public.queue_member_mfa_reset_notice($1) as v", [member])).rows[0].v;
    expect(queued).toMatchObject({ userId: member, pending: true });
    // DURABLE, AND ONLY DURABLE: the mark is a row, not a delivery. That is
    // what survives an endpoint that never gets to call the drain.
    const owed = await boundary(c, member);
    expect(owed.pending).toBe(true);
    expect(owed.notice_owed_at).toEqual(owed.invalid_before);
    expect(owed.notice_sent_at).toBeNull();
    expect(await notices(c, member)).toEqual([]);

    // Half an hour later. notify_member_mfa_reset cannot serve this member any
    // more — not even with the reset_mfa audit row seeded directly, because
    // its binding is a FIFTEEN-MINUTE window on that row. This is the exact
    // stranding the record describes.
    await ageReset(c, member, "30 minutes");
    await c.query(
      "insert into public.member_admin_audit(actor,action,target_user,detail,created_at) values ($1,'reset_mfa',$2,'{\"factorsRemoved\":1}'::jsonb, now() - interval '30 minutes')",
      [admin, member],
    );
    await refuses(c, "select public.notify_member_mfa_reset($1)", [member]);
    expect(await notices(c, member)).toEqual([]);

    // The drain is bound to the boundary instead, so it still delivers — in
    // the member's own language.
    const drained = (await c.query("select public.drain_member_mfa_reset_notice($1) as v", [member])).rows[0].v;
    expect(drained).toMatchObject({ userId: member, drained: true, notified: true, pending: false });
    expect(await notices(c, member)).toEqual([{
      title: ES_TITLE,
      body: expect.stringContaining("Si no lo pediste"),
      kind: "general",
      created_at: expect.anything(),
    }]);
    const settled = await boundary(c, member);
    expect(settled.pending).toBe(false);
    expect(settled.notice_sent_at.getTime()).toBeGreaterThan(settled.notice_owed_at.getTime());

    // Drained once. A second drain — the next reset for this member, or a
    // second administrator retrying — writes nothing and claims nothing.
    const again = (await c.query("select public.drain_member_mfa_reset_notice($1) as v", [member])).rows[0].v;
    expect(again).toMatchObject({ drained: false, notified: false, pending: false });
    expect(await notices(c, member)).toHaveLength(1);
    // Re-marking the same reset cannot un-discharge it either.
    expect((await c.query("select public.queue_member_mfa_reset_notice($1) as v", [member])).rows[0].v)
      .toMatchObject({ pending: false });
    expect((await boundary(c, member)).pending).toBe(false);
    expect(await notices(c, member)).toHaveLength(1);
    // The notice never carries the administrator, a factor or a session.
    expect((await notices(c, member))[0].body).not.toContain(admin);
  } finally { await c.query("rollback"); await c.end(); }
});

live("the drain writes no second notice for a reset notify_member_mfa_reset already told the member about", async () => {
  const c = await connect(); await c.query("begin");
  try {
    const t = await tenant(c);
    const admin = await person(c, t); await staff(c, t, admin, "admin");
    const member = await person(c, t);
    await actAs(c, admin);

    // The ordinary path: the notice landed. The endpoint still drains,
    // because a debt an EARLIER reset left behind is cleared by this one.
    await c.query("select public.begin_mfa_reset($1)", [member]);
    await ageReset(c, member, "1 minute");
    await c.query("select public.record_mfa_reset($1, 1)", [member]);
    expect((await c.query("select public.notify_member_mfa_reset($1) as v", [member])).rows[0].v)
      .toEqual({ userId: member, notified: true });
    expect(await notices(c, member)).toHaveLength(1);

    // Nothing owed: the drain is a no-op, not a second notice.
    expect((await c.query("select public.drain_member_mfa_reset_notice($1) as v", [member])).rows[0].v)
      .toMatchObject({ drained: false, notified: false });
    expect(await notices(c, member)).toHaveLength(1);

    // And when the endpoint marked the debt anyway — a lost 200, a timeout
    // that hid a notice that did land — the drain RECOGNISES the notice this
    // reset already has, settles the row, and still writes nothing. This is
    // the one-notice-per-recorded-reset guard, anchored on the reset rather
    // than on the audit row.
    expect((await c.query("select public.queue_member_mfa_reset_notice($1) as v", [member])).rows[0].v)
      .toMatchObject({ pending: true });
    const drained = (await c.query("select public.drain_member_mfa_reset_notice($1) as v", [member])).rows[0].v;
    expect(drained).toMatchObject({ drained: true, notified: false, duplicate: true, pending: false });
    expect(await notices(c, member)).toHaveLength(1);
    expect((await boundary(c, member)).pending).toBe(false);
  } finally { await c.query("rollback"); await c.end(); }
});

live("a later reset owes its own notice, and the guard is per reset rather than per member", async () => {
  const c = await connect(); await c.query("begin");
  try {
    const t = await tenant(c);
    const admin = await person(c, t); await staff(c, t, admin, "admin");
    const member = await person(c, t);
    await actAs(c, admin);

    await c.query("select public.begin_mfa_reset($1)", [member]);
    await c.query("select public.queue_member_mfa_reset_notice($1)", [member]);
    await ageReset(c, member, "2 hours");
    expect((await c.query("select public.drain_member_mfa_reset_notice($1) as v", [member])).rows[0].v)
      .toMatchObject({ drained: true, notified: true });
    expect(await notices(c, member)).toHaveLength(1);

    // A SECOND reset of the same member, failing the same way. Refusing it a
    // notice because one exists would silence exactly the member who is being
    // reset repeatedly — the signal the record exists for.
    await c.query("select public.begin_mfa_reset($1)", [member]);
    const second = await boundary(c, member);
    expect(second.invalid_before.getTime()).toBeGreaterThan(second.notice_sent_at.getTime());
    expect((await c.query("select public.queue_member_mfa_reset_notice($1) as v", [member])).rows[0].v)
      .toMatchObject({ pending: true });
    expect((await boundary(c, member)).pending).toBe(true);
    expect((await c.query("select public.drain_member_mfa_reset_notice($1) as v", [member])).rows[0].v)
      .toMatchObject({ drained: true, notified: true });
    expect(await notices(c, member)).toHaveLength(2);
    expect((await boundary(c, member)).pending).toBe(false);
  } finally { await c.query("rollback"); await c.end(); }
});

live("both authorities are tenant-scoped and self-denying, and only the queue is bound to the caller's own reset", async () => {
  const c = await connect(); await c.query("begin");
  try {
    const home = await tenant(c);
    const away = await tenant(c);
    const admin = await person(c, home); await staff(c, home, admin, "admin");
    const second = await person(c, home); await staff(c, home, second, "admin");
    const steward = await person(c, home); await staff(c, home, steward, "steward");
    const member = await person(c, home);
    const awayAdmin = await person(c, away); await staff(c, away, awayAdmin, "admin");

    await actAs(c, admin);
    // No reset yet: there is no debt to mint, and the same flat 42501 answers.
    await refuses(c, "select public.queue_member_mfa_reset_notice($1)", [member]);
    await refuses(c, "select public.queue_member_mfa_reset_notice($1)", [admin]);
    await refuses(c, "select public.drain_member_mfa_reset_notice($1)", [admin]);
    await c.query("select public.begin_mfa_reset($1)", [member]);
    await ageReset(c, member, "1 minute");

    // An administrator of another organization can reach neither authority,
    // exactly as they cannot reach begin_mfa_reset, record_mfa_reset or
    // notify_member_mfa_reset (20260917130000, 20260917120000).
    await actAs(c, awayAdmin);
    await refuses(c, "select public.queue_member_mfa_reset_notice($1)", [member]);
    await refuses(c, "select public.drain_member_mfa_reset_notice($1)", [member]);
    // A staff hat that is not admin is refused as well.
    await actAs(c, steward);
    await refuses(c, "select public.queue_member_mfa_reset_notice($1)", [member]);
    await refuses(c, "select public.drain_member_mfa_reset_notice($1)", [member]);
    expect(await notices(c, member)).toEqual([]);

    // A second administrator of the member's own organization cannot mint a
    // debt for a reset they did not run — begin_mfa_reset named the other
    // administrator in reset_by...
    await actAs(c, second);
    await refuses(c, "select public.queue_member_mfa_reset_notice($1)", [member]);
    // ...but once the debt exists, ANY administrator of that organization can
    // discharge it. The member is owed the notice whoever could not send it.
    await actAs(c, admin);
    expect((await c.query("select public.queue_member_mfa_reset_notice($1) as v", [member])).rows[0].v)
      .toMatchObject({ pending: true });
    await actAs(c, second);
    expect((await c.query("select public.drain_member_mfa_reset_notice($1) as v", [member])).rows[0].v)
      .toMatchObject({ drained: true, notified: true });
    expect(await notices(c, member)).toEqual([{
      title: EN_TITLE,
      body: expect.stringContaining("contact your local office"),
      kind: "general",
      created_at: expect.anything(),
    }]);
  } finally { await c.query("rollback"); await c.end(); }
});
