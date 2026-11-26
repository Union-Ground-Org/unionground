import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { AccessHistory } from "../src/features/accessHistory/ui/AccessHistory.jsx";
import { presentAccessHistory, presentLoading } from "../src/features/accessHistory/index.js";
import { catalogue } from "../src/lib/i18n.js";

function RangeHarness() {
  const [rangeDays, setRangeDays] = useState(90);
  return (
    <AccessHistory
      rangeDays={rangeDays}
      onRangeChange={setRangeDays}
      presentation={presentAccessHistory({ ok: true, rangeDays, events: [] })}
    />
  );
}

function loggedLines(spy) {
  return spy.mock.calls.map((args) => args.map((part) => String(part)).join(" "));
}

function declaresFontShorthand(button) {
  return /(?:^|;)\s*font\s*:/.test(button.getAttribute("style") ?? "");
}

describe("access history UI", () => {
  it("lists staff access events without exposing other members", () => {
    const onRangeChange = vi.fn();
    render(
      <AccessHistory
        rangeDays={90}
        onRangeChange={onRangeChange}
        presentation={presentAccessHistory({
          ok: true,
          rangeDays: 90,
          events: [{
            id: "access-1",
            organizationId: "org-a",
            subjectUserId: "member-a",
            actorUserId: "steward-1",
            actorRole: "steward",
            actorLabel: "Sam",
            action: "viewed_case",
            entityType: "case",
            occurredAt: "2026-08-20T12:00:00.000Z",
          }],
        })}
      />,
    );
    expect(screen.getByRole("heading", { name: "Access history" })).toBeInTheDocument();
    // REQ-UG-ACCESS-HISTORY-PROFILE-VIEWS-20261001: staff profile reads and
    // updates are produced server-side again, so the copy names the profile.
    expect(screen.getAllByText(/viewed or changed your profile or issues/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/staff list that shows only a summary does not appear here/i).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/chapter-scoped staff role changes/i)).toHaveLength(0);
    expect(screen.getByRole("heading", { name: "Sam viewed your issue" })).toBeInTheDocument();
    expect(screen.getByText(/Aug 20, 2026/).closest("time")).toHaveAttribute("datetime", "2026-08-20T12:00:00.000Z");
    fireEvent.click(screen.getByRole("button", { name: "Last 30 days" }));
    expect(onRangeChange).toHaveBeenCalledWith(30);
  });

  it("retries in Spanish and falls back when presentation is missing", () => {
    const onRetry = vi.fn();
    render(<AccessHistory lang="es" presentation={{ state: "retry" }} onRetry={onRetry} />);
    expect(screen.getByRole("heading", { name: "Historial de acceso" })).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "Reintentar" });
    expect(retry.style.fontWeight).toBe("800");
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalled();
    render(<AccessHistory presentation={null} />);
    expect(screen.getByText("Loading who accessed your records.")).toBeInTheDocument();
  });

  it("renders exactly one loading sentence in the viewer's language", () => {
    const english = "Loading who accessed your records.";
    const spanish = "Cargando el historial de acceso.";
    const { unmount } = render(<AccessHistory lang="en" presentation={presentLoading("en")} />);
    expect(screen.getAllByText(english)).toHaveLength(1);
    expect(screen.queryByText(spanish)).not.toBeInTheDocument();
    unmount();

    render(<AccessHistory lang="es" presentation={presentLoading("es")} />);
    expect(screen.getAllByText(spanish)).toHaveLength(1);
    expect(screen.queryByText(english)).not.toBeInTheDocument();
    expect(screen.queryByText(catalogue.es["accessHistory.loading"])).not.toBeInTheDocument();
  });

  it("exposes the loading sentence as a status region and drops it when ready", () => {
    const { rerender } = render(<AccessHistory presentation={presentLoading()} />);
    const section = screen.getByRole("region", { name: "Access history" });
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("Loading who accessed your records.");
    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(section).toHaveAttribute("aria-busy", "true");

    rerender(<AccessHistory presentation={presentAccessHistory({ ok: true, rangeDays: 90, events: [] })} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(section).not.toHaveAttribute("aria-busy");
  });

  it("still renders one non-loading status message", () => {
    const ready = presentAccessHistory({ ok: true, events: [], rangeDays: 90 });
    render(<AccessHistory presentation={ready} />);
    expect(screen.getAllByText(ready.message)).toHaveLength(1);
    expect(screen.queryByText("Loading who accessed your records.")).not.toBeInTheDocument();
  });

  it("keeps the selected range chip heavier without a fontWeight style warning", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      render(<RangeHarness />);
      for (const name of ["Last 30 days", "Last year", "Last 90 days"]) {
        fireEvent.click(screen.getByRole("button", { name }));
        const selected = screen.getByRole("button", { name, pressed: true });
        const resting = screen.getAllByRole("button", { pressed: false });
        expect(resting.length).toBeGreaterThan(0);
        expect(declaresFontShorthand(selected)).toBe(false);
        expect(selected.style.fontFamily).toBe("inherit");
        expect(Number(selected.style.fontWeight)).toBe(800);
        for (const button of resting) {
          expect(declaresFontShorthand(button)).toBe(false);
          expect(button.style.fontFamily).toBe("inherit");
          expect(button.style.fontWeight).toBe("inherit");
          expect(Number(selected.style.fontWeight)).toBeGreaterThan(400);
        }
      }
      const logged = [...loggedLines(errorSpy), ...loggedLines(warnSpy)];
      expect(logged.filter((line) => /fontWeight/.test(line))).toEqual([]);
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("renders catalogue Spanish for one event and keeps the English surface on the historical sentences", () => {
    const event = {
      id: "access-1",
      actorLabel: "Sam",
      action: "viewed_case",
      occurredAt: "2026-08-20T12:00:00.000Z",
    };
    const result = { ok: true, rangeDays: 90, events: [event] };
    const englishDisclaimer = catalogue.en["accessHistory.disclaimer"];
    const { unmount } = render(
      <AccessHistory lang="es" rangeDays={90} presentation={presentAccessHistory(result, "es")} />,
    );
    expect(screen.getByRole("heading", { name: "Sam vio tu asunto" })).toBeInTheDocument();
    expect(screen.getByText("Se muestra 1 evento.")).toBeInTheDocument();
    expect(screen.getByText(catalogue.es["accessHistory.disclaimer"])).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("1 event shown.");
    expect(document.body.textContent).not.toContain("viewed your issue");
    expect(document.body.textContent).not.toContain(englishDisclaimer);
    unmount();

    render(<AccessHistory lang="en" rangeDays={90} presentation={presentAccessHistory(result, "en")} />);
    expect(screen.getByRole("heading", { name: "Sam viewed your issue" })).toBeInTheDocument();
    expect(screen.getByText("1 event shown.")).toBeInTheDocument();
    expect(screen.getByText(englishDisclaimer)).toBeInTheDocument();
    expect(screen.getByText("Last 90 days")).toBeInTheDocument();
  });
});
