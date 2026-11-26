// REQ-UG-NAV-LIGHT-IDENTITY-20261102 (first pass for the owner): one
// desktop rail with the chapter catalog in a flyout, the worn role named in
// the rail, no painted Compass badge, light rail surfaces and page titles that
// name the page and the role.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ChapterRail } from "../src/components/ChapterRail.jsx";
import { DesktopRail } from "../src/components/DesktopRail.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { writeChapterRailExpandedByDefault } from "../src/lib/chapterRailPreference.js";
import { applyPageMetadata } from "../src/lib/pageMetadata.js";
import { currentWorkspaceTitle, setWorkspaceTitle, useWorkspaceDocumentTitle, workspaceTitle } from "../src/lib/workspaceTitle.js";

const chapters = [
  { id: "ma-dcf", name: "DCF Campaign", abbreviation: "DCF", category: "Massachusetts", memberCount: 812, staffCount: 6 },
  { id: "ma-dmh", name: "DMH Campaign", abbreviation: "DMH", category: "Massachusetts", memberCount: 436, staffCount: 4 },
];

function Shell({ onSelect = () => {}, activeHat = "steward", lang = "en" }) {
  const [open, setOpen] = useState(false);
  return (
    <LanguageProvider lang={lang}>
      <ChapterRail flyout id="chapter-flyout" triggerId="chapter-flyout-trigger" open={open} onOpenChange={setOpen}
        chapters={chapters} selectedId="ma-dcf" onSelect={onSelect} memberId="member-1" />
      <DesktopRail active="today" activeHat={activeHat} renderMode="desktop" memberId="member-1" onNavigate={() => {}} onAsk={() => {}}
        staffPlanes={[{ key: "steward", labelKey: "demo.hatSteward", path: "/m/steward" }]}
        chapterFlyout={{ open, onToggle: () => setOpen((current) => !current), controlsId: "chapter-flyout", triggerId: "chapter-flyout-trigger", current: chapters[0] }} />
      <main id="main-content"><p>Outside</p></main>
    </LanguageProvider>
  );
}

const trigger = () => screen.getByRole("button", { name: "Campaigns DCF Campaign" });

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => setWorkspaceTitle(null));

describe("campaign flyout from the one rail", () => {
  it("stays closed by default and opens beside the rail with the selection and honest counts", () => {
    render(<Shell />);
    expect(screen.queryByRole("navigation", { name: "Campaigns" })).toBeNull();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(trigger());
    const flyout = screen.getByRole("navigation", { name: "Campaigns" });
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    expect(trigger()).toHaveAttribute("aria-controls", "chapter-flyout");
    expect(flyout).toHaveAttribute("data-flyout", "true");
    expect(flyout).toHaveAttribute("data-collapsed", "false");
    expect(within(flyout).getByRole("searchbox", { name: "Filter campaigns" })).toHaveFocus();
    expect(within(flyout).getByPlaceholderText("Filter campaigns")).toHaveAccessibleName("Filter campaigns");
    expect(within(flyout).getByRole("button", { name: "Open DCF Campaign, 812 workers · 6 staff" })).toHaveAttribute("aria-pressed", "true");
    expect(within(flyout).getByRole("button", { name: "Open DMH Campaign, 436 workers · 4 staff" })).toHaveAttribute("aria-pressed", "false");
  });

  it("closes on Escape and gives focus back to the rail button", () => {
    render(<Shell />);
    fireEvent.click(trigger());
    const filter = screen.getByRole("searchbox", { name: "Filter campaigns" });
    fireEvent.keyDown(filter, { key: "Escape" });
    expect(screen.queryByRole("navigation", { name: "Campaigns" })).toBeNull();
    expect(trigger()).toHaveFocus();
    expect(trigger()).toHaveAttribute("aria-expanded", "false");
  });

  it("gives the open search the same visible and accessible name in Spanish", () => {
    render(<Shell lang="es" />);
    fireEvent.click(screen.getByRole("button", { name: "Campañas DCF Campaign" }));
    expect(screen.getByPlaceholderText("Filtrar campañas")).toHaveAccessibleName("Filtrar campañas");
  });

  it("closes from its own close button and gives focus back to the rail button", () => {
    render(<Shell />);
    fireEvent.click(trigger());
    const close = screen.getByRole("button", { name: "Collapse campaigns" });
    close.focus();
    fireEvent.click(close);
    expect(screen.queryByRole("navigation", { name: "Campaigns" })).toBeNull();
    expect(trigger()).toHaveFocus();
  });

  it("closes on Escape from a campaign choice through the shared Escape layer", () => {
    render(<Shell />);
    fireEvent.click(trigger());
    const choice = screen.getByRole("button", { name: /^Open DMH Campaign\b/ });
    choice.focus();
    fireEvent.keyDown(choice, { key: "Escape" });
    expect(screen.queryByRole("navigation", { name: "Campaigns" })).toBeNull();
    expect(trigger()).toHaveFocus();
  });

  it("moves between choices with the arrow keys and closes once a campaign is chosen", () => {
    const picked = [];
    render(<Shell onSelect={(chapter) => picked.push(chapter.id)} />);
    fireEvent.click(trigger());
    const first = screen.getByRole("button", { name: /^Open DCF Campaign\b/ });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowDown" });
    const second = screen.getByRole("button", { name: /^Open DMH Campaign\b/ });
    expect(second).toHaveFocus();
    fireEvent.click(second);
    expect(picked).toEqual(["ma-dmh"]);
    expect(screen.queryByRole("navigation", { name: "Campaigns" })).toBeNull();
  });

  it("closes on a pointer press outside, and the rail button toggles it", () => {
    render(<Shell />);
    fireEvent.click(trigger());
    fireEvent.pointerDown(screen.getByText("Outside"));
    expect(screen.queryByRole("navigation", { name: "Campaigns" })).toBeNull();

    fireEvent.click(trigger());
    fireEvent.pointerDown(trigger());
    fireEvent.click(trigger());
    expect(screen.queryByRole("navigation", { name: "Campaigns" })).toBeNull();
  });

  it("opens on load, and follows the switch, for a worker who keeps it expanded (#6989)", async () => {
    writeChapterRailExpandedByDefault({ memberId: "member-1" }, true);
    render(<Shell />);
    expect(await screen.findByRole("navigation", { name: "Campaigns" })).toBeInTheDocument();
    act(() => writeChapterRailExpandedByDefault({ memberId: "member-1" }, false));
    expect(screen.queryByRole("navigation", { name: "Campaigns" })).toBeNull();
    act(() => writeChapterRailExpandedByDefault({ memberId: "member-1" }, true));
    expect(screen.getByRole("navigation", { name: "Campaigns" })).toBeInTheDocument();
  });
});

