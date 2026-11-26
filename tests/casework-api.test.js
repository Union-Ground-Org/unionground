import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as casework from "../src/lib/caseworkApi.js";

function query(data = [], { count = undefined, error = null } = {}) {
  const result = { data, error, count };
  const chain = {};
  for (const method of ["select", "eq", "in", "gte", "lt", "order", "limit", "insert", "ilike", "or", "range"]) chain[method] = vi.fn(() => chain);
  chain.single = vi.fn(async () => result);
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  chain.catch = (reject) => Promise.resolve(result).catch(reject);
  return chain;
}

function clientFor(rows = {}) {
  const queries = new Map();
  const client = {
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "actor-1" } }, error: null })) },
    rpc: vi.fn(async (name, args) => ({ data: { name, args }, error: null })),
    from: vi.fn((table) => {
      const configured = rows[table];
      const row = configured && Object.hasOwn(configured, "data") ? configured : { data: configured ?? [] };
      const chain = query(row.data, row);
      queries.set(table, chain);
      return chain;
    }),
  };
  return { client, queries };
}

describe("management behavior window counts", () => {
  const now = Date.parse("2026-10-20T16:00:00Z");
  beforeEach(() => { vi.spyOn(Date, "now").mockReturnValue(now); });
  afterEach(() => { vi.restoreAllMocks(); });
  const row = (index, person = "manager-a", occurredAt = "2026-10-19T12:00:00Z") => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    management_person_id: person,
    occurred_at: occurredAt,
  });
  function cappedClient(rows, failRequest = null, cap = 1000) {
    const requests = [];
    return {
      requests,
      from(table) {
        expect(table).toBe("casework_management_entries");
        const request = { ids: null, since: null, after: null, order: null, limit: cap };
        requests.push(request);
        const number = requests.length;
        const chain = {
          select() { return chain; },
          in(column, ids) { expect(column).toBe("management_person_id"); request.ids = ids; return chain; },
          gte(column, since) { expect(column).toBe("occurred_at"); request.since = since; return chain; },
          gt(column, after) { expect(column).toBe("id"); request.after = after; return chain; },
          order(column) { request.order = column; return chain; },
          limit(limit) { request.limit = Math.min(limit, cap); return chain; },
          then(resolve, reject) {
            if (number === failRequest) return Promise.resolve({ data: null, error: { message: "permission denied", code: "42501" } }).then(resolve, reject);
            let selected = rows.filter((item) => (!request.ids || request.ids.includes(item.management_person_id))
              && (!request.since || item.occurred_at >= request.since)
              && (!request.after || item.id > request.after));
            if (request.order) selected = [...selected].sort((a, b) => a[request.order].localeCompare(b[request.order]));
            return Promise.resolve({ data: selected.slice(0, request.limit), error: null }).then(resolve, reject);
          },
        };
        return chain;
      },
    };
  }

  it("counts all incidents beyond a capped page with stable unique boundaries", async () => {
    const rows = [...Array.from({ length: 1000 }, (_, index) => row(index)), row(1000, "manager-b")].reverse();
    const client = cappedClient(rows);
    expect(await casework.loadCaseworkManagementWindow(client, ["manager-a", "manager-b"], 90))
      .toEqual({ "manager-a": 1000, "manager-b": 1 });
    for (const request of client.requests) {
      expect(request.ids).toEqual(["manager-a", "manager-b"]);
      expect(request.since).toBe("2026-07-22T16:00:00.000Z");
    }
  });

  it("keeps person and time-window filters on every count", async () => {
    const client = cappedClient([row(1), row(2, "manager-a", "2026-01-01T12:00:00Z"), row(3, "foreign-manager")]);
    expect(await casework.loadCaseworkManagementWindow(client, ["manager-a"], 90)).toEqual({ "manager-a": 1 });
    expect(client.requests[0].ids).toEqual(["manager-a"]);
  });

  it("continues when the backend returns fewer rows than the requested page size", async () => {
    const client = cappedClient([...Array.from({ length: 1000 }, (_, index) => row(index)), row(1000, "manager-b")], null, 200);
    expect(await casework.loadCaseworkManagementWindow(client, ["manager-a", "manager-b"], 90))
      .toEqual({ "manager-a": 1000, "manager-b": 1 });
  });

  it("proves completeness at the existing 5000-row bound", async () => {
    const client = cappedClient(Array.from({ length: 5000 }, (_, index) => row(index)));
    expect(await casework.loadCaseworkManagementWindow(client, ["manager-a"], 90)).toEqual({ "manager-a": 5000 });
  });

  it("refuses a window beyond the bound instead of returning partial counts", async () => {
    const client = cappedClient(Array.from({ length: 5001 }, (_, index) => row(index)));
    await expect(casework.loadCaseworkManagementWindow(client, ["manager-a"], 90)).rejects.toThrow(/row limit/i);
  });

  it("propagates a later-page refusal instead of returning the earlier counts", async () => {
    const client = cappedClient(Array.from({ length: 1001 }, (_, index) => row(index)), 2);
    await expect(casework.loadCaseworkManagementWindow(client, ["manager-a"], 90)).rejects.toMatchObject({ code: "42501" });
  });
});

