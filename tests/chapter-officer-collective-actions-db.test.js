// @vitest-environment node
//
// BUG-UG-CHAPTER-PRESIDENT-CANNOT-START-A-PETITION-20261118 (#9166)
// A President (or other manager hat) granted for one chapter starts, edits,
// publishes and closes collective actions of that chapter only, by the votes
// rule; a chapter-tagged action is read and joined by members of that
// selected chapter, and by anyone who already joined it (who can still see
// and withdraw). Organization managers and organization-wide actions keep
// today's behaviour; a steward limited to a unit (#8941) gains nothing.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";

const migration = loadMigrationSql("chapter_officers_start_chapter_petitions");
const flat = stripComments(migration).replace(/\s+/g, " ");

describe("chapter officer collective actions migration (static)", () => {
  it("guards each predecessor and keeps the case-graph prologue on both writers", () => {
    for (const name of ["save_digital_action", "get_collective_actions", "toggle_digital_action_participation"]) {
      expect(flat).toContain(`raise exception 'unreviewed predecessor: public.${name}'`);
    }
    expect(flat.match(/as \$function\$ begin perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);/g)).toHaveLength(2);
    // The three re-emitted functions and the one join-rule helper.
    expect(flat.match(/security definer set search_path = ''|SECURITY DEFINER SET search_path TO ''/gi)).toHaveLength(4);
  });

  it("admits a chapter grant only for the selected chapter and only for actions already in it", () => {
    expect(flat).toContain("chapter_grant := not organization_grant and coalesce(p_chapter_id = private.current_member_chapter(), false) and coalesce(private.member_has_chapter_role(p_chapter_id, array[p_selected_hat]), false);");
    expect(flat).toContain("if chapter_grant and existing_chapter is distinct from p_chapter_id then raise exception 'not authorized' using errcode = '42501';");
    expect(flat).toContain("if p_selected_hat not in ('advisor', 'admin', 'vp') and existing_creator is distinct from caller then raise exception 'not authorized' using errcode = '42501';");
    expect(flat).toContain("if not private.digital_action_join_allowed(action_row.chapter_id) and (p_joined or not exists ( select 1 from public.digital_action_participants own where own.organization_id = org and own.action_id = p_action_id and own.user_id = caller)) then raise exception 'digital action not found' using errcode = 'P0002';");
  });

  it("keeps one join rule, used by the join, the read reach and viewerCanJoin", () => {
    expect(flat).toContain("create function private.digital_action_join_allowed(p_chapter_id text) returns boolean language sql stable security definer set search_path = '' as $function$ select p_chapter_id is null or coalesce(p_chapter_id = private.current_member_chapter(), false); $function$;");
    expect(flat).toContain("revoke all on function private.digital_action_join_allowed(text) from public, anon, authenticated, service_role;");
    expect(flat.match(/private\.digital_action_join_allowed\((a|page|action_row)\.chapter_id\)/g)).toHaveLength(4);
    expect(flat).toContain("'viewerCanJoin', private.digital_action_join_allowed(a.chapter_id),");
  });

  it("states the before-apply assumption about chapter-tagged rows", () => {
    expect(migration).toContain("ASSUMPTION TO READ BEFORE THE APPLY");
    expect(migration).toContain("select pg_catalog.count(*) from public.digital_actions where chapter_id is not null;");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("chapter officers and chapter-tagged collective actions on an owned rollback database", () => {
  let db;
  const f = { people: {} };

  const owner = async () => { await db.query("reset role"); await db.query("select set_config('request.jwt.claims','',true)"); };
  const as = async (name) => {
    await owner();
    const p = f.people[name];
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: p.id, session_id: p.session, role: "authenticated", aal: "aal2" })]);
    await db.query("set local role authenticated");
  };
  const attempt = async (query, args = []) => {
    await db.query("savepoint chapter_action_attempt");
    try {
      const value = (await db.query(query, args)).rows[0]?.v;
      await db.query("release savepoint chapter_action_attempt");
      return { value };
    } catch (error) {
      await db.query("rollback to savepoint chapter_action_attempt");
      await db.query("release savepoint chapter_action_attempt");
      return { refused: error.code };
    }
  };
  const save = (name, hat, { id = null, chapter = null, title = "Safer break room petition", status = "published" } = {}) => as(name).then(() => attempt(
    "select public.save_digital_action($1,$2,$3,'petition',$4,'Fictional proof summary',$5,100,null,null) v",
    [hat, id, chapter, title, status],
  ));
  const list = async (name, hat) => {
    await as(name);
    const result = await attempt("select public.get_collective_actions($1,100,0) v", [hat]);
    if (result.refused) return result;
    return { ...result.value, byId: Object.fromEntries(result.value.actions.map((row) => [row.id, row])) };
  };
  const toggle = (name, id, joined) => as(name).then(() => attempt(
    "select public.toggle_digital_action_participation($1,'signature',$2) v",
    [id, joined],
  ));
  const row = async (id) => {
    await owner();
    return (await db.query("select title, status, chapter_id from public.digital_actions where id=$1", [id])).rows[0];
  };

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "chapter-officer-collective-actions-proof" });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '60s'");
    await db.query("set local lock_timeout = '15s'");
    await db.query("set constraints all deferred");
    f.org = randomUUID(); f.foreignOrg = randomUUID(); f.unitA = randomUUID();
    f.a = `cpa-a-${f.org.slice(0, 8)}`; f.b = `cpa-b-${f.org.slice(0, 8)}`; f.x = `cpa-x-${f.foreignOrg.slice(0, 8)}`;
    await db.query("insert into public.organizations(id,slug,name) values($1::uuid,$1::text,'Harbor Fictional Actions'),($2::uuid,$2::text,'Ridge Fictional Actions')", [f.org, f.foreignOrg]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,order_index) values($1,$1,$1,$2,99161),($3,$3,$3,$2,99162),($4,$4,$4,$5,99163)", [f.a, f.org, f.b, f.x, f.foreignOrg]);
    await db.query("insert into private.chapter_units(id,organization_id,chapter_id,name) values($1,$2,$3,'Garage A')", [f.unitA, f.org, f.a]);
    // name: [selected chapter, chapter role or null, organization role or null, extra chapter membership]
    const cast = {
      vpA: [f.a, "vp", null], coordA: [f.a, "coordinator", null], vpB: [f.b, "vp", null],
      orgVp: [f.b, null, "vp"], orgAdmin: [f.a, null, "admin"], memberA: [f.a, null, null],
      memberB: [f.b, null, null], unitSteward: [f.a, null, null], multi: [f.a, null, null, f.b],
      foreignVp: [f.x, "vp", null],
    };
    for (const [name, [chapter, chapterRole, organizationRole, extra]] of Object.entries(cast)) {
      const id = randomUUID(), session = randomUUID(), org = chapter === f.x ? f.foreignOrg : f.org;
      f.people[name] = { id, session };
      await db.query("insert into auth.users(id,email) values($1,$2)", [id, `${id}@example.invalid`]);
      await db.query("update public.member_profiles set chapter_id=$2,full_name=$3 where id=$1", [id, chapter, `Fictional ${name}`]);
      await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [session, id]);
      await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, id]);
      for (const member of [chapter, extra].filter(Boolean)) {
        await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [id, member]);
      }
      if (chapterRole) {
        await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3)", [id, chapterRole, chapter]);
        await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3)", [id, chapterRole, chapter]);
      }
      if (organizationRole) {
        await db.query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,$3)", [org, id, organizationRole]);
      }
    }
    // The steward is granted the way the app grants one since #7663: a
    // chapter steward role limited to Garage A.
    await as("orgAdmin");
    expect((await attempt("select public.set_member_access_role($1,$2,'steward',true,$3,null) v", [f.people.unitSteward.id, f.a, f.unitA])).refused).toBeUndefined();
    await owner();
    await db.query("set constraints all immediate");
    expect((await db.query("select count(*)::int n from private.chapter_role_scopes where user_id=$1 and chapter_id=$2 and role='steward' and not legacy_chapter_coverage", [f.people.unitSteward.id, f.a])).rows[0].n).toBe(1);

    f.orgWide = (await save("orgVp", "vp", { title: "Organization-wide petition" })).value.id;
    f.bAction = (await save("vpB", "vp", { chapter: f.b, title: "Chapter B petition" })).value.id;
    f.bDraft = (await save("vpB", "vp", { chapter: f.b, title: "Chapter B draft", status: "draft" })).value.id;
  });

  afterAll(async () => {
    if (!db) return;
    await db.query("rollback").catch(() => {});
    await db.end();
  });

  it("lets a chapter President start, edit, publish and close a petition for its own chapter", async () => {
    const started = await save("vpA", "vp", { chapter: f.a, title: "Chapter A draft", status: "draft" });
    expect(started.refused).toBeUndefined();
    f.aAction = started.value.id;
    expect(await row(f.aAction)).toEqual({ title: "Chapter A draft", status: "draft", chapter_id: f.a });
    expect((await save("vpA", "vp", { id: f.aAction, chapter: f.a, title: "Chapter A petition" })).refused).toBeUndefined();
    expect(await row(f.aAction)).toEqual({ title: "Chapter A petition", status: "published", chapter_id: f.a });
    f.aClosed = (await save("vpA", "vp", { chapter: f.a, title: "Chapter A closing" })).value.id;
    expect((await save("vpA", "vp", { id: f.aClosed, chapter: f.a, title: "Chapter A closing", status: "closed" })).refused).toBeUndefined();
    expect((await row(f.aClosed)).status).toBe("closed");
  });

  it("refuses a chapter President for the whole organization, another chapter and another organization", async () => {
    expect(await save("vpA", "vp", { chapter: null })).toEqual({ refused: "42501" });
    expect(await save("vpA", "vp", { chapter: f.b })).toEqual({ refused: "42501" });
    expect(await save("vpA", "vp", { chapter: f.x })).toEqual({ refused: "42501" });
    // Editing an organization-wide or another chapter's action, with or
    // without moving it into the President's chapter, is refused and leaves the row.
    for (const chapter of [null, f.a]) {
      expect(await save("vpA", "vp", { id: f.orgWide, chapter, title: "Hijacked" })).toEqual({ refused: "42501" });
      expect(await save("vpA", "vp", { id: f.bAction, chapter, title: "Hijacked" })).toEqual({ refused: "42501" });
    }
    expect(await row(f.orgWide)).toEqual({ title: "Organization-wide petition", status: "published", chapter_id: null });
    expect(await row(f.bAction)).toEqual({ title: "Chapter B petition", status: "published", chapter_id: f.b });
    // A President of another organization's chapter reaches nothing here.
    expect(await save("foreignVp", "vp", { id: f.aAction, chapter: f.a, title: "Hijacked" })).toEqual({ refused: "42501" });
  });

  it("keeps the edit rule inside the chapter: officers edit any, a coordinator only its own", async () => {
    const own = (await save("coordA", "coordinator", { chapter: f.a, title: "Coordinator A petition" })).value.id;
    expect((await save("coordA", "coordinator", { id: own, chapter: f.a, title: "Coordinator A revised" })).refused).toBeUndefined();
    expect(await save("coordA", "coordinator", { id: f.aAction, chapter: f.a, title: "Hijacked" })).toEqual({ refused: "42501" });
    expect((await save("vpA", "vp", { id: own, chapter: f.a, title: "Coordinator A, President edit" })).refused).toBeUndefined();
    expect((await row(own)).title).toBe("Coordinator A, President edit");
  });

  it("gives ordinary members and a unit-limited steward nothing", async () => {
    for (const hat of ["member", "vp", "steward"]) expect(await save("memberA", hat, { chapter: f.a })).toEqual({ refused: "42501" });
    expect(await save("unitSteward", "steward", { chapter: f.a })).toEqual({ refused: "42501" });
    expect(await save("unitSteward", "steward", { chapter: null })).toEqual({ refused: "42501" });
    const steward = await list("unitSteward", "steward");
    expect(steward.manageScope).toBeNull();
    expect(Object.values(steward.byId).some((action) => action.viewerCanEdit)).toBe(false);
    expect(Object.values(steward.byId).some((action) => action.status === "draft")).toBe(false);
  });

  it("shows a chapter President its chapter's drafts and edit controls only", async () => {
    const draft = (await save("vpA", "vp", { chapter: f.a, title: "Chapter A second draft", status: "draft" })).value.id;
    const page = await list("vpA", "vp");
    expect(page.manageScope).toBe("chapter");
    expect(page.manageChapterId).toBe(f.a);
    expect(page.byId[draft].viewerCanEdit).toBe(true);
    expect(page.byId[f.aAction].viewerCanEdit).toBe(true);
    expect(page.byId[f.orgWide].viewerCanEdit).toBe(false);
    expect(page.byId[f.bAction]).toBeUndefined();
    expect(page.byId[f.bDraft]).toBeUndefined();
    expect(page.totalCount).toBe(page.actions.length);
  });

  it("keeps an organization manager's view: every action, every draft, every edit", async () => {
    const page = await list("orgVp", "vp");
    expect(page.manageScope).toBe("organization");
    expect(page.manageChapterId).toBeNull();
    for (const id of [f.orgWide, f.aAction, f.aClosed, f.bAction, f.bDraft]) expect(page.byId[id]?.viewerCanEdit).toBe(true);
    expect((await save("orgVp", "vp", { id: f.aAction, chapter: f.a, title: "Chapter A petition" })).refused).toBeUndefined();
  });

  it("lets a member of another chapter neither read nor join a chapter-tagged action", async () => {
    const b = await list("memberB", "member");
    expect(b.manageScope).toBeNull();
    expect(b.byId[f.aAction]).toBeUndefined();
    expect(b.byId[f.bAction]).toBeDefined();
    expect(b.byId[f.bDraft]).toBeUndefined();
    expect(await toggle("memberB", f.aAction, true)).toEqual({ refused: "P0002" });
    const a = await list("memberA", "member");
    expect(a.byId[f.aAction]).toBeDefined();
    expect(a.byId[f.bAction]).toBeUndefined();
    expect((await toggle("memberA", f.aAction, true)).value.joined).toBe(true);
  });

  it("tells each caller whether it may join, by the rule the join uses", async () => {
    // An organization manager whose selected chapter is B sees chapter A's
    // action but is told it may not join it, and the join agrees.
    const manager = await list("orgVp", "vp");
    expect(manager.byId[f.aAction].viewerCanJoin).toBe(false);
    expect(manager.byId[f.bAction].viewerCanJoin).toBe(true);
    expect(manager.byId[f.orgWide].viewerCanJoin).toBe(true);
    expect(await toggle("orgVp", f.aAction, true)).toEqual({ refused: "P0002" });
    expect((await list("memberA", "member")).byId[f.aAction].viewerCanJoin).toBe(true);
    expect((await list("vpA", "vp")).byId[f.aAction].viewerCanJoin).toBe(true);
    expect((await list("memberB", "member")).byId[f.orgWide].viewerCanJoin).toBe(true);
  });

  it("answers a withdraw from a hidden chapter action like an unknown id, with no count", async () => {
    // memberB holds no participation in chapter A's action: no count, no status.
    expect(await toggle("memberB", f.aAction, false)).toEqual({ refused: "P0002" });
    expect(await toggle("orgVp", f.aAction, false)).toEqual({ refused: "P0002" });
    // A no-op withdraw on an action the caller may join is unchanged.
    for (const id of [f.bAction, f.orgWide]) {
      const { value } = await toggle("memberB", id, false);
      expect(value).toMatchObject({ actionId: id, joined: false });
      expect(Object.keys(value)).toContain("participantCount");
    }
  });

  it("names only the hats that really manage actions here", async () => {
    expect((await list("vpA", "vp")).authoringHats).toEqual(["vp"]);
    expect((await list("vpA", "member")).authoringHats).toEqual(["vp"]);
    expect((await list("coordA", "member")).authoringHats).toEqual(["coordinator"]);
    expect((await list("orgVp", "member")).authoringHats).toEqual(["vp"]);
    expect((await list("unitSteward", "member")).authoringHats).toEqual([]);
    expect((await list("memberA", "member")).authoringHats).toEqual([]);
  });

  it("leaves an organization-wide action unchanged for everyone", async () => {
    for (const [name, hat] of [["memberA", "member"], ["memberB", "member"], ["unitSteward", "steward"], ["vpA", "vp"], ["orgVp", "vp"]]) {
      expect((await list(name, hat)).byId[f.orgWide]?.status).toBe("published");
    }
    for (const name of ["memberA", "memberB", "unitSteward", "vpB"]) {
      expect((await toggle(name, f.orgWide, true)).value.joined).toBe(true);
      expect((await toggle(name, f.orgWide, false)).value.joined).toBe(false);
    }
  });

  it("lets a member who already joined from outside the chapter see the participation and withdraw it", async () => {
    // A signature written before this change, when any member could join.
    await owner();
    await db.query("insert into public.digital_action_participants(organization_id,action_id,user_id,participation_kind) values($1,$2,$3,'signature')", [f.org, f.aAction, f.people.memberB.id]);
    expect((await list("memberB", "member")).byId[f.aAction]?.viewerParticipation).toBe("signature");
    expect((await toggle("memberB", f.aAction, false)).value.joined).toBe(false);
    expect((await list("memberB", "member")).byId[f.aAction]).toBeUndefined();
    expect(await toggle("memberB", f.aAction, true)).toEqual({ refused: "P0002" });

    // A member of both chapters joins while chapter A is selected, then selects B.
    expect((await toggle("multi", f.aAction, true)).value.joined).toBe(true);
    await owner();
    await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [f.people.multi.id, f.b]);
    expect((await list("multi", "member")).byId[f.aAction]?.viewerParticipation).toBe("signature");
    expect((await toggle("multi", f.aAction, false)).value.joined).toBe(false);
    expect((await list("multi", "member")).byId[f.aAction]).toBeUndefined();
  });
});
