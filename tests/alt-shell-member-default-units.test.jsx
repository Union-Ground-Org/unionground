import { readFileSync } from "node:fs";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AltShell from "../src/alt/AltShell.jsx";
import { SiteViewSettingsCard } from "../src/alt/SiteViewSettingsCard.jsx";
import {
  ALT_SHELL,
  CLASSIC_SHELL,
  MEMBER_SHELL_FLAG,
  MEMBER_SHELL_STORAGE_PREFIX,
  SHELL_STORAGE_KEY,
  explicitShellChoice,
  memberShellExperimentEligible,
  readMemberShellPreference,
  resolveMemberShell,
  writeMemberShellPreference,
} from "../src/alt/altShell.js";
import { ANALYTICS_FLAGS, analyticsFlagValue } from "../src/lib/posthogPrivacy.js";
import { altShellCatalogue } from "../src/lib/i18n/altShell.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

// REQ-UG-AB-MEMBER-DEFAULT-ALT-VIEW-20261030: the member-default-view
// experiment's precedence, eligibility and per-member switch, unit by unit.
// The whole-App journeys live in tests/alt-shell-member-default.test.jsx.

const USER = "00000000-0000-4000-8000-000000000611";
const member = ({ member: fields = {}, ...rest } = {}) => ({
  roles: [], rolesUnknown: false, staffMfa: null, ...rest,
  member: { id: USER, organizationRoles: [], chapterRoles: [], ...fields },
});

function memoryStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    map,
  };
}

afterEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, "", "/");
});

describe("the member-default-view flag", () => {
  it("is registered like member-coach-mark with control as its default", () => {
    expect(MEMBER_SHELL_FLAG).toBe("member-default-view");
    expect(ANALYTICS_FLAGS[MEMBER_SHELL_FLAG]).toEqual({ default: "control", values: ["control", "alt"] });
    expect(analyticsFlagValue(null, MEMBER_SHELL_FLAG)).toBe("control");
    expect(analyticsFlagValue({ [MEMBER_SHELL_FLAG]: "alt" }, MEMBER_SHELL_FLAG)).toBe("alt");
    expect(analyticsFlagValue({ [MEMBER_SHELL_FLAG]: "test" }, MEMBER_SHELL_FLAG)).toBe("control");
  });
});

describe("resolveMemberShell", () => {
  const eligible = { eligible: true, defaultShell: CLASSIC_SHELL };

  it("lets the flag decide for an eligible member with no choice of their own", () => {
    expect(resolveMemberShell({ ...eligible, flagValue: "alt" })).toEqual({ shell: ALT_SHELL, flagDecides: true });
    expect(resolveMemberShell({ ...eligible, flagValue: "control" })).toEqual({ shell: CLASSIC_SHELL, flagDecides: true });
    // "control" is today's member view, whatever the build default is.
    expect(resolveMemberShell({ eligible: true, defaultShell: ALT_SHELL, flagValue: "control" })).toEqual({ shell: ALT_SHELL, flagDecides: true });
  });

  it("puts the query first, then the member's switch, then the device's saved choice", () => {
    expect(resolveMemberShell({ ...eligible, explicit: { shell: CLASSIC_SHELL, source: "query" }, preference: ALT_SHELL, flagValue: "alt" })).toEqual({ shell: CLASSIC_SHELL, flagDecides: false });
    expect(resolveMemberShell({ ...eligible, explicit: { shell: ALT_SHELL, source: "saved" }, preference: CLASSIC_SHELL, flagValue: "alt" })).toEqual({ shell: CLASSIC_SHELL, flagDecides: false });
    expect(resolveMemberShell({ ...eligible, explicit: { shell: ALT_SHELL, source: "saved" }, flagValue: "control" })).toEqual({ shell: ALT_SHELL, flagDecides: false });
    expect(resolveMemberShell({ ...eligible, preference: ALT_SHELL, flagValue: "control" })).toEqual({ shell: ALT_SHELL, flagDecides: false });
  });

  it("never lets the flag decide for anyone outside the experiment", () => {
    expect(resolveMemberShell({ eligible: false, flagValue: "alt", defaultShell: CLASSIC_SHELL })).toEqual({ shell: CLASSIC_SHELL, flagDecides: false });
    expect(resolveMemberShell({ eligible: false, flagValue: "alt", defaultShell: ALT_SHELL })).toEqual({ shell: ALT_SHELL, flagDecides: false });
    expect(resolveMemberShell({ eligible: false, flagValue: "alt", defaultShell: "sideways" })).toEqual({ shell: CLASSIC_SHELL, flagDecides: false });
    expect(resolveMemberShell().flagDecides).toBe(false);
  });
});

