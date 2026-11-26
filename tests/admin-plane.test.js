// @vitest-environment node
// PR4b admin + advisor planes: role management, audit, event management, and
// the advisor overview. Pins the security shape of the three migrations plus
// the loader/write-wrapper contracts.
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, migrationFiles } from "./helpers/migration.js";

// Text pins are a tripwire, not a proof: they assert what THIS MIGRATION SAYS,
// not what the database ENDS UP WITH. A later create-or-replace can supersede
// every guard below and this file stays green. Current-state truth lives in
// scripts/db-contract.json, checked by `npm run verify:db`.
//
// Superseded here: the member_admin_audit action CHECK (20260724031000_mfa_
// staff_gate_and_reset added reset_mfa) and member_has_role, redefined by the
// same migration.

const adminSql = loadMigrationSql("20260723180000_admin_role_management.sql");
const advisorSql = loadMigrationSql("20260723181000_advisor_overview.sql");
const eventsSql = loadMigrationSql("20260723182000_admin_event_management.sql");
const allMigrations = migrationFiles().map((entry) => entry.sql).join("\n");

describe("member_admin_audit", () => {
  it("is admin-read-only with zero client write path", () => {
    expect(adminSql).toContain("alter table public.member_admin_audit enable row level security;");
    expect(adminSql).toContain("create policy member_admin_audit_select_admin on public.member_admin_audit\n  for select to authenticated using (public.member_has_role(array['admin']));");
    expect(adminSql).toContain("revoke all on public.member_admin_audit from anon, authenticated;");
    expect(adminSql).toContain("grant select on public.member_admin_audit to authenticated;");
    // "all" included so a future table-level grant can't slip past the pin.
    expect(allMigrations).not.toMatch(/grant\s+(insert|update|delete|all)[^;]*on\s+(table\s+)?public\.member_admin_audit/i);
  });

  it("constrains actions to the four kinds THIS migration audited", () => {
    // Deliberately a historical pin, not a claim about the database. The live
    // CHECK has five values: 20260724031000_mfa_staff_gate_and_reset added
    // reset_mfa. What this asserts is that the admin plane shipped with a
    // closed allow-list rather than a free-text action column — the current
    // value set is contracted in scripts/db-contract.json
    // (member_admin_audit_action_check) and checked by `npm run verify:db`.
    expect(adminSql).toContain("check (action in ('grant_role', 'revoke_role', 'create_event', 'update_event'))");
  });
});

