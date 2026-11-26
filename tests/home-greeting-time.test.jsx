import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TodayView, greetingKeyForHour } from "../src/views/TodayView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";

// UX-UG-PHONE-HOME-GREETS-AFTERNOON-AT-EVERY-HOUR-20260920. The phone Home
// heading used to render today.greetingAfternoon unconditionally, so a member
// opening the app at 08:00 or 21:00 was told "Good afternoon" / "Buenas
// tardes". The boundaries the fix commits to are stated in TodayView and
// pinned here: before noon = morning, 12:00–17:59 = afternoon, 18:00 on =
// evening, read from the member's OWN clock.
const CASES = [
  { hour: 8, en: "Good morning, Darnell", es: "Buenos días, Darnell" },
  { hour: 14, en: "Good afternoon, Darnell", es: "Buenas tardes, Darnell" },
  { hour: 21, en: "Good evening, Darnell", es: "Buenas noches, Darnell" },
];

// Local-time construction on purpose: getHours() then reads 08/14/21 under any
// TZ the suite runs in (the record asks for UTC, Asia/Tokyo and
// Pacific/Auckland), so this file never depends on the runner's zone.
const at = (hour) => new Date(2026, 5, 16, hour, 30, 0);

function renderPhoneHome(lang) {
  render(
    <LanguageProvider lang={lang}>
      <TodayView data={fallbackData} />
    </LanguageProvider>,
  );
}

beforeEach(() => {
  // Only Date is faked: TodayView's effects still run on real timers.
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("phone Home greeting follows the member's clock", () => {
  for (const { hour, en, es } of CASES) {
    for (const [lang, expected] of [["en", en], ["es", es]]) {
      it(`greets ${expected} at ${String(hour).padStart(2, "0")}:30 in ${lang}`, () => {
        vi.setSystemTime(at(hour));
        renderPhoneHome(lang);
        expect(screen.getByRole("heading", { level: 1, name: new RegExp(expected) })).toBeInTheDocument();
        // and no other time of day leaked onto the first screen
        const others = CASES
          .flatMap((entry) => [entry.en, entry.es])
          .filter((greeting) => greeting !== expected);
        for (const greeting of others) {
          expect(screen.queryByRole("heading", { name: new RegExp(greeting) })).toBeNull();
        }
      });
    }
  }

  it("keeps the 👋 and the date line beside the greeting", () => {
    vi.setSystemTime(at(8));
    renderPhoneHome("en");
    const heading = screen.getByRole("heading", { level: 1, name: /Good morning, Darnell/ });
    expect(heading.textContent).toContain("👋");
    expect(document.querySelector(".home-date").textContent).toContain("June 16");
  });
});

describe("greetingKeyForHour boundaries", () => {
  it("splits the day at noon and at 18:00", () => {
    expect([0, 5, 11].map(greetingKeyForHour)).toEqual([
      "today.greetingMorning", "today.greetingMorning", "today.greetingMorning",
    ]);
    expect([12, 17].map(greetingKeyForHour)).toEqual([
      "today.greetingAfternoon", "today.greetingAfternoon",
    ]);
    expect([18, 23].map(greetingKeyForHour)).toEqual([
      "today.greetingEvening", "today.greetingEvening",
    ]);
  });
});
