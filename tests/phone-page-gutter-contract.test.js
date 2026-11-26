import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement as h } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DemoVoiceStudio } from "../src/components/DemoVoiceStudio.jsx";
import { buildAccessActor } from "../src/lib/mi1AccessHistoryWiring.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { AccessHistoryView } from "../src/views/AccessHistoryView.jsx";
import { CampaignsView } from "../src/views/CampaignsView.jsx";
import { declaredFor, mountStylesheets, styleRule } from "./helpers/appStylesheet.js";

// BUG-UNIONGROUND-WEB-{CIVIC-PAGES,ACCESS-HISTORY,CLAUSE-REFERENCE,
// STAFF-CAMPAIGNS,SURVEY-STUDIO}-NO-PHONE-GUTTER-20261002. `.screen` has no
// side inset and the main column only gets one from the desktop shell, so
// every phone screen sets its own; these hosts did not and ran from x=0 to the
// right edge. Civic action and the contract-clause reference are left out of
// Union Ground, so their two hosts are asserted absent instead. Each case renders the real host inside the phone shell
// (and the desktop shell, which must stay as it was) with the real stylesheet.
// jsdom 31 resolves var(), so mount the real tokens and assert the computed
// 16px inset. The token's declaration is also pinned once below.

const ORG = "org-a";
let unmountStyles;
beforeAll(() => { unmountStyles = mountStylesheets("src/sg-tokens.css", "src/styles.css", "src/components/workspacePages.css"); });
afterAll(() => unmountStyles());
afterEach(cleanup);

function inShell(child, { desktop = false } = {}) {
  return render(h(LanguageProvider, { lang: "en" },
    h("div", { className: desktop ? "sg-app sg-app--desktop" : "sg-app" },
      h("main", { className: "app-column", id: "main-content" }, child))));
}

const INSET = "16px";
const inline = (node) => [getComputedStyle(node).paddingLeft, getComputedStyle(node).paddingRight];

function expectPhoneInsetOnly(host, desktopHost) {
  expect(inline(host), "16px side inset at phone width").toEqual([INSET, INSET]);
  // Desktop is unchanged: the host adds nothing; the desktop column insets it.
  expect(inline(desktopHost).map((value) => Number.parseFloat(value) || 0)).toEqual([0, 0]);
}

it("the inset token is the 16px phone gutter and the desktop column keeps its own 28px", () => {
  const tokens = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "sg-tokens.css"), "utf8");
  expect(tokens).toMatch(/--sg-space-s16:\s*16px;/);
  expect(declaredFor(".sg-app--desktop .app-column")).toMatch(/padding-inline:\s*28px/);
});

describe("phone page gutter for flush feature hosts", () => {
  it("ships no civic or contract-clause host to inset: both features are left out", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..");
    for (const path of ["src/views/CivicView.jsx", "src/civic.css", "src/views/ClauseQuickReferenceView.jsx", "src/lib/mi1ClauseWiring.js"]) {
      expect(existsSync(join(root, path)), path).toBe(false);
    }
    const styles = readFileSync(join(root, "src", "styles.css"), "utf8");
    expect(styles).not.toMatch(/\.civic-host\b/);
    expect(styles).not.toMatch(/\.clause-quickref\b/);
  });

  it("access history: the section takes the phone inset", () => {
    const actor = buildAccessActor({ userId: "member-a", organizationId: ORG, membershipStatus: "active" });
    const host = inShell(h(AccessHistoryView, { actor, nowIso: () => "2026-10-02T12:00:00.000Z" })).container.querySelector("section.access-history");
    const desktop = inShell(h(AccessHistoryView, { actor, nowIso: () => "2026-10-02T12:00:00.000Z" }), { desktop: true }).container.querySelector("section.access-history");
    expect(host).not.toBeNull();
    expectPhoneInsetOnly(host, desktop);
  });

  it("staff campaigns: the registry takes the inset its header and sub-tabs already have, and the filter chips wrap", async () => {
    const api = { load: vi.fn().mockResolvedValue({ campaigns: [], canManageUnion: false, chapterId: "wor" }) };
    const view = inShell(h(CampaignsView, { api }));
    await screen.findByRole("heading", { name: "Campaigns" });
    const screenNode = view.container.querySelector(".campaigns-screen");
    const registry = screenNode.querySelector(".cam-shell");
    const desktop = inShell(h(CampaignsView, { api }), { desktop: true }).container.querySelector(".cam-shell");
    expectPhoneInsetOnly(registry, desktop);
    // The screen itself stays un-inset: its own header and sub-tabs pad
    // themselves, and padding the screen would double them.
    expect(inline(screenNode).map((value) => Number.parseFloat(value) || 0)).toEqual([0, 0]);
    const filters = screenNode.querySelector(".cam-filters");
    expect(getComputedStyle(filters).flexWrap).toBe("wrap");
    expect(getComputedStyle(filters).overflowX).not.toMatch(/auto|scroll/);
    // A 320px phone leaves 288px inside the inset; a list track may not
    // demand more than the row it sits in.
    expect(styleRule(".cam-shell--single .cam-list").getPropertyValue("grid-template-columns")).toContain("min(100%, 320px)");
  });

  it("survey studio: the studio takes the inset and draws no second rule under the sub-page tabs", () => {
    const { container } = inShell(h("section", { className: "campaigns-screen" },
      h("nav", { className: "workspace-subpages", "aria-label": "Pages" }, h("a", { href: "/m/campaigns" }, "Campaigns")),
      h(DemoVoiceStudio, { lang: "en" })));
    const studio = container.querySelector(".voice-demo-studio");
    const desktop = inShell(h(DemoVoiceStudio, { lang: "en" }), { desktop: true }).container.querySelector(".voice-demo-studio");
    expectPhoneInsetOnly(studio, desktop);
    // The tabs end in a rule; the studio's own top rule is dropped after them
    // and kept everywhere else (its border-block is declared once).
    expect(declaredFor(".workspace-subpages")).toMatch(/border-bottom:\s*1px solid/);
    expect(declaredFor(".voice-demo-studio")).toMatch(/border-block:\s*1px solid/);
    expect(getComputedStyle(studio).borderTopWidth).toBe("0px");
    expect(getComputedStyle(desktop).borderTopWidth).not.toBe("0px");
  });
});
