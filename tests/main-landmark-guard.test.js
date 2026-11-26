import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { App } from "../src/App.jsx";
import { t } from "../src/lib/i18n.js";
import { primeDemoHat } from "./helpers/demoHat.js";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const realMatchMedia = window.matchMedia;
const GUIDE = t("en", "nav.compass");
// The desktop rail names the Guide with its AI badge ("Union Ground Guide AI").
const GUIDE_BUTTON = new RegExp(`^${GUIDE}\\b`);
const standaloneShells = new Set([
  "src/main.jsx",
  "src/App.jsx",
  "src/AppRouter.jsx",
  "src/MemberShellShared.jsx",
  "src/components/AuthScreen.jsx",
  "src/components/MfaSettings.jsx",
  "src/components/PublicDocumentShell.jsx",
  "src/views/VerifyReceiptView.jsx",
  "src/views/InvitationAcceptView.jsx",
  "src/views/GetAppView.jsx",
  "src/views/OpenSignupView.jsx",
  "src/views/OpenSignupConfirmView.jsx",
  "src/views/PasswordResetView.jsx",
  "src/features/openSignup/CreateOrganizationGate.jsx",
  "src/views/RequestInviteView.jsx",
  "src/views/PublicInterestStopConfirmView.jsx",
  // Union Ground's public front door (/, /learn, /connect) and the
  // explanation page for retired legacy addresses are standalone routes too.
  "src/views/LearnView.jsx",
  "src/views/ConnectView.jsx",
  "src/views/RetiredLegacyView.jsx",
  // Union Ground's top-level error boundary renders in place of the whole
  // App (tests/App.test.jsx "top-level error boundary"), never inside it.
  "src/components/ErrorBoundary.jsx",
]);
// Union Ground's public landing, public chapter directory, organization claim
// confirmation and dues page are left out of Union Ground; none may return
// as a shell or as a page inside one.
const leftOutViews = [
  "src/views/PublicLanding.jsx",
  "src/features/publicDirectory/PublicDirectoryShell.jsx",
  "src/views/OrganizationClaimConfirmView.jsx",
  "src/views/DuesView.jsx",
];

function jsxFiles(directory) {
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return jsxFiles(path);
    return entry.name.endsWith(".jsx") ? [path] : [];
  });
}

function stubDesktopMatchMedia() {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: query === "(min-width: 768px)" || query.includes("min-width: 1024px"),
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
}

async function assertLandmarks(container) {
  const results = await axe.run(container, {
    runOnly: { type: "rule", values: ["landmark-no-duplicate-main", "landmark-main-is-top-level"] },
  });
  expect(results.violations).toEqual([]);
}

beforeEach(() => {
  stubDesktopMatchMedia();
  window.history.replaceState({}, "", "/m");
  window.scrollTo = vi.fn();
  global.fetch = vi.fn().mockRejectedValue(new Error("offline test"));
});

afterEach(() => {
  window.matchMedia = realMatchMedia;
  try { window.localStorage.removeItem("sg-lang"); } catch { /* jsdom always has storage */ }
});

