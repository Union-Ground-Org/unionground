import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppointmentsView } from "../src/views/AppointmentsView.jsx";
import { ChapterAppointmentsPanel } from "../src/components/ChapterAppointmentsPanel.jsx";
import { StewardAppointmentsPanel } from "../src/components/StewardAppointmentsPanel.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { buildIcsCalendar } from "../src/lib/ics.js";

const winter = {
  id: "winter", memberName: "Renata Cole", stewardName: "Sam Okafor", stewardId: "sam",
  type: "contract_questions", appointmentType: "contract_questions", durationMinutes: 45,
  startsAt: "2026-11-16T18:00:00Z", endsAt: "2026-11-16T18:45:00Z", status: "confirmed",
  dateLabel: "Wrong cached day", timeLabel: "3:00 AM", endTimeLabel: "3:45 AM",
};
const summer = { ...winter, id: "summer", startsAt: "2026-07-15T17:00:00Z", endsAt: "2026-07-15T17:30:00Z", status: "completed", durationMinutes: 30 };
const wrap = (node, lang) => <LanguageProvider lang={lang}>{node}</LanguageProvider>;
afterEach(() => vi.useRealTimers());

describe("appointment clocks use raw Eastern instants", () => {
  it.each(["en", "es"])("renders the Coordinator's full 45-minute winter and 30-minute summer ranges in %s", async (lang) => {
    render(wrap(<ChapterAppointmentsPanel api={{ loadChapterAppointments: async () => ({ rows: [winter, summer], total: 2 }) }} />, lang));
    const rows = await screen.findAllByRole("article");
    expect(rows[0]).toHaveTextContent(/1:00.*1:45.*ET/);
    expect(rows[0]).toHaveTextContent(lang === "es" ? /lun.*16 nov.*2026/ : /Mon.*Nov 16.*2026/);
    expect(rows[1]).toHaveTextContent(/1:00.*1:30.*ET/);
    expect(rows[1]).toHaveTextContent(lang === "es" ? /mié.*15 jul/ : /Wed.*Jul 15/);
    expect(rows[0]).toHaveTextContent("45 min");
    expect(rows[1]).toHaveTextContent("30 min");
    expect(document.body.textContent).not.toMatch(/your local|tu hora local|PST|GMT\+9/);
  });

  it.each(["en", "es"])("renders Steward start/end ranges from the stored instants in %s", async (lang) => {
    render(wrap(<StewardAppointmentsPanel api={{ loadAppointments: async () => ({ upcoming: [winter], recent: [summer], windows: [{ weekday: 1, startMinute: 540, endMinute: 600 }], schedule: { accepting: true }, stats: {} }) }} />, lang));
    await screen.findAllByText("Renata Cole");
    const labels = [...document.querySelectorAll(".cwk-time")].map(x => x.textContent);
    expect(labels[0]).toMatch(/1:00.*ET.*1:45.*ET/);
    expect(labels[1]).toMatch(/1:00.*ET.*1:30.*ET/);
    expect(labels[0]).toMatch(lang === "es" ? /lun.*16 nov/ : /Mon.*Nov 16/);
    expect(labels[0]).toMatch(lang === "es" ? /p\.\s*m\./ : /PM/);
  });

  it.each(["en", "es"])("ignores cached Member labels, including the existing history shape, in %s", (lang) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-11-09T17:00:00Z"));
    render(wrap(<AppointmentsView data={{ appointments: [winter, summer] }} api={{ slots: async () => ({ slots: [] }) }} onCancel={vi.fn()} onBook={vi.fn()} onReschedule={vi.fn()} />, lang));
    const upcoming = document.querySelector(".mappt-row:not(.mappt-row--past)");
    const past = document.querySelector(".mappt-row--past");
    expect(upcoming).toHaveTextContent(/1:00.*ET.*1:45.*ET/);
    expect(past).toHaveTextContent(/1:00.*ET.*1:30.*ET/);
    expect(upcoming).toHaveTextContent(lang === "es" ? /lun.*16 nov/ : /Mon.*Nov 16/);
    expect(past).toHaveTextContent(lang === "es" ? /mié.*15 jul/ : /Wed.*Jul 15/);
    expect(document.body.textContent).not.toMatch(/Wrong cached|your local|tu hora local/);
    fireEvent.click(within(upcoming).getByRole("button", { name: lang === "es" ? "Reprogramar" : "Reschedule" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(/1:00.*ET/);
  });

  it("keeps calendar-export instants and durations unchanged", () => {
    const calendar = buildIcsCalendar([winter, summer]);
    expect(calendar).toContain("DTSTART:20261116T180000Z");
    expect(calendar).toContain("DTEND:20261116T184500Z");
    expect(calendar).toContain("DTSTART:20260715T170000Z");
    expect(calendar).toContain("DTEND:20260715T173000Z");
  });
});
