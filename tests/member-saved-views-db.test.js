// @vitest-environment node
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.RUN_MEMBER_SAVED_VIEWS_DB_TESTS === "1" ? describe : describe.skip;
const ids = {
  owner: "50952000-0000-4000-8000-000000000001",
  other: "50952000-0000-4000-8000-000000000002",
  departing: "50952000-0000-4000-8000-000000000003",
  org: "50952000-0000-4000-8000-000000000010",
  closingOrg: "50952000-0000-4000-8000-000000000011",
  ownerSession: "50952000-0000-4000-8000-000000000101",
  otherSession: "50952000-0000-4000-8000-000000000102",
  ownerAal1Session: "50952000-0000-4000-8000-000000000103",
};
const sessionOf = { [ids.owner]: ids.ownerSession, [ids.other]: ids.otherSession };
const definition = { filters: { step: "Step 2", caseType: "", assignee: "", deadline: "7days", status: "active", chapter: "" }, sorting: [{ id: "deadline", desc: false }] };

// Every RPC re-states the assurance floor itself, so the proof session must be
// a real, MFA-satisfied one: an auth.sessions row the JWT's session_id resolves
// to, at aal2. A bare `sub` claim is exactly what private.mfa_satisfied()
// refuses, and the refusal case below pins that.
async function asUser(client, id, { session = sessionOf[id], aal = "aal2" } = {}) {
  await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: id, role: "authenticated", session_id: session, aal })]);
  await client.query("select set_config('app.saved_view_org', $1, true)", [ids.org]);
  await client.query("set local role authenticated");
}

