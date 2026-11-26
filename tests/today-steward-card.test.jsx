import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { TodayView } from "../src/views/TodayView.jsx";

// BUG-UG-WEB-HOME-STEWARD-LIST-UNCAPPED-20261002.
//
// The seeded demo chapter has 58 stewards and member Home mapped every one of
// them into the Find my committee contact card (5,096px on desktop, 5,538px on a phone).
// The card now shows a short list and a See all control that opens the whole
// roster in place; every steward stays reachable and keeps its own Contact.

const ROSTER = Array.from({ length: 58 }, (_, index) => ({
  id: `steward-${String(index + 1).padStart(2, "0")}`,
  name: `Steward ${String(index + 1).padStart(2, "0")}`,
  roleLabel: "steward",
  chapterId: "wor",
  chapterLabel: "Harborview Care United",
  acceptsAppointments: false,
  contact: { conversation: true, email: index === 40 ? "s41@example.org" : null, phone: null },
}));

function renderHome({ stewards = ROSTER, desktop = false, lang = "en", onContactSteward = vi.fn() } = {}) {
  return render(
    <LanguageProvider lang={lang}>
      <TodayView
        data={{ ...fallbackData, chapterStewards: stewards }}
        desktop={desktop}
        onPlanAction={vi.fn()}
        onContactSteward={onContactSteward}
        onOpenOrgStructure={vi.fn()}
      />
    </LanguageProvider>,
  );
}

const card = () => screen.getByRole("region", { name: /Find my committee contact|Encontrar mi contacto del comité/ });
const contactButtons = () => within(card()).queryAllByRole("button", { name: /^(Contact|Contactar a) Steward \d+$/ });

describe("Home Find my committee contact card is capped", () => {
  it.each([["phone", false], ["desktop", true]])("renders three of 58 stewards and a See all control on %s", (_label, desktop) => {
    renderHome({ desktop });
    expect(contactButtons()).toHaveLength(3);
    expect(within(card()).getByText("Steward 01")).toBeInTheDocument();
    expect(within(card()).queryByText("Steward 04")).toBeNull();
    const seeAll = within(card()).getByRole("button", { name: "See all 58 committee members" });
    expect(seeAll).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById(seeAll.getAttribute("aria-controls"))).toBe(
      within(card()).getByText("Steward 01").closest(".home-steward__list"),
    );
  });

  it("opens the full roster, so every steward is reachable with its own Contact, and closes again", () => {
    const onContactSteward = vi.fn();
    renderHome({ onContactSteward });
    const toggle = within(card()).getByRole("button", { name: "See all 58 committee members" });
    toggle.focus();
    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveTextContent("Show fewer committee members");
    expect(document.activeElement).toBe(toggle);
    const buttons = contactButtons();
    expect(buttons).toHaveLength(58);
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual(ROSTER.map((row) => `Contact ${row.name}`));
    fireEvent.click(within(card()).getByRole("button", { name: "Contact Steward 58" }));
    expect(onContactSteward).toHaveBeenLastCalledWith(ROSTER[57]);
    // A published channel past the cap is reachable once the roster is open.
    expect(within(card()).getByRole("link", { name: "Email Steward 41" })).toHaveAttribute("href", "mailto:s41@example.org");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(contactButtons()).toHaveLength(3);
  });

  it("shows no toggle when the chapter has three stewards or fewer", () => {
    renderHome({ stewards: ROSTER.slice(0, 3) });
    expect(contactButtons()).toHaveLength(3);
    expect(within(card()).queryByRole("button", { name: /See all/ })).toBeNull();
  });

  it("names the toggle in Spanish", () => {
    renderHome({ lang: "es" });
    expect(contactButtons()).toHaveLength(3);
    fireEvent.click(within(card()).getByRole("button", { name: "Ver los 58 miembros del comité" }));
    expect(within(card()).getByRole("button", { name: "Mostrar menos miembros del comité" })).toHaveAttribute("aria-expanded", "true");
  });

  it("gives the toggle a 48px target without changing the card's look", () => {
    const css = readFileSync(resolve(process.cwd(), "src/views/homeStewardRoster.css"), "utf8");
    expect(css).toMatch(/\.home-steward \.home-steward__more \{[^}]*min-height: 48px;/);
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgb|hsl|font-size/i);
    expect(readFileSync(resolve(process.cwd(), "src/views/TodayView.jsx"), "utf8")).toContain('import "./homeStewardRoster.css";');
  });
});
