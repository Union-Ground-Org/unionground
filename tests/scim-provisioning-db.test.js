// @vitest-environment node
//
// REQ-UG-SCIM-PROVISIONING-20261001
//
// 20261003041000 adds organization-scoped SCIM tokens, the SCIM directory
// mirror and the provisioning service behind api/scim.js. Provisioning stays
// inside the Invitation-only accounts contract: a new person gets an ordinary
// invitation, a former member a reactivation invitation, an active member is
// only linked, and deprovisioning revokes the organization membership. A
// group grants a starting role only when an organization admin mapped it.
//
// The live cases use two fictional tenants (Example Workers Local 1 and
// Example Transit Local 2). Every refusal has a same-organization control
// that must succeed, so a check that refuses everything cannot pass. Every row
// is rolled back.
//
// Directory sync is held with single sign-on
// (REQ-UG-HOLD-DIRECTORY-SYNC-WITH-SINGLE-SIGN-ON-20261117, #9037): the
// switch is held with no date by hold_scim_directory_sync. Each live case below
// releases it inside its own rolled-back transaction; the held case proves the
// hold itself.
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, loadMigrationSql, stripComments } from "./helpers/migration.js";
import { applyUserPatch, normalizeUser, toUserResource } from "../api/_lib/scim.js";

const MIGRATION = "scim_provisioning_service";
const HOLD = "hold_scim_directory_sync";
const HASH = (pair) => pair.repeat(32);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("SCIM provisioning migration (static)", () => {
  const sql = stripComments(loadMigrationSql(MIGRATION));

  it("ships one atomic migration in the L14 block with the switch off by default", () => {
    expect(findMigrationName(MIGRATION)).toBe("20261003041000_scim_provisioning_service.sql");
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).toMatch(/\('features\.integrations\.scim', 'boolean', 'SCIM directory provisioning',[\s\S]*?'false', null, null, null, 310, 'integrations', false\)/);
    expect(sql).toContain("on conflict (key) do nothing;");
  });

  it("never creates an account and never grants admin or vp", () => {
    expect(sql).not.toMatch(/insert into auth\.users/);
    expect(sql).not.toMatch(/insert into public\.organization_role_grants/);
    expect(sql).not.toMatch(/insert into public\.member_roles/);
    expect(sql).toContain("check (mapped_role is null or mapped_role in ('steward', 'coordinator', 'advisor'))");
  });

  it("gates every service RPC on the service role and grants it to service_role only", () => {
    for (const name of [
      "scim_authenticate(text)", "scim_list_users(uuid, text, text, integer, integer)", "scim_get_user(uuid, uuid)",
      "scim_upsert_user(uuid, uuid, jsonb, text)", "scim_delete_user(uuid, uuid)",
      "scim_list_groups(uuid, text, text, integer, integer, boolean)", "scim_get_group(uuid, uuid)",
      "scim_upsert_group(uuid, uuid, text, text, uuid[])", "scim_delete_group(uuid, uuid)",
      "scim_record_invitation_delivery(uuid, uuid, integer, text)",
    ]) {
      expect(sql).toContain(`grant execute on function public.${name} to service_role;`);
      expect(sql).not.toContain(`grant execute on function public.${name} to authenticated;`);
    }
  });

  it("pins the new surface in the database contract", () => {
    const sig = (value) => contract.functions.find((row) => row.sig === value);
    expect(sig("public.scim_authenticate(p_token_hash text)")).toMatchObject({ exec: "service_role", secdef: true });
    expect(sig("public.issue_scim_token(p_label text, p_token_hash text, p_token_prefix text, p_expires_in_days integer)"))
      .toMatchObject({ exec: "authenticated", secdef: true });
    expect(contract.tableGrants.filter((row) => row.table === "public.scim_users")).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "authenticated", privileges: "" })]),
    );
  });
});