live("member saved views", () => {
  let client;

  beforeAll(async () => {
    client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "member-saved-views-proof" });
    await client.connect();
    await client.query("begin");
    await client.query("insert into auth.users(id,email,raw_user_meta_data) values ($1,$2,'{}'::jsonb),($3,$4,'{}'::jsonb),($5,$6,'{}'::jsonb)", [ids.owner, "saved-view-owner@example.invalid", ids.other, "saved-view-other@example.invalid", ids.departing, "saved-view-departing@example.invalid"]);
    await client.query("insert into public.organizations(id,slug,name,status) values ($1,'saved-views-proof','Saved views proof','active')", [ids.org]);
    // The production resolver joins complete membership state. This test is
    // about owner isolation inside this new table/RPC, so a transactional
    // resolver fixture provides one active organization without inventing a
    // tenant outside the disposable database.
    await client.query("create or replace function private.current_member_organization() returns uuid language sql stable security definer set search_path = '' as $$ select current_setting('app.saved_view_org', true)::uuid $$");
    await client.query("insert into auth.sessions(id,user_id,aal,created_at,updated_at) values ($1,$2,'aal2',now(),now()),($3,$4,'aal2',now(),now()),($5,$2,'aal1',now(),now())", [ids.ownerSession, ids.owner, ids.otherSession, ids.other, ids.ownerAal1Session]);
    await client.query("grant select on public.member_saved_views to authenticated");
  });

  afterAll(async () => { if (client) { await client.query("rollback").catch(() => {}); await client.end(); } });

  it("creates, lists, updates, defaults, and deletes an owner's saved views", async () => {
    await asUser(client, ids.owner);
    const first = (await client.query("select public.save_member_saved_view(null, 'coordinator', 'Urgent', $1::jsonb, true) as view", [JSON.stringify(definition)])).rows[0].view;
    expect(first).toMatchObject({ name: "Urgent", isDefault: true, definition });
    const updatedDefinition = { ...definition, sorting: [{ id: "member", desc: true }] };
    const updated = (await client.query("select public.save_member_saved_view($1, 'coordinator', 'Urgent today', $2::jsonb, false) as view", [first.id, JSON.stringify(updatedDefinition)])).rows[0].view;
    expect(updated).toMatchObject({ id: first.id, name: "Urgent today", isDefault: false, definition: updatedDefinition });
    const listed = (await client.query("select public.list_member_saved_views('coordinator') as views")).rows[0].views;
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(first.id);
    await client.query("select public.delete_member_saved_view($1)", [first.id]);
    expect((await client.query("select public.list_member_saved_views('coordinator') as views")).rows[0].views).toEqual([]);
  });

  it("keeps rows and RPC writes owner-only under RLS", async () => {
    await asUser(client, ids.owner);
    const ownerView = (await client.query("select public.save_member_saved_view(null, 'steward', 'Only me', $1::jsonb, false) as view", [JSON.stringify(definition)])).rows[0].view;
    await asUser(client, ids.other);
    expect((await client.query("select id from public.member_saved_views")).rows).toEqual([]);
    // Each expected rejection aborts the transaction unless it runs between a
    // savepoint and its rollback — the point is the refusal code, never a
    // poisoned transaction that hides the next assertion.
    await client.query("savepoint expected_hijack_rejection");
    await expect(client.query("select public.save_member_saved_view($1, 'steward', 'Hijacked', $2::jsonb, false)", [ownerView.id, JSON.stringify(definition)])).rejects.toMatchObject({ code: "42501" });
    await client.query("rollback to savepoint expected_hijack_rejection");
    await client.query("savepoint expected_delete_rejection");
    await expect(client.query("select public.delete_member_saved_view($1)", [ownerView.id])).rejects.toMatchObject({ code: "42501" });
    await client.query("rollback to savepoint expected_delete_rejection");
    // The owner cannot re-save an existing id under another plane either: the
    // upsert never rewrites plane, so a mismatch must refuse up front instead
    // of resetting the wrong plane's default and tripping the one-default index.
    await asUser(client, ids.owner);
    await client.query("savepoint expected_plane_rejection");
    await expect(client.query("select public.save_member_saved_view($1, 'coordinator', 'Only me', $2::jsonb, true)", [ownerView.id, JSON.stringify(definition)])).rejects.toMatchObject({ code: "42501" });
    await client.query("rollback to savepoint expected_plane_rejection");
  });

  it("refuses a session that does not satisfy the organization assurance policy", async () => {
    // The RPCs are SECURITY DEFINER and bypass the table's restrictive
    // mfa_assurance policy, so the assurance floor is re-stated inside each of
    // them. A verified TOTP factor plus an aal1 session is the real step-down.
    await client.query("reset role");
    await client.query("savepoint expected_assurance_rejection");
    await client.query("insert into auth.mfa_factors(id,user_id,friendly_name,factor_type,status,created_at,updated_at) values (gen_random_uuid(),$1,'proof totp','totp','verified',now(),now())", [ids.owner]);
    await asUser(client, ids.owner, { session: ids.ownerAal1Session, aal: "aal1" });
    await expect(client.query("select public.list_member_saved_views('coordinator')")).rejects.toMatchObject({ code: "42501" });
    await client.query("rollback to savepoint expected_assurance_rejection");
  });

  // public.member_saved_views deliberately carries no foreign key to auth.users
  // or to public.organizations (it would otherwise be conscripted into the
  // case-graph lock discipline), so the two AFTER DELETE statement triggers the
  // migration installs are the only thing standing between a deleted account or
  // a closed organization and an orphaned row. Both are proven here.
  it("removes the rows when the owning account is deleted", async () => {
    await client.query("reset role");
    await client.query("savepoint account_deletion_proof");
    await client.query(
      "insert into public.member_saved_views(user_id, organization_id, plane, name, definition) values ($1,$2,'coordinator','Departing view',$3::jsonb), ($4,$2,'coordinator','Surviving view',$3::jsonb)",
      [ids.departing, ids.org, JSON.stringify(definition), ids.owner],
    );
    expect((await client.query("select count(*)::int n from public.member_saved_views where user_id = $1", [ids.departing])).rows[0].n).toBe(1);
    await client.query("delete from auth.users where id = $1", [ids.departing]);
    expect((await client.query("select count(*)::int n from public.member_saved_views where user_id = $1", [ids.departing])).rows[0].n).toBe(0);
    // Only the deleted identity's rows go; a co-tenant's views are untouched.
    expect((await client.query("select count(*)::int n from public.member_saved_views where user_id = $1 and name = 'Surviving view'", [ids.owner])).rows[0].n).toBe(1);
    await client.query("rollback to savepoint account_deletion_proof");
  });

  it("removes the rows when the owning organization is deleted", async () => {
    await client.query("reset role");
    await client.query("savepoint organization_deletion_proof");
    await client.query("insert into public.organizations(id,slug,name,status) values ($1,'saved-views-proof-closing','Saved views closing tenant','active')", [ids.closingOrg]);
    await client.query(
      "insert into public.member_saved_views(user_id, organization_id, plane, name, definition) values ($1,$2,'steward','Closing tenant view',$3::jsonb), ($1,$4,'steward','Remaining tenant view',$3::jsonb)",
      [ids.owner, ids.closingOrg, JSON.stringify(definition), ids.org],
    );
    expect((await client.query("select count(*)::int n from public.member_saved_views where organization_id = $1", [ids.closingOrg])).rows[0].n).toBe(1);
    await client.query("delete from public.organizations where id = $1", [ids.closingOrg]);
    expect((await client.query("select count(*)::int n from public.member_saved_views where organization_id = $1", [ids.closingOrg])).rows[0].n).toBe(0);
    expect((await client.query("select count(*)::int n from public.member_saved_views where organization_id = $1 and name = 'Remaining tenant view'", [ids.org])).rows[0].n).toBe(1);
    await client.query("rollback to savepoint organization_deletion_proof");
  });
});
