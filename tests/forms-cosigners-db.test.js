// @vitest-environment node
import { scopeFixtureSteward } from "./helpers/steward-unit-fixtures.js";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl, assertDisposableStorageStatus } from "../scripts/run-required-db-proofs.mjs";

// Real PostgREST and RLS, on the required runner's owned local stack only.
// HTTP reads need committed fixtures; every fixture is random and removed below.
describe.skipIf(!process.env.SUPABASE_DB_URL)("alliance co-signer privacy on the complete schema", () => {
  const orgs = [randomUUID(), randomUUID()];
  const chapters = orgs.map(id => `cosign-${id}`);
  const forms = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const users = {};
  const clients = {};
  const options = { auth: { persistSession: false, autoRefreshToken: false } };
  let db, admin, status;

  beforeAll(async () => {
    const connectionString = assertDisposableProofUrl(process.env.SUPABASE_DB_URL);
    status = assertDisposableStorageStatus(
      JSON.parse(readFileSync(process.env.PRIVATE_FILE_STORAGE_STATUS_FILE, "utf8")), connectionString,
    );
    db = new pg.Client({ connectionString, application_name: "alliance-cosigner-privacy-proof" });
    await db.connect();
    await db.query("set lock_timeout='5s'; set statement_timeout='30s'");
    admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, options);
    for (const name of ["filer", "cosigner", "reviewer", "outsider", "foreignReviewer"]) {
      const email = `${chapters[0]}-${name}@example.invalid`;
      const password = `Local-proof!${randomUUID()}`;
      const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (created.error) throw created.error;
      users[name] = { id: created.data.user.id, email };
      const client = createClient(status.API_URL, status.ANON_KEY, options);
      const signedIn = await client.auth.signInWithPassword({ email, password });
      if (signedIn.error) throw signedIn.error;
      clients[name] = client;
    }
    for (let index = 0; index < orgs.length; index += 1) {
      await db.query("insert into public.organizations(id,slug,name,created_by) values($1,$2,$2,$3)",
        [orgs[index], chapters[index], users.filer.id]);
      await db.query("insert into public.org_security_policy(id,organization_id,require_staff_mfa) values(true,$1,false)", [orgs[index]]);
      await db.query("insert into public.chapters(id,name,slug,organization_id,is_default,order_index) values($1,$1,$1,$2,false,9950)",
        [chapters[index], orgs[index]]);
    }
    for (const [name, user] of Object.entries(users)) {
      const index = ["outsider", "foreignReviewer"].includes(name) ? 1 : 0;
      await db.query("insert into public.organization_memberships(organization_id,user_id,status) values($1,$2,'active')", [orgs[index], user.id]);
      await db.query("insert into public.member_chapter_memberships(user_id,chapter_id,status) values($1,$2,'active')", [user.id, chapters[index]]);
      await db.query("update public.member_profiles set chapter_id=$2 where id=$1", [user.id, chapters[index]]);
    }
    // A reviewer in each tenant exercises both positive and cross-tenant scope.
    await db.query("begin");
    for (const [name, index] of [["reviewer", 0], ["foreignReviewer", 1]]) {
      await db.query("insert into public.organization_role_grants(organization_id,user_id,role) values($1,$2,'steward')",
        [orgs[index], users[name].id]);
      await db.query("insert into public.member_roles(user_id,role,chapter_id) values($1,'steward',$2) on conflict do nothing",
        [users[name].id, chapters[index]]);
      await db.query("insert into public.member_role_chapters(user_id,role,chapter_id) values($1,'steward',$2) on conflict do nothing",
        [users[name].id, chapters[index]]);
    }
    // Committed reviewers choose the default unit.
    for (const [name,index] of [["reviewer",0],["foreignReviewer",1]]) await scopeFixtureSteward(db,users[name].id,chapters[index]);
    await db.query("commit");
    for (let index = 0; index < forms.length; index += 1) {
      await db.query(`insert into public.member_forms
        (id,user_id,template_key,template_version,status,answers,submitted_at)
        values($1,$2,$3,1,$4,'{}',case when $4='draft' then null else now() end)`,
      [forms[index], users.filer.id, index === 3 ? "grievance" : "alliance_grievance",
        ["submitted", "in_review", "draft", "submitted"][index]]);
      await db.query(`insert into public.member_form_cosigners
        (form_id,invited_email,cosigner_user_id,status,invited_by,responded_at,signed_at)
        values($1,$2,$3,'accepted',$4,now(),now())`,
      [forms[index], users.cosigner.email, users.cosigner.id, users.filer.id]);
    }
    await db.query("insert into public.member_form_cosigners(form_id,invited_email,status,invited_by) values($1,$2,'invited',$3)",
      [forms[0], `${chapters[0]}-pending@example.invalid`, users.filer.id]);
  }, 90000);

  afterAll(async () => {
    const failures = [];
    const clean = async operation => { try { await operation(); } catch (error) { failures.push(error); } };
    if (db) {
      await clean(() => db.query("delete from public.member_forms where id=any($1::uuid[])", [forms]));
      const userIds = Object.values(users).map(user => user.id);
      // Chapter deletion sets role chapter_ids to null, which the role guard
      // rightly refuses. Remove this fixture's grants before its chapters.
      // An organization steward grant needs a unit in each
      // chapter while it survives, so it goes before the memberships.
      await clean(() => db.query("delete from public.organization_role_grants where organization_id=any($1::uuid[])", [orgs]));
      await clean(() => db.query("delete from public.member_roles where user_id=any($1::uuid[])", [userIds]));
      await clean(() => db.query("delete from public.member_role_chapters where user_id=any($1::uuid[])", [userIds]));
      await clean(() => db.query("update public.member_profiles set chapter_id=null where id=any($1::uuid[])", [userIds]));
      await clean(() => db.query("delete from public.member_chapter_memberships where user_id=any($1::uuid[])", [userIds]));
      await clean(() => db.query("delete from public.chapters where id=any($1::text[])", [chapters]));
      for (const table of ["organization_role_grants", "organization_memberships", "dues_member_subjects", "org_security_policy"]) {
        await clean(() => db.query(`delete from public.${table} where organization_id=any($1::uuid[])`, [orgs]));
      }
      await clean(() => db.query("delete from public.organizations where id=any($1::uuid[])", [orgs]));
      for (const user of Object.values(users)) {
        await clean(async () => { const result = await admin.auth.admin.deleteUser(user.id); if (result.error) throw result.error; });
      }
      await clean(() => db.end());
    }
    if (failures.length) throw new AggregateError(failures, "Co-signer privacy fixture cleanup failed");
  }, 90000);

  async function read(name, table, formIds = forms) {
    const result = await clients[name].from(table).select(table === "member_forms" ? "id" : "form_id,status")
      .in(table === "member_forms" ? "id" : "form_id", formIds);
    expect(result.error).toBeNull();
    return result.data;
  }

  it("refuses the tenant-B member's public RPC for tenant-A submitted and unknown form UUIDs", async () => {
    for (const id of [forms[0], randomUUID()]) {
      const result = await clients.outsider.rpc("form_is_alliance_reviewable", { p_form_id: id });
      expect(result.error, `public RPC must refuse ${id}; received ${JSON.stringify(result.data)}`).not.toBeNull();
      expect(["PGRST202", "42501", "42883"]).toContain(result.error.code);
      expect(result.data).toBeNull();
    }
  });

  it("does not expose the private helper through a requested API schema", async () => {
    const result = await clients.outsider.schema("private").rpc("form_is_alliance_reviewable", { p_form_id: forms[0] });
    expect(result.error?.code).toBe("PGRST106");
    expect(result.data).toBeNull();
  });

  it("keeps every own invitation visible to the filer", async () => {
    const rows = await read("filer", "member_form_cosigners", [forms[0]]);
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      { form_id: forms[0], status: "accepted" }, { form_id: forms[0], status: "invited" },
    ]));
    expect(await read("filer", "member_forms")).toHaveLength(4);
  });

  it("keeps only the accepted co-signer's own row and full alliance form visible", async () => {
    expect(await read("cosigner", "member_form_cosigners", [forms[0]])).toEqual([{ form_id: forms[0], status: "accepted" }]);
    expect(await read("cosigner", "member_forms", [forms[0]])).toEqual([{ id: forms[0] }]);
    expect(await read("cosigner", "member_forms", [forms[3]])).toEqual([]);
  });

  it("keeps the reviewer's accepted-only, review-state and alliance-template filters", async () => {
    const rows = await read("reviewer", "member_form_cosigners");
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining(forms.slice(0, 2).map(form_id => ({ form_id, status: "accepted" }))));
  });

  it("keeps another tenant's steward outside the form and co-signer policies", async () => {
    for (const name of ["outsider", "foreignReviewer"]) {
      expect(await read(name, "member_forms")).toEqual([]);
      expect(await read(name, "member_form_cosigners")).toEqual([]);
    }
  });
});
