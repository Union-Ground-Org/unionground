// @vitest-environment node
// REQ-UG-SITE-GUIDE-FOR-REAL-ACCOUNTS-20261001: the Site Guide switch is
// enforced on the server, the copy override is admin-only and audited, the
// override table has no client grant, and one organization's copy never
// reaches another.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Required proof (scripts/run-required-db-proofs.mjs): live whenever the owned
// disposable stack is named, rolled back afterwards.
const runLive = Boolean(process.env.SUPABASE_DB_URL);
const IDS = {
  orgA: "50912200-0000-4000-8000-000000000001",
  orgB: "50912200-0000-4000-8000-000000000002",
  adminA: "50912200-0000-4000-8000-000000000101",
  memberA: "50912200-0000-4000-8000-000000000102",
  adminB: "50912200-0000-4000-8000-000000000201",
  memberB: "50912200-0000-4000-8000-000000000202",
};
const SWITCH = "features.guidance_onboarding.site_guide";
const SESSIONS = Object.fromEntries(Object.entries(IDS)
  .filter(([key]) => !key.startsWith("org"))
  .map(([, userId], index) => [userId, `50912200-0000-4000-8000-0000009000${String(index + 10).padStart(2, "0")}`]));

describe.skipIf(!runLive)("site guide live database behavior", () => {
  let client;

  async function callAs(userId, sql, values = []) {
    await client.query("savepoint site_guide_probe");
    try {
      await client.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: userId, role: "authenticated", aal: "aal2", session_id: SESSIONS[userId] }),
      ]);
      await client.query("set local role authenticated");
      const result = await client.query(sql, values);
      await client.query("reset role");
      await client.query("release savepoint site_guide_probe");
      return { code: "", rows: result.rows };
    } catch (error) {
      await client.query("rollback to savepoint site_guide_probe");
      return { code: error.code || "?", message: error.message || "", rows: [] };
    }
  }

  async function guideFor(userId) {
    const result = await callAs(userId, "select public.get_site_guide() result");
    expect(result.code, result.message).toBe("");
    return result.rows[0].result;
  }

  function save(userId, { title = null, intro = null, helpTitle = null, helpBody = null, sections = {} } = {}) {
    return callAs(
      userId,
      "select public.save_site_guide($1, $2, $3, $4, $5::jsonb, $6) result",
      [title, intro, helpTitle, helpBody, sections === null ? null : JSON.stringify(sections), crypto.randomUUID()],
    );
  }

  beforeAll(async () => {
    client = new pg.Client({ connectionString: process.env.SUPABASE_DB_URL, ssl: false, application_name: "site-guide-test" });
    await client.connect();
    await client.query("begin");
    await client.query(
      `insert into auth.users (id, email) values
       ($1, 'guide-admin-a@example.test'), ($2, 'guide-member-a@example.test'),
       ($3, 'guide-admin-b@example.test'), ($4, 'guide-member-b@example.test')`,
      [IDS.adminA, IDS.memberA, IDS.adminB, IDS.memberB],
    );
    await client.query(
      `insert into public.organizations (id, slug, name, created_by) values
       ($1, 'site-guide-org-a', 'Site Guide Org A', $3), ($2, 'site-guide-org-b', 'Site Guide Org B', $4)`,
      [IDS.orgA, IDS.orgB, IDS.adminA, IDS.adminB],
    );
    await client.query("set local session_replication_role = replica");
    await client.query("insert into public.chapters (id,name,slug,order_index,organization_id) values ('tamarack-site-guide-a','Tamarack site-guide A','tamarack-site-guide-a',901,$1)", [IDS.orgA]);
    await client.query("insert into public.chapters (id,name,slug,order_index,organization_id) values ('tamarack-site-guide-b','Tamarack site-guide B','tamarack-site-guide-b',901,$1)", [IDS.orgB]);
    await client.query("insert into public.chapter_workstreams(chapter_id,name) values ('tamarack-site-guide-a','General'), ('tamarack-site-guide-b','General') on conflict(chapter_id,name) do nothing");
    await client.query("set local session_replication_role = origin");
    await client.query(
      `update public.member_profiles set chapter_id = fixture.chapter_id
       from (values ($1::uuid, 'tamarack-site-guide-a'::text), ($2::uuid, 'tamarack-site-guide-a'::text), ($3::uuid, 'tamarack-site-guide-b'::text), ($4::uuid, 'tamarack-site-guide-b'::text)) fixture(id, chapter_id)
       where member_profiles.id = fixture.id`,
      [IDS.adminA, IDS.memberA, IDS.adminB, IDS.memberB],
    );
    await client.query(
      `insert into public.member_chapter_memberships (user_id, chapter_id, status, pinned, last_selected_at)
       values ($1, 'tamarack-site-guide-a', 'active', true, now()), ($2, 'tamarack-site-guide-a', 'active', true, now()),
              ($3, 'tamarack-site-guide-b', 'active', true, now()), ($4, 'tamarack-site-guide-b', 'active', true, now())
       on conflict (user_id, chapter_id) do update set status = 'active', revoked_at = null, last_selected_at = now()`,
      [IDS.adminA, IDS.memberA, IDS.adminB, IDS.memberB],
    );
    await client.query(
      `insert into public.organization_memberships (organization_id, user_id) values ($1,$3),($1,$4),($2,$5),($2,$6)`,
      [IDS.orgA, IDS.orgB, IDS.adminA, IDS.memberA, IDS.adminB, IDS.memberB],
    );
    await client.query(
      `insert into public.organization_role_grants (organization_id, user_id, role, granted_by)
       values ($1,$3,'admin',$3),($2,$4,'admin',$4)`,
      [IDS.orgA, IDS.orgB, IDS.adminA, IDS.adminB],
    );
    await client.query(
      `insert into auth.mfa_factors (id, user_id, friendly_name, factor_type, status, created_at, updated_at)
       values (gen_random_uuid(), $1, 'guide-a-totp', 'totp', 'verified', now(), now()),
              (gen_random_uuid(), $2, 'guide-b-totp', 'totp', 'verified', now(), now())`,
      [IDS.adminA, IDS.adminB],
    );
    await client.query(
      `insert into auth.sessions (id, user_id, created_at, updated_at, aal)
       select (value ->> 'sessionId')::uuid, (value ->> 'userId')::uuid, now(), now(), 'aal2'
       from pg_catalog.jsonb_array_elements($1::jsonb) value`,
      [JSON.stringify(Object.entries(SESSIONS).map(([userId, sessionId]) => ({ userId, sessionId })))],
    );
  }, 30_000);

  afterAll(async () => {
    if (!client) return;
    await client.query("rollback");
    await client.end();
  });

  it("defines the member-visible Site Guide switch on by default (old 0612)", async () => {
    const { rows } = await client.query(
      "select value_kind, default_value, category, member_visible from public.platform_setting_definitions where key = $1",
      [SWITCH],
    );
    expect(rows).toEqual([{ value_kind: "boolean", default_value: true, category: "guidance_onboarding", member_visible: true }]);
  });

  it("serves the defaults to every signed-in member until an admin saves copy", async () => {
    expect(await guideFor(IDS.memberA)).toMatchObject({ state: "ready", enabled: true, canEdit: false, copy: null, organizationId: IDS.orgA });
    expect(await guideFor(IDS.adminA)).toMatchObject({ enabled: true, canEdit: true, copy: null });
  });

  it("lets only an admin save the organization's copy, and audits who saved it", async () => {
    expect((await save(IDS.memberA, { title: "Member edit" })).code).toBe("42501");
    const saved = await save(IDS.adminA, {
      title: "  Using Union Ground  ",
      intro: "Start here.\nThen follow your navigation.",
      sections: { me: { body: "Your own work.", steps: ["Check counts first.", "  ", "Open your cases."] }, steward: { steps: [] } },
    });
    expect(saved.code, saved.message).toBe("");
    expect(saved.rows[0].result).toMatchObject({ saved: true, restoredDefaults: false, fields: ["title", "intro", "sections"] });
    const guide = await guideFor(IDS.memberA);
    expect(guide.copy).toMatchObject({
      title: "Using Union Ground",
      intro: "Start here.\nThen follow your navigation.",
      helpTitle: null,
      sections: { me: { body: "Your own work.", steps: ["Check counts first.", "Open your cases."] } },
    });
    expect(guide.copy.sections.steward).toBeUndefined();
    const { rows } = await client.query(
      "select actor_user_id, action, event_type, metadata from public.organization_audit_ledger where organization_id = $1 and event_type = 'site_guide_copy_changed'",
      [IDS.orgA],
    );
    expect(rows).toEqual([expect.objectContaining({ actor_user_id: IDS.adminA, action: "settings_change", metadata: expect.objectContaining({ reasonCode: "copy_saved" }) })]);
  });

  it("keeps the override table out of every client role", async () => {
    expect((await callAs(IDS.adminA, "select * from private.organization_site_guide_copy")).code).toBe("42501");
    const { rows } = await client.query(
      `select has_table_privilege('authenticated', 'private.organization_site_guide_copy', 'select') a,
              has_function_privilege('anon', 'public.get_site_guide()', 'execute') b,
              has_function_privilege('anon', 'public.save_site_guide(text,text,text,text,jsonb,uuid)', 'execute') c`,
    );
    expect(rows[0]).toEqual({ a: false, b: false, c: false });
  });

  it("refuses malformed copy", async () => {
    for (const sections of [
      { "Bad Key": { body: "x" } },
      { me: { body: "x", extra: true } },
      { me: { steps: ["1", "2", "3", "4", "5", "6", "7"] } },
      { me: { steps: ["x".repeat(221)] } },
      { me: { body: "y".repeat(1201) } },
      { me: "not an object" },
    ]) {
      expect((await save(IDS.adminA, { sections })).code, JSON.stringify(sections)).toBe("22023");
    }
    expect((await save(IDS.adminA, { title: "t".repeat(121) })).code).toBe("23514");
    expect((await callAs(IDS.adminA, "select public.save_site_guide(null, null, null, null, '[]'::jsonb, $1)", [crypto.randomUUID()])).code).toBe("22023");
  });

  it("stays inside the caller's organization", async () => {
    expect(await guideFor(IDS.memberB)).toMatchObject({ organizationId: IDS.orgB, copy: null });
    const saved = await save(IDS.adminB, { title: "Org B guide" });
    expect(saved.code, saved.message).toBe("");
    expect((await guideFor(IDS.memberA)).copy.title).toBe("Using Union Ground");
  });

  it("restores the defaults when an admin clears every override", async () => {
    const restored = await save(IDS.adminA, { sections: null });
    expect(restored.rows[0].result).toMatchObject({ restoredDefaults: true, fields: [] });
    expect((await guideFor(IDS.memberA)).copy).toBeNull();
  });

  it("withholds the guide when the organization turns the switch off", async () => {
    await client.query(
      `insert into public.organization_setting_values (organization_id, setting_key, value) values ($1, $2, 'false'::jsonb)
       on conflict (organization_id, setting_key) do update set value = excluded.value`,
      [IDS.orgB, SWITCH],
    );
    expect(await guideFor(IDS.memberB)).toEqual({ state: "ready", organizationId: IDS.orgB, enabled: false, canEdit: false });
    expect((await guideFor(IDS.adminB)).canEdit).toBe(true);
  });
});
