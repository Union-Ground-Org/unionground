import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkWidgets } from "../src/components/WorkWidgets.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

const canonical = ["messages", "appointments", "cases", "forms", "workload", "numbers"];
const widgetKeys = (container) => [...container.querySelectorAll(".workwidget")].map((item) => item.dataset.widget);

function Harness({ initial = canonical, onChange = vi.fn() }) {
  const [order, setOrder] = useState(initial);
  return (
    <LanguageProvider lang="en">
      <WorkWidgets
        data={{}}
        order={order}
        onOrderChange={(next) => { onChange(next); setOrder(next); }}
        onNavigate={vi.fn()}
      />
    </LanguageProvider>
  );
}

describe("controlled Work widgets", () => {
  it("renders the exact normalized member order supplied by its owner", () => {
    const { container, rerender } = render(
      <LanguageProvider lang="en">
        <WorkWidgets data={{}} order={["cases", "messages", "appointments", "forms", "workload", "numbers"]} onOrderChange={vi.fn()} onNavigate={vi.fn()} />
      </LanguageProvider>,
    );
    expect(widgetKeys(container)).toEqual(["cases", "messages", "appointments", "forms", "workload", "numbers"]);
    rerender(
      <LanguageProvider lang="en">
        <WorkWidgets data={{}} order={canonical} onOrderChange={vi.fn()} onNavigate={vi.fn()} />
      </LanguageProvider>,
    );
    expect(widgetKeys(container)).toEqual(canonical);
  });

  it("emits the complete next order and never writes device-global storage", () => {
    const onChange = vi.fn();
    const { container } = render(<Harness onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "Reorder Messages" }), { key: "ArrowDown" });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(["appointments", "messages", "cases", "forms", "workload", "numbers"]);
    expect(widgetKeys(container)).toEqual(["appointments", "messages", "cases", "forms", "workload", "numbers"]);
    expect(window.localStorage.getItem("sg-work-widgets")).toBeNull();
  });

  it("tells assistive technology that the arrow keys move a panel, in both languages", () => {
    const { container } = render(<Harness />);
    const handles = [...container.querySelectorAll(".workwidget__handle")];
    expect(handles).toHaveLength(canonical.length);
    for (const handle of handles) {
      const describedBy = handle.getAttribute("aria-describedby");
      expect(describedBy).toBeTruthy();
      const hint = container.querySelector(`#${CSS.escape(describedBy)}`);
      expect(hint?.textContent).toBe("Use the arrow keys to move this panel.");
      // The hint must be its own node: describing the handle with the polite
      // live region would make every move announcement re-read the hint.
      expect(hint?.getAttribute("aria-live")).toBeNull();
      expect(handle.getAttribute("aria-keyshortcuts")).toBe("ArrowUp ArrowDown ArrowLeft ArrowRight");
    }

    const spanish = render(
      <LanguageProvider lang="es">
        <WorkWidgets data={{}} order={canonical} onOrderChange={vi.fn()} onNavigate={vi.fn()} />
      </LanguageProvider>,
    );
    const spanishHandle = spanish.container.querySelector(".workwidget__handle");
    const spanishHint = spanish.container.querySelector(`#${CSS.escape(spanishHandle.getAttribute("aria-describedby"))}`);
    expect(spanishHint?.textContent).toBe("Usa las flechas para mover este panel.");
  });

  it("cancels an in-flight visual drag on window blur without saving it", () => {
    const onChange = vi.fn();
    const { container } = render(<Harness onChange={onChange} />);
    const messages = container.querySelector('[data-widget="messages"]');
    const appointments = container.querySelector('[data-widget="appointments"]');
    messages.getBoundingClientRect = () => ({ left: 0, right: 100, top: 0, bottom: 100 });
    appointments.getBoundingClientRect = () => ({ left: 0, right: 100, top: 101, bottom: 200 });
    fireEvent.pointerDown(screen.getByRole("button", { name: "Reorder Messages" }), { button: 0, pointerId: 7, pointerType: "touch" });
    fireEvent.pointerMove(window, { pointerId: 7, clientX: 50, clientY: 150 });
    expect(widgetKeys(container)[1]).toBe("messages");
    fireEvent.blur(window);
    expect(onChange).not.toHaveBeenCalled();
    expect(widgetKeys(container)).toEqual(canonical);
  });

  it("opens a preview row with its backed destination and exact focus identity", () => {
    const onNavigate = vi.fn();
    const { container } = render(
      <LanguageProvider lang="en">
        <WorkWidgets
          data={{ conversations: [{ id: "thread-1", sender: "Chapter steward", preview: "Preview", dateLabel: "Today" }] }}
          order={["messages"]}
          onOrderChange={vi.fn()}
          onNavigate={onNavigate}
        />
      </LanguageProvider>,
    );

    fireEvent.click(container.querySelector(".workwidget__rowbtn"));
    expect(onNavigate).toHaveBeenCalledWith(
      "messages",
      "/m/messages",
      "",
      { view: "messages", conversationId: "thread-1" },
    );
  });

  describe("appointment preview matches AppointmentsView upcoming", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("renders confirmed future and in-progress rows and hides cancelled or ended ones", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-21T15:00:00.000Z"));

      const { container } = render(
        <LanguageProvider lang="en">
          <WorkWidgets
            data={{
              appointments: [
                {
                  id: "appt-cancelled-future",
                  status: "cancelled",
                  startsAt: "2026-09-22T14:00:00.000Z",
                  endsAt: "2026-09-22T14:30:00.000Z",
                  dateLabel: "Tue, Sep 22",
                  timeLabel: "10:00 AM",
                  stewardName: "Cancelled Steward",
                },
                {
                  id: "appt-confirmed-future",
                  status: "confirmed",
                  startsAt: "2026-09-23T16:00:00.000Z",
                  endsAt: "2026-09-23T16:30:00.000Z",
                  dateLabel: "Wed, Sep 23",
                  timeLabel: "12:00 PM",
                  stewardName: "Future Steward",
                },
                {
                  id: "appt-confirmed-live",
                  status: "confirmed",
                  startsAt: "2026-09-21T14:30:00.000Z",
                  endsAt: "2026-09-21T15:30:00.000Z",
                  dateLabel: "Mon, Sep 21",
                  timeLabel: "10:30 AM",
                  stewardName: "Live Steward",
                },
                {
                  id: "appt-confirmed-past",
                  status: "confirmed",
                  startsAt: "2026-09-20T14:00:00.000Z",
                  endsAt: "2026-09-20T14:30:00.000Z",
                  dateLabel: "Sun, Sep 20",
                  timeLabel: "10:00 AM",
                  stewardName: "Past Steward",
                },
              ],
            }}
            order={["appointments"]}
            onOrderChange={vi.fn()}
            onNavigate={vi.fn()}
          />
        </LanguageProvider>,
      );

      const rows = [...container.querySelectorAll('[data-widget="appointments"] .workwidget__row')];
      expect(rows.map((row) => row.querySelector(".workwidget__secondary")?.textContent)).toEqual([
        "Live Steward",
        "Future Steward",
      ]);
      expect(rows.map((row) => row.querySelector(".workwidget__primary")?.textContent)).toEqual([
        "Mon, Sep 21 · 10:30 AM",
        "Wed, Sep 23 · 12:00 PM",
      ]);
      expect(container.textContent).not.toContain("Cancelled Steward");
      expect(container.textContent).not.toContain("Past Steward");
    });

    it("hides a confirmed future booking with a missing end, matching AppointmentsView Past", () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-21T15:00:00.000Z"));

      const { container } = render(
        <LanguageProvider lang="en">
          <WorkWidgets
            data={{
              appointments: [
                {
                  id: "appt-confirmed-future-null-end",
                  status: "confirmed",
                  startsAt: "2030-01-01T10:00:00.000Z",
                  endsAt: null,
                  dateLabel: "Tue, Jan 1",
                  timeLabel: "10:00 AM",
                  stewardName: "Null End Steward",
                },
                {
                  id: "appt-confirmed-future-missing-end",
                  status: "confirmed",
                  startsAt: "2030-01-02T10:00:00.000Z",
                  dateLabel: "Wed, Jan 2",
                  timeLabel: "10:00 AM",
                  stewardName: "Missing End Steward",
                },
                {
                  id: "appt-confirmed-future",
                  status: "confirmed",
                  startsAt: "2026-09-23T16:00:00.000Z",
                  endsAt: "2026-09-23T16:30:00.000Z",
                  dateLabel: "Wed, Sep 23",
                  timeLabel: "12:00 PM",
                  stewardName: "Future Steward",
                },
              ],
            }}
            order={["appointments"]}
            onOrderChange={vi.fn()}
            onNavigate={vi.fn()}
          />
        </LanguageProvider>,
      );

      const rows = [...container.querySelectorAll('[data-widget="appointments"] .workwidget__row')];
      expect(rows.map((row) => row.querySelector(".workwidget__secondary")?.textContent)).toEqual([
        "Future Steward",
      ]);
      expect(container.textContent).not.toContain("Null End Steward");
      expect(container.textContent).not.toContain("Missing End Steward");
    });

    it("does not compare appointment status to American canceled anywhere under src/", () => {
      const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "../src");
      const sourceExt = /\.(?:js|jsx|ts|tsx)$/;
      const banned = /\bstatus\s*[!=]==?\s*(['"])canceled\1/;
      expect(banned.test('item.status !== \'canceled\'')).toBe(true);
      expect(banned.test('row.status == "canceled"')).toBe(true);
      expect(banned.test('item.status !== "cancelled"')).toBe(false);
      const hits = [];
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(full);
            continue;
          }
          if (!sourceExt.test(entry.name)) continue;
          if (banned.test(readFileSync(full, "utf8"))) hits.push(full);
        }
      };
      walk(srcRoot);
      expect(hits).toEqual([]);
    });
  });
});

