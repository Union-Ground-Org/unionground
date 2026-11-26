// @vitest-environment node
//
// SEC-UG-SUPPORT-WORKSPACE-AND-INTELLIGENCE-SNAPSHOT-SHOW-OTHER-ORGANIZATION-CHAPTER-IDS-20261111 (#8368)
//
// get_member_support_workspace (mentorshipDirectory[].chapterId) and
// get_organization_intelligence_snapshot (relationshipNodes[].chapterId) give
// staff each organization member's selected chapter id. For a member of two
// organizations with the other organization's chapter selected, that was the
// other organization's chapter id. Both now return the selected chapter id only
// when the chapter belongs to the caller's organization, and null otherwise.
//
// The product keeps an account to one active organization (create_my_organization,
// accept_former_member_invitation and SCIM each refuse an account active
// elsewhere) and refuses a switch to another organization's chapter, so the
// two-organization member is built here with direct inserts, as the leak audit
// did. The last cases fail if those product rules are removed.
// Everything runs in one transaction that is rolled back.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PROOF_FILES, assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, loadMigrationSql, stripComments } from "./helpers/migration.js";
import { insertSignupCoverageLease, insertSignupRecoveryCheck, openPeriod } from "./helpers/openSignupOrganization.js";
import { releaseCalendarHolds } from "./helpers/release-calendar-holds.js";

const STEM = "selected_chapter_own_organization_only";
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const SUPPORT = "public.get_member_support_workspace()";
const SNAPSHOT = "public.get_organization_intelligence_snapshot(p_selected_hat text)";

describe("selected chapter ids stay inside the caller's organization (static)", () => {
  let migration = "";
  beforeAll(() => { migration = stripComments(loadMigrationSql(STEM)); });

  it("sorts after the migrations queued ahead of it and joins the chapter on the caller's organization in both functions", () => {
    expect(findMigrationName(STEM) > "20261113111500").toBe(true);
    expect(migration).toContain("set local search_path = pg_catalog;");
    expect(migration.match(/\.organization_id = org/g)?.length).toBeGreaterThanOrEqual(2);
    expect(migration).toContain("'chapterId', own_chapter.id");
    expect(migration).toContain("'chapterId', scoped.own_chapter_id");
  });

  it("pins both functions in the database contract", () => {
    for (const [sig, needle] of [[SUPPORT, "'chapterId', own_chapter.id"], [SNAPSHOT, "'chapterId', scoped.own_chapter_id"]]) {
      const entry = contract.functions.find((row) => row.sig === sig);
      expect(entry?.bodyContains, sig).toContain(needle);
      for (const pinned of entry.bodyContains) expect(migration, `${sig} ${pinned}`).toContain(pinned);
    }
  });

  it("is registered in the required database proof lane", () => {
    expect(PROOF_FILES).toContain("tests/selected-chapter-other-organization-db.test.js");
  });
});

