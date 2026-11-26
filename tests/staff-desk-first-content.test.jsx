import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import { loadAdvisorDesk, loadCoordinatorDesk, loadStewardDesk } from "../src/lib/memberApi.js";
import { AdvisorView } from "../src/views/AdvisorView.jsx";
import { CoordinatorView } from "../src/views/CoordinatorView.jsx";
import { StewardView } from "../src/views/StewardView.jsx";

const data = { member: { id: "reader", chapterId: "chapter-1", initials: "FR" }, events: [] };
const caseRow = { id: "case-1", user_id: "member-1", chapter_id: "chapter-1", status: "active", title: "Fixture case", reference: "GR-F1" };
const request = { id: "request-1", user_id: "member-1", status: "requested", member_name: "Fixture requester", created_at: "2026-11-20T14:00:00Z", total_count: 1 };
const kpis = { byStep: [{ step: "Step 1", count: 6 }] };

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

function deferred() {
  let resolve;
  const promise = new Promise((land) => { resolve = land; });
  return { promise, resolve };
}

function answer(data) {
  return { data, error: null };
}

function clientFor(replies, tables = {}) {
  const empty = answer([]);
  return {
    rpc: vi.fn((name) => Promise.resolve(replies[name] ?? empty)),
    from: vi.fn((name) => {
      let result = tables[name] ?? empty;
      const query = new Proxy({}, {
        get: (_, key) => key === "then" ? (...args) => Promise.resolve(result).then(...args) : (column, value) => {
          if (key === "eq" && column === "status" && value === "resolved") result = empty;
          return query;
        },
      });
      return query;
    }),
  };
}

function page(view, path, child) {
  window.history.replaceState({}, "", path);
  return <WorkspacePages view={view} hat={view} location={path} navigate={vi.fn()}>{child}</WorkspacePages>;
}

it("shows Advisor chapter health while optional reads are unresolved, then loads the roster on its own page", async () => {
  const workload = deferred();
  const roster = deferred();
  const client = clientFor({ get_advisor_overview: answer({ membersCovered: 87 }), get_workload_stats: workload.promise, get_staff_roster: roster.promise });
  const api = { loadDesk: (options) => loadAdvisorDesk(client, options) };
  const tree = (path) => page("advisor", path, <AdvisorView data={data} api={api} />);
  const view = render(tree("/m/advisor"));
  try {
    await act(async () => {});
    expect(screen.getByText("87")).toBeVisible();
    expect(client.rpc.mock.calls.map(([name]) => name)).toEqual(["get_advisor_overview"]);
    view.rerender(tree("/m/advisor/leadership"));
    await act(async () => {});
    expect(client.rpc).toHaveBeenCalledWith("get_staff_roster", { p_chapter_only: true });
    expect(screen.getByText("Loading campaign health…")).toHaveAttribute("role", "status");
  } finally {
    await act(async () => { workload.resolve(answer({ enoughData: false })); roster.resolve(answer([])); });
  }
});


it("starts Coordinator case enrichment before the independent KPIs resolve", async () => {
  const aggregates = deferred();
  const client = clientFor({ get_coordinator_kpis: aggregates.promise, list_coordinator_cases: answer([caseRow]) });
  const pending = loadCoordinatorDesk(client);
  try {
    await act(async () => {});
    expect(client.rpc).toHaveBeenCalledWith("list_case_latest_updates", expect.objectContaining({ p_case_ids: ["case-1"] }));
  } finally {
    aggregates.resolve(answer(kpis));
    await pending;
  }
  expect(await pending).toMatchObject({ kpis, cases: [{ id: "case-1" }] });
});


it("shows Steward requests while the unrelated workload and form reads are unresolved", async () => {
  const workload = deferred();
  const forms = deferred();
  const client = clientFor({ list_steward_requests: answer([request]), get_steward_workload_intelligence: workload.promise, list_steward_forms: forms.promise },
    { member_cases: answer([caseRow]) });
  client.auth = { getSession: async () => answer({ session: { user: { id: "reader" } } }) };
  const api = { loadDesk: (options) => loadStewardDesk(client, options) };
  render(page("committee member", "/m/steward/requests", <StewardView data={data} api={api} />));
  try {
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Fixture requester" })).toBeVisible();
    expect(client.rpc.mock.calls.map(([name]) => name)).not.toContain("get_steward_workload_intelligence");
    expect(client.rpc.mock.calls.map(([name]) => name)).not.toContain("list_steward_forms");
    fireEvent.click(screen.getByRole("button", { name: "Fixture requester" }));
    expect(screen.getByRole("button", { name: t("en", "steward.requestOpenCase", { reference: "GR-F1" }) })).toBeVisible();
  } finally {
    await act(async () => { workload.resolve(answer(null)); forms.resolve(answer([])); });
  }
});

it("waits for Forms review after Worker requests and reuses the full desk on return", async () => {
  const forms = deferred();
  const client = clientFor({ list_steward_requests: answer([request]), list_steward_forms: forms.promise });
  const api = { loadDesk: vi.fn((options) => loadStewardDesk(client, options)) };
  const tree = (path) => page("committee member", path, <StewardView data={data} api={api} />);
  const view = render(tree("/m/steward/requests"));
  try {
    await screen.findByRole("button", { name: "Fixture requester" });
    view.rerender(tree("/m/steward/forms"));
    expect(screen.getByText("Loading the committee desk…")).toBeVisible();
    expect(screen.queryByText(t("en", "steward.formsEmpty"))).toBeNull();
  } finally {
    await act(async () => { forms.resolve(answer([])); });
  }
  expect(await screen.findByText(t("en", "steward.formsEmpty"))).toBeVisible();
  view.rerender(tree("/m/steward/requests"));
  expect(await screen.findByRole("button", { name: "Fixture requester" })).toBeVisible();
  expect(api.loadDesk.mock.calls).toEqual([[{ requestsOnly: true }], [{ overviewOnly: false }]]);
});
