import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsView } from "../src/views/SettingsView.jsx";
import { explicitHatAllowsView } from "../src/App.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

// The More hub is reachable under a staff hat (settings is a shared account
// view), but it used to render the member rows for every hat. Tapping Search
// under the Steward role changed the URL to /m/search, the shell's route guard
// refused it, replaceState snapped back to /m/steward, and the member got
// "Your Steward role cannot open that page" for a control the hub itself had
// offered. Nine rows behaved that way. The hub now asks the shell's OWN guard
// (explicitHatAllowsView, bound to the selected hat) and omits what it
// refuses — no hat is switched implicitly.
//
// The assertion deliberately reads each row's real destination by activating
// it, not by label: a row gated on one view while navigating to another is
// exactly the defect this pins.

const REFUSED_UNDER_STEWARD = [
  "search",
  "voting",
  "rewards",
  "rights",
  "events",
  "voice",
  "forms",
  "workload",
  "numbers",
];

function guardFor(hat, roles) {
  // Same arguments the shell passes at the SettingsView mount: no SAMPLE
  // (demo false), the member's real roles, and the phone shell (no rail), so
  // the test refuses exactly what a signed-in steward's shell refuses.
  return (nextView, path) => explicitHatAllowsView(hat, nextView, false, roles, true, path);
}

function renderHub({ hat, roles }) {
  const onNavigate = vi.fn();
  const result = render(
    <LanguageProvider lang="en">
      <SettingsView
        data={{ member: { initials: "MV" }, roles }}
        lang="en"
        onNavigate={onNavigate}
        canNavigateView={guardFor(hat, roles)}
        onAssistant={vi.fn()}
        onProfile={vi.fn()}
      />
    </LanguageProvider>,
  );
  return { onNavigate, container: result.container };
}

// Every hub row that navigates, reported as the (view, path) pair it actually
// sends to the shell.
function offeredTargets(container, onNavigate) {
  const rows = container.querySelectorAll("section.morehub-list button.morehub-row--nav");
  for (const row of rows) fireEvent.click(row);
  return onNavigate.mock.calls.map(([view, path]) => ({ view, path }));
}

describe("More hub rows under a staff hat", () => {
  it("offers the member destinations while the member hat is worn", () => {
    const { container, onNavigate } = renderHub({ hat: "member", roles: ["steward"] });
    const views = offeredTargets(container, onNavigate).map((target) => target.view);
    for (const view of REFUSED_UNDER_STEWARD) expect(views).toContain(view);
    expect(views).toContain("appointments");
    expect(views).toContain("hub");
  });

  it("offers no row the steward hat's route guard would refuse", () => {
    const { container, onNavigate } = renderHub({ hat: "steward", roles: ["steward"] });
    const targets = offeredTargets(container, onNavigate);
    const refused = targets.filter(
      (target) => !explicitHatAllowsView("steward", target.view, false, ["steward"], true, target.path),
    );
    expect(refused).toEqual([]);
    const views = targets.map((target) => target.view);
    for (const view of REFUSED_UNDER_STEWARD) expect(views).not.toContain(view);
  });

  it("keeps the destinations the steward hat can open", () => {
    const { container, onNavigate } = renderHub({ hat: "steward", roles: ["steward"] });
    const views = offeredTargets(container, onNavigate).map((target) => target.view);
    // Account-level (settings/appointments) and the shared organize surface
    // are on every staff hat's map: hiding those would trade one dead tap for
    // a missing entrance.
    expect(views).toContain("appointments");
    expect(views).toContain("hub");
  });

  it("binds the hub's predicate to the shell's selected hat at the mount", () => {
    // A component test cannot see the wiring: a mount that forgets the prop
    // renders every row again and still passes the cases above.
    const app = readFileSync(resolve(process.cwd(), "src/App.jsx"), "utf8");
    const mount = app.split("\n").find((line) => line.includes("settings: <SettingsView"));
    expect(mount).toContain("canNavigateView={(nextView, path) => explicitHatAllowsView(selectedStaffHat,");
  });
});