describe("the rail's identity", () => {
  it.each([["steward", "Working as Committee"], ["member", "Working as Worker"]])("names the worn %s role under the organization", (activeHat, text) => {
    render(<Shell activeHat={activeHat} />);
    const role = screen.getByText(text);
    expect(role).toHaveClass("desktop-rail__role");
    expect(role).toHaveAttribute("data-role", activeHat);
  });

  // REQ-UG-DESKTOP-RAIL-GREEN-THEME-GUIDE-20261112 replaced the white
  // paper rail of #6796 with the theme guide's green rail (Suggestions item 2,
  // option A), which the owner decided on Nov 13, 2026 ("Proceed with a
  // recommendation"; the Desktop rail contract in src/AGENTS.md). The
  // chapter flyout keeps its paper surface.
  const railTokens = () => {
    const tokens = readFileSync("src/sg-tokens.css", "utf8");
    return Object.fromEntries([...tokens.matchAll(/--(sg-rail-[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
  };

  it("keeps the rail's sizes in one set of tokens, 30% larger than the guide's first rail", () => {
    expect(railTokens()).toEqual({
      "sg-rail-width": "302px",
      "sg-rail-width-folded": "78px",
      "sg-rail-icon": "26px",
      "sg-rail-icon-folded": "32px",
      "sg-rail-row-text": "15px",
      "sg-rail-row-height": "48px",
      "sg-rail-icon-gap": "12px",
      "sg-rail-label-text": "12px",
      "sg-rail-count": "20px",
      "sg-rail-count-text": "11.5px",
      "sg-rail-count-folded": "17px",
      "sg-rail-count-folded-text": "11px",
      "sg-rail-mark": "40px",
      "sg-rail-name-text": "17.5px",
      "sg-rail-tile": "40px",
      "sg-rail-tablet-icon": "24px",
      "sg-rail-tablet-row-text": "14px",
    });
    // The app's floors: no rail text under 11px, no rail row under 44px.
    for (const [name, value] of Object.entries(railTokens())) {
      if (name.endsWith("-text")) expect(Number.parseFloat(value), name).toBeGreaterThanOrEqual(11);
    }
    expect(Number.parseFloat(railTokens()["sg-rail-row-height"])).toBeGreaterThanOrEqual(44);
  });

  it("sizes rail icons from the tokens beside a label, folded and on the tablet rail, with token-sized count pills", () => {
    const styles = readFileSync("src/styles.css", "utf8");
    expect(styles).toContain('.desktop-rail[data-workspace-theme="union-ground"] .desktop-rail__ic svg { width: var(--sg-rail-icon); height: var(--sg-rail-icon); }');
    expect(styles).toContain('.desktop-rail[data-workspace-theme="union-ground"][data-render-mode="desktop"][data-collapsed="true"] .desktop-rail__ic svg { width: var(--sg-rail-icon-folded); height: var(--sg-rail-icon-folded); }');
    const tablet = ruleOf(styles, '.desktop-rail[data-workspace-theme="union-ground"][data-render-mode="tablet"]');
    for (const line of ["--sg-rail-icon: var(--sg-rail-tablet-icon);", "--sg-rail-row-text: var(--sg-rail-tablet-row-text);"]) expect(tablet).toContain(line);
    // Beside the bell on the 220px tablet rail the name wraps onto two lines;
    // on one line (#8649) it ran under the bell. The browser assurance suite
    // measures it (assertRailBrandWhole in e2e/assurance-smoke.spec.js).
    expect(ruleOf(styles, '.desktop-rail[data-workspace-theme="union-ground"][data-render-mode="tablet"] .desktop-rail__brand .desktop-rail__brand-text > b')).toContain("white-space: normal;");
    const count = styles.slice(styles.indexOf('.desktop-rail[data-workspace-theme="union-ground"] :is(.rail-count, .rail-badge) {'));
    const rule = count.slice(0, count.indexOf("}"));
    for (const line of ["min-width: var(--sg-rail-count);", "height: var(--sg-rail-count);", "font-size: var(--sg-rail-count-text);", "background: var(--sg-light-rail-count);", "color: var(--sg-light-on-primary);"]) expect(rule).toContain(line);
    expect(styles).toContain('.desktop-rail[data-workspace-theme="union-ground"] :is(.desktop-rail__chapters-abbr, .desktop-rail__user-avatar) { flex-basis: var(--sg-rail-tile); width: var(--sg-rail-tile); height: var(--sg-rail-tile); }');
  });

  it("shows a count pill for a count and none for a zero count", () => {
    render(<LanguageProvider lang="en"><DesktopRail active="today" activeHat="member" renderMode="desktop" memberId="member-1" onNavigate={() => {}} onAsk={() => {}} badges={{ messages: 0, cases: 3 }} /></LanguageProvider>);
    expect([...document.querySelectorAll(".desktop-rail .rail-count")].map((pill) => pill.textContent)).toEqual(["3"]);
  });

  // UX-UG-DESKTOP-RAIL-MATCH-THEME-GUIDE-SIDE-RAIL-20261113: the rest
  // of the guide's Side rail, measured against the guide in a browser.
  const ruleOf = (styles, selector) => {
    const start = styles.indexOf(`${selector} {`);
    expect(start, selector).toBeGreaterThan(-1);
    return styles.slice(start, styles.indexOf("}", start));
  };

  it("folds from the pill on the rail's edge, which draws a chevron and keeps its name and state", () => {
    render(<Shell activeHat="member" />);
    const rail = screen.getByRole("navigation", { name: "Primary" });
    const pill = screen.getByRole("button", { name: "Collapse rail" });
    expect(pill.querySelector(".desktop-rail__collapse-glyph svg")).not.toBeNull();
    fireEvent.click(pill);
    expect(rail).toHaveAttribute("data-collapsed", "true");
    expect(screen.getByRole("button", { name: "Expand rail" }).querySelector(".desktop-rail__collapse-glyph svg")).not.toBeNull();
    expect(window.localStorage.getItem("sg:member:member-1:desktop-main-rail:collapsed")).toBe("true");

    const styles = readFileSync("src/styles.css", "utf8");
    const rule = ruleOf(styles, '.desktop-rail[data-workspace-theme="union-ground"][data-render-mode="desktop"] .desktop-rail__collapse');
    for (const line of ["position: fixed;", "top: calc(50% - 26px);", "left: calc(var(--desktop-rail-current-width, var(--sg-rail-width)) - 22px);", "width: 44px;", "height: 52px;"]) expect(rule).toContain(line);
    expect(ruleOf(styles, '.desktop-rail[data-workspace-theme="union-ground"][data-render-mode="desktop"] .desktop-rail__collapse:hover')).toContain("transform: translateX(2px);");
    const drawnPill = ruleOf(styles, '.desktop-rail[data-workspace-theme="union-ground"][data-render-mode="desktop"] .desktop-rail__collapse::before');
    for (const line of ["inset: 0 10px;", "border-radius: var(--sg-radius-lg);", "background: var(--sg-light-card);", "box-shadow: var(--rail-pill-shadow);"]) expect(drawnPill).toContain(line);
  });

  it("marks a draft-forms count as asking for attention and leaves other counts green", () => {
    render(<LanguageProvider lang="en"><DesktopRail active="today" activeHat="member" renderMode="desktop" memberId="member-1" onNavigate={() => {}} onAsk={() => {}} badges={{ forms: 2, cases: 3 }} /></LanguageProvider>);
    const counts = [...document.querySelectorAll(".desktop-rail .rail-count")];
    expect(counts.map((pill) => [pill.textContent, pill.classList.contains("is-alert")])).toEqual(expect.arrayContaining([["2", true], ["3", false]]));
  });

  it("follows the guide's widths, group labels, rows and pointer nudge, with room for the focus ring", () => {
    const styles = readFileSync("src/styles.css", "utf8");
    expect(styles).toContain('.sg-app--desktop:has(.desktop-rail[data-workspace-theme="union-ground"]) { --desktop-rail-expanded-width: var(--sg-rail-width); }');
    expect(styles).toContain('.sg-app--desktop:has(.desktop-rail[data-workspace-theme="union-ground"][data-collapsed="true"]) { --desktop-rail-current-width: var(--sg-rail-width-folded); }');
    const label = ruleOf(styles, '.desktop-rail[data-workspace-theme="union-ground"] .desktop-rail__items > .desktop-rail__grouplabel');
    for (const line of ["font-family: var(--sg-font-family-mono);", "font-size: var(--sg-rail-label-text);", "letter-spacing: .08em;", "padding: 0 10px 2px;"]) expect(label).toContain(line);
    const row = ruleOf(styles, '.desktop-rail[data-workspace-theme="union-ground"] .desktop-rail__items .desktop-rail__row');
    for (const line of ["gap: var(--sg-rail-icon-gap);", "min-height: var(--sg-rail-row-height);", "border-radius: 9px;", "padding: 6px 10px;", "font-size: var(--sg-rail-row-text);"]) expect(row).toContain(line);
    expect(styles).toContain('.desktop-rail[data-workspace-theme="union-ground"] .desktop-rail__items { gap: 4px; margin-inline: -5px; padding-inline: 5px 8px; }');
    expect(styles).toContain('.desktop-rail[data-workspace-theme="union-ground"]:not([data-collapsed="true"]) .desktop-rail__items .desktop-rail__row:hover { transform: translateX(1px); }');
    expect(styles).toContain('.desktop-rail[data-workspace-theme="union-ground"] .desktop-rail__ic svg { stroke-width: 1.75; }');
  });
});

describe("page titles", () => {
  it("names the page and the role, once each", () => {
    expect(workspaceTitle("Committee worker messages", "Committee worker")).toBe("Committee worker messages · Committee worker | Union Ground");
    expect(workspaceTitle("Committee worker", "Committee worker")).toBe("Committee worker | Union Ground");
    expect(workspaceTitle("", "")).toBeNull();
  });

  it("follows the workspace heading and survives a head refresh on a signed-in path", async () => {
    window.history.replaceState({}, "", "/m/steward/messages");
    function Page({ heading }) {
      useWorkspaceDocumentTitle("Committee worker");
      return <main id="main-content"><h1>{heading}</h1></main>;
    }
    const view = render(<Page heading="Committee worker messages" />);
    await waitFor(() => expect(document.title).toBe("Committee worker messages · Committee worker | Union Ground"));
    applyPageMetadata("/m/steward/messages");
    expect(document.title).toBe("Committee worker messages · Committee worker | Union Ground");

    view.rerender(<Page heading="One-on-ones" />);
    await waitFor(() => expect(document.title).toBe("One-on-ones · Committee worker | Union Ground"));

    view.unmount();
    expect(currentWorkspaceTitle()).toBeNull();
    applyPageMetadata("/m/steward/messages");
    expect(document.title).toBe("Union Ground | Organizing workspace");
  });

  it("leaves public page titles alone", () => {
    setWorkspaceTitle("Security · Worker | Union Ground");
    applyPageMetadata("/privacy");
    expect(document.title).not.toContain("Security · Worker");
  });
});
