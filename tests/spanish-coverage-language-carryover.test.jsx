// REQ-UG-SPANISH-COVERAGE-AND-LANGUAGE-CARRYOVER-20261030: the Spanish
// view left seeded tier and role names in English and said "sombrero" for a
// hat, and a member's language choice became the device's, so the next
// account on the same computer saw sign-in and verification-code pages in it.
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { parse } from "@babel/parser";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accountLanguage, accountTag, rememberAccountLanguage } from "../src/lib/accountLanguage.js";
import { catalogue } from "../src/lib/i18n/allLanguages.js";
import { t } from "../src/lib/i18n.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { seededRoleLine, seededTierName } from "../src/lib/seededLabels.js";
import { StaffAuthoringContext, StaffAuthoringHint } from "../src/components/StaffAuthoringHint.jsx";
import { RewardsView } from "../src/views/RewardsView.jsx";

const es = (key, vars) => t("es", key, vars);
const en = (key, vars) => t("en", key, vars);

describe("seeded tier and role names", () => {
  it.each([
    ["Member", "Trabajador"], ["Backer", "Colaborador"], ["Organizer", "Organizador"],
    ["Steward-Ready", "Listo para miembro del comité"], ["Architect", "Arquitecto"], [" Backer ", "Colaborador"],
  ])("shows the seeded tier %s in Spanish as %s", (name, spanish) => {
    expect(seededTierName(name, es)).toBe(spanish);
    const english = { Member: "Worker", "Steward-Ready": "Committee member-Ready" };
    expect(seededTierName(name, en)).toBe(english[name.trim()] || name.trim());
  });

  it("shows a name an organization typed as written", () => {
    expect(seededTierName("Quarry Crew", es)).toBe("Quarry Crew");
    expect(seededTierName("backer", es)).toBe("backer");
    for (const value of [null, undefined, ""]) expect(seededTierName(value, es)).toBe(value);
  });

  it("translates only the seeded role line", () => {
    expect(seededRoleLine("Member", es)).toBe("Trabajador");
    expect(seededRoleLine("Member", en)).toBe("Worker");
    expect(seededRoleLine("Direct support professional", es)).toBe("Direct support professional");
    expect(seededRoleLine(null, es)).toBeNull();
  });

  it("declares every seeded label in English and Spanish", () => {
    const keys = (lang) => Object.keys(catalogue[lang]).filter((key) => key.startsWith("seededLabels.")).sort();
    expect(keys("en")).toHaveLength(6);
    expect(keys("es")).toEqual(keys("en"));
  });


});

describe("hat wording in Spanish", () => {
  it("offers the staff role without the word sombrero", () => {
    const wearHat = vi.fn();
    render(createElement(LanguageProvider, { lang: "es" },
      createElement(StaffAuthoringContext.Provider, { value: { hats: ["coordinator"], wearHat } },
        createElement(StaffAuthoringHint, { item: "library" }))));
    const button = screen.getByRole("button", { name: /^Actuar aquí como / });
    expect(button).toHaveTextContent(`Actuar aquí como ${es("demo.hatCoordinator")}`);
    for (const [key, value] of Object.entries(catalogue.es)) expect(value, key).not.toMatch(/sombrero/i);
  });
});