// Union Ground has no points economy: the reports widget never shows a
// points or tier row, only the member's own year-to-date action count.
describe("reports widget without points", () => {
  it("shows the action count and no points, tier, or streak row", () => {
    const { container } = render(
      <LanguageProvider lang="en">
        <WorkWidgets
          data={{ rewards: { totalPoints: 640, tierNumber: 2, tierName: "Builder", weekStreak: 3, actionsYtd: 12 } }}
          order={["numbers"]}
          onOrderChange={vi.fn()}
          onNavigate={vi.fn()}
        />
      </LanguageProvider>,
    );
    const widget = container.querySelector('.workwidget[data-widget="numbers"]');
    const rows = [...widget.querySelectorAll(".workwidget__row")].map((row) => row.textContent);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("12");
    expect(rows[0]).toContain("Actions YTD");
    expect(widget.textContent).not.toMatch(/pts|640|Tier|Builder|streak/);
  });

  it("shows no row at all when no action count is loaded", () => {
    const { container } = render(
      <LanguageProvider lang="en">
        <WorkWidgets data={{ rewards: { totalPoints: 640, tierNumber: 2, tierName: "Builder" } }} order={["numbers"]} onOrderChange={vi.fn()} onNavigate={vi.fn()} />
      </LanguageProvider>,
    );
    const widget = container.querySelector('.workwidget[data-widget="numbers"]');
    expect(widget.querySelectorAll(".workwidget__row")).toHaveLength(0);
    expect(widget.textContent).not.toMatch(/pts|640|Tier|Builder/);
  });
});