describe("casework API", () => {
  it("loads every case-scoped work family and groups deadline extensions", async () => {
    const { client } = clientFor({
      member_cases: { id: "case-1", organization_id: "org-1", chapter_id: "ch-1" },
      casework_deadlines: [{ id: "deadline-1" }],
      casework_deadline_extensions: [{ id: "ext-1", deadline_id: "deadline-1" }],
    });
    const result = await casework.loadCaseworkCase(client, "case-1");
    expect(result.scope.organization_id).toBe("org-1");
    expect(result.deadlines[0].extensions).toEqual([{ id: "ext-1", deadline_id: "deadline-1" }]);
    expect(client.from.mock.calls.flat()).toEqual(expect.arrayContaining([
      "casework_strength_analyses", "casework_deadlines", "casework_alerts", "casework_management_entries",
      "casework_retaliation_reports", "casework_entity_links", "casework_reminders",
    ]));
    // Union Ground issues have no grievance procedure: no step transitions,
    // no stage checklists, and no step column in the scope read.
    expect(client.from).not.toHaveBeenCalledWith("casework_step_transitions");
    expect(client.from).not.toHaveBeenCalledWith("casework_checklists");
    expect(result).not.toHaveProperty("transitions");
    expect(result).not.toHaveProperty("checklists");
    const scopeSelect = client.from.mock.results[client.from.mock.calls.findIndex(([table]) => table === "member_cases")].value.select.mock.calls[0][0];
    expect(scopeSelect.split(",")).not.toContain("step");
  });

  it("keeps another accessible case out of every selected-case read", async () => {
    const caseId = "case-selected";
    const otherCaseId = "case-other";
    // This edition reads no step transitions or step checklists (no grievance
    // procedure); the mocked sensitive-content reader below serves retaliation.
    const families = [
      ["casework_strength_analyses", "case_id", "strength"],
      ["casework_deadlines", "case_id", "deadlines"],
      ["casework_alerts", "case_id", "alerts"],
      ["casework_management_entries", "case_id", "management"],
      ["casework_retaliation_reports", "case_id", "retaliation"],
      ["casework_entity_links", "source_case_id", "links"],
      ["casework_reminders", "case_id", "reminders"],
      ["casework_access_grants", "case_id", "accessGrants"],
    ];
    const rows = Object.fromEntries(families.map(([table, column]) => [table, [
      { id: `${table}-selected`, [column]: caseId },
      { id: `${table}-other`, [column]: otherCaseId },
    ]]));
    rows.member_cases = [
      { id: caseId, organization_id: "org-1", chapter_id: "ch-1" },
      { id: otherCaseId, organization_id: "org-1", chapter_id: "ch-1" },
    ];
    const extension = { id: "extension-selected", deadline_id: "casework_deadlines-selected" };
    rows.casework_deadline_extensions = [
      extension,
      { id: "extension-other", deadline_id: "casework_deadlines-other" },
    ];
    const queries = new Map();
    const client = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
      from: vi.fn((table) => {
        const predicates = [];
        const selectedRows = () => rows[table].filter((row) => predicates.every((matches) => matches(row)));
        const chain = {};
        for (const method of ["select", "order", "limit"]) chain[method] = vi.fn(() => chain);
        chain.eq = vi.fn((column, value) => {
          predicates.push((row) => row[column] === value);
          return chain;
        });
        chain.in = vi.fn((column, values) => {
          predicates.push((row) => values.includes(row[column]));
          return chain;
        });
        chain.single = vi.fn(async () => ({ data: selectedRows()[0] ?? null, error: null }));
        chain.then = (resolve, reject) => Promise.resolve({ data: selectedRows(), error: null }).then(resolve, reject);
        queries.set(table, chain);
        return chain;
      }),
    };

    const result = await casework.loadCaseworkCase(client, caseId);

    expect(result.scope.id).toBe(caseId);
    expect(queries.get("member_cases").eq).toHaveBeenCalledExactlyOnceWith("id", caseId);
    for (const [table, column, projection] of families) {
      expect(queries.get(table).eq, table).toHaveBeenCalledExactlyOnceWith(column, caseId);
      expect(result[projection].map((row) => row.id), table).toEqual([`${table}-selected`]);
    }
    for (const table of ["casework_step_transitions", "casework_checklists"]) {
      expect(client.from, table).not.toHaveBeenCalledWith(table);
    }
    expect(queries.get("casework_deadline_extensions").in).toHaveBeenCalledExactlyOnceWith(
      "deadline_id", ["casework_deadlines-selected"],
    );
    expect(result.deadlines[0].extensions).toEqual([extension]);
  });

  it("handles an empty case workspace and rejects a missing case id", async () => {
    const { client } = clientFor({ member_cases: { id: "case-1", organization_id: "org-1", chapter_id: "ch-1" } });
    const result = await casework.loadCaseworkCase(client, "case-1");
    expect(result.deadlines).toEqual([]);
    expect(client.from).not.toHaveBeenCalledWith("casework_deadline_extensions");
    await expect(casework.loadCaseworkCase(client, "")).rejects.toThrow("Case id required");
  });

  const requiredCommands = [
    {
      rpc: "casework_score_case", label: "Score case",
      run: (client) => casework.scoreCaseworkCase(client, "case-1", { facts: 4 }),
      args: {
        p_case_id: "case-1", p_inputs: { facts: 4 },
        p_idempotency_key: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
      },
    },
    {
      rpc: "casework_revoke_access", label: "Revoke case access",
      run: (client) => casework.revokeCaseworkAccess(client, "grant-1"),
      args: { p_grant_id: "grant-1" },
    },
    {
      rpc: "casework_acknowledge_alert", label: "Acknowledge case alert",
      run: (client) => casework.acknowledgeCaseworkAlert(client, "alert-1", "Reviewed with member"),
      args: { p_alert_id: "alert-1", p_note: "Reviewed with member" },
    },
  ];

  it.each(requiredCommands)("sends $rpc with exact arguments and returns its response", async ({ rpc, run, args }) => {
    const { client } = clientFor();
    const data = { operation: rpc, confirmed: true };
    client.rpc.mockResolvedValueOnce({ data, error: null });

    await expect(run(client)).resolves.toBe(data);
    expect(client.rpc).toHaveBeenCalledExactlyOnceWith(rpc, args);
    expect(client.from).not.toHaveBeenCalled();
  });

  it.each(requiredCommands)("propagates $rpc failures with their operation and code", async ({ run, label }) => {
    const { client } = clientFor();
    client.rpc.mockResolvedValueOnce({ data: null, error: { message: "outside case scope", code: "42501" } });

    await expect(run(client)).rejects.toMatchObject({
      message: `${label}: outside case scope`, code: "42501",
    });
  });

  it("gives separate scoring requests distinct idempotency keys", async () => {
    const { client } = clientFor();
    await casework.scoreCaseworkCase(client, "case-1", { facts: 4 });
    await casework.scoreCaseworkCase(client, "case-1", { facts: 4 });

    expect(client.rpc).toHaveBeenCalledTimes(2);
    const [first, second] = client.rpc.mock.calls.map(([, args]) => args.p_idempotency_key);
    expect(first).not.toBe(second);
  });

  it.each([undefined, ""])("sends an absent alert note as null (%s)", async (note) => {
    const { client } = clientFor();
    await casework.acknowledgeCaseworkAlert(client, "alert-1", note);
    expect(client.rpc).toHaveBeenCalledExactlyOnceWith("casework_acknowledge_alert", {
      p_alert_id: "alert-1", p_note: null,
    });
  });

  it("routes the remaining case commands and inserts with the authenticated actor", async () => {
    const { client, queries } = clientFor();
    const scope = { id: "case-1", organization_id: "org-1", chapter_id: "ch-1" };
    await casework.setCaseworkRestriction(client, scope.id, true, "Sensitive witness information");
    await casework.grantCaseworkAccess(client, scope.id, "staff-2", "Preparing the follow-up meeting");
    expect(client.rpc).toHaveBeenCalledWith("casework_grant_access", { p_case_id: "case-1", p_grantee_user_id: "staff-2", p_reason: "Preparing the follow-up meeting" });
    // SEC-UG-CASEWORK-DEADLINES-ALERTS-INSERT-MISSING-EVENT-ROW-20260920:
    // creation is the audited RPC, never a direct insert.
    await casework.createCaseworkDeadline(client, scope, { kind: "response", label: "  File response  ", dueAt: "2026-09-01", reminderAt: "" });
    expect(client.rpc).toHaveBeenCalledWith("casework_create_deadline", { p_case_id: "case-1", p_kind: "response", p_label: "File response", p_due_at: "2026-09-01", p_reminder_at: null });
    expect(queries.get("casework_deadlines")?.insert).toBeUndefined();
    await casework.requestCaseworkDeadlineExtension(client, "deadline-1", "2026-09-03", "Need records");
    await casework.decideCaseworkDeadlineExtension(client, "extension-1", "approved");
    await casework.createCaseworkAlert(client, scope, { kind: "deadline", severity: "high", message: "  Deadline approaching  ", escalationDueAt: "" });
    expect(client.rpc).toHaveBeenCalledWith("casework_create_alert", { p_case_id: "case-1", p_kind: "deadline", p_severity: "high", p_message: "Deadline approaching", p_escalation_due_at: null });
    expect(queries.get("casework_alerts")?.insert).toBeUndefined();
    await casework.createCaseworkReminder(client, scope, { title: "  Call member  ", remindAt: "2026-09-02", recurrence: "" });
    expect(client.rpc).toHaveBeenCalledWith("create_my_case_reminder", { p_case_id: "case-1", p_title: "Call member", p_remind_at: "2026-09-02", p_recurrence: "none" });
    expect(queries.get("casework_reminders")?.insert).toBeUndefined();
    await casework.logCaseworkManagementBehavior(client, scope.id, { displayName: "Manager", occurredAt: "2026-08-28", category: "meeting", summary: "Denied request" });
    await casework.addCaseworkManagementAddendum(client, "entry-1", "Follow-up details");
    await casework.linkCaseworkCases(client, scope.id, "case-2", "related");
    await casework.setCaseworkReminderStatus(client, "reminder-1", "snooze", null);
    for (const [, args] of client.rpc.mock.calls) {
      expect(args).not.toHaveProperty("p_organization_id");
      expect(args).not.toHaveProperty("p_chapter_id");
    }
    const rpcNames = client.rpc.mock.calls.map(([name]) => name);
    expect(rpcNames).not.toContain("casework_advance_step");
    expect(rpcNames).not.toContain("casework_set_checklist_item");
  });

  it("loads and assembles bargaining, drafts and patterns without checklist templates", async () => {
    const { client } = clientFor({
      casework_bargaining_workspaces: [{ id: "workspace-1" }],
      casework_bargaining_proposals: [{ id: "proposal-1", workspace_id: "workspace-1" }, { id: "proposal-2", workspace_id: "other" }],
      casework_bargaining_events: [{ id: "event-1", workspace_id: "workspace-1" }],
      casework_intake_drafts: [{ id: "draft-1" }],
      casework_retaliation_patterns: [{ id: "pattern-1" }],
      casework_checklist_templates: [{ id: "template-1" }],
    });
    const result = await casework.loadCaseworkHub(client, "ch-1");
    expect(result.workspaces[0].proposals).toHaveLength(1);
    expect(result.workspaces[0].events).toHaveLength(1);
    expect(result.drafts).toEqual([{ id: "draft-1" }]);
    expect(result.patterns).toMatchObject({ name: "list_patterns", args: { chapterId: "ch-1" } });
    // Stage checklist templates are gone with the grievance procedure.
    expect(result).not.toHaveProperty("templates");
    expect(client.from).not.toHaveBeenCalledWith("casework_checklist_templates");
    await expect(casework.loadCaseworkHub(client, "")).rejects.toThrow("Chapter id required");
    const empty = clientFor().client;
    expect((await casework.loadCaseworkHub(empty, "ch-1")).workspaces).toEqual([]);
    expect(empty.from).not.toHaveBeenCalledWith("casework_bargaining_proposals");
  });

  it("covers hub mutation commands", async () => {
    const { client } = clientFor();
    await casework.createCaseworkBargainingWorkspace(client, "ch-1", "2027 bargaining");
    await casework.addCaseworkBargainingProposal(client, "workspace-1", { side: "union", title: "Article 3", body: "Language", responseDueAt: "" });
    await casework.transitionCaseworkBargainingProposal(client, "proposal-1", "proposed", "countered");
    await casework.addCaseworkBargainingEvent(client, "workspace-1", "pulse", "Caucus complete", "steady");
    await casework.setCaseworkBargainingStatus(client, "workspace-1", "draft", "live");
    await casework.saveCaseworkIntakeDraft(client, { chapterId: "ch-1", payload: { title: "Draft" } });
    await casework.scanCaseworkRetaliationPatterns(client, "ch-1");
    await casework.reviewCaseworkRetaliationPattern(client, "pattern-1", "reviewed", "No common actor");
    await casework.submitCaseworkRetaliationReport(client, { caseId: "case-1", incidentAt: "2026-08-28", managementPerson: "Manager", protectedActivity: "Filed", adverseAction: "Schedule changed" });
    await casework.withdrawCaseworkRetaliationReport(client, "report-1", "Revise details");
    await casework.bulkUpdateCaseworkCases(client, ["case-1"], "active", { step: "must-not-pass" });
    expect(client.rpc).toHaveBeenLastCalledWith("casework_bulk_update_cases", expect.objectContaining({
      p_next_status: null,
      p_next_step: null,
    }));
    expect(client.rpc).toHaveBeenCalledTimes(11);
    expect(client.rpc.mock.calls.map(([name]) => name)).not.toContain("casework_create_checklist_template");
  });

  it("loads member reports and filtered, paginated case history", async () => {
    const { client, queries } = clientFor({
      casework_retaliation_reports: [{ id: "report-1" }],
      member_cases: { data: [{ id: "case-1", user_id: "member-1" }, { id: "case-2", user_id: null }], count: 7 },
      member_profiles: [{ id: "member-1", full_name: "Member One" }],
    });
    expect(await casework.loadMemberRetaliationReports(client, "case-1")).toEqual([{ id: "report-1" }]);
    const result = await casework.loadCaseworkHistory(client, { page: 2, status: "active", caseType: "Scheduling", step: "Step%,1", restricted: "restricted", search: " GRV%,1 " });
    expect(result).toMatchObject({ total: 7, page: 2, pageSize: 50 });
    expect(result.rows[0].member.full_name).toBe("Member One");
    expect(queries.get("member_cases").range).toHaveBeenCalledWith(100, 149);
    expect(queries.get("member_cases").eq).toHaveBeenCalledWith("status", "active");
    expect(queries.get("member_cases").eq).toHaveBeenCalledWith("case_type", "Scheduling");
    expect(queries.get("member_cases").eq).toHaveBeenCalledWith("is_restricted", true);
    // No step filter or step column: a stale step option is ignored.
    expect(queries.get("member_cases").ilike).not.toHaveBeenCalled();
    expect(queries.get("member_cases").select.mock.calls[0][0].split(",")).not.toContain("step");
    expect(queries.get("member_cases").or).toHaveBeenCalledWith("reference.ilike.%GRV1%,title.ilike.%GRV1%");
    const standard = clientFor({ member_cases: [] });
    const empty = await casework.loadCaseworkHistory(standard.client, { page: -1, status: "all", restricted: "standard", search: " %,% " });
    expect(empty).toMatchObject({ rows: [], total: 0, page: 0 });
    expect(standard.client.from).not.toHaveBeenCalledWith("member_profiles");
  });

  it("surfaces auth and database failures instead of optimistic fiction", async () => {
    const { client } = clientFor();
    client.rpc.mockResolvedValueOnce({ data: null, error: { message: "case not found", code: "P0002" } });
    await expect(casework.setCaseworkRestriction(client, "missing", true, "Sensitive")).rejects.toThrow("case not found");
    client.auth.getUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    await expect(casework.loadCaseworkHistory(client)).rejects.toThrow("Authenticated actor required");
    client.auth.getUser.mockResolvedValueOnce({ data: null, error: { code: "401" } });
    await expect(casework.createCaseworkDeadline(client, { id: "case-1" }, {})).rejects.toThrow();
  });
});

