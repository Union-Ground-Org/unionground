// @vitest-environment node
//
// SEC-UG-DIGITAL-ACTION-EDIT-NO-OBJECT-LEVEL-CHECK-20260920
// public.save_digital_action used to accept an update of any action in the
// organization from any manager hat. This proof executes the writer and the
// reader on a disposable catalog: the author and an organization officer hat
// may update, another steward or coordinator is refused and the row is left
// unchanged, and get_collective_actions reports viewerCanEdit under the same
// rule.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";

const repairSql = stripComments(loadMigrationSql("digital_action_edit_object_level_check")).replace(/\s+/g, " ");

describe("digital action edit object-level check (offline pins)", () => {
  it("binds updates to the author or an organization officer hat and keeps the case-graph prologue", () => {
    expect(repairSql).toContain("if p_selected_hat not in ('advisor', 'admin', 'vp') and existing_creator is distinct from caller then raise exception 'not authorized' using errcode = '42501';");
    expect(repairSql).toContain("'viewerCanEdit', manager and (organization_editor or a.created_by = caller)");
    expect(repairSql).toContain("as $function$ begin perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]); declare");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("save_digital_action object-level rule over a disposable database", () => {
  let client;
  const world = {};

  async function actor(label, role) {
    const id = randomUUID();
    const session = randomUUID();
    await client.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}-${label}@example.invalid`]);
    await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [session, id]);
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [id, world.chapter]);
    await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing", [id, world.chapter]);
    await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing", [world.org, id]);
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [world.org, id, role]);
    await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
    return { id, session, hat: role };
  }

  async function become(person) {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({
      sub: person.id,
      role: "authenticated",
      aal: "aal2",
      session_id: person.session,
    })]);
    await client.query("set local role authenticated");
  }

  async function save(person, id, title) {
    await become(person);
    const { rows } = await client.query(
      "select public.save_digital_action($1,$2,null,'petition',$3,'Proof action summary','published',100,null,null) as saved",
      [person.hat, id, title],
    );
    return rows[0].saved;
  }

  async function titleOf(id) {
    await client.query("reset role");
    return (await client.query("select title from public.digital_actions where id=$1", [id])).rows[0].title;
  }

  async function canEdit(person, id) {
    await become(person);
    const { rows } = await client.query("select public.get_collective_actions($1,100,0) as page", [person.hat]);
    return rows[0].page.actions.find((action) => action.id === id)?.viewerCanEdit;
  }

  async function refused(person, id, title) {
    await client.query("savepoint refused");
    try {
      await save(person, id, title);
      throw new Error("save_digital_action accepted a write it must refuse");
    } catch (error) {
      expect(error.code).toBe("42501");
    } finally {
      await client.query("rollback to savepoint refused");
    }
  }

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      application_name: "digital-action-edit-object-level-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '30s'");
    await client.query("set local lock_timeout = '15s'");

    world.org = randomUUID();
    world.chapter = `da-${world.org.slice(0, 8)}`;
    await client.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [world.org, world.chapter]);
    await client.query("insert into public.chapters(id,name,slug,region,organization_id,order_index) values ($1,$1,$1,'proof',$2,97432)", [world.chapter, world.org]);
    world.author = await actor("author", "steward");
    world.otherSteward = await actor("steward", "steward");
    world.coordinator = await actor("coordinator", "coordinator");
    world.admin = await actor("admin", "admin");

    world.action = (await save(world.author, null, "Author petition")).id;
  });

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end();
  });

  it("refuses an update from a manager hat that did not create the action and leaves the row unchanged", async () => {
    await refused(world.otherSteward, world.action, "Hijacked by another steward");
    await refused(world.coordinator, world.action, "Hijacked by a coordinator");
    expect(await titleOf(world.action)).toBe("Author petition");
  });

  it("lets the author and an organization officer hat update", async () => {
    await save(world.author, world.action, "Author petition revised");
    expect(await titleOf(world.action)).toBe("Author petition revised");
    await save(world.admin, world.action, "Admin petition revised");
    expect(await titleOf(world.action)).toBe("Admin petition revised");
  });

  it("reports viewerCanEdit under the same rule", async () => {
    expect(await canEdit(world.author, world.action)).toBe(true);
    expect(await canEdit(world.admin, world.action)).toBe(true);
    expect(await canEdit(world.otherSteward, world.action)).toBe(false);
    expect(await canEdit(world.coordinator, world.action)).toBe(false);
  });
});
