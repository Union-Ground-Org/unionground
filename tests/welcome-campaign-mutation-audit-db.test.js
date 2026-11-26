// @vitest-environment node
//
// SEC-UG-WELCOME-CAMPAIGN-MUTATION-AUDIT-20260921.
//
// save_welcome_campaign_step, enroll_member_in_welcome_campaign and
// transition_member_welcome_enrollment are Admin-only writes over membership
// lifecycle and member-facing message content, yet they stored only an
// idempotency receipt. 20260925550500_welcome_campaign_mutation_audit re-emits
// them so each admitted mutation appends one operation-specific
// organization_audit_events row naming the session actor, with bounded
// identifiers and states and never the step subject/body or member text.
//
// The static half pins the replacement shape: the reviewed wrapped
// predecessors, the case-graph gate kept first, the admitted event types and
// the live source digests. The live half runs inside one rolled-back
// transaction on the owned disposable stack and proves one admitted row per
// mutation, none on an idempotent replay, and no message or profile text.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseFunctions } from "../scripts/account-case-graph-inventory.mjs";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";

const NAME = "20260925550500_welcome_campaign_mutation_audit";
const sql = loadMigrationSql(NAME);
const code = stripComments(sql);
const originalSql = loadMigrationSql("20260830160000_member_operations_completion");
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

const STEP = "public.save_welcome_campaign_step";
const ENROLL = "public.enroll_member_in_welcome_campaign";
const TRANSITION = "public.transition_member_welcome_enrollment";
const EVENTS = {
  [STEP]: "welcome_campaign_step_saved",
  [ENROLL]: "welcome_member_enrolled",
  [TRANSITION]: "welcome_enrollment_transitioned",
};
const PREDECESSORS = {
  [STEP]: ["67416ddae3daba7f068b5ae64174517b23f525ac9f12449c7b5f36907ba1c72e", "07270fc03f325c61f20df1d9e32646a7c39e52c7a677c704042fe54f9d0c689f"],
  [ENROLL]: ["b13e06e9776180449c36882da46b1ead439826f188e3e6d9551485f0afe4dd56", "fb4f97cd3a61862431682996f823e736d0dce769168015a25f0c113259d8e9cd"],
  [TRANSITION]: ["a494e0e32e4d71e580d346348299d680f64b49896d2b7a4ac2470e8313e3d9ab", "259c4adea7b2c210dbc19cff00e4660d4c5709ba5dc2a3244f0852e98fdc921d"],
};
const REPLACEMENTS = {
  [STEP]: "6c0e10bbe3376e5855e2f365f21f503a701d09caf5120168027839e2841e90e1",
  [ENROLL]: "771c46a5075208484e41f0486323f8ff65ec52131a98a54fa8ec01400e4e9da5",
  [TRANSITION]: "a71f6d29e09ff2de93924091f8c5583bbc0daff9e03fbdf6696f45680d63652b",
};

function wrap(source) {
  const rtrimmed = source.replace(/[\n\r\t ]+$/, "");
  const semi = rtrimmed.endsWith(";") ? "" : ";";
  return `\nbegin\n  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);\n${rtrimmed}${semi}\nend;\n`;
}

function parsed(name, source, file) {
  const fn = parseFunctions(source, file).find((entry) => entry.name === name);
  expect(fn, `missing ${name} in ${file}`).toBeTruthy();
  return fn;
}

