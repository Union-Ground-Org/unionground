import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  composeAnalyticsCore,
  createPreviewAnalyticsSnapshot,
  createPreviewAnalyticsWorkspace,
  createPreviewAnalyticsViewer,
} from "../src/features/analytics/index.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { buildMi1AnalyticsActor } from "../src/lib/mi1AnalyticsWiring.js";
import { AnalyticsCoreView } from "../src/views/AnalyticsCoreView.jsx";
import { createAnalyticsCoreAdapter } from "../src/features/analytics/adapter.js";
import { showAnalyticsView } from "./helpers/analyticsView.js";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";

function wrap(node) {
  return render(<LanguageProvider lang="en">{node}</LanguageProvider>);
}

describe("MI1 analytics web view", () => {
  it("keeps the desk empty when no organization is selected", async () => {
    wrap(<AnalyticsCoreView viewer={buildMi1AnalyticsActor({
      userId: "admin-a",
      roles: ["admin"],
      mfaSatisfied: true,
      selectedHat: "admin",
    })} client={null} />);
    expect(await screen.findByRole("heading", { name: "No organization yet" })).toBeInTheDocument();
  });

  it("renders analytics as unset without a snapshot RPC", async () => {
    wrap(<AnalyticsCoreView viewer={buildMi1AnalyticsActor({
      userId: "admin-a",
      organizationId: ORG,
      roles: ["admin"],
      mfaSatisfied: true,
      selectedHat: "admin",
    })} client={null} />);
    // Exact copy, not a multi-branch regex: a loose regex here would still
    // pass if this admin were wrongly shown the unauthorized state instead of
    // unset.
    expect(await screen.findByText(
      "Organization analytics are reserved and not wired yet for this environment.",
    )).toBeInTheDocument();
  });

  it("keeps the member hat unauthorized even when staff grants exist", async () => {
    wrap(<AnalyticsCoreView viewer={buildMi1AnalyticsActor({
      userId: "admin-a",
      organizationId: ORG,
      roles: ["admin"],
      selectedHat: "member",
    })} client={null} />);
    expect(await screen.findByRole("heading", { name: "Analytics isn't open to this role" })).toBeInTheDocument();
  });

  it("shows Try again when loadDesk throws", async () => {
    const adapter = {
      loadDesk: vi.fn().mockRejectedValue(new Error("analytics snapshot failed")),
      exportDesk: vi.fn(),
    };
    wrap(<AnalyticsCoreView viewer={buildMi1AnalyticsActor({
      userId: "admin-a",
      organizationId: ORG,
      roles: ["admin"],
      mfaSatisfied: true,
      selectedHat: "admin",
    })} client={null} api={adapter} />);
    expect(await screen.findByRole("heading", { name: "Analytics could not load" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(adapter.loadDesk.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("shows Try again when loadDesk hangs past the deadline", async () => {
    const adapter = {
      loadDesk: vi.fn(() => new Promise(() => {})),
      exportDesk: vi.fn(),
    };
    wrap(<AnalyticsCoreView viewer={buildMi1AnalyticsActor({
      userId: "admin-a",
      organizationId: ORG,
      roles: ["admin"],
      mfaSatisfied: true,
      selectedHat: "admin",
    })} client={null} api={adapter} loadDeadlineMs={40} />);
    expect(await screen.findByRole("heading", { name: "Analytics took too long" })).toBeInTheDocument();
    const calls = adapter.loadDesk.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(adapter.loadDesk.mock.calls.length).toBe(calls + 1);
  });

  // REQ-UG-PULSE-WEB-EXPLORER-AND-STUDIO-20261031: the Charts studio
  // view is the shared Pulse chart builder; the preview reads the labeled
  // Tamarack fixture, never the earlier layout store.
  it("loads preview data and opens the Pulse chart builder in the Charts studio view", async () => {
    const onOpenPulse = vi.fn();
    wrap(<AnalyticsCoreView viewer={buildMi1AnalyticsActor({
      userId: "admin-a",
      organizationId: "preview-analytics-org",
      roles: ["admin"],
      mfaSatisfied: true,
      selectedHat: "admin",
    })} client={null} preview onOpenPulse={onOpenPulse} />);

    await screen.findByRole("navigation", { name: "Analytics sections" });
    showAnalyticsView("Charts studio");
    expect(await screen.findByRole("heading", { name: "Your charts" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: /Chapter sign-ups$/ })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Layout name" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Pulse" }));
    expect(onOpenPulse).toHaveBeenCalledTimes(1);
  });

  // An injected desk api keeps the layout studio (REQ-UNIONGROUND-PULSE-WEB-
  // EXPLORER-AND-STUDIO-20261031 renders the Pulse builder only for the wired
  // and preview desks). The view's save, remove and export callbacks call the
  // adapter, re-read the desk after a confirmed change, and pass refusals on.
  it("saves, removes and exports through an injected desk api, re-reading the desk after each confirmed change", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => "11111111-1111-4111-8111-111111111111" });
    const base = createAnalyticsCoreAdapter({
      fetchSnapshot: async () => createPreviewAnalyticsSnapshot(),
      fetchWorkspace: async () => createPreviewAnalyticsWorkspace(),
    });
    const adapter = {
      ...base,
      loadDesk: vi.fn((options) => base.loadDesk(options)),
      saveLayout: vi.fn().mockResolvedValueOnce({ ok: false, reason: "save_failed" }).mockResolvedValue({ ok: true }),
      deleteLayout: vi.fn(async () => ({ ok: true })),
      exportDesk: vi.fn(async () => ({ ok: false, reason: "export_failed" })),
    };
    wrap(<AnalyticsCoreView viewer={buildMi1AnalyticsActor({
      userId: "admin-a",
      organizationId: "preview-analytics-org",
      roles: ["admin"],
      mfaSatisfied: true,
      selectedHat: "admin",
    })} client={null} api={adapter} />);
    await screen.findByRole("navigation", { name: "Analytics sections" });
    const reads = () => adapter.loadDesk.mock.calls.length;
    const initialReads = reads();

    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(await screen.findByText("The export could not be prepared. Try again.")).toBeInTheDocument();
    expect(adapter.exportDesk).toHaveBeenCalledWith(expect.objectContaining({ state: "ready" }), expect.objectContaining({ selectedHat: "admin" }), { format: "csv" });

    showAnalyticsView("Charts studio");
    fireEvent.change(screen.getByRole("textbox", { name: "Layout name" }), { target: { value: "Health briefing" } });
    fireEvent.click(screen.getByRole("button", { name: "Save layout" }));
    expect(await screen.findByText("The layout could not be saved.")).toBeInTheDocument();
    expect(reads()).toBe(initialReads);
    fireEvent.click(screen.getByRole("button", { name: "Save layout" }));
    await waitFor(() => expect(adapter.saveLayout).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(reads()).toBe(initialReads + 1));

    await screen.findByRole("navigation", { name: "Analytics sections" });
    showAnalyticsView("Charts studio");
    fireEvent.click(screen.getAllByRole("button", { name: "Remove" })[0]);
    await waitFor(() => expect(adapter.deleteLayout).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(reads()).toBe(initialReads + 2));
    vi.unstubAllGlobals();
  });

  function deferred() {
    let resolve;
    const promise = new Promise((next) => {
      resolve = next;
    });
    return { promise, resolve };
  }

  function readyAnalyticsModel() {
    return composeAnalyticsCore({
      snapshot: createPreviewAnalyticsSnapshot(),
      viewer: createPreviewAnalyticsViewer({ selectedHat: "admin", roles: ["admin"] }),
    });
  }

  async function renderReadyDesk(focusTarget) {
    const scope = deferred();
    const client = {
      rpc: vi.fn((name) => {
        if (name !== "get_my_chapter_memberships") return Promise.resolve({ data: null, error: null });
        return scope.promise.then((organizationId) => ({
          data: [{
            selected: true,
            organizationId,
            chapterId: "chapter-a",
            organizationRoles: ["admin"],
            chapterRoles: [],
          }],
          error: null,
        }));
      }),
    };
    const adapter = {
      loadDesk: vi.fn()
        .mockResolvedValueOnce(readyAnalyticsModel())
        .mockImplementation(() => new Promise(() => {})),
      exportDesk: vi.fn(),
    };
    wrap(
      <>
        <nav>
          <button type="button">Shell nav</button>
        </nav>
        <AnalyticsCoreView
          viewer={buildMi1AnalyticsActor({
            userId: "admin-a",
            organizationId: ORG,
            roles: ["admin"],
            mfaSatisfied: true,
            selectedHat: "admin",
          })}
          client={client}
          api={adapter}
        />
      </>,
    );
    const exportButton = await screen.findByRole("button", { name: "Export CSV" });
    const focusNode = {
      export: exportButton,
      tab: screen.getByRole("button", { name: "Activity" }),
      stats: screen.getByRole("combobox", { name: "Show" }),
      shell: screen.getByRole("button", { name: "Shell nav" }),
    }[focusTarget];
    focusNode.focus();
    expect(document.activeElement).toBe(focusNode);
    return {
      adapter,
      focused: focusNode,
      async blankScope() {
        await act(async () => {
          scope.resolve(OTHER_ORG);
          await scope.promise;
        });
        await waitFor(() => {
          expect(screen.queryByRole("button", { name: "Export CSV" })).not.toBeInTheDocument();
        });
      },
    };
  }

  it.each([
    ["export", "Export CSV"],
    ["tab", "Activity"],
    ["stats", "Show"],
  ])("restores heading focus when a scope answer blanks a desk focused on %s", async (focusTarget) => {
    const desk = await renderReadyDesk(focusTarget);
    expect(desk.adapter.loadDesk.mock.calls[0][0].viewer.organizationId).toBe(ORG);
    await desk.blankScope();
    expect(screen.getByText(/Loading organization analytics/)).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Organization analytics" }));
    expect(document.activeElement).not.toBe(document.body);
    expect(desk.adapter.loadDesk.mock.calls.at(-1)[0].viewer.organizationId).toBe(OTHER_ORG);
  });

  it("leaves shell focus in place when a scope answer blanks the analytics desk", async () => {
    const desk = await renderReadyDesk("shell");
    await desk.blankScope();
    expect(screen.getByText(/Loading organization analytics/)).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Shell nav" }));
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).not.toBe(screen.getByRole("heading", { name: "Organization analytics" }));
  });

  it("keeps the ready-desk wrapper from changing column layout or entry motion", async () => {
    await renderReadyDesk("tab");
    const screenRoot = document.querySelector(".screen.mi1-ana");
    const wrapper = document.querySelector(".mi1-ana > .mi1-ana__ready[data-analytics-ready-subtree]");
    const tabs = screen.getByRole("navigation", { name: "Analytics sections" });
    expect(screenRoot).toBeTruthy();
    expect(wrapper).toBeTruthy();
    expect(wrapper.parentElement).toBe(screenRoot);
    expect(wrapper.contains(tabs)).toBe(true);
    expect(wrapper.contains(screen.getByRole("button", { name: "Activity" }))).toBe(true);
    expect(wrapper.contains(screen.getByRole("combobox", { name: "Show" }))).toBe(true);
    expect(tabs.parentElement).toBe(wrapper);
    expect(wrapper.className).toBe("mi1-ana__ready");
    expect([...screenRoot.children].some((node) => node.classList.contains("phead"))).toBe(true);
    expect([...screenRoot.children].some((node) => node.classList.contains("mi1-ana__ready"))).toBe(true);
  });

  // BUG-UG-TAMARACK-WEB-ANALYTICS-FULL-RUN-FAILURE-CAUSE-20261021:
  // the Tamarack failure, end to end through the wired adapter. The browser
  // drops the first workspace read (net::ERR_NETWORK_CHANGED reaches
  // postgrest-js as status 0); Campaign charts must still load, not show
  // "These charts could not load".
  it("loads Campaign charts when the browser drops the first workspace read of every load", async () => {
    const PREVIEW_ORG = "preview-analytics-org";
    // Every desk load reads the snapshot and the workspace together; the
    // first workspace read after each snapshot read is the one dropped, so
    // only a retry inside the same load can recover.
    let workspaceReads = 0;
    let dropNextWorkspaceRead = false;
    const client = {
      rpc: vi.fn(async (name) => {
        if (name === "get_my_chapter_memberships") {
          return { data: [{ selected: true, organizationId: PREVIEW_ORG, chapterId: "north", organizationRoles: ["admin"], chapterRoles: [] }], error: null, status: 200 };
        }
        if (name === "get_organization_analytics_snapshot") {
          dropNextWorkspaceRead = true;
          return { data: createPreviewAnalyticsSnapshot(), error: null, status: 200 };
        }
        if (name === "get_organization_analytics_workspace") {
          workspaceReads += 1;
          if (!dropNextWorkspaceRead) return { data: createPreviewAnalyticsWorkspace(), error: null, status: 200 };
          dropNextWorkspaceRead = false;
          return { data: null, error: { message: "TypeError: Failed to fetch", details: "", hint: "", code: "" }, count: null, status: 0, statusText: "" };
        }
        return { data: null, error: null, status: 200 };
      }),
    };
    wrap(
      <AnalyticsCoreView
        viewer={buildMi1AnalyticsActor({ userId: "admin-a", organizationId: PREVIEW_ORG, roles: ["admin"], mfaSatisfied: true, selectedHat: "admin" })}
        client={client}
      />,
    );
    await screen.findByRole("button", { name: "Export CSV" });
    showAnalyticsView("Campaign charts");
    expect(await screen.findByRole("heading", { name: "Campaign charts" })).toBeInTheDocument();
    expect(screen.queryByText("These charts could not load")).not.toBeInTheDocument();
    expect(workspaceReads).toBeGreaterThanOrEqual(2);
  });
});
