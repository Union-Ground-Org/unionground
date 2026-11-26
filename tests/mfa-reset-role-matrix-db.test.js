// @vitest-environment node
//
// SEC-UG-CHAPTER-SCOPED-ROLE-GRANTS-RECEIVE-ORGANIZATION-WIDE-MFA-RESET-AUTHORITY-20260921
//
// public.member_has_role(array['admin']) answers for the caller. The
// organization-only target check then let a chapter-scoped administrator
// reach every member of the organization. 20260924100000 adds the sibling
// chapter-scope predicate used by grant/revoke/set chapter-role RPCs, resolved
// through active member_chapter_memberships the same way
// get_admin_member_directory locates a member:
//
//   private.has_organization_role(org, array['admin'])
//   or private.member_has_chapter_role(membership_chapter, array['admin'])
//
// Offline pins prove the latest bodies and the database contract carry that
// helper. The live matrix is the part that matters: organization-wide
// administrators keep organization reach, chapter-scoped administrators stay
// inside their grants (including a multi-chapter member whose selected
// chapter is elsewhere), and an out-of-scope target is indistinguishable
// from an unknown member.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, fnBody, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";

const sql = stripComments(loadMigrationSql("mfa_reset_chapter_scope_boundary"));
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const SCOPE_NEEDLES = [
  "from public.member_chapter_memberships m",
  "m.status = 'active'",
  "private.has_organization_role(c.organization_id, array['admin'])",
  "private.member_has_chapter_role(m.chapter_id, array['admin'])",
  "pc.organization_id = private.current_member_organization()",
];
const AUTHORITIES = [
  "public.authorize_mfa_reset(p_user_id uuid)",
  "public.begin_mfa_reset(p_user_id uuid)",
  "public.record_mfa_reset(p_user_id uuid, p_factors integer)",
  "public.notify_member_mfa_reset(p_user_id uuid)",
  "public.queue_member_mfa_reset_notice(p_user_id uuid)",
  "public.drain_member_mfa_reset_notice(p_user_id uuid)",
];

function latestFunction(signature) {
  const migration = [...migrationFiles()].reverse().find(({ sql: text }) => (
    stripComments(text).toLowerCase().includes(`function ${signature.toLowerCase()}`)
  ));
  expect(migration, `missing migration for ${signature}`).toBeTruthy();
  return stripComments(fnBody(migration.sql, signature));
}