// Keep the casework composition assertions independent of HTTP transport.
vi.mock("../src/lib/sensitiveContentApi.js", () => ({ sensitiveContentRpc: (client, name, args) => name === "list_retaliation"
  ? client.from("casework_retaliation_reports").select("*").eq("case_id", args.caseId).order("created_at", { ascending: false }).then(result => ({ ...result, data: { reports: result.data, nextCursor: null } }))
  : client.rpc(name, args) }));

describe("coordinator deadlines card API", () => {
  // REQ-UG-STEWARD-CASE-STEP-DEADLINE-AND-TITLE-CONTROLS-20261006
  it("reads open procedural clocks only for the named cases, soonest first", async () => {
    const pages = [[{ id: "d-1", case_id: "case-1", kind: "response", label: "County answer due", due_at: "2026-10-16T21:00:00Z", status: "active" }], []];
    const chains = [];
    const client = { from: vi.fn((table) => { expect(table).toBe("casework_deadlines"); const chain = query(pages[chains.length]); chains.push(chain); return chain; }) };
    const rows = await casework.listOpenCaseworkDeadlines(client, ["case-1", "case-2", "case-1", ""]);
    expect(rows).toEqual([{ id: "d-1", caseId: "case-1", kind: "response", label: "County answer due", dueAt: "2026-10-16T21:00:00Z", status: "active" }]);
    expect(chains).toHaveLength(2);
    for (const chain of chains) {
      expect(chain.in).toHaveBeenCalledWith("case_id", ["case-1", "case-2"]);
      expect(chain.in).toHaveBeenCalledWith("status", ["active", "extended", "missed"]);
    }
    expect(chains[0].order).toHaveBeenCalledWith("due_at");
  });

  it("asks about every named case in batches and merges the clocks soonest first", async () => {
    const ids = Array.from({ length: 250 }, (_, index) => `case-${String(index).padStart(3, "0")}`);
    const row = (id, caseId, dueAt, status = "active") => ({ id, case_id: caseId, kind: "response", label: "", due_at: dueAt, status });
    // Per batch: the from-today read, then the earlier read.
    const pages = [
      [row("d-a", "case-000", "2026-10-20T15:00:00Z")], [],
      [row("d-b", "case-150", "2026-10-09T15:00:00Z")], [row("d-old", "case-120", "2026-09-01T15:00:00Z", "missed")],
      [row("d-c", "case-249", "2026-10-12T15:00:00Z", "extended")], [],
    ];
    const chains = [];
    const client = { from: vi.fn(() => { const chain = query(pages[chains.length]); chains.push(chain); return chain; }) };
    const now = new Date(2026, 9, 8, 12, 0, 0);
    const rows = await casework.listOpenCaseworkDeadlines(client, ids, { now });
    expect(chains).toHaveLength(6);
    const since = now.toISOString();
    expect(chains.filter((_, index) => index % 2 === 0).flatMap((chain) => chain.in.mock.calls.filter(([column]) => column === "case_id").flatMap(([, batch]) => batch))).toEqual(ids);
    for (const [index, chain] of chains.entries()) {
      expect(chain.in).toHaveBeenCalledWith("status", ["active", "extended", "missed"]);
      if (index % 2 === 0) {
        expect(chain.gte).toHaveBeenCalledWith("due_at", since);
        expect(chain.order).toHaveBeenCalledWith("due_at");
      } else {
        // Old missed clocks are bounded on their own, newest first.
        expect(chain.lt).toHaveBeenCalledWith("due_at", since);
        expect(chain.order).toHaveBeenCalledWith("due_at", { ascending: false });
        expect(chain.limit).toHaveBeenCalledWith(20);
      }
    }
    expect(rows.map((entry) => entry.id)).toEqual(["d-old", "d-b", "d-c", "d-a"]);
  });

  it("does not let a day of already-passed clocks crowd clocks still ahead out of the read", async () => {
    // A table fake that applies the filters, order and limit the read asks for.
    const now = new Date(2026, 9, 8, 18, 0, 0);
    const table = Array.from({ length: 250 }, (_, index) => ({ id: `passed-${index}`, case_id: "case-1", kind: "procedure", label: "", due_at: new Date(2026, 9, 8, 1, 0, index).toISOString(), status: "active" }));
    table.push({ id: "tomorrow", case_id: "case-1", kind: "hearing", label: "", due_at: new Date(2026, 9, 9, 10, 0, 0).toISOString(), status: "active" });
    function tableQuery() {
      let rows = table;
      let order = null;
      let limit = Infinity;
      const chain = {
        select: () => chain,
        in: (column, values) => { rows = rows.filter((row) => values.includes(row[column])); return chain; },
        gte: (column, value) => { rows = rows.filter((row) => Date.parse(row[column]) >= Date.parse(value)); return chain; },
        lt: (column, value) => { rows = rows.filter((row) => Date.parse(row[column]) < Date.parse(value)); return chain; },
        order: (column, { ascending = true } = {}) => { order = { column, ascending }; return chain; },
        limit: (count) => { limit = count; return chain; },
        then: (resolve, reject) => {
          const sorted = [...rows].sort((a, b) => (Date.parse(a[order.column]) - Date.parse(b[order.column])) * (order.ascending ? 1 : -1));
          return Promise.resolve({ data: sorted.slice(0, limit), error: null }).then(resolve, reject);
        },
      };
      return chain;
    }
    const rows = await casework.listOpenCaseworkDeadlines({ from: () => tableQuery() }, ["case-1"], { now });
    expect(rows.map((row) => row.id)).toContain("tomorrow");
    expect(rows.at(-1).id).toBe("tomorrow");
  });

  it("asks nothing when no case is named and surfaces a refused read", async () => {
    const { client } = clientFor();
    expect(await casework.listOpenCaseworkDeadlines(client, [])).toEqual([]);
    expect(client.from).not.toHaveBeenCalled();
    const refused = clientFor({ casework_deadlines: { data: null, error: { message: "permission denied", code: "42501" } } });
    await expect(casework.listOpenCaseworkDeadlines(refused.client, ["case-1"])).rejects.toThrow();
  });
});

