import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { StewardView } from "../src/views/StewardView.jsx";

const instants = ["2026-01-15T17:05:00Z", "2026-07-15T17:05:00Z", "invalid", null];

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("Steward conversation Eastern timestamps", () => {
  it.each(["America/Los_Angeles", "Asia/Tokyo"].flatMap((zone) => ["en", "es"].map((lang) => [zone, lang])))(
    "labels messages and staff-only contact notes in %s, app language %s", async (zone, lang) => {
      vi.stubEnv("TZ", zone);
      const NativeDateTimeFormat = Intl.DateTimeFormat;
      vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function(locale, options) {
        return new NativeDateTimeFormat(locale, { timeZone: zone, ...options });
      });
      const api = {
        loadDesk: vi.fn().mockResolvedValue({
          queue: [], broadcasts: [], formsInbox: [], kpis: {},
          threads: [{ id: "tamarack-conversation", memberName: "Simone Nguyen", memberInitials: "SN",
            preview: "Tamarack scheduling question", updatedAt: instants[1],
            messages: instants.map((created_at, index) => ({ id: `message-${index}`, created_at,
              sender_kind: index % 2 ? "steward" : "member", sender_name: "Tamarack steward", body: `Message ${index}` })),
          }],
        }),
        listEmailIntakes: vi.fn().mockResolvedValue(instants.map((receivedAt, index) => ({ id: `email-${index}`, receivedAt, subject: `Tamarack email ${index}`, status: "pending" }))),
        listScheduled: vi.fn().mockResolvedValue(instants.map((scheduled_for, index) => ({ id: `scheduled-${index}`, scheduled_for, body: `Scheduled ${index}`, status: "pending" }))),
        listContactNotes: vi.fn().mockResolvedValue(instants.map((createdAt, index) => ({ id: `note-${index}`, createdAt, note: `Private note ${index}` }))),
      };
      render(<LanguageProvider lang={lang}><StewardView data={{ member: { id: "tamarack-steward", initials: "TS" } }} api={api} /></LanguageProvider>);
      fireEvent.click(await screen.findByText("Tamarack scheduling question"));
      const dialog = await screen.findByRole("dialog", { name: "Simone Nguyen" });
      await within(dialog).findByText("Private note 3");
      expect(await screen.findByText("Tamarack email 3")).toBeInTheDocument();
      for (const selector of [".thread-list time", ".cwk-contact-notes time"]) {
        const stamps = [...dialog.querySelectorAll(selector)];
        expect(stamps).toHaveLength(4);
        expect(stamps[0]).toHaveTextContent(lang === "es" ? "15 ene 2026, 12:05 p. m. EST" : "Jan 15, 2026, 12:05 PM EST");
        expect(stamps[1]).toHaveTextContent(lang === "es" ? "15 jul 2026, 1:05 p. m. EDT" : "Jul 15, 2026, 1:05 PM EDT");
        expect(stamps[0]).toHaveAttribute("datetime", "2026-01-15T17:05:00.000Z");
        expect(stamps[1]).toHaveAttribute("datetime", "2026-07-15T17:05:00.000Z");
        for (const missing of stamps.slice(2)) {
          expect(missing).toHaveTextContent(lang === "es" ? "Hora no disponible" : "Time unavailable");
          expect(missing).not.toHaveAttribute("datetime");
        }
      }
      for (const selector of [".inbox-scheduled__row p", ".cwk-email time"]) {
        const stamps = [...document.querySelectorAll(selector)];
        expect(stamps).toHaveLength(4);
        expect(stamps[0]).toHaveTextContent(lang === "es" ? "15 ene 2026, 12:05 p. m. EST" : "Jan 15, 2026, 12:05 PM EST");
        expect(stamps[1]).toHaveTextContent(lang === "es" ? "15 jul 2026, 1:05 p. m. EDT" : "Jul 15, 2026, 1:05 PM EDT");
        for (const missing of stamps.slice(2)) expect(missing).toHaveTextContent(lang === "es" ? "Hora no disponible" : "Time unavailable");
      }
    },
  );
});
