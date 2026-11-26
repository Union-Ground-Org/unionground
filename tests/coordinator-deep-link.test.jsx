import { caseListOpenerName } from "./helpers/case-list-opener.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CoordinatorView } from "../src/views/CoordinatorView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { clearDeviceParityState } from "../src/lib/deviceParity.js";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";

const actor = {
  userId: "coordinator-jordan",
  selectedOrganizationId: "org-a",
  roles: ["coordinator"],
  membershipStatus: "active",
};

const cases = [
  {
    id: "case-a",
    subjectUserId: "member-a",
    memberName: "Renata Cole",
    memberInitials: "RC",
    reference: "GRV-2026-014",
    title: "Mandated overtime without notice",
    caseType: "Grievance",
    articles: "Art. 21 §3",
    step: "Step 2",
    status: "active",
    deadline: "2026-10-15",
    deadlineLabel: "Oct 15",
    updatedAt: "2026-09-20T12:00:00Z",
    assignedAt: "2026-09-18T09:00:00Z",
    coordinatorName: "Dana Ortiz",
    updates: [],
    updatesTotal: 0,
  },
  {
    id: "case-b",
    subjectUserId: "member-b",
    memberName: "Devon Pratt",
    memberInitials: "DP",
    reference: "GRV-2026-015",
    title: "Denied schedule accommodation",
    caseType: "Grievance",
    articles: "",
    step: "Step 1",
    status: "active",
    deadline: "2026-10-20",
    deadlineLabel: "Oct 20",
    updatedAt: "2026-09-20T13:00:00Z",
    assignedAt: "2026-09-19T09:00:00Z",
    coordinatorName: null,
    updates: [],
    updatesTotal: 0,
  },
];

function desk(rows = cases) {
  return {
    kpis: {
      openCases: rows.filter((item) => item.status === "active").length,
      dueThisWeek: 0,
      inArbitration: 0,
      resolved: 0,
      resolutionRate: 0,
      byStep: [],
      byArticle: [],
    },
    cases: rows.map((item) => ({ ...item })),
  };
}

function makeApi(readDesk = () => desk()) {
  return {
    loadDesk: vi.fn(async () => structuredClone(readDesk())),
    loadCases: vi.fn(async () => ({ cases: structuredClone(readDesk().cases), nextCursor: null })),
    recordAccess: vi.fn().mockResolvedValue({ ok: true }),
  };
}

function renderDesk(api) {
  return render(
    <LanguageProvider lang="en">
      <CoordinatorView
        data={{ member: { id: actor.userId, initials: "JP" } }}
        accessActor={actor}
        api={api}
        onNotice={() => {}}
      />
    </LanguageProvider>,
  );
}

function viewedCaseCalls(api, entityId) {
  return api.recordAccess.mock.calls.filter(([, payload]) => (
    payload?.action === "viewed_case" && payload?.entityId === entityId
  ));
}

function caseRow(memberName) {
  return screen.getByRole("button", { name: caseListOpenerName(cases.find((item) => item.memberName === memberName)) });
}

afterEach(() => {
  window.history.replaceState({}, "", "/m/coordinator");
  clearDeviceParityState();
});

