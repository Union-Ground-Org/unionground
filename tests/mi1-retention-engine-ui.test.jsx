import { fireEvent, render, screen, waitFor, within, cleanup } from "@testing-library/react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { describe, expect, it, vi } from "vitest";
import { RetentionEnginePanel } from "../src/features/retention/RetentionEnginePanel.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue, dateTimeFormat } from "../src/lib/i18n.js";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { latestFnBody } from "./helpers/migration.js";
import { PLATFORM_ENFORCED_RETENTION_CLASSES } from "../src/features/retention/platformPurges.js";
import { expectHeldWriteFocus, expectOneWriteFromOneTick } from "./helpers/busyWriteFocus.js";

const policy = {
  dataClass: "organization_page_views",
  retentionDays: 180,
  minimumDays: 30,
  maximumDays: 3650,
  defaultDays: 180,
  executionEnabled: false,
  configured: true,
  updatedAt: "2026-08-28T12:00:00.000Z",
};

function engine(overrides = {}) {
  return {
    organizationId: "10000000-0000-4000-8000-000000000001",
    schedulerConfigured: false,
    policies: [policy],
    runs: [],
    ...overrides,
  };
}

function makeApi(overrides = {}) {
  return {
    saveRetentionPolicy: vi.fn().mockResolvedValue({ ok: true }),
    previewRetentionRun: vi.fn().mockResolvedValue({
      id: "run-1",
      dataClass: "organization_page_views",
      retentionDays: 180,
      mode: "dry_run",
      status: "previewed",
      eligibleCount: 12,
      deletedCount: 0,
      remainingCount: 0,
      confirmationPhrase: "AUTHORIZE organization_page_views",
      createdAt: "2026-08-28T12:00:00.000Z",
    }),
    authorizeRetentionRun: vi.fn().mockResolvedValue({ id: "run-1", status: "authorized" }),
    executeRetentionRun: vi.fn().mockResolvedValue({
      id: "run-1", status: "completed", deletedCount: 12, remainingCount: 0,
    }),
    ...overrides,
  };
}

const messageBodiesPolicy = {
  dataClass: "member_message_bodies",
  retentionDays: 1095,
  minimumDays: 365,
  maximumDays: 2555,
  defaultDays: 1095,
  executionEnabled: false,
  configured: true,
  updatedAt: "2026-08-28T12:00:00.000Z",
};

function renderPanel({ value = engine(), api = makeApi(), lang = "en", unavailableReason = null } = {}) {
  const reload = vi.fn();
  const onNotice = vi.fn();
  const view = render(<LanguageProvider lang={lang}>
    <RetentionEnginePanel engine={value} unavailableReason={unavailableReason} api={api} reload={reload} onNotice={onNotice} />
  </LanguageProvider>);
  return {
    api,
    reload,
    onNotice,
    rerender(nextValue) {
      view.rerender(<LanguageProvider lang={lang}>
        <RetentionEnginePanel engine={nextValue} unavailableReason={unavailableReason} api={api} reload={reload} onNotice={onNotice} />
      </LanguageProvider>);
    },
  };
}

function policySection(name) {
  return screen.getByRole("heading", { name }).closest("section");
}

