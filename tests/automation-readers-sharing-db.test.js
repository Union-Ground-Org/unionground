// @vitest-environment node
// #9307 Part B / a review note. No producer change or simulated authorization.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl, PROOF_FILES } from "../scripts/run-required-db-proofs.mjs";
import { callSql, compareWorlds, judge, observe, readList } from "../scripts/lib/non-interference.mjs";
import { AUTOMATION_READERS, DEFINITION_FIELDS, ROUTING_FIELDS, seedAutomationSharing } from "./helpers/automation-reader-sharing.mjs";
import { migrateLegacyStewardFixtures } from "./helpers/steward-unit-fixtures.js";

const ROOT = new URL("../config/non-interference/", import.meta.url);
const shard = JSON.parse(readFileSync(new URL("probes.d/9307-automation-readers.json", ROOT), "utf8"));
const contracts = readList(new URL("shared.json", ROOT));
const signature = (name, args) => `${name}(${args})`;
const compareAnswers = (key, name, { withNeighbour, base, control }) => {
  const world = (answer) => new Map([[key, observe({ value: [{ [name]: answer[name] }] })]]);
  return compareWorlds({ withNeighbour: world(withNeighbour), base: world(base), control: world(control) });
};

describe("automation sharing contract (offline)", () => {
  it("loads exactly three reviewed probes through the landed shard reader", () => {
    expect(Object.keys(shard.functions)).toEqual(AUTOMATION_READERS.map(([name, args]) => signature(name, args)));
    const merged = readList(new URL("probes.json", ROOT)).functions;
    for (const [sig, probe] of Object.entries(shard.functions)) expect(merged[sig]).toEqual(probe);
    expect(shard.functions[signature(...AUTOMATION_READERS[0])].arguments).toEqual({ p_page: 1, p_page_size: 50, p_search: "C334 shared", p_status: null });
    expect(PROOF_FILES).toContain("tests/automation-readers-sharing-db.test.js");
  });

  it("never permits an organization neighbour, extra person column or draft-only field through a sharing pin", () => {
    for (const [name, args] of AUTOMATION_READERS) {
      const entry = contracts.functions[name];
      expect(entry.pairs).toEqual(["chapter", "unit"]);
      expect(entry.reason.trim()).not.toBe("");
      const pin = entry.differences.find(({ pair }) => pair === "unit");
      const denied = [["org", pin.fields], ["unit", [...pin.fields, `$[].${name}.ordinaryMemberId`].sort()]];
      if (name !== "mi1_get_automation_routing_rules") {
        const collection = name === "mi1_get_automation_definitions" ? "rows" : "definitions";
        denied.push(["unit", [...pin.fields, `$[].${name}.${collection}[].conditions.priority`].sort()]);
      }
      for (const [pair, fields] of denied) {
        const key = `${pair}|unitSteward|function:${signature(name, args)}|${pin.variants[0]}`;
        const diff = { key, pair, persona: "unitSteward", kind: "function", name, signature: signature(name, args), variant: pin.variants[0], fields };
        const verdict = judge({ compared: { diffs: [diff], unstable: [], inconclusive: [], truncated: [], notProven: [] },
          unreached: {}, shared: { functions: { [name]: entry }, tables: {} }, expected: { records: {} }, unreachable: { functions: {} } });
        expect(verdict.unexpected).toEqual([diff]);
      }
    }
  });

  it("compares all three neighbour worlds and rejects an unstable repeated control offline", () => {
    const name = "mi1_get_automation_routing_rules";
    const base = { [name]: { rules: [{ id: "own-rule" }] } };
    const changed = { [name]: { rules: [{ id: "own-rule" }, { id: "neighbour-rule" }] } };
    for (const pair of ["org", "chapter", "unit"]) {
      const key = `${pair}|unitSteward|function:${signature(name, "")}|min`;
      const compared = compareAnswers(key, name, { withNeighbour: pair === "org" ? base : changed, base, control: base });
      expect(compared.unstable).toEqual([]);
      expect(compared.inconclusive).toEqual([]);
      expect(compared.truncated).toEqual([]);
      if (pair === "org") expect(compared.diffs).toEqual([]);
      else {
        expect(compared.diffs).toHaveLength(1);
        expect(compared.diffs[0]).toMatchObject({ key, pair, name, fields: [`$[].${name}.rules[].id`] });
      }
      const unstable = compareAnswers(key, name, { withNeighbour: changed, base, control: changed });
      expect(unstable.unstable).toHaveLength(1);
      expect(unstable.unstable[0]).toMatchObject({ key, pair, name });
      expect(unstable.diffs).toEqual([]);
    }
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
live("automation sharing with discriminating organization/chapter/unit neighbours", () => {
  let db;
  let own;
  const f = { org: randomUUID(), foreignOrg: randomUUID(), unit: randomUUID(), otherUnit: randomUUID(), people: {} };
  f.chapter = `auto-sharing-${f.org}`;
  f.second = `auto-sharing-second-${f.org}`;
  f.foreign = `auto-sharing-${f.foreignOrg}`;
  const owner = async () => { await db.query("reset role"); await db.query("select set_config('request.jwt.claims','',true)"); };
  const as = async (key) => {
    await owner();
    const person = f.people[key];
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: person.id, session_id: person.session, role: "authenticated", aal: "aal2" })]);
    await db.query("set local role authenticated");
  };
  const read = async (key) => {
    await as(key);
    const result = {};
    for (const [name, args] of AUTOMATION_READERS) {
      const fn = { name, sig: args, nargs: args ? 4 : 0, ndefaults: args ? 4 : 0,
        argnames: args ? ["p_page", "p_page_size", "p_search", "p_status"] : [], argtypes: args ? ["integer", "integer", "text", "text"] : [] };
      result[name] = (await db.query(callSql(fn, args ? "own" : "min", {}, {}, { probe: shard.functions[signature(name, args)] }))).rows[0].v[0][name];
    }
    await owner();
    return result;
  };
  const definitions = (answers) => answers.mi1_get_automation_definitions.rows;
  const assertNoOrdinary = (answers) => {
    const text = JSON.stringify(answers);
    expect(text).not.toContain(f.people.ordinary.id);
    expect(text).not.toContain("Fictional ordinary private name");
  };

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "automation-sharing-rollback-proof" });
    await db.connect(); await db.query("begin"); await db.query("set local statement_timeout='60s'");
    await db.query("insert into public.organizations(id,slug,name) values($1::uuid,$1::text,'Fictional Quarry'),($2::uuid,$2::text,'Fictional Ridge')", [f.org, f.foreignOrg]);
    for (const [chapter, org] of [[f.chapter, f.org], [f.second, f.org], [f.foreign, f.foreignOrg]])
      await db.query("insert into public.chapters(id,name,slug,organization_id,order_index) values($1,$1,$1,$2,9990)", [chapter, org]);
    for (const [key, chapter, org, role] of [["admin", f.chapter, f.org, "admin"], ["author", f.chapter, f.org, "steward"],
      ["ownTarget", f.chapter, f.org, "coordinator"], ["unitTarget", f.chapter, f.org, "steward"],
      ["chapterTarget", f.second, f.org, "steward"], ["foreignAdmin", f.foreign, f.foreignOrg, "admin"],
      ["foreignTarget", f.foreign, f.foreignOrg, "steward"], ["ordinary", f.chapter, f.org, null]]) {
      const id = randomUUID(), session = randomUUID(); f.people[key] = { id, session };
      await db.query("insert into auth.users(id,email) values($1,$2)", [id, `${id}@example.invalid`]);
      await db.query("update public.member_profiles set chapter_id=$2,full_name=$3 where id=$1", [id, chapter, key === "ordinary" ? "Fictional ordinary private name" : `Fictional ${key}`]);
      await db.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values($1,$2,'aal2',now(),now())", [session, id]);
      await db.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [org, id]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [id, chapter]);
      if (role === "admin") await db.query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,'admin')", [org, id]);
      else if (role) {
        await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,$2,$3)", [id, role, chapter]);
        await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,$2,$3)", [id, role, chapter]);
      }
    }
    await db.query("insert into private.chapter_units(id,organization_id,chapter_id,name) values($1,$3,$4,'Shop A'),($2,$3,$4,'Shop B')", [f.unit, f.otherUnit, f.org, f.chapter]);
    await migrateLegacyStewardFixtures(db);
    await as("admin");
    for (const [key, unit] of [["author", f.unit], ["ordinary", f.unit], ["unitTarget", f.otherUnit]])
      await db.query("select public.set_chapter_access_member($1,$2,$3,null,true)", [f.chapter, f.people[key].id, unit]);
    await db.query("select public.set_member_access_role($1,$2,'steward',true,$3,null)", [f.people.author.id, f.chapter, f.unit]);
    await owner();
    own = await seedAutomationSharing(db, { org: f.org, chapter: f.chapter, staff: f.people.ownTarget.id, label: "own" });
  }, 120_000);
  afterAll(async () => { if (db) { try { await db.query("rollback"); } finally { await db.end(); } } });

  it.each(["org", "chapter", "unit"])("pins %s neighbour differences, rejects forbidden rows and compares repeated controls strictly", async (pair) => {
    const base = await read("author");
    expect(definitions(base).map(({ id }) => id).sort()).toEqual([own.global, own.chapter].sort());
    assertNoOrdinary(base);
    const spec = pair === "org" ? { org: f.foreignOrg, chapter: f.foreign, staff: f.people.foreignTarget.id }
      : { org: f.org, chapter: pair === "chapter" ? f.second : f.chapter, staff: f.people[pair === "chapter" ? "chapterTarget" : "unitTarget"].id };
    await db.query("savepoint sharing_neighbour");
    let withNeighbour, ids;
    try {
      ids = await seedAutomationSharing(db, { ...spec, label: `neighbour ${pair}` });
      withNeighbour = await read("author");
      assertNoOrdinary(withNeighbour);
      const visible = definitions(withNeighbour);
      expect(visible.some(({ id }) => id === ids.global)).toBe(pair !== "org");
      expect(visible.some(({ id }) => id === ids.chapter)).toBe(pair === "unit");
      expect(visible.some(({ id }) => id === ids.draft)).toBe(false);
      const rules = withNeighbour.mi1_get_automation_routing_rules.rules;
      expect(rules.some(({ id }) => id === ids.rule)).toBe(pair !== "org");
      for (const definition of visible) expect(Object.keys(definition).sort()).toEqual([...DEFINITION_FIELDS].sort());
      for (const rule of rules) expect(Object.keys(rule).sort()).toEqual([...ROUTING_FIELDS].sort());
      if (pair !== "org") expect(visible.find(({ id }) => id === ids.global).actionConfig).toEqual({ assigneeId: spec.staff });
      if (pair === "unit") expect(visible.find(({ id }) => id === ids.chapter).actionConfig).toEqual({ recipientId: spec.staff });
      const admin = await read("admin");
      if (pair !== "org") expect(definitions(admin).find(({ id }) => id === ids.draft)?.conditions)
        .toEqual({ chapterId: spec.chapter, priority: "low" });
      else expect(JSON.stringify(admin)).not.toContain(ids.global);
    } finally {
      await owner(); await db.query("rollback to savepoint sharing_neighbour"); await db.query("release savepoint sharing_neighbour");
    }
    const control = await read("author");
    expect(control).toEqual(base);
    for (const [name, args] of AUTOMATION_READERS) {
      const variant = args ? "own" : "min";
      const key = `${pair}|unitSteward|function:${signature(name, args)}|${variant}`;
      const compared = compareAnswers(key, name, { withNeighbour, base, control });
      expect(compared.unstable).toEqual([]);
      expect(compared.inconclusive).toEqual([]);
      expect(compared.truncated).toEqual([]);
      if (pair === "org") expect(compared.diffs).toEqual([]);
      else {
        expect(compared.diffs).toHaveLength(1);
        // The same pinned fields apply to the full sweep's chapter authors;
        // only its persona label differs from this focused unit-steward caller.
        const pin = contracts.functions[name].differences.find((entry) => entry.pair === pair);
        expect(compared.diffs[0].fields).toEqual(pin.fields);
      }
    }
  });

  it.each(["assigneeId", "recipientId"])("the real validator refuses an ordinary member as %s", async (field) => {
    await db.query("savepoint ordinary_target");
    await as("admin");
    const spec = { schemaVersion: 2, name: "C334 ordinary target refused", triggerKind: "overdue_task", thresholdDays: 1,
      taskPriority: "medium", cadence: "daily", conditions: { chapterId: f.chapter },
      actionKind: field === "assigneeId" ? "assign_task" : "notify_in_app", actionConfig: { [field]: f.people.ordinary.id } };
    await expect(db.query("select public.mi1_save_automation_definition_v2($1::jsonb)", [JSON.stringify(spec)]))
      .rejects.toMatchObject({ code: "42501", message: "recipient unavailable" });
    await db.query("rollback to savepoint ordinary_target"); await owner(); await db.query("release savepoint ordinary_target");
  });

  it("keeps run summaries own-initiated for authors and organization-wide for approvers", async () => {
    await db.query("savepoint sharing_runs");
    try {
      const runs = [];
      for (const key of ["author", "ownTarget"]) {
        const id = randomUUID(); runs.push(id);
        await db.query("insert into public.organization_automation_runs(id,organization_id,definition_id,definition_version,mode,status,initiated_by) values($1,$2,$3,1,'preview','previewed',$4)", [id, f.org, own.global, f.people[key].id]);
      }
      expect((await read("author")).mi1_get_automation_workspace.runs.map(({ id }) => id)).toEqual([runs[0]]);
      expect((await read("admin")).mi1_get_automation_workspace.runs.map(({ id }) => id).sort()).toEqual([...runs].sort());
    } finally {
      await owner(); await db.query("rollback to savepoint sharing_runs"); await db.query("release savepoint sharing_runs");
    }
  });

  it.each(AUTOMATION_READERS)("refuses the ordinary member %s", async (name, args) => {
    await db.query("savepoint ordinary_reader");
    await as("ordinary");
    const sql = args ? `select public.${name}(1,50,'C334 shared',null)` : `select public.${name}()`;
    await expect(db.query(sql)).rejects.toMatchObject({ code: "42501" });
    await db.query("rollback to savepoint ordinary_reader"); await owner(); await db.query("release savepoint ordinary_reader");
  });
});