function eventTypes(source) {
  const definitions = [...source.matchAll(
    /add constraint organization_audit_events_event_type_check check \(event_type in \(([\s\S]*?)\)\)/g,
  )];
  expect(definitions.length).toBeGreaterThan(0);
  return [...definitions.at(-1)[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

function auditPayload(body) {
  const match = body.match(/private\.mi1_w2_write_audit\(org, '(\w+)', pg_catalog\.jsonb_build_object\(([\s\S]*?)\)\);/);
  expect(match, "missing audit append").toBeTruthy();
  // jsonb_build_object alternates key, value; no argument here nests a comma.
  const args = match[2].split(",").map((arg) => arg.trim());
  return { event: match[1], keys: args.filter((_, index) => index % 2 === 0).map((key) => key.replace(/^'|'$/g, "")) };
}

describe("welcome campaign mutation audit migration", () => {
  it("is the last definition of all three RPCs and runs as one transaction", () => {
    for (const name of Object.keys(EVENTS)) {
      const last = [...migrationFiles()].reverse().find(({ sql: text }) => (
        stripComments(text).toLowerCase().includes(`function ${name}(`)
      ));
      expect(last.name).toBe(`${NAME}.sql`);
    }
    expect(code).toMatch(/^\s*begin;/);
    expect(code).toMatch(/commit;\s*$/);
    expect(NAME > "20260907151000_account_deletion_finalization_reconciliation").toBe(true);
  });

  it("admits only the 20260907151000-wrapped originals as predecessors", () => {
    for (const [name, [original, wrapped]] of Object.entries(PREDECESSORS)) {
      const fn = parsed(name, originalSql, "20260830160000.sql");
      expect(fn.sourceSha256).toBe(original);
      expect(createHash("sha256").update(wrap(fn.source)).digest("hex")).toBe(wrapped);
      expect(code.slice(0, code.indexOf("do $ledger$"))).toContain(wrapped);
    }
    expect(code).toContain("raise exception 'unreviewed % predecessor: %'");
  });

  it("keeps the case-graph gate first and pins the replaced source digests", () => {
    const lock = /^\nbegin\n {2}perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);\n\ndeclare\n/;
    for (const [name, digest] of Object.entries(REPLACEMENTS)) {
      const fn = parsed(name, sql, `${NAME}.sql`);
      expect(fn.source).toMatch(lock);
      expect(fn.sourceSha256).toBe(digest);
      expect(code.slice(code.indexOf("do $ledger$"))).toContain(digest);
    }
  });

  it("appends one operation-specific event after the replay return, with bounded identifiers only", () => {
    for (const [name, event] of Object.entries(EVENTS)) {
      const body = stripComments(fnBody(sql, name));
      const payload = auditPayload(body);
      expect(payload.event).toBe(event);
      expect(body.match(/private\.mi1_w2_write_audit/g)).toHaveLength(1);
      expect(body.indexOf("if prior is not null then return prior; end if;"))
        .toBeLessThan(body.indexOf("private.mi1_w2_write_audit"));
      expect(body.indexOf("private.mi1_w2_write_audit"))
        .toBeLessThan(body.indexOf("private.member_operations_store_receipt"));
      expect(payload.keys.slice(0, 2)).toEqual(["organizationId", "campaignId"]);
      for (const forbidden of ["subject", "body", "userId", "memberUserId", "locale", "fullName", "email"]) {
        expect(payload.keys).not.toContain(forbidden);
      }
    }
    expect(auditPayload(stripComments(fnBody(sql, TRANSITION))).keys)
      .toEqual(["organizationId", "campaignId", "entityType", "entityId", "fromStatus", "toStatus"]);
  });

  it("admits the three event types without rewriting metadata keys", () => {
    expect(code).not.toContain("organization_audit_events_metadata_keys");
    // The previous emitter in apply order: Main's newest vocabulary, which
    // this list must keep in order before appending the new tokens. The only
    // other token it may carry is 20260925550000's discard event, which a
    // sibling lane admits in the same reserved range.
    const previous = [...migrationFiles()]
      .filter(({ name }) => name < `${NAME}.sql`)
      .reverse()
      .find(({ sql: text }) => text.includes("add constraint organization_audit_events_event_type_check"));
    const before = eventTypes(previous.sql);
    const after = eventTypes(sql);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.slice(-3)).toEqual(Object.values(EVENTS));
    expect(after.slice(before.length, -3).every((type) => type === "member_operations_import_discarded")).toBe(true);
    expect(new Set(after).size).toBe(after.length);
    const check = contract.constraints.find((entry) => entry.name === "organization_audit_events_event_type_check");
    expect(check.defContains).toEqual(expect.arrayContaining(Object.values(EVENTS)));
  });

  it("pins each audit append on the live contract entry", () => {
    for (const [name, event] of Object.entries(EVENTS)) {
      const entry = contract.functions.find((candidate) => candidate.sig.startsWith(`${name}(`));
      expect(entry.bodyContains).toEqual(expect.arrayContaining(["private.mi1_w2_write_audit", `'${event}'`]));
    }
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("welcome campaign mutation audit", () => {
  let client;
  let ids;
  const SUBJECT = "Synthetic welcome subject text";
  const BODY = "Synthetic welcome body text";
  const MEMBER_NAME = "Welcome Proof Member";

  const as = async (user, role = "authenticated") => {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims',$1,true)",
      [JSON.stringify({ role, sub: user, session_id: ids.sessions[user], aal: "aal2" })]);
    await client.query(`set local role ${role}`);
  };

  const call = async (statement, params) => (await client.query(statement, params)).rows[0].value;

  const auditRows = async () => {
    await as(ids.admin, "postgres");
    const { rows } = await client.query(
      `select id, actor_user_id, event_type, metadata from public.organization_audit_events
       where organization_id = $1 and event_type like 'welcome_%'`, [ids.org]);
    await as(ids.admin);
    return rows;
  };

  beforeAll(async () => {
    client = new pg.Client({
      connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL),
      ssl: false,
      application_name: "welcome-campaign-mutation-audit-proof",
    });
    await client.connect();
    await client.query("begin");
    await client.query("set local statement_timeout = '60s'");
    await client.query("set local lock_timeout = '15s'");
    const installed = (await client.query(
      "select pg_get_constraintdef(oid) like '%welcome_enrollment_transitioned%' as installed from pg_constraint where conname = 'organization_audit_events_event_type_check'",
    )).rows[0]?.installed;
    if (!installed) throw new Error(`the disposable stack must have ${NAME} applied`);

    ids = Object.fromEntries(["org", "admin", "member", "adminSession", "memberSession"].map((key) => [key, randomUUID()]));
    ids.chapter = `welcome-proof-${ids.org}`;
    ids.sessions = { [ids.admin]: ids.adminSession, [ids.member]: ids.memberSession };
    for (const [user, session] of [[ids.admin, ids.adminSession], [ids.member, ids.memberSession]]) {
      await client.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,'{}')", [user, `${user}@example.invalid`]);
      await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal2')", [session, user]);
      await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values($1,$2,'Synthetic welcome factor','totp','verified',now(),now())", [randomUUID(), user]);
    }
    await client.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)", [ids.org, `welcome-proof-${ids.org}`, ids.admin]);
    await client.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9902)", [ids.chapter, ids.org]);
    await client.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,true)", [ids.org]);
    for (const user of [ids.admin, ids.member]) {
      await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [ids.org, user]);
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user, ids.chapter]);
    }
    await client.query("update public.member_profiles set chapter_id=$2, full_name=$3 where id=$1", [ids.member, ids.chapter, MEMBER_NAME]);
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'admin',$2)", [ids.org, ids.admin]);
    await client.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'admin',$2) on conflict do nothing", [ids.admin, ids.chapter]);
    await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,'admin',$2) on conflict do nothing", [ids.admin, ids.chapter]);
  }, 120_000);

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback").catch(() => {});
    await client.end().catch(() => {});
  });

  it("writes one admitted event per mutation, none on replay, and no message or profile text", async () => {
    await as(ids.admin);
    const campaign = await call(
      "select public.save_welcome_campaign(null,'Welcome proof','active',$1) value", [randomUUID()]);
    // Every row in this transaction shares now(), so each call's rows are the
    // ids it added rather than a created_at ordering.
    const seen = new Set((await auditRows()).map((row) => row.id));
    const added = async () => {
      const rows = (await auditRows()).filter((row) => !seen.has(row.id));
      for (const row of rows) seen.add(row.id);
      return rows;
    };
    const scope = { organizationId: ids.org, campaignId: campaign.id };
    const expectOne = async (eventType, metadata) => {
      const rows = await added();
      expect(rows.map((row) => row.event_type)).toEqual([eventType]);
      expect(rows[0].actor_user_id).toBe(ids.admin);
      expect(rows[0].metadata).toEqual({ ...scope, ...metadata });
      const serialized = JSON.stringify(rows[0]);
      for (const text of [SUBJECT, BODY, MEMBER_NAME, ids.member]) expect(serialized).not.toContain(text);
    };

    const stepKey = randomUUID();
    const step = await call(
      "select public.save_welcome_campaign_step($1,null,0,0,'en',$2,$3,true,$4) value",
      [campaign.id, SUBJECT, BODY, stepKey]);
    await expectOne("welcome_campaign_step_saved", { entityType: "welcome_campaign_step", entityId: step.id, action: "created" });
    // An idempotent replay returns the stored receipt and appends nothing.
    await call("select public.save_welcome_campaign_step($1,null,0,0,'en',$2,$3,true,$4) value",
      [campaign.id, SUBJECT, BODY, stepKey]);
    expect(await added()).toEqual([]);
    await call("select public.save_welcome_campaign_step($1,$2,0,1,'en',$3,$4,true,$5) value",
      [campaign.id, step.id, SUBJECT, BODY, randomUUID()]);
    await expectOne("welcome_campaign_step_saved", { entityType: "welcome_campaign_step", entityId: step.id, action: "updated" });

    const enrollKey = randomUUID();
    const enrollment = await call(
      "select public.enroll_member_in_welcome_campaign($1,$2,$3) value", [campaign.id, ids.member, enrollKey]);
    await expectOne("welcome_member_enrolled", { entityType: "welcome_enrollment", entityId: enrollment.id, status: "active" });
    await call("select public.enroll_member_in_welcome_campaign($1,$2,$3) value", [campaign.id, ids.member, enrollKey]);
    expect(await added()).toEqual([]);

    await call("select public.transition_member_welcome_enrollment($1,'paused',$2) value", [enrollment.id, randomUUID()]);
    await expectOne("welcome_enrollment_transitioned", {
      entityType: "welcome_enrollment", entityId: enrollment.id, fromStatus: "active", toStatus: "paused",
    });
  });
});
