// @vitest-environment node
//
// REQ-UG-SSO-SIGNIN-20261001
//
// 20261003042000 adds per-organization SAML single sign-on through Supabase
// Auth SSO inside the Invitation-only accounts contract: SSO signs in only
// people who already hold an invitation or membership in the organization.
// GoTrue signs a SAML user in only through an auth.identities row
// (provider 'sso:<provider id>', provider_id = email); these cases prove that
// such a row exists exactly for eligible accounts and disappears when they
// stop being eligible.
//
// Fictional tenants only (Example Workers Local 1, Example Transit Local 2);
// every row is rolled back.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { findMigrationName, loadMigrationSql, stripComments } from "./helpers/migration.js";
import { releaseCalendarHolds } from "./helpers/release-calendar-holds.js";

const MIGRATION = "sso_saml_signin";
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

describe("SSO sign-in migration (static)", () => {
  const sql = stripComments(loadMigrationSql(MIGRATION));

  it("ships one atomic migration in the L14 block with the switch off by default", () => {
    expect(findMigrationName(MIGRATION)).toBe("20261003042000_sso_saml_signin.sql");
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    expect(sql).toMatch(/\('features\.security\.sso', 'boolean', 'Single sign-on \(SAML\)',[\s\S]*?'false', null, null, null, 410, 'security', false\)/);
  });

  it("never creates an account and links only through the eligibility check", () => {
    expect(sql).not.toMatch(/insert into auth\.users/);
    expect(sql.match(/insert into auth\.identities/g)).toHaveLength(1);
    const link = sql.slice(sql.indexOf("create function private.sso_link_identity"), sql.indexOf("revoke all on function private.sso_link_identity"));
    expect(link).toContain("private.sso_account_eligible(p_organization_id, p_user_id)");
    expect(link).toContain("private.sso_active_provider(p_organization_id)");
    expect(link.indexOf("sso_account_eligible")).toBeLessThan(link.indexOf("insert into auth.identities"));
  });

  it("pins the service RPCs to service_role and the sweep schedule in the contract", () => {
    for (const name of ["record_sso_domain_check(uuid, uuid, boolean)", "record_sso_registration(uuid, uuid, text, text)",
      "record_sso_test(uuid, boolean, text)", "record_sso_deregistration(uuid)", "sso_signin_lookup(text, text)"]) {
      expect(sql).toContain(`grant execute on function public.${name} to service_role;`);
      expect(sql).not.toContain(`grant execute on function public.${name} to authenticated;`);
    }
    expect(contract.functions.find((row) => row.sig === "public.sso_signin_lookup(p_email text, p_network text)")).toMatchObject({ exec: "service_role", secdef: true });
    expect(contract.cron.find((row) => row.jobname === "sso-identity-link-sweep")).toMatchObject({ schedule: "6-56/10 * * * *" });
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("SSO sign-in on a disposable database", () => {
  let client;

  beforeAll(async () => {
    assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, application_name: "sso-signin-rollback-proof" });
    await client.connect();
    await client.query("set statement_timeout = '20s'");
  });

  afterAll(async () => {
    await client?.end();
  });

  async function tenants() {
    const orgA = randomUUID();
    const orgB = randomUUID();
    const chapterA = `ewl1-a-${orgA}`;
    const chapterB = `etl2-a-${orgB}`;
    await client.query(
      "insert into public.organizations(id,slug,name) values ($1,$2,$3), ($4,$5,$6)",
      [orgA, `ewl1-${orgA}`, `Example Workers Local 1 ${orgA}`, orgB, `etl2-${orgB}`, `Example Transit Local 2 ${orgB}`],
    );
    await client.query(
      `insert into public.chapters(id,name,slug,region,organization_id,order_index)
       values ($1,$1,$1,'proof',$3,9951), ($2,$2,$2,'proof',$4,9952)`,
      [chapterA, chapterB, orgA, orgB],
    );
    const domainA = `ewl1-${orgA.slice(0, 8)}.example`;
    const domainB = `etl2-${orgB.slice(0, 8)}.example`;
    return { orgA, orgB, chapterA, chapterB, domainA, domainB };
  }

  async function person({ email, chapter = null, organization = null }) {
    const id = randomUUID();
    await client.query("insert into auth.users(id,email,email_confirmed_at) values ($1,$2,now())", [id, email]);
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [id, chapter]);
    if (organization) {
      await client.query("insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [organization, id]);
      await client.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [id, chapter]);
    }
    return id;
  }

  async function staff(org, chapter, role, email) {
    const id = await person({ email, chapter, organization: org });
    await client.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,$3)", [org, id, role]);
    await client.query("insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())", [randomUUID(), id]);
    return id;
  }

  async function actAs(userId, aal = "aal2") {
    const session = randomUUID();
    await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,$3,now(),now())", [session, userId, aal]);
    await client.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: userId, role: "authenticated", aal, session_id: session })]);
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

  async function setting(org, key, value) {
    await client.query(
      "insert into public.organization_setting_values(organization_id,setting_key,value) values ($1,$2,$3::jsonb) on conflict (organization_id, setting_key) do update set value = excluded.value",
      [org, key, value],
    );
  }

  // An organization with SSO switched on, a verified domain and a registered provider.
  async function activeSso(t, org = t.orgA, chapter = t.chapterA, domain = t.domainA) {
    const admin = await staff(org, chapter, "admin", `admin-${randomUUID().slice(0, 8)}@${domain}`);
    await setting(org, "features.security.sso", "true");
    await actAs(admin);
    expect((await capture("select public.save_sso_connection('https://idp.example/metadata', null, '{\"email\":\"mail\"}'::jsonb) as v")).ok).toBe(true);
    const added = await capture("select public.add_sso_domain($1) as v", [domain]);
    expect(added.ok, added.message).toBe(true);
    await asOwner();
    const domainId = added.row.v.domains.find((item) => item.domain === domain).id;
    const provider = randomUUID();
    await actAsService();
    expect((await capture("select public.record_sso_domain_check($1,$2,true) as v", [org, domainId])).row.v).toEqual({ outcome: "verified" });
    expect((await capture("select public.record_sso_registration($1,$2,'https://idp.example/entity',null) as v", [org, provider])).row.v).toEqual({ outcome: "registered" });
    await asOwner();
    return { admin, provider, domainId };
  }

  const lookup = (email, network = "ipv4:192.0.2.10") => capture("select public.sso_signin_lookup($1,$2) as v", [email, network]);
  const identities = async (provider) => (await client.query(
    "select user_id, provider_id from auth.identities where provider = $1 order by provider_id", [`sso:${provider}`],
  )).rows;

  it("lets an MFA organization admin configure SSO, a vp read it, and refuses a steward and AAL1", async () => {
    await client.query("begin");
    await releaseCalendarHolds(client);
    try {
      const t = await tenants();
      const admin = await staff(t.orgA, t.chapterA, "admin", `a-${randomUUID()}@${t.domainA}`);
      const vp = await staff(t.orgA, t.chapterA, "vp", `v-${randomUUID()}@${t.domainA}`);
      const steward = await staff(t.orgA, t.chapterA, "steward", `s-${randomUUID()}@${t.domainA}`);
      await actAs(admin);
      expect((await capture("select public.save_sso_connection('https://idp.example/m', '<xml/>', '{}'::jsonb) as v")).code).toBe("22023");
      expect((await capture("select public.save_sso_connection('http://idp.example/m', null, '{}'::jsonb) as v")).code).toBe("22023");
      expect((await capture("select public.save_sso_connection('https://idp.example/m', null, '{\"role\":\"x\"}'::jsonb) as v")).code).toBe("22023");
      const saved = await capture("select public.save_sso_connection('https://idp.example/m', null, '{\"email\":\"mail\",\"givenName\":\"givenName\"}'::jsonb) as v");
      expect(saved.ok, saved.message).toBe(true);
      expect(saved.row.v).toMatchObject({ enabled: false, canManage: true, active: false, connection: { status: "draft", metadataUrl: "https://idp.example/m" } });
      expect((await capture("select public.add_sso_domain('not a domain') as v")).code).toBe("22023");
      const added = await capture("select public.add_sso_domain($1) as v", [`${t.domainA.toUpperCase()}.`]);
      expect(added.row.v.domains[0]).toMatchObject({ domain: t.domainA, verified: false, recordName: `_union-ground-sso.${t.domainA}` });
      expect(added.row.v.domains[0].recordValue).toMatch(/^union-ground-sso=[0-9a-f]{32}$/);
      const context = await capture("select public.begin_sso_admin_action() as v");
      expect(context.row.v).toMatchObject({ organizationId: t.orgA, enabled: false, connection: { metadataUrl: "https://idp.example/m" } });
      await asOwner();

      await actAs(admin, "aal1");
      expect((await capture("select public.get_sso_control() as v")).code).toBe("42501");
      await asOwner();
      await actAs(vp);
      expect((await capture("select public.get_sso_control() as v")).row.v.canManage).toBe(false);
      expect((await capture("select public.add_sso_domain('vp.example') as v")).code).toBe("42501");
      expect((await capture("select public.begin_sso_admin_action() as v")).code).toBe("42501");
      await asOwner();
      await actAs(steward);
      expect((await capture("select public.get_sso_control() as v")).code).toBe("42501");
      await asOwner();
    } finally {
      await client.query("rollback");
    }
  });

  it("lets one organization prove a domain and refuses it to the next", async () => {
    await client.query("begin");
    await releaseCalendarHolds(client);
    try {
      const t = await tenants();
      await activeSso(t);
      const adminB = await staff(t.orgB, t.chapterB, "admin", `b-${randomUUID()}@${t.domainB}`);
      await actAs(adminB);
      const taken = await capture("select public.add_sso_domain($1) as v", [t.domainA]);
      expect(taken.ok).toBe(false);
      expect(taken.message).toContain("verified elsewhere");
      await asOwner();
      // A pending claim made before A verified cannot be verified afterwards.
      await client.query("insert into public.organization_sso_domains(organization_id,domain,verification_token) values ($1,$2,$3)", [t.orgB, `x${t.domainA}`, "a".repeat(32)]);
      const pendingB = (await client.query("select id from public.organization_sso_domains where organization_id=$1", [t.orgB])).rows[0].id;
      await client.query("update public.organization_sso_domains set domain=$2 where id=$1", [pendingB, t.domainA]);
      await actAsService();
      expect((await capture("select public.record_sso_domain_check($1,$2,true) as v", [t.orgB, pendingB])).row.v).toEqual({ outcome: "taken" });
      expect((await capture("select public.record_sso_domain_check($1,$2,true) as v", [t.orgA, pendingB])).row.v).toEqual({ outcome: "not_found" });
      await asOwner();
    } finally {
      await client.query("rollback");
    }
  });

  it("answers the provider only for a verified domain with SSO on, and links only members and invitees", async () => {
    await client.query("begin");
    await releaseCalendarHolds(client);
    try {
      const t = await tenants();
      const { provider } = await activeSso(t);
      const member = await person({ email: `member-${randomUUID().slice(0, 8)}@${t.domainA}`, chapter: t.chapterA, organization: t.orgA });
      const outsider = await person({ email: `outsider-${randomUUID().slice(0, 8)}@${t.domainA}` });
      const elsewhere = await person({ email: `elsewhere-${randomUUID().slice(0, 8)}@${t.domainA}`, chapter: t.chapterB, organization: t.orgB });
      const invitee = await person({ email: `invitee-${randomUUID().slice(0, 8)}@${t.domainA}` });
      const emails = Object.fromEntries((await client.query("select id, email from auth.users where id = any($1::uuid[])", [[member, outsider, elsewhere, invitee]])).rows.map((row) => [row.id, row.email]));
      await client.query(
        `insert into public.member_invitations(normalized_email,full_name,first_name,initials,chapter_id,locale,token_hash,status,delivery_version,expires_at,kind)
         values ($1,'Ivy Example','Ivy','IE',$2,'en',$3,'pending',1,now() + interval '10 minutes','reactivation')`,
        [emails[invitee], t.chapterA, "c".repeat(64)],
      );
      // A stale identity for the outsider (for example from an earlier membership).
      await client.query("insert into auth.identities(provider_id,user_id,identity_data,provider) values ($1,$2,'{}'::jsonb,$3)", [emails[outsider], outsider, `sso:${provider}`]);

      await actAsService();
      const answers = [];
      for (const email of [emails[member], emails[outsider], emails[elsewhere], emails[invitee], `nobody-${randomUUID().slice(0, 8)}@${t.domainA}`]) {
        const answer = await lookup(email);
        expect(answer.ok, answer.message).toBe(true);
        answers.push(answer.row.v);
      }
      expect(new Set(answers.map((answer) => JSON.stringify(answer)))).toEqual(new Set([JSON.stringify({ sso: true, providerId: provider })]));
      expect((await lookup(`someone@${t.domainB}`)).row.v).toEqual({ sso: false });
      expect((await lookup("not-an-email")).code).toBe("22023");
      await asOwner();

      const linked = await identities(provider);
      expect(linked.map((row) => row.user_id).sort()).toEqual([member, invitee].sort());
      expect(linked.find((row) => row.user_id === member).provider_id).toBe(emails[member]);
      expect((await client.query("select count(*)::int as n from auth.users where email like $1", [`nobody-%@${t.domainA}`])).rows[0].n).toBe(0);

      // The switch off answers no provider and the sweep removes every link.
      await setting(t.orgA, "features.security.sso", "false");
      await actAsService();
      expect((await lookup(emails[member])).row.v).toEqual({ sso: false });
      await asOwner();
      expect((await client.query("select private.sso_unlink_ineligible(500) as n")).rows[0].n).toBe(2);
      expect(await identities(provider)).toEqual([]);
    } finally {
      await client.query("rollback");
    }
  });

  // REQ-UG-RELEASE-HOLD-ON-ENTRY-SCREEN-CONTROLS-20261112 (#8465):
  // while features.security.sso is held for a release date, discovery answers
  // exactly as for an address whose domain has no provider, and links nobody.
  it("answers no provider and links nobody while single sign-on is held for release", async () => {
    await client.query("begin");
    await releaseCalendarHolds(client);
    try {
      const t = await tenants();
      const { provider } = await activeSso(t);
      const member = await person({ email: `member-${randomUUID().slice(0, 8)}@${t.domainA}`, chapter: t.chapterA, organization: t.orgA });
      const email = (await client.query("select email from auth.users where id = $1", [member])).rows[0].email;
      await client.query("update public.platform_setting_definitions set release_at = 'infinity' where key = 'features.security.sso'");
      await actAsService();
      expect((await lookup(email)).row.v).toEqual({ sso: false });
      expect((await lookup(`someone@${t.domainB}`)).row.v).toEqual({ sso: false });
      await asOwner();
      expect(await identities(provider)).toEqual([]);
      // Released, the same organization answers its provider again.
      await client.query("update public.platform_setting_definitions set release_at = null where key = 'features.security.sso'");
      await actAsService();
      expect((await lookup(email)).row.v).toEqual({ sso: true, providerId: provider });
      await asOwner();
    } finally {
      await client.query("rollback");
    }
  });

  it("unlinks a deprovisioned member, a removed domain and a deregistered provider", async () => {
    await client.query("begin");
    await releaseCalendarHolds(client);
    try {
      const t = await tenants();
      const { provider, domainId, admin } = await activeSso(t);
      const left = await person({ email: `left-${randomUUID().slice(0, 8)}@${t.domainA}`, chapter: t.chapterA, organization: t.orgA });
      const stays = await person({ email: `stays-${randomUUID().slice(0, 8)}@${t.domainA}`, chapter: t.chapterA, organization: t.orgA });
      const emails = Object.fromEntries((await client.query("select id, email from auth.users where id = any($1::uuid[])", [[left, stays]])).rows.map((row) => [row.id, row.email]));
      await actAsService();
      await lookup(emails[left]);
      await lookup(emails[stays]);
      await asOwner();
      expect(await identities(provider)).toHaveLength(2);

      await client.query("update public.organization_memberships set status='revoked', revoked_at=now() where organization_id=$1 and user_id=$2", [t.orgA, left]);
      expect((await client.query("select private.sso_unlink_ineligible(500) as n")).rows[0].n).toBe(1);
      expect((await identities(provider)).map((row) => row.user_id)).toEqual([stays]);

      await actAs(admin);
      expect((await capture("select public.remove_sso_domain($1) as v", [domainId])).row.v.connection.needsRegistration).toBe(true);
      await asOwner();
      expect(await identities(provider)).toEqual([]);

      await actAsService();
      await lookup(emails[stays]);
      const deregistered = await capture("select public.record_sso_deregistration($1) as v", [t.orgA]);
      expect(deregistered.row.v.outcome).toBe("deregistered");
      await asOwner();
      expect(await identities(provider)).toEqual([]);
      const connection = (await client.query("select status, gotrue_provider_id from public.organization_sso_connections where organization_id=$1", [t.orgA])).rows[0];
      expect(connection).toEqual({ status: "draft", gotrue_provider_id: null });
    } finally {
      await client.query("rollback");
    }
  });

  it("never moves an identity to another account and keeps organizations apart", async () => {
    await client.query("begin");
    await releaseCalendarHolds(client);
    try {
      const t = await tenants();
      const { provider } = await activeSso(t);
      const b = await activeSso(t, t.orgB, t.chapterB, t.domainB);
      const memberA = await person({ email: `m-${randomUUID().slice(0, 8)}@${t.domainA}`, chapter: t.chapterA, organization: t.orgA });
      const emailA = (await client.query("select email from auth.users where id=$1", [memberA])).rows[0].email;
      // Organization B's provider can never link an organization A address.
      await actAsService();
      expect((await lookup(emailA)).row.v).toEqual({ sso: true, providerId: provider });
      await asOwner();
      expect(await identities(b.provider)).toEqual([]);
      expect((await client.query("select private.sso_link_identity($1,$2) as linked", [t.orgB, memberA])).rows[0].linked).toBe(false);
      // An identity already held by another account is left alone.
      const other = await person({ email: `o-${randomUUID().slice(0, 8)}@${t.domainA}`, chapter: t.chapterA, organization: t.orgA });
      const otherEmail = (await client.query("select email from auth.users where id=$1", [other])).rows[0].email;
      await client.query("delete from auth.identities where provider=$1", [`sso:${provider}`]);
      await client.query("insert into auth.identities(provider_id,user_id,identity_data,provider) values ($1,$2,'{}'::jsonb,$3)", [otherEmail, memberA, `sso:${provider}`]);
      expect((await client.query("select private.sso_link_identity($1,$2) as linked", [t.orgA, other])).rows[0].linked).toBe(false);
    } finally {
      await client.query("rollback");
    }
  });

  it("throttles discovery per network with the platform sign-in limits and refuses signed-in callers", async () => {
    await client.query("begin");
    await releaseCalendarHolds(client);
    try {
      const t = await tenants();
      const { admin } = await activeSso(t);
      const limit = (await client.query("select private.organization_limit(null, 'limits.security.signin_attempts_per_ip_hour') as n")).rows[0].n;
      await actAsService();
      let limited = false;
      for (let index = 0; index <= limit && !limited; index += 1) {
        const answer = (await lookup(`p${index}-${randomUUID().slice(0, 6)}@${t.domainA}`, "ipv4:198.51.100.77")).row.v;
        limited = answer.limited === true;
      }
      expect(limited).toBe(true);
      expect((await lookup(`fresh@${t.domainA}`, "ipv4:198.51.100.78")).row.v.sso).toBe(true);
      await asOwner();
      await actAs(admin);
      for (const statement of [
        ["select public.sso_signin_lookup($1,'unknown')", [`a@${t.domainA}`]],
        ["select public.record_sso_registration($1,$2,null,null)", [t.orgA, randomUUID()]],
        ["select public.record_sso_deregistration($1)", [t.orgA]],
      ]) {
        expect((await capture(...statement)).code).toBe("42501");
      }
      await asOwner();
    } finally {
      await client.query("rollback");
    }
  });

  // REQ-UG-HOLD-RELEASE-CALENDAR-SWITCHES-20261112 (#8579): while
  // features.security.sso is held its setup answers only that it is held and
  // refuses every setup write; released but switched off by the organization,
  // setup reads and writes exactly as before. Stored setup rows are kept.
  it("hides single sign-on setup and refuses its writes only while it is held", async () => {
    await client.query("begin");
    await releaseCalendarHolds(client);
    try {
      const t = await tenants();
      const { admin, domainId } = await activeSso(t);
      await setting(t.orgA, "features.security.sso", "false");
      await actAs(admin);
      const released = await capture("select public.get_sso_control() as v");
      expect(released.ok, released.message).toBe(true);
      expect(released.row.v).toMatchObject({ organizationId: t.orgA, released: true, enabled: false, canManage: true });
      expect(released.row.v.domains).toHaveLength(1);
      const added = await capture("select public.add_sso_domain($1) as v", [`extra-${t.domainA}`]);
      expect(added.ok, added.message).toBe(true);
      await asOwner();

      await client.query("update public.platform_setting_definitions set release_at = 'infinity' where key = 'features.security.sso'");
      await actAs(admin);
      expect((await capture("select public.get_sso_control() as v")).row.v).toEqual({ organizationId: t.orgA, released: false });
      const writes = [
        ["select public.save_sso_connection('https://idp.example/other', null, '{}'::jsonb) as v", []],
        ["select public.add_sso_domain($1) as v", [`more-${t.domainA}`]],
        ["select public.remove_sso_domain($1) as v", [domainId]],
        ["select public.begin_sso_admin_action() as v", []],
      ];
      for (const [statement, args] of writes) {
        expect(await capture(statement, args), statement).toMatchObject({ ok: false, code: "42501", message: "sso held for release" });
      }
      await asOwner();
      expect((await client.query("select count(*)::int n from public.organization_sso_domains where organization_id=$1", [t.orgA])).rows[0].n).toBe(2);
      expect((await client.query("select metadata_url from public.organization_sso_connections where organization_id=$1", [t.orgA])).rows).toEqual([{ metadata_url: "https://idp.example/metadata" }]);
    } finally {
      await client.query("rollback");
    }
  });
});