describe("memberShellExperimentEligible", () => {
  it("admits a signed-in member with no role outside the demo", () => {
    expect(memberShellExperimentEligible({ signedIn: true, demo: false, data: member() })).toBe(true);
    expect(memberShellExperimentEligible({ signedIn: true, demo: false, data: member({ roles: ["member"] }) })).toBe(true);
  });

  it.each([
    ["signed out", { signedIn: false, demo: false, data: member() }],
    ["the demo", { signedIn: true, demo: true, data: member() }],
    ["no member yet", { signedIn: true, demo: false, data: null }],
    ["an unknown roles read", { signedIn: true, demo: false, data: member({ rolesUnknown: true }) }],
    ["a staff role", { signedIn: true, demo: false, data: member({ roles: ["steward"] }) }],
    ["an organization-wide role", { signedIn: true, demo: false, data: member({ member: { organizationRoles: ["admin"] } }) }],
    ["a chapter role", { signedIn: true, demo: false, data: member({ member: { chapterRoles: ["steward"] } }) }],
    ["staff roles suspended for two-step sign-in", { signedIn: true, demo: false, data: member({ staffMfa: { blocked: true } }) }],
  ])("keeps %s out of the experiment", (_label, input) => {
    expect(memberShellExperimentEligible(input)).toBe(false);
  });
});

describe("the member's own switch", () => {
  it("is stored under the member and retires the device's saved query choice", () => {
    const storage = memoryStorage({ [SHELL_STORAGE_KEY]: ALT_SHELL });
    expect(readMemberShellPreference(USER, storage)).toBeNull();
    expect(writeMemberShellPreference(USER, CLASSIC_SHELL, storage)).toBe(true);
    expect(storage.map.get(`${MEMBER_SHELL_STORAGE_PREFIX}${USER}`)).toBe(CLASSIC_SHELL);
    expect(storage.map.has(SHELL_STORAGE_KEY)).toBe(false);
    expect(readMemberShellPreference(USER, storage)).toBe(CLASSIC_SHELL);
    expect(readMemberShellPreference("someone-else", storage)).toBeNull();
  });

  it("refuses a missing member, an unknown shell, unreadable storage and a refused write", () => {
    const storage = memoryStorage({ [`${MEMBER_SHELL_STORAGE_PREFIX}${USER}`]: "sideways" });
    expect(readMemberShellPreference(USER, storage)).toBeNull();
    expect(readMemberShellPreference(null, storage)).toBeNull();
    expect(writeMemberShellPreference(null, ALT_SHELL, storage)).toBe(false);
    expect(writeMemberShellPreference(USER, "sideways", storage)).toBe(false);
    expect(writeMemberShellPreference(USER, ALT_SHELL, null)).toBe(false);
    const throwing = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => {} };
    expect(readMemberShellPreference(USER, throwing)).toBeNull();
    expect(writeMemberShellPreference(USER, ALT_SHELL, throwing)).toBe(false);
  });

  it("reads the visit's explicit choice from the query (saved) or the device", () => {
    const storage = memoryStorage();
    expect(explicitShellChoice({ search: "", storage })).toBeNull();
    expect(explicitShellChoice({ search: "?shell=alt", storage })).toEqual({ shell: ALT_SHELL, source: "query" });
    expect(storage.map.get(SHELL_STORAGE_KEY)).toBe(ALT_SHELL);
    expect(explicitShellChoice({ search: "?shell=odd", storage })).toEqual({ shell: ALT_SHELL, source: "saved" });
    window.history.replaceState({}, "", "/m?shell=classic");
    expect(explicitShellChoice()).toEqual({ shell: CLASSIC_SHELL, source: "query" });
  });
});