describe("admin/advisor RPC security shape", () => {
  const guards = [
    { sql: adminSql, name: "grant_member_role", args: "uuid, text, text", roles: "array['admin']" },
    { sql: adminSql, name: "revoke_member_role", args: "uuid, text", roles: "array['admin']" },
    { sql: adminSql, name: "admin_search_members", args: "text", roles: "array['admin']" },
    { sql: adminSql, name: "get_admin_audit", args: "integer", roles: "array['admin']" },
    { sql: advisorSql, name: "get_advisor_overview", args: "", roles: "array['advisor', 'admin']" },
    { sql: eventsSql, name: "create_member_event", args: "text, text, timestamptz, text, text, text", roles: "array['admin']" },
    { sql: eventsSql, name: "update_member_event", args: "text, text, timestamptz, text, text, text", roles: "array['admin']" },
    { sql: eventsSql, name: "get_admin_events", args: "", roles: "array['admin']" },
  ];

  for (const { sql, name, args, roles } of guards) {
    it(`${name} is a role-gated definer with an empty search_path`, () => {
      const body = fnBody(sql, name);
      expect(body).toContain("security definer");
      expect(body).toContain("set search_path = ''");
      expect(body).toContain(`not public.member_has_role(${roles})`);
      expect(body).toContain("errcode = '42501'");
      expect(sql).toContain(`revoke all on function public.${name}(${args}) from public, anon;`);
      expect(sql).toContain(`grant execute on function public.${name}(${args}) to authenticated;`);
    });
  }

  it("grant_member_role validates role/member/chapter in-body and stamps granted_by + audit", () => {
    const body = fnBody(adminSql, "grant_member_role");
    // Defence-in-depth over the CHECK: a future CHECK widening cannot
    // silently make a new slug grantable here.
    expect(body).toContain("p_role not in ('steward', 'coordinator', 'advisor', 'admin', 'vp')");
    expect(body).toContain("'unknown member'");
    expect(body).toContain("'unknown chapter'");
    expect(body).toContain("granted_by");
    expect(body).toContain("'grant_role'");
    expect(body).toContain("on conflict (user_id, role) do nothing");
    // A conflict no-op must not write an audit row the trail reads as a grant.
    expect(body).toContain("if inserted > 0 then");
  });

  it("revoke_member_role refuses to remove the last admin, under an advisory lock", () => {
    const body = fnBody(adminSql, "revoke_member_role");
    expect(body).toContain("pg_advisory_xact_lock");
    expect(body).toContain("cannot remove the last admin");
    expect(body).toContain("'revoke_role'");
    // The guard only fires when the target actually holds admin.
    expect(body).toContain("where user_id = p_user_id and role = 'admin'");
    // Non-holder revokes are no-ops and stay out of the audit trail.
    expect(body).toContain("if removed > 0 then");
  });

  it("admin_search_members is name-only, min 2 chars, bounded to 20", () => {
    const body = fnBody(adminSql, "admin_search_members");
    expect(body).toContain("char_length(needle) < 2");
    expect(body).toContain("limit 20");
    expect(body).not.toMatch(/email/i);
    // ilike wildcards in the query are escaped, not interpreted.
    expect(body).toContain("'\\%'");
  });

  it("admin_search_members resolves roles only for the 20 surviving rows and returns a disambiguator", () => {
    const body = fnBody(adminSql, "admin_search_members");
    // The roles subselect correlates on the post-LIMIT alias s, never on the
    // pre-LIMIT p — inside the inner query it would run once per ilike match
    // (~100k definer-read probes on a broad needle over live data).
    expect(body).toContain("from public.member_roles r where r.user_id = s.id");
    expect(body).not.toContain("r.user_id = p.id");
    expect(body).toContain("'memberSince', s.member_since");
  });

  it("get_admin_audit clamps the limit to 1..200 and returns the stable target id", () => {
    const body = fnBody(adminSql, "get_admin_audit");
    expect(body).toContain("greatest(1, least(coalesce(p_limit, 50), 200))");
    // Names alone cannot disambiguate same-named members after the fact.
    expect(body).toContain("'targetId', s.target_user");
  });

  it("never schema-qualifies GREATEST/LEAST (grammar constructs, not functions)", () => {
    // pg_catalog.least(...) parses at CREATE time but raises 42883 on every
    // call under set search_path = '' — caught live by the PR4b smoke.
    expect(allMigrations).not.toMatch(/pg_catalog\.(greatest|least)\s*\(/i);
  });

  it("get_advisor_overview is chapter-scoped and single-pass over the case join", () => {
    const body = fnBody(advisorSql, "get_advisor_overview");
    expect(body).toContain("select r.chapter_id into caller_chapter");
    expect(body).toContain("caller_chapter is null or p.chapter_id = caller_chapter");
    expect(body).toContain("with base as materialized");
    expect(body.match(/from public\.member_cases c/g)).toHaveLength(1);
  });
});

describe("event management", () => {
  it("create/update validate the SG code with the table's exact regex, reject control characters, and audit", () => {
    for (const [name, action] of [["create_member_event", "'create_event'"], ["update_member_event", "'update_event'"]]) {
      const body = fnBody(eventsSql, name);
      expect(body).toContain("'^SG-[0-9A-Z]{3,12}$'");
      expect(body).toContain("[[:cntrl:]]");
      expect(body).toContain(action);
    }
  });

  it("create serializes order_index allocation and rejects duplicate ids", () => {
    const body = fnBody(eventsSql, "create_member_event");
    expect(body).toContain("pg_advisory_xact_lock");
    expect(body).toContain("'event id already exists'");
    expect(body).toContain("max(order_index) + 1");
  });

  it("update locks the row and audits only fields whose value actually changed", () => {
    const body = fnBody(eventsSql, "update_member_event");
    expect(body).toContain("for update;");
    expect(body).toContain("'unknown event'");
    expect(body).toContain("'fields', pg_catalog.to_jsonb(changed)");
    // Diff against the locked row: the edit form pre-fills every text field,
    // so parameter presence alone would log supplied-but-identical values.
    expect(body).toContain("is distinct from ev.title");
    expect(body).toContain("is distinct from ev.check_in_code");
    // No-op edits write neither an UPDATE nor an audit row.
    expect(body).toContain("if pg_catalog.cardinality(changed) > 0 then");
  });

  it("get_admin_events is the only client-reachable path returning check_in_code", () => {
    expect(fnBody(eventsSql, "get_admin_events")).toContain("'checkInCode', e.check_in_code");
    // The member_events column grant never widens to include the code.
    expect(allMigrations).not.toMatch(/grant select[^;()]*\([^)]*check_in_code[^)]*\)[^;]*on public\.member_events[^;]*to authenticated/i);
    // A column-list-free (or ALL) table grant would expose every column
    // including the code — reject that shape outright.
    expect(allMigrations).not.toMatch(/grant\s+(all|select)\s+on\s+(table\s+)?public\.member_events\s+to\s+(authenticated|anon)/i);
  });
});

