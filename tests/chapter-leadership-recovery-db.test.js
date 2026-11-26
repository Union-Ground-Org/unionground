// @vitest-environment node
//
// REQ-UG-CHAPTER-LEADERSHIP-RECOVERY-20261001 (old lib/chapter-takeover).
//
// On a disposable database this proves the restored claim path end to end:
// eligibility from real activity (sign-in, session refresh, authored work, a
// recent role grant), the organization switch and limits, the MFA-assured
// (AAL2) caller, one claim per chapter, immediate organization-admin notices,
// rejection with a 30-day wait, tenant isolation of the admin review, the
// cooling-off grant through set_member_chapter_role's writes and audit row,
// the lapse when a leader comes back, and immutable claim evidence.
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { stripComments } from "./helpers/migration.js";

const MIGRATION = "supabase/migrations/20261003051000_governance_leadership_recovery_and_officer_removal.sql";
const migration = readFileSync(new URL(`../${MIGRATION}`, import.meta.url), "utf8");
const SWITCH = "features.governance.chapter_leadership_recovery";
const MONTHS = "limits.governance.leadership_inactivity_months";
const HOURS = "limits.governance.leadership_claim_cooling_off_hours";

describe("chapter leadership recovery (static)", () => {
  it("registers the switch ON with the old six months and a 72-hour cooling-off window", () => {
    expect(migration).toMatch(/\nbegin;\n/);
    expect(migration.trimEnd()).toMatch(/\ncommit;$/);
    expect(migration).toContain(`('${SWITCH}', 'boolean'`);
    expect(migration).toMatch(/'6', 3, 24, null, 20, 'governance', true\)/);
    expect(migration).toMatch(/'72', 24, 336, null, 30, 'governance', true\)/);
    expect(migration).toMatch(/policy\.ts:4 TAKEOVER_INACTIVITY_MONTHS = 6/);
    const code = stripComments(migration);
    expect(code).toMatch(/cron\.schedule\(\s*'chapter-leadership-claims-tick',\s*'\*\/15 \* \* \* \*'/);
    expect(code).not.toMatch(/grant [^;]* to (anon|public)\b/i);
    expect(code).toMatch(/coalesce\(\(select auth\.jwt\(\)\) ->> 'aal', ''\) <> 'aal2'/);
  });
});

