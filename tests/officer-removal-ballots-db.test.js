// @vitest-environment node
//
// REQ-UG-OFFICER-REMOVAL-BALLOTS-20261001 (old 0618_controller_removal_ballots
// and lib/voting/controller-removal.ts).
//
// On a disposable database this proves the restored ballot type: the target
// must hold a staff role inside the ballot's tenant scope (chapter or
// organization), the reason is required, the two options are fixed against the
// generic editor, the organization switch gates drafting and publishing,
// members read the officer and reason only once the ballot is published, and
// staff record "removed" or "retained" exactly once after voting ends, with a
// tenancy re-check and no automatic demotion.
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const MIGRATION = "supabase/migrations/20261003051000_governance_leadership_recovery_and_officer_removal.sql";
const migration = readFileSync(new URL(`../${MIGRATION}`, import.meta.url), "utf8");
const SWITCH = "features.governance.officer_removal_ballots";

describe("officer removal ballots (static)", () => {
  it("registers the switch ON from the old controller_removal_enabled seed", () => {
    expect(migration).toContain(`('${SWITCH}', 'boolean'`);
    expect(migration).toMatch(/0618_controller_removal_ballots\.sql:8 controller_removal_enabled 'true'/);
    expect(migration).toMatch(/'true', null, null, null, 40, 'governance', true\)/);
    expect(migration).toContain("check (ballot_type in ('standard', 'officer_removal'))");
  });
});

