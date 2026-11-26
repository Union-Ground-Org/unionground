// @vitest-environment node
//
// BUG-UG-MEMBER-NEVER-SEES-GRIEVANCE-OUTCOME-20261106 (#7195)
//
// A coordinator's recorded outcome was staff-only and nothing told the member
// their case had been resolved. 20261106216000 gives the case owner a select
// policy on member_case_outcomes (under the existing mfa_assurance and
// member_pin_step_up restrictive policies) and has
// coordinator_record_case_outcome send the owner one case.resolved notice.
//
// The offline half pins the migration text and the db-contract rows; the live
// half proves the policy and the notice against a disposable database.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, latestFnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

const sql = stripComments(loadMigrationSql("20261106216000_member_case_outcome_visible_to_owner"));
const squash = (text) => text.replace(/\s+/g, " ").trim();
const flat = squash(sql);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("member case outcome owner read and resolution notice migration", () => {
  it("merges an owner branch, bound to both the row and the parent case owner, into the one permissive SELECT policy", () => {
    expect(flat).toContain("if observed is distinct from array['member_case_outcomes_select_coordinator'] then");
    expect(flat).toContain("drop policy member_case_outcomes_select_coordinator on public.member_case_outcomes;");
    expect(flat).toContain(
      "create policy member_case_outcomes_select on public.member_case_outcomes for select to authenticated using ( ( user_id = (select auth.uid()) and exists ( select 1 from public.member_cases c where c.id = member_case_outcomes.case_id and c.user_id = (select auth.uid()) ) ) or ( public.staff_can_see_user(user_id, 'coordinator') and exists ( select 1 from public.member_cases c where c.id = member_case_outcomes.case_id ) ) );",
    );
    // A read policy only: the member gains no write path to the outcome.
    expect(flat).not.toMatch(/create policy \w+ on public\.member_case_outcomes for (insert|update|delete|all)/);
    expect(flat).not.toMatch(/grant (insert|update|delete)/);
  });

  it("writes EN and ES resolution copy that carries no case content", () => {
    expect(flat).toContain("('case.resolved', 'en', 'Your case was resolved', 'Open Cases to see how it ended.')");
    expect(flat).toContain("('case.resolved', 'es', 'Tu caso se resolvió', 'Abre Casos para ver cómo terminó.')");
    const copy = flat.slice(flat.indexOf("insert into private.notification_copy"), flat.indexOf("on conflict (key, lang)"));
    expect(copy).not.toMatch(/\{\w+\}/);
  });

  it("notifies the case owner whenever the writer resolves the case or changes the recorded outcome", () => {
    const body = squash(stripComments(fnBody(sql, "public.coordinator_record_case_outcome")));
    expect(body).toContain(
      "if c.status is distinct from 'resolved' or prior.case_id is null or prior.outcome is distinct from saved.outcome or prior.summary is distinct from saved.summary then perform private.notify_member(c.user_id, 'case.resolved', '{}'::jsonb, 'cases'); end if;",
    );
    // The notice is sent after every write the action makes, and the rest of
    // the reviewed 20261104123000 body is unchanged.
    expect(body.indexOf("'case.resolved'")).toBeGreaterThan(body.indexOf("'outcome_recorded'"));
    expect(squash(latestFnBody("public.coordinator_record_case_outcome"))).toBe(body);
    const previous = squash(stripComments(fnBody(loadMigrationSql("20261104123000_learning_period_case_workflow"), "public.coordinator_record_case_outcome")));
    const withoutNotice = body.replace(/ if c\.status is distinct from 'resolved' or prior\.case_id is null or prior\.outcome is distinct from saved\.outcome or prior\.summary is distinct from saved\.summary then perform private\.notify_member\(c\.user_id, 'case\.resolved', '\{\}'::jsonb, 'cases'\); end if;/, "");
    expect(withoutNotice).toBe(previous);
  });

  it("pins the owner policy and the notice in the database contract", () => {
    const permissive = contract.policies.filter((row) => row.table === "member_case_outcomes" && row.permissive !== false);
    expect(permissive.map((row) => row.name)).toEqual(["member_case_outcomes_select"]);
    expect(permissive[0]).toMatchObject({ cmd: "r", roles: "authenticated" });
    expect(squash(permissive[0].qual)).toBe(squash(
      "(((user_id = ( SELECT auth.uid() AS uid)) AND (EXISTS ( SELECT 1 FROM member_cases c WHERE ((c.id = member_case_outcomes.case_id) AND (c.user_id = ( SELECT auth.uid() AS uid)))))) OR (staff_can_see_user(user_id, 'coordinator'::text) AND (EXISTS ( SELECT 1 FROM member_cases c WHERE (c.id = member_case_outcomes.case_id)))))",
    ));
    const writer = contract.functions.find((row) => row.sig === "public.coordinator_record_case_outcome(p_case_id uuid, p_outcome text, p_summary text)");
    expect(writer.bodyContains).toContain("private.notify_member(c.user_id, 'case.resolved', '{}'::jsonb, 'cases')");
    expect(writer.bodyContains).toContain("if c.status is distinct from 'resolved' or prior.case_id is null");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("a case owner reads their recorded outcome and hears once that the case was resolved", () => {
  let client;
  const id = Object.fromEntries([
    "owner", "other", "coordinator", "ownerSession", "ownerAal1Session", "ownerPinSession", "otherSession", "coordinatorSession",
    "org", "case",
  ].map((key) => [key, randomUUID()]));
  const chapter = `case-outcome-owner-${id.org}`;
  const reference = "CASE-OUTCOME-OWNER";

  const act = async (actor, session, aal = "aal2") => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role: "authenticated", sub: actor, session_id: session, aal }),
    ]);
    await client.query("set local role authenticated");
  };
  const outcomes = async () => (await client.query(
    "select outcome, summary from public.member_case_outcomes where case_id = $1",
    [id.case],
  )).rows;
  const notices = async () => {
    await client.query("reset role");
    return (await client.query(
      "select title, body, kind, copy_key from public.member_notifications where user_id = $1 and copy_key = 'case.resolved' order by created_at, id",
      [id.owner],
    )).rows;
  };
  const record = async (outcome, summary) => {
    await act(id.coordinator, id.coordinatorSession);
    await client.query("select public.coordinator_record_case_outcome($1, $2, $3)", [id.case, outcome, summary]);
  };

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "member-case-outcome-owner-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");

    const people = [[id.owner, id.ownerSession], [id.other, id.otherSession], [id.coordinator, id.coordinatorSession]];
    for (const [user, session] of people) {
      await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [user, `${user}@example.invalid`]);
      await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, user]);
      await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic outcome factor','totp','verified',now(),now())", [randomUUID(), user]);
    }
    for (const [session, aal] of [[id.ownerAal1Session, "aal1"], [id.ownerPinSession, "aal2"]]) {
      await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),$3)", [session, id.owner, aal]);
    }
    await client.query("insert into private.member_pin_sessions(session_id,user_id) values($1,$2)", [id.ownerPinSession, id.owner]);
    await client.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [id.org, chapter, id.owner]);
    await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9903)", [chapter, id.org]);
    for (const [user] of people) {
      await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [id.org, user]);
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user, chapter]);
      await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, chapter]);
    }
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'coordinator',$2)", [id.org, id.coordinator]);
    await client.query(
      "insert into public.member_cases(id,user_id,reference,title,case_type,organization_id,chapter_id) values($1,$2,$3,$3,'other',$4,$5)",
      [id.case, id.owner, reference, id.org, chapter],
    );
  }, 120000);

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("shows nothing before an outcome is recorded and sends no notice", async () => {
    await act(id.owner, id.ownerSession);
    expect(await outcomes()).toEqual([]);
    expect(await notices()).toEqual([]);
  });

  it("lets the case owner read the outcome and summary and refuses another member", async () => {
    await record("settled", "Back pay restored for the missed shifts.");
    await act(id.owner, id.ownerSession);
    expect(await outcomes()).toEqual([{ outcome: "settled", summary: "Back pay restored for the missed shifts." }]);
    await act(id.other, id.otherSession);
    expect(await outcomes()).toEqual([]);
  });

  it("refuses the owner without two-step assurance and in a restricted PIN session", async () => {
    // The owner has a verified authenticator, so an aal1 session is short of
    // the assurance mfa_assurance requires.
    await act(id.owner, id.ownerAal1Session, "aal1");
    expect(await outcomes()).toEqual([]);
    // member_pin_step_up admits no row to a restricted PIN session.
    await act(id.owner, id.ownerPinSession);
    expect(await outcomes()).toEqual([]);
    await act(id.owner, id.ownerSession);
    expect(await outcomes()).toHaveLength(1);
  });

  it("sends the owner one resolution notice with no case content, and another only when the outcome changes", async () => {
    const first = await notices();
    expect(first).toEqual([{ title: "Your case was resolved", body: "Open Cases to see how it ended.", kind: "cases", copy_key: "case.resolved" }]);
    for (const text of [reference, "settled", "Back pay"]) {
      expect(`${first[0].title} ${first[0].body}`).not.toContain(text);
    }
    await record("settled", "Back pay restored for the missed shifts.");
    expect(await notices()).toHaveLength(1);
    await record("settled", "Back pay restored for the missed shifts, with interest.");
    expect(await notices()).toHaveLength(2);
    // Gate r1s1/r2s1: the owner reopens the case (the outcome row stays),
    // and the identical outcome resolves it again, which is a new resolution.
    await act(id.owner, id.ownerSession);
    await client.query("select public.update_my_member_case($1, 'active', null)", [id.case]);
    await record("settled", "Back pay restored for the missed shifts, with interest.");
    expect(await notices()).toHaveLength(3);
    // A retry on the case it already resolved still sends nothing.
    await record("settled", "Back pay restored for the missed shifts, with interest.");
    expect(await notices()).toHaveLength(3);
    await client.query("reset role");
    await client.query("update public.member_profiles set language='es' where id=$1", [id.owner]);
    await record("denied", "The grievance was denied at step 2.");
    // One transaction gives every notice the same created_at, so the Spanish
    // one is found by content rather than by position.
    const all = await notices();
    expect(all).toHaveLength(4);
    expect(all).toContainEqual({ title: "Tu caso se resolvió", body: "Abre Casos para ver cómo terminó.", kind: "cases", copy_key: "case.resolved" });
    // The coordinator's own notices are untouched.
    expect((await client.query("select count(*)::int as n from public.member_notifications where user_id = $1 and copy_key = 'case.resolved'", [id.coordinator])).rows[0].n).toBe(0);
  });
});
