// @vitest-environment node
//
// BUG-UG-INVITE-CHAPTER-LOCKED-TO-CURRENT-CHAPTER-20261003
//
// 20261004010000 lets an admin invite into any chapter they administer in the
// selected organization, and makes the list, resend, revoke and delivery-record
// RPCs follow the same rule, so nothing can be created that its creator cannot
// manage. The live cases use two fictional tenants (Harbor Workers Local 7 and
// Ridge Transit Local 9). Every refusal has an allowed control in the same
// transaction, so a check that refuses everything cannot pass. Every row is
// rolled back.
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";
import { fnBody, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";

const MIGRATION = "20261004010000_invitation_target_chapter_admin";
// REQ-UG-MEMBER-SENT-INVITATIONS-20261111 (#8171) re-emits the list
// to name each invitation's source and sending member; found by name because
// its stamp follows the migration queue.
const MEMBER_SENT_LIST = readdirSync(new URL("../supabase/migrations/", import.meta.url))
  .find((name) => name.endsWith("_member_sent_invitations.sql"));
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const HASH = (pair) => pair.repeat(32);

function latestFunction(signature) {
  const migration = [...migrationFiles()].reverse().find(({ sql: text }) => (
    stripComments(text).toLowerCase().includes(`function ${signature.toLowerCase()}`)
  ));
  expect(migration, `missing migration for ${signature}`).toBeTruthy();
  return { name: migration.name, body: stripComments(fnBody(migration.sql, signature)) };
}

const SIGNATURES = {
  create: "public.create_member_invitation(p_email text, p_full_name text, p_chapter_id text, p_initial_role text, p_locale text, p_token_hash text)",
  former: "public.create_former_member_invitation(p_email text, p_chapter_id text, p_locale text, p_token_hash text)",
  list: "public.get_member_invitations(p_limit integer default 50)",
  resend: "public.resend_member_invitation(p_invitation_id uuid, p_token_hash text)",
  revoke: "public.revoke_member_invitation(p_invitation_id uuid)",
  delivery: "public.record_member_invitation_delivery(",
};

describe("invitation target chapter (static)", () => {
  it("adds one atomic migration whose helper checks the organization before the chapter role", () => {
    const sql = stripComments(loadMigrationSql(MIGRATION));
    expect(sql.trimStart().startsWith("begin;")).toBe(true);
    expect(sql.trimEnd().endsWith("commit;")).toBe(true);
    const helper = stripComments(fnBody(sql, "private.member_invitation_chapter_administrable(p_chapter_id text)"));
    expect(helper).toContain("target.organization_id = selected.organization_id");
    expect(helper).toContain("private.member_has_chapter_role(p_chapter_id, array['admin'])");
    expect(sql).toContain("revoke all on function private.member_invitation_chapter_administrable(text)\n  from public, anon, authenticated, service_role;");
    expect(sql).not.toMatch(/grant execute on function private\.member_invitation_chapter_administrable/);
  });

  it("puts every invitation path on the same target-chapter rule behind the unchanged desk gate", () => {
    // 20261004040000 (BUG-UG-CHAPTER-PRESIDENT-CANNOT-INVITE-20261003)
    // later re-emitted every path except the former-member one behind a gate
    // that also admits a chapter President; the admin target-chapter rule is
    // unchanged.
    for (const [key, signature] of Object.entries(SIGNATURES)) {
      // The old API delegates to the unit-aware core.
      let { name, body } = latestFunction(signature);
      if (key === "create") {
        expect(body).toContain("return public.create_member_invitation(p_email,p_full_name,p_chapter_id,p_initial_role,p_locale,p_token_hash,null::uuid)");
        ({ name, body } = latestFunction(signature.replace("p_token_hash text)","p_token_hash text, p_unit_id uuid)")));
      }
      const president = key !== "former";
      // 20261008122000 (REQ-UG-OFFICER-ROLES-VP-TREASURER-SECRETARY-20261006)
      // re-emits create only, to add President to the starting access.
      // 20261022171700 (UX-UG-ROSTER-IMPORT-TAKES-DAYS-20261018) re-emits
      // resend (a resent roster invitation keeps its 7-day link) and the list
      // (every actionable invitation stays listed). 20261103005000
      // (BUG-UG-ACCEPTED-INVITATIONS-SHOW-EXPIRY-20261102) re-emits the
      // list to return when each invitation was accepted and revoked.
      // 20261104111500 (REQ-UG-LEARNING-PERIOD-MESSAGES-NOTICES-INVITES-EXPORTS-20261103)
      // re-emits create, former, resend and revoke to journal the send and to
      // hold a revoke during the learning period; the target-chapter rule is
      // unchanged.
      // The member-sent invitations migration re-emits the list with two added
      // fields; the caller gate and chapter scope are unchanged. #7663 re-emits
      // create with the steward's unit choice.
      // #9273 extracts system expiry from create and former; their desk and
      // target-chapter gates remain byte for byte under the new source proof.
      const expected = ["create", "former"].includes(key) ? migrationFiles().find(({name}) => name.endsWith("_invitation_expiry_system_maintenance.sql")).name : ["resend", "revoke"].includes(key)
        ? "20261104111500_learning_period_messages_notices_invites_exports.sql"
        : key === "list" ? MEMBER_SENT_LIST
        : key === "resend" ? "20261022171700_roster_invitation_import.sql"
        : president ? "20261004040000_president_own_chapter_invitations.sql" : `${MIGRATION}.sql`;
      expect(name, key).toBe(expected);
      expect(body, key).toMatch(/\$function\$\s*begin\s+perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);\s*declare/);
      expect(body, key).toContain(president
        ? "caller_chapter text := private.require_member_invitation_inviter_chapter();"
        : "caller_chapter text := private.require_member_invitation_admin_chapter();");
      expect(body, key).toContain("private.member_invitation_chapter_administrable(");
      expect(body, key).not.toContain("chapter_id = caller_chapter");
      expect(body, key).not.toContain("p_chapter_id is distinct from caller_chapter");
    }
    // Unit-required creation lives in the seven-argument core.
    const create = latestFunction(SIGNATURES.create.replace("p_token_hash text)","p_token_hash text, p_unit_id uuid)")).body;
    expect(create.indexOf("member_invitation_chapter_administrable")).toBeLessThan(create.indexOf("consume_member_invitation_admin_limit"));
    expect(create).toContain("'chapter:' || target_chapter");
    expect(create).toContain("clean_email, clean_name, clean_first, clean_initials, target_chapter,");
    const former = latestFunction(SIGNATURES.former).body;
    expect(former).toContain("not private.has_organization_role(target_org, array['admin'])");
    expect(former.indexOf("member_invitation_chapter_administrable")).toBeLessThan(former.indexOf("consume_member_invitation_admin_limit"));
    expect(former).toContain("locked_org is distinct from target_org");
    const list = latestFunction(SIGNATURES.list).body;
    expect(list).toContain("'chapters', coalesce((");
    // The cap stays per chapter: one busy chapter cannot hide another's rows.
    expect(list).toContain("from pg_catalog.unnest(administrable || presided) as a(chapter_id)\n      cross join lateral (");
    expect(list).toContain("where i.chapter_id = a.chapter_id and i.status <> 'superseded'");
    expect(list).toContain("'chapterName', s.chapter_name");
  });

  it("pins the new helper and the changed bodies in the database contract", () => {
    const helper = contract.functions.find((row) => row.sig === "private.member_invitation_chapter_administrable(p_chapter_id text)");
    expect(helper).toMatchObject({ secdef: true, exec: "" });
    expect(helper.bodyContains).toContain("target.organization_id = selected.organization_id");
    for (const sig of [
      "public.create_member_invitation(p_email text, p_full_name text, p_chapter_id text, p_initial_role text, p_locale text, p_token_hash text)",
      "public.create_former_member_invitation(p_email text, p_chapter_id text, p_locale text, p_token_hash text)",
      "public.get_member_invitations(p_limit integer)",
      "public.resend_member_invitation(p_invitation_id uuid, p_token_hash text)",
      "public.revoke_member_invitation(p_invitation_id uuid)",
      "public.record_member_invitation_delivery(p_invitation_id uuid, p_delivery_version integer, p_outcome text)",
    ]) {
      // Unit-required creation lives in the seven-argument core.
      const actual = sig === SIGNATURES.create ? sig.replace("p_token_hash text)","p_token_hash text, p_unit_id uuid)") : sig;
      const row = contract.functions.find((entry) => entry.sig === actual);
      expect(row, sig).toBeDefined();
      expect(row.bodyContains.join("\n"), sig).toContain("private.member_invitation_chapter_administrable(");
      expect(row.bodyContains.join("\n"), sig).not.toContain("chapter_id = caller_chapter");
    }
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("invitation target chapter on a disposable database", () => {
  let client;

  beforeAll(async () => {
    assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    client = new pg.Client({
      connectionString: process.env.SUPABASE_DB_URL,
      application_name: "invitation-target-chapter-admin-rollback-proof",
    });
    await client.connect();
    await client.query("set statement_timeout = '10s'");
  });

  afterAll(async () => {
    await client?.end();
  });

  async function tenants() {
    const orgA = randomUUID();
    const orgB = randomUUID();
    const local = `hwl7-local-${orgA}`;
    const hhs = `hwl7-hhs-${orgA}`;
    const transit = `hwl7-transit-${orgA}`;
    const other = `rtl9-a-${orgB}`;
    await client.query(
      "insert into public.organizations(id,slug,name) values ($1,$2,$3), ($4,$5,$6)",
      [orgA, `hwl7-${orgA}`, `Harbor Workers Local 7 ${orgA}`, orgB, `rtl9-${orgB}`, `Ridge Transit Local 9 ${orgB}`],
    );
    await client.query(
      `insert into public.chapters(id,name,slug,region,organization_id,order_index)
       values ($1,'Harbor Local',$1,'proof',$5,9941), ($2,'HHS Chapter',$2,'proof',$5,9942),
              ($3,'Transit Chapter',$3,'proof',$5,9943), ($4,'Ridge Chapter',$4,'proof',$6,9944)`,
      [local, hhs, transit, other, orgA, orgB],
    );
    return { orgA, orgB, local, hhs, transit, other };
  }

  async function person({ chapter, organization, memberships = [chapter] }) {
    const id = randomUUID();
    await client.query("insert into auth.users(id,email) values ($1,$2)", [id, `${id}@example.invalid`]);
    await client.query("update public.member_profiles set chapter_id=$2 where id=$1", [id, chapter]);
    await client.query(
      "insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active') on conflict do nothing",
      [organization, id],
    );
    for (const membership of memberships) {
      await client.query(
        "insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active') on conflict do nothing",
        [id, membership],
      );
    }
    return id;
  }

  // An admin of each chapter in adminOf, selected into `chapter`.
  async function admin(t, { chapter = t.local, adminOf = [t.local], organizationAdmin = false } = {}) {
    const id = await person({ chapter, organization: t.orgA, memberships: [...new Set([chapter, ...adminOf])] });
    await client.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,'admin',$2)", [id, chapter]);
    for (const adminChapter of adminOf) {
      await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,'admin',$2)", [id, adminChapter]);
    }
    if (organizationAdmin) {
      await client.query("insert into public.organization_role_grants(organization_id,user_id,role) values ($1,$2,'admin')", [t.orgA, id]);
    }
    await client.query(
      "insert into auth.mfa_factors(id,user_id,factor_type,status,created_at,updated_at) values ($1,$2,'totp','verified',now(),now())",
      [randomUUID(), id],
    );
    return id;
  }

  async function steward(t) {
    const id = await person({ chapter: t.local, organization: t.orgA });
    await client.query("insert into public.member_roles(user_id,role,chapter_id) values ($1,'steward',$2)", [id, t.local]);
    await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,'steward',$2)", [id, t.local]);
    return id;
  }

  async function actAs(userId) {
    const session = randomUUID();
    await client.query(
      "insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now())",
      [session, userId],
    );
    await client.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2", session_id: session }),
    ]);
    await client.query("set local role authenticated");
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
      return { ok: true, value: result.rows[0]?.v ?? null, code: "", message: "" };
    } catch (error) {
      await client.query("rollback to savepoint cell");
      return { ok: false, value: null, code: error.code || "", message: error.message || "" };
    }
  }

  const create = (email, chapter, hash) => capture(
    "select public.create_member_invitation($1,'Proof Invitee',$2,null,'en',$3) as v", [email, chapter, hash],
  );
  const list = () => capture("select public.get_member_invitations(50) as v", []);
  const resend = (id, hash) => capture("select public.resend_member_invitation($1,$2) as v", [id, hash]);
  const revoke = (id) => capture("select public.revoke_member_invitation($1) as v", [id]);
  const record = (id, version, outcome) => capture(
    "select public.record_member_invitation_delivery($1,$2,$3) as v", [id, version, outcome],
  );
  const selectedChapter = async (id) => (
    await client.query("select chapter_id from public.member_profiles where id=$1", [id])
  ).rows[0].chapter_id;
  const invitationRow = async (id) => (
    await client.query("select chapter_id, status, delivery_version, sent_at from public.member_invitations where id=$1", [id])
  ).rows[0];

  it("lets an admin of two chapters invite into the other one, list and manage it, without changing the selected chapter", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const multi = await admin(t, { adminOf: [t.local, t.hhs] });

      await actAs(multi);
      const created = await create(`invitee-${randomUUID()}@example.invalid`, t.hhs, HASH("b1"));
      const listed = await list();
      await asOwner();
      expect(created.ok, created.message).toBe(true);
      expect(created.value).toMatchObject({ accepted: true, send: true });
      const invitationId = created.value.invitationId;
      expect(await invitationRow(invitationId)).toMatchObject({ chapter_id: t.hhs, status: "pending" });
      const audit = (await client.query(
        "select action, chapter_id, detail from public.member_invitation_audit where invitation_id=$1", [invitationId],
      )).rows;
      expect(audit).toEqual([expect.objectContaining({ action: "invite_requested", chapter_id: t.hhs })]);
      expect(audit[0].detail.chapterId).toBe(t.hhs);
      expect(await selectedChapter(multi)).toBe(t.local);

      expect(listed.ok, listed.message).toBe(true);
      expect(listed.value.chapter).toEqual({ id: t.local, name: "Harbor Local" });
      expect(listed.value.chapters).toEqual([{ id: t.local, name: "Harbor Local", grantsAccess: true }, { id: t.hhs, name: "HHS Chapter", grantsAccess: true }]);
      expect(listed.value.items).toEqual([expect.objectContaining({ id: invitationId, chapterId: t.hhs, chapterName: "HHS Chapter" })]);

      await actAs(multi);
      const recorded = await record(invitationId, 1, "sent");
      const resent = await resend(invitationId, HASH("b2"));
      await asOwner();
      expect(recorded.value).toEqual({ recorded: true });
      expect(resent.ok, resent.message).toBe(true);
      expect(resent.value).toMatchObject({ accepted: true, send: true, deliveryVersion: 2 });
      expect(await invitationRow(resent.value.invitationId)).toMatchObject({ chapter_id: t.hhs, status: "pending", delivery_version: 2 });

      await actAs(multi);
      const revoked = await revoke(resent.value.invitationId);
      await asOwner();
      expect(revoked.value).toEqual({ accepted: true, revoked: true });
      expect((await invitationRow(resent.value.invitationId)).status).toBe("revoked");
      expect(await selectedChapter(multi)).toBe(t.local);
    } finally {
      await client.query("rollback");
    }
  });

  it("caps the list per chapter, so a busy chapter cannot hide the selected chapter's invitations", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const multi = await admin(t, { adminOf: [t.local, t.hhs] });

      await actAs(multi);
      const localIds = [];
      for (const hash of ["c7", "c8"]) {
        localIds.push((await create(`local-${randomUUID()}@example.invalid`, t.local, HASH(hash))).value.invitationId);
      }
      // Newer rows in HHS than every Harbor Local row.
      for (const hash of ["c9", "ca", "cb"]) {
        const result = await create(`hhs-${randomUUID()}@example.invalid`, t.hhs, HASH(hash));
        expect(result.ok, result.message).toBe(true);
      }
      await client.query("reset role");
      await client.query(
        "update public.member_invitations set created_at = created_at - interval '1 hour' where id = any($1::uuid[])", [localIds],
      );
      await client.query("set local role authenticated");
      const listed = await capture("select public.get_member_invitations(2) as v", []);
      await asOwner();

      expect(listed.ok, listed.message).toBe(true);
      const byChapter = listed.value.items.reduce((counts, item) => ({ ...counts, [item.chapterId]: (counts[item.chapterId] ?? 0) + 1 }), {});
      // The cap bounds each chapter's history; live invitations are always
      // listed (20261022171700), so all three live HHS rows appear and HHS
      // still cannot push Harbor Local's rows out.
      expect(byChapter).toEqual({ [t.local]: 2, [t.hhs]: 3 });
      expect(listed.value.items.filter((item) => item.chapterId === t.local).map((item) => item.id).sort()).toEqual([...localIds].sort());
    } finally {
      await client.query("rollback");
    }
  });

  it("refuses a chapter the caller does not administer and hides its invitations from list, resend, revoke and delivery", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const multi = await admin(t, { adminOf: [t.local, t.hhs] });
      const single = await admin(t, { adminOf: [t.local] });

      await actAs(multi);
      const hhsInvite = await create(`invitee-${randomUUID()}@example.invalid`, t.hhs, HASH("c1"));
      await asOwner();
      expect(hhsInvite.ok, hhsInvite.message).toBe(true);
      const hhsId = hhsInvite.value.invitationId;

      await actAs(single);
      const refused = await create(`invitee-${randomUUID()}@example.invalid`, t.hhs, HASH("c2"));
      const notAdministered = await create(`invitee-${randomUUID()}@example.invalid`, t.transit, HASH("c3"));
      const missing = await create(`invitee-${randomUUID()}@example.invalid`, `no-such-${randomUUID()}`, HASH("c4"));
      const control = await create(`invitee-${randomUUID()}@example.invalid`, t.local, HASH("c5"));
      const listed = await list();
      const resent = await resend(hhsId, HASH("c6"));
      const recorded = await record(hhsId, 1, "failed");
      const revoked = await revoke(hhsId);
      await asOwner();

      for (const result of [refused, notAdministered, missing]) {
        expect(result.ok).toBe(false);
        expect(result.code).toBe("42501");
        expect(result.message).toBe("invitation not permitted");
      }
      expect(control.ok, control.message).toBe(true);
      expect(listed.value.chapters).toEqual([{ id: t.local, name: "Harbor Local", grantsAccess: true }]);
      expect(listed.value.items.map((item) => item.chapterId)).toEqual([t.local]);
      expect(resent.value).toEqual({ accepted: true, send: false });
      expect(recorded.value).toEqual({ recorded: false });
      expect(revoked.value).toEqual({ accepted: true, revoked: false });
      expect(await invitationRow(hhsId)).toMatchObject({ chapter_id: t.hhs, status: "pending", delivery_version: 1, sent_at: null });
    } finally {
      await client.query("rollback");
    }
  });

  it("keeps an admin of two organizations inside the selected one for create, list, resend, revoke and delivery", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      // Admin of the selected Harbor chapter AND of a Ridge Transit chapter.
      // Both member_has_chapter_role and the invitation helper scope to the
      // selected organization, so nothing reaches Ridge from this desk.
      const dual = await admin(t, { adminOf: [t.local] });
      await client.query(
        "insert into public.organization_memberships(organization_id,user_id,status) values ($1,$2,'active')", [t.orgB, dual],
      );
      await client.query(
        "insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [dual, t.other],
      );
      await client.query("insert into public.member_role_chapters(user_id,role,chapter_id) values ($1,'admin',$2)", [dual, t.other]);
      const foreign = (await client.query(
        `insert into public.member_invitations
           (normalized_email, full_name, first_name, initials, chapter_id, initial_role, locale,
            token_hash, status, delivery_version, invited_by, expires_at)
         values ($1, 'Ridge Invitee', 'Ridge', 'RI', $2, null, 'en', $3, 'pending', 1, $4,
                 clock_timestamp() + interval '15 minutes')
         returning id`,
        [`ridge-${randomUUID()}@example.invalid`, t.other, HASH("d0"), dual],
      )).rows[0].id;

      await actAs(dual);
      const crossTenant = await create(`invitee-${randomUUID()}@example.invalid`, t.other, HASH("d1"));
      const sameTenant = await create(`invitee-${randomUUID()}@example.invalid`, t.local, HASH("d2"));
      const listed = await list();
      const resent = await resend(foreign, HASH("d3"));
      const recorded = await record(foreign, 1, "sent");
      const revoked = await revoke(foreign);
      await asOwner();

      expect(crossTenant).toMatchObject({ ok: false, code: "42501", message: "invitation not permitted" });
      expect(sameTenant.ok, sameTenant.message).toBe(true);
      expect(listed.value.chapters).toEqual([{ id: t.local, name: "Harbor Local", grantsAccess: true }]);
      expect(listed.value.items.map((item) => item.chapterId)).not.toContain(t.other);
      expect(resent.value).toEqual({ accepted: true, send: false });
      expect(recorded.value).toEqual({ recorded: false });
      expect(revoked.value).toEqual({ accepted: true, revoked: false });
      expect(await invitationRow(foreign)).toMatchObject({ chapter_id: t.other, status: "pending", delivery_version: 1, sent_at: null });
      const ridgeRows = (await client.query(
        "select count(*)::int as n from public.member_invitations where chapter_id=$1", [t.other],
      )).rows[0].n;
      expect(ridgeRows).toBe(1);
    } finally {
      await client.query("rollback");
    }
  });

  it("lets an organization admin invite into every chapter they belong to, and no other", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      // Organization admin grant plus memberships in Harbor Local and HHS; the
      // chapter-scoped admin role covers Harbor Local only.
      const orgAdmin = await admin(t, { adminOf: [t.local], organizationAdmin: true });
      await client.query(
        "insert into public.member_chapter_memberships(user_id,chapter_id,status) values ($1,$2,'active')", [orgAdmin, t.hhs],
      );

      await actAs(orgAdmin);
      const intoHhs = await create(`invitee-${randomUUID()}@example.invalid`, t.hhs, HASH("a7"));
      const intoTransit = await create(`invitee-${randomUUID()}@example.invalid`, t.transit, HASH("a8"));
      const listed = await list();
      await asOwner();

      expect(intoHhs.ok, intoHhs.message).toBe(true);
      expect(await invitationRow(intoHhs.value.invitationId)).toMatchObject({ chapter_id: t.hhs });
      expect(intoTransit).toMatchObject({ ok: false, code: "42501", message: "invitation not permitted" });
      expect(listed.value.chapters).toEqual([{ id: t.local, name: "Harbor Local", grantsAccess: true }, { id: t.hhs, name: "HHS Chapter", grantsAccess: true }]);
      expect(await selectedChapter(orgAdmin)).toBe(t.local);
    } finally {
      await client.query("rollback");
    }
  });

  it("refuses a steward at the desk gate before any chapter is considered", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const stewardId = await steward(t);
      const multi = await admin(t, { adminOf: [t.local, t.hhs] });

      await actAs(stewardId);
      const refused = await create(`invitee-${randomUUID()}@example.invalid`, t.local, HASH("e1"));
      const refusedList = await list();
      await asOwner();
      await actAs(multi);
      const control = await create(`invitee-${randomUUID()}@example.invalid`, t.local, HASH("e2"));
      await asOwner();

      expect(refused).toMatchObject({ ok: false, code: "42501", message: "admin role required" });
      expect(refusedList).toMatchObject({ ok: false, code: "42501", message: "admin role required" });
      expect(control.ok, control.message).toBe(true);
    } finally {
      await client.query("rollback");
    }
  });

  it("lets an organization admin re-invite a former member into another administered chapter, never into another organization", async () => {
    await client.query("begin");
    try {
      const t = await tenants();
      const orgAdmin = await admin(t, { adminOf: [t.local, t.hhs], organizationAdmin: true });
      const former = await person({ chapter: null, organization: t.orgA, memberships: [t.hhs] });
      await client.query(
        "update public.member_chapter_memberships set status='revoked', revoked_at=now() where user_id=$1", [former],
      );
      await client.query(
        "update public.organization_memberships set status='revoked', revoked_at=now() - interval '2 days' where organization_id=$1 and user_id=$2",
        [t.orgA, former],
      );
      const formerEmail = (await client.query("select email from auth.users where id=$1", [former])).rows[0].email;

      await actAs(orgAdmin);
      const foreign = await capture(
        "select public.create_former_member_invitation($1,$2,'en',$3) as v", [formerEmail, t.other, HASH("f1")],
      );
      const reinvited = await capture(
        "select public.create_former_member_invitation($1,$2,'en',$3) as v", [formerEmail, t.hhs, HASH("f2")],
      );
      await asOwner();

      expect(foreign.ok).toBe(false);
      expect(foreign.code).toBe("42501");
      expect(reinvited.ok, reinvited.message).toBe(true);
      expect(reinvited.value).toMatchObject({ accepted: true, send: true });
      expect(await invitationRow(reinvited.value.invitationId)).toMatchObject({ chapter_id: t.hhs, status: "pending" });
      expect(await selectedChapter(orgAdmin)).toBe(t.local);
    } finally {
      await client.query("rollback");
    }
  });
});
