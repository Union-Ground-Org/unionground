// @vitest-environment node
//
// BUG-UG-VOTE-CAMPAIGN-AUTHORITY-IGNORES-ORGANIZATION-GRANTS-20260920
//
// An organization admin granted only through public.set_member_organization_role
// must author, publish and close chapter and organization-wide ballots and
// pulses. A chapter-granted steward, limited to a unit since #7663, is refused
// chapter authoring (#8941) and the union scope. A legacy public.member_roles admin keeps today's union authority.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const migrationSql = loadMigrationSql("vote_campaign_authority_organization_grants");
const sql = stripComments(migrationSql);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
const OPTIONS = JSON.stringify([
  { labelEn: "Yes option", labelEs: "Opción sí" },
  { labelEn: "No option", labelEs: "Opción no" },
]);

describe("vote campaign organization-grant authority (static)", () => {
  it("redefines both vote-scope branches through the supported grant helpers", () => {
    const scope = fnBody(sql, "private.can_manage_vote_scope");
    const save = fnBody(sql, "save_vote_campaign_draft");
    expect(scope).toContain("private.has_organization_role(");
    expect(scope).toContain("private.member_has_chapter_role(");
    expect(scope).toMatch(
      /p_chapter_id is null then[\s\S]+private\.has_organization_role\([\s\S]+current_member_chapter\(\)[\s\S]+private\.member_has_chapter_role\(/,
    );
    expect(save).toContain("private.can_manage_vote_scope(null)");
    expect(save).toContain("private.can_manage_vote_scope(caller_chapter)");
    expect(save).not.toMatch(/exists \(\s*select 1 from public\.member_roles/i);
  });

  it("re-emits the case-graph lock wrapper as the first statement of save_vote_campaign_draft", () => {
    const fn = parseFunctions(migrationSql, "20260921230000_vote_campaign_authority_organization_grants.sql")
      .find((entry) => entry.name === "public.save_vote_campaign_draft");
    expect(fn.source).toMatch(
      /^\nbegin\n {2}perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);\n\ndeclare\n/,
    );
  });

  it("pins the corrected authority source in the database contract", () => {
    const scope = contract.functions.find((entry) => entry.sig === "private.can_manage_vote_scope(p_chapter_id text)");
    const save = contract.functions.find((entry) => entry.sig.startsWith("public.save_vote_campaign_draft("));
    expect(scope.bodyContains).toEqual(expect.arrayContaining([
      "private.has_organization_role(",
      "private.member_has_chapter_role(",
      "r.role in ('admin', 'vp')",
    ]));
    expect(scope.note).toContain("private.has_organization_role");
    expect(save.bodyContains).toEqual(expect.arrayContaining([
      "perform private.lock_case_graph(array[auth.uid()], array[]::uuid[])",
      "private.can_manage_vote_scope(null)",
      "private.can_manage_vote_scope(caller_chapter)",
    ]));
    expect(save.bodyForbids).toContain("from public.member_roles r");
  });
});

async function attachMembership(client, { user, org, chapter, session }) {
  await client.query(
    "insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())",
    [session, user],
  );
  await client.query(
    `insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at)
     values(gen_random_uuid(),$1,'vote-authority-totp','totp','verified',now(),now())`,
    [user],
  );
  await client.query(
    "insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')",
    [org, user],
  );
  await client.query(
    "insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')",
    [user, chapter],
  );
  await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, chapter]);
}

async function seedPerson(client, person) {
  await client.query("insert into auth.users(id,email) values($1,$2)", [person.user, person.email]);
  await attachMembership(client, person);
}

// withFixture opens one transaction for the whole case, so a statement that
// raises (an expected 42501 scope denial) aborts it and the trailing
// "reset role" would fail with 25P02 and mask the real error. Every call runs
// inside its own savepoint and rolls back to it before the role reset, the way
// the other transactional database proofs do, so a denial leaves the fixture
// usable for the assertions that follow it.
let savepointSeq = 0;

