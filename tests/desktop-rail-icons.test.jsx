import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DesktopRail } from "../src/components/DesktopRail.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { STAFF_PLANES } from "../src/lib/staffPlanes.js";

// UX-UG-DESKTOP-RAIL-PLACEHOLDER-CIRCLE-ICONS-20261108: the rail drew
// a plain Circle for pages with no icon of their own (Q&A queue, Email intake,
// Procedure settings, Case macros, Coordination, Organization & chapters,
// Campaigns & priorities, Invite a member, Requests). Walk every row of every
// demo role's rail and fail on the fallback.
const ROLES = [{ key: "member", view: "today" }, ...STAFF_PLANES.map((plane) => ({ key: plane.key, view: plane.view }))];

beforeEach(() => {
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
});

afterEach(() => {
  delete globalThis.ResizeObserver;
});

describe("desktop rail icons", () => {
  for (const role of ROLES) {
    for (const renderMode of ["desktop", "tablet"]) {
      it(`draws a product icon on every ${role.key} row (${renderMode})`, () => {
        const { container } = render(<LanguageProvider lang="en">
          <DesktopRail active={role.view} activeHat={role.key} demo memberId={null} staffPlanes={STAFF_PLANES} onSwitchHat={() => {}} onAsk={() => {}} onNavigate={() => {}} renderMode={renderMode} />
        </LanguageProvider>);
        const rows = [...container.querySelectorAll(".desktop-rail__items :is(a, button)")];
        expect(rows.length).toBeGreaterThan(5);
        const placeholders = rows.filter((row) => row.querySelector("svg.lucide-circle")).map((row) => row.textContent.trim());
        expect(placeholders).toEqual([]);
      });
    }
  }
});
