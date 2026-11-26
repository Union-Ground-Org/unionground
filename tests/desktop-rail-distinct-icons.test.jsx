import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DesktopRail } from "../src/components/DesktopRail.jsx";
import { RAIL_ICON_FOR, RailIcon, railIconName } from "../src/components/RailIcons.jsx";
import { NAV_PINS_MAX } from "../src/features/memberHome/navUsage.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { FEATURE_GROUPS } from "../src/lib/mobileNav.js";
import { STAFF_PLANES } from "../src/lib/staffPlanes.js";

// UX-UG-FOLDED-RAIL-AND-COMMAND-PALETTE-ICONS-REPEAT-20261122 (#9565):
// folded, the rail shows only icons, and on Main six Admin pages drew one
// people icon (38 different icons for 52 rows). The owner chose option A
// ("rail icons A", Nov 23, 2026): every row its own icon from the theme
// package. Walk every row of every demo role's folded rail, in English and
// Spanish, and fail when two rows draw the same shape or a row draws an icon
// that is not one of the package's. Then build every rail the definitions can
// produce on the live site (every role, the Desks group with every desk, the
// site guide and dues on, every phone-directory page pinned, desktop folded
// and tablet) and fail on a row with no package icon or two rows that open
// different pages with one shape.
const ROLES = [{ key: "member", view: "today" }, ...STAFF_PLANES.map((plane) => ({ key: plane.key, view: plane.view }))];
const FOLD = "sg:demo:desktop-main-rail:collapsed";

beforeEach(() => {
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  window.sessionStorage.setItem(FOLD, "true");
});

afterEach(() => {
  delete globalThis.ResizeObserver;
  window.sessionStorage.removeItem(FOLD);
});

function foldedRows(role, lang) {
  const { container } = render(<LanguageProvider lang={lang}>
    <DesktopRail active={role.view} activeHat={role.key} demo memberId={null} staffPlanes={STAFF_PLANES} workspaceTheme="union-ground" onSwitchHat={() => {}} onAsk={() => {}} onNavigate={() => {}} renderMode="desktop" />
  </LanguageProvider>);
  expect(container.querySelector(".desktop-rail")?.getAttribute("data-collapsed")).toBe("true");
  return [...container.querySelectorAll(".desktop-rail__items :is(a, button)")].map((row) => {
    const svg = row.querySelector(".desktop-rail__ic svg");
    return { label: row.getAttribute("aria-label"), name: svg?.getAttribute("data-rail-icon") ?? null, shape: svg?.innerHTML ?? "" };
  });
}

describe("folded desktop rail icons", () => {
  for (const lang of ["en", "es"]) {
    for (const role of ROLES) {
      it(`gives every ${role.key} row its own package icon (${lang})`, () => {
        const rows = foldedRows(role, lang);
        expect(rows.length).toBeGreaterThanOrEqual(7);
        const byShape = new Map();
        for (const row of rows) byShape.set(row.shape, [...(byShape.get(row.shape) || []), row.label]);
        expect([...byShape.values()].filter((labels) => labels.length > 1)).toEqual([]);
        expect(rows.filter((row) => !row.name).map((row) => row.label)).toEqual([]);
      });
    }
  }

  it("names a drawn package icon for every mapped row", () => {
    const blank = Object.entries(RAIL_ICON_FOR).filter(([, name]) => {
      const { container, unmount } = render(<RailIcon name={name} />);
      const empty = container.querySelector("svg")?.childElementCount === 0;
      unmount();
      return empty;
    });
    expect(blank).toEqual([]);
    // A key with no entry (a row added later) gets no package icon, so the
    // rail falls back and the live cases below fail on it.
    expect(railIconName("a-row-added-later")).toBeNull();
    expect(railIconName("toString")).toBeNull();
    const { container } = render(<RailIcon name="compass" size={32} />);
    expect(container.querySelector("svg")?.getAttribute("width")).toBe("32");
  });

  const PINNABLE = FEATURE_GROUPS.flatMap((group) => group.items).filter((item) => item?.path && !item.action).map((item) => item.viewKey ?? item.key);
  const PIN_SETS = Array.from({ length: Math.ceil(PINNABLE.length / NAV_PINS_MAX) }, (_, index) => PINNABLE.slice(index * NAV_PINS_MAX, (index + 1) * NAV_PINS_MAX));
  const LIVE_CASES = [
    ...PIN_SETS.map((pins, index) => ({ role: ROLES[0], pins, name: `member, pins ${index + 1} of ${PIN_SETS.length}` })),
    ...ROLES.slice(1).map((role) => ({ role, pins: null, name: role.key })),
  ];

  function liveRows({ role, pins }, renderMode) {
    const memberId = `rail-icons-${role.key}-${renderMode}`;
    window.localStorage.setItem(`sg:member:${memberId}:desktop-main-rail:collapsed`, "true");
    try {
      const { container, unmount } = render(<LanguageProvider lang="en">
        <DesktopRail active={role.view} activeHat={role.key} memberId={memberId} staffPlanes={STAFF_PLANES} deskEntrances={STAFF_PLANES} siteGuide dues navUsagePins={pins} workspaceTheme="union-ground" onAsk={() => {}} onNavigate={() => {}} renderMode={renderMode} />
      </LanguageProvider>);
      if (renderMode === "desktop") expect(container.querySelector(".desktop-rail")?.getAttribute("data-collapsed")).toBe("true");
      const rows = [...container.querySelectorAll(".desktop-rail__items :is(a, button)")].map((row) => {
        const svg = row.querySelector(".desktop-rail__ic svg");
        const label = row.getAttribute("aria-label");
        return { label, page: row.getAttribute("href") ?? `button:${label}`, name: svg?.getAttribute("data-rail-icon") ?? null, shape: svg?.innerHTML ?? "" };
      });
      unmount();
      return rows;
    } finally {
      window.localStorage.removeItem(`sg:member:${memberId}:desktop-main-rail:collapsed`);
    }
  }

  for (const renderMode of ["desktop", "tablet"]) {
    for (const liveCase of LIVE_CASES) {
      it(`draws a package icon on every live ${liveCase.name} row, one page per shape (${renderMode})`, () => {
        const rows = liveRows(liveCase, renderMode);
        expect(rows.length).toBeGreaterThanOrEqual(7);
        expect(rows.filter((row) => !row.name).map((row) => row.label)).toEqual([]);
        if (liveCase.pins) expect(rows.filter((row) => liveCase.pins.some((pin) => row.page.endsWith(`/${pin}`) || row.page.includes(`/${pin}/`))).length).toBeGreaterThan(0);
        const pagesByShape = new Map();
        for (const row of rows) pagesByShape.set(row.shape, new Map([...(pagesByShape.get(row.shape) || []), [row.page, row.label]]));
        expect([...pagesByShape.values()].filter((pages) => pages.size > 1).map((pages) => [...pages.values()])).toEqual([]);
      });
    }
  }
});
