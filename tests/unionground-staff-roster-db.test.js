// @vitest-environment node
// D2 (owner decision, 2026-10-15): Organizers are staff. They appear on the
// staff roster and in the admin role counts, and they keep the staff two-step
// sign-in requirement: without a second factor an Organizer is told to enroll
// and holds no usable hat. Rolled back against the owned disposable stack.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const live = process.env.RUN_UNIONGROUND_STAFF_ROSTER_DB_TESTS === "1" ? describe : describe.skip;

live("Organizer hat on the staff roster", () => {
  let client;
  const organization = randomUUID();
  const chapter = `psg-roster-${organization}`;
  const admin = randomUUID();
  const organizer = randomUUID();
  const worker = randomUUID();
  const sessions = { admin: randomUUID(), organizer: randomUUID() };

  beforeAll(async () => {
    client = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), application_name: "unionground-staff-roster-proof" });
    await client.connect();
  });
  afterAll(async () => { await client?.end(); });
  beforeEach(async () => {
    const q = (sql, values) => client.query(sql, values);
    await q("begin");
    await q("insert into public.organizations (id, slug, name) values ($1, $2, 'Roster Proof Campaign Org')", [organization, chapter]);
    await q("insert into public.chapters (id, name, region, order_index, organization_id, slug) values ($1, 'Roster Proof Campaign', 'Local proof', 916, $2, $1)", [chapter, organization]);
    await q("insert into auth.users (id, email) select unnest($1::uuid[]), unnest($2::text[])",
      [[admin, organizer, worker], ["roster-admin@example.invalid", "roster-organizer@example.invalid", "roster-worker@example.invalid"]]);
    await q("insert into public.organization_memberships (organization_id, user_id) select $1, unnest($2::uuid[])", [organization, [admin, organizer, worker]]);
    await q("insert into public.member_chapter_memberships (user_id, chapter_id) select unnest($1::uuid[]), $2", [[admin, organizer, worker], chapter]);
    await q("update public.member_profiles set chapter_id = $2 where id = any($1::uuid[])", [[admin, organizer, worker], chapter]);
    await q("insert into public.member_roles (user_id, role, chapter_id) values ($1, 'admin', $3), ($2, 'organizer', $3)", [admin, organizer, chapter]);
    await q("insert into public.member_role_chapters (user_id, role, chapter_id) values ($1, 'admin', $3), ($2, 'organizer', $3) on conflict do nothing", [admin, organizer, chapter]);
    await q("insert into public.org_security_policy (id, organization_id, require_staff_mfa, updated_by) values (true, $1, true, $2)", [organization, admin]);
    await q("insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at) values ($1, $2, 'totp', 'verified', now(), now())", [randomUUID(), admin]);
    await q("insert into auth.sessions (id, user_id, aal, created_at) values ($1, $2, 'aal2', now()), ($3, $4, 'aal1', now())",
      [sessions.admin, admin, sessions.organizer, organizer]);
  });
  afterEach(async () => { await client.query("rollback"); });

  async function as(user, session, aal, sql) {
    await client.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: "authenticated", aal, session_id: session })]);
    await client.query("set local role authenticated");
    try {
      return (await client.query(sql)).rows[0].value;
    } finally {
      await client.query("reset role");
    }
  }

  it("lists the Organizer with the organizer hat on the staff roster, and never the worker", async () => {
    const roster = await as(admin, sessions.admin, "aal2", "select public.get_staff_roster() as value");
    const listed = roster.find((entry) => entry.userId === organizer);
    expect(listed?.roles).toEqual(["organizer"]);
    expect(listed?.chapterId).toBe(chapter);
    expect(roster.some((entry) => entry.userId === worker)).toBe(false);
  });

  it("counts Organizers in the admin overview role counts", async () => {
    const structure = await as(admin, sessions.admin, "aal2", "select public.get_admin_org_structure() as value");
    const counted = structure.chapters.find((entry) => entry.id === chapter);
    expect(counted.roleCounts).toEqual({ steward: 0, organizer: 1, coordinator: 0, advisor: 0, admin: 1, vp: 0 });
    expect(counted.staffCount).toBe(2);
    expect(counted.memberCount).toBe(3);
  });

  it("keeps the staff two-step sign-in requirement for Organizers", async () => {
    const standing = await as(organizer, sessions.organizer, "aal1", "select public.get_staff_mfa_standing() as value");
    expect(standing).toMatchObject({ requireStaffMfa: true, holdsStaffRole: true, enrolled: false, blocked: true });
    expect(await as(organizer, sessions.organizer, "aal1",
      `select private.member_has_chapter_role('${chapter}', array['organizer']) as value`)).toBe(false);

    const enrolled = randomUUID();
    await client.query("insert into auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at) values ($1, $2, 'totp', 'verified', now(), now())", [randomUUID(), organizer]);
    await client.query("insert into auth.sessions (id, user_id, aal, created_at) values ($1, $2, 'aal2', now())", [enrolled, organizer]);
    expect(await as(organizer, enrolled, "aal2",
      `select private.member_has_chapter_role('${chapter}', array['organizer']) as value`)).toBe(true);
    // An enrolled Organizer on an aal1 session is still refused.
    expect(await as(organizer, sessions.organizer, "aal1",
      `select private.member_has_chapter_role('${chapter}', array['organizer']) as value`)).toBe(false);
  });
});
