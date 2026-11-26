import { cleanup, render, screen, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { StaffRoster } from "../src/components/StaffRoster.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { declaredFor, mountStylesheets } from "./helpers/appStylesheet.js";

const ROSTER = [
  { userId: "u1", fullName: "Ana Rivera", initials: "AR", memberSince: 2019, roles: ["steward", "organizer", "coordinator", "advisor", "admin", "vp"] },
  { userId: "u2", fullName: "Darnell Brooks", initials: "DB", memberSince: null, roles: [] },
];

function renderRoster(lang) {
  return render(<LanguageProvider lang={lang}><StaffRoster roster={ROSTER} /></LanguageProvider>);
}

afterEach(cleanup);

describe("StaffRoster", () => {
  it("labels the membership year in English and omits it when missing", () => {
    renderRoster("en");
    const rows = document.querySelectorAll(".ach-roster__row");
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector(".ach-roster__role").textContent).toBe("With the campaign since 2019");
    expect(screen.queryByText("2019")).toBeNull();
    expect(rows[1].querySelector(".ach-roster__role")).toBeNull();
    expect(rows[1].textContent).not.toMatch(/With the campaign since|Member since|\b0\b|null/);
  });

  it("labels the membership year in Spanish", () => {
    renderRoster("es");
    expect(screen.getByText("En la campaña desde 2019")).toBeInTheDocument();
  });

  it("hides the initials avatar from assistive technology", () => {
    renderRoster("en");
    for (const avatar of document.querySelectorAll(".ach-roster__avatar")) {
      expect(avatar).toHaveAttribute("aria-hidden", "true");
    }
  });

  it("still shows the localized label for each supported role", () => {
    renderRoster("en");
    const chips = [...document.querySelectorAll(".ach-roster__row")[0].querySelectorAll(".reward-chip")].map((chip) => chip.textContent);
    expect(chips).toHaveLength(6);
    for (const label of chips) {
      expect(["steward", "organizer", "coordinator", "advisor", "admin", "vp"]).not.toContain(label);
    }
  });

  // Organizer is a staff hat, so the
  // roster names it with its hat label, never the raw role id.
  it("labels an organizer with the Organizer hat in English and Spanish", () => {
    const organizer = [{ userId: "u4", fullName: "Elena Cruz", initials: "EC", memberSince: 2024, roles: ["organizer"] }];
    const english = render(<LanguageProvider lang="en"><StaffRoster roster={organizer} /></LanguageProvider>);
    expect([...english.container.querySelectorAll(".reward-chip")].map((chip) => chip.textContent)).toEqual(["Organizer"]);
    english.unmount();
    const spanish = render(<LanguageProvider lang="es"><StaffRoster roster={organizer} /></LanguageProvider>);
    expect([...spanish.container.querySelectorAll(".reward-chip")].map((chip) => chip.textContent)).toEqual(["Organizador"]);
  });
});

// BUG-UG-WEB-ROLE-ROSTER-NAMES-ONE-LETTER-PER-LINE-20261002. The
// chip group never shrank (flex 0 0 auto) while the name could break anywhere
// and its column could shrink to nothing, so on advisor and President
// leadership and admin access a two-role person's name printed one letter per
// line. The row now wraps the chips onto their own line and the name keeps a
// floor; names are never truncated and chips are never hidden.
describe("StaffRoster row layout", () => {
  let unmountStyles;
  beforeAll(() => { unmountStyles = mountStylesheets(); });
  afterAll(() => unmountStyles());

  const TWO_ROLE = [{ userId: "u3", fullName: "Guadalupe Vasquez-Hernandez Fitzgerald", initials: "GV", memberSince: 2020, roles: ["coordinator", "steward"] }];

  it("keeps a two-role person's chips in their own group, apart from the name line", () => {
    render(<LanguageProvider lang="en"><StaffRoster roster={TWO_ROLE} /></LanguageProvider>);
    const row = document.querySelector(".ach-roster__row");
    const copy = row.querySelector(".ach-roster__copy");
    const chips = row.querySelector(".ach-roster__chips");
    expect(copy.querySelector(".ach-roster__name")).toHaveTextContent("Guadalupe Vasquez-Hernandez Fitzgerald");
    expect(copy.contains(chips)).toBe(false);
    expect([...chips.children].map((chip) => chip.textContent)).toEqual(["Campaign lead", "Committee"]);
  });

  it("wraps chips onto their own line instead of squeezing the name, and never breaks a name inside a word", () => {
    render(<LanguageProvider lang="en"><StaffRoster roster={TWO_ROLE} /></LanguageProvider>);
    const row = document.querySelector(".ach-roster__row");
    const name = row.querySelector(".ach-roster__name");
    const chips = row.querySelector(".ach-roster__chips");
    expect(getComputedStyle(row).flexWrap).toBe("wrap");
    expect(getComputedStyle(name).overflowWrap).not.toBe("anywhere");
    // The chip group may shrink and wrap within the row; it is never the
    // non-shrinking block that squeezed the name.
    expect(getComputedStyle(chips).flexShrink).not.toBe("0");
    expect(getComputedStyle(chips).flexWrap).toBe("wrap");
    expect(getComputedStyle(chips).maxWidth).toBe("100%");
    // The copy keeps a floor wider than a word instead of min-width 0.
    expect(declaredFor(".ach-roster__copy")).toMatch(/min-width:\s*min\(100%,\s*7\.5rem\)/);
    expect(declaredFor(".ach-roster__name")).not.toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("keeps the admin plane's remove buttons beside their chips at full target size, with translated role names", () => {
    render(
      <LanguageProvider lang="es">
        <StaffRoster
          roster={TWO_ROLE}
          renderRoleChip={(role, label, person) => (
            <span key={role} className="reward-chip reward-chip--tier">
              {label}
              <button type="button" className="xus-role-remove" aria-label={`Quitar ${label} de ${person.fullName}`}>x</button>
            </span>
          )}
        />
      </LanguageProvider>,
    );
    const chips = document.querySelector(".ach-roster__chips");
    const removes = within(chips).getAllByRole("button");
    expect(removes).toHaveLength(2);
    expect(removes.map((button) => button.getAttribute("aria-label"))).toEqual([
      "Quitar Liderazgo de campaña de Guadalupe Vasquez-Hernandez Fitzgerald",
      "Quitar Comité de Guadalupe Vasquez-Hernandez Fitzgerald",
    ]);
    for (const button of removes) {
      expect(getComputedStyle(button).width).toBe("44px");
      expect(getComputedStyle(button).height).toBe("44px");
    }
    expect(screen.getByText("Guadalupe Vasquez-Hernandez Fitzgerald")).toBeInTheDocument();
  });
});
