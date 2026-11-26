// @vitest-environment node
//
// SEC-UG-RECOVERY-CODE-USE-WRITES-NO-AUDIT-ROW-OR-NOTICE-20261112
// (#8491) on a disposable database. Consuming a claimed recovery code writes
// one member_admin_audit row and one notice to the member, in their saved
// language, with no code, hash, address or device in either. A refused or
// reused code writes neither.
// SEC-UG-ACCOUNT-RECOVERY-NOTICE-AND-RESET-LOCK-GAPS-20261117
// (#9036): the same commit queues one email to the account's own address in
// private.account_notice_mail, which the service-only claim and complete
// functions lease, mark sent or release. The row holds no code or address.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

live("recovery code use leaves an audit row and a notice, on a disposable database", () => {
  let client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false,
      application_name: "recovery-code-use-audit-rollback-proof" });
    await client.connect();
    await client.query("set statement_timeout = '20s'");
  });

  afterAll(async () => {
    await client?.end();
  });

  async function inTransaction(body) {
    await client.query("begin");
    try {
      return await body();
    } finally {
      await client.query("rollback");
    }
  }

  // A member whose recovery code has been claimed, as claim_mfa_recovery_code
  // and prepare_mfa_recovery_signout leave it, with the claim token returned.
  async function claimedCode(language = "en") {
    const user = randomUUID();
    await client.query("insert into auth.users(id,email,created_at) values ($1,$2,now())", [user, `${user}@recovery.invalid`]);
    // Isolate the recovery notice from this edition's account welcome.
    await client.query("delete from public.member_notifications where user_id=$1 and kind='general' and title='Welcome to your private organizing workspace'", [user]);
    await client.query("update public.member_profiles set language = $2 where id = $1", [user, language]);
    const token = randomBytes(32).toString("hex");
    const code = randomBytes(12).toString("hex").toUpperCase();
    await client.query(`insert into public.mfa_recovery_codes(user_id,generation,code_prefix,code_hash,claimed_at,claim_expires_at,claim_token_hash,claim_session_handle)
      values ($1,1,$2,$3,now(),now() + interval '2 minutes',$4,$5)`, [user, code.slice(0, 8), sha256(code), sha256(token), randomBytes(32).toString("hex")]);
    await client.query("insert into private.member_mfa_recovery_locks(user_id,claim_token_hash) values ($1,$2)", [user, sha256(token)]);
    return { user, token, code };
  }

  async function finalize(user, token) {
    await client.query("savepoint finalize");
    await client.query("select set_config('request.jwt.claims','{\"role\":\"service_role\"}',true)");
    await client.query("set local role service_role");
    const answer = (await client.query("select public.finalize_mfa_recovery_code($1,$2) as ok", [user, token])).rows[0].ok;
    await client.query("reset role");
    await client.query("release savepoint finalize");
    return answer;
  }

  const trail = async (user) => ({
    audit: (await client.query("select actor, action, target_user, detail from public.member_admin_audit where target_user = $1", [user])).rows,
    notices: (await client.query("select title, body, kind from public.member_notifications where user_id = $1", [user])).rows,
    mail: (await client.query("select notice, attempts, sent_at is null as waiting from private.account_notice_mail where user_id = $1", [user])).rows,
  });

  async function asRole(role, sql, params) {
    await client.query("savepoint as_role");
    try {
      await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role })]);
      await client.query(`set local role ${role}`);
      const { rows } = await client.query(sql, params);
      await client.query("reset role");
      await client.query("release savepoint as_role");
      return rows[0].r;
    } catch (error) {
      await client.query("rollback to savepoint as_role");
      return { refused: error.code };
    }
  }
  const claimMail = (user, limit = 20) => asRole("service_role", "select public.claim_account_notice_mail($1, $2) as r", [user, limit]);
  // Time passing for one row: its lease or back-off ends.
  const due = (user) => client.query("update private.account_notice_mail set next_attempt_at = now() where user_id = $1", [user]);
  const prepareMail = (id, attempt, request) => asRole("service_role", "select public.prepare_account_notice_mail($1,$2,$3::jsonb) as r", [id, attempt, JSON.stringify(request)]);
  const completeMail = (id, attempt, sent) => asRole("service_role", "select public.complete_account_notice_mail($1,$2,$3) as r", [id, attempt, sent]);

  // api/mfa-recovery.js and the dispatcher tick send the queued email
  // (tests/recovery-code-notice.test.js).
  it("writes one audit row and one English notice when a code is used", () => inTransaction(async () => {
    const { user, token, code } = await claimedCode("en");
    expect(await finalize(user, token)).toBe(true);
    const after = await trail(user);
    expect(after.audit).toEqual([{ actor: user, action: "mfa_recovery_code_used", target_user: user, detail: {} }]);
    expect(after.notices).toEqual([expect.objectContaining({ title: "A recovery code was used on your account", kind: "general" })]);
    expect(after.notices[0].body).toContain("If this was not you");
    expect(after.mail).toEqual([{ notice: "recovery_code_used", attempts: 0, waiting: true }]);
    // Nothing of the code or its claim is kept beside the trail.
    const written = JSON.stringify(after);
    for (const secret of [code, sha256(code), token, sha256(token)]) expect(written).not.toContain(secret);
  }));

  it("writes the notice in Spanish for a member who saved Spanish", () => inTransaction(async () => {
    const { user, token } = await claimedCode("es");
    expect(await finalize(user, token)).toBe(true);
    const after = await trail(user);
    expect(after.notices).toEqual([expect.objectContaining({ title: "Se usó un código de recuperación en tu cuenta" })]);
    expect(after.notices[0].body).toContain("Si no fuiste tú");
  }));

  // A member whose selected chapter is in an organization, active or not.
  async function inOrganization(user, status) {
    const organization = randomUUID();
    const chapter = `recovery-proof-${organization}`;
    await client.query("insert into public.organizations(id,slug,name,status) values ($1,$2,$3,'active')",
      [organization, `rcp-${organization}`, `Recovery Proof ${organization}`]);
    await client.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,'Proof',$1,'proof',$2,9991)", [chapter, organization]);
    await client.query("update public.member_profiles set chapter_id = $2 where id = $1", [user, chapter]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [organization, user]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [user, chapter]);
    if (status !== "active") await client.query("update public.organizations set status = $2 where id = $1", [organization, status]);
    return organization;
  }

  const consumed = async (user) => ({
    open: Number((await client.query("select count(*) from public.mfa_recovery_codes where user_id = $1 and used_at is null", [user])).rows[0].count),
    locks: Number((await client.query("select count(*) from private.member_mfa_recovery_locks where user_id = $1", [user])).rows[0].count),
  });

  it("attributes the row to the member's active organization", () => inTransaction(async () => {
    const { user, token } = await claimedCode("en");
    const organization = await inOrganization(user, "active");
    expect(await finalize(user, token)).toBe(true);
    expect((await client.query("select organization_id from public.member_admin_audit where target_user = $1", [user])).rows)
      .toEqual([{ organization_id: organization }]);
  }));

  // Round 1 of #8535: the audit trigger refused a member whose selected
  // organization is suspended, so finalize rolled back after the factor was
  // removed and every session signed out, and the recovery lock stayed.
  it("completes the recovery of a member whose organization is suspended, with an unscoped row", () => inTransaction(async () => {
    const { user, token } = await claimedCode("en");
    await inOrganization(user, "suspended");
    expect(await finalize(user, token)).toBe(true);
    expect(await consumed(user)).toEqual({ open: 0, locks: 0 });
    expect((await client.query("select actor, organization_id, detail from public.member_admin_audit where target_user = $1", [user])).rows)
      .toEqual([{ actor: user, organization_id: null, detail: {} }]);
    expect((await trail(user)).notices).toHaveLength(1);
  }));

  it("still refuses every other unscoped row from a member of a suspended organization", () => inTransaction(async () => {
    const { user } = await claimedCode("en");
    await inOrganization(user, "suspended");
    const other = (await claimedCode("en")).user;
    const attempt = async (action, detail, target = user, role = "service_role") => {
      await client.query("savepoint other_row");
      try {
        await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role })]);
        await client.query("insert into public.member_admin_audit (actor, action, target_user, detail) values ($1,$2,$3,$4)", [user, action, target, detail]);
        return "written";
      } catch (error) {
        return error.code;
      } finally {
        await client.query("rollback to savepoint other_row");
      }
    };
    expect(await attempt("self_service_password_reset", {})).toBe("42501");
    expect(await attempt("mfa_recovery_code_used", { note: "x" })).toBe("42501");
    expect(await attempt("mfa_recovery_code_used", {}, other)).toBe("42501");
    expect(await attempt("mfa_recovery_code_used", {}, user, "authenticated")).toBe("42501");
  }));

  it("writes nothing for a refused claim or a reused code", () => inTransaction(async () => {
    const { user, token } = await claimedCode("en");
    expect(await finalize(user, randomBytes(32).toString("hex"))).toBe(false);
    expect(await trail(user)).toEqual({ audit: [], notices: [], mail: [] });
    expect(await finalize(user, token)).toBe(true);
    expect(await finalize(user, token)).toBe(false);
    const after = await trail(user);
    expect(after.audit).toHaveLength(1);
    expect(after.notices).toHaveLength(1);
    expect(after.mail).toHaveLength(1);
  }));

  it("leases the queued email once, releases it on a failed send, and marks it sent exactly once", () => inTransaction(async () => {
    const { user, token, code } = await claimedCode("es");
    const bystander = await claimedCode("en");
    expect(await finalize(user, token)).toBe(true);
    expect(await finalize(bystander.user, bystander.token)).toBe(true);

    const [first] = await claimMail(user);
    expect(first).toEqual({ id: expect.any(String), notice: "recovery_code_used", attempt: 1, email: `${user}@recovery.invalid`, lang: "es" });
    for (const secret of [code, sha256(code), token, sha256(token)]) expect(JSON.stringify(first)).not.toContain(secret);
    // Leased: neither a second claim for the account nor the sweep takes it.
    expect(await claimMail(user)).toEqual([]);
    expect((await claimMail(null)).map((row) => row.email)).toEqual([`${bystander.user}@recovery.invalid`]);

    expect(await completeMail(first.id, 1, false)).toBe(true);
    // A failed try backs off: not due again at once.
    expect(await claimMail(user)).toEqual([]);
    expect(Number((await client.query("select extract(epoch from next_attempt_at - now()) s from private.account_notice_mail where user_id = $1", [user])).rows[0].s)).toBe(300);
    await due(user);
    const [retry] = await claimMail(user);
    expect(retry).toMatchObject({ id: first.id, attempt: 2 });
    // A stale attempt cannot complete it; the current one can, once.
    expect(await completeMail(first.id, 1, true)).toBe(false);
    expect(await completeMail(first.id, 2, true)).toBe(true);
    expect(await completeMail(first.id, 2, true)).toBe(false);
    expect(await claimMail(user)).toEqual([]);
    expect((await trail(user)).mail).toEqual([{ notice: "recovery_code_used", attempts: 2, waiting: false }]);
  }));

  // Retention: a row is tried for 23 hours and kept seven days from queueing;
  // only the sweep (no account given) deletes rows past seven days.
  it("stops claiming a row after 23 hours and deletes it on the sweep after seven days", () => inTransaction(async () => {
    const old = await claimedCode("en");
    const stale = await claimedCode("en");
    expect(await finalize(old.user, old.token)).toBe(true);
    expect(await finalize(stale.user, stale.token)).toBe(true);
    await client.query("update private.account_notice_mail set created_at = now() - interval '8 days' where user_id = $1", [old.user]);
    await client.query("update private.account_notice_mail set created_at = now() - interval '25 hours' where user_id = $1", [stale.user]);

    // An account's own claim neither sends nor deletes either one.
    expect(await claimMail(old.user)).toEqual([]);
    expect(await claimMail(stale.user)).toEqual([]);
    expect((await trail(old.user)).mail).toHaveLength(1);

    const swept = await claimMail(null);
    expect(swept.map((row) => row.email)).not.toContain(`${old.user}@recovery.invalid`);
    expect(swept.map((row) => row.email)).not.toContain(`${stale.user}@recovery.invalid`);
    expect((await trail(old.user)).mail).toEqual([]);
    expect((await trail(stale.user)).mail).toEqual([{ notice: "recovery_code_used", attempts: 0, waiting: true }]);
  }));

  // #9076 round 1, r1s4/r2s2: every try sends what was stored at queueing.
  it("returns the address and language stored when the row was queued, not the account's current ones", () => inTransaction(async () => {
    const { user, token } = await claimedCode("es");
    expect(await finalize(user, token)).toBe(true);
    await client.query("update public.member_profiles set language = 'en' where id = $1", [user]);
    await client.query("update auth.users set email = $2 where id = $1", [user, `changed-${user}@recovery.invalid`]);
    const [row] = await claimMail(user);
    expect(row).toMatchObject({ email: `${user}@recovery.invalid`, lang: "es" });
    expect(await completeMail(row.id, 1, false)).toBe(true);
    await due(user);
    expect(await claimMail(user)).toEqual([expect.objectContaining({ id: row.id, attempt: 2, email: `${user}@recovery.invalid`, lang: "es" })]);
  }));

  // #9076 final, r3s2/r4s1: the complete provider request is stored once and
  // every try gets the stored one back, even if the sender rebuilt it.
  it("stores the provider request once, only to the stored address, and returns it on every try", () => inTransaction(async () => {
    const { user, token } = await claimedCode("en");
    expect(await finalize(user, token)).toBe(true);
    const [row] = await claimMail(user);
    const first = { from: "Union Ground <alerts@example.invalid>", to: [`${user}@recovery.invalid`], subject: "s", text: "t 100 Fixture Street", html: "<p>h</p>" };
    // Addressed elsewhere, or missing a field: nothing is stored.
    expect(await prepareMail(row.id, 1, { ...first, to: ["someone-else@example.invalid"] })).toBeNull();
    expect(await prepareMail(row.id, 1, { from: first.from, to: first.to, subject: "s", text: "t" })).toBeNull();
    expect(await prepareMail(row.id, 1, first)).toEqual(first);
    // A wrong attempt gets nothing.
    expect(await prepareMail(row.id, 2, first)).toBeNull();
    expect(await completeMail(row.id, 1, false)).toBe(true);
    await due(user);
    const [retry] = await claimMail(user);
    // The rebuilt request after a redeploy differs; the stored one comes back.
    expect(await prepareMail(retry.id, 2, { ...first, from: "Other <notices@example.invalid>", text: "t 200 Other Avenue" })).toEqual(first);
  }));

  // #9076 round 1, r1s2: rows that keep failing never hold back a newer one.
  it("claims soonest-due first, so a failing older row backs off behind a newer one", () => inTransaction(async () => {
    const older = await claimedCode("en");
    const newer = await claimedCode("en");
    expect(await finalize(older.user, older.token)).toBe(true);
    await client.query("update private.account_notice_mail set created_at = now() - interval '1 hour', next_attempt_at = now() - interval '1 hour' where user_id = $1", [older.user]);
    expect(await finalize(newer.user, newer.token)).toBe(true);
    const [first] = await claimMail(older.user, 1);
    expect(await completeMail(first.id, 1, false)).toBe(true);
    const swept = await claimMail(null, 1);
    expect(swept.map((row) => row.email)).toEqual([`${newer.user}@recovery.invalid`]);
  }));

  // #9076 round 1, r1s3/r2s4: the purge-only call claims nothing.
  it("purges old rows and claims nothing on the zero-limit sweep call", () => inTransaction(async () => {
    const old = await claimedCode("en");
    const fresh = await claimedCode("en");
    expect(await finalize(old.user, old.token)).toBe(true);
    expect(await finalize(fresh.user, fresh.token)).toBe(true);
    await client.query("update private.account_notice_mail set created_at = now() - interval '8 days' where user_id = $1", [old.user]);
    expect(await claimMail(null, 0)).toEqual([]);
    expect((await trail(old.user)).mail).toEqual([]);
    expect((await trail(fresh.user)).mail).toEqual([{ notice: "recovery_code_used", attempts: 0, waiting: true }]);
  }));

  it("lets no client role read the queue or call its functions, and removes the rows with the account", () => inTransaction(async () => {
    const { user, token } = await claimedCode("en");
    expect(await finalize(user, token)).toBe(true);
    for (const role of ["anon", "authenticated"]) {
      expect(await asRole(role, "select public.claim_account_notice_mail(null, 20) as r")).toEqual({ refused: "42501" });
      expect(await asRole(role, "select public.complete_account_notice_mail(gen_random_uuid(), 1, true) as r")).toEqual({ refused: "42501" });
      expect(await asRole(role, "select public.prepare_account_notice_mail(gen_random_uuid(), 1, '{}'::jsonb) as r")).toEqual({ refused: "42501" });
    }
    for (const role of ["anon", "authenticated", "service_role"]) {
      expect(await asRole(role, "select count(*) as r from private.account_notice_mail")).toEqual({ refused: "42501" });
    }
    await client.query("delete from auth.users where id = $1", [user]);
    expect(Number((await client.query("select count(*) from private.account_notice_mail where user_id = $1", [user])).rows[0].count)).toBe(0);
  }));
});
