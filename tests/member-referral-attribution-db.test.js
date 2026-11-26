// @vitest-environment node
//
// REQ-UG-MEMBER-REFERRAL-ATTRIBUTION-20261110 (#8152): referral codes,
// the referral record, activation at the first check-in and the members-recruited
// count, on a disposable database after 20261111184100. Two fictional tenants
// (Harbor Workers Local 7, Ridge Transit Local 9). Every test runs in one
// transaction that is rolled back.
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
// #8772: the migration's own backfill statement, run as written. Found by its
// name, not its stamp.
const WAIT_MIGRATION = readFileSync(new URL(`../supabase/migrations/${readdirSync(new URL("../supabase/migrations/", import.meta.url))
  .find((name) => name.endsWith("_referral_over_weekly_cap_waits_for_a_later_week.sql"))}`, import.meta.url), "utf8");
const BACKFILL = /insert into private\.member_referral_payouts_waiting \(award_key, referrer_user_id, waiting_since\)[\s\S]*?on conflict \(award_key\) do nothing;/u
  .exec(WAIT_MIGRATION)[0];

live("member referral attribution on a disposable database", () => {
  let client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false,
      application_name: "member-referral-attribution-rollback-proof" });
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

  async function tenant(label) {
    const org = randomUUID();
    const chapter = `${label}-${org}`;
    await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$3)", [org, `${label}-${org}`, `${label} ${org}`]);
    await client.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$2,$1,'East',$3,1)",
      [chapter, `${label} chapter`, org]);
    return { org, chapter };
  }

  async function member(t) {
    const id = randomUUID();
    await client.query("insert into auth.users(id,email,raw_user_meta_data) values ($1,$2,'{\"full_name\":\"Synthetic Person\"}')",
      [id, `${id}@example.invalid`]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [t.org, id]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [id, t.chapter]);
    return id;
  }

  // An administrator-issued invitation that the referred member accepted.
  async function acceptedInvitation(t, userId) {
    const id = randomUUID();
    await client.query(
      `insert into public.member_invitations(id,normalized_email,full_name,first_name,initials,chapter_id,status,auth_user_id,expires_at,accepted_at)
       values ($1,$2,'Synthetic Person','Synthetic','SP',$3,'accepted',$4,now() + interval '7 days',now())`,
      [id, `${userId}@example.invalid`, t.chapter, userId]);
    return id;
  }

  const codeOf = async (userId) => (await client.query("select private.member_referral_code($1) as code", [userId])).rows[0].code;
  const record = async (invitation, code) => (await client.query("select public.record_member_referral($1,$2) as r", [invitation, code])).rows[0].r;
  const checkIn = (userId, event) => client.query(
    "insert into public.member_point_events(user_id,action_key,action_kind,points) values ($1,$2,'checkin',10)", [userId, `checkin-${event}`]);
  const referralPoints = async (userId) => (await client.query(
    "select coalesce(sum(points),0)::int as points, count(*)::int as events from public.member_point_events where user_id=$1 and action_kind='referral'", [userId])).rows[0];
  const summaryAs = async (userId, rpc = "get_member_referral_summary") => {
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: userId, role: "authenticated" })]);
    await client.query("set local role authenticated");
    try {
      return (await client.query(`select public.${rpc}() as s`)).rows[0].s;
    } finally {
      await client.query("reset role");
    }
  };

  it("derives a stable twelve-digit code per member that differs between members", () => inTransaction(async () => {
    const t = await tenant("hwl7");
    const a = await member(t);
    const b = await member(t);
    const codeA = await codeOf(a);
    expect(codeA).toMatch(/^[0-9A-F]{12}$/);
    expect(await codeOf(a)).toBe(codeA);
    expect(await codeOf(b)).not.toBe(codeA);
  }));

  it("records a referral when an administrator-issued invitation is accepted with a member's code", () => inTransaction(async () => {
    const t = await tenant("hwl7");
    const referrer = await member(t);
    const referred = await member(t);
    const invitation = await acceptedInvitation(t, referred);
    expect(await record(invitation, (await codeOf(referrer)).toLowerCase())).toEqual({ recorded: true });
    const { rows } = await client.query("select referrer_user_id, organization_id, code, activated_at from private.member_referrals where referred_user_id=$1", [referred]);
    expect(rows).toEqual([{ referrer_user_id: referrer, organization_id: t.org, code: await codeOf(referrer), activated_at: null }]);
    const columns = (await client.query("select column_name from information_schema.columns where table_schema='private' and table_name='member_referrals'")).rows.map((row) => row.column_name);
    expect(columns.some((name) => /mail/u.test(name))).toBe(false);
  }));

  it("refuses a self-referral", () => inTransaction(async () => {
    const t = await tenant("hwl7");
    const self = await member(t);
    const invitation = await acceptedInvitation(t, self);
    expect(await record(invitation, await codeOf(self))).toEqual({ recorded: false, reason: "no-member" });
    await client.query("savepoint s");
    await expect(client.query("insert into private.member_referrals(referrer_user_id,referred_user_id,organization_id,code) values ($1,$1,$2,'ABCDEF012345')", [self, t.org]))
      .rejects.toMatchObject({ code: "23514" });
    await client.query("rollback to savepoint s");
  }));

  it("refuses a second referring member for the same person", () => inTransaction(async () => {
    const t = await tenant("hwl7");
    const first = await member(t);
    const second = await member(t);
    const referred = await member(t);
    const invitation = await acceptedInvitation(t, referred);
    expect(await record(invitation, await codeOf(first))).toEqual({ recorded: true });
    expect(await record(invitation, await codeOf(second))).toEqual({ recorded: false });
    await client.query("savepoint s");
    await expect(client.query("insert into private.member_referrals(referrer_user_id,referred_user_id,organization_id,code) values ($1,$2,$3,'ABCDEF012345')", [second, referred, t.org]))
      .rejects.toMatchObject({ code: "23505" });
    await client.query("rollback to savepoint s");
    expect((await client.query("select referrer_user_id from private.member_referrals where referred_user_id=$1", [referred])).rows).toEqual([{ referrer_user_id: first }]);
  }));

  it("refuses a referral across organizations, and an invitation that was not accepted", () => inTransaction(async () => {
    const home = await tenant("hwl7");
    const other = await tenant("rtl9");
    const outsider = await member(other);
    const referred = await member(home);
    const invitation = await acceptedInvitation(home, referred);
    expect(await record(invitation, await codeOf(outsider))).toEqual({ recorded: false, reason: "no-member" });
    expect(await record(invitation, "not a code")).toEqual({ recorded: false, reason: "invalid-code" });
    expect(await record(randomUUID(), await codeOf(outsider))).toEqual({ recorded: false, reason: "invitation-not-accepted" });
    expect((await client.query("select count(*)::int as n from private.member_referrals where referred_user_id=$1", [referred])).rows[0].n).toBe(0);
  }));






  // #8772: a referral over the cap waits for a later week instead of being consumed.
  // The cap week is date_trunc('week', now()), the same as every other weekly point cap.
  const waiting = async (referrer) => (await client.query(
    `select (select count(*)::int from private.member_referral_payouts_waiting w where w.referrer_user_id = $1) as waiting,
            (select count(*)::int from private.member_referrals r where r.referrer_user_id = $1 and r.activated_at is not null) as active`,
    [referrer])).rows[0];
  // Moves the referrer's paid referral events and waiting marks into last week, as if
  // a week had passed (one test transaction has one now()).
  const aWeekPasses = async (referrer) => {
    await client.query(
      "update public.member_point_events set occurred_at = date_trunc('week', now()) - interval '1 day' where user_id=$1 and action_kind='referral'", [referrer]);
    await client.query(
      "update private.member_referral_payouts_waiting set waiting_since = date_trunc('week', now()) - interval '1 day' where referrer_user_id=$1", [referrer]);
  };
  async function referralsCheckedIn(t, referrer, count, label) {
    const code = await codeOf(referrer);
    const recruits = [];
    for (let index = 0; index < count; index += 1) {
      const referred = await member(t);
      await record(await acceptedInvitation(t, referred), code);
      await checkIn(referred, `${label}-${index}`);
      recruits.push(referred);
    }
    return recruits;
  }





  // The waiting payout outlasts the referral row.

  // Gate final r3s1/r4s2: any successful check-in settles a waiting payout,
  // through the real check-in RPC, even while check-ins earn 0 points.

  // The backfill judges each old activation by
  // the rule in force when it activated, from the revision log.
  async function oldConsumedReferral(t, referrer, activatedAt) {
    const referred = await member(t);
    const id = randomUUID();
    await client.query(
      "insert into private.member_referrals(id, referrer_user_id, referred_user_id, organization_id, code, activated_at) values ($1,$2,$3,$4,$5,$6)",
      [id, referrer, referred, t.org, await codeOf(referrer), activatedAt]);
    return id;
  }
  const lastWeek = async (hours) => (await client.query(
    "select (date_trunc('week', now()) - interval '7 days' + make_interval(hours => $1))::text as at", [hours])).rows[0].at;
  const awardAt = (referrer, at) => client.query(
    "insert into public.member_point_events(user_id, action_key, action_kind, points, occurred_at) values ($1, $2, 'referral', 50, $3)",
    [referrer, `referral-${randomUUID()}`, at]);
  const ruleRevision = (at, oldValue, newValue) => client.query(
    "insert into public.member_reward_economy_revisions(entity_kind, entity_key, old_value, new_value, created_at) values ('point_rule','referral',$1::jsonb,$2::jsonb,$3)",
    [JSON.stringify(oldValue), JSON.stringify(newValue), at]);
  const rule = (points, cap) => ({ action_kind: "referral", label: "Recruit a member", points, weekly_cap: cap });
  const backfilled = async (referralId) => (await client.query(
    "select count(*)::int as n from private.member_referral_payouts_waiting where award_key = $1", [`referral-${referralId}`])).rows[0].n;


  it("does not backfill a referral that activated while the rule paid nothing, even in a week that reached the cap (#8772)", () => inTransaction(async () => {
    const t = await tenant("hwl7");
    const referrer = await member(t);
    await awardAt(referrer, await lastWeek(10));
    await awardAt(referrer, await lastWeek(11));
    // The operator turned the rule off, a referral activated, then turned it back on.
    await ruleRevision(await lastWeek(12), rule(50, 2), rule(0, 2));
    const off = await oldConsumedReferral(t, referrer, await lastWeek(13));
    await ruleRevision(await lastWeek(14), rule(0, 2), rule(50, 2));
    await client.query(BACKFILL);
    expect(await backfilled(off)).toBe(0);
  }));

  it("backfills by the rule in force at activation, not today's, whatever the order of the awards' timestamps (#8772)", () => inTransaction(async () => {
    const t = await tenant("hwl7");
    const referrer = await member(t);
    await awardAt(referrer, await lastWeek(10));
    await awardAt(referrer, await lastWeek(11));
    const capped = await oldConsumedReferral(t, referrer, await lastWeek(12));
    // The cap was raised to 5 after the activation: the cap then was 2, so it is owed.
    await ruleRevision(await lastWeek(20), rule(50, 2), rule(50, 5));
    await client.query("update public.member_point_rules set weekly_cap = 5 where action_kind = 'referral'");
    // Gate final r3s2: a second referrer whose awards carry later transaction-start
    // timestamps than the activation they capped is still backfilled; the backfill
    // takes no count, so timestamp order does not matter.
    const other = await member(t);
    const skewed = await oldConsumedReferral(t, other, await lastWeek(9));
    await awardAt(other, await lastWeek(15));
    await awardAt(other, await lastWeek(16));
    await client.query(BACKFILL);
    expect(await backfilled(capped)).toBe(1);
    expect(await backfilled(skewed)).toBe(1);
  }));

  it("gives a client no direct access, and shows the member only their own code and count", () => inTransaction(async () => {
    const t = await tenant("hwl7");
    const referrer = await member(t);
    const referred = await member(t);
    await record(await acceptedInvitation(t, referred), await codeOf(referrer));
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      for (const role of ["anon", "authenticated"]) {
        expect((await client.query("select has_table_privilege($1,'private.member_referrals',$2) as ok", [role, privilege])).rows[0].ok).toBe(false);
      }
    }
    expect((await client.query("select has_function_privilege('authenticated','public.record_member_referral(uuid,text)','EXECUTE') as ok")).rows[0].ok).toBe(false);
    expect((await client.query("select has_function_privilege('authenticated','private.member_referral_code(uuid)','EXECUTE') as ok")).rows[0].ok).toBe(false);
    expect(await summaryAs(referrer)).toEqual({ code: await codeOf(referrer), recruitedYtd: 1 });
    expect(await summaryAs(referred)).toEqual({ code: await codeOf(referred), recruitedYtd: 0 });
    // The Home tile reads the same count from the rewards summary it already loads.
    expect((await summaryAs(referrer, "get_member_rewards_summary")).recruitedYtd).toBe(1);
    expect((await summaryAs(referred, "get_member_rewards_summary")).recruitedYtd).toBe(0);
  }));
});
