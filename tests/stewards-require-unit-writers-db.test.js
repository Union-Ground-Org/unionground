// @vitest-environment node
// REQ-UG-STEWARDS-REQUIRE-A-UNIT-20261109 (#7663), gate round 1 of
// #8589: the writers that could still ask for a steward with no unit. A
// directory group mapped to Steward, and any unfinished steward invitation
// that names no unit, could never be finished once a steward needs a unit:
// finalize refuses it and the person does not even join. The migration's
// reset invites those people as plain members, with one audit row each.
import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findMigrationName, loadMigrationSql, migrationFiles } from "./helpers/migration.js";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const sql = loadMigrationSql("stewards_require_unit_with_carry_over");
const BEGIN = "-- BEGIN MIGRATION-ONLY UNIT-LESS STEWARD RESET (retained verbatim for its proof).";
const END = "-- END MIGRATION-ONLY UNIT-LESS STEWARD RESET.";
const reset = sql.split(BEGIN)[1]?.split(END)[0];
const NARROW_SCIM = "add constraint scim_groups_mapped_role check (mapped_role is null or mapped_role in ('coordinator','advisor'))";
// The invitation audit actions a migration's last check of that name allows.
const auditActions = (text) => {
  const checks = [...text.matchAll(/add\s+constraint\s+member_invitation_audit_action_check\s+check\s*\(\s*action\s+in\s*\(([^)]*)\)/gi)];
  return checks.length ? [...checks.at(-1)[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).sort() : null;
};

describe("unit-less steward reset contract", () => {
  it("runs once in the migration, after the audit action exists and before the SCIM constraint narrows", () => {
    expect(reset).toBeTruthy();
    expect(sql.split(BEGIN)).toHaveLength(2);
    expect(sql.indexOf("'invite_role_cleared'));")).toBeLessThan(sql.indexOf(BEGIN));
    expect(sql.indexOf(END)).toBeLessThan(sql.indexOf(NARROW_SCIM));
  });
  it("keeps every invitation audit action the previous definition allowed and adds only invite_role_cleared", () => {
    const own = findMigrationName("stewards_require_unit_with_carry_over");
    const previous = migrationFiles().filter((entry) => entry.name < own).map((entry) => auditActions(entry.sql)).filter(Boolean).at(-1);
    expect(previous).toContain("invite_restored");
    expect(auditActions(sql)).toEqual([...previous, "invite_role_cleared"].sort());
  });
  it("only lowers a role: no grant, unit link or carry-over is written", () => {
    expect(reset).not.toMatch(/insert\s+into\s+(?:public\.member_roles|public\.member_role_chapters|public\.organization_role_grants|private\.chapter_role_scopes|private\.member_invitation_units|private\.organization_steward_unit_assignments)/i);
    expect(reset).toContain("set initial_role=null");
    expect(reset).toContain("set mapped_role=null");
    expect(reset).toContain("private.member_invitation_selected_unit(invitation.id,invitation.chapter_id) is null");
  });
});

const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;
live("unit-less steward reset on an owned rollback database", () => {
  let db, f;
  const rows = async (query, args = []) => (await db.query(query, args)).rows;
  const capture = async (query, args = []) => {
    await db.query("savepoint writer_probe");
    try {
      const result = await db.query(query, args);
      await db.query("release savepoint writer_probe");
      return { ok: true, rows: result.rows };
    } catch (error) {
      await db.query("rollback to savepoint writer_probe");
      await db.query("release savepoint writer_probe");
      return { ok: false, code: error.code, message: error.message };
    }
  };
  const invitation = async (key, { role = "steward", status = "pending", invitedBy = f.admin, unit = null, replaces = null } = {}) => {
    const id = randomUUID();
    const email = `${key}-${f.org}@example.invalid`;
    const token = ["pending", "accepting"].includes(status) ? createHash("sha256").update(id).digest("hex") : null;
    await db.query(
      `insert into public.member_invitations(id,normalized_email,full_name,first_name,initials,chapter_id,initial_role,token_hash,status,
         invited_by,replaces_id,expires_at,accepting_at,revoked_at)
       values($1,$2,'Fictional Invitee','Fictional','FI',$3,$4,$5,$6,$7,$8,
         now() + case when $6='expired' then interval '-1 hour' else interval '15 minutes' end,
         case when $6='accepting' then now() end, case when $6='revoked' then now() end)`,
      [id, email, f.chapter, role, token, status, invitedBy, replaces]);
    if (unit) await db.query("insert into private.member_invitation_units(invitation_id,unit_id) values($1,$2)", [id, unit]);
    await db.query(
      "insert into public.member_invitation_audit(invitation_id,chapter_id,actor,action,detail) values($1,$2,$3,'invite_requested',$4)",
      [id, f.chapter, invitedBy, JSON.stringify({ chapterId: f.chapter, initialRole: role, ...(invitedBy ? {} : { source: "scim" }) })]);
    f.invitations[key] = { id, email };
    return id;
  };
  const finalize = async (key) => {
    const { id, email } = f.invitations[key];
    const user = randomUUID();
    await db.query("update public.member_invitations set status='accepting', accepting_at=now() where id=$1 and status='pending'", [id]);
    await db.query(
      `insert into auth.users(id,email,raw_user_meta_data,raw_app_meta_data,banned_until)
       values($1,$2,$3::jsonb,'{"union_ground_provisioning":"pending"}'::jsonb,now() + interval '1 hour')`,
      [user, email, JSON.stringify({ union_base_invitation_id: id, chapter_id: f.chapter })]);
    await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [user, f.chapter]);
    await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active') on conflict do nothing", [user, f.chapter]);
    await db.query("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ role: "service_role" })]);
    const result = await capture("select public.finalize_member_invitation($1,$2) as v", [id, user]);
    await db.query("select set_config('request.jwt.claims','',true)");
    return { ...result, user };
  };
  const roles = (user) => rows("select role,chapter_id from public.member_role_chapters where user_id=$1", [user]);
  const initialRoles = async () => {
    const found = {};
    for (const [key, { id }] of Object.entries(f.invitations)) found[key] = (await rows("select initial_role from public.member_invitations where id=$1", [id]))[0].initial_role;
    return found;
  };

  beforeEach(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "unit-less-steward-writer-proof" });
    await db.connect(); await db.query("begin");
    f = { org: randomUUID(), invitations: {} };
    f.chapter = "unitless-writers-" + f.org;
    await db.query("insert into public.organizations(id,slug,name) values($1::uuid,$1::text,'Fictional Directory Local')", [f.org]);
    await db.query("insert into public.chapters(id,name,slug,organization_id,order_index) values($1,'Directory chapter',$1,$2,9987)", [f.chapter, f.org]);
    f.defaultUnit = (await rows("select id from private.chapter_units where chapter_id=$1 and is_default", [f.chapter]))[0].id;
    f.admin = randomUUID();
    await db.query("insert into auth.users(id,email) values($1,$2)", [f.admin, `admin-${f.org}@example.invalid`]);
    await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [f.org, f.admin]);
    // Model rows written before #7663: the SCIM role check still allowed Steward.
    await db.query("alter table public.scim_groups drop constraint scim_groups_mapped_role");
    f.stewardGroup = randomUUID(); f.coordinatorGroup = randomUUID();
    await db.query("insert into public.scim_groups(id,organization_id,display_name,mapped_role) values($1,$3,'Stewards','steward'),($2,$3,'Coordinators','coordinator')",
      [f.stewardGroup, f.coordinatorGroup, f.org]);
  });
  afterEach(async () => { if (db) { await db.query("rollback"); await db.end(); } });

  it("refuses to finish a unit-less steward invitation before the reset, so the person cannot even join", async () => {
    await invitation("admin-accepting", { status: "accepting" });
    const refused = await finalize("admin-accepting");
    expect(refused).toMatchObject({ ok: false, code: "22023", message: "steward invitation requires a unit" });
  });

  it("invites unit-less steward invitees as plain members, keeps linked and finished ones, and audits each change once", async () => {
    await invitation("directory-pending", { invitedBy: null });
    await invitation("admin-accepting", { status: "accepting" });
    await invitation("admin-expired", { status: "expired" });
    await invitation("admin-failed", { status: "delivery_failed" });
    await invitation("linked-pending", { unit: f.defaultUnit });
    const original = await invitation("linked-original", { status: "superseded", unit: f.defaultUnit });
    await invitation("linked-resend", { replaces: original });
    await invitation("revoked", { status: "revoked" });
    await invitation("coordinator-pending", { role: "coordinator" });

    await db.query(reset);

    expect(await initialRoles()).toEqual({
      "directory-pending": null, "admin-accepting": null, "admin-expired": null, "admin-failed": null,
      "linked-pending": "steward", "linked-original": "steward", "linked-resend": "steward", revoked: "steward",
      "coordinator-pending": "coordinator",
    });
    const cleared = ["directory-pending", "admin-accepting", "admin-expired", "admin-failed"].map((key) => f.invitations[key].id).sort();
    const audits = await rows("select invitation_id,actor,detail from public.member_invitation_audit where action='invite_role_cleared' and chapter_id=$1 order by invitation_id", [f.chapter]);
    expect(audits.map((row) => row.invitation_id)).toEqual(cleared);
    for (const row of audits) {
      expect(row.actor).toBeNull();
      expect(row.detail).toMatchObject({ chapterId: f.chapter, previousRole: "steward", reason: "steward_requires_unit", source: "migration-7663" });
    }

    expect(await rows("select id,mapped_role from public.scim_groups where organization_id=$1 order by display_name", [f.org]))
      .toEqual([{ id: f.coordinatorGroup, mapped_role: "coordinator" }, { id: f.stewardGroup, mapped_role: null }]);
    expect(await rows("select actor,target_user,organization_id,detail from public.member_admin_audit where detail->>'organizationId'=$1 and action='role_scope_updated'", [f.org]))
      .toEqual([{ actor: null, target_user: null, organization_id: null, detail: { organizationId: f.org, provider: "scim", scimGroupId: f.stewardGroup, role: "steward", mappedRole: null, reason: "steward_requires_unit", source: "migration-7663" } }]);
    // The narrowed SCIM check validates against the reset rows.
    await db.query("alter table public.scim_groups " + NARROW_SCIM);

    // A second run finds nothing left to change.
    await db.query(reset);
    expect((await rows("select count(*)::int as n from public.member_invitation_audit where action='invite_role_cleared' and chapter_id=$1", [f.chapter]))[0].n).toBe(4);
    expect((await rows("select count(*)::int as n from public.member_admin_audit where detail->>'organizationId'=$1 and action='role_scope_updated'", [f.org]))[0].n).toBe(1);
  });

  it("lets a reset invitee finish joining as a plain member, and a linked steward invitee join in their unit", async () => {
    await invitation("directory-pending", { invitedBy: null });
    await invitation("admin-accepting", { status: "accepting" });
    const original = await invitation("linked-original", { status: "superseded", unit: f.defaultUnit });
    await invitation("linked-resend", { replaces: original });
    await db.query(reset);

    for (const key of ["directory-pending", "admin-accepting"]) {
      const joined = await finalize(key);
      expect(joined, joined.message).toMatchObject({ ok: true });
      expect(await roles(joined.user)).toEqual([]);
      expect(await rows("select status from public.member_chapter_memberships where user_id=$1 and chapter_id=$2", [joined.user, f.chapter])).toEqual([{ status: "active" }]);
    }
    const steward = await finalize("linked-resend");
    expect(steward, steward.message).toMatchObject({ ok: true });
    expect(await roles(steward.user)).toEqual([{ role: "steward", chapter_id: f.chapter }]);
    expect(await rows("select unit_id,committee_id,legacy_chapter_coverage from private.chapter_role_scopes where user_id=$1 and role='steward'", [steward.user]))
      .toEqual([{ unit_id: f.defaultUnit, committee_id: null, legacy_chapter_coverage: false }]);
    await db.query("set constraints all immediate");
  });

  // #8589 gate round 1 (P1 r3s4/r4s3): no writer can leave an open steward
  // invitation without a unit in its resend chain after the reset.
  it("refuses at commit an open steward invitation, or a resend of one, with no unit in its chain", async () => {
    await db.query(reset);
    const atCommit = async (write) => {
      await db.query("savepoint invitation_unit");
      let error;
      try { await write(); await db.query("set constraints all immediate"); } catch (caught) { error = caught; }
      await db.query("rollback to savepoint invitation_unit"); await db.query("release savepoint invitation_unit");
      await db.query("set constraints all deferred");
      return error;
    };
    expect(await atCommit(() => invitation("bare-pending"))).toMatchObject({ code: "23514", message: "steward invitation requires a unit" });
    expect(await atCommit(() => invitation("bare-expired", { status: "expired" }))).toMatchObject({ code: "23514" });
    expect(await atCommit(() => invitation("linked", { unit: f.defaultUnit }))).toBeUndefined();
    const linkedOriginal = await invitation("linked-original", { status: "superseded", unit: f.defaultUnit });
    expect(await atCommit(() => invitation("linked-resend", { replaces: linkedOriginal }))).toBeUndefined();
    const bareOriginal = await invitation("bare-original", { status: "superseded" });
    expect(await atCommit(() => invitation("bare-resend", { replaces: bareOriginal }))).toMatchObject({ code: "23514" });
    // Finished, member and coordinator invitations are untouched by the rule.
    expect(await atCommit(() => invitation("revoked", { status: "revoked" }))).toBeUndefined();
    expect(await atCommit(() => invitation("member", { role: null }))).toBeUndefined();
  });

  // #8589 gate round 2 (P1 r5s2/r6s3): deleting a unit cascades its
  // reservation links, so the reservation itself keeps the unit.
  it("refuses at commit removing a unit an open steward invitation or its resend still reserves", async () => {
    await db.query(reset);
    const atCommit = async (write) => {
      await db.query("savepoint unit_reservation");
      let error;
      try { await write(); await db.query("set constraints all immediate"); } catch (caught) { error = caught; }
      await db.query("rollback to savepoint unit_reservation"); await db.query("release savepoint unit_reservation");
      await db.query("set constraints all deferred");
      return error;
    };
    const unit = async () => (await rows("insert into private.chapter_units(organization_id,chapter_id,name) values($1,$2,$3) returning id", [f.org, f.chapter, "Fictional unit " + randomUUID().slice(0, 8)]))[0].id;
    const removeUnit = (id) => () => db.query("delete from private.chapter_units where id=$1", [id]);
    // Each invitation commits with its unit first, as a real one would.
    const settle = async () => { await db.query("set constraints all immediate"); await db.query("set constraints all deferred"); };
    const direct = await unit();
    await invitation("direct", { unit: direct }); await settle();
    expect(await atCommit(removeUnit(direct))).toMatchObject({ code: "23514", message: "unit is reserved by an open steward invitation: revoke the invitation or resend it with another unit first" });
    const inherited = await unit();
    const original = await invitation("original", { status: "superseded", unit: inherited });
    await invitation("resend", { replaces: original }); await settle();
    expect(await atCommit(removeUnit(inherited))).toMatchObject({ code: "23514" });
    // The reserving invitation itself cannot be deleted: its audit trail is
    // kept (on delete restrict), so its link never cascades away that way.
    expect(await atCommit(() => db.query("delete from public.member_invitations where id=$1", [original]))).toMatchObject({ code: "23503" });
    const finished = await unit();
    await invitation("finished", { status: "revoked", unit: finished }); await settle();
    expect(await atCommit(removeUnit(finished))).toBeUndefined();
  });

  // #8589 final: moving a reserved unit to another chapter (save_chapter_unit)
  // would leave the invitation's reservation in the wrong chapter.
  it("refuses at commit moving a unit an open steward invitation or its resend still reserves", async () => {
    await db.query(reset);
    const sibling = "unitless-sibling-" + f.org;
    await db.query("insert into public.chapters(id,name,slug,organization_id,order_index) values($1,'Sibling chapter',$1,$2,9988)", [sibling, f.org]);
    const settle = async () => { await db.query("set constraints all immediate"); await db.query("set constraints all deferred"); };
    const atCommit = async (write) => {
      await db.query("savepoint unit_move");
      let error;
      try { await write(); await db.query("set constraints all immediate"); } catch (caught) { error = caught; }
      await db.query("rollback to savepoint unit_move"); await db.query("release savepoint unit_move");
      await db.query("set constraints all deferred");
      return error;
    };
    const unit = async () => (await rows("insert into private.chapter_units(organization_id,chapter_id,name) values($1,$2,$3) returning id", [f.org, f.chapter, "Movable unit " + randomUUID().slice(0, 8)]))[0].id;
    const move = (id) => () => db.query("update private.chapter_units set chapter_id=$2 where id=$1", [id, sibling]);
    const direct = await unit();
    await invitation("direct", { unit: direct }); await settle();
    expect(await atCommit(move(direct))).toMatchObject({ code: "23514", message: "unit is reserved by an open steward invitation: revoke the invitation or resend it with another unit before moving the unit" });
    const inherited = await unit();
    const original = await invitation("original", { status: "superseded", unit: inherited });
    await invitation("resend", { replaces: original }); await settle();
    expect(await atCommit(move(inherited))).toMatchObject({ code: "23514" });
    const finished = await unit();
    await invitation("finished", { status: "revoked", unit: finished }); await settle();
    expect(await atCommit(move(finished))).toBeUndefined();
    expect(await atCommit(() => db.query("update private.chapter_units set name='Renamed unit' where id=$1", [direct]))).toBeUndefined();
  });

  it("refuses a raw Steward mapping on a directory group once the check narrows", async () => {
    await db.query(reset);
    await db.query("alter table public.scim_groups " + NARROW_SCIM);
    const raw = await capture("update public.scim_groups set mapped_role='steward' where id=$1", [f.coordinatorGroup]);
    expect(raw).toMatchObject({ ok: false, code: "23514" });
  });
});