describe("removed grievance procedure API", () => {
  // Union Ground leaves grievance steps, procedures, stage checklists, ULP
  // deadlines, retaliation timing flags, the strength suggestion and the web
  // member progress view out (owner decision, 2026-10-13).
  it("exports no step, procedure, checklist, ULP or member-progress command", () => {
    for (const name of [
      "advanceCaseworkStep", "CASEWORK_BOARD_MOVE_OUTCOME", "saveProcedure", "listProcedures", "getCaseProcedure",
      "setHolidays", "getStarterProcedure", "loadStarterProcedure", "loadMemberCasework",
      "setCaseworkChecklistItem", "createCaseworkChecklistTemplate", "loadMemberCaseUlpSummary",
      "listCaseRetaliationFlags", "flagCaseworkRetaliationIncident", "reviewCaseworkRetaliationFlag",
      "listCaseworkUlpDeadlines", "scanCaseworkRetaliationTiming", "suggestCaseworkStrength",
    ]) expect(casework, name).not.toHaveProperty(name);
  });

  it("reads no by-step or median-per-step dashboard aggregate", async () => {
    const { client } = clientFor();
    client.rpc.mockImplementation(async () => ({ data: [], error: null }));
    const dashboards = await casework.loadCaseDashboards(client);
    const names = client.rpc.mock.calls.map(([name]) => name);
    expect(names).toEqual(expect.arrayContaining([
      "casework_dashboard_deadlines_due_soon", "casework_dashboard_overdue_deadlines", "casework_dashboard_open_cases_by_assignee",
    ]));
    expect(names).not.toContain("casework_dashboard_open_cases_by_step");
    expect(names).not.toContain("casework_dashboard_median_days_per_step");
    expect(dashboards).not.toHaveProperty("byStep");
    expect(dashboards).not.toHaveProperty("medianDays");
  });

  it("asks the server whether the worker's own issue is managed, true only on a true answer", async () => {
    const { client } = clientFor();
    client.rpc.mockResolvedValueOnce({ data: true, error: null });
    expect(await casework.getMyCaseManaged(client, "case-1")).toBe(true);
    expect(client.rpc).toHaveBeenLastCalledWith("get_my_member_case_managed", { p_case_id: "case-1" });
    client.rpc.mockResolvedValueOnce({ data: null, error: null });
    expect(await casework.getMyCaseManaged(client, "case-1")).toBe(false);
    client.rpc.mockResolvedValueOnce({ data: null, error: { message: "case unavailable", code: "42501" } });
    await expect(casework.getMyCaseManaged(client, "case-1")).rejects.toThrow("case unavailable");
  });
});