const ID = {
  org: "51801800-0000-4000-8000-000000000001",
  otherOrg: "51801800-0000-4000-8000-000000000002",
  claimant: "51801800-0000-4000-8000-000000000101",
  second: "51801800-0000-4000-8000-000000000102",
  leader: "51801800-0000-4000-8000-000000000103",
  admin: "51801800-0000-4000-8000-000000000104",
  outsiderAdmin: "51801800-0000-4000-8000-000000000105",
  aal1Member: "51801800-0000-4000-8000-000000000106",
  claimantSession: "51801800-0000-4000-8000-000000000201",
  secondSession: "51801800-0000-4000-8000-000000000202",
  adminSession: "51801800-0000-4000-8000-000000000204",
  outsiderSession: "51801800-0000-4000-8000-000000000205",
  aal1Session: "51801800-0000-4000-8000-000000000206",
};
const CHAPTER = "leadership-recovery-chapter";
const NEW_CHAPTER = "leadership-recovery-new-chapter";
const OUTSIDE_CHAPTER = "leadership-recovery-outside-chapter";
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("chapter leadership recovery on a disposable database", () => {
  let db;

  async function as(userId, sessionId, sql, values = [], aal = "aal2") {
    await db.query("savepoint leadership_call");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        sub: userId, role: "authenticated", session_id: sessionId, aal,
      })]);
      await db.query("set local role authenticated");
      const result = await db.query(sql, values);
      await db.query("reset role");
      await db.query("release savepoint leadership_call");
      return result.rows[0] ? Object.values(result.rows[0])[0] : null;
    } catch (error) {
      await db.query("rollback to savepoint leadership_call");
      await db.query("reset role").catch(() => {});
      throw error;
    }
  }

  async function failure(promise) {
    try {
      await promise;
    } catch (error) {
      return { code: error.code, message: error.message };
    }
    throw new Error("expected the call to fail");
  }

  // A direct statement expected to fail, isolated so the proof transaction survives.
  async function rawFailure(sql, values = []) {
    await db.query("savepoint leadership_raw");
    try {
      await db.query(sql, values);
    } catch (error) {
      await db.query("rollback to savepoint leadership_raw");
      return { code: error.code, message: error.message };
    }
    await db.query("release savepoint leadership_raw");
    throw new Error("expected the statement to fail");
  }

  async function withChange(sql, values, check) {
    await db.query("savepoint leadership_change");
    try {
      if (sql) await db.query(sql, values);
      await check();
    } finally {
      await db.query("rollback to savepoint leadership_change");
    }
  }

  const recovery = (userId = ID.claimant, sessionId = ID.claimantSession, aal) =>
    as(userId, sessionId, "select public.get_chapter_leadership_recovery() r", [], aal);
  const claim = (userId = ID.claimant, sessionId = ID.claimantSession, chapter = CHAPTER, aal) =>
    as(userId, sessionId, "select public.claim_chapter_leadership($1) r", [chapter], aal);

  beforeAll(async () => {
    db = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "chapter-leadership-recovery-proof",
    });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '60s'");
    await db.query("set local lock_timeout = '15s'");
    await db.query(
      `insert into auth.users (id, email, created_at, last_sign_in_at) values
        ($1, 'leadership-claimant@example.invalid', now() - interval '2 years', now()),
        ($2, 'leadership-second@example.invalid', now() - interval '2 years', now()),
        ($3, 'leadership-leader@example.invalid', now() - interval '2 years', now() - interval '1 year'),
        ($4, 'leadership-admin@example.invalid', now() - interval '2 years', now()),
        ($5, 'leadership-outsider@example.invalid', now() - interval '2 years', now()),
        ($6, 'leadership-aal1@example.invalid', now() - interval '2 years', now())`,
      [ID.claimant, ID.second, ID.leader, ID.admin, ID.outsiderAdmin, ID.aal1Member],
    );
    await db.query(
      `insert into public.organizations(id, slug, name, created_by) values
        ($1, 'leadership-recovery-org', 'Leadership recovery proof org', $3),
        ($2, 'leadership-recovery-other', 'Leadership recovery other org', $4)`,
      [ID.org, ID.otherOrg, ID.admin, ID.outsiderAdmin],
    );
    await db.query(
      `insert into public.chapters(id, name, slug, organization_id, is_default, order_index, created_at) values
        ($1, 'Leadership Proof Chapter', $1, $4, false, 91801, now() - interval '3 years'),
        ($2, 'Leadership New Chapter', $2, $4, false, 91802, now() - interval '1 month'),
        ($3, 'Leadership Outside Chapter', $3, $5, false, 91803, now() - interval '3 years')`,
      [CHAPTER, NEW_CHAPTER, OUTSIDE_CHAPTER, ID.org, ID.otherOrg],
    );
    // The organization admin belongs to another chapter of the organization,
    // so the proof chapter's only leader is its long-inactive steward.
    for (const [userId, chapterId] of [[ID.claimant, CHAPTER], [ID.second, CHAPTER], [ID.leader, CHAPTER], [ID.aal1Member, CHAPTER], [ID.admin, NEW_CHAPTER]]) {
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ID.org, userId]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [userId, chapterId]);
      await db.query("update public.member_profiles set chapter_id = $2 where id = $1", [userId, chapterId]);
    }
    await db.query("update public.member_profiles set full_name = 'Casey Claimant' where id = $1", [ID.claimant]);
    await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ID.otherOrg, ID.outsiderAdmin]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [ID.outsiderAdmin, OUTSIDE_CHAPTER]);
    await db.query("update public.member_profiles set chapter_id = $2 where id = $1", [ID.outsiderAdmin, OUTSIDE_CHAPTER]);
    await db.query(
      "insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'admin',$2),($3,$4,'admin',$4)",
      [ID.org, ID.admin, ID.otherOrg, ID.outsiderAdmin],
    );
    // The chapter's only steward: appointed and last seen a year ago.
    await db.query("insert into public.member_roles(user_id, role, chapter_id, granted_at) values($1,'steward',$2, now() - interval '1 year')", [ID.leader, CHAPTER]);
    await db.query("insert into public.member_role_chapters(user_id, role, chapter_id, granted_at) values($1,'steward',$2, now() - interval '1 year')", [ID.leader, CHAPTER]);
    await db.query(
      `insert into auth.sessions(id,user_id,aal,created_at,updated_at) values
        ($1,$2,'aal2',now(),now()), ($3,$4,'aal2',now(),now()), ($5,$6,'aal2',now(),now()),
        ($7,$8,'aal2',now(),now()), ($9,$10,'aal1',now(),now())`,
      [ID.claimantSession, ID.claimant, ID.secondSession, ID.second, ID.adminSession, ID.admin,
        ID.outsiderSession, ID.outsiderAdmin, ID.aal1Session, ID.aal1Member],
    );
    await db.query(
      `insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at)
       select gen_random_uuid(), u, 'proof-totp', 'totp', 'verified', now(), now()
       from unnest($1::uuid[]) u`,
      [[ID.claimant, ID.second, ID.admin, ID.outsiderAdmin]],
    );
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  it("registers the governance switch and limits for members to read", async () => {
    const rows = (await db.query(
      "select key, value_kind, default_value, category, member_visible from public.platform_setting_definitions where key = any($1) order by key",
      [[SWITCH, MONTHS, HOURS]],
    )).rows;
    expect(rows).toEqual([
      { key: SWITCH, value_kind: "boolean", default_value: true, category: "governance", member_visible: true },
      { key: HOURS, value_kind: "integer", default_value: 72, category: "governance", member_visible: true },
      { key: MONTHS, value_kind: "integer", default_value: 6, category: "governance", member_visible: true },
    ]);
  });

  it("offers the claim when every chapter leader has been inactive for the window", async () => {
    expect(await recovery()).toMatchObject({
      available: true, eligible: true, reason: "eligible", chapterId: CHAPTER,
      inactiveLeaderCount: 1, inactivityMonths: 6, coolingOffHours: 72, mfaAssured: true, claim: null,
    });
  });

  it.each([
    ["a recent sign-in", "update auth.users set last_sign_in_at = now() - interval '2 days' where id = $1"],
    ["a live session refresh", "insert into auth.sessions(id,user_id,aal,created_at,updated_at,refreshed_at) values (gen_random_uuid(),$1,'aal1',now() - interval '1 year',now() - interval '1 day',(now() - interval '1 hour') at time zone 'UTC')"],
    ["authored admin work", "insert into public.member_admin_audit(actor, action, detail) values ($1, 'create_event', '{}'::jsonb)"],
    ["a recent appointment", "update public.member_role_chapters set granted_at = now() - interval '1 week' where user_id = $1"],
  ])("treats a leader with %s as active", async (_label, sql) => {
    await withChange(sql, [ID.leader], async () => {
      expect(await recovery()).toMatchObject({ eligible: false, reason: "active_leader_present", inactiveLeaderCount: null });
      expect(await failure(claim())).toMatchObject({ code: "22023", message: "leadership claim unavailable: active_leader_present" });
    });
  });

  it.each(['admin', 'steward'])("blocks a recovery claim after a recent organization %s grant to an inactive leader", async (role) => {
    await withChange(
      "insert into public.organization_role_grants(organization_id,user_id,role,granted_by,granted_at) values($1,$2,$3,$4,now()-interval '1 day')",
      [ID.org, ID.leader, role, ID.admin], async () => {
        expect(await recovery()).toMatchObject({ eligible: false, reason: "active_leader_present" });
        expect(await failure(claim())).toMatchObject({ code: "22023", message: "leadership claim unavailable: active_leader_present" });
      },
    );
  });

  it("keeps recovery eligible for an old organization grant, and ignores grants in another organization", async () => {
    await withChange(
      "insert into public.organization_role_grants(organization_id,user_id,role,granted_by,granted_at) values($1,$2,'steward',$3,now()-interval '1 year')",
      [ID.org, ID.leader, ID.admin], async () => expect(await recovery()).toMatchObject({ eligible: true, reason: "eligible" }),
    );
    // Isolate the grant scope from other activity signals with the old leader.
    await withChange(
      "insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')",
      [ID.otherOrg, ID.leader], async () => {
        await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'steward',$3)", [ID.otherOrg, ID.leader, ID.outsiderAdmin]);
        expect(await recovery()).toMatchObject({ eligible: true, reason: "eligible" });
      },
    );
  });

  it("counts an organization steward who belongs to the chapter as a leader", async () => {
    await withChange(
      "insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'steward',$2)",
      [ID.org, ID.second],
      async () => {
        // The second member signed in today, so the chapter has an active leader.
        expect(await recovery()).toMatchObject({ eligible: false, reason: "active_leader_present" });
        expect(await recovery(ID.second, ID.secondSession)).toMatchObject({ eligible: false, reason: "already_leader" });
      },
    );
  });

  it("follows the organization switch and inactivity limit", async () => {
    await withChange(
      "insert into public.organization_setting_values(organization_id,setting_key,value,updated_by) values($1,$2,'false'::jsonb,$3)",
      [ID.org, SWITCH, ID.admin],
      async () => {
        expect(await recovery()).toMatchObject({ available: false, eligible: false, reason: "disabled" });
        expect(await failure(claim())).toMatchObject({ code: "22023", message: "leadership claim unavailable: disabled" });
      },
    );
    await withChange(
      "insert into public.organization_setting_values(organization_id,setting_key,value,updated_by) values($1,$2,'18'::jsonb,$3)",
      [ID.org, MONTHS, ID.admin],
      async () => expect(await recovery()).toMatchObject({ eligible: false, reason: "active_leader_present", inactivityMonths: 18 }),
    );
  });

  it("never offers a chapter younger than the window or a chapter the caller does not belong to", async () => {
    await withChange(
      "update public.chapters set created_at = now() - interval '2 months' where id = $1",
      [CHAPTER],
      async () => expect(await recovery()).toMatchObject({ eligible: false, reason: "chapter_too_new" }),
    );
    expect(await failure(claim(ID.claimant, ID.claimantSession, OUTSIDE_CHAPTER))).toMatchObject({ code: "42501", message: "chapter unavailable" });
    expect(await failure(claim(ID.outsiderAdmin, ID.outsiderSession, CHAPTER))).toMatchObject({ code: "42501", message: "chapter unavailable" });
  });

  it("requires an MFA-assured (AAL2) session to claim", async () => {
    expect(await recovery(ID.aal1Member, ID.aal1Session, "aal1")).toMatchObject({ eligible: true, mfaAssured: false });
    expect(await failure(claim(ID.aal1Member, ID.aal1Session, CHAPTER, "aal1"))).toMatchObject({ code: "42501", message: "two-step sign-in required" });
  });

  describe("after a member claims", () => {
    let claimed;

    beforeAll(async () => {
      claimed = await claim();
    });

    it("records a pending claim that takes effect after the cooling-off window", async () => {
      expect(claimed).toMatchObject({ chapterId: CHAPTER, status: "pending", inactiveLeaderCount: 1, coolingOffHours: 72, inactivityMonths: 6 });
      const hours = (Date.parse(claimed.effectiveAt) - Date.parse(claimed.claimedAt)) / 3_600_000;
      expect(hours).toBe(72);
      expect(await recovery()).toMatchObject({ eligible: false, reason: "claim_pending", claim: { id: claimed.id, status: "pending" } });
    });

    it("tells organization admins at once and nobody else", async () => {
      const notices = (await db.query(
        "select user_id, title, kind from public.member_notifications where title = 'Chapter leadership claim to review'",
      )).rows;
      expect(notices).toEqual([{ user_id: ID.admin, title: "Chapter leadership claim to review", kind: "general" }]);
    });

    it("allows one open claim per chapter", async () => {
      expect(await failure(claim(ID.second, ID.secondSession))).toMatchObject({ code: "22023", message: "leadership claim unavailable: claim_pending" });
      const duplicate = await rawFailure(
        `insert into public.chapter_leadership_claims(organization_id, chapter_id, claimant_user_id, inactivity_months, cooling_off_hours,
           inactive_leader_count, activity_cutoff, claimed_at, effective_at)
         values ($1, $2, $3, 6, 72, 1, now() - interval '6 months', now(), now() + interval '72 hours')`,
        [ID.org, CHAPTER, ID.second],
      );
      expect(duplicate.code).toBe("23505");
    });

    it("lists the claim for organization admins only, inside their organization", async () => {
      const list = await as(ID.admin, ID.adminSession, "select public.list_chapter_leadership_claims(50) r");
      expect(list).toMatchObject({ enabled: true, inactivityMonths: 6, coolingOffHours: 72 });
      expect(list.items).toEqual([expect.objectContaining({
        id: claimed.id, status: "pending", chapterName: "Leadership Proof Chapter", claimantName: "Casey Claimant",
      })]);
      expect(await failure(as(ID.claimant, ID.claimantSession, "select public.list_chapter_leadership_claims(50) r")))
        .toMatchObject({ code: "42501" });
      const outside = await as(ID.outsiderAdmin, ID.outsiderSession, "select public.list_chapter_leadership_claims(50) r");
      expect(outside.items).toEqual([]);
      expect(await failure(as(ID.outsiderAdmin, ID.outsiderSession, "select public.reject_chapter_leadership_claim($1, null) r", [claimed.id])))
        .toMatchObject({ code: "P0002" });
    });

    it("keeps the claim's evidence immutable", async () => {
      expect((await rawFailure(
        "update public.chapter_leadership_claims set effective_at = now() where id = $1", [claimed.id],
      )).code).toBe("42501");
    });

    it("lets an organization admin reject it during the window, and the claimant waits 30 days", async () => {
      await withChange(null, [], async () => {
        const rejected = await as(ID.admin, ID.adminSession, "select public.reject_chapter_leadership_claim($1, $2) r", [claimed.id, "Elections are next month."]);
        expect(rejected).toMatchObject({ id: claimed.id, status: "rejected", decisionNote: "Elections are next month." });
        const row = (await db.query("select decided_by, decided_at is not null decided from public.chapter_leadership_claims where id = $1", [claimed.id])).rows[0];
        expect(row).toEqual({ decided_by: ID.admin, decided: true });
        const notice = (await db.query(
          "select title from public.member_notifications where user_id = $1 and title = 'Chapter leadership claim not approved'", [ID.claimant],
        )).rows;
        expect(notice).toHaveLength(1);
        expect(await recovery()).toMatchObject({ eligible: false, reason: "recently_rejected", claim: { status: "rejected" } });
        expect(await failure(as(ID.admin, ID.adminSession, "select public.reject_chapter_leadership_claim($1, null) r", [claimed.id])))
          .toMatchObject({ code: "P0002" });
        // Another member may still claim.
        expect(await claim(ID.second, ID.secondSession)).toMatchObject({ status: "pending" });
      });
    });

    it("lets the claimant withdraw it", async () => {
      await withChange(null, [], async () => {
        expect(await failure(as(ID.second, ID.secondSession, "select public.withdraw_chapter_leadership_claim($1) r", [claimed.id])))
          .toMatchObject({ code: "P0002" });
        expect(await as(ID.claimant, ID.claimantSession, "select public.withdraw_chapter_leadership_claim($1) r", [claimed.id]))
          .toMatchObject({ status: "withdrawn" });
      });
    });

    it("does nothing before the window ends", async () => {
      await withChange(null, [], async () => {
        expect((await db.query("select private.finalize_due_chapter_leadership_claims(50) n")).rows[0].n).toBe(0);
        expect((await db.query("select status from public.chapter_leadership_claims where id = $1", [claimed.id])).rows[0].status).toBe("pending");
      });
    });
  });

  describe("when the cooling-off window has ended", () => {
    const DUE = "51801800-0000-4000-8000-000000000301";

    async function dueClaim() {
      await db.query(
        `insert into public.chapter_leadership_claims(id, organization_id, chapter_id, claimant_user_id, inactivity_months,
           cooling_off_hours, inactive_leader_count, activity_cutoff, claimed_at, effective_at)
         values ($1, $2, $3, $4, 6, 72, 1, now() - interval '6 months' - interval '4 days', now() - interval '4 days', now() - interval '1 day')`,
        [DUE, ID.org, CHAPTER, ID.second],
      );
    }

    it("grants chapter admin through set_member_chapter_role's writes and audit row", async () => {
      await withChange(null, [], async () => {
        await db.query("delete from public.chapter_leadership_claims where chapter_id = $1 and status = 'pending'", [CHAPTER]);
        await dueClaim();
        expect((await db.query("select private.finalize_due_chapter_leadership_claims(50) n")).rows[0].n).toBe(1);
        expect((await db.query("select status, decided_by from public.chapter_leadership_claims where id = $1", [DUE])).rows[0])
          .toEqual({ status: "granted", decided_by: null });
        expect((await db.query(
          "select role, chapter_id, granted_by from public.member_role_chapters where user_id = $1", [ID.second],
        )).rows).toEqual([{ role: "admin", chapter_id: CHAPTER, granted_by: null }]);
        expect((await db.query("select role from public.member_roles where user_id = $1", [ID.second])).rows).toEqual([{ role: "admin" }]);
        const audit = (await db.query(
          "select actor, action, detail from public.member_admin_audit where target_user = $1 and action = 'grant_role'", [ID.second],
        )).rows;
        expect(audit).toEqual([{ actor: null, action: "grant_role", detail: { role: "admin", chapterId: CHAPTER, source: "chapter_leadership_recovery", claimId: DUE } }]);
        const notices = (await db.query(
          "select user_id, title from public.member_notifications where title in ('You are now a chapter admin', 'Chapter leadership claim took effect') order by title",
        )).rows;
        expect(notices).toEqual([
          { user_id: ID.admin, title: "Chapter leadership claim took effect" },
          { user_id: ID.second, title: "You are now a chapter admin" },
        ]);
        // The new admin holds the chapter role through the normal predicate.
        expect(await as(ID.second, ID.secondSession, "select public.member_has_role(array['admin']) r")).toBe(true);
        // The grant reaches the member's own access history as a chapter role grant.
        const history = await as(ID.second, ID.secondSession, "select public.list_my_access_history(30) r");
        expect(history).toEqual(expect.arrayContaining([expect.objectContaining({ action: "granted_role", entityId: CHAPTER })]));
      });
    });

    it.each(['admin', 'steward'])("lapses a due claim after a recent organization %s grant", async (role) => {
      await withChange(null, [], async () => {
        await db.query("delete from public.chapter_leadership_claims where chapter_id=$1 and status='pending'", [CHAPTER]);
        await dueClaim();
        await db.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,$3,$4)", [ID.org, ID.leader, role, ID.admin]);
        expect((await db.query("select private.finalize_due_chapter_leadership_claims(50) n")).rows[0].n).toBe(1);
        expect((await db.query("select status,lapse_reason from public.chapter_leadership_claims where id=$1", [DUE])).rows[0]).toEqual({ status: "lapsed", lapse_reason: "active_leader_present" });
        expect((await db.query("select count(*)::int n from public.member_role_chapters where user_id=$1", [ID.second])).rows[0].n).toBe(0);
      });
    });

    it("lapses instead when a leader came back during the window", async () => {
      await withChange("update auth.users set last_sign_in_at = now() where id = $1", [ID.leader], async () => {
        await db.query("delete from public.chapter_leadership_claims where chapter_id = $1 and status = 'pending'", [CHAPTER]);
        await dueClaim();
        expect((await db.query("select private.finalize_due_chapter_leadership_claims(50) n")).rows[0].n).toBe(1);
        expect((await db.query("select status, lapse_reason from public.chapter_leadership_claims where id = $1", [DUE])).rows[0])
          .toEqual({ status: "lapsed", lapse_reason: "active_leader_present" });
        expect((await db.query("select count(*)::int n from public.member_role_chapters where user_id = $1", [ID.second])).rows[0].n).toBe(0);
        expect((await db.query(
          "select count(*)::int n from public.member_notifications where user_id = $1 and title = 'Chapter leadership claim closed'", [ID.second],
        )).rows[0].n).toBe(1);
      });
    });
  });
});