describe("main landmark guard", () => {
  it("ships none of the left-out views", () => {
    for (const path of leftOutViews) expect(existsSync(resolve(root, path)), path).toBe(false);
  });

  it.each([
    ["src/views/MemberSupportView.jsx", "member-support-desk"],
    ["src/views/CollectiveActionsView.jsx", "oi-shell"],
    ["src/views/OrganizationIntelligenceView.jsx", "oi-shell"],
    ["src/components/FloatingControls.jsx", "assistant-chat"],
  ])("keeps the converted section named in %s", (path, className) => {
    expect(read(path), path).toMatch(new RegExp(`<section\\b[^>]*className="${className}"[^>]*\\baria-label=`));
  });

  it("permits main landmarks only in exact standalone shells", () => {
    for (const path of jsxFiles("src")) {
      const source = read(path);
      if (standaloneShells.has(path)) continue;
      expect(source, path).not.toMatch(/<main\b/);
    }
  });

  it("keeps the standalone-main allowlist exact", () => {
    const source = read("tests/main-landmark-guard.test.js");
    for (const path of standaloneShells) expect(read(path), path).toMatch(/<main\b/);
    expect(source).toContain("const standaloneShells");
  });

  it("A11Y-UG-NESTED-MAIN-LANDMARKS-20260907 serves no dues page at /m/dues and still renders one main", async () => {
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m/dues?demo=1");
    const { container } = render(createElement(App));
    expect(await screen.findByRole("main")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "My dues" })).toBeNull();
    expect(container.querySelector(".dues-workspace")).toBeNull();
    expect(container.querySelectorAll("main")).toHaveLength(1);
    await assertLandmarks(container);
  });

  it.each([
    ["/m/support?demo=1", "Worker support", "member"],
    ["/m/actions?demo=1", "Safe staffing commitment", "member"],
    ["/m/organization-map?demo=1", "Organization map", "coordinator"],
  ])("A11Y-UG-NESTED-MAIN-LANDMARKS-20260907 renders %s with one main and desktop Compass landmarks", async (path, intendedHeading, hat) => {
    primeDemoHat(hat);
    window.history.replaceState({}, "", path);
    const { container } = render(createElement(App));

    expect(await screen.findByRole("heading", { name: intendedHeading })).toBeInTheDocument();
    expect(container.querySelector('[data-mi1-surface]')).toBeInTheDocument();
    expect(container.querySelectorAll("main")).toHaveLength(1);
    await assertLandmarks(container);

    // Staff rails intentionally expose their owned desk links instead of the
    // member-only Compass shortcut. Keep the route assertion above on the
    // requested staff surface, then use the same rendered App shell's Home
    // control to exercise the desktop Compass overlay as well.
    // Union Ground's Compass is the Guide, and its member hat is Worker.
    if (!screen.queryByRole("button", { name: GUIDE_BUTTON })) {
      fireEvent.click(screen.getByRole("button", { name: /Switch role, current:/ }));
      fireEvent.click(screen.getByRole("menuitemradio", { name: "Worker" }));
      await screen.findByRole("heading", { name: /Darnell/ });
    }
    fireEvent.click(screen.getByRole("button", { name: GUIDE_BUTTON }));
    expect(await screen.findByRole("dialog", { name: GUIDE })).toBeInTheDocument();
    expect(container.querySelectorAll("main")).toHaveLength(1);
    await assertLandmarks(container);
  });

  it("A11Y-UG-NESTED-MAIN-LANDMARKS-20260907 keeps the authenticated route shell as the only main landmark in source", () => {
    expect(read("src/App.jsx").match(/<main\b[^>]*id="main-content"/g)).toHaveLength(1);
    for (const path of [
      "src/views/MemberSupportView.jsx",
      "src/views/CollectiveActionsView.jsx",
      "src/views/OrganizationIntelligenceView.jsx",
      "src/components/FloatingControls.jsx",
    ]) {
      expect(read(path), path).not.toMatch(/<main\b/);
    }
  });

  it("routes the authenticated main landmark name through the catalogue", () => {
    const source = read("src/App.jsx");
    expect(source).not.toMatch(/aria-label=\{embedPhone \? "Companion phone workspace" : "Primary workspace"\}/);
    expect(source).toMatch(/aria-label=\{mainWorkspaceLabel\}/);
    expect(source).toMatch(/: tr\(embedPhone \? "app\.mainCompanionLabel" : "app\.mainWorkspaceLabel"\);/);
    expect(t("en", "app.mainWorkspaceLabel")).toBe("Primary workspace");
    expect(t("es", "app.mainWorkspaceLabel")).not.toBe("Primary workspace");
    expect(t("en", "app.mainCompanionLabel")).toBe("Companion phone workspace");
    expect(t("es", "app.mainCompanionLabel")).not.toBe("Companion phone workspace");
  });

  it("names the authenticated main landmark from the Spanish catalogue", async () => {
    window.localStorage.setItem("sg-lang", "es");
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m?demo=1");
    render(createElement(App));
    const main = await screen.findByRole("main");
    expect(main).toHaveAttribute("id", "main-content");
    expect(main.getAttribute("aria-label")).not.toBe("Primary workspace");
    expect(main).toHaveAccessibleName(`${t("es", "app.mainWorkspaceLabel")}: ${t("es", "demo.hatMember")}`);
    expect(screen.getByRole("link", { name: t("es", "app.skip") })).toBeInTheDocument();
  });
});
