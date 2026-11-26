// @vitest-environment node
//
// sol PR #734 follow-ups, client half:
//   F8 — fetchAllFormTemplates walks the registry whole in deterministic
//        (sort, key, version) order, 500-row pages until a short one, and a
//        failed page degrades to the static fallback instead of a partial
//        registry (exercised through loadStewardDesk, whose
//        formTemplateVersions is the raw pass-through of the walk).
//   F9 — loadStewardAppointments carries page-one cursors and TRUE totals for
//        the panel's two lists; loadStewardAppointmentsPage forwards the
//        keyset walk and mirrors the SQL clamps; the pageStewardAppointments
//        demo twin replays the same semantics over in-memory rows.
// Same fake-client style as steward-desk-paging.test.js: a recording Proxy
// chain per table plus an rpc log.
import { describe, expect, it } from "vitest";
import {
  loadStewardAppointments,
  loadStewardAppointmentsPage,
  loadStewardDesk,
} from "../src/lib/memberApi.js";
import { pageStewardAppointments } from "../src/lib/stewardDeskPaging.js";

function recordingChain(result, log) {
  const proxy = new Proxy(function () {}, {
    get(_target, prop) {
      if (prop === "then") return (...args) => Promise.resolve(result).then(...args);
      return (...args) => {
        log.push([prop, args]);
        return proxy;
      };
    },
  });
  return proxy;
}

function deskClient({ uid = "steward-1", tables = {}, rpcs = {}, logs = {}, rpcCalls = [] } = {}) {
  return {
    auth: { getSession: async () => ({ data: { session: uid ? { user: { id: uid } } : null } }) },
    from: (table) => {
      logs[table] = logs[table] || [];
      // A table value may be an array of per-call results consumed FIFO —
      // form_template_registry is queried once per page of the registry walk.
      const canned = tables[table];
      const result = Array.isArray(canned) ? (canned.length > 1 ? canned.shift() : canned[0]) : canned;
      return recordingChain(result ?? { data: [], error: null }, logs[table]);
    },
    rpc: (name, args) => {
      rpcCalls.push([name, args]);
      return Promise.resolve(rpcs[name] ?? { data: [], error: null });
    },
  };
}

function templateRow(i) {
  return { key: `tmpl-${i}`, version: 1, label_en: `Template ${i}`, field_schema: { steps: [] } };
}

describe("form template registry walk (sol F8)", () => {
  it("pages past 500 rows until a short page and serves the WHOLE registry", async () => {
    const pageOne = Array.from({ length: 500 }, (_, i) => templateRow(i));
    const pageTwo = [templateRow(500), templateRow(501)];
    const logs = {};
    const client = deskClient({
      tables: { form_template_registry: [{ data: pageOne, error: null }, { data: pageTwo, error: null }] },
      logs,
    });
    const desk = await loadStewardDesk(client);
    expect(desk.formTemplateVersions).toHaveLength(502);
    expect(desk.formTemplateVersions[501].key).toBe("tmpl-501");
    // The walk is deterministic and windowed: (sort, key, version) order on
    // every page, ranges advancing by the page size.
    expect(logs.form_template_registry).toContainEqual(["order", ["sort"]]);
    expect(logs.form_template_registry).toContainEqual(["order", ["key"]]);
    expect(logs.form_template_registry).toContainEqual(["order", ["version"]]);
    expect(logs.form_template_registry).toContainEqual(["range", [0, 499]]);
    expect(logs.form_template_registry).toContainEqual(["range", [500, 999]]);
  });

  it("a page failing mid-walk degrades to the fallback, never a partial registry", async () => {
    const pageOne = Array.from({ length: 500 }, (_, i) => templateRow(i));
    const client = deskClient({
      tables: { form_template_registry: [{ data: pageOne, error: null }, { data: null, error: { message: "boom" } }] },
    });
    const desk = await loadStewardDesk(client);
    // 500 confirmed rows plus an unknown remainder is still a partial
    // registry — a draft pinned to a missing version would render the wrong
    // schema. The additive contract falls back instead.
    expect(desk.formTemplateVersions).toEqual([]);
  });
});

// Wire rows exactly as list_steward_appointments returns them: snake_case,
// resolved member name and the TRUE windowed total riding every row.
function apptRow(i, extra = {}) {
  return {
    id: `a${i}`,
    member_name: "Ada Union",
    appointment_type: "office_hours",
    duration_minutes: 30,
    starts_at: new Date(Date.UTC(2026, 7, 1, 0, i)).toISOString(),
    ends_at: new Date(Date.UTC(2026, 7, 1, 0, i + 30)).toISOString(),
    status: "confirmed",
    reason_category: "general",
    routed_via: "steward",
    total_count: 120,
    ...extra,
  };
}

function pagerClient(results = {}) {
  const calls = [];
  const client = {
    from: () => recordingChain({ data: [], error: null }, []),
    rpc: async (name, args) => {
      calls.push([name, args]);
      return results[name] ?? { data: [], error: null };
    },
  };
  return { client, calls };
}