describe("CR-104 retention engine Admin surface", () => {
  it("renders every live class in the fallback engine and preserves platform-enforced controls", () => {
    const liveClasses = [...latestFnBody("private.retention_data_class_config")
      .matchAll(/when '([a-z_]+)' then/g)].map(([, dataClass]) => dataClass);
    expect(liveClasses.length).toBeGreaterThan(0);
    const { api } = renderPanel({ value: fallbackData.adminDesk.retentionEngine });
    for (const dataClass of liveClasses) {
      const section = policySection(catalogue.en[`admin.retention.class.${dataClass}`]);
      expect(section).toBeInTheDocument();
      if (Object.hasOwn(PLATFORM_ENFORCED_RETENTION_CLASSES, dataClass)) {
        expect(within(section).queryByRole("checkbox")).not.toBeInTheDocument();
        expect(within(section).queryByRole("spinbutton")).not.toBeInTheDocument();
        expect(within(section).queryAllByRole("button")).toHaveLength(0);
      } else {
        expect(within(section).getByRole("spinbutton")).toBeInTheDocument();
        expect(within(section).getByRole("checkbox")).toBeInTheDocument();
      }
    }
    expect(api.saveRetentionPolicy).not.toHaveBeenCalled();
    expect(api.executeRetentionRun).not.toHaveBeenCalled();
  });

  it("renders unreadable state as unavailable and exposes no deletion action", () => {
    const { reload } = renderPanel({ value: null });
    expect(screen.getByText(/could not be loaded/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /authorize deletion/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /execute authorized/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reload).toHaveBeenCalledOnce();
  });

  // BUG-UG-RETENTION-ENGINE-STATE-UNKNOWN-FOR-ADMIN-20261009: the
  // deletion control stays withheld in every branch — that part was always
  // right — but the notice now names the cause, so an admin knows whether to
  // wait for a database change, retry, or report a version gap.
  it.each([
    ["missingConfiguration", /no retention engine yet/i],
    ["notPermitted", /two-step policy/i],
    ["readFailed", /could not be read just now/i],
    ["unrecognizedPayload", /does not recognize/i],
  ])("names %s instead of calling the engine state unknown", (reason, copy) => {
    const { reload } = renderPanel({ value: null, unavailableReason: reason });
    expect(screen.getByText(copy)).toBeInTheDocument();
    expect(screen.queryByText(/while its state is unknown/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /authorize deletion/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /execute authorized/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /preview eligible records/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("keeps the unnamed notice for a reason the desk did not report", () => {
    renderPanel({ value: null, unavailableReason: "something-else" });
    expect(screen.getByText(/while its state is unknown/i)).toBeInTheDocument();
  });

  // A failed or rejected read cannot know whether a save, an execution that
  // just completed, or the daily scheduler deleted anything, so no notice may
  // promise that nothing was deleted or that the rules are unchanged.
  it.each(["en", "es"])("never promises an unchanged state in %s", (lang) => {
    const notices = Object.entries(catalogue[lang])
      .filter(([key]) => key.startsWith("admin.retention.unavailableWhy."));
    expect(notices).toHaveLength(4);
    for (const [, text] of notices) {
      expect(text).not.toMatch(/nothing has been deleted|unchanged|no se ha eliminado nada|no han cambiado/i);
    }
  });

  it("names a missing configuration in Spanish too", () => {
    renderPanel({ value: null, unavailableReason: "missingConfiguration", lang: "es" });
    expect(screen.getByText(/todavía no tiene motor de retención/i)).toBeInTheDocument();
  });

  it("requires a valid window and the exact phrase before enabling deletion jobs", async () => {
    const { api, reload, onNotice } = renderPanel();
    const section = screen.getByRole("heading", { name: "Organization page views" }).closest("section");
    const save = within(section).getByRole("button", { name: "Save rule" });
    expect(save).toBeDisabled();

    fireEvent.click(within(section).getByRole("checkbox", {
      name: "Allow authorized manual and scheduled deletion jobs",
    }));
    const confirmation = within(section).getByRole("textbox", {
      name: /Type ENABLE organization_page_views/i,
    });
    fireEvent.change(confirmation, { target: { value: "enable organization_page_views" } });
    expect(save).toBeDisabled();
    fireEvent.change(confirmation, { target: { value: "ENABLE organization_page_views" } });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() => expect(api.saveRetentionPolicy).toHaveBeenCalledWith({
      dataClass: "organization_page_views",
      retentionDays: 180,
      executionEnabled: true,
      confirmation: "ENABLE organization_page_views",
    }));
    expect(onNotice).toHaveBeenCalledWith("Retention rule saved.");
    expect(reload).toHaveBeenCalledOnce();
  });

  // DOCS-UG-RETENTION-PLATFORM-PURGES-BYPASS-POLICY-AUDIT-20260921: a
  // global platform cron already deletes these two classes at their fixed
  // 90-day window, so an execution toggle on them controlled nothing.
  it("renders platform-enforced classes read-only, without an execution toggle", () => {
    const fixed = (dataClass) => ({
      ...policy, dataClass, retentionDays: 90, minimumDays: 90, maximumDays: 90, defaultDays: 90,
    });
    for (const lang of ["en", "es"]) {
      const { api } = renderPanel({
        lang,
        value: engine({ policies: [policy, fixed("public_event_rsvps"), fixed("deleted_chapter_tasks")] }),
      });
      for (const dataClass of ["public_event_rsvps", "deleted_chapter_tasks"]) {
        const section = policySection(catalogue[lang][`admin.retention.class.${dataClass}`]);
        expect(within(section).queryByRole("checkbox"), dataClass).toBeNull();
        expect(within(section).queryByRole("spinbutton"), dataClass).toBeNull();
        expect(within(section).queryByRole("textbox"), dataClass).toBeNull();
        expect(within(section).queryAllByRole("button"), dataClass).toHaveLength(0);
        expect(within(section).getByText(catalogue[lang]["admin.retention.platformEnforced"])).toBeInTheDocument();
        expect(within(section).getByText(
          catalogue[lang]["admin.retention.platformPurge"].replace("{days}", "90"),
        )).toBeInTheDocument();
      }
      // An engine-run class keeps its controls.
      const pageViews = policySection(catalogue[lang]["admin.retention.class.organization_page_views"]);
      expect(within(pageViews).getByRole("checkbox")).toBeInTheDocument();
      expect(api.saveRetentionPolicy).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it("keeps preview non-destructive and requires exact authorization before execution", async () => {
    const { api, reload, onNotice } = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Preview eligible records" }));
    expect(await screen.findByRole("heading", { name: "Current dry run" })).toBeInTheDocument();
    expect(screen.getByText("Eligible 12 · deleted 0 · remaining 0")).toBeInTheDocument();
    expect(api.authorizeRetentionRun).not.toHaveBeenCalled();
    expect(api.executeRetentionRun).not.toHaveBeenCalled();

    const authorize = screen.getByRole("button", { name: "Authorize deletion job" });
    const confirmation = screen.getByRole("textbox", {
      name: /Type AUTHORIZE organization_page_views/i,
    });
    expect(authorize).toBeDisabled();
    fireEvent.change(confirmation, { target: { value: "AUTHORIZE organization_page_views" } });
    fireEvent.click(authorize);
    await waitFor(() => expect(api.authorizeRetentionRun).toHaveBeenCalledWith(
      "run-1", "AUTHORIZE organization_page_views",
    ));
    expect(onNotice).toHaveBeenCalledWith("Retention job authorized for 15 minutes.");

    fireEvent.click(await screen.findByRole("button", { name: "Execute authorized job" }));
    await waitFor(() => expect(api.executeRetentionRun).toHaveBeenCalledWith("run-1"));
    expect(onNotice).toHaveBeenCalledWith("Retention job finished. Review the recorded counts below.");
    expect(reload).toHaveBeenCalledOnce();
  });

  it.each([
    ["en", "Preview eligible records", "Current dry run"],
    ["es", "Previsualizar registros elegibles", catalogue.es["admin.retention.previewTitle"]],
  ])("explains an empty preview instead of offering authorization (%s)", async (lang, previewName, title) => {
    const api = makeApi({
      previewRetentionRun: vi.fn().mockResolvedValue({
        id: "run-empty",
        dataClass: "organization_page_views",
        retentionDays: 180,
        mode: "dry_run",
        status: "previewed",
        eligibleCount: 0,
        confirmationPhrase: "AUTHORIZE organization_page_views",
      }),
    });
    renderPanel({ api, lang });
    fireEvent.click(await screen.findByRole("button", { name: previewName }));
    const preview = (await screen.findByRole("heading", { name: title })).closest("section");
    expect(within(preview).getByText(catalogue[lang]["admin.retention.nothingEligible"])).toBeInTheDocument();
    expect(within(preview).queryByRole("textbox")).toBeNull();
    expect(within(preview).queryByRole("button")).toBeNull();
    expect(api.authorizeRetentionRun).not.toHaveBeenCalled();
  });

  it("keeps an unsaved window, allow-execution tick and ENABLE phrase across a value-identical policies array", () => {
    const { rerender } = renderPanel();
    const section = policySection("Organization page views");
    fireEvent.change(within(section).getByRole("spinbutton"), { target: { value: "90" } });
    fireEvent.click(within(section).getByRole("checkbox", {
      name: "Allow authorized manual and scheduled deletion jobs",
    }));
    fireEvent.change(within(section).getByRole("textbox", {
      name: /Type ENABLE organization_page_views/i,
    }), { target: { value: "ENABLE organization_page_views" } });

    rerender(engine({ policies: [{ ...policy }] }));

    expect(within(section).getByRole("spinbutton")).toHaveValue(90);
    expect(within(section).getByRole("checkbox", {
      name: "Allow authorized manual and scheduled deletion jobs",
    })).toBeChecked();
    expect(within(section).getByRole("textbox", {
      name: /Type ENABLE organization_page_views/i,
    })).toHaveValue("ENABLE organization_page_views");
  });

  it("keeps class A drafts after class B saves and only B's server value changes", async () => {
    const { api, reload, rerender } = renderPanel({
      value: engine({ policies: [policy, messageBodiesPolicy] }),
    });
    const classA = policySection("Organization page views");
    fireEvent.change(within(classA).getByRole("spinbutton"), { target: { value: "90" } });
    fireEvent.click(within(classA).getByRole("checkbox", {
      name: "Allow authorized manual and scheduled deletion jobs",
    }));
    fireEvent.change(within(classA).getByRole("textbox", {
      name: /Type ENABLE organization_page_views/i,
    }), { target: { value: "ENABLE organization_page_views" } });

    const classB = policySection("Direct message bodies");
    fireEvent.change(within(classB).getByRole("spinbutton"), { target: { value: "730" } });
    fireEvent.click(within(classB).getByRole("button", { name: "Save rule" }));
    await waitFor(() => expect(api.saveRetentionPolicy).toHaveBeenCalledWith({
      dataClass: "member_message_bodies",
      retentionDays: 730,
      executionEnabled: false,
      confirmation: null,
    }));
    expect(reload).toHaveBeenCalledOnce();

    rerender(engine({
      policies: [
        { ...policy },
        { ...messageBodiesPolicy, retentionDays: 730 },
      ],
    }));

    expect(within(classA).getByRole("spinbutton")).toHaveValue(90);
    expect(within(classA).getByRole("checkbox", {
      name: "Allow authorized manual and scheduled deletion jobs",
    })).toBeChecked();
    expect(within(classA).getByRole("textbox", {
      name: /Type ENABLE organization_page_views/i,
    })).toHaveValue("ENABLE organization_page_views");
    expect(within(classB).getByRole("spinbutton")).toHaveValue(730);
    expect(within(classB).getByRole("checkbox", {
      name: "Allow authorized manual and scheduled deletion jobs",
    })).not.toBeChecked();
    expect(within(classB).queryByRole("textbox", { name: /Type ENABLE/i })).not.toBeInTheDocument();
  });

  it("resets drafts and confirmation when the selected organization changes", () => {
    const { rerender } = renderPanel();
    const section = policySection("Organization page views");
    fireEvent.change(within(section).getByRole("spinbutton"), { target: { value: "90" } });
    fireEvent.click(within(section).getByRole("checkbox", {
      name: "Allow authorized manual and scheduled deletion jobs",
    }));
    fireEvent.change(within(section).getByRole("textbox", {
      name: /Type ENABLE organization_page_views/i,
    }), { target: { value: "ENABLE organization_page_views" } });

    rerender(engine({
      organizationId: "20000000-0000-4000-8000-000000000002",
      policies: [{ ...policy }],
    }));

    expect(within(section).getByRole("spinbutton")).toHaveValue(180);
    expect(within(section).getByRole("checkbox", {
      name: "Allow authorized manual and scheduled deletion jobs",
    })).not.toBeChecked();
    expect(within(section).queryByRole("textbox", { name: /Type ENABLE/i })).not.toBeInTheDocument();
  });

  // The org reset lives in a passive effect, so React commits (and paints) one
  // frame for the newly selected organization while `drafts`, `preview` and the
  // typed phrases still belong to the previous one. `flushSync` reproduces that
  // exact frame: the commit lands, the passive effect has not run yet.
  it("suppresses retention actions during the committed frame after an organization switch", () => {
    const api = makeApi();
    const previousActEnvironment = globalThis.IS_REACT_ACT_ENVIRONMENT;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const tree = (value) => <LanguageProvider lang="en">
      <RetentionEnginePanel engine={value} api={api} reload={() => {}} onNotice={() => {}} />
    </LanguageProvider>;

    act(() => { root.render(tree(engine())); });
    const section = within(container)
      .getByRole("heading", { name: "Organization page views" }).closest("section");
    fireEvent.change(within(section).getByRole("spinbutton"), { target: { value: "90" } });
    fireEvent.click(within(section).getByRole("checkbox", {
      name: "Allow authorized manual and scheduled deletion jobs",
    }));
    fireEvent.change(within(section).getByRole("textbox", {
      name: /Type ENABLE organization_page_views/i,
    }), { target: { value: "ENABLE organization_page_views" } });
    expect(within(section).getByRole("button", { name: "Save rule" })).toBeEnabled();

    act(() => {
      flushSync(() => {
        root.render(tree(engine({
          organizationId: "20000000-0000-4000-8000-000000000002",
          policies: [{ ...policy }],
        })));
      });

      // Still inside the stale frame: tenant one's window, execution tick and
      // tenant-agnostic ENABLE phrase are on screen while `api` already talks to
      // tenant two. No action may be reachable.
      expect(within(section).getByRole("spinbutton")).toHaveValue(90);
      expect(within(section).getByRole("button", { name: "Save rule" })).toBeDisabled();
      expect(within(section).getByRole("button", { name: "Preview eligible records" })).toBeDisabled();
      fireEvent.click(within(section).getByRole("button", { name: "Save rule" }));
    });

    expect(api.saveRetentionPolicy).not.toHaveBeenCalled();
    expect(within(section).getByRole("spinbutton")).toHaveValue(180);
    expect(within(section).getByRole("button", { name: "Preview eligible records" })).toBeEnabled();
    act(() => { root.unmount(); });
    container.remove();
    globalThis.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
  });

  it("keeps drafts, preview and AUTHORIZE phrase through a retention-read outage", async () => {
    const { rerender } = renderPanel();
    const section = policySection("Organization page views");
    fireEvent.change(within(section).getByRole("spinbutton"), { target: { value: "90" } });
    fireEvent.click(within(section).getByRole("checkbox", {
      name: "Allow authorized manual and scheduled deletion jobs",
    }));
    fireEvent.change(within(section).getByRole("textbox", {
      name: /Type ENABLE organization_page_views/i,
    }), { target: { value: "ENABLE organization_page_views" } });

    fireEvent.click(screen.getByRole("button", { name: "Preview eligible records" }));
    const authorize = await screen.findByRole("textbox", {
      name: /Type AUTHORIZE organization_page_views/i,
    });
    fireEvent.change(authorize, { target: { value: "AUTHORIZE organization_page_views" } });

    rerender(null);
    expect(screen.getByText(/could not be loaded/i)).toBeInTheDocument();

    rerender(engine({ policies: [{ ...policy }] }));

    const restored = policySection("Organization page views");
    expect(within(restored).getByRole("spinbutton")).toHaveValue(90);
    expect(within(restored).getByRole("checkbox", {
      name: "Allow authorized manual and scheduled deletion jobs",
    })).toBeChecked();
    expect(within(restored).getByRole("textbox", {
      name: /Type ENABLE organization_page_views/i,
    })).toHaveValue("ENABLE organization_page_views");
    expect(screen.getByRole("heading", { name: "Current dry run" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", {
      name: /Type AUTHORIZE organization_page_views/i,
    })).toHaveValue("AUTHORIZE organization_page_views");
  });

  it("still resets after a retention-read outage when the recovered engine is a different organization", async () => {
    const { rerender } = renderPanel();
    const section = policySection("Organization page views");
    fireEvent.change(within(section).getByRole("spinbutton"), { target: { value: "90" } });
    fireEvent.click(within(section).getByRole("checkbox", {
      name: "Allow authorized manual and scheduled deletion jobs",
    }));
    fireEvent.change(within(section).getByRole("textbox", {
      name: /Type ENABLE organization_page_views/i,
    }), { target: { value: "ENABLE organization_page_views" } });

    fireEvent.click(screen.getByRole("button", { name: "Preview eligible records" }));
    await screen.findByRole("textbox", {
      name: /Type AUTHORIZE organization_page_views/i,
    });

    rerender(null);
    rerender(engine({
      organizationId: "20000000-0000-4000-8000-000000000002",
      policies: [{ ...policy }],
    }));

    const restored = policySection("Organization page views");
    expect(within(restored).getByRole("spinbutton")).toHaveValue(180);
    expect(within(restored).getByRole("checkbox", {
      name: "Allow authorized manual and scheduled deletion jobs",
    })).not.toBeChecked();
    expect(within(restored).queryByRole("textbox", { name: /Type ENABLE/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Current dry run" })).not.toBeInTheDocument();
  });

  it("seeds drafts when the first successful engine arrives after an unavailable read", () => {
    const { rerender } = renderPanel({ value: null });
    expect(screen.getByText(/could not be loaded/i)).toBeInTheDocument();
    rerender(engine());
    const section = policySection("Organization page views");
    expect(within(section).getByRole("spinbutton")).toHaveValue(180);
    expect(within(section).getByRole("checkbox", {
      name: "Allow authorized manual and scheduled deletion jobs",
    })).not.toBeChecked();
  });

  it("keeps an unsaved window when only the class execution seed changes", () => {
    const { rerender } = renderPanel();
    const section = policySection("Organization page views");
    fireEvent.change(within(section).getByRole("spinbutton"), { target: { value: "90" } });

    rerender(engine({
      policies: [{ ...policy, executionEnabled: true }],
    }));

    expect(within(section).getByRole("spinbutton")).toHaveValue(90);
    expect(within(section).getByRole("checkbox", {
      name: "Allow authorized manual and scheduled deletion jobs",
    })).toBeChecked();
    expect(within(section).queryByRole("textbox", { name: /Type ENABLE/i })).not.toBeInTheDocument();
  });

  it("keeps an unsaved execution tick and ENABLE phrase when only the window seed changes", () => {
    const { rerender } = renderPanel();
    const section = policySection("Organization page views");
    fireEvent.click(within(section).getByRole("checkbox", {
      name: "Allow authorized manual and scheduled deletion jobs",
    }));
    fireEvent.change(within(section).getByRole("textbox", {
      name: /Type ENABLE organization_page_views/i,
    }), { target: { value: "ENABLE organization_page_views" } });

    rerender(engine({
      policies: [{ ...policy, retentionDays: 90 }],
    }));

    expect(within(section).getByRole("spinbutton")).toHaveValue(90);
    expect(within(section).getByRole("checkbox", {
      name: "Allow authorized manual and scheduled deletion jobs",
    })).toBeChecked();
    expect(within(section).getByRole("textbox", {
      name: /Type ENABLE organization_page_views/i,
    })).toHaveValue("ENABLE organization_page_views");
  });

  it("does not reset drafts when a sibling admin card reloads with the same reload prop", () => {
    const value = engine();
    const { reload, rerender } = renderPanel({ value });
    const section = policySection("Organization page views");
    fireEvent.change(within(section).getByRole("spinbutton"), { target: { value: "90" } });
    fireEvent.click(within(section).getByRole("checkbox", {
      name: "Allow authorized manual and scheduled deletion jobs",
    }));
    fireEvent.change(within(section).getByRole("textbox", {
      name: /Type ENABLE organization_page_views/i,
    }), { target: { value: "ENABLE organization_page_views" } });

    reload();
    rerender({
      ...value,
      policies: value.policies.map((item) => ({ ...item })),
    });

    expect(within(section).getByRole("spinbutton")).toHaveValue(90);
    expect(within(section).getByRole("checkbox", {
      name: "Allow authorized manual and scheduled deletion jobs",
    })).toBeChecked();
    expect(within(section).getByRole("textbox", {
      name: /Type ENABLE organization_page_views/i,
    })).toHaveValue("ENABLE organization_page_views");
  });

  it("renders count-only history and Spanish controls", () => {
    renderPanel({
      lang: "es",
      value: engine({
        runs: [{
          id: "run-history",
          dataClass: "organization_page_views",
          retentionDays: 180,
          mode: "scheduled",
          status: "completed",
          eligibleCount: 9,
          deletedCount: 9,
          remainingCount: 0,
          completedAt: "2026-08-28T12:00:00.000Z",
        }],
      }),
    });
    expect(screen.getByRole("heading", { name: "Retención operativa de datos" })).toBeInTheDocument();
    expect(screen.getByText("Elegibles 9 · eliminados 9 · restantes 0")).toBeInTheDocument();
    expect(screen.getByText(/Trabajo programado · 180 días/)).toBeInTheDocument();
  });
});

it('configures, previews and authorizes the direct-message retention policy', async () => {
  const dataClass = 'member_message_bodies';
  const api = makeApi({ previewRetentionRun: vi.fn().mockResolvedValue({
    id: 'message-run', dataClass, status: 'previewed', eligibleCount: 2,
    confirmationPhrase: `AUTHORIZE ${dataClass}`,
  }) });
  renderPanel({ value: engine({policies:[{...policy,dataClass,retentionDays:1095,minimumDays:365,maximumDays:2555,defaultDays:1095}]}), api });
  const section=screen.getByRole('heading',{name:'Direct message bodies'}).closest('section');
  fireEvent.click(within(section).getByRole('checkbox'));
  fireEvent.change(within(section).getByRole('textbox',{name:/Type ENABLE/}),{target:{value:`ENABLE ${dataClass}`}});
  fireEvent.click(within(section).getByRole('button',{name:'Save rule'}));
  await waitFor(()=>expect(api.saveRetentionPolicy).toHaveBeenCalledWith({dataClass,retentionDays:1095,executionEnabled:true,confirmation:`ENABLE ${dataClass}`}));
  fireEvent.click(within(section).getByRole('button',{name:'Preview eligible records'}));
  const confirmation=await screen.findByRole('textbox',{name:/Type AUTHORIZE member_message_bodies/});
  expect(api.previewRetentionRun).toHaveBeenCalledWith(dataClass);
  fireEvent.change(confirmation,{target:{value:`AUTHORIZE ${dataClass}`}});
  fireEvent.click(screen.getByRole('button',{name:'Authorize deletion job'}));
  await waitFor(()=>expect(api.authorizeRetentionRun).toHaveBeenCalledWith('message-run',`AUTHORIZE ${dataClass}`));
});

describe("BUG-UG-RETENTION-PANEL-CONFIRMS-RUNS-THE-SERVER-REFUSED-20260920", () => {
  const SUCCESS_AUTHORIZED = "Retention job authorized for 15 minutes.";
  const SUCCESS_EXECUTED = "Retention job finished. Review the recorded counts below.";
  const REFUSED_EXPIRED = /preview window expired/i;
  const REFUSED_DISABLED = /deletion execution is disabled/i;
  const REFUSED_POLICY = /policy changed after authorization/i;
  const REFUSED_FAILED = /failed during execution/i;
  const REFUSED_UNKNOWN = /did not finish as authorized/i;

  async function authorizeFirstPreview(api) {
    fireEvent.click(screen.getByRole("button", { name: "Preview eligible records" }));
    const confirmation = await screen.findByRole("textbox", {
      name: /Type AUTHORIZE organization_page_views/i,
    });
    fireEvent.change(confirmation, { target: { value: "AUTHORIZE organization_page_views" } });
    fireEvent.click(screen.getByRole("button", { name: "Authorize deletion job" }));
    await waitFor(() => expect(api.authorizeRetentionRun).toHaveBeenCalled());
  }

  async function authorizeThenExecute(api) {
    await authorizeFirstPreview(api);
    await screen.findByRole("button", { name: "Execute authorized job" });
    fireEvent.click(screen.getByRole("button", { name: "Execute authorized job" }));
    await waitFor(() => expect(api.executeRetentionRun).toHaveBeenCalled());
  }

  it("names an expired preview window on authorize instead of confirming success", async () => {
    const api = makeApi({
      authorizeRetentionRun: vi.fn().mockResolvedValue({ id: "run-1", status: "expired" }),
    });
    const { onNotice } = renderPanel({ api });
    await authorizeFirstPreview(api);
    expect(onNotice).not.toHaveBeenCalledWith(SUCCESS_AUTHORIZED);
    expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(REFUSED_EXPIRED));
    expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/no records were deleted/i));
  });

  it("names an expired execution window on execute instead of blaming the preview", async () => {
    const api = makeApi({
      executeRetentionRun: vi.fn().mockResolvedValue({ id: "run-1", status: "expired" }),
    });
    const { onNotice, reload } = renderPanel({ api });
    await authorizeThenExecute(api);
    expect(onNotice).toHaveBeenCalledWith(SUCCESS_AUTHORIZED);
    expect(onNotice).not.toHaveBeenCalledWith(SUCCESS_EXECUTED);
    expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/authorization window expired before execution/i));
    expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/no records were deleted/i));
    expect(onNotice).not.toHaveBeenCalledWith(expect.stringMatching(/preview window expired before authorization/i));
    expect(reload).toHaveBeenCalled();
  });

  it("names each refused execute outcome instead of confirming success", async () => {
    const cases = [
      ["execution_disabled", REFUSED_DISABLED],
      ["policy_changed", REFUSED_POLICY],
      ["execution_failed", REFUSED_FAILED],
    ];
    for (const [failureCode, pattern] of cases) {
      const api = makeApi({
        executeRetentionRun: vi.fn().mockResolvedValue({
          id: "run-1", status: "failed", failureCode,
        }),
      });
      const { onNotice, reload } = renderPanel({ api });
      await authorizeThenExecute(api);
      expect(onNotice).toHaveBeenCalledWith(SUCCESS_AUTHORIZED);
      expect(onNotice).not.toHaveBeenCalledWith(SUCCESS_EXECUTED);
      expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(pattern));
      expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/no records were deleted/i));
      expect(reload).toHaveBeenCalled();
      cleanup();
    }
  });

  it("falls back to a non-success notice for an unrecognized status or failureCode", async () => {
    const api = makeApi({
      executeRetentionRun: vi.fn().mockResolvedValue({
        id: "run-1", status: "failed", failureCode: "something_new",
      }),
    });
    const { onNotice } = renderPanel({ api });
    await authorizeThenExecute(api);
    expect(onNotice).not.toHaveBeenCalledWith(SUCCESS_EXECUTED);
    expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(REFUSED_UNKNOWN));

    cleanup();
    const expiredApi = makeApi({
      authorizeRetentionRun: vi.fn().mockResolvedValue({ id: "run-1", status: "expired" }),
    });
    const expired = renderPanel({ api: expiredApi });
    await authorizeFirstPreview(expiredApi);
    expect(expired.onNotice).not.toHaveBeenCalledWith(SUCCESS_AUTHORIZED);
    expect(expired.onNotice).toHaveBeenCalledWith(expect.stringMatching(REFUSED_EXPIRED));
  });

  it("resolves the refusal notices in Spanish too", async () => {
    const api = makeApi({
      executeRetentionRun: vi.fn().mockResolvedValue({
        id: "run-1", status: "failed", failureCode: "execution_disabled",
      }),
    });
    const { onNotice } = renderPanel({ api, lang: "es" });
    fireEvent.click(await screen.findByRole("button", { name: "Previsualizar registros elegibles" }));
    const confirmation = await screen.findByRole("textbox", {
      name: /Escribe AUTHORIZE organization_page_views/i,
    });
    fireEvent.change(confirmation, { target: { value: "AUTHORIZE organization_page_views" } });
    fireEvent.click(screen.getByRole("button", { name: "Autorizar trabajo de eliminación" }));
    await waitFor(() => expect(api.authorizeRetentionRun).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: "Ejecutar trabajo autorizado" }));
    await waitFor(() => expect(api.executeRetentionRun).toHaveBeenCalled());
    expect(onNotice).not.toHaveBeenCalledWith("Terminó el trabajo de retención. Revisa los conteos registrados abajo.");
    expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/eliminación está deshabilitada/i));
    expect(onNotice).toHaveBeenCalledWith(expect.stringMatching(/no se eliminó ningún registro/i));
  });

  it("declares every refusal notice key in both catalogue locales", () => {
    const keys = [
      "admin.retention.refused.expired",
      "admin.retention.refused.executionExpired",
      "admin.retention.refused.executionDisabled",
      "admin.retention.refused.policyChanged",
      "admin.retention.refused.executionFailed",
      "admin.retention.refused.unknown",
    ];
    for (const key of keys) {
      expect(catalogue.en[key], `${key} missing in en`).toBeTruthy();
      expect(catalogue.es[key], `${key} missing in es`).toBeTruthy();
    }
  });
});