const n = (suffix) => `50908368-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const ID = { orgA: n(1), orgB: n(2), staffA: n(101), memberA: n(102), dual: n(103), staffB: n(201) };
const SESSION = (id) => `50908368-0000-4000-8000-9${id.slice(-11)}`;
const A1 = "selected-chapter-proof-harbor";
const A2 = "selected-chapter-proof-harbor-east";
const B1 = "selected-chapter-proof-inland";
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("selected chapter ids stay inside the caller's organization on a disposable database", () => {
  let db;

  async function as(userId, sql, values = []) {
    await db.query("savepoint as_user");
    try {
      const claims = { sub: userId, role: "authenticated", session_id: SESSION(userId), aal: "aal2" };
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
      await db.query("set local role authenticated");
      const rows = (await db.query(sql, values)).rows;
      await db.query("reset role");
      await db.query("release savepoint as_user");
      return rows;
    } catch (error) {
      await db.query("rollback to savepoint as_user");
      await db.query("reset role");
      throw error;
    }
  }
  const select = (chapter, userId = ID.dual) => db.query("update public.member_profiles set chapter_id = $2 where id = $1", [userId, chapter]);
  const directory = async (staff) => (await as(staff, "select public.get_member_support_workspace() v"))[0].v.mentorshipDirectory;
  const nodes = async (staff) => (await as(staff, "select public.get_organization_intelligence_snapshot('admin') v"))[0].v.relationshipNodes;
  const chapterOf = (rows, userId, key) => rows.find((row) => row[key] === userId)?.chapterId;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "selected-chapter-other-organization-proof" });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '60s'");
    await db.query("set local lock_timeout = '15s'");
    // The snapshot carries relationship nodes only with Neuro Map on, which the
    // release calendar holds on Main (20261112214700).
    await releaseCalendarHolds(db);
    for (const id of Object.values(ID).filter((value) => ![ID.orgA, ID.orgB].includes(value))) {
      await db.query("insert into auth.users(id, email, email_confirmed_at) values ($1, $2, now())", [id, `selected-chapter-${id.slice(-3)}@example.invalid`]);
      await db.query("insert into auth.sessions(id, user_id, created_at, updated_at, aal) values ($1, $2, now(), now(), 'aal2')", [SESSION(id), id]);
      await db.query("insert into auth.mfa_factors(id, user_id, friendly_name, factor_type, status, created_at, updated_at) values (gen_random_uuid(), $1, 'Selected chapter proof', 'totp', 'verified', now(), now())", [id]);
    }
    await db.query("insert into public.organizations(id, slug, name, created_by) values ($1, 'selected-chapter-proof-harbor', 'Fictional Harbor Local', $3), ($2, 'selected-chapter-proof-inland', 'Fictional Inland Local', $4)",
      [ID.orgA, ID.orgB, ID.staffA, ID.staffB]);
    await db.query("insert into public.chapters(id, name, slug, organization_id, is_default, order_index) values ($1, 'Harbor Main', $1, $4, false, 9981), ($2, 'Harbor East', $2, $4, false, 9982), ($3, 'Inland Main', $3, $5, false, 9983)",
      [A1, A2, B1, ID.orgA, ID.orgB]);
    // Harbor: its staff, a plain member and the member of both organizations.
    // Inland: its staff and the same member of both organizations.
    for (const [userId, org, chapter] of [
      [ID.staffA, ID.orgA, A1], [ID.memberA, ID.orgA, A2], [ID.dual, ID.orgA, A1], [ID.dual, ID.orgB, B1], [ID.staffB, ID.orgB, B1],
    ]) {
      await db.query("insert into public.organization_memberships(organization_id, user_id, status) values ($1, $2, 'active')", [org, userId]);
      await db.query("insert into public.member_chapter_memberships(user_id, chapter_id, status) values ($1, $2, 'active')", [userId, chapter]);
    }
    for (const [userId, chapter] of [[ID.staffA, A1], [ID.memberA, A2], [ID.dual, B1], [ID.staffB, B1]]) await select(chapter, userId);
    for (const [org, staff] of [[ID.orgA, ID.staffA], [ID.orgB, ID.staffB]]) {
      await db.query("insert into public.organization_role_grants(organization_id, user_id, role, granted_by) values ($1, $2, 'admin', $2), ($1, $2, 'steward', $2)", [org, staff]);
    }
    // The member of both organizations has a name the searches below look for,
    // and has agreed to SMS in each organization, so the member search and the
    // SMS recipient search can find them.
    await db.query("update public.member_profiles set full_name = 'Dual Proof Member' where id = $1", [ID.dual]);
    for (const org of [ID.orgA, ID.orgB]) {
      await db.query("insert into private.member_sms_preferences(user_id, organization_id, phone_e164, consented, consented_at) values ($1, $2, '+15555550123', true, now())", [ID.dual, org]);
    }
  }, 60_000);
  beforeEach(async () => { await db.query("savepoint proof_case"); });
  afterEach(async () => { await db.query("rollback to savepoint proof_case"); });
  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  it("never gives the first organization's staff a chapter id of the second, whichever chapter the member selected", async () => {
    for (const selected of [B1, A1]) {
      await select(selected);
      const expected = selected === A1 ? A1 : null;
      expect(chapterOf(await directory(ID.staffA), ID.dual, "userId"), `support directory, ${selected} selected`).toBe(expected);
      expect(chapterOf(await nodes(ID.staffA), ID.dual, "id"), `relationship nodes, ${selected} selected`).toBe(expected);
      for (const rows of [await directory(ID.staffA), await nodes(ID.staffA)]) expect(JSON.stringify(rows)).not.toContain(B1);
    }
  });

  it("gives the second organization's staff its own chapter id and never the first's", async () => {
    for (const selected of [A1, B1]) {
      await select(selected);
      const expected = selected === B1 ? B1 : null;
      expect(chapterOf(await directory(ID.staffB), ID.dual, "userId")).toBe(expected);
      expect(chapterOf(await nodes(ID.staffB), ID.dual, "id")).toBe(expected);
      for (const rows of [await directory(ID.staffB), await nodes(ID.staffB)]) {
        expect(JSON.stringify(rows)).not.toContain(A1);
        expect(JSON.stringify(rows)).not.toContain(A2);
      }
    }
  });

  it("still gives staff the chapter ids of their own organization, and keeps every other field", async () => {
    await select(B1);
    const support = await directory(ID.staffA);
    expect(support.map((row) => row.userId).sort()).toEqual([ID.staffA, ID.memberA, ID.dual].sort());
    expect(chapterOf(support, ID.memberA, "userId")).toBe(A2);
    expect(chapterOf(support, ID.staffA, "userId")).toBe(A1);
    for (const row of support) expect(Object.keys(row).sort()).toEqual(["chapterId", "label", "userId"]);
    const graph = await nodes(ID.staffA);
    expect(graph.map((row) => row.id).sort()).toEqual([ID.staffA, ID.memberA, ID.dual].sort());
    expect(chapterOf(graph, ID.memberA, "id")).toBe(A2);
    for (const row of graph) expect(Object.keys(row).sort()).toEqual(["chapterId", "id", "label", "roleLabel"]);
  });

  // Same pattern elsewhere: the other member-callable staff functions that put
  // a member's or row's chapter id in their answer, run against the same
  // two-organization member with the other organization's chapter selected.
  it("finds no other staff function that gives one organization the other's chapter id", async () => {
    const calls = [
      ["get_staff_roster", "select public.get_staff_roster() v"],
      ["admin_search_members", "select public.admin_search_members('Dual') v"],
      ["get_admin_member_directory", "select public.get_admin_member_directory(null, null, null, 25) v"],
      ["get_member_operations_directory", "select public.get_member_operations_directory(null, null, null, 25) v"],
      ["get_staff_engagement_snapshot", "select public.get_staff_engagement_snapshot() v"],
      ["search_twilio_sms_recipients", "select public.search_twilio_sms_recipients('Dual') v"],
      ["get_member_organization_structure", "select public.get_member_organization_structure() v"],
      ["get_organization_analytics_workspace", "select public.get_organization_analytics_workspace() v"],
      ["get_institutional_records_workspace", "select public.get_institutional_records_workspace() v"],
      ["get_member_chapter_memberships_for_admin", "select public.get_member_chapter_memberships_for_admin($1) v", [ID.dual]],
      ["get_member_invitations", "select public.get_member_invitations(100) v"],
    ];
    // Positive controls first: both searches do find the member of both
    // organizations, so the isolation checks below are not vacuous. The member
    // search finds them whichever chapter they selected; the SMS search lists
    // only members whose selected chapter is in the searching organization.
    const search = async (staff, sql) => (await as(staff, sql))[0].v.map((row) => row.userId);
    for (const [staff, own, foreign] of [[ID.staffA, A1, B1], [ID.staffB, B1, A1]]) {
      for (const selected of [own, foreign]) {
        await select(selected);
        expect(await search(staff, "select public.admin_search_members('Dual') v"), `member search, ${selected} selected`).toContain(ID.dual);
      }
      await select(own);
      expect(await search(staff, "select public.search_twilio_sms_recipients('Dual') v"), "SMS search, own chapter selected").toContain(ID.dual);
      await select(foreign);
      expect(await search(staff, "select public.search_twilio_sms_recipients('Dual') v"), "SMS search, foreign chapter selected").not.toContain(ID.dual);
    }
    for (const [staff, selected, foreign] of [[ID.staffA, B1, [B1]], [ID.staffB, A1, [A1, A2]]]) {
      await select(selected);
      for (const [name, sql, args = []] of calls) {
        const answer = JSON.stringify(await as(staff, sql, args));
        for (const chapter of foreign) expect(answer, `${name} as staff of ${staff === ID.staffA ? "Harbor" : "Inland"}`).not.toContain(chapter);
      }
    }
  });

  // The product rules that keep the two-organization member out of reach.
  it("refuses a self-serve organization to an account already active in one", async () => {
    // Signup open, so the refusal below can only come from the membership rule.
    await insertSignupRecoveryCheck(db);
    await insertSignupCoverageLease(db);
    await openPeriod(db);
    await expect(as(ID.memberA, "select public.create_my_organization('Second Proof Local', $1) v", [randomUUID()]))
      .rejects.toMatchObject({ code: "22023", message: "organization membership exists" });
    const created = await db.query("select count(*)::int c from public.organizations where name = 'Second Proof Local'");
    expect(created.rows[0].c).toBe(0);
  });

  it("refuses a switch to another organization's chapter", async () => {
    await select(A1);
    await expect(as(ID.dual, "select public.switch_my_chapter($1) v", [B1])).rejects.toMatchObject({ code: "42501", message: "foreign chapter switching denied" });
    const { rows } = await db.query("select chapter_id from public.member_profiles where id = $1", [ID.dual]);
    expect(rows[0].chapter_id).toBe(A1);
  });

  it("refuses a former-member return to an account active in another organization", async () => {
    // Inland revoked the member and invites them back; the member is still
    // active in Harbor. The same invitation is refused while that holds and
    // accepted once the member is active nowhere, so only the one-organization
    // rule stands between them.
    await db.query("update public.organization_memberships set status = 'revoked', revoked_at = now() where organization_id = $1 and user_id = $2", [ID.orgB, ID.dual]);
    const { rows: [{ id }] } = await db.query(
      `insert into public.member_invitations(normalized_email, full_name, first_name, initials, chapter_id, token_hash, status, accepting_at, invited_by, expires_at, kind)
       values ($1, 'Dual Proof Member', 'Dual', 'DP', $2, $3, 'accepting', now(), $4, now() + interval '1 day', 'reactivation') returning id`,
      [`selected-chapter-${ID.dual.slice(-3)}@example.invalid`, B1, "a".repeat(64), ID.staffB]);
    const accept = async () => {
      await db.query("savepoint former");
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ role: "service_role" })]);
      await db.query("set local role service_role");
      try {
        await db.query("select public.accept_former_member_invitation($1)", [id]);
        await db.query("reset role");
        await db.query("release savepoint former");
        return null;
      } catch (caught) {
        await db.query("rollback to savepoint former");
        await db.query("reset role");
        return caught;
      }
    };
    const status = async (org) => (await db.query("select status from public.organization_memberships where organization_id = $1 and user_id = $2", [org, ID.dual])).rows[0].status;
    expect((await accept())?.message).toBe("invitation unavailable");
    expect(await status(ID.orgB)).toBe("revoked");
    await db.query("update public.organization_memberships set status = 'revoked', revoked_at = now() where organization_id = $1 and user_id = $2", [ID.orgA, ID.dual]);
    expect(await accept()).toBeNull();
    expect(await status(ID.orgB)).toBe("active");
  });
});