describe("casework board-move outcome vocabulary", () => {
  it("maps the board-move key through the catalogue and passes unknown values through", async () => {
    const t = (key) => ({ "caseworkOutcome.board_move": "Moved on the case board." })[key] ?? key;
    const tEs = (key) => ({ "caseworkOutcome.board_move": "Movido en el tablero de casos." })[key] ?? key;
    expect(casework.formatCaseworkOutcome("board_move", t)).toBe("Moved on the case board.");
    expect(casework.formatCaseworkOutcome("board_move", tEs)).toBe("Movido en el tablero de casos.");
    expect(casework.formatCaseworkOutcome("Filed with management", t)).toBe("Filed with management");
    expect(casework.formatCaseworkOutcome("Moved on the case board.", tEs)).toBe("Moved on the case board.");
    expect(casework.formatCaseworkOutcome("Movido en el tablero de casos.", t)).toBe("Movido en el tablero de casos.");
    expect(casework.formatCaseworkOutcome("", t)).toBe("");
    expect(casework.formatCaseworkOutcome(null, t)).toBe("");
  });

  // Review regression (Opus, 2026-09-18): the key lookup must be own-property
  // only, and the catalogue result must be a string before it is returned.
  it("returns a string verbatim for outcomes that collide with Object.prototype members", () => {
    const t = (key) => ({ "caseworkOutcome.board_move": "Moved on the case board." })[key] ?? key;
    for (const inherited of ["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf"]) {
      const rendered = casework.formatCaseworkOutcome(inherited, t);
      expect(typeof rendered, `${inherited} must render as a string`).toBe("string");
      expect(rendered).toBe(inherited);
    }
  });

  it("falls back to the stored value when the catalogue returns a non-string", () => {
    expect(casework.formatCaseworkOutcome("board_move", () => undefined)).toBe("board_move");
    expect(casework.formatCaseworkOutcome("board_move", () => ({}))).toBe("board_move");
  });

  // SEC-UG-CASE-CSV-EXPORT-UNAUDITED-UNBOUNDED-20260917: the export receipt
  // sends ids, a scope and facet NAMES and nothing else. No row, no filter
  // value, no count the caller asserts for itself — the routine derives the
  // count, the actor and the tenant.
  it("records a case export through the RPC with ids, scope and facet names only", async () => {
    const { client } = clientFor();
    const result = await casework.recordCaseworkCaseExport(client, ["case-1", "case-2"], "selection", ["status"]);
    expect(client.rpc).toHaveBeenCalledWith("casework_record_case_export", {
      p_case_ids: ["case-1", "case-2"],
      p_scope: "selection",
      p_filter_keys: ["status"],
    });
    expect(Object.keys(result.args)).toEqual(["p_case_ids", "p_scope", "p_filter_keys"]);
    const { client: bare } = clientFor();
    await casework.recordCaseworkCaseExport(bare, ["case-1"], "visible");
    expect(bare.rpc.mock.calls[0][1].p_filter_keys).toEqual([]);
  });
});

