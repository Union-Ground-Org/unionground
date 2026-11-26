// REQ-UG-NAVIGATION-HELP-AND-SETUP-COPY-20261030, finding 84: the guided
// menu says how onboarding finishes, the guide list's badge words are plain,
// and the member rail no longer names two controls "Home".
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DesktopRail } from "../src/components/DesktopRail.jsx";
import { GuidedNavToggle } from "../src/components/OnboardingHud.jsx";
import { MemberGuideList } from "../src/features/onboardingGuideEngine/MemberGuideLayers.jsx";
import { memberFeatureGuides } from "../src/features/onboardingGuideEngine/memberLayers.js";
import { GUIDE_COPY_EN } from "../apps/mobile/src/features/guideLayers/guideCopy.ts";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue, t as translate } from "../src/lib/i18n.js";
import { INACTIVE_GUIDE, NEW_MEMBER_GUIDED_NAV_DAYS, normalizeOnboardingGuide, withNewMemberGuidedNav } from "../src/lib/onboardingGuide.js";

const guided = { progressiveDisclosureActive: true };

function rail(props = {}, lang = "en") {
  return render(<LanguageProvider lang={lang}><DesktopRail renderMode="desktop" active="today" onNavigate={vi.fn()} onAsk={vi.fn()} {...props} /></LanguageProvider>);
}

describe("guided menu note", () => {
  it("names what finishes onboarding and how to see everything now", () => {
    render(<LanguageProvider lang="en"><GuidedNavToggle guide={guided} showAll={false} hiddenCount={16} onToggle={vi.fn()} /></LanguageProvider>);
    const note = screen.getByText(/Showing the essentials/);
    expect(note.textContent).toContain("until you finish your onboarding steps in Worker support > Onboarding");
    expect(note.textContent).toContain("Show everything");
    expect(screen.getByRole("button", { name: "Show everything (16 more)" })).toBeInTheDocument();
  });

  it("says the same in Spanish, in the informal register", () => {
    render(<LanguageProvider lang="es"><GuidedNavToggle guide={guided} showAll={false} hiddenCount={3} onToggle={vi.fn()} /></LanguageProvider>);
    const note = screen.getByText(/Mostrando lo esencial/);
    expect(note.textContent).toContain("hasta que termines tus pasos de incorporación en Apoyo para trabajadores > Incorporación");
    expect(note.textContent).toContain("Mostrar todo");
  });
});

describe("guided menu note for a new member with no onboarding steps (#6888)", () => {
  const DAY = 86_400_000;
  const NOW = Date.UTC(2026, 10, 3, 12);
  const daysAgo = (days) => new Date(NOW - days * DAY).toISOString();
  const noSteps = normalizeOnboardingGuide({ state: "ready", applies: false, onboardingComplete: true });
  const withSteps = normalizeOnboardingGuide({ state: "ready", applies: true, onboardingComplete: false, totalSteps: 3, completedSteps: 1 });
  const note = (guide, lang = "en") => {
    const { container, unmount } = render(<LanguageProvider lang={lang}><GuidedNavToggle guide={guide} showAll={false} hiddenCount={5} onToggle={vi.fn()} /></LanguageProvider>);
    const text = container.querySelector(".guided-nav-toggle__note")?.textContent ?? null;
    unmount();
    return text;
  };


  it("names the steps or the 14 days, whichever comes first, when steps are assigned", () => {
    const nav = withNewMemberGuidedNav(withSteps, { accountCreatedAt: daysAgo(2), memberOnly: true, now: NOW });
    expect(nav.progressiveDisclosureActive).toBe(true);
    expect(nav.newMemberWindowOnly).toBe(false);
    expect(note(nav)).toBe(`Showing the essentials until you finish your onboarding steps in Worker support > Onboarding or for your first ${NEW_MEMBER_GUIDED_NAV_DAYS} days, whichever comes first. Choose Show everything to see the full menu now.`);
    expect(note(nav, "es")).toBe("Mostrando lo esencial hasta que termines tus pasos de incorporación en Apoyo para trabajadores > Incorporación o durante tus primeros 14 días, lo que ocurra primero. Elige Mostrar todo para ver el menú completo ahora.");
    // The organization's own guided view ends only with its steps, so its note stays.
    const own = normalizeOnboardingGuide({ state: "ready", applies: true, onboardingComplete: false, progressiveDisclosureActive: true, totalSteps: 2 });
    expect(note(withNewMemberGuidedNav(own, { accountCreatedAt: daysAgo(2), memberOnly: true, now: NOW }))).toBe("Showing the essentials until you finish your onboarding steps in Worker support > Onboarding. Choose Show everything to see the full menu now.");
  });

  it("shows no note for an account older than 14 days", () => {
    const nav = withNewMemberGuidedNav(noSteps, { accountCreatedAt: daysAgo(15), memberOnly: true, now: NOW });
    expect(nav.progressiveDisclosureActive).toBe(false);
    expect(note(nav)).toBeNull();
  });
});