const inLanguage = (lang, node) => <LanguageProvider lang={lang}>{node}</LanguageProvider>;

describe("SiteViewSettingsCard", () => {
  it("renders nothing without a switch to offer", () => {
    const { container } = render(inLanguage("en", <SiteViewSettingsCard siteView={null} />));
    expect(container).toBeEmptyDOMElement();
  });

  it("offers the new view from the classic view and the way back from the new one", () => {
    const onChange = vi.fn();
    const { rerender } = render(inLanguage("en", <SiteViewSettingsCard siteView={{ alt: false, onChange }} />));
    expect(screen.getByRole("heading", { name: "Site view" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try the new view" }));
    expect(onChange).toHaveBeenLastCalledWith(true);
    rerender(inLanguage("es", <SiteViewSettingsCard siteView={{ alt: true, onChange }} />));
    expect(screen.getByRole("heading", { name: "Vista del sitio" })).toBeInTheDocument();
    const back = screen.getByRole("button", { name: "Cambiar a la vista clásica" });
    expect(back).toHaveAccessibleDescription(/Estás usando la vista nueva/);
    fireEvent.click(back);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });
});

describe("AltShell switch back to classic", () => {
  const realMatchMedia = window.matchMedia;
  beforeEach(() => {
    window.matchMedia = vi.fn(() => ({ matches: true, media: "", addEventListener: () => {}, removeEventListener: () => {} }));
  });
  afterEach(() => { window.matchMedia = realMatchMedia; });

  const props = (overrides) => ({ active: "today", activePath: "/m", onNavigate: vi.fn(), user: { initials: "TM", name: "Taylor Member", onProfile: vi.fn() }, ...overrides });

  it("offers the member's switch in the side nav and the footer instead of the query link", () => {
    const onSwitchShell = vi.fn();
    render(inLanguage("en", <AltShell {...props({ onSwitchShell })}><p>page</p></AltShell>));
    fireEvent.click(within(document.getElementById("ug-side")).getByRole("button", { name: "Switch to classic view" }));
    fireEvent.click(within(document.getElementById("ug-ftr")).getByRole("button", { name: "Switch to classic view" }));
    expect(onSwitchShell).toHaveBeenCalledTimes(2);
    expect(within(document.getElementById("ug-ftr")).queryByRole("link", { name: "Switch to the classic site" })).toBeNull();
  });

  it("keeps the query link when there is no member switch", () => {
    render(inLanguage("en", <AltShell {...props()}><p>page</p></AltShell>));
    expect(within(document.getElementById("ug-side")).queryByRole("button", { name: "Switch to classic view" })).toBeNull();
    expect(within(document.getElementById("ug-ftr")).getByRole("link", { name: "Switch to the classic site" })).toBeInTheDocument();
  });
});

describe("strings and targets", () => {
  it("adds every new string in English and Spanish", () => {
    const added = ["altShell.switchToClassic", "altShell.switchToAlt", "altShell.siteViewTitle", "altShell.siteViewBodyAlt", "altShell.siteViewBodyClassic"];
    for (const key of added) {
      expect(altShellCatalogue.en[key], key).toBeTruthy();
      expect(altShellCatalogue.es[key], key).toBeTruthy();
      expect(altShellCatalogue.es[key], key).not.toBe(altShellCatalogue.en[key]);
    }
  });

  it("gives both switches a 52px target", () => {
    const shell = readFileSync("src/alt/styles/shell.css", "utf8");
    expect(shell).toMatch(/\.ugalt \.ug-side-foot \.ug-shell-switch,\s*\.ugalt \.ug-ftr \.ug-ftr-switch \{ min-height: 52px; \}/);
    expect(readFileSync("src/styles.css", "utf8")).toMatch(/\.site-view-switch \{ min-height: 52px; \}/);
  });
});
