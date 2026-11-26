// @vitest-environment node
//
// SEC-UG-CROSS-TENANT-VOTE-CAMPAIGNS-20260920
//
// Ballots and pulses carry an owning organization. A member reads, votes on,
// answers and tallies only campaigns owned by their selected organization, and
// staff list, publish and close only their own organization's campaigns. An
// organization-wide campaign with no owner is quarantined, never platform-wide.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const MIGRATION = "20260924160000_vote_campaign_organization_boundary.sql";
const migrationSql = loadMigrationSql("vote_campaign_organization_boundary");
const sql = stripComments(migrationSql);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
const OPTIONS = JSON.stringify([
  { labelEn: "Yes option", labelEs: "Opción sí" },
  { labelEn: "No option", labelEs: "Opción no" },
]);
const LOCK_PREAMBLE = /^\nbegin\n {2}perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);\n\ndeclare\n/;

describe("vote campaign organization boundary (static)", () => {
  it("bounds every read policy and member lookup by the owning organization", () => {
    const reader = fnBody(sql, "private.can_read_vote_campaign");
    expect(reader).toMatch(/p_chapter_id is null then\s+p_organization_id is not null\s+and p_organization_id = private\.current_member_organization\(\)/);
    expect(reader).toContain("p_organization_id is not distinct from private.current_member_organization()");
    for (const policy of [
      "member_ballots_read_eligible",
      "member_ballot_options_read_eligible",
      "member_surveys_read_eligible",
      "member_survey_options_read_eligible",
    ]) {
      const body = sql.slice(sql.indexOf(`create policy ${policy}`)).split(";")[0];
      expect(body).toContain("private.can_read_vote_campaign(");
      expect(body).not.toContain("chapter_id is null or");
    }
    expect(fnBody(sql, "public.submit_ballot_vote")).toContain("private.can_read_vote_campaign(b.organization_id, b.chapter_id)");
    expect(fnBody(sql, "public.submit_survey_response")).toContain("private.can_read_vote_campaign(s.organization_id, s.chapter_id)");
    expect(fnBody(sql, "public.get_ballot_tally")).toContain("private.can_read_vote_campaign(organization_id, chapter_id)");
    const manage = fnBody(sql, "private.can_manage_vote_campaign");
    expect(manage).toContain("p_organization_id is not distinct from private.current_member_organization()");
    expect(manage).toContain("private.can_manage_vote_scope(p_chapter_id)");
    for (const name of ["get_staff_vote_campaigns", "save_vote_campaign_draft", "publish_vote_campaign", "close_vote_campaign"]) {
      const body = fnBody(sql, `public.${name}`);
      expect(body).toContain("private.can_manage_vote_campaign(b.organization_id, b.chapter_id)");
      expect(body).toContain("private.can_manage_vote_campaign(s.organization_id, s.chapter_id)");
      expect(body).not.toContain("can_manage_vote_scope(b.chapter_id)");
    }
  });

  it("keeps the case-graph lock preamble first in every re-emitted writer", () => {
    const functions = parseFunctions(migrationSql, MIGRATION);
    for (const name of [
      "public.save_vote_campaign_draft",
      "public.publish_vote_campaign",
      "public.close_vote_campaign",
      "public.submit_ballot_vote",
      "public.submit_survey_response",
    ]) {
      const fn = functions.find((entry) => entry.name === name);
      expect(fn, name).toBeTruthy();
      expect(fn.source, name).toMatch(LOCK_PREAMBLE);
    }
  });

  it("pins the organization boundary in the database contract", () => {
    const policies = contract.policies.filter((entry) => /^member_(ballot|survey)(_option)?s_read_eligible$/.test(entry.name));
    expect(policies).toHaveLength(4);
    for (const policy of policies) expect(policy.qual).toContain("private.can_read_vote_campaign(");
    const fn = (prefix) => contract.functions.find((entry) => entry.sig.startsWith(prefix));
    expect(fn("public.submit_ballot_vote(").bodyContains).toContain("private.can_read_vote_campaign(b.organization_id, b.chapter_id)");
    expect(fn("public.submit_survey_response(").bodyContains).toContain("private.can_read_vote_campaign(s.organization_id, s.chapter_id)");
    expect(fn("public.get_ballot_tally(").bodyContains).toContain("private.can_read_vote_campaign(organization_id, chapter_id)");
    for (const prefix of ["public.get_staff_vote_campaigns(", "public.publish_vote_campaign(", "public.close_vote_campaign(", "public.save_vote_campaign_draft("]) {
      expect(fn(prefix).bodyContains.join("\n"), prefix).toContain("private.can_manage_vote_campaign(");
    }
    expect(fn("private.can_read_vote_campaign(")).toBeTruthy();
    expect(fn("private.can_manage_vote_campaign(")).toBeTruthy();
    expect(fn("private.assign_vote_campaign_organization(")).toBeTruthy();
  });
});

