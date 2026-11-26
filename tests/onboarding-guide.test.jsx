// REQ-UG-PROGRESSIVE-DISCLOSURE-AND-FEATURE-DRIP-20261001: the member
// onboarding guide on web (stage card, guided navigation with a visible escape
// hatch, next-step spotlight, badges) driven only by the server payload.
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DesktopRail } from "../src/components/DesktopRail.jsx";
import { MobileCardNav } from "../src/components/MobileCardNav.jsx";
import { OnboardingHud } from "../src/components/OnboardingHud.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import {
  INACTIVE_GUIDE,
  ONBOARDING_CORE_NAV_KEYS,
  ONBOARDING_GUIDE_REFRESH_EVENT,
  ONBOARDING_GUIDE_SWITCH_KEYS,
  guidedNavItems,
  hiddenGuidedNavCount,
  loadMemberOnboardingGuide,
  normalizeOnboardingGuide,
  onboardingGuideSwitchesOn,
  onboardingHudCopy,
  readGuideShowAll,
  readGuideShowAllChoice,
  spotlightNavItem,
  withNewMemberGuidedNav,
} from "../src/lib/onboardingGuide.js";
import { GUIDE_RECONNECT_RETRY_LIMIT, useMemberOnboardingGuide } from "../src/lib/useMemberOnboardingGuide.js";

const READY = Object.freeze({
  state: "ready",
  applies: true,
  memberOnly: true,
  programConfigured: true,
  enrolled: true,
  totalSteps: 6,
  completedSteps: 1,
  onboardingComplete: false,
  progressiveDisclosureActive: true,
  stage: "welcome",
  nextStep: { id: "step-2", title: "Meet your committee contact" },
  featureDrip: true,
  showHud: true,
  spotlight: "member-support",
  badge: "new_member",
  switches: { featureDrip: true, hudTooltips: true, spotlight: true, progressiveDisclosure: true, badgeAchievements: true },
});

beforeEach(() => {
  window.localStorage.clear();
});

describe("onboarding guide payload", () => {
  it("fails closed to no guide for anything but a ready, applicable payload", () => {
    expect(normalizeOnboardingGuide(null)).toMatchObject({ applies: false, progressiveDisclosureActive: false, showHud: false });
    expect(normalizeOnboardingGuide({ state: "unavailable", applies: false })).toMatchObject({ applies: false, onboardingComplete: null });
    expect(normalizeOnboardingGuide({ ...READY, applies: false, onboardingComplete: false })).toMatchObject({
      applies: false,
      onboardingComplete: false,
      progressiveDisclosureActive: false,
    });
    expect(normalizeOnboardingGuide({ ...READY, spotlight: "admin", badge: "gold", completedSteps: 99 })).toMatchObject({
      spotlight: null,
      badge: null,
      completedSteps: 6,
    });
  });

  it("never keeps the guided navigation for a complete member", () => {
    expect(normalizeOnboardingGuide({ ...READY, onboardingComplete: true, stage: "complete" }).progressiveDisclosureActive).toBe(false);
  });

  it("asks the server only when a guide switch is on in the member configuration", () => {
    expect(onboardingGuideSwitchesOn(null)).toBe(false);
    expect(onboardingGuideSwitchesOn({ switches: {} })).toBe(false);
    expect(onboardingGuideSwitchesOn({ switches: { [ONBOARDING_GUIDE_SWITCH_KEYS[0]]: "true" } })).toBe(false);
    expect(onboardingGuideSwitchesOn({ switches: { "features.guidance_onboarding.spotlight": true } })).toBe(true);
  });

  it("loads through the one read-only RPC and surfaces errors to the caller", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: READY, error: null });
    await expect(loadMemberOnboardingGuide({ rpc })).resolves.toMatchObject({ applies: true, stage: "welcome" });
    expect(rpc).toHaveBeenCalledWith("get_member_onboarding_guide");
    await expect(loadMemberOnboardingGuide({ rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "42501" } }) })).rejects.toMatchObject({ code: "42501" });
  });

  it("stages the card copy like the old HUD, with feature drip changing the titles", () => {
    const guide = normalizeOnboardingGuide(READY);
    expect(onboardingHudCopy(guide)).toMatchObject({ titleKey: "onboardingGuide.welcomeTitleDrip", target: { view: "memberSupport", path: "/m/support/onboarding" } });
    expect(onboardingHudCopy({ ...guide, featureDrip: false }).titleKey).toBe("onboardingGuide.welcomeTitle");
    expect(onboardingHudCopy({ ...guide, stage: "activate" }).titleKey).toBe("onboardingGuide.activateTitleDrip");
    expect(onboardingHudCopy({ ...guide, enrolled: false }).ctaKey).toBe("onboardingGuide.startOnboarding");
    expect(onboardingHudCopy({ ...guide, stage: "complete" })).toMatchObject({ bodyKey: "onboardingGuide.completeBodyNavigation", target: { view: "events" } });
    expect(onboardingHudCopy(INACTIVE_GUIDE)).toBeNull();
  });

  it("keeps only the core destinations while guided, and everything once the member asks", () => {
    const guide = normalizeOnboardingGuide(READY);
    const items = [{ key: "today" }, { key: "voting" }, { key: "member-support" }, { key: "rewards" }, { key: "settings" }];
    expect(guidedNavItems(items, guide).map((item) => item.key)).toEqual(["today", "member-support", "settings"]);
    expect(guidedNavItems(items, guide, true)).toBe(items);
    expect(guidedNavItems(items, INACTIVE_GUIDE)).toBe(items);
    expect(hiddenGuidedNavCount([items], guide)).toBe(2);
    expect(ONBOARDING_CORE_NAV_KEYS).toContain("member-support");
  });

  // BUG-UG-GUIDED-NAV-HIDES-SITE-GUIDE-20261018: the guided view used
  // to drop "How to use this site" from web navigation.
  it("keeps the site guide in the guided navigation", () => {
    const guide = normalizeOnboardingGuide(READY);
    expect(ONBOARDING_CORE_NAV_KEYS).toContain("site-guide");
    const account = [{ key: "notifications" }, { key: "site-guide" }, { key: "voting" }, { key: "settings" }];
    expect(guidedNavItems(account, guide).map((item) => item.key)).toEqual(["notifications", "site-guide", "settings"]);
    expect(hiddenGuidedNavCount([account], guide)).toBe(1);
  });

  it("ships every guide string in English and Spanish", () => {
    const keys = Object.keys(catalogue.en).filter((key) => key.startsWith("onboardingGuide.") || key.startsWith("settings.def.features.guidance_onboarding."));
    expect(keys.length).toBeGreaterThanOrEqual(35);
    for (const key of keys) expect(catalogue.es[key], key).toEqual(expect.any(String));
  });
});

