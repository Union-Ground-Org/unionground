import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationWorkflowLink } from "../src/features/automation/AutomationWorkflowLink.jsx";
import { useSourceReference } from "../src/features/automation/useSourceReference.js";
import { automationConditionLabel } from "../src/features/automation/automationUiLabels.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

const sourceId = "50900000-0000-4000-8000-000000000111";
const secondId = "50900000-0000-4000-8000-000000000112";
const session = { authenticated: true, selectedOrganizationId: "50900000-0000-4000-8000-000000000108",
  selectedHat: "admin", role: "admin", organizationRoles: ["admin"], membershipStatus: "active",
  organizationStatus: "active", mfaSatisfied: true };
afterEach(() => { vi.restoreAllMocks(); window.history.replaceState({}, "", "/"); });

describe("automation source links", () => {
  it.each(["en", "es"])("uses an authorized native link with an ordinary SPA click in %s", (lang) => {
    const navigate = vi.fn();
    render(<LanguageProvider lang={lang}><AutomationWorkflowLink session={session} sourceKind="task" sourceId={sourceId} navigate={navigate} /></LanguageProvider>);
    const link = screen.getByRole("link", { name: lang === "es" ? "Automatizar este flujo" : "Automate this workflow" });
    const href = `/m/automations/recipes?sourceKind=task&sourceId=${sourceId}`;
    expect(link).toHaveAttribute("href", href);
    fireEvent.click(link);
    expect(navigate).toHaveBeenCalledExactlyOnceWith("automations", href);
    for (const options of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) fireEvent.click(link, options);
    expect(navigate).toHaveBeenCalledTimes(1);
  });
  it("keeps native navigation when no SPA callback is supplied and hides unauthorized controls", () => {
    const { rerender } = render(<LanguageProvider lang="en"><AutomationWorkflowLink session={session} sourceKind="event" sourceId="event-a" /></LanguageProvider>);
    const link = screen.getByRole("link");
    fireEvent.click(link);
    expect(link).toHaveAttribute("href", expect.stringContaining("sourceId=event-a"));
    rerender(<LanguageProvider lang="en"><AutomationWorkflowLink session={{ ...session, selectedHat: "member" }} sourceKind="task" sourceId={sourceId} /></LanguageProvider>);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});

function Destination({ rows, showTargets = true, kind = "task" }) {
  const result = useSourceReference(kind, rows);
  return <><output>{JSON.stringify(result)}</output>{showTargets && rows.map((row) => <article key={row.id} data-automation-source-id={row.id}>{row.id}</article>)}</>;
}
function frames() {
  const callbacks = [];
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callbacks.push(callback); return callbacks.length; });
  const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  return { callbacks, cancel, flush: () => act(() => { for (const callback of callbacks.splice(0)) callback(0); }) };
}

describe("authorized destination reference focus", () => {
  it("focuses only an already-authorized row and follows a changed reference without fetching", () => {
    const frame = frames();
    window.history.replaceState({}, "", `/m/tasks/board?task=${sourceId}`);
    const rows = [{ id: secondId }, { id: sourceId }];
    const { rerender } = render(<Destination rows={rows} />);
    const target = document.querySelector(`[data-automation-source-id="${sourceId}"]`);
    target.scrollIntoView = vi.fn(); frame.flush();
    expect(target).toHaveFocus(); expect(target).toHaveAttribute("tabindex", "-1");
    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "instant" });
    rerender(<Destination rows={[...rows]} />); frame.flush();
    expect(target.scrollIntoView).toHaveBeenCalledTimes(1);
    window.history.replaceState({}, "", `/m/tasks/board?task=${secondId}`);
    rerender(<Destination rows={rows} />); frame.flush();
    expect(document.querySelector(`[data-automation-source-id="${secondId}"]`)).toHaveFocus();
    expect(frame.cancel).toHaveBeenCalled();
  });
  it("reports missing or malformed sources without focusing unrelated records", () => {
    const frame = frames();
    const { rerender } = render(<Destination rows={[{ id: sourceId }]} />);
    expect(screen.getByRole("status")).toHaveTextContent('"missing":false');
    for (const requested of [secondId, "private-invalid-reference"]) {
      window.history.replaceState({}, "", `/m/tasks/board?task=${requested}`);
      rerender(<Destination rows={[{ id: sourceId }]} />);
      expect(screen.getByRole("status")).toHaveTextContent('"requestedId":null,"missing":true');
    }
    expect(frame.callbacks).toHaveLength(0);
  });
  it("handles a missing DOM target and cancels a scheduled focus on unmount", () => {
    const frame = frames();
    window.history.replaceState({}, "", `/m/tasks/board?task=${sourceId}`);
    const { unmount } = render(<Destination rows={[{ id: sourceId }]} showTargets={false} />);
    frame.flush(); expect(document.body).toHaveFocus();
    unmount(); expect(frame.cancel).toHaveBeenCalled();
  });
});

it("labels unknown conditions honestly in either language", () => {
  expect(automationConditionLabel("unknown", "en")).toBe("Condition unavailable");
  expect(automationConditionLabel("unknown", "es")).toBe("Condición no disponible");
  expect(automationConditionLabel("high", "en")).toBe("High");
  expect(automationConditionLabel("unassigned", "es")).toBe("Sin asignar");
});
