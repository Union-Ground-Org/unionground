import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CaseHistoryTimeline } from "../src/components/CaseHistoryTimeline.jsx";
import { CasesView } from "../src/views/CasesView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { formatHistoryValue } from "../src/lib/caseHistoryValue.js";
import { t } from "../src/lib/i18n.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const winter = "2026-01-15T17:05:00Z";
const summer = "2026-07-15T17:05:00Z";

it.each(["America/Los_Angeles", "Asia/Tokyo"].flatMap((zone) => ["en", "es"].map((lang) => [zone, lang])))(
  "labels case history fields, events and fallback notes Eastern in %s / %s", async (zone, lang) => {
    vi.stubEnv("TZ", zone);
    const NativeDateTimeFormat = Intl.DateTimeFormat;
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function(locale, options) {
      return new NativeDateTimeFormat(locale, { timeZone: zone, ...options });
    });
    expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(zone);
    const expected = lang === "es" ? "15 ene 2026, 12:05 p. m. ET" : "Jan 15, 2026, 12:05 PM ET";
    const summerExpected = lang === "es" ? "15 jul 2026, 1:05 p. m. ET" : "Jul 15, 2026, 1:05 PM ET";
    const format = (value, key) => formatHistoryValue(value, { key, lang, t: (name, vars) => t(lang, name, vars) });
    for (const key of ["deadline", "due_at", "created_at", "decided_at", "custom_at"]) {
      expect(format(winter, key)).toBe(expected);
      expect(format(summer, key)).toBe(summerExpected);
    }
    expect(format(winter, "summary")).toBe(winter);
    expect(format("Keep the member's words verbatim", "summary")).toBe("Keep the member's words verbatim");
    expect(format("not-a-date", "due_at")).toBe("not-a-date");
    expect(format("2026-01-15", "deadline")).not.toMatch(/ET|EST|EDT/);
    const rows = [
      { event_id: "field", kind: "fields", at: winter, details: { table: "member_cases", changes: { deadline: { old: winter, new: summer } } } },
      { event_id: "note", kind: "note", at: summer, details: { body: "Tamarack history note" } },
      { event_id: "invalid", kind: "note", at: "invalid", details: { body: "Undated history note" } },
    ];
    render(<LanguageProvider lang={lang}><CaseHistoryTimeline caseId="tamarack-case" api={{ loadCaseHistory: vi.fn().mockResolvedValue({ rows, nextBefore: null }) }} /></LanguageProvider>);
    await screen.findByText("Tamarack history note");
    const stamps = [...document.querySelectorAll(".case-history__event-head time")];
    expect(stamps[0]).toHaveTextContent(expected);
    expect(stamps[1]).toHaveTextContent(summerExpected);
    expect(stamps[0]).toHaveAttribute("datetime", "2026-01-15T17:05:00.000Z");
    expect(stamps[2]).not.toHaveAttribute("datetime");
    expect(document.querySelector(".case-history__changes")).toHaveTextContent(expected);
    expect(document.querySelector(".case-history__changes")).toHaveTextContent(summerExpected);
    cleanup();
    const item = { id: "tamarack-case", reference: "TAM-1", title: "Tamarack schedule case", type: "Scheduling", status: "active", step: "Intake", deadlineValue: null, files: [],
      updates: [winter, summer, null].map((created_at, id) => ({ id: `note-${id}`, body: `Tamarack fallback ${id}`, created_at })) };
    render(<LanguageProvider lang={lang}><CasesView data={{ cases: [item] }} focus={{ caseId: item.id }} /></LanguageProvider>);
    const dialog = await screen.findByRole("dialog", { name: item.title });
    expect(within(dialog).getByText("Tamarack fallback 0").closest("article").querySelector("time")).toHaveTextContent(expected);
    expect(within(dialog).getByText("Tamarack fallback 1").closest("article").querySelector("time")).toHaveTextContent(summerExpected);
    expect(within(dialog).getByText("Tamarack fallback 2").closest("article").querySelector("time")).not.toHaveAttribute("datetime");
  },
);