describe("language carryover between accounts on one device", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => {
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("reads a member's language back only for that account", () => {
    rememberAccountLanguage("member-a", "es");
    expect(accountLanguage("member-a")).toBe("es");
    expect(accountLanguage("member-b")).toBeNull();
    expect(accountLanguage(null)).toBeNull();
    expect(window.localStorage.getItem("sg-lang")).toBeNull();
    rememberAccountLanguage("member-b", "en");
    expect(accountLanguage("member-a")).toBeNull();
    expect(accountLanguage("member-b")).toBe("en");
  });

  it("keeps no account id on the device and ignores what it cannot use", () => {
    rememberAccountLanguage("8d3f1c2e-0000-4000-8000-000000000001", "es");
    expect(window.localStorage.getItem("sg-lang-account")).not.toContain("8d3f1c2e");
    expect(accountTag("member-a")).toMatch(/^[0-9a-f]{8}$/);
    expect(accountTag("member-a")).toBe(accountTag("member-a"));
    expect(accountTag("member-a")).not.toBe(accountTag("member-b"));
    rememberAccountLanguage("member-a", "fr");
    rememberAccountLanguage("", "es");
    expect(accountLanguage("member-a")).toBeNull();
    window.localStorage.setItem("sg-lang-account", "{not json");
    expect(accountLanguage("member-a")).toBeNull();
    window.localStorage.setItem("sg-lang-account", JSON.stringify({ account: accountTag("member-a"), lang: "fr" }));
    expect(accountLanguage("member-a")).toBeNull();
  });

  it("survives blocked or missing storage", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(() => rememberAccountLanguage("member-a", "es")).not.toThrow();
    expect(accountLanguage("member-a")).toBeNull();
    const throwing = { get localStorage() { throw new Error("denied"); } };
    expect(() => rememberAccountLanguage("member-a", "es", throwing)).not.toThrow();
    expect(accountLanguage("member-a", throwing)).toBeNull();
    expect(accountLanguage("member-a", null)).toBeNull();
  });

  describe("App wiring", () => {
    const appSource = readFileSync("src/App.jsx", "utf8");
    const appAst = parse(appSource, { sourceType: "module", plugins: ["jsx"] });
    const find = (node, predicate) => {
      if (!node || typeof node !== "object") return null;
      if (predicate(node)) return node;
      for (const [key, value] of Object.entries(node)) {
        if (key === "loc") continue;
        for (const child of Array.isArray(value) ? value : [value]) {
          const match = find(child, predicate);
          if (match) return match;
        }
      }
      return null;
    };
    const declared = (name) => find(appAst, (node) => node.type === "VariableDeclarator" && node.id?.name === name).init;
    // eslint-disable-next-line no-new-func -- evaluates source extracted from the module under test
    const evaluate = (node, deps) => new Function(...Object.keys(deps), `return (${appSource.slice(node.start, node.end)});`)(...Object.values(deps));

    it("shows the verification-code page in this account's language, never another's", () => {
      const requested = declared("requestedLang");
      // Settings not loaded yet (the verification-code page): the account's own language.
      expect(evaluate(requested, { visitorLanguage: false, data: null, signedInLang: "es", bootLang: "en" })).toBe("es");
      // Another account on this device: no slot for it, so the device's own choice.
      expect(evaluate(requested, { visitorLanguage: false, data: null, signedInLang: null, bootLang: "en" })).toBe("en");
      // Saved settings win once loaded; fixture demo stays on the device choice.
      expect(evaluate(requested, { visitorLanguage: false, data: { member: { language: "en" } }, signedInLang: "es", bootLang: "es" })).toBe("en");
      expect(evaluate(requested, { visitorLanguage: true, data: { member: { language: "en" } }, signedInLang: "es", bootLang: "es" })).toBe("es");
      expect(appSource).toMatch(/const signedInLang = useMemo\(\(\) => \(visitorLanguage \? null : accountLanguage\(languageUserId\)\)/);
    });

    it("keeps a signed-in member's language change off the device's sg-lang", () => {
      const showLanguage = declared("showLanguage");
      const changeBootLanguage = vi.fn();
      let attempts = 0;
      const setLanguageAttempt = (advance) => { attempts = advance(attempts); };
      evaluate(showLanguage, { fixtureDemo: false, changeBootLanguage, setLanguageAttempt })("es");
      expect(changeBootLanguage).not.toHaveBeenCalled();
      expect(attempts).toBe(1);
      expect(window.localStorage.getItem("sg-lang")).toBeNull();
      evaluate(showLanguage, { fixtureDemo: true, changeBootLanguage, setLanguageAttempt })("es");
      expect(changeBootLanguage).toHaveBeenCalledWith("es");
    });

    it("remembers the saved language for the signed-in account only", () => {
      expect(appSource).toContain("if (!visitorLanguage && languageUserId && data?.member?.id === languageUserId) rememberAccountLanguage(languageUserId, saved);");
      const handleLanguage = find(appAst, (node) => node.type === "FunctionDeclaration" && node.id?.name === "handleLanguage");
      // A shared demo person is the one exception (#9776): the visitor's choice
      // is the device's, so only that branch may write sg-lang.
      const body = appSource.slice(handleLanguage.start, handleLanguage.end);
      const sharedBranch = body.slice(body.indexOf("if (sharedPersonaSession) {"), body.indexOf("return memberOperation.run("));
      expect(body.replace(sharedBranch, "")).not.toMatch(/changeBootLanguage\((next|previous)\)/);
    });

    // #9776 (demo walk of Nov 24, 2026): the shared Steward demo account had
    // Espanol saved, so every English visitor who switched to Steward got the
    // whole site in Spanish, and a language chosen in the demo was saved on
    // the shared account for the next visitor.
    describe("a shared demo person's saved language", () => {
      it("never overrides the visitor's own choice across a role switch", () => {
        const visitor = declared("visitorLanguage");
        expect(evaluate(visitor, { fixtureDemo: false, sharedPersonaSession: true })).toBe(true);
        expect(evaluate(visitor, { fixtureDemo: true, sharedPersonaSession: false })).toBe(true);
        // A signed-in SAMPLE organization account is its own person: its saved language holds.
        expect(evaluate(visitor, { fixtureDemo: false, sharedPersonaSession: false })).toBe(false);
        const requested = declared("requestedLang");
        // English visitor switches to the Steward persona, which has Spanish saved.
        expect(evaluate(requested, { visitorLanguage: true, data: { member: { language: "es" } }, signedInLang: null, bootLang: "en" })).toBe("en");
        // Spanish visitor switches to a persona with English saved.
        expect(evaluate(requested, { visitorLanguage: true, data: { member: { language: "en" } }, signedInLang: null, bootLang: "es" })).toBe("es");
        const signedIn = declared("signedInLang");
        expect(appSource.slice(signedIn.start, signedIn.end)).toContain("visitorLanguage ? null");
      });

      it("keeps a language change in the demo on the visitor's device, never on the shared account", () => {
        const handleLanguage = find(appAst, (node) => node.type === "FunctionDeclaration" && node.id?.name === "handleLanguage");
        const shared = find(handleLanguage, (node) => node.type === "IfStatement" && node.test.type === "Identifier" && node.test.name === "sharedPersonaSession");
        expect(shared).not.toBeNull();
        expect(shared.start).toBeLessThan(find(handleLanguage, (node) => node.type === "CallExpression" && node.callee.type === "MemberExpression" && node.callee.property.name === "run").start);
        const changeBootLanguage = vi.fn();
        const setNotice = vi.fn();
        const updateMemberSettings = vi.fn();
        // eslint-disable-next-line no-new-func -- evaluates source extracted from the module under test
        const branch = new Function("sharedPersonaSession", "next", "changeBootLanguage", "setNotice", "tr", "updateMemberSettings", `${appSource.slice(shared.start, shared.end)}\nreturn "saved";`);
        expect(branch(false, "es", changeBootLanguage, setNotice, (key) => key, updateMemberSettings)).toBe("saved");
        expect(changeBootLanguage).not.toHaveBeenCalled();
        expect(branch(true, "es", changeBootLanguage, setNotice, (key) => key, updateMemberSettings)).toBeUndefined();
        expect(changeBootLanguage).toHaveBeenCalledWith("es");
        expect(setNotice).toHaveBeenCalledWith("toast.languageUpdated");
        expect(updateMemberSettings).not.toHaveBeenCalled();
        expect(appSource.slice(shared.start, shared.end)).not.toMatch(/updateMemberSettings|mutate\(/);
      });
    });
  });
});