// BUG-UG-WEB-STAFF-CAMPAIGNS-REGISTRY-UNBOUNDED-READ-20261002: the
// registry read becomes one bounded keyset page; the boundary above is kept.
describe("staff campaign registry paged read (static)", () => {
  const pagedSql = stripComments(loadMigrationSql("staff_vote_campaigns_paged_registry_read"));
  const body = fnBody(pagedSql, "public.get_staff_vote_campaigns");

  it("drops the unbounded parameterless read and pages with a clamped limit and a cursor", () => {
    expect(pagedSql).toMatch(/drop function public\.get_staff_vote_campaigns\(\);/);
    expect(pagedSql).toContain("create function public.get_staff_vote_campaigns(\n  p_state text default null,\n  p_limit integer default 50,\n  p_cursor jsonb default null\n)");
    expect(body).toContain("least(greatest(coalesce(p_limit, 50), 1), 100)");
    expect(body).toContain("limit page_limit + 1");
    expect(body).toContain("order by ranked.state_rank, ranked.closes_at desc, ranked.kind, ranked.id");
    expect(body).toContain("'nextCursor', case when has_more then next_cursor else null end");
    expect(body).toMatch(/'counts', counts/);
  });

  it("keeps the staff role check and the organization boundary on both tables", () => {
    expect(body).toContain("public.member_has_role(array['steward', 'coordinator', 'advisor', 'admin', 'vp'])");
    expect(body).toContain("private.can_manage_vote_campaign(b.organization_id, b.chapter_id)");
    expect(body).toContain("private.can_manage_vote_campaign(s.organization_id, s.chapter_id)");
    expect(body).not.toContain("can_manage_vote_scope(b.chapter_id)");
    expect(pagedSql).toContain("revoke all on function public.get_staff_vote_campaigns(text, integer, jsonb) from public, anon;");
    expect(pagedSql).toContain("grant execute on function public.get_staff_vote_campaigns(text, integer, jsonb) to authenticated, service_role;");
    const entry = contract.functions.find((fn) => fn.sig.startsWith("public.get_staff_vote_campaigns("));
    expect(entry.sig).toBe("public.get_staff_vote_campaigns(p_state text, p_limit integer, p_cursor jsonb)");
    expect(entry.bodyContains).toEqual(expect.arrayContaining(["limit page_limit + 1", "least(greatest(coalesce(p_limit, 50), 1), 100)"]));
  });
});

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
  const savepoint = `vote_boundary_${++savepointSeq}`;
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

async function asPostgres(client, statement, values = []) {
  const savepoint = `vote_boundary_${++savepointSeq}`;
  await client.query(`savepoint ${savepoint}`);
  try {
    const result = await client.query(statement, values);
    await client.query(`release savepoint ${savepoint}`);
    return result;
  } catch (error) {
    await client.query(`rollback to savepoint ${savepoint}`);
    await client.query(`release savepoint ${savepoint}`);
    throw error;
  }
}