async function asUser(client, user, session, statement, values = []) {
  await client.query("reset role");
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
    sub: user,
    role: "authenticated",
    session_id: session,
    aal: "aal2",
  })]);
  await client.query("set local role authenticated");
  const savepoint = `vote_authority_${++savepointSeq}`;
  await client.query(`savepoint ${savepoint}`);
  try {
    const result = await client.query(statement, values);
    await client.query(`release savepoint ${savepoint}`);
    return result;
  } catch (error) {
    await client.query(`rollback to savepoint ${savepoint}`);
    await client.query(`release savepoint ${savepoint}`);
    throw error;
  } finally {
    await client.query("reset role");
  }
}

async function withFixture(run) {
  const client = new pg.Client({
    connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
    ssl: false,
    application_name: "vote-campaign-authority-proof",
  });
  await client.connect();
  await client.query("begin");
  try {
    const ids = {
      org: randomUUID(),
      founder: randomUUID(),
      admin: randomUUID(),
      steward: randomUUID(),
      legacy: randomUUID(),
      founderSession: randomUUID(),
      adminSession: randomUUID(),
      stewardSession: randomUUID(),
      legacySession: randomUUID(),
    };
    ids.chapter = `vote-auth-${ids.org.slice(0, 8)}`;
    await client.query("insert into auth.users(id,email) values($1,$2)", [ids.founder, "vote-founder@example.invalid"]);
    await client.query(
      "insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)",
      [ids.org, `vote-auth-${ids.org.slice(0, 8)}`, ids.founder],
    );
    await client.query(
      "insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9918)",
      [ids.chapter, ids.org],
    );
    await client.query(
      "insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)",
      [ids.org],
    );
    await attachMembership(client, {
      user: ids.founder, org: ids.org, chapter: ids.chapter, session: ids.founderSession,
    });
    await client.query(
      "insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'admin',$2)",
      [ids.org, ids.founder],
    );
    await seedPerson(client, {
      user: ids.admin, email: "vote-org-admin@example.invalid", org: ids.org,
      chapter: ids.chapter, session: ids.adminSession,
    });
    await seedPerson(client, {
      user: ids.steward, email: "vote-chapter-steward@example.invalid", org: ids.org,
      chapter: ids.chapter, session: ids.stewardSession,
    });
    await seedPerson(client, {
      user: ids.legacy, email: "vote-legacy-admin@example.invalid", org: ids.org,
      chapter: ids.chapter, session: ids.legacySession,
    });
    await run(client, ids);
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
  }
}

async function saveDraft(client, user, session, { kind, scope, titleEn, titleEs, quorum }) {
  const result = await asUser(
    client, user, session,
    "select public.save_vote_campaign_draft($1,null,$2,$3,$4,now() + interval '7 days',$5,'Body text','Texto del cuerpo',$6::jsonb) value",
    [kind, scope, titleEn, titleEs, quorum ?? null, OPTIONS],
  );
  return result.rows[0].value;
}