describe("coordinator desk deep links", () => {
  it("opens a linked case once, records one access event, and does not re-fire on close, other-case select, or desk reloads", async () => {
    window.history.replaceState({}, "", "/m/coordinator?case=case-a");
    const api = makeApi();
    const { rerender } = renderDesk(api);

    const linkedRow = await screen.findByRole("button", { name: caseListOpenerName(cases[0]) });
    await waitFor(() => expect(linkedRow).toHaveAttribute("aria-expanded", "true"));
    await waitFor(() => expect(api.recordAccess).toHaveBeenCalledTimes(1));
    expect(api.recordAccess).toHaveBeenCalledWith(actor, {
      subjectUserId: "member-a",
      action: "viewed_case",
      entityType: "case",
      entityId: "case-a",
    });
    expect(document.querySelector(".gq-detail")).not.toBeNull();

    fireEvent.click(linkedRow);
    await waitFor(() => expect(caseRow("Renata Cole")).toHaveAttribute("aria-expanded", "false"));
    // The current-tree bug re-opens from the still-present ?case= after paint.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.recordAccess).toHaveBeenCalledTimes(1);
    expect(caseRow("Renata Cole")).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector(".gq-detail")).toBeNull();

    fireEvent.click(caseRow("Devon Pratt"));
    await waitFor(() => expect(caseRow("Devon Pratt")).toHaveAttribute("aria-expanded", "true"));
    expect(caseRow("Renata Cole")).toHaveAttribute("aria-expanded", "false");
    expect(viewedCaseCalls(api, "case-a")).toHaveLength(1);

    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Devon" } });
    expect(screen.queryByRole("button", { name: caseListOpenerName(cases[0]) })).toBeNull();
    expect(caseRow("Devon Pratt")).toHaveAttribute("aria-expanded", "true");
    expect(viewedCaseCalls(api, "case-a")).toHaveLength(1);

    const reload = (rows) => {
      const nextApi = {
        ...api,
        loadDesk: vi.fn(async () => desk(rows)),
      };
      rerender(
        <LanguageProvider lang="en">
          <CoordinatorView
            data={{ member: { id: actor.userId, initials: "JP" } }}
            accessActor={actor}
            api={nextApi}
            onNotice={() => {}}
          />
        </LanguageProvider>,
      );
      return nextApi;
    };

    reload(cases.map((item) => ({ ...item })));
    await waitFor(() => expect(caseRow("Devon Pratt")).toHaveAttribute("aria-expanded", "true"));
    expect(screen.queryByRole("button", { name: caseListOpenerName(cases[0]) })).toBeNull();
    expect(viewedCaseCalls(api, "case-a")).toHaveLength(1);

    reload(cases.map((item) => ({ ...item, updates: [] })));
    await waitFor(() => expect(caseRow("Devon Pratt")).toHaveAttribute("aria-expanded", "true"));
    expect(screen.queryByRole("button", { name: caseListOpenerName(cases[0]) })).toBeNull();
    expect(viewedCaseCalls(api, "case-a")).toHaveLength(1);
  });

  it("does not consume a deep link when access logging fails, then retries on the next desk reload", async () => {
    window.history.replaceState({}, "", "/m/coordinator?case=case-a");
    let allowWrite = false;
    const api = makeApi();
    api.recordAccess = vi.fn(async () => ({ ok: allowWrite }));
    const { rerender } = renderDesk(api);

    await waitFor(() => expect(viewedCaseCalls(api, "case-a")).toHaveLength(1));
    await waitFor(() => expect(caseRow("Renata Cole")).toHaveAttribute("aria-expanded", "false"));
    expect(document.querySelector(".gq-detail")).toBeNull();

    allowWrite = true;
    const retryApi = {
      ...api,
      loadDesk: vi.fn(async () => desk(cases.map((item) => ({ ...item })))),
    };
    rerender(
      <LanguageProvider lang="en">
        <CoordinatorView
          data={{ member: { id: actor.userId, initials: "JP" } }}
          accessActor={actor}
          api={retryApi}
          onNotice={() => {}}
        />
      </LanguageProvider>,
    );

    await waitFor(() => expect(viewedCaseCalls(api, "case-a")).toHaveLength(2));
    await waitFor(() => expect(caseRow("Renata Cole")).toHaveAttribute("aria-expanded", "true"));
    expect(document.querySelector(".gq-detail")).not.toBeNull();
  });

  it("holds one in-flight deep-link open across a desk reload until access logging finishes", async () => {
    window.history.replaceState({}, "", "/m/coordinator?case=case-a");
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const api = makeApi();
    api.recordAccess = vi.fn(() => gate.then(() => ({ ok: true })));
    const { rerender } = renderDesk(api);

    await waitFor(() => expect(viewedCaseCalls(api, "case-a")).toHaveLength(1));
    expect(caseRow("Renata Cole")).toHaveAttribute("aria-expanded", "false");

    rerender(
      <LanguageProvider lang="en">
        <CoordinatorView
          data={{ member: { id: actor.userId, initials: "JP" } }}
          accessActor={actor}
          api={{
            ...api,
            loadDesk: vi.fn(async () => desk(cases.map((item) => ({ ...item })))),
          }}
          onNotice={() => {}}
        />
      </LanguageProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(viewedCaseCalls(api, "case-a")).toHaveLength(1);

    release();
    await waitFor(() => expect(caseRow("Renata Cole")).toHaveAttribute("aria-expanded", "true"));
    expect(viewedCaseCalls(api, "case-a")).toHaveLength(1);
  });

  it("retains every consumed linked id for the mount so returning to A after B does not write again", async () => {
    window.history.replaceState({}, "", "/m/coordinator?case=case-a");
    const api = makeApi();
    const { rerender } = renderDesk(api);

    await waitFor(() => expect(caseRow("Renata Cole")).toHaveAttribute("aria-expanded", "true"));
    expect(viewedCaseCalls(api, "case-a")).toHaveLength(1);

    const refresh = (search) => {
      window.history.replaceState({}, "", search);
      rerender(
        <LanguageProvider lang="en">
          <CoordinatorView
            data={{ member: { id: actor.userId, initials: "JP" } }}
            accessActor={actor}
            api={{
              ...api,
              loadDesk: vi.fn(async () => desk(cases.map((item) => ({ ...item })))),
            }}
            onNotice={() => {}}
          />
        </LanguageProvider>,
      );
    };

    refresh("/m/coordinator?case=case-b");
    await waitFor(() => expect(caseRow("Devon Pratt")).toHaveAttribute("aria-expanded", "true"));
    expect(viewedCaseCalls(api, "case-b")).toHaveLength(1);
    expect(viewedCaseCalls(api, "case-a")).toHaveLength(1);

    refresh("/m/coordinator?case=case-a");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(viewedCaseCalls(api, "case-a")).toHaveLength(1);
    expect(viewedCaseCalls(api, "case-b")).toHaveLength(1);
    expect(caseRow("Devon Pratt")).toHaveAttribute("aria-expanded", "true");
    expect(caseRow("Renata Cole")).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps a later manual case selection when the first deep-link write finishes late", async () => {
    window.history.replaceState({}, "", "/m/coordinator?case=case-a");
    let releaseA;
    const gateA = new Promise((resolve) => { releaseA = resolve; });
    const api = makeApi();
    api.recordAccess = vi.fn((_actor, payload) => (
      payload?.entityId === "case-a"
        ? gateA.then(() => ({ ok: true }))
        : Promise.resolve({ ok: true })
    ));
    const { rerender } = renderDesk(api);

    await waitFor(() => expect(viewedCaseCalls(api, "case-a")).toHaveLength(1));
    expect(caseRow("Renata Cole")).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(caseRow("Devon Pratt"));
    await waitFor(() => expect(caseRow("Devon Pratt")).toHaveAttribute("aria-expanded", "true"));
    expect(viewedCaseCalls(api, "case-b")).toHaveLength(1);

    releaseA();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(caseRow("Devon Pratt")).toHaveAttribute("aria-expanded", "true");
    expect(caseRow("Renata Cole")).toHaveAttribute("aria-expanded", "false");
    expect(viewedCaseCalls(api, "case-a")).toHaveLength(1);

    rerender(
      <LanguageProvider lang="en">
        <CoordinatorView
          data={{ member: { id: actor.userId, initials: "JP" } }}
          accessActor={actor}
          api={{
            ...api,
            loadDesk: vi.fn(async () => desk(cases.map((item) => ({ ...item })))),
          }}
          onNotice={() => {}}
        />
      </LanguageProvider>,
    );
    await waitFor(() => expect(caseRow("Devon Pratt")).toHaveAttribute("aria-expanded", "true"));
    expect(caseRow("Renata Cole")).toHaveAttribute("aria-expanded", "false");
    expect(viewedCaseCalls(api, "case-a")).toHaveLength(1);
  });

  it("does not reveal a pending deep link after the coordinator desk unmounts", async () => {
    window.history.replaceState({}, "", "/m/coordinator?case=case-a");
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const api = makeApi();
    api.recordAccess = vi.fn(() => gate.then(() => ({ ok: true })));
    const { unmount } = renderDesk(api);

    await waitFor(() => expect(viewedCaseCalls(api, "case-a")).toHaveLength(1));
    unmount();
    window.history.replaceState({}, "", "/m/coordinator");
    renderDesk(api);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(caseRow("Renata Cole")).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector(".gq-detail")).toBeNull();
    expect(viewedCaseCalls(api, "case-a")).toHaveLength(1);
  });

  it("cancels a pending linked reveal when the case query leaves or returns to a consumed id", async () => {
    window.history.replaceState({}, "", "/m/coordinator?case=case-a");
    let releaseB;
    const gateB = new Promise((resolve) => { releaseB = resolve; });
    const api = makeApi();
    api.recordAccess = vi.fn((_actor, payload) => (
      payload?.entityId === "case-b"
        ? gateB.then(() => ({ ok: true }))
        : Promise.resolve({ ok: true })
    ));
    const { rerender } = renderDesk(api);

    await waitFor(() => expect(caseRow("Renata Cole")).toHaveAttribute("aria-expanded", "true"));
    expect(viewedCaseCalls(api, "case-a")).toHaveLength(1);

    const refresh = (search) => {
      window.history.replaceState({}, "", search);
      rerender(
        <LanguageProvider lang="en">
          <CoordinatorView
            data={{ member: { id: actor.userId, initials: "JP" } }}
            accessActor={actor}
            api={{
              ...api,
              loadDesk: vi.fn(async () => desk(cases.map((item) => ({ ...item })))),
            }}
            onNotice={() => {}}
          />
        </LanguageProvider>,
      );
    };

    refresh("/m/coordinator?case=case-b");
    await waitFor(() => expect(viewedCaseCalls(api, "case-b")).toHaveLength(1));
    expect(caseRow("Devon Pratt")).toHaveAttribute("aria-expanded", "false");

    refresh("/m/coordinator");
    await new Promise((resolve) => setTimeout(resolve, 0));
    releaseB();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(caseRow("Devon Pratt")).toHaveAttribute("aria-expanded", "false");
    expect(caseRow("Renata Cole")).toHaveAttribute("aria-expanded", "true");
    expect(viewedCaseCalls(api, "case-b")).toHaveLength(1);
  });

  it("does not consume a linked case whose reveal was canceled after the query moved on", async () => {
    window.history.replaceState({}, "", "/m/coordinator?case=case-a");
    let releaseA;
    const gateA = new Promise((resolve) => { releaseA = resolve; });
    const api = makeApi();
    api.recordAccess = vi.fn((_actor, payload) => (
      payload?.entityId === "case-a"
        ? gateA.then(() => ({ ok: true }))
        : Promise.resolve({ ok: true })
    ));
    const { rerender } = renderDesk(api);

    await waitFor(() => expect(viewedCaseCalls(api, "case-a")).toHaveLength(1));
    expect(caseRow("Renata Cole")).toHaveAttribute("aria-expanded", "false");

    const refresh = (search) => {
      window.history.replaceState({}, "", search);
      rerender(
        <LanguageProvider lang="en">
          <CoordinatorView
            data={{ member: { id: actor.userId, initials: "JP" } }}
            accessActor={actor}
            api={{
              ...api,
              loadDesk: vi.fn(async () => desk(cases.map((item) => ({ ...item })))),
            }}
            onNotice={() => {}}
          />
        </LanguageProvider>,
      );
    };

    refresh("/m/coordinator?case=case-b");
    await waitFor(() => expect(caseRow("Devon Pratt")).toHaveAttribute("aria-expanded", "true"));
    expect(viewedCaseCalls(api, "case-b")).toHaveLength(1);

    releaseA();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(caseRow("Devon Pratt")).toHaveAttribute("aria-expanded", "true");
    expect(caseRow("Renata Cole")).toHaveAttribute("aria-expanded", "false");
    expect(viewedCaseCalls(api, "case-a")).toHaveLength(1);

    refresh("/m/coordinator?case=case-a");
    await waitFor(() => expect(caseRow("Renata Cole")).toHaveAttribute("aria-expanded", "true"));
    expect(viewedCaseCalls(api, "case-a")).toHaveLength(1);
    expect(caseRow("Devon Pratt")).toHaveAttribute("aria-expanded", "false");
  });

  it("observes a query-only route change without rebuilding the api or case array", async () => {
    window.history.replaceState({}, "", "/m/coordinator?case=case-a");
    const api = makeApi();
    const { rerender } = renderDesk(api);

    await waitFor(() => expect(caseRow("Renata Cole")).toHaveAttribute("aria-expanded", "true"));
    expect(viewedCaseCalls(api, "case-a")).toHaveLength(1);

    window.history.replaceState({}, "", "/m/coordinator?case=case-b");
    rerender(
      <LanguageProvider lang="en">
        <CoordinatorView
          data={{ member: { id: actor.userId, initials: "JP" } }}
          accessActor={actor}
          api={api}
          onNotice={() => {}}
        />
      </LanguageProvider>,
    );

    await waitFor(() => expect(caseRow("Devon Pratt")).toHaveAttribute("aria-expanded", "true"));
    expect(viewedCaseCalls(api, "case-b")).toHaveLength(1);
    expect(viewedCaseCalls(api, "case-a")).toHaveLength(1);
    expect(caseRow("Renata Cole")).toHaveAttribute("aria-expanded", "false");
  });

  it("does not consume a target that returns before its canceled audit settles", async () => {
    window.history.replaceState({}, "", "/m/coordinator?case=case-a");
    let releaseA;
    const gateA = new Promise((resolve) => { releaseA = resolve; });
    const api = makeApi();
    api.recordAccess = vi.fn((_actor, payload) => (
      payload?.entityId === "case-a"
        ? gateA.then(() => ({ ok: true }))
        : Promise.resolve({ ok: true })
    ));
    const { rerender } = renderDesk(api);

    await waitFor(() => expect(viewedCaseCalls(api, "case-a")).toHaveLength(1));
    expect(caseRow("Renata Cole")).toHaveAttribute("aria-expanded", "false");

    const refresh = (search, nextApi = api) => {
      window.history.replaceState({}, "", search);
      rerender(
        <LanguageProvider lang="en">
          <CoordinatorView
            data={{ member: { id: actor.userId, initials: "JP" } }}
            accessActor={actor}
            api={nextApi}
            onNotice={() => {}}
          />
        </LanguageProvider>,
      );
    };

    refresh("/m/coordinator?case=case-b");
    await waitFor(() => expect(caseRow("Devon Pratt")).toHaveAttribute("aria-expanded", "true"));
    expect(viewedCaseCalls(api, "case-b")).toHaveLength(1);

    refresh("/m/coordinator?case=case-a");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(viewedCaseCalls(api, "case-a")).toHaveLength(1);
    expect(caseRow("Renata Cole")).toHaveAttribute("aria-expanded", "false");

    releaseA();
    await waitFor(() => expect(caseRow("Renata Cole")).toHaveAttribute("aria-expanded", "true"));
    expect(viewedCaseCalls(api, "case-a")).toHaveLength(1);

    refresh("/m/coordinator?case=case-a", {
      ...api,
      loadDesk: vi.fn(async () => desk(cases.map((item) => ({ ...item })))),
    });
    await waitFor(() => expect(caseRow("Renata Cole")).toHaveAttribute("aria-expanded", "true"));
    expect(viewedCaseCalls(api, "case-a")).toHaveLength(1);
  });

  it.each([
    ["resolves ok: false", (gate) => gate.then(() => ({ ok: false }))],
    ["rejects", (gate) => gate.then(() => { throw new Error("audit down"); })],
  ])("retries a returned target once when its first audit %s", async (_label, failA) => {
    window.history.replaceState({}, "", "/m/coordinator?case=case-a");
    let releaseA;
    const gateA = new Promise((resolve) => { releaseA = resolve; });
    let firstA = true;
    const api = makeApi();
    api.recordAccess = vi.fn((_actor, payload) => {
      if (payload?.entityId !== "case-a") return Promise.resolve({ ok: true });
      if (firstA) {
        firstA = false;
        return failA(gateA);
      }
      return Promise.resolve({ ok: true });
    });
    const { rerender } = renderDesk(api);
    const refresh = (search) => {
      window.history.replaceState({}, "", search);
      rerender(
        <LanguageProvider lang="en">
          <CoordinatorView
            data={{ member: { id: actor.userId, initials: "JP" } }}
            accessActor={actor}
            api={api}
            onNotice={() => {}}
          />
        </LanguageProvider>,
      );
    };

    await waitFor(() => expect(viewedCaseCalls(api, "case-a")).toHaveLength(1));
    refresh("/m/coordinator?case=case-b");
    await waitFor(() => expect(caseRow("Devon Pratt")).toHaveAttribute("aria-expanded", "true"));
    refresh("/m/coordinator?case=case-a");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(viewedCaseCalls(api, "case-a")).toHaveLength(1);

    releaseA();
    await waitFor(() => expect(caseRow("Renata Cole")).toHaveAttribute("aria-expanded", "true"));
    expect(viewedCaseCalls(api, "case-a")).toHaveLength(2);
  });
});