async function seedPerson(client, { user, email, org, chapter, session }) {
  await client.query("insert into auth.users(id,email) values($1,$2)", [user, email]);
  await client.query(
    "insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())",
    [session, user],
  );
  await client.query(
    `insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at)
     values(gen_random_uuid(),$1,'vote-boundary-totp','totp','verified',now(),now())`,
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

async function seedTenant(client, label, order) {
  const tenant = {
    org: randomUUID(),
    admin: randomUUID(),
    member: randomUUID(),
    adminSession: randomUUID(),
    memberSession: randomUUID(),
  };
  tenant.chapter = `vote-boundary-${label}-${tenant.org.slice(0, 8)}`;
  await client.query(
    "insert into public.organizations(id,slug,name) values($1,$2,$2)",
    [tenant.org, tenant.chapter],
  );
  await client.query(
    "insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,$3)",
    [tenant.chapter, tenant.org, order],
  );
  await seedPerson(client, {
    user: tenant.admin, email: `vote-boundary-admin-${label}@example.invalid`,
    org: tenant.org, chapter: tenant.chapter, session: tenant.adminSession,
  });
  await seedPerson(client, {
    user: tenant.member, email: `vote-boundary-member-${label}@example.invalid`,
    org: tenant.org, chapter: tenant.chapter, session: tenant.memberSession,
  });
  await client.query(
    "insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'admin',$2)",
    [tenant.org, tenant.admin],
  );
  return tenant;
}

async function withFixture(run) {
  const client = new pg.Client({
    connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
    ssl: false,
    application_name: "vote-campaign-organization-boundary-proof",
  });
  await client.connect();
  await client.query("begin");
  try {
    const a = await seedTenant(client, "a", 9921);
    const b = await seedTenant(client, "b", 9922);
    await run(client, { a, b });
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end();
  }
}

async function author(client, tenant, { kind, scope, publish }) {
  const draft = (await asUser(
    client, tenant.admin, tenant.adminSession,
    "select public.save_vote_campaign_draft($1,null,$2,$3,$4,now() + interval '7 days',$5,'Body text','Texto del cuerpo',$6::jsonb) value",
    [kind, scope, `${kind} ${scope} english`, `${kind} ${scope} español`, kind === "ballot" ? 10 : null, OPTIONS],
  )).rows[0].value;
  if (publish) {
    await asUser(client, tenant.admin, tenant.adminSession, "select public.publish_vote_campaign($1,$2)", [kind, draft.id]);
  }
  return draft.id;
}

async function visibleRows(client, tenant, ballotId, surveyId) {
  const { rows } = await asUser(
    client, tenant.member, tenant.memberSession,
    `select
       (select count(*)::int from public.member_ballots where id = $1) ballots,
       (select count(*)::int from public.member_ballot_options where ballot_id = $1) ballot_options,
       (select count(*)::int from public.member_surveys where id = $2) surveys,
       (select count(*)::int from public.member_survey_options where survey_id = $2) survey_options`,
    [ballotId, surveyId],
  );
  return rows[0];
}

live("vote campaign organization boundary on a disposable database", () => {
  it("stamps the owning organization and keeps another organization's members from reading it", async () => {
    await withFixture(async (client, { a, b }) => {
      const ballot = await author(client, a, { kind: "ballot", scope: "union", publish: true });
      const pulse = await author(client, a, { kind: "pulse", scope: "union", publish: true });
      const chapterBallot = await author(client, a, { kind: "ballot", scope: "chapter", publish: true });
      const owners = (await client.query(
        "select id, organization_id, chapter_id from public.member_ballots where id = any($1) union all select id, organization_id, chapter_id from public.member_surveys where id = $2",
        [[ballot, chapterBallot], pulse],
      )).rows;
      expect(owners).toHaveLength(3);
      for (const row of owners) expect(row.organization_id).toBe(a.org);

      expect(await visibleRows(client, a, ballot, pulse)).toEqual({ ballots: 1, ballot_options: 2, surveys: 1, survey_options: 2 });
      expect(await visibleRows(client, b, ballot, pulse)).toEqual({ ballots: 0, ballot_options: 0, surveys: 0, survey_options: 0 });
      expect((await visibleRows(client, b, chapterBallot, pulse)).ballots).toBe(0);
    });
  }, 60_000);

  it("refuses another organization's vote, pulse response and tally exactly like an unknown campaign", async () => {
    await withFixture(async (client, { a, b }) => {
      const ballot = await author(client, a, { kind: "ballot", scope: "union", publish: true });
      const pulse = await author(client, a, { kind: "pulse", scope: "union", publish: true });
      const ballotOption = (await client.query(
        "select id from public.member_ballot_options where ballot_id=$1 order by order_index limit 1", [ballot],
      )).rows[0].id;
      const pulseOption = (await client.query(
        "select id from public.member_survey_options where survey_id=$1 order by order_index limit 1", [pulse],
      )).rows[0].id;

      const unknown = await asUser(client, b.member, b.memberSession,
        "select public.submit_ballot_vote('no-such-ballot',$1)", [ballotOption]).catch((error) => error);
      const foreign = await asUser(client, b.member, b.memberSession,
        "select public.submit_ballot_vote($1,$2)", [ballot, ballotOption]).catch((error) => error);
      expect(unknown).toMatchObject({ code: "22023", message: "ballot not found" });
      expect(foreign).toMatchObject({ code: unknown.code, message: unknown.message });

      await expect(asUser(client, b.member, b.memberSession,
        "select public.submit_survey_response($1,$2)", [pulse, pulseOption]))
        .rejects.toMatchObject({ code: "22023", message: "pulse not found" });
      await expect(asUser(client, b.member, b.memberSession,
        "select public.get_ballot_tally($1)", [ballot]))
        .rejects.toMatchObject({ code: "22023", message: "ballot not found" });
      expect((await client.query(
        "select count(*)::int n from public.member_ballot_receipts where ballot_id=$1", [ballot],
      )).rows[0].n).toBe(0);

      const vote = (await asUser(client, a.member, a.memberSession,
        "select public.submit_ballot_vote($1,$2) value", [ballot, ballotOption])).rows[0].value;
      expect(vote.receiptCode).toBeTruthy();
      await asUser(client, a.member, a.memberSession, "select public.submit_survey_response($1,$2)", [pulse, pulseOption]);
      const tally = (await asUser(client, a.member, a.memberSession,
        "select public.get_ballot_tally($1) value", [ballot])).rows[0].value;
      expect(tally.totalVotes).toBe(1);
    });
  }, 60_000);

  it("keeps another organization's staff from listing, editing, publishing or closing the campaign", async () => {
    await withFixture(async (client, { a, b }) => {
      const draft = await author(client, a, { kind: "ballot", scope: "union", publish: false });
      const open = await author(client, a, { kind: "pulse", scope: "union", publish: true });

      const foreignRegistry = (await asUser(client, b.admin, b.adminSession,
        "select public.get_staff_vote_campaigns() value")).rows[0].value;
      expect(foreignRegistry.canManageUnion).toBe(true);
      expect(foreignRegistry.campaigns.map((row) => row.id)).not.toEqual(expect.arrayContaining([draft]));
      expect(foreignRegistry.campaigns.map((row) => row.id)).not.toEqual(expect.arrayContaining([open]));

      await expect(asUser(client, b.admin, b.adminSession,
        "select public.publish_vote_campaign('ballot',$1)", [draft]))
        .rejects.toMatchObject({ code: "22023", message: "campaign not found" });
      await expect(asUser(client, b.admin, b.adminSession,
        "select public.close_vote_campaign('pulse',$1)", [open]))
        .rejects.toMatchObject({ code: "22023", message: "campaign not found" });
      await expect(asUser(client, b.admin, b.adminSession,
        "select public.save_vote_campaign_draft('ballot',$1,'union','Hijack title','Titulo robado',now() + interval '7 days',10,'','',$2::jsonb)",
        [draft, OPTIONS]))
        .rejects.toMatchObject({ code: "22023", message: "campaign not found" });

      const state = (await client.query(
        "select (select campaign_state from public.member_ballots where id=$1) ballot, (select campaign_state from public.member_surveys where id=$2) pulse, (select title from public.member_ballots where id=$1) title",
        [draft, open],
      )).rows[0];
      expect(state).toEqual({ ballot: "draft", pulse: "open", title: "ballot union english" });

      const ownRegistry = (await asUser(client, a.admin, a.adminSession,
        "select public.get_staff_vote_campaigns() value")).rows[0].value;
      expect(ownRegistry.campaigns.map((row) => row.id)).toEqual(expect.arrayContaining([draft, open]));
    });
  }, 60_000);

  it("refuses ownerless or mismatched owners and quarantines a legacy ownerless campaign", async () => {
    await withFixture(async (client, { a, b }) => {
      await expect(asPostgres(client,
        `insert into public.member_ballots (id,title,closes_at,active,campaign_state,order_index,quorum_target)
         values ('vote-boundary-ownerless','Ownerless',now() + interval '1 day',true,'open',9921001,10)`))
        .rejects.toMatchObject({ code: "42501" });
      await expect(asPostgres(client,
        `insert into public.member_surveys (id,title,closes_at,active,campaign_state,order_index,chapter_id,organization_id)
         values ('vote-boundary-mismatch','Mismatch',now() + interval '1 day',true,'open',9921002,$1,$2)`,
        [a.chapter, b.org]))
        .rejects.toMatchObject({ code: "42501" });

      const owned = await author(client, a, { kind: "pulse", scope: "union", publish: true });
      await expect(asPostgres(client,
        "update public.member_surveys set organization_id=$2 where id=$1", [owned, b.org]))
        .rejects.toMatchObject({ code: "42501" });

      await client.query("alter table public.member_ballots disable trigger b10_vote_campaign_organization");
      await client.query(
        `insert into public.member_ballots (id,title,closes_at,active,campaign_state,order_index,quorum_target)
         values ('vote-boundary-legacy','Legacy',now() + interval '1 day',true,'open',9921003,10)`,
      );
      await client.query("alter table public.member_ballots enable trigger b10_vote_campaign_organization");
      await client.query(
        "insert into public.member_ballot_options (id,ballot_id,label,order_index) values ('vote-boundary-legacy-yes','vote-boundary-legacy','Yes',1)",
      );
      for (const tenant of [a, b]) {
        expect((await visibleRows(client, tenant, "vote-boundary-legacy", "none")).ballots).toBe(0);
        await expect(asUser(client, tenant.member, tenant.memberSession,
          "select public.submit_ballot_vote('vote-boundary-legacy','vote-boundary-legacy-yes')"))
          .rejects.toMatchObject({ code: "22023", message: "ballot not found" });
        const registry = (await asUser(client, tenant.admin, tenant.adminSession,
          "select public.get_staff_vote_campaigns() value")).rows[0].value;
        expect(registry.campaigns.map((row) => row.id)).not.toContain("vote-boundary-legacy");
      }
    });
  }, 60_000);

  it("pages the registry with a page size and cursor, keeping counts and the boundary", async () => {
    await withFixture(async (client, { a, b }) => {
      const authored = [];
      for (const [kind, publish, close] of [
        ["ballot", false, false], ["pulse", false, false], ["ballot", false, false],
        ["ballot", true, false], ["pulse", true, false],
        ["ballot", true, true], ["pulse", true, true],
      ]) {
        const id = await author(client, a, { kind, scope: "union", publish });
        if (close) await asUser(client, a.admin, a.adminSession, "select public.close_vote_campaign($1,$2)", [kind, id]);
        authored.push(id);
      }
      const read = async (tenant, state, limit, cursor) => (await asUser(client, tenant.admin, tenant.adminSession,
        "select public.get_staff_vote_campaigns($1,$2,$3::jsonb) value", [state, limit, cursor ? JSON.stringify(cursor) : null])).rows[0].value;

      const whole = await read(a, null, 100, null);
      expect(whole.counts).toEqual({ all: 7, draft: 3, open: 2, closed: 2 });
      expect(whole.nextCursor).toBeNull();
      expect(whole.campaigns.map((row) => row.state)).toEqual(["draft", "draft", "draft", "open", "open", "closed", "closed"]);
      expect(new Set(whole.campaigns.map((row) => row.id))).toEqual(new Set(authored));

      const walked = [];
      let cursor = null;
      let pages = 0;
      do {
        const page = await read(a, null, 2, cursor);
        expect(page.campaigns.length).toBeLessThanOrEqual(2);
        expect(page.limit).toBe(2);
        expect(page.counts).toEqual(whole.counts);
        expect(page.canManageUnion).toBe(true);
        walked.push(...page.campaigns.map((row) => row.id));
        cursor = page.nextCursor;
        pages += 1;
      } while (cursor && pages < 10);
      expect(pages).toBe(4);
      expect(walked).toEqual(whole.campaigns.map((row) => row.id));

      const open = await read(a, "open", 50, null);
      expect(open.campaigns.map((row) => row.state)).toEqual(["open", "open"]);
      expect(open.counts).toEqual(whole.counts);
      expect((await read(a, null, 0, null)).campaigns).toHaveLength(1);
      expect((await read(a, null, 1000, null)).limit).toBe(100);
      const defaulted = (await asUser(client, a.admin, a.adminSession, "select public.get_staff_vote_campaigns() value")).rows[0].value;
      expect(defaulted.limit).toBe(50);
      expect(defaulted.campaigns.map((row) => row.id)).toEqual(whole.campaigns.map((row) => row.id));

      await expect(asUser(client, a.admin, a.adminSession,
        "select public.get_staff_vote_campaigns(null, 2, $1::jsonb)", [JSON.stringify({ rank: "x", closesAt: "soon", kind: "ballot", id: "b" })]))
        .rejects.toMatchObject({ code: "22023" });
      await expect(asUser(client, a.admin, a.adminSession,
        "select public.get_staff_vote_campaigns(null, 2, $1::jsonb)", [JSON.stringify({ ...whole.nextCursor, rank: 0, closesAt: new Date().toISOString(), kind: "survey", id: "b" })]))
        .rejects.toMatchObject({ code: "22023" });
      await expect(asUser(client, a.admin, a.adminSession, "select public.get_staff_vote_campaigns('archived')"))
        .rejects.toMatchObject({ code: "22023" });

      const foreign = await read(b, null, 100, null);
      expect(foreign.counts).toEqual({ all: 0, draft: 0, open: 0, closed: 0 });
      expect(foreign.campaigns).toEqual([]);
      await expect(asUser(client, a.member, a.memberSession, "select public.get_staff_vote_campaigns(null, 2, null)"))
        .rejects.toMatchObject({ code: "42501" });
    });
  }, 60_000);
});