live("vote campaign organization-grant authority on a disposable database", () => {
  it("lets an organization-role-grant-only admin list, author, publish and close both scopes", async () => {
    await withFixture(async (client, ids) => {
      await asUser(
        client, ids.founder, ids.founderSession,
        "select public.set_member_organization_role($1,'admin',true)",
        [ids.admin],
      );
      expect((await client.query(
        "select count(*)::int n from public.organization_role_grants where user_id=$1 and role='admin'",
        [ids.admin],
      )).rows[0].n).toBe(1);
      expect((await client.query(
        "select count(*)::int n from public.member_roles where user_id=$1",
        [ids.admin],
      )).rows[0].n).toBe(0);

      const registry = (await asUser(
        client, ids.admin, ids.adminSession,
        "select public.get_staff_vote_campaigns() value",
      )).rows[0].value;
      expect(registry.canManageUnion).toBe(true);
      expect(registry.chapterId).toBe(ids.chapter);

      const authored = [];
      for (const [kind, scope, quorum] of [
        ["ballot", "chapter", 10],
        ["ballot", "union", 10],
        ["pulse", "chapter", null],
        ["pulse", "union", null],
      ]) {
        const draft = await saveDraft(client, ids.admin, ids.adminSession, {
          kind, scope, quorum,
          titleEn: `${kind} ${scope} english`,
          titleEs: `${kind} ${scope} español`,
        });
        expect(draft).toMatchObject({ kind, state: "draft" });
        const published = (await asUser(
          client, ids.admin, ids.adminSession,
          "select public.publish_vote_campaign($1,$2) value",
          [kind, draft.id],
        )).rows[0].value;
        expect(published).toMatchObject({ id: draft.id, kind, state: "open" });
        const closed = (await asUser(
          client, ids.admin, ids.adminSession,
          "select public.close_vote_campaign($1,$2) value",
          [kind, draft.id],
        )).rows[0].value;
        expect(closed).toMatchObject({ id: draft.id, kind, state: "closed" });
        authored.push({ id: draft.id, kind, scope });
      }

      const listed = (await asUser(
        client, ids.admin, ids.adminSession,
        "select public.get_staff_vote_campaigns() value",
      )).rows[0].value;
      expect(listed.canManageUnion).toBe(true);
      const idsListed = listed.campaigns.map((row) => row.id).sort();
      expect(idsListed).toEqual(expect.arrayContaining(authored.map((row) => row.id).sort()));
      for (const campaign of authored) {
        const row = listed.campaigns.find((entry) => entry.id === campaign.id);
        expect(row).toMatchObject({ kind: campaign.kind, scope: campaign.scope, state: "closed" });
      }
    });
  }, 60_000);

  it("refuses a unit-limited chapter steward both chapter and union authoring (#8941)", async () => {
    await withFixture(async (client, ids) => {
      await asUser(
        client, ids.founder, ids.founderSession,
    // This new steward grant explicitly chooses a real unit.
        "select public.set_member_access_role($1,$2,'steward',true,((public.get_chapter_access_workspace($2)->'units')->0->>'id')::uuid,null)",
        [ids.steward, ids.chapter],
      );
      // SEC-UG-UNIT-STEWARD-OPENS-CHAPTER-WIDE-VOTE-CAMPAIGNS-20261115:
      // a steward limited to a unit runs no chapter-wide campaign; carry-over
      // stewards and chapter leadership keep chapter authoring
      // (tests/vote-campaign-unit-limit-db.test.js).
      for (const scope of ["chapter", "union"]) {
        await expect(saveDraft(client, ids.steward, ids.stewardSession, {
          kind: "ballot", scope, quorum: 10,
          titleEn: "Steward ballot",
          titleEs: "Papeleta del steward",
        })).rejects.toMatchObject({ code: "42501", message: expect.stringContaining("campaign scope unavailable") });
      }

      const listed = (await asUser(
        client, ids.steward, ids.stewardSession,
        "select public.get_staff_vote_campaigns() value",
      )).rows[0].value;
      expect(listed.canManageUnion).toBe(false);
      expect(listed.campaigns).toEqual([]);
    });
  }, 60_000);

  it("keeps a legacy member_roles admin on union authoring", async () => {
    await withFixture(async (client, ids) => {
      await client.query(
        "insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'steward',$3)",
        [ids.org, ids.legacy, ids.founder],
      );
      await client.query("alter table public.member_roles disable trigger member_roles_forbid_new_ownerless");
      await client.query(
        "insert into public.member_roles(user_id,role,chapter_id,granted_by) values($1,'admin',null,$2)",
        [ids.legacy, ids.founder],
      );
      await client.query("alter table public.member_roles enable trigger member_roles_forbid_new_ownerless");

      const listed = (await asUser(
        client, ids.legacy, ids.legacySession,
        "select public.get_staff_vote_campaigns() value",
      )).rows[0].value;
      expect(listed.canManageUnion).toBe(true);
      const draft = await saveDraft(client, ids.legacy, ids.legacySession, {
        kind: "pulse", scope: "union", quorum: null,
        titleEn: "Legacy union pulse",
        titleEs: "Pulso legado sindical",
      });
      expect(draft.state).toBe("draft");
      const published = (await asUser(
        client, ids.legacy, ids.legacySession,
        "select public.publish_vote_campaign('pulse',$1) value",
        [draft.id],
      )).rows[0].value;
      expect(published.state).toBe("open");
      const closed = (await asUser(
        client, ids.legacy, ids.legacySession,
        "select public.close_vote_campaign('pulse',$1) value",
        [draft.id],
      )).rows[0].value;
      expect(closed.state).toBe("closed");
    });
  }, 60_000);
});