describe("A11Y-UG-RETENTION-HISTORY-ROWS-ARE-EACH-A-LIVE-REGION-20260920", () => {
  const historyRuns = [
    {
      id: "hist-completed",
      dataClass: "organization_page_views",
      retentionDays: 180,
      mode: "scheduled",
      status: "completed",
      eligibleCount: 9,
      deletedCount: 9,
      remainingCount: 0,
      completedAt: "2026-08-28T12:00:00.000Z",
    },
    {
      id: "hist-failed",
      dataClass: "member_message_bodies",
      retentionDays: 1095,
      mode: "manual",
      status: "failed",
      eligibleCount: 4,
      deletedCount: 0,
      remainingCount: 4,
      completedAt: "2026-08-27T12:00:00.000Z",
    },
    {
      id: "hist-expired",
      dataClass: "public_event_rsvps",
      retentionDays: 365,
      mode: "dry_run",
      status: "expired",
      eligibleCount: 1,
      deletedCount: 0,
      remainingCount: 1,
      completedAt: "2026-08-26T12:00:00.000Z",
    },
  ];

  function historyRows() {
    const history = screen.getByRole("heading", { name: "Run history" }).closest("section");
    return [...history.querySelectorAll(".retention-history__row")];
  }

  function expectStaticHistory() {
    const rows = historyRows();
    expect(rows.map((row) => row.querySelector("strong").textContent)).toEqual([
      "Organization page views",
      "Direct message bodies",
      "Public meeting RSVPs",
    ]);
    expect(rows[0].textContent).toContain("Scheduled job · 180 days");
    expect(rows[0].textContent).toContain("Completed");
    expect(rows[0].textContent).toContain("Eligible 9 · deleted 9 · remaining 0");
    expect(rows[1].textContent).toContain("Manual job · 1095 days");
    expect(rows[1].textContent).toContain("Failed safely");
    expect(rows[1].textContent).toContain("Eligible 4 · deleted 0 · remaining 4");
    expect(rows[2].textContent).toContain("Dry run · 365 days");
    expect(rows[2].textContent).toContain("Expired");
    expect(rows[2].textContent).toContain("Eligible 1 · deleted 0 · remaining 1");
    for (const row of rows) {
      expect(row.querySelector("[role='status']")).toBeNull();
      expect(row.querySelector("[aria-live]")).toBeNull();
    }
  }

  it("keeps settled history rows static and announces only the current dry run", async () => {
    renderPanel({ value: engine({ runs: historyRuns }) });
    expectStaticHistory();
    expect(screen.queryAllByRole("status")).toEqual([]);
    expect(screen.queryByRole("heading", { name: "Current dry run" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Preview eligible records" }));
    const preview = (await screen.findByRole("heading", { name: "Current dry run" })).closest("section");
    const live = within(preview).getAllByRole("status");
    expect(live).toHaveLength(1);
    expect(live[0]).toHaveAttribute("aria-live", "polite");
    expect(live[0].textContent).toContain("Preview ready");
    expect(live[0].textContent).toContain("Eligible 12 · deleted 0 · remaining 0");
    expect(screen.getAllByRole("status")).toEqual(live);
    expectStaticHistory();
  });
});

// UX-UG-RETENTION-STATUS-OMITS-DEADLINES-AND-FAILURE-CAUSES-20260920
// A run's row used to print the status word, the counts and one timestamp, so an
// admin could not see how long an authorized deletion job stays executable, nor
// why a refused one stopped — and the Execute button stayed enabled after the
// window closed, leaving the server to be the only thing that said no.
describe("UX-UG-RETENTION-STATUS-OMITS-DEADLINES-AND-FAILURE-CAUSES-20260920", () => {
  function authorizedApi(authorizationExpiresAt) {
    return makeApi({
      authorizeRetentionRun: vi.fn().mockResolvedValue({
        id: "run-1", status: "authorized", authorizationExpiresAt,
      }),
    });
  }

  async function authorize(api) {
    fireEvent.click(screen.getByRole("button", { name: "Preview eligible records" }));
    const confirmation = await screen.findByRole("textbox", {
      name: /Type AUTHORIZE organization_page_views/i,
    });
    fireEvent.change(confirmation, { target: { value: "AUTHORIZE organization_page_views" } });
    fireEvent.click(screen.getByRole("button", { name: "Authorize deletion job" }));
    await waitFor(() => expect(api.authorizeRetentionRun).toHaveBeenCalled());
    return screen.findByRole("button", { name: "Execute authorized job" });
  }

  function historyRow(engineValue, lang = "en") {
    renderPanel({ value: engineValue, lang });
    return screen.getByRole("article").querySelector(".retention-history__row");
  }

  function run(overrides) {
    return {
      id: "run-history",
      dataClass: "organization_page_views",
      retentionDays: 180,
      mode: "manual",
      status: "completed",
      eligibleCount: 9,
      deletedCount: 0,
      remainingCount: 9,
      completedAt: "2026-08-28T12:00:00.000Z",
      ...overrides,
    };
  }

  it("names the deadline an authorized job must be executed by", async () => {
    const expiresAt = new Date(Date.now() + 15 * 60_000);
    const api = authorizedApi(expiresAt.toISOString());
    renderPanel({ api });
    const execute = await authorize(api);
    expect(execute).toBeEnabled();
    const deadline = screen.getByText(/Executable until/i);
    expect(deadline).toBeInTheDocument();
    expect(deadline.textContent).toContain(dateTimeFormat("en", {
      dateStyle: "medium", timeStyle: "short",
    }).format(expiresAt));
  });

  it("closes the window in place when the authorization deadline passes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const api = authorizedApi(new Date(Date.now() + 60_000).toISOString());
      renderPanel({ api });
      const execute = await authorize(api);
      expect(execute).toBeEnabled();
      expect(screen.queryByText(/authorization window closed/i)).not.toBeInTheDocument();

      await act(async () => {
        vi.advanceTimersByTime(60_001);
      });

      expect(screen.getByText(/authorization window closed at/i)).toBeInTheDocument();
      expect(screen.getByText(/Preview this class again/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Execute authorized job" })).toBeDisabled();
      expect(api.executeRetentionRun).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses to offer execution for a window that had already closed when it arrived", async () => {
    const api = authorizedApi(new Date(Date.now() - 1_000).toISOString());
    renderPanel({ api });
    const execute = await authorize(api);
    expect(execute).toBeDisabled();
    fireEvent.click(execute);
    expect(api.executeRetentionRun).not.toHaveBeenCalled();
    expect(screen.getByText(/authorization window closed at/i)).toBeInTheDocument();
  });

  it("names the recorded cause of each refused run in its history row", () => {
    const cases = [
      ["failed", "execution_disabled", /deletion execution was disabled/i],
      ["failed", "policy_changed", /retention policy changed after authorization/i],
      ["failed", "execution_failed", /stopped safely during execution/i],
      ["expired", "authorization_expired", /authorization window closed before the job ran/i],
    ];
    for (const [status, failureCode, pattern] of cases) {
      const row = historyRow(engine({ runs: [run({ status, failureCode })] }));
      expect(within(row).getByText(pattern), `${status}/${failureCode}`).toBeInTheDocument();
      expect(within(row).getByText(/no records were deleted/i)).toBeInTheDocument();
      cleanup();
    }
  });

  it("names the window for an expired run the server reported without a failure code", () => {
    const row = historyRow(engine({ runs: [run({ status: "expired", failureCode: null })] }));
    expect(within(row).getByText(/authorization window closed before the job ran/i)).toBeInTheDocument();
    expect(within(row).queryByText(/did not report a recognized reason/i)).not.toBeInTheDocument();
  });

  it("falls back to an unrecognized cause for a failed run with an unknown code", () => {
    const row = historyRow(engine({ runs: [run({ status: "failed", failureCode: "something_new" })] }));
    expect(within(row).getByText(/did not report a recognized reason/i)).toBeInTheDocument();
  });

  it("adds no cause or deadline line to a completed run", () => {
    const row = historyRow(engine({ runs: [run({ status: "completed", deletedCount: 9, remainingCount: 0 })] }));
    expect(within(row).getByText("Completed")).toBeInTheDocument();
    expect(within(row).queryByText(/^Cause:/)).not.toBeInTheDocument();
    expect(within(row).queryByText(/Executable until/i)).not.toBeInTheDocument();
  });

  it("resolves the cause lines in Spanish too", () => {
    const changed = historyRow(engine({ runs: [run({ status: "failed", failureCode: "policy_changed" })] }), "es");
    expect(within(changed).getByText(/política de retención cambió después de la autorización/i)).toBeInTheDocument();
    expect(within(changed).getByText(/no se eliminó ningún registro/i)).toBeInTheDocument();
    cleanup();
    const expired = historyRow(engine({ runs: [run({ status: "expired", failureCode: "authorization_expired" })] }), "es");
    expect(within(expired).getByText(/ventana de autorización se cerró antes de ejecutar el trabajo/i)).toBeInTheDocument();
  });

  it("closes an authorized history row's window in place as well", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const row = historyRow(engine({
        runs: [run({
          status: "authorized",
          completedAt: null,
          createdAt: "2026-08-28T12:00:00.000Z",
          authorizationExpiresAt: new Date(Date.now() + 30_000).toISOString(),
        })],
      }));
      expect(within(row).getByText(/Executable until/i)).toBeInTheDocument();
      await act(async () => {
        vi.advanceTimersByTime(30_001);
      });
      expect(within(row).getByText(/authorization window closed at/i)).toBeInTheDocument();
      expect(within(row).queryByText(/Executable until/i)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("declares every deadline and cause key in both catalogue locales", () => {
    const keys = [
      "admin.retention.windowDeadline",
      "admin.retention.windowLapsed",
      "admin.retention.cause.authorization_expired",
      "admin.retention.cause.execution_disabled",
      "admin.retention.cause.policy_changed",
      "admin.retention.cause.execution_failed",
      "admin.retention.cause.unknown",
    ];
    for (const key of keys) {
      expect(catalogue.en[key], `${key} missing in en`).toBeTruthy();
      expect(catalogue.es[key], `${key} missing in es`).toBeTruthy();
    }
  });
});

// Record 8435: a retention write keeps focus while it runs, and the panel's
// one lock refuses a second write started in the same tick.
describe("retention writes while one runs", () => {
  const saveRule = () => {
    const section = policySection("Direct message bodies");
    fireEvent.change(within(section).getByRole("spinbutton"), { target: { value: "730" } });
    return within(section).getByRole("button", { name: "Save rule" });
  };

  it("keeps Save rule focused while the rule is saved, and saves once", async () => {
    const api = makeApi({ saveRetentionPolicy: vi.fn(async () => ({ ok: true })) });
    renderPanel({ value: engine({ policies: [policy, messageBodiesPolicy] }), api });
    await expectHeldWriteFocus(api.saveRetentionPolicy, saveRule());
    expect(api.saveRetentionPolicy).toHaveBeenCalledTimes(1);
  });

  it("starts one retention write when Save rule and Preview are activated in one tick", async () => {
    const api = makeApi({ saveRetentionPolicy: vi.fn(async () => ({ ok: true })) });
    api.previewRetentionRun.mockImplementation(async () => ({ id: "run-1", dataClass: "organization_page_views", retentionDays: 180, mode: "dry_run", status: "previewed", eligibleCount: 12, deletedCount: 0, remainingCount: 0, confirmationPhrase: "AUTHORIZE organization_page_views", createdAt: "2026-08-28T12:00:00.000Z" }));
    renderPanel({ value: engine({ policies: [policy, messageBodiesPolicy] }), api });
    const save = saveRule();
    const preview = screen.getAllByRole("button", { name: "Preview eligible records" })[0];
    await expectOneWriteFromOneTick([api.saveRetentionPolicy, api.previewRetentionRun], [() => fireEvent.click(save), () => fireEvent.click(save), () => fireEvent.click(preview)]);
  });
});