// Union Ground issues have no grievance procedure (owner decision,
// 2026-10-13), so /m/coordinator/cases/board is no longer a page. A pasted
// board link lands on the plane's overview: it draws no board, offers no Board
// tab or page, and reveals no case behind the retired URL.
describe("coordinator desk legacy board deep link", () => {
  it("treats a retired board URL as no page and draws no board", async () => {
    window.history.replaceState({}, "", "/m/coordinator/cases/board?case=case-a");
    const api = makeApi();
    const navigate = vi.fn();
    const { container } = render(
      <LanguageProvider lang="en">
        <WorkspacePages view="coordinator" location="/m/coordinator/cases/board" navigate={navigate} hat="coordinator">
          <CoordinatorView
            data={{ member: { id: actor.userId, initials: "JP" } }}
            accessActor={actor}
            api={api}
            onNotice={() => {}}
          />
        </WorkspacePages>
      </LanguageProvider>,
    );

    await waitFor(() => expect(api.loadDesk).toHaveBeenCalled());
    // The system eyebrow heads only the timeline and outreach sections in this
    // edition; the overview's queue KPI shows the desk has drawn.
    await screen.findByText("Open issues in your queue");
    expect(container.querySelector(".workspace-pages")).toHaveAttribute("data-workspace-section", "overview");
    const pageMenu = screen.getByRole("navigation", { name: "Page menu" });
    // This edition's page picker lists its pages as links in a collapsed panel.
    const pageLinks = [...pageMenu.querySelectorAll(".workspace-page-menu__panel a")];
    expect(pageLinks.filter((link) => /board/i.test(link.textContent))).toEqual([]);
    const pagePaths = pageLinks.map((link) => new URL(link.href).pathname);
    expect(pagePaths).toContain("/m/coordinator/macros");
    expect(pagePaths.filter((value) => /board|settings|funnel|articles/.test(value))).toEqual([]);
    expect(screen.queryByRole("button", { name: /^Board/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Case board" })).toBeNull();
    expect(container.querySelector(".case-board-card")).toBeNull();
    expect(container.querySelector(".gq-detail")).toBeNull();
  });
});
