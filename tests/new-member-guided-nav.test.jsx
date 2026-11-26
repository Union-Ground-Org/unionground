// UX-UG-WEB-NAVIGATION-TOO-MANY-DESTINATIONS-20261018: a member's
// first 14 days get the guided core navigation whether or not the
// organization wrote onboarding steps; the Site guide leads Account; Dues and
// the membership card no longer share one glyph.
import { plan } from "../src/features/onboardingGuideEngine/engine.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DesktopRail } from "../src/components/DesktopRail.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { FEATURE_GROUPS } from "../src/lib/mobileNav.js";
import { INACTIVE_GUIDE, NEW_MEMBER_GUIDED_NAV_DAYS, memberOnlyAccount, normalizeOnboardingGuide, withNewMemberGuidedNav } from "../src/lib/onboardingGuide.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 20, 12);
const daysAgo = (days) => new Date(NOW - days * DAY).toISOString();
// What get_member_onboarding_guide answers for an organization with no steps.
const NO_STEPS = normalizeOnboardingGuide({ state: "ready", applies: false, memberOnly: true, programConfigured: false, onboardingComplete: true });

describe("new-member guided navigation", () => {
  it("turns the guided view on for a member's first 14 days when the organization has no guide", () => {
    expect(NEW_MEMBER_GUIDED_NAV_DAYS).toBe(14);
    for (const guide of [INACTIVE_GUIDE, NO_STEPS, null]) {
      expect(withNewMemberGuidedNav(guide, { accountCreatedAt: daysAgo(0), memberOnly: true, now: NOW }).progressiveDisclosureActive).toBe(true);
      expect(withNewMemberGuidedNav(guide, { accountCreatedAt: daysAgo(13.9), memberOnly: true, now: NOW }).progressiveDisclosureActive).toBe(true);
      expect(withNewMemberGuidedNav(guide, { accountCreatedAt: daysAgo(14), memberOnly: true, now: NOW }).progressiveDisclosureActive).toBe(false);
    }
  });

  it("keeps the full list for staff, unknown or future creation times, and a member who finished the organization's checklist", () => {
    const recent = daysAgo(2);
    expect(withNewMemberGuidedNav(INACTIVE_GUIDE, { accountCreatedAt: recent, memberOnly: false, now: NOW })).toBe(INACTIVE_GUIDE);
    expect(withNewMemberGuidedNav(INACTIVE_GUIDE, { accountCreatedAt: null, memberOnly: true, now: NOW })).toBe(INACTIVE_GUIDE);
    expect(withNewMemberGuidedNav(INACTIVE_GUIDE, { accountCreatedAt: "not a date", memberOnly: true, now: NOW })).toBe(INACTIVE_GUIDE);
    expect(withNewMemberGuidedNav(INACTIVE_GUIDE, { accountCreatedAt: daysAgo(-1), memberOnly: true, now: NOW })).toBe(INACTIVE_GUIDE);
    const finished = { ...INACTIVE_GUIDE, applies: true, onboardingComplete: true, progressiveDisclosureActive: false };
    expect(withNewMemberGuidedNav(finished, { accountCreatedAt: recent, memberOnly: true, now: NOW })).toBe(finished);
    // The organization's own guided view is never replaced.
    const own = { ...INACTIVE_GUIDE, applies: true, onboardingComplete: false, progressiveDisclosureActive: true, spotlight: "member-support" };
    expect(withNewMemberGuidedNav(own, { accountCreatedAt: daysAgo(30), memberOnly: true, now: NOW })).toBe(own);
    expect(withNewMemberGuidedNav(INACTIVE_GUIDE)).toBe(INACTIVE_GUIDE);
  });

  // BUG-UG-ESTABLISHED-MEMBER-BADGED-NEW-MEMBER-20261106 (#7279).
  it("keeps the full list for an established member with a recent account", () => {
    const established = normalizeOnboardingGuide({ state: "ready", applies: false, memberOnly: true, programConfigured: true, enrolled: false, establishedMember: true, onboardingComplete: false });
    expect(established).toMatchObject({ applies: false, establishedMember: true, progressiveDisclosureActive: false, showHud: false, badge: null });
    expect(withNewMemberGuidedNav(established, { accountCreatedAt: daysAgo(1), memberOnly: true, now: NOW })).toBe(established);
    const newMember = normalizeOnboardingGuide({ state: "ready", applies: false, memberOnly: true, programConfigured: true, enrolled: false, establishedMember: false, onboardingComplete: false });
    expect(withNewMemberGuidedNav(newMember, { accountCreatedAt: daysAgo(1), memberOnly: true, now: NOW }).progressiveDisclosureActive).toBe(true);
  });

  it("treats only an account with no known staff role as member only", () => {
    expect(memberOnlyAccount({ roles: [] })).toBe(true);
    expect(memberOnlyAccount({ roles: ["member"] })).toBe(true);
    expect(memberOnlyAccount({})).toBe(true);
    expect(memberOnlyAccount({ roles: ["member", "steward"] })).toBe(false);
    expect(memberOnlyAccount({ roles: [], rolesUnknown: true })).toBe(false);
    expect(memberOnlyAccount({ roles: [], staffMfa: { blocked: true } })).toBe(false);
    expect(memberOnlyAccount(null)).toBe(false);
  });

  it("reduces the rail to core items with Show everything for a new member of an organization without steps", () => {
    const guide = withNewMemberGuidedNav(NO_STEPS, { accountCreatedAt: daysAgo(1), memberOnly: true, now: NOW });
    const onToggle = vi.fn();
    render(
      <LanguageProvider lang="en">
        <DesktopRail active="today" activeHat="member" demo={false} memberId="member-a" onAsk={() => {}} onNavigate={() => {}}
          renderMode="desktop" guide={guide} guideShowAll={false} onGuideShowAllChange={onToggle} siteGuide />
      </LanguageProvider>,
    );
    const rail = screen.getByRole("navigation", { name: "Primary" });
    expect(within(rail).queryByRole("link", { name: /Voting/ })).toBeNull();
    expect(within(rail).getByRole("link", { name: "Worker support" })).toBeInTheDocument();
    expect(within(rail).getByRole("link", { name: "Site guide" })).toBeInTheDocument();
    fireEvent.click(within(rail).getByRole("button", { name: /Show everything \(\d+ more\)/ }));
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("feeds that guide to the rail and the phone menu, never the organization's guide card", () => {
    // Since port step 2 (REQ-UG-ONBOARDING-GUIDE-ENGINE-PORT-STEP2-20261023)
    // the guide engine applies withNewMemberGuidedNav to the same inputs: the
    // navigation reads plan().nav.guide, the card plan().card (the
    // organization's guide only).
    const app = readFileSync(resolve("src/App.jsx"), "utf8");
    expect(app).toMatch(/who: \{ memberOnlyAccount: memberOnlyAccount\(data\), accountCreatedAt: demoActive \? null : session\?\.user\?\.created_at \?\? null \}/);
    expect(app).toContain("const navGuide = guideView.nav.guide;");
    expect(app.match(/guide=\{navGuide\}/g)).toHaveLength(2);
    expect(app).toContain("<OnboardingHud card={guideView.card}");
    const view = plan({ now: Date.UTC(2026, 9, 19, 13), hat: "member", switches: null, guide: null, who: { memberOnlyAccount: true, accountCreatedAt: "2026-10-15T12:00:00Z" } });
    expect(view.nav.guide.progressiveDisclosureActive).toBe(true);
    expect(view.card).toBeNull();
  });
});

describe("Account order and glyphs", () => {
  it("puts the Site guide first in the phone menu's Account group", () => {
    const account = FEATURE_GROUPS.find((group) => group.key === "account");
    expect(account.items[0].key).toBe("site-guide");
    expect(account.items.filter((item) => item.key === "site-guide")).toHaveLength(1);
  });

  // Union Ground's Dues and membership-card glyph case is not taken:
  // Union Ground has neither destination (dues and the card were removed, D5).
});