describe("loadStewardAppointmentsPage", () => {
  it("forwards scope, keyset cursor, and limit to the RPC", async () => {
    const { client, calls } = pagerClient();
    await loadStewardAppointmentsPage(client, {
      scope: "recent",
      cursor: { startsAt: "2026-08-01T00:00:00Z", id: "a9" },
      limit: 10,
    });
    expect(calls[0]).toEqual(["list_steward_appointments", {
      p_scope: "recent",
      p_after_starts: "2026-08-01T00:00:00Z",
      p_after_id: "a9",
      p_limit: 10,
    }]);
  });

  it("defaults to upcoming with a null cursor", async () => {
    const { client, calls } = pagerClient();
    await loadStewardAppointmentsPage(client, {});
    expect(calls[0][1].p_scope).toBe("upcoming");
    expect(calls[0][1].p_after_starts).toBeNull();
    expect(calls[0][1].p_after_id).toBeNull();
    expect(calls[0][1].p_limit).toBe(50);
  });

  it("clamps a caller limit above each scope's cap so the cursor contract holds", async () => {
    const { client, calls } = pagerClient();
    await loadStewardAppointmentsPage(client, { scope: "upcoming", limit: 999 });
    expect(calls[0][1].p_limit).toBe(50);
    await loadStewardAppointmentsPage(client, { scope: "recent", limit: 999 });
    expect(calls[1][1].p_limit).toBe(20);
  });

  it("returns shaped rows, the last row's cursor on a full page, and the true total", async () => {
    const rows = [apptRow(1), apptRow(2)];
    const { client } = pagerClient({ list_steward_appointments: { data: rows, error: null } });
    const page = await loadStewardAppointmentsPage(client, { limit: 2 });
    expect(page.rows).toHaveLength(2);
    expect(page.rows[0]).toMatchObject({
      id: "a1",
      memberName: "Ada Union",
      type: "office_hours",
      durationMinutes: 30,
      status: "confirmed",
      reasonCategory: "general",
      routedVia: "steward",
    });
    expect(page.nextCursor).toEqual({ startsAt: rows[1].starts_at, id: "a2" });
    expect(page.total).toBe(120);
  });

  it("reports total 0 on an empty first page but null on an empty cursored page", async () => {
    const { client } = pagerClient();
    const first = await loadStewardAppointmentsPage(client, {});
    expect(first.total).toBe(0);
    expect(first.nextCursor).toBeNull();
    const later = await loadStewardAppointmentsPage(client, { cursor: { startsAt: "2026-08-01T00:00:00Z", id: "a9" } });
    expect(later.total).toBeNull();
  });
});

describe("loadStewardAppointments page-one seeds", () => {
  function camelRow(i, extra = {}) {
    return {
      id: `u${i}`,
      memberName: "Ada Union",
      type: "office_hours",
      durationMinutes: 30,
      startsAt: new Date(Date.UTC(2026, 7, 1, 0, i)).toISOString(),
      endsAt: new Date(Date.UTC(2026, 7, 1, 0, i + 30)).toISOString(),
      status: "confirmed",
      reasonCategory: "general",
      routedVia: "steward",
      ...extra,
    };
  }

  it("attaches a keyset cursor to a full page-one list and passes the true totals through", async () => {
    const upcoming = Array.from({ length: 50 }, (_, i) => camelRow(i));
    const blob = { schedule: null, windows: [], blackouts: [], connections: [], upcoming, upcomingTotal: 137, recent: [], recentTotal: 0, stats: { noShows30d: 0, completed30d: 0 } };
    const { client } = pagerClient({ get_steward_appointments: { data: blob, error: null } });
    const desk = await loadStewardAppointments(client);
    expect(desk.upcomingTotal).toBe(137);
    expect(desk.upcomingCursor).toEqual({ startsAt: upcoming[49].startsAt, id: "u49" });
    expect(desk.recentCursor).toBeNull();
    expect(desk.recentTotal).toBe(0);
  });

  it("a short page-one list ends the walk and an older payload shape stays honest", async () => {
    const blob = { upcoming: [camelRow(1)], recent: [camelRow(2, { status: "completed" })], stats: {} };
    const { client } = pagerClient({ get_steward_appointments: { data: blob, error: null } });
    const desk = await loadStewardAppointments(client);
    expect(desk.upcomingCursor).toBeNull();
    // No totals on the wire (pre-paging payload): rows.length, never more.
    expect(desk.upcomingTotal).toBe(1);
    expect(desk.recentTotal).toBe(1);
  });
});

describe("pageStewardAppointments demo twin", () => {
  const upcoming = [
    { id: "u1", startsAt: "2026-08-01T10:00:00Z" },
    { id: "u2", startsAt: "2026-08-02T10:00:00Z" },
    { id: "u3", startsAt: "2026-08-03T10:00:00Z" },
  ];

  it("upcoming ascends — ended-but-unmarked rows surface on page one", () => {
    const page = pageStewardAppointments([...upcoming].reverse(), { scope: "upcoming", limit: 2 });
    expect(page.rows.map((row) => row.id)).toEqual(["u1", "u2"]);
    expect(page.nextCursor).toEqual({ startsAt: "2026-08-02T10:00:00Z", id: "u2" });
    expect(page.total).toBe(3);
  });

  it("recent descends", () => {
    const page = pageStewardAppointments(upcoming, { scope: "recent", limit: 2 });
    expect(page.rows.map((row) => row.id)).toEqual(["u3", "u2"]);
    expect(page.nextCursor).toEqual({ startsAt: "2026-08-02T10:00:00Z", id: "u2" });
  });

  it("the cursor is a POSITION — a row deleted mid-walk cannot break the walk", () => {
    const page = pageStewardAppointments(
      upcoming.filter((row) => row.id !== "u2"),
      { scope: "upcoming", cursor: { startsAt: "2026-08-02T10:00:00Z", id: "u2" }, limit: 2 },
    );
    expect(page.rows.map((row) => row.id)).toEqual(["u3"]);
    expect(page.nextCursor).toBeNull();
  });

  it("a short page ends the walk", () => {
    const page = pageStewardAppointments(upcoming, { scope: "upcoming", limit: 5 });
    expect(page.rows).toHaveLength(3);
    expect(page.nextCursor).toBeNull();
  });
});