describe("onboarding guide card", () => {
  function renderHud(payload, props = {}) {
    return render(
      <LanguageProvider lang="en">
        <OnboardingHud guide={normalizeOnboardingGuide(payload)} memberId="member-a" onNavigate={props.onNavigate ?? (() => {})} />
      </LanguageProvider>,
    );
  }

  it("shows the stage, the next real step, progress and the badge", () => {
    const onNavigate = vi.fn();
    renderHud(READY, { onNavigate });
    const card = screen.getByRole("complementary", { name: "Start with one clear next step" });
    expect(within(card).getByText("Next step: Meet your committee contact")).toBeInTheDocument();
    expect(within(card).getByText("New Worker")).toBeInTheDocument();
    expect(within(card).getByRole("progressbar", { name: "Onboarding progress" })).toHaveAttribute("aria-valuenow", "1");
    fireEvent.click(within(card).getByRole("button", { name: "Open onboarding" }));
    expect(onNavigate).toHaveBeenCalledWith("memberSupport", "/m/support/onboarding");
    expect(within(card).queryByRole("button", { name: "Dismiss" })).toBeNull();
  });

  it("renders nothing when the card switch is off", () => {
    const { container } = renderHud({ ...READY, showHud: false });
    expect(container).toBeEmptyDOMElement();
  });

  it("lets a finished member put the completed card away for good on this device", () => {
    renderHud({ ...READY, stage: "complete", onboardingComplete: true, completedSteps: 6, badge: "ready_to_roll", nextStep: null });
    expect(screen.getByText("Ready to Roll")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(window.localStorage.getItem("sg:member:member-a:onboarding-guide:complete-dismissed")).toBe("true");
  });

  it("speaks Spanish", () => {
    render(
      <LanguageProvider lang="es">
        <OnboardingHud guide={normalizeOnboardingGuide(READY)} memberId="member-a" onNavigate={() => {}} />
      </LanguageProvider>,
    );
    expect(screen.getByRole("complementary", { name: "Empieza con un siguiente paso claro" })).toBeInTheDocument();
    expect(screen.getByText("Siguiente paso: Meet your committee contact")).toBeInTheDocument();
  });
});

describe("guided navigation surfaces", () => {
  function renderRail(guide, props = {}) {
    const onToggle = vi.fn();
    const view = render(
      <LanguageProvider lang="en">
        <DesktopRail
          active="today"
          activeHat="member"
          demo={false}
          memberId="member-a"
          onAsk={() => {}}
          onNavigate={() => {}}
          renderMode="desktop"
          guide={guide}
          guideShowAll={false}
          onGuideShowAllChange={onToggle}
          {...props}
        />
      </LanguageProvider>,
    );
    return { ...view, onToggle };
  }

  it("reduces the member rail to core items, spotlights the checklist and offers Show everything", () => {
    const { onToggle } = renderRail(normalizeOnboardingGuide(READY));
    const rail = screen.getByRole("navigation", { name: "Primary" });
    expect(within(rail).queryByRole("link", { name: /Voting/ })).toBeNull();
    expect(within(rail).getByRole("link", { name: "Issues" })).toBeInTheDocument();
    expect(within(rail).queryByRole("link", { name: "My cases" })).toBeNull();
    expect(within(rail).getByRole("link", { name: "Worker support, Next step" })).toHaveClass("is-spotlit");
    const toggle = within(rail).getByRole("button", { name: /Show everything \(\d+ more\)/ });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("shows the full rail when the member chose Show everything", () => {
    renderRail(normalizeOnboardingGuide(READY), { guideShowAll: true });
    const rail = screen.getByRole("navigation", { name: "Primary" });
    expect(within(rail).getByRole("link", { name: /Voting/ })).toBeInTheDocument();
    expect(within(rail).getByRole("button", { name: "Show the guided view" })).toHaveAttribute("aria-pressed", "true");
  });

  it("leaves the rail untouched without a guide", () => {
    renderRail(INACTIVE_GUIDE);
    const rail = screen.getByRole("navigation", { name: "Primary" });
    expect(within(rail).getByRole("link", { name: /Voting/ })).toBeInTheDocument();
    expect(within(rail).queryByRole("button", { name: /Show everything/ })).toBeNull();
  });

  // BUG-UG-SPOTLIT-MEMBER-SUPPORT-OPENS-RIGHTS-20261018: the spotlit
  // Member support row opened the Emergency rights tab, not the checklist.
  it("links the spotlit Member support row to the onboarding checklist on the rail and the phone card", () => {
    const onNavigate = vi.fn();
    const rail = renderRail(normalizeOnboardingGuide(READY), { onNavigate });
    const railLink = within(screen.getByRole("navigation", { name: "Primary" })).getByRole("link", { name: "Worker support, Next step" });
    expect(railLink).toHaveAttribute("href", "/m/support/onboarding");
    fireEvent.click(railLink);
    expect(onNavigate).toHaveBeenCalledWith("memberSupport", "/m/support/onboarding", undefined);
    rail.unmount();
    renderRail(normalizeOnboardingGuide({ ...READY, spotlight: "events" }));
    expect(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("link", { name: "Worker support" })).toHaveAttribute("href", "/m/support");
    cleanup();
    const cardNavigate = vi.fn();
    render(
      <LanguageProvider lang="en">
        <MobileCardNav onNavigate={cardNavigate} onAsk={() => {}} guide={normalizeOnboardingGuide(READY)} guideShowAll={false} onGuideShowAllChange={() => {}}>
          <p>feed</p>
        </MobileCardNav>
      </LanguageProvider>,
    );
    const cardLink = within(document.querySelector("#card-nav-panel-features")).getByRole("link", { name: /Worker support/ });
    expect(cardLink).toHaveAttribute("href", "/m/support/onboarding");
    fireEvent.click(cardLink);
    expect(cardNavigate).toHaveBeenCalledWith("memberSupport", "/m/support/onboarding", undefined);
  });

  it("retargets only the Member support row and leaves other rows and a missing item alone", () => {
    const support = { key: "member-support", viewKey: "memberSupport", path: "/m/support" };
    expect(spotlightNavItem(support)).toEqual({ ...support, path: "/m/support/onboarding" });
    expect(support.path).toBe("/m/support");
    const events = { key: "events", path: "/m/events" };
    expect(spotlightNavItem(events)).toBe(events);
    expect(spotlightNavItem(null)).toBeNull();
    expect(spotlightNavItem(undefined)).toBeUndefined();
  });

  it("reduces the phone All features card the same way", () => {
    const onToggle = vi.fn();
    render(
      <LanguageProvider lang="en">
        <MobileCardNav onNavigate={() => {}} onAsk={() => {}} guide={normalizeOnboardingGuide(READY)} guideShowAll={false} onGuideShowAllChange={onToggle}>
          <p>feed</p>
        </MobileCardNav>
      </LanguageProvider>,
    );
    const features = document.querySelector("#card-nav-panel-features");
    // The directory row is the one guided navigation hides; the pinned Voting
    // shortcut (named Voice before #9527) is the member's own choice and stays.
    expect([...features.querySelectorAll(".morehub-row")].some((row) => /Voting/.test(row.textContent))).toBe(false);
    expect(within(features).getByRole("link", { name: /Worker support/ })).toHaveTextContent("Next step");
    fireEvent.click(within(features).getByRole("button", { name: /Show everything/ }));
    expect(onToggle).toHaveBeenCalledWith(true);
  });
});

describe("shell guide hook", () => {
  for (const lang of ["en", "es"]) {
    it.each([
      ["first-14-day guided navigation", "2026-10-22", true, false, true],
      ["older member", "2026-10-01", true, false, false],
      ["missing account age", null, true, false, false],
      ["staff account", "2026-10-22", false, false, false],
      ["member showing everything", "2026-10-22", true, true, false],
    ])(`describes the actual navigation in ${lang} for %s`, (_name, accountCreatedAt, memberOnly, showAll, guided) => {
      const navigationGuide = withNewMemberGuidedNav(INACTIVE_GUIDE, { accountCreatedAt, memberOnly, now: Date.parse("2026-10-23") });
      render(<LanguageProvider lang={lang}><OnboardingHud guide={INACTIVE_GUIDE} navigationGuide={navigationGuide} showAll={showAll} loadFailed onRetry={() => {}} /></LanguageProvider>);
      const copy = screen.getByRole("status").textContent;
      const controlName = lang === "en" ? "Show everything" : "Mostrar todo";
      if (guided) expect(copy).toContain(controlName);
      else {
        expect(copy).not.toContain(controlName);
        expect(copy).toContain(lang === "en" ? "Your full navigation is open" : "Tienes toda la navegación abierta");
      }
      const items = [{ key: "today" }, { key: "voting" }];
      expect(guidedNavItems(items, navigationGuide, showAll).length).toBe(guided ? 1 : 2);
    });
  }

  it.each(["en", "es"])("explains the first-14-day fallback and Show everything in %s after a read failure", async (lang) => {
    const client = { rpc: vi.fn().mockRejectedValue(new Error("offline")) };
    const { result } = renderHook(() => useMemberOnboardingGuide({ client, enabled: true, memberId: "new-member" }));
    await waitFor(() => expect(result.current.loadFailed).toBe(true));
    const guide = withNewMemberGuidedNav(result.current.guide, {
      memberOnly: true, accountCreatedAt: "2026-10-22", now: Date.parse("2026-10-23"),
    });
    const items = [{ key: "today" }, { key: "voting" }];
    expect(guidedNavItems(items, guide, result.current.showAll)).toEqual([{ key: "today" }]);
    render(<LanguageProvider lang={lang}><OnboardingHud guide={guide} loadFailed onRetry={result.current.retry} /></LanguageProvider>);
    const copy = screen.getByRole("status").textContent;
    expect(copy).toContain(lang === "en" ? "Show everything" : "Mostrar todo");
    expect(copy).not.toContain(lang === "en" ? "Your full navigation is open" : "Tienes toda la navegación abierta");
    act(() => result.current.setShowAll(true));
    expect(guidedNavItems(items, guide, result.current.showAll)).toEqual(items);
  });

  it.each([
    { state: "unavailable", applies: false, onboardingComplete: true },
    { state: "ready" },
  ])("does not suppress retry errors after an unconfirmed response %j", async (data) => {
    const client = { rpc: vi.fn().mockResolvedValueOnce({ data, error: null }).mockRejectedValue(new Error("offline")) };
    const { result } = renderHook(() => useMemberOnboardingGuide({ client, enabled: true, memberId: "member-a" }));
    await act(async () => {});
    act(() => result.current.retry());
    await waitFor(() => expect(client.rpc).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.loadFailed).toBe(true));
  });

  it("does not call the server while disabled, then reads, re-reads on refresh and remembers Show everything", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: READY, error: null });
    const client = { rpc };
    const { result, rerender } = renderHook((props) => useMemberOnboardingGuide(props), {
      initialProps: { client, enabled: false, memberId: "member-a", refreshKey: "today" },
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(result.current.guide).toBe(INACTIVE_GUIDE);
    rerender({ client, enabled: true, memberId: "member-a", refreshKey: "today" });
    await waitFor(() => expect(result.current.guide.applies).toBe(true));
    act(() => { window.dispatchEvent(new Event(ONBOARDING_GUIDE_REFRESH_EVENT)); });
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    act(() => result.current.setShowAll(true));
    expect(result.current.showAll).toBe(true);
    expect(readGuideShowAll("member-a")).toBe(true);
  });

  it("starts a shared sample persona on the full navigation, keeps the way back, and leaves other members guided", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: READY, error: null });
    const shared = renderHook(() => useMemberOnboardingGuide({ client: { rpc }, enabled: true, memberId: "persona-a", refreshKey: "today", showAllByDefault: true }));
    await waitFor(() => expect(shared.result.current.guide.applies).toBe(true));
    expect(shared.result.current.showAll).toBe(true);
    // Nothing is stored for the persona: the default is not a recorded choice.
    expect(readGuideShowAllChoice("persona-a")).toBeNull();
    act(() => shared.result.current.setShowAll(false));
    expect(shared.result.current.showAll).toBe(false);
    // The guided-view choice is remembered on the device: a fresh mount keeps it, and it can be undone.
    expect(readGuideShowAllChoice("persona-a")).toBe(false);
    const again = renderHook(() => useMemberOnboardingGuide({ client: { rpc }, enabled: true, memberId: "persona-a", refreshKey: "today", showAllByDefault: true }));
    expect(again.result.current.showAll).toBe(false);
    act(() => again.result.current.setShowAll(true));
    expect(readGuideShowAllChoice("persona-a")).toBe(true);
    const member = renderHook(() => useMemberOnboardingGuide({ client: { rpc }, enabled: true, memberId: "member-b", refreshKey: "today" }));
    await waitFor(() => expect(member.result.current.guide.applies).toBe(true));
    expect(member.result.current.showAll).toBe(false);
    // The shell derives the default from the live sample backend and the signed-in persona's own email.
    const appSource = (await import("node:fs")).readFileSync("src/App.jsx", "utf8");
    expect(appSource).toContain("showAllByDefault: sampleLive && samplePersonas().some((persona) => persona.email === session?.user?.email),");
  });

  it("fails open to the full navigation when the read fails", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: "PGRST202" } });
    const { result } = renderHook(() => useMemberOnboardingGuide({ client: { rpc }, enabled: true, memberId: "member-a", refreshKey: "today" }));
    await waitFor(() => expect(rpc).toHaveBeenCalled());
    expect(result.current.guide.progressiveDisclosureActive).toBe(false);
  });

  // BUG-UG-GUIDE-LOAD-FAILURE-HIDES-GUIDANCE-20261018: a rejected read
  // used to land on INACTIVE_GUIDE, which renders exactly like finished
  // onboarding. It now yields an error state that renders the retry card, and
  // a successful retry restores the guide. The client is stable, as the
  // shell's Supabase client is: a new object would re-read on every render.
  it("turns a rejected read into a retry card, and a successful retry restores the guide", async () => {
    const rpc = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue({ data: READY, error: null });
    const client = { rpc };
    const { result } = renderHook(() => useMemberOnboardingGuide({ client, enabled: true, memberId: "member-a", refreshKey: "today" }));
    await waitFor(() => expect(result.current.loadFailed).toBe(true));
    expect(result.current.guide).toBe(INACTIVE_GUIDE);
    expect(result.current.guide.progressiveDisclosureActive).toBe(false);

    const onRetry = vi.fn(() => result.current.retry());
    const view = render(
      <LanguageProvider lang="en">
        <OnboardingHud guide={result.current.guide} memberId="member-a" onNavigate={() => {}} loadFailed={result.current.loadFailed} onRetry={onRetry} />
      </LanguageProvider>,
    );
    const card = screen.getByRole("complementary", { name: "Getting started could not load" });
    expect(within(card).getByText("Your full navigation is open. Try again to see your next onboarding step.")).toBeInTheDocument();
    act(() => { fireEvent.click(within(card).getByRole("button", { name: "Try again" })); });
    expect(onRetry).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.loadFailed).toBe(false));
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(result.current.guide).toMatchObject({ applies: true, progressiveDisclosureActive: true, stage: "welcome" });
    view.rerender(
      <LanguageProvider lang="en">
        <OnboardingHud guide={result.current.guide} memberId="member-a" onNavigate={() => {}} loadFailed={result.current.loadFailed} onRetry={onRetry} />
      </LanguageProvider>,
    );
    expect(screen.queryByRole("complementary", { name: "Getting started could not load" })).toBeNull();
    expect(screen.getByRole("complementary", { name: "Start with one clear next step" })).toBeInTheDocument();
  });

  it("places the retry card like the stage card and drops the button when no retry is wired", () => {
    render(
      <LanguageProvider lang="en">
        <OnboardingHud guide={INACTIVE_GUIDE} memberId="member-a" onNavigate={() => {}} loadFailed className="onboarding-hud--home" />
      </LanguageProvider>,
    );
    const card = screen.getByRole("complementary", { name: "Getting started could not load" });
    expect(card).toHaveClass("onboarding-hud", "onboarding-hud--failed", "onboarding-hud--home");
    expect(within(card).queryByRole("button")).toBeNull();
  });

  it("ignores a failed read that settles after the shell moved on", async () => {
    let reject;
    const rpc = vi.fn().mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const client = { rpc };
    const { result, unmount } = renderHook(() => useMemberOnboardingGuide({ client, enabled: true, memberId: "member-a", refreshKey: "today" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    const before = result.current;
    unmount();
    await act(async () => { reject(new TypeError("Failed to fetch")); await Promise.resolve(); });
    expect(result.current).toBe(before);
    expect(result.current.loadFailed).toBe(false);
  });

  it("treats a server error as a failed read, not as a finished guide", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: "PGRST202" } });
    const client = { rpc };
    const { result } = renderHook(() => useMemberOnboardingGuide({ client, enabled: true, memberId: "member-a", refreshKey: "today" }));
    await waitFor(() => expect(result.current.loadFailed).toBe(true));
  });

  it("re-reads on reconnect a bounded number of times per failure streak", async () => {
    const rpc = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const client = { rpc };
    const { result } = renderHook(() => useMemberOnboardingGuide({ client, enabled: true, memberId: "member-a", refreshKey: "today" }));
    await waitFor(() => expect(result.current.loadFailed).toBe(true));
    for (let attempt = 0; attempt < GUIDE_RECONNECT_RETRY_LIMIT + 2; attempt += 1) {
      act(() => { window.dispatchEvent(new Event("online")); });
      await waitFor(() => expect(rpc).toHaveBeenCalledTimes(Math.min(attempt + 2, GUIDE_RECONNECT_RETRY_LIMIT + 1)));
    }
    expect(rpc).toHaveBeenCalledTimes(GUIDE_RECONNECT_RETRY_LIMIT + 1);
    // The Try again button is never capped.
    act(() => result.current.retry());
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(GUIDE_RECONNECT_RETRY_LIMIT + 2));
    expect(result.current.loadFailed).toBe(true);
  });

  it("shows no retry card when this member's last good read said onboarding was complete", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: { ...READY, onboardingComplete: true, stage: "complete" }, error: null })
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const client = { rpc };
    const { result } = renderHook(() => useMemberOnboardingGuide({ client, enabled: true, memberId: "member-a", refreshKey: "today" }));
    await waitFor(() => expect(result.current.guide.stage).toBe("complete"));
    act(() => result.current.retry());
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.guide).toBe(INACTIVE_GUIDE));
    expect(result.current.loadFailed).toBe(false);
  });

  it("does not carry completed onboarding into another organization after a failed read", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: { ...READY, onboardingComplete: true, stage: "complete" }, error: null })
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const client = { rpc };
    const hook = renderHook(props => useMemberOnboardingGuide(props), {
      initialProps: { client, enabled: true, memberId: "member-a", organizationId: "org-a", refreshKey: "today" },
    });
    await waitFor(() => expect(hook.result.current.guide.stage).toBe("complete"));
    hook.rerender({ client, enabled: true, memberId: "member-a", organizationId: "org-b", refreshKey: "today" });
    expect(hook.result.current.guide).toBe(INACTIVE_GUIDE);
    await waitFor(() => expect(hook.result.current.loadFailed).toBe(true));
  });

  it("wires the failure state from the shell to the guide card", async () => {
    const appSource = (await import("node:fs")).readFileSync("src/App.jsx", "utf8");
    expect(appSource).toContain("loadFailed: onboardingGuideLoadFailed,");
    expect(appSource).toContain("navigationGuide={navGuide} showAll={onboardingGuideShowAll}");
    expect(appSource).toContain("loadFailed={onboardingGuideLoadFailed} onRetry={retryOnboardingGuide}");
  });
});