describe("mfa reset chapter-scope boundary (static)", () => {
  it("redefines every MFA-reset authority after the pending-notice generation with the sibling chapter-scope predicate", () => {
    const name = findMigrationName("mfa_reset_chapter_scope_boundary");
    expect(name).toBe("20260924100000_mfa_reset_chapter_scope_boundary.sql");
    expect(name > "20260918090000_mfa_reset_pending_member_notice.sql").toBe(true);
    const statements = sql.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
    expect(statements.trimStart().startsWith("begin;")).toBe(true);
    expect(statements.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).toContain("set local lock_timeout = '5s';");
    for (const signature of AUTHORITIES) {
      const body = latestFunction(signature);
      expect(body, signature).toContain("public.member_has_role(array['admin'])");
      for (const needle of SCOPE_NEEDLES) {
        expect(body, `${signature} missing ${needle}`).toContain(needle);
      }
      expect(body, `${signature} still keys off the selected chapter`).not.toContain(
        "private.member_has_chapter_role(p.chapter_id, array['admin'])",
      );
    }
    const begin = latestFunction("public.begin_mfa_reset(p_user_id uuid)");
    expect(begin.indexOf("p_user_id = caller"))
      .toBeLessThan(begin.indexOf("insert into private.member_mfa_reset_boundaries"));
    expect(begin).toContain("raise exception 'unknown member' using errcode = '42501'");
  });

  it("pins the chapter-scope helper on every MFA-reset authority in the database contract", () => {
    for (const sig of [
      "public.authorize_mfa_reset(p_user_id uuid)",
      "public.begin_mfa_reset(p_user_id uuid)",
      "public.record_mfa_reset(p_user_id uuid, p_factors integer)",
      "public.notify_member_mfa_reset(p_user_id uuid)",
      "public.queue_member_mfa_reset_notice(p_user_id uuid)",
      "public.drain_member_mfa_reset_notice(p_user_id uuid)",
    ]) {
      const entry = contract.functions.find((row) => row.sig === sig);
      expect(entry, sig).toBeDefined();
      expect(entry.bodyContains, sig).toEqual(expect.arrayContaining([
        "from public.member_chapter_memberships m",
        "m.status = 'active'",
        "private.has_organization_role(c.organization_id, array['admin'])",
        "private.member_has_chapter_role(m.chapter_id, array['admin'])",
        "pc.organization_id = private.current_member_organization()",
      ]));
    }
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("mfa reset role matrix on a disposable database", () => {
  let client;

  beforeAll(async () => {
    assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    client = new pg.Client({
      connectionString: process.env.SUPABASE_DB_URL,
      application_name: "mfa-reset-role-matrix-rollback-proof",
    });
    await client.connect();
    await client.query("set statement_timeout = '10s'");
  });

  afterAll(async () => {
    await client?.end();
  });

  it("admits only the allowed caller/target cells and uses the unknown-member refusal for every out-of-scope target", async () => {
    await client.query("begin");
    try {
      const org = randomUUID();
      const otherOrg = randomUUID();
      const chapterA = `matrix-a-${org}`;
      const chapterB = `matrix-b-${org}`;
      const chapterC = `matrix-c-${otherOrg}`;

      await client.query(
        "insert into public.organizations(id,slug,name) values ($1,$2,$2), ($3,$4,$4)",
        [org, `matrix-${org}`, otherOrg, `matrix-${otherOrg}`],
      );
      await client.query(
        `insert into public.chapters(id,name,slug,region,organization_id,order_index)
         values ($1,$1,$1,'proof',$4,9911), ($2,$2,$2,'proof',$4,9912), ($3,$3,$3,'proof',$5,9913)`,
        [chapterA, chapterB, chapterC, org, otherOrg],
      );

      const person = async (chapter, organization) => {
        const id = randomUUID();
        await client.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
        await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [id, chapter]);
        await client.query(
          "insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing",
          [organization, id],
        );
        await client.query(
          "insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing",
          [id, chapter],
        );
        return id;
      };

      const enrollMfa = async (userId) => {
        await client.query(
          "insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())",
          [randomUUID(), userId],
        );
      };

      const orgWide = await person(chapterA, org);
      const chapterAdminA = await person(chapterA, org);
      const chapterAdminB = await person(chapterB, org);
      const nonAdmin = await person(chapterA, org);
      const inChapter = await person(chapterA, org);
      const otherChapter = await person(chapterB, org);
      const multiChapter = await person(chapterB, org);
      const crossOrg = await person(chapterC, otherOrg);
      // A member of another organization handed an active membership in
      // chapter A (what the chapter grant could create before 20260925965000)
      // must stay out of reach: the selected-chapter tenant check is kept.
      const foreignGranted = await person(chapterC, otherOrg);
      const unknown = randomUUID();

      await client.query(
        "insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing",
        [multiChapter, chapterA],
      );
      await client.query(
        "insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing",
        [foreignGranted, chapterA],
      );

      await client.query(
        "insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'admin')",
        [org, orgWide],
      );
      await enrollMfa(orgWide);

      for (const [userId, chapter] of [[chapterAdminA, chapterA], [chapterAdminB, chapterB]]) {
        await client.query(
          "insert into public.member_roles(user_id,role,chapter_id) values ($1,'admin',$2)",
          [userId, chapter],
        );
        await client.query(
          "insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,'admin',$2)",
          [userId, chapter],
        );
        await enrollMfa(userId);
      }
      await enrollMfa(nonAdmin);

      const actAs = async (userId) => {
        const session = randomUUID();
        await client.query(
          "insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())",
          [session, userId],
        );
        await client.query("select set_config('request.jwt.claims',$1,true)", [
          JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2", session_id: session }),
        ]);
      };

      const capture = async (statement, args) => {
        await client.query("savepoint matrix_cell");
        try {
          const result = await client.query(statement, args);
          await client.query("release savepoint matrix_cell");
          return { ok: true, row: result.rows[0], code: "", message: "" };
        } catch (error) {
          await client.query("rollback to savepoint matrix_cell");
          return { ok: false, row: null, code: error.code || "", message: error.message || "" };
        }
      };

      const allowed = new Set([
        "orgWide:inChapter",
        "orgWide:otherChapter",
        "orgWide:multiChapter",
        "chapterAdminA:inChapter",
        "chapterAdminA:multiChapter",
        "chapterAdminB:otherChapter",
        "chapterAdminB:multiChapter",
      ]);

      const callers = [
        ["orgWide", orgWide],
        ["chapterAdminA", chapterAdminA],
        ["chapterAdminB", chapterAdminB],
        ["nonAdmin", nonAdmin],
      ];
      const targets = [
        ["inChapter", inChapter],
        ["otherChapter", otherChapter],
        ["multiChapter", multiChapter],
        ["crossOrg", crossOrg],
        ["foreignGranted", foreignGranted],
      ];

      await actAs(orgWide);
      const unknownBegin = await capture("select public.begin_mfa_reset($1) as v", [unknown]);
      const unknownAuthorize = await capture("select public.authorize_mfa_reset($1) as v", [unknown]);
      expect(unknownBegin).toMatchObject({ ok: false, code: "42501" });
      expect(unknownBegin.message).toMatch(/unknown member/i);
      expect(unknownAuthorize).toMatchObject({ ok: false, code: "22023" });
      expect(unknownAuthorize.message).toMatch(/unknown member/i);

      for (const [callerName, callerId] of callers) {
        await actAs(callerId);
        for (const [targetName, targetId] of targets) {
          const cell = `${callerName}:${targetName}`;
          const begin = await capture("select public.begin_mfa_reset($1) as v", [targetId]);
          const authorize = await capture("select public.authorize_mfa_reset($1) as v", [targetId]);
          if (allowed.has(cell)) {
            expect(begin.ok, cell).toBe(true);
            expect(begin.row.v).toMatchObject({ userId: targetId, authorized: true });
            expect(authorize.ok, cell).toBe(true);
            expect(authorize.row.v).toMatchObject({ userId: targetId, authorized: true });
            await client.query("delete from private.member_mfa_reset_boundaries where user_id=$1", [targetId]);
          } else if (callerName === "nonAdmin") {
            expect(begin).toMatchObject({ ok: false, code: "42501" });
            expect(begin.message).toMatch(/admin role required/i);
            expect(authorize).toMatchObject({ ok: false, code: "42501" });
            expect(authorize.message).toMatch(/admin role required/i);
          } else {
            expect(begin.ok, cell).toBe(false);
            expect(begin.code, cell).toBe(unknownBegin.code);
            expect(begin.message, cell).toBe(unknownBegin.message);
            expect(authorize.ok, cell).toBe(false);
            expect(authorize.code, cell).toBe(unknownAuthorize.code);
            expect(authorize.message, cell).toBe(unknownAuthorize.message);
          }
        }
      }

      const leftover = await client.query(
        "select count(*)::int as n from private.member_mfa_reset_boundaries where user_id = any($1::uuid[])",
        [[inChapter, otherChapter, multiChapter, crossOrg, foreignGranted, unknown]],
      );
      expect(leftover.rows[0].n).toBe(0);
    } finally {
      await client.query("rollback");
    }
  });
});