const ID = {
  org: "51801810-0000-4000-8000-000000000001",
  otherOrg: "51801810-0000-4000-8000-000000000002",
  steward: "51801810-0000-4000-8000-000000000101",
  officer: "51801810-0000-4000-8000-000000000102",
  otherChapterOfficer: "51801810-0000-4000-8000-000000000103",
  admin: "51801810-0000-4000-8000-000000000104",
  member: "51801810-0000-4000-8000-000000000105",
  outsider: "51801810-0000-4000-8000-000000000106",
  stewardSession: "51801810-0000-4000-8000-000000000201",
  adminSession: "51801810-0000-4000-8000-000000000204",
  memberSession: "51801810-0000-4000-8000-000000000205",
  outsiderSession: "51801810-0000-4000-8000-000000000206",
};
const CHAPTER = "officer-removal-chapter";
const OTHER_CHAPTER = "officer-removal-other-chapter";
const OUTSIDE_CHAPTER = "officer-removal-outside-chapter";
const REASON = "Missed every grievance meeting this year.";
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("officer removal ballots on a disposable database", () => {
  let db;

  async function as(userId, sessionId, sql, values = []) {
    await db.query("savepoint removal_call");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        sub: userId, role: "authenticated", session_id: sessionId, aal: "aal2",
      })]);
      await db.query("set local role authenticated");
      const result = await db.query(sql, values);
      await db.query("reset role");
      await db.query("release savepoint removal_call");
      return result.rows[0] ? Object.values(result.rows[0])[0] : null;
    } catch (error) {
      await db.query("rollback to savepoint removal_call");
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

  async function rawFailure(sql, values = []) {
    await db.query("savepoint removal_raw");
    try {
      await db.query(sql, values);
    } catch (error) {
      await db.query("rollback to savepoint removal_raw");
      return { code: error.code, message: error.message };
    }
    await db.query("release savepoint removal_raw");
    throw new Error("expected the statement to fail");
  }

  async function withChange(sql, values, check) {
    await db.query("savepoint removal_change");
    try {
      if (sql) await db.query(sql, values);
      await check();
    } finally {
      await db.query("rollback to savepoint removal_change");
    }
  }

  const SAVE = "select public.save_officer_removal_ballot_draft($1, $2, $3, $4, 'Remove the steward?', '¿Destituir al delegado?', '', '', now() + interval '7 days', 3) r";
  const save = (userId, sessionId, { id = null, scope = "chapter", target = ID.officer, reason = REASON } = {}) =>
    as(userId, sessionId, SAVE, [id, scope, target, reason]);
  const details = (userId, sessionId, ids) => as(userId, sessionId, "select public.get_officer_removal_ballot_details($1) r", [ids]);

  beforeAll(async () => {
    db = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "officer-removal-ballots-proof",
    });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '60s'");
    await db.query("set local lock_timeout = '15s'");
    await db.query(
      `insert into auth.users (id, email) values
        ($1,'removal-steward@example.invalid'), ($2,'removal-officer@example.invalid'),
        ($3,'removal-other-officer@example.invalid'), ($4,'removal-admin@example.invalid'),
        ($5,'removal-member@example.invalid'), ($6,'removal-outsider@example.invalid')`,
      [ID.steward, ID.officer, ID.otherChapterOfficer, ID.admin, ID.member, ID.outsider],
    );
    await db.query(
      `insert into public.organizations(id, slug, name, created_by) values
        ($1, 'officer-removal-org', 'Officer removal proof org', $3),
        ($2, 'officer-removal-other', 'Officer removal other org', $4)`,
      [ID.org, ID.otherOrg, ID.admin, ID.outsider],
    );
    await db.query(
      `insert into public.chapters(id, name, slug, organization_id, is_default, order_index) values
        ($1, 'Removal Chapter', $1, $4, false, 91811), ($2, 'Removal Other Chapter', $2, $4, false, 91812),
        ($3, 'Removal Outside Chapter', $3, $5, false, 91813)`,
      [CHAPTER, OTHER_CHAPTER, OUTSIDE_CHAPTER, ID.org, ID.otherOrg],
    );
    const placements = [
      [ID.steward, ID.org, CHAPTER], [ID.officer, ID.org, CHAPTER], [ID.admin, ID.org, CHAPTER],
      [ID.member, ID.org, CHAPTER], [ID.otherChapterOfficer, ID.org, OTHER_CHAPTER], [ID.outsider, ID.otherOrg, OUTSIDE_CHAPTER],
    ];
    for (const [userId, orgId, chapterId] of placements) {
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [orgId, userId]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [userId, chapterId]);
      await db.query("update public.member_profiles set chapter_id = $2 where id = $1", [userId, chapterId]);
    }
    await db.query("update public.member_profiles set full_name = 'Olivia Officer' where id = $1", [ID.officer]);
    for (const [userId, chapterId] of [[ID.steward, CHAPTER], [ID.officer, CHAPTER], [ID.otherChapterOfficer, OTHER_CHAPTER]]) {
      await db.query("insert into public.member_roles(user_id, role, chapter_id) values($1,'steward',$2)", [userId, chapterId]);
      await db.query("insert into public.member_role_chapters(user_id, role, chapter_id) values($1,'steward',$2)", [userId, chapterId]);
    }
    await db.query(
      "insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'admin',$2),($3,$4,'admin',$4)",
      [ID.org, ID.admin, ID.otherOrg, ID.outsider],
    );
    await db.query(
      `insert into auth.sessions(id,user_id,aal,created_at,updated_at) values
        ($1,$2,'aal2',now(),now()), ($3,$4,'aal2',now(),now()), ($5,$6,'aal2',now(),now()), ($7,$8,'aal2',now(),now())`,
      [ID.stewardSession, ID.steward, ID.adminSession, ID.admin, ID.memberSession, ID.member, ID.outsiderSession, ID.outsider],
    );
    await db.query(
      `insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at)
       select gen_random_uuid(), u, 'proof-totp', 'totp', 'verified', now(), now() from unnest($1::uuid[]) u`,
      [[ID.steward, ID.admin, ID.member, ID.outsider]],
    );
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  it("lists only officers inside the ballot scope", async () => {
    const chapterTargets = await as(ID.steward, ID.stewardSession, "select public.list_officer_removal_targets('chapter') r");
    expect(chapterTargets.items.map((item) => item.userId).sort()).toEqual([ID.steward, ID.officer].sort());
    expect(chapterTargets.items.find((item) => item.userId === ID.officer)).toEqual({ userId: ID.officer, name: "Olivia Officer", role: "steward" });
    const unionTargets = await as(ID.admin, ID.adminSession, "select public.list_officer_removal_targets('union') r");
    expect(unionTargets.items.map((item) => item.userId).sort()).toEqual([ID.steward, ID.officer, ID.otherChapterOfficer, ID.admin].sort());
    expect(unionTargets.items.map((item) => item.userId)).not.toContain(ID.outsider);
    expect(await failure(as(ID.steward, ID.stewardSession, "select public.list_officer_removal_targets('union') r")))
      .toMatchObject({ code: "42501", message: "campaign scope unavailable" });
    expect(await failure(as(ID.member, ID.memberSession, "select public.list_officer_removal_targets('chapter') r")))
      .toMatchObject({ code: "42501", message: "staff role required" });
  });

  it("refuses a target outside the tenant scope and a short reason", async () => {
    for (const target of [ID.otherChapterOfficer, ID.outsider, ID.member]) {
      expect(await failure(save(ID.steward, ID.stewardSession, { target })))
        .toMatchObject({ code: "22023", message: "officer not found in this scope" });
    }
    expect(await failure(save(ID.steward, ID.stewardSession, { reason: "too short" })))
      .toMatchObject({ code: "22023", message: "a removal reason of at least 10 characters is required" });
    expect(await failure(save(ID.outsider, ID.outsiderSession, { target: ID.officer, scope: "union" })))
      .toMatchObject({ code: "22023", message: "officer not found in this scope" });
  });

  it("is refused while the organization switch is off", async () => {
    await withChange(
      "insert into public.organization_setting_values(organization_id,setting_key,value,updated_by) values($1,$2,'false'::jsonb,$3)",
      [ID.org, SWITCH, ID.admin],
      async () => {
        expect(await failure(save(ID.steward, ID.stewardSession)))
          .toMatchObject({ code: "42501", message: "officer removal ballots are turned off" });
        expect(await details(ID.steward, ID.stewardSession, [])).toEqual({ enabled: false, items: [] });
      },
    );
  });

  describe("with a drafted removal ballot", () => {
    let ballotId;

    beforeAll(async () => {
      ({ id: ballotId } = await save(ID.steward, ID.stewardSession));
    });

    it("stores the target snapshot, reason and fixed options", async () => {
      const row = (await db.query(
        `select ballot_type, target_officer_id, target_officer_name, target_officer_role, removal_reason, chapter_id, organization_id, campaign_state
         from public.member_ballots where id = $1`, [ballotId],
      )).rows[0];
      expect(row).toEqual({
        ballot_type: "officer_removal", target_officer_id: ID.officer, target_officer_name: "Olivia Officer",
        target_officer_role: "steward", removal_reason: REASON, chapter_id: CHAPTER, organization_id: ID.org, campaign_state: "draft",
      });
      expect((await db.query(
        "select id, label, label_es, order_index from public.member_ballot_options where ballot_id = $1 order by order_index", [ballotId],
      )).rows).toEqual([
        { id: `${ballotId}-option-remove`, label: "Remove from office", label_es: "Destituir del cargo", order_index: 1 },
        { id: `${ballotId}-option-retain`, label: "Do not remove", label_es: "No destituir", order_index: 2 },
      ]);
      const audit = (await db.query(
        "select action, target_user, detail ->> 'ballotType' ballot_type from public.member_admin_audit where detail ->> 'campaignId' = $1", [ballotId],
      )).rows;
      expect(audit).toEqual([{ action: "create_campaign", target_user: ID.officer, ballot_type: "officer_removal" }]);
    });

    it("keeps the generic campaign editor from rewriting it", async () => {
      const generic = await failure(as(ID.steward, ID.stewardSession,
        `select public.save_vote_campaign_draft('ballot', $1, 'chapter', 'Changed title', 'Título cambiado', now() + interval '7 days', 3, '', '',
          '[{"labelEn":"Yes","labelEs":"Sí"},{"labelEn":"No","labelEs":"No"}]'::jsonb) r`, [ballotId]));
      expect(generic).toMatchObject({ code: "22023", message: "officer removal ballot options are fixed" });
      expect((await db.query("select title from public.member_ballots where id = $1", [ballotId])).rows[0].title).toBe("Remove the steward?");
    });

    it("hides the draft from members and shows it to the staff who manage it", async () => {
      expect((await details(ID.member, ID.memberSession, [ballotId])).items).toEqual([]);
      expect((await details(ID.steward, ID.stewardSession, [ballotId])).items).toEqual([expect.objectContaining({
        ballotId, targetUserId: ID.officer, targetName: "Olivia Officer", targetRole: "steward", reason: REASON, outcome: null, canRecordOutcome: false,
      })]);
      expect((await details(ID.outsider, ID.outsiderSession, [ballotId])).items).toEqual([]);
    });

    it("cannot open while the switch is off", async () => {
      await withChange(
        "insert into public.organization_setting_values(organization_id,setting_key,value,updated_by) values($1,$2,'false'::jsonb,$3)",
        [ID.org, SWITCH, ID.admin],
        async () => {
          expect(await failure(as(ID.steward, ID.stewardSession, "select public.publish_vote_campaign('ballot', $1) r", [ballotId])))
            .toMatchObject({ code: "42501", message: "officer removal ballots are turned off" });
        },
      );
    });

    describe("once published", () => {
      beforeAll(async () => {
        await as(ID.steward, ID.stewardSession, "select public.publish_vote_campaign('ballot', $1) r", [ballotId]);
      });

      it("shows members the officer and the reason, never another tenant", async () => {
        // Voters get the name and reason, never the officer's account id.
        expect((await details(ID.member, ID.memberSession, [ballotId])).items).toEqual([{
          ballotId, targetUserId: null, targetName: "Olivia Officer", targetRole: "steward", reason: REASON,
          outcome: null, outcomeRecordedAt: null, canRecordOutcome: false,
        }]);
        expect((await details(ID.outsider, ID.outsiderSession, [ballotId])).items).toEqual([]);
      });

      it("fixes the target once the ballot left draft", async () => {
        expect((await rawFailure("update public.member_ballots set removal_reason = 'A different reason entirely.' where id = $1", [ballotId])).code)
          .toBe("42501");
      });

      it("records the outcome only after voting ends, once, and demotes nobody", async () => {
        expect(await failure(as(ID.steward, ID.stewardSession, "select public.record_officer_removal_outcome($1, 'removed') r", [ballotId])))
          .toMatchObject({ code: "22023", message: "voting has not ended" });
        await as(ID.steward, ID.stewardSession, "select public.close_vote_campaign('ballot', $1) r", [ballotId]);
        expect(await failure(as(ID.member, ID.memberSession, "select public.record_officer_removal_outcome($1, 'removed') r", [ballotId])))
          .toMatchObject({ code: "42501" });
        expect(await failure(as(ID.outsider, ID.outsiderSession, "select public.record_officer_removal_outcome($1, 'removed') r", [ballotId])))
          .toMatchObject({ code: "22023", message: "campaign not found" });
        expect(await failure(as(ID.steward, ID.stewardSession, "select public.record_officer_removal_outcome($1, 'fired') r", [ballotId])))
          .toMatchObject({ code: "22023", message: "invalid removal outcome" });
        expect((await details(ID.steward, ID.stewardSession, [ballotId])).items[0].canRecordOutcome).toBe(true);

        await withChange(
          "update public.organization_memberships set status = 'revoked', revoked_at = now() where organization_id = $1 and user_id = $2",
          [ID.org, ID.officer],
          async () => {
            expect(await failure(as(ID.steward, ID.stewardSession, "select public.record_officer_removal_outcome($1, 'removed') r", [ballotId])))
              .toMatchObject({ code: "22023", message: "officer is no longer in this organization" });
          },
        );

        expect(await as(ID.steward, ID.stewardSession, "select public.record_officer_removal_outcome($1, 'removed') r", [ballotId]))
          .toEqual({ id: ballotId, outcome: "removed" });
        expect(await failure(as(ID.steward, ID.stewardSession, "select public.record_officer_removal_outcome($1, 'retained') r", [ballotId])))
          .toMatchObject({ code: "22023", message: "removal outcome already recorded" });
        expect((await rawFailure("update public.member_ballots set removal_outcome = 'retained' where id = $1", [ballotId])).code).toBe("42501");
        expect((await db.query("select removal_outcome_recorded_by from public.member_ballots where id = $1", [ballotId])).rows[0])
          .toEqual({ removal_outcome_recorded_by: ID.steward });
        expect((await details(ID.member, ID.memberSession, [ballotId])).items[0]).toMatchObject({ outcome: "removed", canRecordOutcome: false });
        // No automatic demotion: the officer keeps the steward role until an admin changes it.
        expect((await db.query("select count(*)::int n from public.member_role_chapters where user_id = $1 and role = 'steward'", [ID.officer])).rows[0].n)
          .toBe(1);
      });
    });
  });

  it("keeps standard ballots free of removal fields", async () => {
    expect((await rawFailure(
      `insert into public.member_ballots(id, title, closes_at, active, order_index, chapter_id, campaign_state, removal_reason)
       values ('removal-proof-standard', 'Standard', now() + interval '1 day', false, 991811, $1, 'draft', 'Not allowed on a standard ballot')`,
      [CHAPTER],
    )).code).toBe("23514");
  });
});
