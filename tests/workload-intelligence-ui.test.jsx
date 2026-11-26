import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { WorkloadView } from "../src/views/WorkloadView.jsx";
import { WORKLOAD_CATEGORY_KEYS } from "../src/lib/workloadCategories.js";

const workload = {
  entries: [{ id: "w1", receipt: "a3f81c92", counts: { priority: 7 }, dateLabel: "Aug 11" }],
  stats: {
    enoughData: true,
    period: "2026-Q2",
    submittersBand: "25-49",
    categories: [{ key: "priority", avg: 10, median: 9, p90: 18 }],
    tiles: {},
  },
  reminders: {
    available: true,
    enabled: false,
    cadence: "weekly",
    weekday: 1,
    localHour: 9,
    timezone: "America/New_York",
    nextDueAt: null,
    lastSentAt: null,
  },
};

function renderView({ lang = "en", data = workload, onSaveReminder = vi.fn() } = {}) {
  return render(
    <LanguageProvider lang={lang}>
      <WorkloadView data={{ workload: data }} onLogWork={vi.fn()} onSaveReminder={onSaveReminder} />
    </LanguageProvider>,
  );
}

describe("workload intelligence worker UI", () => {
  it("restores four tabs and labels average, median, and p90 without an exact count", () => {
    renderView();
    expect(screen.getByRole("button", { name: "Reminders" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stats" }));
    expect(screen.getByText("Average · Median · 90th percentile")).toBeInTheDocument();
    expect(screen.getByText("10 / 9 / 18")).toBeInTheDocument();
    expect(screen.queryByText(/25 contributors/i)).toBeNull();
  });

  it("names the distribution figures with text a generic span cannot carry", () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Stats" }));
    const value = document.querySelector(".mwl-bar__val");
    expect(value).not.toHaveAttribute("aria-label");
    expect(screen.getByText("10 / 9 / 18")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("Average 10, median 9, 90th percentile 18")).toBeInTheDocument();
  });

  it("leaves out a category the server withheld instead of drawing it as zero (#7180)", () => {
    renderView();
    fireEvent.click(screen.getByRole("button", { name: "Stats" }));
    expect(document.querySelectorAll(".mwl-bar")).toHaveLength(1);
    expect(screen.queryByText("0 / 0 / 0")).toBeNull();
  });

  it("compares a complete personal entry only with averages the server published (#7180)", () => {
    const counts = Object.fromEntries(WORKLOAD_CATEGORY_KEYS.map((key) => [key, 9]));
    renderView({ data: { ...workload, entries: [{ id: "w2", receipt: "b4e9a2d1", counts, dateLabel: "Aug 12" }] } });
    fireEvent.click(screen.getByRole("button", { name: "Stats" }));
    const rows = [...document.querySelectorAll(".mwl-cmprow")];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("Priority");
    expect(rows[0]).toHaveTextContent("you 9 · campaign 10");
  });

  it("starts reminders off, saves a closed schedule, and reports the server next due time", async () => {
    const onSaveReminder = vi.fn().mockResolvedValue({
      ...workload.reminders,
      enabled: true,
      nextDueAt: "2026-08-17T13:00:00Z",
    });
    renderView({ onSaveReminder });
    fireEvent.click(screen.getByRole("button", { name: "Reminders" }));
    expect(screen.getByText("Reminders are off")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Enable workplace log reminders" }));
    fireEvent.change(screen.getByLabelText("Cadence"), { target: { value: "biweekly" } });
    fireEvent.click(screen.getByRole("button", { name: "Save reminder schedule" }));
    await waitFor(() => expect(onSaveReminder).toHaveBeenCalledWith({
      enabled: true,
      cadence: "biweekly",
      weekday: 1,
      localHour: 9,
      timezone: "America/New_York",
    }));
    expect(await screen.findByText("Schedule saved")).toBeInTheDocument();
    expect(screen.getByText(/Aug 17, 2026/)).toBeInTheDocument();
  });

  // UX-UG-DEVELOPER-AND-MACHINE-TEXT-SHOWN-TO-PEOPLE-20261122 (B-18): the
  // zone list read "America/Indiana/Indianapolis" and the hours "00:00 … 23:00".
  it("names reminder zones as places, hours as clock times, and the next reminder with its zone", () => {
    renderView({ data: { ...workload, reminders: { ...workload.reminders, enabled: true, localHour: 17, timezone: "America/Chicago", nextDueAt: "2026-11-24T23:00:00Z" } } });
    fireEvent.click(screen.getByRole("button", { name: "Reminders" }));
    const zone = screen.getByLabelText("Time zone");
    expect(zone.selectedOptions[0].textContent).toBe("Central — Chicago");
    expect([...zone.options].map((option) => option.textContent)).not.toContain("America/Chicago");
    expect([...zone.options].map((option) => option.value)).toContain("America/Indiana/Indianapolis");
    const hour = screen.getByLabelText("Local time");
    expect(hour.selectedOptions[0].textContent).toBe("5:00 PM");
    expect(hour.options[0].textContent).toBe("12:00 AM");
    expect(screen.getByText("Next reminder: Nov 24, 2026, 5:00 PM CST")).toBeInTheDocument();
  });

  it("writes the reminder zones and hours in Spanish", () => {
    renderView({ lang: "es", data: { ...workload, reminders: { ...workload.reminders, localHour: 17, timezone: "America/Chicago" } } });
    fireEvent.click(screen.getByRole("button", { name: "Recordatorios" }));
    const selects = [...document.querySelectorAll(".mwl-reminder__grid select")];
    const zone = selects.find((node) => node.value === "America/Chicago");
    const hour = selects.find((node) => node.value === "17");
    expect(zone.selectedOptions[0].textContent).toBe("Centro — Chicago");
    expect(hour.selectedOptions[0].textContent).toBe("5:00 p. m.");
  });

  it("owns an explicit read-error state and bilingual controls", () => {
    renderView({ lang: "es", data: { ...workload, reminders: { available: false, reason: "read_error" } } });
    fireEvent.click(screen.getByRole("button", { name: "Recordatorios" }));
    expect(screen.getByText("No se pudo cargar la programación de recordatorios.")).toBeInTheDocument();
  });

  it.each([null, "not-a-date"])("renders a placeholder when nextDueAt is %s", (nextDueAt) => {
    const { unmount } = renderView({
      data: {
        ...workload,
        reminders: { ...workload.reminders, enabled: true, nextDueAt },
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reminders" }));
    expect(screen.getByText("Next reminder time is not available yet")).toBeInTheDocument();
    unmount();
  });

  it("starts the History CSV with a UTF-8 byte order mark so Excel keeps accented notes readable", async () => {
    const entry = { id: "w2", receipt: "b7c40e15", counts: { ...Object.fromEntries(WORKLOAD_CATEGORY_KEYS.map(key => [key, 0])), priority: 3 }, dateLabel: "Aug 12", note: "Revisión de citación" };
    renderView({ data: { ...workload, entries: [entry] } });
    fireEvent.click(screen.getByRole("button", { name: "History" }));
    let blob = null;
    const url = { createObjectURL: vi.fn((value) => { blob = value; return "blob:workload-log"; }), revokeObjectURL: vi.fn() };
    vi.stubGlobal("URL", Object.assign(Object.create(URL), url));
    try {
      fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    } finally { vi.unstubAllGlobals(); }
    expect(url.createObjectURL).toHaveBeenCalledOnce();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    // The mark is the only addition: the payload after it is the same file.
    // Decode the remaining bytes directly — Blob.text() swallows the mark.
    const lines = new TextDecoder().decode(bytes.subarray(3)).split("\r\n");
    expect(lines[0]).toBe("date,receipt,priority,pending,unread_docs,todos,referrals,ce_activities,assistance_requests,aged_cases,meta,note,worked_on,hours_worked");
    expect(lines[1]).toBe("Aug 12,b7c40e15,3,0,0,0,0,0,0,0,,Revisión de citación,,");
    expect(lines).toHaveLength(2);
  });

  it.each([
    ["Cadence", "biweekly"],
    ["Day", "3"],
    ["Local time", "17"],
    ["Time zone", "America/Chicago"],
  ])("retires the saved status when %s is edited after a save", async (label, value) => {
    const onSaveReminder = vi.fn().mockResolvedValue({ ...workload.reminders, enabled: true });
    const { unmount } = renderView({ onSaveReminder });
    fireEvent.click(screen.getByRole("button", { name: "Reminders" }));
    fireEvent.click(screen.getByRole("button", { name: "Save reminder schedule" }));
    expect(await screen.findByText("Schedule saved")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(label), { target: { value } });

    expect(screen.queryByText("Schedule saved")).toBeNull();
    unmount();
  });

  it("retires the save-failure alert when the schedule is edited again", async () => {
    const onSaveReminder = vi.fn().mockRejectedValue(new Error("offline"));
    renderView({ onSaveReminder });
    fireEvent.click(screen.getByRole("button", { name: "Reminders" }));
    fireEvent.click(screen.getByRole("button", { name: "Save reminder schedule" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Cadence"), { target: { value: "monthly" } });

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("surfaces save failures without claiming success", async () => {
    const onSaveReminder = vi.fn().mockRejectedValue(new Error("offline"));
    renderView({ onSaveReminder });
    fireEvent.click(screen.getByRole("button", { name: "Reminders" }));
    fireEvent.click(screen.getByRole("button", { name: "Save reminder schedule" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save the reminder schedule.");
    expect(screen.queryByText("Schedule saved")).toBeNull();
  });

  // UX-UG-WORKLOAD-STATS-TILES-LOCALE-NUMBER-FORMAT-20260920. The tiles used
  // to interpolate their number into an English "%"/"h" literal. A fractional
  // avgOtHours is the value that tells the two locales apart — get_workload_stats
  // rounds it to one decimal — so the case is driven by 1.5, and the whole-ten
  // percentages are pinned so this repair does not move them either way.
  describe.each([
    { lang: "en", statsTab: "Stats", overtime: "1.5h" },
    { lang: "es", statsTab: "Estadísticas", overtime: "1,5 h" },
  ])("Stats summary tiles in $lang", ({ lang, statsTab, overtime }) => {
    const data = {
      ...workload,
      stats: { ...workload.stats, tiles: { pctFullTime: 60, pctPartTime: 40, avgOtHours: 1.5 } },
    };

    it("formats the overtime average for the locale and keeps the percentages put", () => {
      renderView({ lang, data });
      fireEvent.click(screen.getByRole("button", { name: statsTab }));
      expect(screen.getByText(overtime)).toBeInTheDocument();
      expect(screen.getByText("60%")).toBeInTheDocument();
      expect(screen.getByText("40%")).toBeInTheDocument();
    });
  });
});