describe("admin/advisor loaders and write wrappers", () => {
  it("loadAdvisorDesk requires the overview and degrades workload + roster", async () => {
    const { loadAdvisorDesk } = await import("../src/lib/memberApi.js");
    const ok = { rpc: async (name) => (name === "get_advisor_overview" ? { data: { membersCovered: 5 }, error: null } : { data: null, error: { message: "down" } }) };
    const desk = await loadAdvisorDesk(ok);
    expect(desk.overview.membersCovered).toBe(5);
    expect(desk.workload).toBeNull();
    expect(desk.roster).toEqual([]);
    const bad = { rpc: async () => ({ data: null, error: { message: "denied" } }) };
    await expect(loadAdvisorDesk(bad)).rejects.toThrow("Advisor overview: denied");
  });

  it("loadAdminDesk localizes labels and independently degrades roster, events and compliance queues", async () => {
    const { loadAdminDesk } = await import("../src/lib/memberApi.js");
    const called = [];
    const client = {
      rpc: async (name) => {
        called.push(name);
        if (name === "get_staff_roster") return { data: [{ userId: "u1" }], error: null };
        if (name === "get_admin_events") return { data: [{ id: "e1", title: "T", startsAt: "2026-07-24T22:00:00Z", checkInCode: "SG-X99" }], error: null };
        if (name === "get_admin_reward_queue") return { data: [{ id: "g1", itemKey: "sg-hoodie", createdAt: "2026-07-24T22:00:00Z" }], error: null };
        return { data: null, error: { message: "audit down" } };
      },
    };
    const desk = await loadAdminDesk(client);
    expect(desk.roster).toHaveLength(1);
    expect(desk.events[0].startsLabel).toContain("Jul");
    // No perk claims means no admin reward queue: never read, never projected.
    expect(called).not.toContain("get_admin_reward_queue");
    expect(desk).not.toHaveProperty("rewardQueue");
    // null (unavailable), NOT [] — an unreadable audit trail must never
    // render as a genuinely empty one.
    expect(desk.audit).toBeNull();
    expect(desk.leadershipReviews).toBeNull();
    expect(desk.invitations).toBeNull();
    // An unreadable event list is null (unavailable) on a desk that still
    // loads, not a rejection that blanks every other admin panel
    // (BUG-UG-ADMIN-DESK-FAILS-WHOLE-WHEN-ONE-READ-FAILS-20261006).
    const noEvents = { rpc: async (name) => (name === "get_admin_events" ? { data: null, error: { message: "denied" } } : { data: [], error: null }) };
    const withoutEvents = await loadAdminDesk(noEvents);
    expect(withoutEvents.events).toBeNull();
    expect(withoutEvents.roster).toEqual([]);
  });

  it("loadAdminDesk localizes governance requests and degrades a failed reader to a null sentinel", async () => {
    const { loadAdminDesk } = await import("../src/lib/memberApi.js");
    const withGovernance = {
      rpc: async (name) => {
        if (name === "get_staff_roster") return { data: [{ userId: "u1" }], error: null };
        if (name === "get_admin_events") return { data: [], error: null };
        if (name === "get_admin_governance_requests") {
          return { data: [{ id: "g1", requesterName: "Darnell Brooks", requestType: "export", details: "Export my data.", status: "submitted", response: null, createdAt: "2026-07-25T16:00:00Z" }], error: null };
        }
        return { data: null, error: { message: "down" } };
      },
    };
    const desk = await loadAdminDesk(withGovernance);
    expect(desk.governance).toHaveLength(1);
    expect(desk.governance[0].createdLabel).toContain("Jul");
    expect(desk.governance[0].requesterName).toBe("Darnell Brooks");
    const failedGovernance = {
      rpc: async (name) => {
        if (name === "get_staff_roster") return { data: [{ userId: "u1" }], error: null };
        if (name === "get_admin_events") return { data: [], error: null };
        if (name === "get_admin_governance_requests") return { data: null, error: { message: "governance down" } };
        return { data: null, error: { message: "down" } };
      },
    };
    // null (unavailable), NOT [] — an unreadable data-rights queue must never
    // render as a genuinely empty one.
    expect((await loadAdminDesk(failedGovernance)).governance).toBeNull();
  });

  it("maps the invitation chapter, expiry labels, and empty items without inventing data", async () => {
    const { loadAdminDesk } = await import("../src/lib/memberApi.js");
    const client = {
      rpc: async (name) => {
        if (name === "get_staff_roster" || name === "get_admin_events") return { data: [], error: null };
        if (name === "get_member_invitations") return { data: {
          chapter: { id: "wor", name: "Harborview Care United" },
          items: [{
            id: "i1", normalizedEmail: "member@example.com", fullName: "Member Name",
            chapterId: "wor", initialRole: null, locale: "en", status: "pending",
            deliveryVersion: 1, expiresAt: "2026-08-12T19:15:00Z", createdAt: "2026-08-12T19:00:00Z",
          }],
        }, error: null };
        return { data: null, error: { message: "optional down" } };
      },
    };
    const desk = await loadAdminDesk(client, "en");
    expect(desk.invitations.chapter).toEqual({ id: "wor", name: "Harborview Care United" });
    expect(desk.invitations.items[0]).toMatchObject({
      normalizedEmail: "member@example.com", status: "pending",
      expiresLabel: expect.stringContaining("Aug"),
    });
    // Before the database lists the invitable chapters the desk keeps its
    // locked chapter: null, not an empty list.
    expect(desk.invitations.chapters).toBeNull();
  });

  // BUG-UG-ACCEPTED-INVITATIONS-SHOW-EXPIRY-20261102: both invitation
  // reads label the expiry, acceptance and revocation times with their zone,
  // and leave a time the database did not return blank.
  it("labels invitation times with their zone in both reads, and invents none", async () => {
    const { loadAdminDesk, loadMemberInvitations } = await import("../src/lib/memberApi.js");
    const items = [
      { id: "accepted", status: "accepted", expiresAt: "2026-11-02T16:23:00Z", createdAt: "2026-11-02T16:08:00Z", acceptedAt: "2026-11-02T16:14:00Z", revokedAt: null },
      { id: "revoked", status: "revoked", expiresAt: "2026-11-02T16:23:00Z", createdAt: "2026-11-02T16:08:00Z", acceptedAt: null, revokedAt: "2026-11-02T16:20:00Z" },
      { id: "untimed", status: "revoked", expiresAt: "2026-11-02T16:23:00Z", createdAt: "2026-11-02T16:08:00Z" },
    ];
    const client = {
      rpc: async (name) => {
        if (name === "get_staff_roster" || name === "get_admin_events") return { data: [], error: null };
        if (name === "get_member_invitations") return { data: { chapter: { id: "wor", name: "Cedar Ridge Care Services" }, items }, error: null };
        return { data: null, error: { message: "optional down" } };
      },
    };
    const expected = [
      { id: "accepted", expiresLabel: "Mon, Nov 2 · 4:23 PM UTC", acceptedLabel: "Mon, Nov 2 · 4:14 PM UTC", revokedLabel: "" },
      { id: "revoked", expiresLabel: "Mon, Nov 2 · 4:23 PM UTC", acceptedLabel: "", revokedLabel: "Mon, Nov 2 · 4:20 PM UTC" },
      { id: "untimed", acceptedLabel: "", revokedLabel: "" },
    ];
    expect((await loadAdminDesk(client, "en")).invitations.items).toMatchObject(expected);
    expect((await loadMemberInvitations(client, "en")).items).toMatchObject(expected);
    expect((await loadMemberInvitations(client, "es")).items[0].acceptedLabel).toMatch(/^lun, 2 nov · 4:14 p\. ?m\. UTC$/);
  });

  it("passes the invitable chapters through and drops malformed entries (BUG-UG-INVITE-CHAPTER-LOCKED-TO-CURRENT-CHAPTER-20261003)", async () => {
    const { loadAdminDesk } = await import("../src/lib/memberApi.js");
    const client = {
      rpc: async (name) => {
        if (name === "get_staff_roster" || name === "get_admin_events") return { data: [], error: null };
        if (name === "get_member_invitations") return { data: {
          chapter: { id: "wor", name: "Harborview Care United" },
          chapters: [{ id: "wor", name: "Harborview Care United" }, { id: "spr", name: "Harborview Care Springfield" }, { id: "", name: "blank" }, null],
          items: [],
        }, error: null };
        return { data: null, error: { message: "optional down" } };
      },
    };
    const desk = await loadAdminDesk(client, "en");
    expect(desk.invitations.chapters).toEqual([{ id: "wor", name: "Harborview Care United" }, { id: "spr", name: "Harborview Care Springfield" }]);
  });

  it("write wrappers pass the rpc payload verbatim and surface errors", async () => {
    const { grantMemberRole, createAdminEvent, closeAdminGovernanceRequest } = await import("../src/lib/memberApi.js");
    const calls = [];
    const client = { rpc: async (name, args) => { calls.push([name, args]); return { data: { ok: true }, error: null }; } };
    await grantMemberRole(client, "u1", "steward", { chapterId: "ch", unitId: "unit-a" });
    expect(calls[0]).toEqual(["set_member_access_role", {
      p_user: "u1", p_chapter: "ch", p_role: "steward", p_enabled: true, p_unit: "unit-a", p_committee: null,
    }]);
    await createAdminEvent(client, { id: " ev-1 ", title: "Meet", startsAt: "2026-08-01T18:00:00Z", location: "Hall", summary: "S", checkInCode: "sg-abc" });
    expect(calls[1][1].p_id).toBe("ev-1");
    expect(calls[1][1].p_check_in_code).toBe("SG-ABC");
    expect(calls[1][1].p_is_public).toBe(false);
    expect(calls[1][1].p_is_public_across_agencies).toBe(false);
    await closeAdminGovernanceRequest(client, "request-1", "fulfilled", "Complete");
    expect(calls[2]).toEqual(["close_admin_governance_request", { p_request_id: "request-1", p_status: "fulfilled", p_response: "Complete" }]);
    const bad = { rpc: async () => ({ data: null, error: { message: "nope" } }) };
    await expect(grantMemberRole(bad, "u1", "steward", { chapterId: "ch", unitId: "unit-a" })).rejects.toThrow("Grant steward: nope");
  });

  it("loads the complete versioned template registry without exposing audit identity", async () => {
    const { loadAdminFormTemplates } = await import("../src/lib/memberApi.js");
    const calls = [];
    const rows = [
      { key: "grievance", version: 1, label_en: "Grievance", label_es: "Queja", active: false, sort: 1, field_schema: { steps: [] } },
      { key: "grievance", version: 2, label_en: "Grievance report", label_es: "Reporte de queja", active: true, sort: 1, field_schema: { steps: [] } },
    ];
    const client = {
      from(table) {
        calls.push(["from", table]);
        return {
          select(columns) {
            calls.push(["select", columns]);
            const query = {
              order(column) { calls.push(["order", column]); return query; },
              eq(column, value) { calls.push(["eq", column, value]); return query; },
              async range(from, to) { calls.push(["range", from, to]); return { data: rows, error: null }; },
            };
            return query;
          },
        };
      },
    };

    await expect(loadAdminFormTemplates(client)).resolves.toEqual(rows);
    expect(calls).toContainEqual(["from", "form_template_registry"]);
    expect(calls).toContainEqual(["eq", "available_to_start", true]);
    expect(calls.find(([kind]) => kind === "select")?.[1]).toBe(
      "key,version,label_en,label_es,blurb_en,blurb_es,icon,points,active,sort,field_schema,created_at,updated_at,organization_id,is_platform_seed,available_to_start",
    );
    expect(calls.find(([kind]) => kind === "select")?.[1]).not.toContain("updated_by");
    expect(calls.filter(([kind]) => kind === "order").map(([, column]) => column)).toEqual(["sort", "key", "version"]);
    expect(calls).toContainEqual(["range", 0, 499]);

    const denied = {
      from: () => ({
        select: () => {
          const query = {
            order: () => query,
            eq: () => query,
            range: async () => ({ data: null, error: { message: "denied", code: "42501" } }),
          };
          return query;
        },
      }),
    };
    await expect(loadAdminFormTemplates(denied)).rejects.toMatchObject({ message: "Form templates: denied", code: "42501" });
  });

  it("routes template mutations through the three admin RPCs with exact payloads", async () => {
    const { upsertFormTemplate, deactivateFormTemplate, reactivateFormTemplate } = await import("../src/lib/memberApi.js");
    const calls = [];
    const client = { rpc: async (name, args) => { calls.push([name, args]); return { data: { ok: true }, error: null }; } };
    const template = {
      key: " leave_request ",
      labelEn: " Leave request ",
      labelEs: " Solicitud de licencia ",
      blurbEn: " Help with leave ",
      blurbEs: " Ayuda con licencia ",
      icon: " 🗓 ",
      points: 15,
      sort: 8,
      active: true,
      fieldSchema: { steps: [{ title: { en: "Details", es: "Detalles" }, fields: [] }] },
    };

    await upsertFormTemplate(client, template);
    await deactivateFormTemplate(client, " leave_request ");
    await reactivateFormTemplate(client, " leave_request ");

    expect(calls).toEqual([
      ["upsert_form_template", {
        p_key: "leave_request",
        p_label_en: "Leave request",
        p_label_es: "Solicitud de licencia",
        p_blurb_en: "Help with leave",
        p_blurb_es: "Ayuda con licencia",
        p_icon: "🗓",
        // Safe recognition pins form_templates.points to 0: filing a form
        // never earns, whatever value an editor or stale draft carries.
        p_points: 0,
        p_sort: 8,
        p_active: true,
        p_field_schema: template.fieldSchema,
      }],
      ["deactivate_form_template", { p_key: "leave_request" }],
      ["reactivate_form_template", { p_key: "leave_request" }],
    ]);

    const denied = { rpc: async () => ({ data: null, error: { message: "admin role required", code: "42501" } }) };
    await expect(upsertFormTemplate(denied, template)).rejects.toMatchObject({ message: "Save form template: admin role required", code: "42501" });
  });
});
