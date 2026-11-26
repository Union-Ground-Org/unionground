import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { ConfirmActionDialog } from "../src/components/ConfirmActionDialog.jsx";
import { AutomationWorkspaceLink, automationSubpage } from "../src/components/AutomationWorkspaceLink.jsx";
import { CaseList } from "../src/components/CaseList.jsx";
import { formatDateTimeWithZone, formatDateWithYear } from "../src/lib/i18n.js";
import { expectPendingFocus } from "./helpers/busyWriteFocus.js";

// REQ-UG-LOVABLE-AUDIT-WEBAPP-FIXES-20261103, part 2: the Lovable
// audit's remaining web patterns (confirmations, automation subroutes that
// name their page, dates with a year and times with a zone, counts that name
// their scope).

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/");
});

const wrap = (node, lang = "en") => <LanguageProvider lang={lang}>{node}</LanguageProvider>;

describe("one confirmation for a consequential action", () => {
  it("states the effect, who is affected and whether it can be undone, then confirms", () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(wrap(<ConfirmActionDialog eyebrow="Retract broadcast" title="Retract “Vote”?" effects={["It leaves the tab.", "Read stays read."]} affected="Every worker." undo="No." confirmLabel="Retract broadcast" onConfirm={onConfirm} onClose={onClose} />));
    const dialog = screen.getByTestId("confirm-action");
    expect(screen.getByRole("heading", { name: "Retract “Vote”?" })).toBeInTheDocument();
    expect(within(dialog).getByRole("heading", { name: "What happens" })).toBeInTheDocument();
    expect(within(dialog).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["It leaves the tab.", "Read stays read."]);
    expect(within(dialog).getByText("Who is affected:").parentElement).toHaveTextContent("Who is affected: Every worker.");
    expect(within(dialog).getByText("Can it be undone?").parentElement).toHaveTextContent("Can it be undone? No.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Retract broadcast" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("shows the busy label and holds both buttons while the action runs", async () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(wrap(<ConfirmActionDialog title="Close?" confirmLabel="Close request" busy busyLabel="Closing…" onConfirm={onConfirm} onClose={onClose} />, "es"));
    const dialog = screen.getByTestId("confirm-action");
    expect(within(dialog).queryByRole("heading", { name: "Qué pasa" })).toBeNull();
    for (const name of ["Closing…", "Cancelar"]) {
      const control = within(dialog).getByRole("button", { name });
      await expectPendingFocus(control);
      fireEvent.click(control);
      fireEvent.keyDown(control, { key: "Enter" });
    }
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("automation subroutes on the Admin and Campaign chair planes", () => {
  it("recognizes each workspace page and nothing else", () => {
    expect(automationSubpage("/m/admin/automations/builder")).toEqual({ tab: "builder", labelKey: "automation.pages.pageBuilder" });
    expect(automationSubpage("/m/vp/automations/settings/")).toEqual({ tab: "settings", labelKey: "automation.readiness.safety" });
    expect(automationSubpage("/m/admin/automations")).toBeNull();
    expect(automationSubpage("/m/admin/automations/unknown")).toBeNull();
    expect(automationSubpage("/m/steward/automations/builder")).toBeNull();
    expect(automationSubpage(undefined)).toBeNull();
  });

  it("names the page and links the same page of the Automations workspace", () => {
    window.history.replaceState({}, "", "/m/vp/automations/builder?demo=1");
    render(wrap(<AutomationWorkspaceLink id="vp-automation-control" />));
    expect(screen.getByRole("heading", { name: "Automations: Builder" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Builder in Automations" })).toHaveAttribute("href", "/m/automations/builder?demo=1");
  });

  it("keeps the overview card on the plane's own automation page", () => {
    window.history.replaceState({}, "", "/m/admin/automations");
    render(wrap(<AutomationWorkspaceLink />));
    expect(screen.getByRole("link", { name: "Open Automations" })).toHaveAttribute("href", "/m/automations");
  });
});

describe("dates with a year and times with a zone", () => {
  it("names the year and the zone, and gives nothing for a missing or invalid value", () => {
    const value = "2026-10-23T21:00:00Z";
    expect(formatDateWithYear(value, "en")).toMatch(/2026/);
    expect(formatDateTimeWithZone(value, "en")).toMatch(/2026/);
    expect(formatDateTimeWithZone(value, "en")).toMatch(/\b(?:[A-Z]{2,5}|GMT[+-]\d+|UTC)\b/);
    for (const missing of ["", null, "not a date"]) {
      expect(formatDateWithYear(missing, "en")).toBe("");
      expect(formatDateTimeWithZone(missing, "en")).toBe("");
    }
  });
});

describe("issue counts that name their scope", () => {
  const rows = Array.from({ length: 5 }, (_, index) => ({ id: `case-${index}`, memberName: `Worker ${index}`, memberInitials: "M", reference: `C-${index}`, title: "Issue", caseType: "Grievance", step: "Step 1", status: "active", deadline: "", deadlineLabel: "", chapterId: "chapter-a" }));

  it("says how many match and how many are on screen when the list is paged", () => {
    render(wrap(<CaseList plane="coordinator" rows={rows} onOpenCase={vi.fn()} visibleCount={2} />));
    expect(screen.getByRole("status")).toHaveTextContent("5 matching issues · showing 2");
  });

  it("keeps the loaded-window wording beside both numbers", () => {
    render(wrap(<CaseList plane="coordinator" rows={rows} onOpenCase={vi.fn()} visibleCount={2} countsWindowed />));
    expect(screen.getByRole("status")).toHaveTextContent("5 matching issues from the loaded window · showing 2");
  });
});
