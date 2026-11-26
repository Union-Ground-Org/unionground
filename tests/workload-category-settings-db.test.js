// @vitest-environment node
//
// REQ-UG-WORKLOAD-CATEGORY-LABELS-VISIBILITY-ORDER-20261103 (#6910).
//
// Offline half: what the migration says, and what it leaves alone. Live half
// (disposable loopback only): members of an organization read its workload
// category order and visibility, only its admins replace it, another
// organization never sees it, the private table has no client access, and the
// eight workload category names are organization labels.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { helperFirst, parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { stripComments } from "./helpers/migration.js";
import { WORKLOAD_CATEGORY_KEYS, WORKLOAD_CATEGORY_LABEL_KEYS } from "../src/lib/workloadCategories.js";

const FILE = "20261103131500_workload_category_labels_visibility_order.sql";
const sql = readFileSync(`supabase/migrations/${FILE}`, "utf8");
const code = stripComments(sql);

describe("workload category labels, visibility and order migration (offline)", () => {
  it("is one atomic migration whose writers take the case-graph gate first", () => {
    expect(code.trimStart().startsWith("begin;")).toBe(true);
    expect(code.trimEnd().endsWith("commit;")).toBe(true);
    const functions = parseFunctions(sql);
    for (const name of ["public.update_organization_label", "public.save_organization_workload_categories"]) {
      expect(helperFirst(functions.find((fn) => fn.name === name).source), name).toBe(true);
    }
  });

  it("adds exactly the eight category names to both label allow-lists", () => {
    const quoted = WORKLOAD_CATEGORY_LABEL_KEYS.map((key) => `'${key}'`);
    const constraint = code.slice(code.indexOf("add constraint organization_label_overrides_key"), code.indexOf("create or replace function public.update_organization_label"));
    const writer = parseFunctions(sql).find((fn) => fn.name === "public.update_organization_label").source;
    for (const text of [constraint, writer]) {
      for (const key of quoted) expect(text, key).toContain(key);
      for (const kept of ["'nav.home'", "'vp.title'", "'term.chapter'", "'term.worksites'"]) expect(text).toContain(kept);
      expect(text.match(/'[a-zA-Z]+\.[a-zA-Z_.]+'/g)).toHaveLength(25);
    }
  });

  it("keeps the table private, without grants, under forced RLS and the case-graph triggers", () => {
    const table = "private.organization_workload_categories";
    expect(code).toContain(`create table ${table} (`);
    expect(code).toContain(`alter table ${table} force row level security;`);
    expect(code).toContain(`revoke all on table ${table} from public, anon, authenticated, service_role;`);
    expect(code).toContain(`create policy mfa_assurance on ${table} as restrictive for all to authenticated`);
    expect(code).toContain(`create trigger a00_case_graph_lock before insert or update or delete on ${table}`);
    expect(code).not.toMatch(/grant [a-z, ]+ on (table )?private\./);
    expect(code).not.toMatch(/references auth\.users/);
    for (const key of WORKLOAD_CATEGORY_KEYS) expect(code).toContain(`'${key}'`);
  });

  it("checks two-step sign-in, the selected organization and the admin role", () => {
    const whole = (signature) => {
      const start = code.indexOf(`create function ${signature}`);
      expect(start, signature).toBeGreaterThanOrEqual(0);
      return code.slice(start, code.indexOf("$function$;", start));
    };
    const read = whole("public.get_organization_workload_categories()");
    const save = whole("public.save_organization_workload_categories(");
    for (const text of [read, save]) {
      expect(text).toContain("security definer");
      expect(text).toContain("set search_path = ''");
      expect(text).toContain("not private.mfa_satisfied()");
      expect(text).toContain("org := private.chapter_units_context();");
    }
    expect(save).toContain("not private.has_organization_role(org, array['admin'])");
  });

  it("leaves workload logs and the stats, intelligence, notification and export functions alone", () => {
    expect(code).not.toMatch(/member_workload_logs/);
    expect(code).not.toMatch(/workload_stats|workload_intelligence|workload_stress|export/i);
    const names = parseFunctions(sql).map((fn) => fn.name).sort();
    expect(names).toEqual([
      "private.organization_workload_categories_payload",
      "public.get_organization_workload_categories",
      "public.save_organization_workload_categories",
      "public.update_organization_label",
    ]);
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("workload category settings on a disposable database", () => {
  let c;
  let world;
  beforeAll(async () => {
    c = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "workload-category-settings-proof" });
    await c.connect();
  });
  afterAll(async () => { await c?.end(); });

  async function call(text, values = [], user = null) {
    await c.query("savepoint call");
    try {
      await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(user
        ? { role: "authenticated", sub: user.id, session_id: user.session, aal: "aal2" }
        : { role: "anon" })]);
      await c.query(user ? "set local role authenticated" : "set local role anon");
      const rows = (await c.query(text, values)).rows;
      await c.query("reset role");
      await c.query("release savepoint call");
      return { ok: true, rows };
    } catch (error) {
      await c.query("rollback to savepoint call");
      await c.query("release savepoint call");
      return { ok: false, code: error.code, message: error.message };
    }
  }

  const read = (user) => call("select public.get_organization_workload_categories() as result", [], user);
  const save = (user, categories) => call("select public.save_organization_workload_categories($1::jsonb) as result", [JSON.stringify(categories)], user);
  const layout = (keys, hidden = []) => keys.map((key) => ({ key, visible: !hidden.includes(key) }));
  const reordered = ["aged_cases", "priority", "pending", "unread_docs", "todos", "referrals", "ce_activities", "assistance_requests"];

  beforeEach(async () => {
    await c.query("begin");
    world = {};
    for (const [label, role, orgName] of [["admin", "admin", "orgA"], ["member", "member", "orgA"], ["steward", "steward", "orgA"], ["other", "admin", "orgB"]]) {
      if (!world[orgName]) {
        world[orgName] = { id: randomUUID(), chapter: `workload-cat-${orgName.toLowerCase()}-${randomUUID().slice(0, 8)}` };
        await c.query("insert into public.organizations(id,slug,name) values ($1,$2,$2)", [world[orgName].id, world[orgName].chapter]);
        await c.query("insert into public.chapters(id,name,slug,organization_id,order_index) values ($1,$1,$1,$2,98312)", [world[orgName].chapter, world[orgName].id]);
      }
      const user = { id: randomUUID(), session: randomUUID(), org: world[orgName] };
      world[label] = user;
      await c.query("insert into auth.users(id,email) values ($1,$2)", [user.id, `${user.id}@example.invalid`]);
      await c.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [user.org.id, user.id]);
      await c.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [user.id, user.org.chapter]);
      await c.query("update public.member_profiles set chapter_id=$2 where id=$1", [user.id, user.org.chapter]);
      if (role !== "member") {
        await c.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values ($1,$2,$3,$2)", [user.org.id, user.id, role]);
        await c.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,$2,$3) on conflict do nothing", [user.id, role, user.org.chapter]);
      }
      await c.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), user.id]);
      await c.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())", [user.session, user.id]);
    }
  });
  afterEach(async () => { await c.query("rollback"); });

  it("answers every member with all eight categories shown, in page order, until an admin saves", async () => {
    const member = await read(world.member);
    expect(member).toMatchObject({ ok: true });
    expect(member.rows[0].result).toEqual({ categories: layout(WORKLOAD_CATEGORY_KEYS), canEdit: false, updatedAt: null });
    const admin = await read(world.admin);
    expect(admin.rows[0].result).toMatchObject({ canEdit: true });
    expect(await read(null)).toMatchObject({ ok: false, code: "42501" });
  });

  it("lets an organization admin reorder and hide, and every member of that organization only sees it", async () => {
    const saved = await save(world.admin, layout(reordered, ["todos", "referrals"]));
    expect(saved).toMatchObject({ ok: true });
    expect(saved.rows[0].result.categories).toEqual(layout(reordered, ["todos", "referrals"]));
    for (const user of [world.member, world.steward]) {
      const seen = await read(user);
      expect(seen.rows[0].result.categories).toEqual(layout(reordered, ["todos", "referrals"]));
      expect(seen.rows[0].result.updatedAt).not.toBeNull();
    }
    // Another organization keeps its own default.
    const other = await read(world.other);
    expect(other.rows[0].result.categories).toEqual(layout(WORKLOAD_CATEGORY_KEYS));
    const stored = await c.query("select category_key, visible, sort_order from private.organization_workload_categories where organization_id = $1 order by sort_order", [world.orgA.id]);
    expect(stored.rows.map((row) => row.category_key)).toEqual(reordered);
    expect(stored.rows.filter((row) => !row.visible).map((row) => row.category_key)).toEqual(["todos", "referrals"]);
    const audit = await c.query("select actor_user_id, action, previous_value, new_value from public.organization_configuration_audit where organization_id = $1 and item_key = 'workload.categories'", [world.orgA.id]);
    expect(audit.rows).toEqual([{
      actor_user_id: world.admin.id,
      action: "setting_updated",
      previous_value: WORKLOAD_CATEGORY_KEYS,
      new_value: reordered.filter((key) => !["todos", "referrals"].includes(key)),
    }]);
  });

  it("refuses a member, a steward and an anonymous caller", async () => {
    for (const user of [world.member, world.steward, null]) {
      expect(await save(user, layout(reordered)), user?.id ?? "anon").toMatchObject({ ok: false, code: "42501" });
    }
    const stored = await c.query("select count(*)::int as n from private.organization_workload_categories where organization_id = $1", [world.orgA.id]);
    expect(stored.rows[0].n).toBe(0);
  });

  it("refuses a list that is not all eight categories once each, or that hides every one", async () => {
    for (const bad of [
      layout(WORKLOAD_CATEGORY_KEYS.slice(0, 7)),
      [...layout(WORKLOAD_CATEGORY_KEYS.slice(0, 7)), { key: "priority", visible: true }],
      [...layout(WORKLOAD_CATEGORY_KEYS.slice(0, 7)), { key: "overtime", visible: true }],
      [...layout(WORKLOAD_CATEGORY_KEYS.slice(0, 7)), { key: "aged_cases", visible: "yes" }],
      [...layout(WORKLOAD_CATEGORY_KEYS.slice(0, 7)), { key: "aged_cases", visible: true, label: "Old" }],
      [...layout(WORKLOAD_CATEGORY_KEYS.slice(0, 7)), "aged_cases"],
      { categories: layout(WORKLOAD_CATEGORY_KEYS) },
      layout(WORKLOAD_CATEGORY_KEYS, WORKLOAD_CATEGORY_KEYS),
    ]) {
      expect(await save(world.admin, bad), JSON.stringify(bad)).toMatchObject({ ok: false, code: "22023" });
    }
    expect(await call("select public.save_organization_workload_categories(null)", [], world.admin)).toMatchObject({ ok: false, code: "22023" });
  });

  it("gives clients no direct access to the private table", async () => {
    for (const statement of [
      "select * from private.organization_workload_categories",
      `insert into private.organization_workload_categories(organization_id, category_key, visible, sort_order) values ('${world.orgA.id}', 'priority', false, 1)`,
    ]) {
      for (const user of [world.admin, null]) {
        expect(await call(statement, [], user), statement).toMatchObject({ ok: false, code: "42501" });
      }
    }
  });

  it("makes the eight category names organization labels only an admin may set", async () => {
    const named = await call("select public.update_organization_label('workload.cat.priority', '  Hot   files ') as result", [], world.admin);
    expect(named).toMatchObject({ ok: true });
    expect(named.rows[0].result).toEqual({ key: "workload.cat.priority", value: "Hot files", updated: true });
    const config = await call("select public.get_member_organization_configuration() as result", [], world.member);
    expect(config.rows[0].result.labelOverrides).toEqual({ "workload.cat.priority": "Hot files" });
    const other = await call("select public.get_member_organization_configuration() as result", [], world.other);
    expect(other.rows[0].result.labelOverrides).toEqual({});
    expect(await call("select public.update_organization_label('workload.cat.todos', 'Tasks')", [], world.steward)).toMatchObject({ ok: false, code: "42501" });
    expect(await call("select public.update_organization_label('workload.cat.overtime', 'OT')", [], world.admin)).toMatchObject({ ok: false, code: "22023" });
    expect(await call("select public.update_organization_label('workload.cat.todos', '<b>Tasks</b>')", [], world.admin)).toMatchObject({ ok: false, code: "22023" });
    // The existing keys keep working.
    expect(await call("select public.update_organization_label('term.chapter', 'Shop')", [], world.admin)).toMatchObject({ ok: true });
  });
});