describe("guide list badge words", () => {
  it("reads as plain words instead of Optional / core features / Not yet", () => {
    const guides = memberFeatureGuides({ on: true, memberHat: true, memberOnly: true }).view;
    render(<LanguageProvider lang="en"><MemberGuideList guides={guides} onOpen={vi.fn()} /></LanguageProvider>);
    const first = screen.getAllByRole("button")[0];
    expect(within(first).getByText("Optional guide")).toBeInTheDocument();
    expect(within(first).getByText("A good place to start: one of the main things your role does.")).toBeInTheDocument();
    expect(within(first).getByText("Not done yet")).toBeInTheDocument();
    expect(screen.getAllByText("Another page you can use.").length).toBeGreaterThan(0);
    expect(screen.queryByText("One of this role's core features.")).not.toBeInTheDocument();
  });

  it("keeps the phone's copy of those lines equal to the shared English, with Spanish beside it", () => {
    for (const key of ["guideEngine.fg.optional", "guideEngine.fg.notYet"]) {
      expect(GUIDE_COPY_EN[key]).toBe(catalogue.en[key]);
    }
    expect(translate("es", "guideEngine.fg.optional")).toBe("Guía opcional");
    expect(translate("es", "guideEngine.fg.notYet")).toBe("Aún sin hacer");
    expect(translate("es", "guideEngine.why.r36.core")).toMatch(/tu rol/);
  });
});

describe("one Home in the member rail", () => {
  it("names the logo for the product and keeps the single Home link", () => {
    rail();
    const nav = screen.getByRole("navigation", { name: translate("en", "nav.primary") });
    const homeNamed = within(nav).queryAllByRole("button", { name: "Home" }).length + within(nav).queryAllByRole("link", { name: "Home" }).length;
    expect(homeNamed).toBe(1);
    expect(within(nav).getByRole("link", { name: "Home" })).toHaveAttribute("href", "/m");
    expect(within(nav).getByRole("button", { name: "Union Ground" })).toBeInTheDocument();
  });

  it("still sends the logo home on the member rail", () => {
    const onNavigate = vi.fn();
    rail({ onNavigate });
    within(screen.getByRole("navigation", { name: translate("en", "nav.primary") })).getByRole("button", { name: "Union Ground" }).click();
    expect(onNavigate).toHaveBeenCalledWith("today", "/m", "");
  });

  // The collapsed rail is icons only and its logo button is the Home control
  // the compact tooltip and keyboard contracts name (e2e/assurance-smoke.spec.js).
  it("keeps the logo named Home on the collapsed member rail", () => {
    window.localStorage.setItem("sg:member:m-compact:desktop-main-rail:collapsed", "true");
    try {
      rail({ memberId: "m-compact" });
      const nav = screen.getByRole("navigation", { name: translate("en", "nav.primary") });
      expect(within(nav).getByRole("button", { name: "Home", exact: true })).toBeInTheDocument();
      expect(within(nav).queryByRole("button", { name: "Union Ground" })).toBeNull();
    } finally {
      window.localStorage.clear();
    }
  });

  it("keeps the logo named Home on a staff desk, which has no Home link", () => {
    rail({ active: "committee member", activeHat: "committee member", staffPlanes: [{ key: "committee member", labelKey: "demo.hatSteward", view: "committee member", path: "/m/steward" }] });
    const nav = screen.getByRole("navigation", { name: translate("en", "nav.primary") });
    expect(within(nav).getByRole("button", { name: "Home" })).toBeInTheDocument();
    expect(within(nav).queryByRole("link", { name: "Home" })).not.toBeInTheDocument();
  });
});