// BUG-UG-CASE-MACRO-WRITE-AUDIENCE-WIDER-THAN-READ-20260917. The one save
// refusal the macro editor translates is identified by a server-issued HINT,
// not by prose, because 42501 alone is also "macro scope cannot change".
describe("casework macro audience refusal", () => {
  it("recognises only the hinted authorization refusal", () => {
    expect(casework.CASEWORK_MACRO_AUDIENCE_HINT).toBe("casework_macro_audience");
    expect(casework.isCaseworkMacroAudienceRefusal(
      { code: "42501", hint: "casework_macro_audience" })).toBe(true);
    // Same SQLSTATE, different decision.
    expect(casework.isCaseworkMacroAudienceRefusal({ code: "42501", hint: null })).toBe(false);
    // Same hint, but not an authorization refusal — a message alone never
    // qualifies, so a validation error carrying borrowed text cannot be
    // relabelled as an authorization decision.
    expect(casework.isCaseworkMacroAudienceRefusal(
      { code: "22023", hint: "casework_macro_audience" })).toBe(false);
    expect(casework.isCaseworkMacroAudienceRefusal(
      { message: "casework_macro_audience" })).toBe(false);
    expect(casework.isCaseworkMacroAudienceRefusal(new Error("boom"))).toBe(false);
    expect(casework.isCaseworkMacroAudienceRefusal(null)).toBe(false);
    expect(casework.isCaseworkMacroAudienceRefusal(undefined)).toBe(false);
  });
});