describe("directory sync hold migration (static)", () => {
  const sql = stripComments(loadMigrationSql(HOLD));
  const code = sql.replace(/\s+/g, " ");
  const original = stripComments(loadMigrationSql(MIGRATION));
  const definition = (text) => text.slice(text.indexOf("function public.get_scim_control()"), text.indexOf("$function$;", text.indexOf("function public.get_scim_control()")));

  it("holds only the directory sync switch, with no date, and refuses to finish without it", () => {
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(code).toContain("update public.platform_setting_definitions set release_at = 'infinity' where key = 'features.integrations.scim' and value_kind = 'boolean';");
    expect(code).toMatch(/get diagnostics held = row_count; if held <> 1 then raise exception 'expected to hold directory sync, held %', held using errcode = '55000';/);
    expect(code.match(/release_at = /g)).toHaveLength(1);
    expect(code).not.toContain("organization_setting_values");
  });

  it("re-emits get_scim_control from its last definition with only the hold added", () => {
    const names = [...sql.matchAll(/create or replace function ([\w.]+)\(/g)].map((match) => match[1]);
    expect(names).toEqual(["public.get_scim_control"]);
    const held = "if exists ( select 1 from public.platform_setting_definitions h where h.key = 'features.integrations.scim' and h.release_at > pg_catalog.now() ) then return pg_catalog.jsonb_build_object('organizationId', org, 'released', false); end if; ";
    const now = definition(sql).replace(/\s+/g, " ");
    expect(now).toContain(held);
    expect(now.replace(held, "").replace("'organizationId', org, 'released', true, 'enabled'", "'organizationId', org, 'enabled'"))
      .toBe(definition(original).replace(/\s+/g, " "));
    expect(code).toContain("grant execute on function public.get_scim_control() to authenticated;");
  });

  it("refuses a database whose get_scim_control is not the definition it replaces", () => {
    const raw = loadMigrationSql(MIGRATION);
    const start = raw.indexOf("$function$", raw.indexOf("create function public.get_scim_control()")) + "$function$".length;
    const digest = createHash("md5").update(raw.slice(start, raw.indexOf("$function$", start))).digest("hex");
    expect(sql).toContain(`if (select pg_catalog.md5(p.prosrc) from pg_catalog.pg_proc p where p.oid='public.get_scim_control()'::regprocedure)\n    is distinct from '${digest}' then\n    raise exception 'unreviewed predecessor: public.get_scim_control' using errcode='55000';`);
    expect(sql.indexOf("$preflight$")).toBeLessThan(sql.indexOf("$hold$"));
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("SCIM provisioning on a disposable database", () => {
  let client;

  beforeAll(async () => {
    assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, application_name: "scim-provisioning-rollback-proof" });
    await client.connect();
    await client.query("set statement_timeout = '20s'");
  });

  afterAll(async () => {
    await client?.end();
  });

  // Released inside the caller's transaction unless the case proves the hold.
  async function tenants({ held = false } = {}) {
    if (!held) await client.query("update public.platform_setting_definitions set release_at = null where key = 'features.integrations.scim'");
    const orgA = randomUUID();
    const orgB = randomUUID();
    const chapterA = `ewl1-a-${orgA}`;
    const chapterA2 = `ewl1-b-${orgA}`;
    const chapterB = `etl2-a-${orgB}`;
    await client.query(
      "insert into public.organizations(id,slug,name) values ($1,$2,$3), ($4,$5,$6)",
      [orgA, `ewl1-${orgA}`, `Example Workers Local 1 ${orgA}`, orgB, `etl2-${orgB}`, `Example Transit Local 2 ${orgB}`],
    );
    await client.query(
      `insert into public.chapters(id,name,slug,region,organization_id,order_index)
       values ($1,$1,$1,'proof',$4,9941), ($2,$2,$2,'proof',$4,9942), ($3,$3,$3,'proof',$5,9943)`,
      [chapterA, chapterA2, chapterB, orgA, orgB],
    );
    return { orgA, orgB, chapterA, chapterA2, chapterB };
  }

  async function person({ chapter = null, organization = null, chapterMembership = chapter, email = null } = {}) {
    const id = randomUUID();
    await client.query("insert into auth.users(id,email) values ($1,$2)", [id, email ?? `${id}@example.invalid`]);
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [id, chapter]);
    if (organization) {
      await client.query(
        "insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing",
        [organization, id],
      );
    }
    if (chapterMembership) {
      await client.query(
        "insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing",
        [id, chapterMembership],
      );
    }
    return id;
  }

  async function organizationStaff(org, chapter, role) {
    const id = await person({ chapter, organization: org });
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,$3)", [org, id, role]);
    await client.query(
      "insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())",
      [randomUUID(), id],
    );
    return id;
  }

  async function actAs(userId, aal = "aal2") {
    const session = randomUUID();
    await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,$3,now(),now())", [session, userId, aal]);
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: userId, role: "authenticated", aal, session_id: session }),
    ]);
    await client.query("set local role authenticated");
  }

  async function actAsService() {
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: "service_role" })]);
    await client.query("set local role service_role");
  }

  async function asOwner() {
    await client.query("reset role");
    await client.query("select set_config('request.jwt.claims','',true)");
  }

  async function capture(statement, args) {
    await client.query("savepoint cell");
    try {
      const result = await client.query(statement, args);
      await client.query("release savepoint cell");
      return { ok: true, row: result.rows[0], code: "", message: "" };
    } catch (error) {
      await client.query("rollback to savepoint cell");
      return { ok: false, row: null, code: error.code || "", message: error.message || "" };
    }
  }

  async function switchOn(org, key = "features.integrations.scim", value = "true") {
    await client.query(
      "insert into public.organization_setting_values(organization_id,setting_key,value) values ($1,$2,$3::jsonb) on conflict (organization_id, setting_key) do update set value = excluded.value",
      [org, key, value],
    );
  }

  // An organization with SCIM on, a default chapter and one live token.
  async function provisioned(t, org = t.orgA, chapter = t.chapterA, tokenPair = "aa") {
    const admin = await organizationStaff(org, chapter, "admin");
    await switchOn(org);
    await actAs(admin);
    const saved = await capture("select public.save_scim_settings($1) as v", [chapter]);
    expect(saved.ok, saved.message).toBe(true);
    const issued = await capture("select public.issue_scim_token('Directory',$1,'ug_scim_abcd',90) as v", [HASH(tokenPair)]);
    expect(issued.ok, issued.message).toBe(true);
    await asOwner();
    return admin;
  }

  const upsert = (org, id, user, hash) => capture(
    "select public.scim_upsert_user($1,$2,$3::jsonb,$4) as v", [org, id, JSON.stringify(user), hash],
  );
  const scimUser = (email, extra = {}) => ({ userName: email, givenName: "Ana", familyName: "Example", displayName: "Ana Example", active: true, locale: "en", ...extra });
  const membership = async (org, user) => (await client.query(
    "select status from public.organization_memberships where organization_id=$1 and user_id=$2", [org, user],
  )).rows[0]?.status;

  it("lets only an MFA organization admin configure SCIM, and only while the switch is on", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const admin = await organizationStaff(t.orgA, t.chapterA, "admin");
      const vp = await organizationStaff(t.orgA, t.chapterA, "vp");
      const steward = await organizationStaff(t.orgA, t.chapterA, "steward");

      await actAs(admin);
      const off = await capture("select public.issue_scim_token('Directory',$1,'ug_scim_abcd',90) as v", [HASH("b1")]);
      expect(off.ok).toBe(false);
      expect(off.message).toContain("switched off");
      await asOwner();
      await switchOn(t.orgA);

      await actAs(admin);
      const noChapter = await capture("select public.issue_scim_token('Directory',$1,'ug_scim_abcd',90) as v", [HASH("b1")]);
      expect(noChapter.message).toContain("default chapter");
      const foreignChapter = await capture("select public.save_scim_settings($1) as v", [t.chapterB]);
      expect(foreignChapter.code).toBe("22023");
      const saved = await capture("select public.save_scim_settings($1) as v", [t.chapterA]);
      expect(saved.ok, saved.message).toBe(true);
      const issued = await capture("select public.issue_scim_token('Directory',$1,'ug_scim_abcd',90) as v", [HASH("b1")]);
      expect(issued.ok, issued.message).toBe(true);
      expect(issued.row.v.tokens).toHaveLength(1);
      expect(JSON.stringify(issued.row.v)).not.toContain(HASH("b1"));
      expect(issued.row.v).toMatchObject({ released: true, enabled: true, canManage: true, defaultChapterId: t.chapterA });
      await asOwner();

      await actAs(admin, "aal1");
      expect((await capture("select public.get_scim_control() as v")).code).toBe("42501");
      await asOwner();

      await actAs(vp);
      const vpRead = await capture("select public.get_scim_control() as v");
      expect(vpRead.ok, vpRead.message).toBe(true);
      expect(vpRead.row.v.canManage).toBe(false);
      expect((await capture("select public.issue_scim_token('VP',$1,'ug_scim_abcd',90) as v", [HASH("b2")])).code).toBe("42501");
      await asOwner();

      await actAs(steward);
      expect((await capture("select public.get_scim_control() as v")).code).toBe("42501");
      await asOwner();

      const status = (await client.query(
        "select status, default_settings from public.organization_integrations where organization_id=$1 and provider='scim'", [t.orgA],
      )).rows[0];
      expect(status).toMatchObject({ status: "configured", default_settings: { defaultChapterId: t.chapterA } });
    } finally {
      await client.query("rollback");
    }
  });

  it("holds directory sync with single sign-on: no setup, no token and no provisioning, whatever the stored switch", async () => {
    await client.query("begin");
    try {
      const t = await tenants({ held: true });
      expect((await client.query("select release_at::text as r from public.platform_setting_definitions where key = 'features.integrations.scim'")).rows[0].r).toBe("infinity");
      const admin = await organizationStaff(t.orgA, t.chapterA, "admin");
      await switchOn(t.orgA);
      await client.query("insert into public.scim_tokens(organization_id, token_hash, label, token_prefix, expires_at) values ($1, $2, 'Directory', 'ug_scim_abcd', now() + interval '1 day')", [t.orgA, HASH("c1")]);
      expect((await client.query("select private.organization_feature_enabled($1, 'features.integrations.scim') as on", [t.orgA])).rows[0].on).toBe(false);

      await actAs(admin);
      const read = await capture("select public.get_scim_control() as v");
      expect(read.ok, read.message).toBe(true);
      expect(read.row.v).toEqual({ organizationId: t.orgA, released: false });
      const issued = await capture("select public.issue_scim_token('Directory',$1,'ug_scim_abcd',90) as v", [HASH("c2")]);
      expect(issued.ok).toBe(false);
      expect(issued.message).toContain("switched off");
      await asOwner();
      await actAsService();
      expect((await capture("select public.scim_authenticate($1) as v", [HASH("c1")])).row.v).toEqual({ state: "disabled" });
      await asOwner();

      // The same organization, released: setup, token and provisioning are back.
      await client.query("update public.platform_setting_definitions set release_at = null where key = 'features.integrations.scim'");
      await actAsService();
      expect((await capture("select public.scim_authenticate($1) as v", [HASH("c1")])).row.v).toMatchObject({ state: "ok", organizationId: t.orgA });
      await asOwner();
      await actAs(admin);
      const released = await capture("select public.get_scim_control() as v");
      expect(released.ok, released.message).toBe(true);
      expect(released.row.v).toMatchObject({ organizationId: t.orgA, released: true, enabled: true, canManage: true });
      await asOwner();
    } finally {
      await client.query("rollback");
    }
  });

  it("authenticates a live token only for its organization and stops on revocation, the switch and the rate limit", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const admin = await provisioned(t);
      await actAsService();
      const ok = await capture("select public.scim_authenticate($1) as v", [HASH("aa")]);
      expect(ok.row.v).toMatchObject({ state: "ok", organizationId: t.orgA });
      expect((await capture("select public.scim_authenticate($1) as v", [HASH("ff")])).row.v).toBeNull();
      await asOwner();

      await actAs(admin);
      expect((await capture("select public.scim_authenticate($1) as v", [HASH("aa")])).code).toBe("42501");
      await asOwner();

      await switchOn(t.orgA, "limits.integrations.scim_requests_per_minute", "10");
      await actAsService();
      const states = [];
      for (let index = 0; index < 10; index += 1) {
        states.push((await capture("select public.scim_authenticate($1) as v", [HASH("aa")])).row.v.state);
      }
      expect(states.filter((state) => state === "limited").length).toBeGreaterThan(0);
      await asOwner();

      await switchOn(t.orgA, "features.integrations.scim", "false");
      await actAsService();
      expect((await capture("select public.scim_authenticate($1) as v", [HASH("aa")])).row.v).toEqual({ state: "disabled" });
      await asOwner();
      await switchOn(t.orgA);

      const tokenId = (await client.query("select id from public.scim_tokens where token_hash=$1", [HASH("aa")])).rows[0].id;
      await actAs(admin);
      expect((await capture("select public.revoke_scim_token($1) as v", [tokenId])).ok).toBe(true);
      await asOwner();
      await actAsService();
      expect((await capture("select public.scim_authenticate($1) as v", [HASH("aa")])).row.v).toBeNull();
      await asOwner();
      const status = (await client.query("select status from public.organization_integrations where organization_id=$1 and provider='scim'", [t.orgA])).rows[0];
      expect(status.status).toBe("unset");
    } finally {
      await client.query("rollback");
    }
  });

  it("invites a new person into the default chapter through an ordinary invitation and records delivery", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      await provisioned(t);
      const email = `new-${randomUUID()}@example.invalid`;
      await actAsService();
      const created = await upsert(t.orgA, null, scimUser(email), HASH("c1"));
      expect(created.ok, created.message).toBe(true);
      expect(created.row.v).toMatchObject({ outcome: "created", user: { userName: email, state: "invited" }, invitation: { send: true, email, locale: "en" } });
      const invitationId = created.row.v.invitation.invitationId;
      const duplicate = await upsert(t.orgA, null, scimUser(email), HASH("c2"));
      expect(duplicate.row.v).toEqual({ outcome: "conflict" });
      const recorded = await capture("select public.scim_record_invitation_delivery($1,$2,1,'sent') as v", [t.orgA, invitationId]);
      expect(recorded.row.v).toEqual({ recorded: true });
      const wrongTenant = await capture("select public.scim_record_invitation_delivery($1,$2,1,'sent') as v", [t.orgB, invitationId]);
      expect(wrongTenant.row.v).toEqual({ recorded: false });
      await asOwner();

      const invitation = (await client.query(
        "select kind, status, chapter_id, initial_role, invited_by, token_hash, full_name, sent_at is not null as sent from public.member_invitations where id=$1", [invitationId],
      )).rows[0];
      expect(invitation).toMatchObject({ kind: "provision", status: "pending", chapter_id: t.chapterA, initial_role: null, invited_by: null, token_hash: HASH("c1"), full_name: "Ana Example", sent: true });
      const audit = (await client.query("select action, actor, detail from public.member_invitation_audit where invitation_id=$1 order by created_at", [invitationId])).rows;
      expect(audit.map((row) => row.action)).toEqual(["invite_requested", "invite_sent"]);
      expect(audit.every((row) => row.actor === null && row.detail.source === "scim")).toBe(true);
      expect((await client.query("select count(*)::int as n from auth.users where email=$1", [email])).rows[0].n).toBe(0);
    } finally {
      await client.query("rollback");
    }
  });

  it("enforces case-insensitive group names in creation, replacement, filtering and the unique index", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      await provisioned(t);
      await actAsService();
      const create = (name, id = null) => capture("select public.scim_upsert_group($1,$2,$3,null,array[]::uuid[]) as v", [t.orgA, id, name]);
      const first = await create("Stewards");
      expect(first.row.v.outcome).toBe("created");
      // BUG-UG-SCIM-CONFLICT-LABELS-AND-EMAIL-SELECTOR-TRIM-20261021: a
      // concurrent create cannot race the existence check into the unique
      // index. This transaction holds lock_case_graph's exclusive (509, 700)
      // lock, so a second session's create waits for it.
      const racer = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, application_name: "scim-provisioning-group-race" });
      await racer.connect();
      try {
        await racer.query("begin");
        await racer.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: "service_role" })]);
        await racer.query("set local role service_role");
        await racer.query("set local lock_timeout = '200ms'");
        await expect(racer.query("select public.scim_upsert_group($1,null,'STEWARDS',null,array[]::uuid[]) as v", [t.orgA]))
          .rejects.toMatchObject({ code: "55P03" });
      } finally {
        await racer.query("rollback").catch(() => {});
        await racer.end();
      }
      expect((await create("stewards")).row.v.outcome).toBe("conflict");
      // BUG-UG-SCIM-CONCURRENT-GROUP-PATCH-LOST-MEMBERS-20261020: a PATCH
      // names the version it read; a stale one changes nothing.
      const versioned = (version, name) => capture("select public.scim_upsert_group($1,$2,$3,null,array[]::uuid[],$4) as v", [t.orgA, first.row.v.group.id, name, version]);
      const read = first.row.v.group.version;
      expect((await versioned(read, "Stewards")).row.v).toMatchObject({ outcome: "updated", group: { version: read + 1 } });
      expect((await versioned(read, "Stale stewards")).row.v).toEqual({ outcome: "version_conflict", version: read + 1 });
      expect((await capture("select public.scim_get_group($1,$2) as v", [t.orgA, first.row.v.group.id])).row.v).toMatchObject({ displayName: "Stewards", version: read + 1 });
      await asOwner();
      expect((await capture("select count(*)::int n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'scim_upsert_group'")).row.n).toBe(1);
      await actAsService();
      const second = await create("Coordinators");
      expect((await create("STEWARDs", second.row.v.group.id)).row.v.outcome).toBe("conflict");
      expect((await create("STEWARDS", first.row.v.group.id)).row.v).toMatchObject({ outcome: "updated", group: { displayName: "STEWARDS" } });
      const listed = await capture("select public.scim_list_groups($1,'displayName','sTeWaRdS',1,100,true) as v", [t.orgA]);
      expect(listed.row.v.totalResults).toBe(1);
      expect(listed.row.v.items[0].id).toBe(first.row.v.group.id);
      await asOwner();
      expect((await capture("insert into public.scim_groups(organization_id,display_name) values($1,'stewards')", [t.orgA])).code).toBe("23505");
      expect((await capture("insert into public.scim_groups(organization_id,display_name) values($1,'stewards')", [t.orgB])).ok).toBe(true);
    } finally {
      await client.query("rollback");
    }
  });

  it("starts a role only from an admin-mapped group and never from the provider", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const admin = await provisioned(t);
      const email = `grouped-${randomUUID()}@example.invalid`;
      await actAsService();
      const created = await upsert(t.orgA, null, scimUser(email), HASH("d1"));
      const userId = created.row.v.user.id;
      const group = await capture("select public.scim_upsert_group($1,null,'Stewards',null,$2::uuid[]) as v", [t.orgA, [userId]]);
      expect(group.row.v.outcome).toBe("created");
      await asOwner();
      const before = (await client.query("select initial_role from public.member_invitations where id=$1", [created.row.v.invitation.invitationId])).rows[0];
      expect(before.initial_role).toBeNull();

      await actAs(admin);
      // #7663: a steward needs a unit, which a directory group cannot supply.
      const stewardMapped = await capture("select public.set_scim_group_role($1,'steward') as v", [group.row.v.group.id]);
      expect(stewardMapped).toMatchObject({ ok: false, code: "22023" });
      expect(stewardMapped.message).toMatch(/^steward needs a unit/);
      const adminMapped = await capture("select public.set_scim_group_role($1,'coordinator') as v", [group.row.v.group.id]);
      expect(adminMapped.ok, adminMapped.message).toBe(true);
      expect((await capture("select public.set_scim_group_role($1,'admin') as v", [group.row.v.group.id])).code).toBe("22023");
      await asOwner();
      const after = (await client.query("select initial_role from public.member_invitations where id=$1", [created.row.v.invitation.invitationId])).rows[0];
      expect(after.initial_role).toBe("coordinator");

      await actAsService();
      const removed = await capture("select public.scim_upsert_group($1,$2,'Stewards',null,array[]::uuid[]) as v", [t.orgA, group.row.v.group.id]);
      expect(removed.row.v.outcome).toBe("updated");
      await asOwner();
      const cleared = (await client.query("select initial_role from public.member_invitations where id=$1", [created.row.v.invitation.invitationId])).rows[0];
      expect(cleared.initial_role).toBeNull();
    } finally {
      await client.query("rollback");
    }
  });

  // #7663: groups map only to coordinator or advisor; a desk steward keeps its unit.
  it.each([
    ["steward", "advisor", false],
    ["coordinator", "advisor", false],
    ["advisor", "coordinator", false],
    ["vp", "advisor", false],
    [null, "coordinator", false],
    ["steward", "advisor", true],
    ["coordinator", "advisor", true],
    ["advisor", "coordinator", true],
    ["vp", "advisor", true],
    [null, "coordinator", true],
  ])("preserves an adopted desk %s invitation against mapped %s (inviter cleared: %s)", async (role, mappedRole, clearInviter) => {
    await client.query("begin");
    try {
      const t = await tenants();
      const admin = await provisioned(t);
      const email = `desk-${randomUUID()}@example.invalid`;
      const userId = randomUUID();
      const groupId = randomUUID();
      // An existing, unbound directory entry is the double-reconcile path in
      // scim_upsert_user. Its invitation is issued independently by the desk.
      await client.query(
        "insert into public.scim_users(id,organization_id,user_name,directory_user_name,provisioning_state) values ($1,$2,$3,$3,'needs_admin')",
        [userId, t.orgA, email],
      );
      await client.query(
        "insert into public.scim_groups(id,organization_id,display_name,mapped_role) values ($1,$2,'Mapped staff',$3)",
        [groupId, t.orgA, mappedRole],
      );
      await client.query(
        "insert into public.scim_group_members(group_id,user_id,organization_id) values ($1,$2,$3)",
        [groupId, userId, t.orgA],
      );
      // The adopted desk grant includes its selected unit.
      const unit=(await client.query("select id from private.chapter_units where chapter_id=$1 order by is_default desc,id limit 1", [t.chapterA])).rows[0].id;
      await actAs(admin);
      const desk = await capture("select public.create_member_invitation($1,'Desk Invite',$2,$3,'en',$4,$5) as v", [email, t.chapterA, role, HASH("da"), role === "steward" ? unit : null]);
      expect(desk.ok, desk.message).toBe(true);
      expect(desk.row.v.send).toBe(true);
      const invitationId = desk.row.v.invitationId;
      await asOwner();
      if (clearInviter) {
        // These are the two ON DELETE SET NULL effects of inviter deletion.
        // The retained issuance audit still distinguishes desk from SCIM.
        await client.query("update public.member_invitations set invited_by=null where id=$1", [invitationId]);
        await client.query("update public.member_invitation_audit set actor=null where invitation_id=$1", [invitationId]);
      }

      await actAsService();
      for (let pass = 0; pass < 2; pass += 1) {
        const reconciled = await upsert(t.orgA, userId, scimUser(email), HASH("db"));
        expect(reconciled.ok, reconciled.message).toBe(true);
        expect(reconciled.row.v).toMatchObject({ outcome: "updated", invitation: { send: false } });
      }
      await asOwner();
      const readInvitation = async () => (await client.query(
        "select initial_role, token_hash, chapter_id from public.member_invitations where id=$1", [invitationId],
      )).rows[0];
      expect(await readInvitation()).toEqual({ initial_role: role, token_hash: HASH("da"), chapter_id: t.chapterA });
      expect((await client.query("select invitation_id from public.scim_users where id=$1", [userId])).rows[0].invitation_id).toBe(invitationId);

      await actAs(admin);
      const cleared = await capture("select public.set_scim_group_role($1,null) as v", [groupId]);
      expect(cleared.ok, cleared.message).toBe(true);
      await asOwner();
      expect((await readInvitation()).initial_role).toBe(role);
    } finally {
      await client.query("rollback");
    }
  });

  it("links an active member, re-invites a former member and leaves an account in another organization to an admin", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      await provisioned(t);
      const active = await person({ chapter: t.chapterA, organization: t.orgA });
      const former = await person({ chapter: null, organization: t.orgA, chapterMembership: null });
      await client.query("update public.organization_memberships set status='revoked', revoked_at=now() where organization_id=$1 and user_id=$2", [t.orgA, former]);
      const elsewhere = await person({ chapter: t.chapterB, organization: t.orgB });
      const emailOf = async (id) => (await client.query("select email from auth.users where id=$1", [id])).rows[0].email;
      const [activeEmail, formerEmail, elsewhereEmail] = [await emailOf(active), await emailOf(former), await emailOf(elsewhere)];

      await actAsService();
      const linked = await upsert(t.orgA, null, scimUser(activeEmail), HASH("e1"));
      expect(linked.row.v).toMatchObject({ user: { state: "active" }, invitation: { send: false } });
      const reinvited = await upsert(t.orgA, null, scimUser(formerEmail), HASH("e2"));
      expect(reinvited.row.v).toMatchObject({ user: { state: "reactivation_invited" }, invitation: { send: true } });
      const blocked = await upsert(t.orgA, null, scimUser(elsewhereEmail), HASH("e3"));
      expect(blocked.row.v).toMatchObject({ user: { state: "needs_admin", stateReason: "account_in_other_organization" }, invitation: { send: false } });
      await asOwner();

      const reactivation = (await client.query("select kind, initial_role, invited_by from public.member_invitations where id=$1", [reinvited.row.v.invitation.invitationId])).rows[0];
      expect(reactivation).toEqual({ kind: "reactivation", initial_role: null, invited_by: null });
      expect((await client.query("select count(*)::int as n from public.member_invitations where normalized_email=$1", [elsewhereEmail])).rows[0].n).toBe(0);
      expect(await membership(t.orgB, elsewhere)).toBe("active");
    } finally {
      await client.query("rollback");
    }
  });


  it.each([true,false])('deprovisions the bound UUID after Auth email change (directory rename %s), clears roles and revokes sessions', async (rename) => {
    await client.query('begin');
    try {
      const t=await tenants();await provisioned(t);
      const member=await person({chapter:t.chapterA,organization:t.orgA});
      const oldEmail=(await client.query('select email from auth.users where id=$1',[member])).rows[0].email;
      await client.query("insert into public.organization_role_grants(organization_id,user_id,role,granted_by) values($1,$2,'steward',$2)",[t.orgA,member]);
      await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal1')",[randomUUID(),member]);
      await actAsService();const linked=await upsert(t.orgA,null,scimUser(oldEmail),HASH('ef'));expect(linked.ok,linked.message).toBe(true);
      const resource=linked.row.v.user.id;await asOwner();
      expect((await client.query('select auth_user_id from public.scim_users where id=$1',[resource])).rows[0].auth_user_id).toBe(member);
      const newEmail='changed-'+randomUUID()+'@example.invalid';await client.query('update auth.users set email=$2 where id=$1',[member,newEmail]);
      await actAsService();const deactivated=await upsert(t.orgA,resource,scimUser(rename?newEmail:oldEmail,{active:false}),HASH('fa'));
      expect(deactivated.ok,deactivated.message).toBe(true);expect(deactivated.row.v.user.state).toBe('deprovisioned');
      await asOwner();expect(await membership(t.orgA,member)).toBe('revoked');
      expect((await client.query('select count(*)::int as n from public.organization_role_grants where organization_id=$1 and user_id=$2',[t.orgA,member])).rows[0].n).toBe(0);
      expect((await client.query('select count(*)::int as n from auth.sessions where user_id=$1',[member])).rows[0].n).toBe(0);
      expect((await client.query('select auth_user_id from public.scim_users where id=$1',[resource])).rows[0].auth_user_id).toBe(member);
    } finally {await client.query('rollback');}
  });

  it('deletes after email change using the retained account UUID',async()=>{
    await client.query('begin');try{
      const t=await tenants();await provisioned(t);const member=await person({chapter:t.chapterA,organization:t.orgA});
      const email=(await client.query('select email from auth.users where id=$1',[member])).rows[0].email;
      await actAsService();const linked=await upsert(t.orgA,null,scimUser(email),HASH('fb'));await asOwner();
      await client.query('update auth.users set email=$2 where id=$1',[member,'renamed-'+randomUUID()+'@example.invalid']);
      await actAsService();const deleted=await capture('select public.scim_delete_user($1,$2) as v',[t.orgA,linked.row.v.user.id]);
      expect(deleted.ok,deleted.message).toBe(true);expect(deleted.row.v).toEqual({deleted:true});await asOwner();expect(await membership(t.orgA,member)).toBe('revoked');
    }finally{await client.query('rollback');}
  });

  it('refuses deactivate and delete when a formerly linked account binding is unresolved',async()=>{
    await client.query('begin');try{
      const t=await tenants();await provisioned(t);const member=await person({chapter:t.chapterA,organization:t.orgA});
      const email=(await client.query('select email from auth.users where id=$1',[member])).rows[0].email;
      await actAsService();const linked=await upsert(t.orgA,null,scimUser(email),HASH('fc'));await asOwner();
      await client.query('update auth.users set deleted_at=now() where id=$1',[member]);
      await actAsService();expect((await upsert(t.orgA,linked.row.v.user.id,scimUser(email,{active:false}),HASH('fd'))).code).toBe('23514');
      expect((await capture('select public.scim_delete_user($1,$2) as v',[t.orgA,linked.row.v.user.id])).code).toBe('23514');
      await asOwner();expect(await membership(t.orgA,member)).toBe('active');
    }finally{await client.query('rollback');}
  });

  it("deprovisions by revoking the organization membership, chapter roles and open invitations, and keeps the account", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      await provisioned(t);
      const member = await person({ chapter: t.chapterA, organization: t.orgA });
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [member, t.chapterA2]);
      await client.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,'steward',$2)", [member, t.chapterA]);
      await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,'steward',$2)", [member, t.chapterA]);
      // The same person also belongs to the other organization; SCIM for A
      // must not touch that membership.
      await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [t.orgB, member]);
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [member, t.chapterB]);
      await client.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'advisor')", [t.orgB, member]);
      await client.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,'advisor',$2)", [member, t.chapterB]);
      const email = (await client.query("select email from auth.users where id=$1", [member])).rows[0].email;
      const invitee = `pending-${randomUUID()}@example.invalid`;

      await actAsService();
      const linked = await upsert(t.orgA, null, scimUser(email), HASH("f1"));
      const pending = await upsert(t.orgA, null, scimUser(invitee), HASH("f2"));
      const off = await upsert(t.orgA, linked.row.v.user.id, scimUser(email, { active: false }), null);
      expect(off.ok, off.message).toBe(true);
      expect(off.row.v).toMatchObject({ outcome: "updated", user: { state: "deprovisioned", active: false } });
      const deleted = await capture("select public.scim_delete_user($1,$2) as v", [t.orgA, pending.row.v.user.id]);
      expect(deleted.row.v).toEqual({ deleted: true });
      await asOwner();

      expect(await membership(t.orgA, member)).toBe("revoked");
      expect(await membership(t.orgB, member)).toBe("active");
      expect((await client.query("select role from public.organization_role_grants where organization_id=$1 and user_id=$2", [t.orgB, member])).rows).toEqual([{ role: "advisor" }]);
      expect((await client.query("select role, chapter_id from public.member_roles where user_id=$1", [member])).rows).toEqual([{ role: "advisor", chapter_id: t.chapterB }]);
      const chapters = (await client.query("select chapter_id, status from public.member_chapter_memberships where user_id=$1 order by chapter_id", [member])).rows;
      expect(chapters.find((row) => row.chapter_id === t.chapterA).status).toBe("revoked");
      expect(chapters.find((row) => row.chapter_id === t.chapterA2).status).toBe("revoked");
      expect(chapters.find((row) => row.chapter_id === t.chapterB).status).toBe("active");
      expect((await client.query("select count(*)::int as n from public.member_role_chapters where user_id=$1", [member])).rows[0].n).toBe(0);
      expect((await client.query("select chapter_id from public.member_profiles where id=$1", [member])).rows[0].chapter_id).toBe(t.chapterB);
      expect((await client.query("select count(*)::int as n from auth.users where id=$1", [member])).rows[0].n).toBe(1);
      const revokedInvitation = (await client.query("select status from public.member_invitations where id=$1", [pending.row.v.invitation.invitationId])).rows[0];
      expect(revokedInvitation.status).toBe("revoked");
      const audit = (await client.query(
        "select actor_user_id, action, entity_id, metadata from public.organization_audit_ledger where organization_id=$1 and event_type='membership.scim_deprovisioned'", [t.orgA],
      )).rows;
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor_user_id: null, action: "revoke", entity_id: member });
      expect(audit[0].metadata).toMatchObject({ userId: member, reasonCode: "scim_deprovision", count: 2 });
    } finally {
      await client.query("rollback");
    }
  });

  it("never removes the organization's last admin", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const admin = await provisioned(t);
      const email = (await client.query("select email from auth.users where id=$1", [admin])).rows[0].email;
      await actAsService();
      const linked = await upsert(t.orgA, null, scimUser(email), HASH("0a"));
      const removed = await capture("select public.scim_delete_user($1,$2) as v", [t.orgA, linked.row.v.user.id]);
      expect(removed).toMatchObject({ ok: false, code: "23514" });
      expect(removed.message).toContain("last organization admin");
      await asOwner();
      expect(await membership(t.orgA, admin)).toBe("active");

      // Control: with a second admin the same deprovision completes.
      await organizationStaff(t.orgA, t.chapterA, "admin");
      await actAsService();
      const again = await capture("select public.scim_delete_user($1,$2) as v", [t.orgA, linked.row.v.user.id]);
      expect(again.ok, again.message).toBe(true);
      expect(again.row.v).toEqual({ deleted: true });
      await asOwner();
      expect(await membership(t.orgA, admin)).toBe("revoked");
    } finally {
      await client.query("rollback");
    }
  });

  it("does not revoke another tenant's sessions when an unlinked directory entry is deleted", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      await provisioned(t);
      const other = await person({ chapter: t.chapterB, organization: t.orgB });
      const email = (await client.query("select email from auth.users where id=$1", [other])).rows[0].email;
      const session = randomUUID();
      await client.query("insert into auth.sessions(id,user_id,created_at,updated_at,aal) values($1,$2,now(),now(),'aal1')", [session, other]);
      await actAsService();
      const blocked = await upsert(t.orgA, null, scimUser(email), HASH("fe"));
      expect(blocked.row.v.user.stateReason).toBe("account_in_other_organization");
      const removed = await capture("select public.scim_delete_user($1,$2) as v", [t.orgA, blocked.row.v.user.id]);
      expect(removed.row.v).toEqual({ deleted: true });
      await asOwner();
      expect(await membership(t.orgB, other)).toBe("active");
      expect((await client.query("select id from auth.sessions where id=$1", [session])).rows).toHaveLength(1);
    } finally { await client.query("rollback"); }
  });

  it("binds the account UUID at invitation acceptance before its address changes", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      await provisioned(t);
      const email = `accepted-${randomUUID()}@example.invalid`;
      await actAsService();
      const invited = await upsert(t.orgA, null, scimUser(email), HASH("ff"));
      await asOwner();
      const member = await person({ chapter: t.chapterA, organization: t.orgA, email });
      await client.query("update public.member_invitations set status='accepted', auth_user_id=$2, accepted_at=now(), token_hash=null where id=$1", [invited.row.v.invitation.invitationId, member]);
      expect((await client.query("select auth_user_id from public.scim_users where id=$1", [invited.row.v.user.id])).rows[0].auth_user_id).toBe(member);
      await client.query("update auth.users set email=$2 where id=$1", [member, `accepted-new-${randomUUID()}@example.invalid`]);
      await actAsService();
      const removed = await capture("select public.scim_delete_user($1,$2) as v", [t.orgA, invited.row.v.user.id]);
      expect(removed.ok, removed.message).toBe(true);
      expect(removed.row.v).toEqual({ deleted: true });
      await asOwner();
      expect(await membership(t.orgA, member)).toBe("revoked");
    } finally { await client.query("rollback"); }
  });

  it("keeps each organization's directory to its own token", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      await provisioned(t);
      await provisioned(t, t.orgB, t.chapterB, "bb");
      const email = `iso-${randomUUID()}@example.invalid`;
      await actAsService();
      const created = await upsert(t.orgA, null, scimUser(email), HASH("0b"));
      const userId = created.row.v.user.id;
      expect((await capture("select public.scim_get_user($1,$2) as v", [t.orgB, userId])).row.v).toBeNull();
      expect((await capture("select public.scim_get_user($1,$2) as v", [t.orgA, userId])).row.v.userName).toBe(email);
      const listed = await capture("select public.scim_list_users($1,'userName',$2,1,10) as v", [t.orgB, email]);
      expect(listed.row.v).toEqual({ totalResults: 0, items: [] });
      expect((await capture("select public.scim_list_users($1,'userName',$2,1,10) as v", [t.orgA, email])).row.v.totalResults).toBe(1);
      expect((await upsert(t.orgB, userId, scimUser(email, { active: false }), null)).row.v).toEqual({ outcome: "not_found" });
      expect((await capture("select public.scim_delete_user($1,$2) as v", [t.orgB, userId])).row.v).toEqual({ deleted: false });
      const foreignGroup = await capture("select public.scim_upsert_group($1,null,'Mixed',null,$2::uuid[]) as v", [t.orgB, [userId]]);
      expect(foreignGroup.row.v).toEqual({ outcome: "unknown_member" });
      await asOwner();
      expect((await client.query("select status from public.member_invitations where id=$1", [created.row.v.invitation.invitationId])).rows[0].status).toBe("pending");
    } finally {
      await client.query("rollback");
    }
  });

  it("holds an account whose provider address changed for an admin instead of inviting a second account", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      await provisioned(t);
      const member = await person({ chapter: t.chapterA, organization: t.orgA });
      const email = (await client.query("select email from auth.users where id=$1", [member])).rows[0].email;
      const renamed = `renamed-${randomUUID()}@example.invalid`;
      await actAsService();
      const linked = await upsert(t.orgA, null, scimUser(email), HASH("0c"));
      const moved = await upsert(t.orgA, linked.row.v.user.id, scimUser(renamed), HASH("0d"));
      expect(moved.row.v).toMatchObject({ user: { state: "needs_admin", stateReason: "user_name_changed" }, invitation: { send: false } });
      await asOwner();
      expect((await client.query("select count(*)::int as n from public.member_invitations where normalized_email=$1", [renamed])).rows[0].n).toBe(0);
      expect(await membership(t.orgA, member)).toBe("active");
    } finally {
      await client.query("rollback");
    }
  });

  it.each([false, true])("keeps divergent directory mappings stable after a work-email correction (bound account: %s)", async (bound) => {
    await client.query("begin");
    try {
      const t = await tenants();
      await provisioned(t);
      const email = `directory-${randomUUID()}@example.invalid`;
      const work = `work-${randomUUID()}@example.invalid`;
      if (bound) await person({ chapter: t.chapterA, organization: t.orgA, email });
      await actAsService();
      let result = (await upsert(t.orgA, null, scimUser(email), HASH("71"))).row.v;
      const initialInvitation = result.invitation.invitationId;
      let sends = 0;
      for (const [index, operation] of [
        { op: "replace", path: 'emails[type eq "work"].value', value: work },
        { op: "replace", path: "userName", value: email },
        { op: "replace", path: 'emails[type eq "work"].value', value: work },
        { op: "replace", path: "userName", value: email },
      ].entries()) {
        const resource = toUserResource(result.user, "https://example.invalid/scim/v2");
        const normalized = normalizeUser(applyUserPatch(resource, { Operations: [operation] }));
        const saved = await upsert(t.orgA, result.user.id, normalized, HASH(`7${index + 2}`));
        expect(saved.ok, saved.message).toBe(true);
        result = saved.row.v;
        sends += Number(result.invitation.send);
        expect(toUserResource(result.user, "https://example.invalid/scim/v2"))
          .toMatchObject({ userName: email, emails: [{ value: work }] });
        expect(result.user.state).toBe(bound ? "needs_admin" : "invited");
        expect(result.user.stateReason).toBe(bound ? "user_name_changed" : null);
      }
      expect(sends).toBe(bound ? 0 : 1);
      // A client serializes the corrected GET resource before its next PUT;
      // no private PATCH metadata survives this wire roundtrip.
      const wire = JSON.parse(JSON.stringify(toUserResource(result.user, "https://example.invalid/scim/v2")));
      const beforePut = result.user;
      await asOwner();
      const invitationSql = "select id,normalized_email,status,token_hash,delivery_version from public.member_invitations where chapter_id=$1 order by id";
      const invitationsBeforePut = (await client.query(invitationSql, [t.chapterA])).rows;
      await actAsService();
      const replacement = normalizeUser(wire, { preferEmailAttribute: true });
      const put = (await upsert(t.orgA, result.user.id, replacement, HASH("78"))).row.v;
      expect(put.user).toMatchObject({ userName: beforePut.userName, directoryUserName: beforePut.directoryUserName,
        state: beforePut.state, stateReason: beforePut.stateReason });
      expect(put.invitation.send).toBe(false);
      expect(toUserResource(put.user, "https://example.invalid/scim/v2").emails).toEqual(wire.emails);
      await asOwner();
      expect((await client.query(invitationSql, [t.chapterA])).rows).toEqual(invitationsBeforePut);
      await actAsService();
      const listed = await capture("select public.scim_list_users($1,'userName',$2,1,10) as v", [t.orgA, email]);
      expect(listed.row.v.totalResults).toBe(1);
      expect((await capture("select public.scim_list_users($1,'userName',$2,1,10) as v", [t.orgA, work])).row.v.totalResults).toBe(0);
      expect((await capture("select public.scim_list_users($1,'emails.value',$2,1,10) as v", [t.orgA, work])).row.v.totalResults).toBe(1);
      expect((await capture("select public.scim_list_users($1,'emails.value',$2,1,10) as v", [t.orgA, email])).row.v.totalResults).toBe(0);
      const duplicate = await upsert(t.orgA, null, { ...scimUser(`other-${randomUUID()}@example.invalid`), directoryUserName: email }, HASH("77"));
      expect(duplicate.row.v.outcome).toBe("conflict");
      await asOwner();
      const invitations = (await client.query("select normalized_email,status from public.member_invitations where chapter_id=$1 order by created_at", [t.chapterA])).rows;
      expect(invitations.filter((row) => row.status === "pending")).toEqual(bound ? [] : [{ normalized_email: work, status: "pending" }]);
      if (!bound) expect((await client.query("select status, token_hash from public.member_invitations where id=$1", [initialInvitation])).rows[0])
        .toEqual({ status: "revoked", token_hash: null });
    } finally { await client.query("rollback"); }
  });

  it("refuses pre-existing duplicate bindings clearly without modifying either identity", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const account = await person({ organization: t.orgA });
      // Model the schema before this migration's unique constraint exists.
      // The transaction restores it, and every fixture row, on rollback.
      await client.query("alter table public.scim_users drop constraint scim_users_organization_auth_user_key");
      const ids = [randomUUID(), randomUUID()];
      await client.query("insert into public.scim_users(id,organization_id,user_name,directory_user_name,auth_user_id) values($1,$3,'first@example.invalid','first@example.invalid',$4),($2,$3,'second@example.invalid','second@example.invalid',$4)", [ids[0], ids[1], t.orgA, account]);
      const readRows = async () => (await client.query("select id,organization_id,user_name,directory_user_name,auth_user_id from public.scim_users where id=any($1::uuid[]) order by id", [ids])).rows;
      const before = await readRows();
      const migration = loadMigrationSql("scim_preserve_directory_identity");
      const preflight = migration.match(/do \$assert_scim_account_bindings\$[\s\S]*?\$assert_scim_account_bindings\$;/)[0];
      const refused = await capture(preflight);
      expect(refused.ok).toBe(false);
      expect(refused.code).toBe("23505");
      expect(refused.message).toContain("SCIM account binding conflict: duplicate (organization_id, auth_user_id)");
      expect(await readRows()).toEqual(before);
      await client.query("delete from public.scim_users where id=$1", [ids[1]]);
      // Same UUID in another tenant and multiple NULL bindings are controls.
      await client.query("insert into public.scim_users(organization_id,user_name,directory_user_name,auth_user_id) values($1,'other@example.invalid','other@example.invalid',$2),($3,'unbound1@example.invalid','unbound1@example.invalid',null),($3,'unbound2@example.invalid','unbound2@example.invalid',null)", [t.orgB, account, t.orgA]);
      expect((await capture(preflight)).ok).toBe(true);
    } finally { await client.query("rollback"); }
  });

  it.each(["emails", "userName"])("refuses a second identity for a bound account after a %s correction", async (attribute) => {
    await client.query("begin");
    try {
      const t = await tenants();
      await provisioned(t);
      const email = `collision-${randomUUID()}@example.invalid`;
      const correctedEmail = `corrected-${randomUUID()}@example.invalid`;
      const account = await person({ chapter: t.chapterA, organization: t.orgA, email });
      await actAs(account);
      await asOwner();
      const sessionCount = async () => Number((await client.query("select count(*) n from auth.sessions where user_id=$1", [account])).rows[0].n);
      const sessionsBefore = await sessionCount();
      await actAsService();
      const first = (await upsert(t.orgA, null, scimUser(email), HASH("81"))).row.v;
      const resource = toUserResource(first.user, "https://example.invalid/scim/v2");
      const changed = normalizeUser(applyUserPatch(resource, { Operations: [{ op: "replace",
        path: attribute === "emails" ? 'emails[type eq "work"].value' : "userName", value: correctedEmail }] }));
      const corrected = await upsert(t.orgA, first.user.id, changed, HASH("82"));
      expect(corrected.ok, corrected.message).toBe(true);
      expect(corrected.row.v.user).toMatchObject({ userName: correctedEmail, state: "needs_admin", stateReason: "user_name_changed" });
      const second = normalizeUser({ userName: "00u-second", emails: [{ value: email, type: "work", primary: true }], active: true });
      for (const active of [true, false]) {
        const refused = await upsert(t.orgA, null, { ...second, active }, HASH("83"));
        expect(refused.ok, refused.message).toBe(true);
        // The binding collision is labeled as one, not as a duplicate userName.
        expect(refused.row.v).toEqual({ outcome: "conflict", conflict: "binding" });
      }
      await asOwner();
      expect((await client.query("select count(*)::integer n from public.scim_users where organization_id=$1", [t.orgA])).rows[0].n).toBe(1);
      // An existing unbound row can also discover the same Auth identity on
      // PATCH or DELETE. A refusal must roll back the attempted deactivation.
      const secondId = randomUUID();
      await client.query("insert into public.scim_users(id,organization_id,user_name,directory_user_name,provisioning_state) values($1,$2,$3,'00u-second','needs_admin')", [secondId, t.orgA, email]);
      await actAsService();
      const refusedUpdate = await upsert(t.orgA, secondId, { ...second, active: false }, HASH("84"));
      expect(refusedUpdate.ok, refusedUpdate.message).toBe(true);
      expect(refusedUpdate.row.v).toEqual({ outcome: "conflict", conflict: "binding" });
      const refusedDelete = await capture("select public.scim_delete_user($1,$2) v", [t.orgA, secondId]);
      expect(refusedDelete.ok).toBe(false);
      expect(refusedDelete.code).toBe("23505");
      await asOwner();
      expect((await client.query("select active,auth_user_id,version from public.scim_users where id=$1", [secondId])).rows[0])
        .toMatchObject({ active: true, auth_user_id: null, version: 1 });
      expect(await membership(t.orgA, account)).toBe("active");
      expect((await client.query("select status from public.member_chapter_memberships where user_id=$1 and chapter_id=$2", [account, t.chapterA])).rows[0].status).toBe("active");
      expect(await sessionCount()).toBe(sessionsBefore);
      expect((await client.query("select auth_user_id,provisioning_state,state_reason from public.scim_users where id=$1", [first.user.id])).rows[0])
        .toMatchObject({ auth_user_id: account, provisioning_state: "needs_admin", state_reason: "user_name_changed" });
      // The same person can belong to another organization; its independent
      // SCIM identity is a permitted control, not a global Auth UUID ban.
      await client.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [t.orgB, account]);
      await actAsService();
      const otherOrganization = await upsert(t.orgB, null, scimUser(email), HASH("85"));
      expect(otherOrganization.ok, otherOrganization.message).toBe(true);
      expect(otherOrganization.row.v).toMatchObject({ outcome: "created", user: { state: "active" }, invitation: { send: false } });
      await asOwner();
      expect((await client.query("select auth_user_id from public.scim_users where id=$1", [otherOrganization.row.v.user.id])).rows[0].auth_user_id).toBe(account);
    } finally { await client.query("rollback"); }
  });

  it("stops inviting at the organization's daily SCIM budget", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      await provisioned(t);
      await switchOn(t.orgA, "limits.integrations.scim_invitations_per_day", "1");
      await actAsService();
      const first = await upsert(t.orgA, null, scimUser(`one-${randomUUID()}@example.invalid`), HASH("0e"));
      expect(first.ok, first.message).toBe(true);
      const second = await upsert(t.orgA, null, scimUser(`two-${randomUUID()}@example.invalid`), HASH("0f"));
      expect(second.ok).toBe(false);
      expect(second.code).toBe("P0001");
      expect(second.message).toContain("scim invitation limit");
      await asOwner();
    } finally {
      await client.query("rollback");
    }
  });

  it("refuses every service RPC to a signed-in admin", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const admin = await provisioned(t);
      await actAs(admin);
      for (const statement of [
        ["select public.scim_list_users($1,null,null,1,10)", [t.orgA]],
        ["select public.scim_upsert_user($1,null,'{}'::jsonb,null)", [t.orgA]],
        ["select public.scim_delete_user($1,$2)", [t.orgA, randomUUID()]],
        ["select public.scim_upsert_group($1,null,'x',null,array[]::uuid[])", [t.orgA]],
      ]) {
        expect((await capture(...statement)).code).toBe("42501");
      }
      await asOwner();
    } finally {
      await client.query("rollback");
    }
  });
});
