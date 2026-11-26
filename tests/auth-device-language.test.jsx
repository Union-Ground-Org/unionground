import { readFileSync } from "node:fs";
import { parse } from "@babel/parser";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthScreen } from "../src/components/AuthScreen.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { sessionIDFromAccessToken } from "../src/lib/exactSessionStorage.js";
import { bootLanguage } from "../src/lib/bootLanguage.js";

// Exercise the actual app callbacks without mounting the full member workspace
// or creating an Auth session. The fixture supplies only their external effects.
const appSource = readFileSync("src/App.jsx", "utf8");
const appAst = parse(appSource, { sourceType: "module", plugins: ["jsx"] });
function findNode(node, predicate) {
  if (!node || typeof node !== "object") return null;
  if (predicate(node)) return node;
  for (const [key, value] of Object.entries(node)) {
    if (key === "loc") continue;
    for (const child of Array.isArray(value) ? value : [value]) {
      const match = findNode(child, predicate);
      if (match) return match;
    }
  }
  return null;
}
function expression(node, dependencies = {}) {
  // eslint-disable-next-line no-new-func -- evaluates a slice of src/App.jsx under test with injected dependencies.
  return new Function(...Object.keys(dependencies), `return (${appSource.slice(node.start, node.end)});`)(...Object.values(dependencies));
}
function appFunction(name, dependencies = {}) {
  const node = findNode(appAst, (candidate) => candidate.type === "FunctionDeclaration" && candidate.id?.name === name);
  return expression(node, dependencies);
}
const changeBootLanguageNode = findNode(appAst, (node) => node.type === "VariableDeclarator" && node.id?.name === "changeBootLanguage").init.arguments[0];
// The member's requested language; useLoadedLanguage renders it once its
// catalogue is loaded (PERF-UG-WEB-SHELL-AND-PER-LANGUAGE-BUNDLES-20261011).
const memberLanguageNode = findNode(appAst, (node) => node.type === "VariableDeclarator"
  && node.id?.name === "requestedLang" && node.init?.test?.name === "visitorLanguage").init;
// Union Ground keeps the device language under its own key and reads the
// sibling product's sg-lang value only as a legacy fallback at boot.
const LANGUAGE_KEY = "unionground-lang";
const LEGACY_LANGUAGE_KEY = "sg-lang";
const navigatorLanguageDescriptor = Object.getOwnPropertyDescriptor(window.navigator, "language")
  ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(window.navigator), "language");
function browserLanguage(value) {
  Object.defineProperty(window.navigator, "language", { configurable: true, get: () => value });
}
function authView(lang, onLanguageChange) {
  return <LanguageProvider lang={lang}><AuthScreen client={{ auth: {} }} lang={lang} onLanguageChange={onLanguageChange} /></LanguageProvider>;
}

beforeEach(() => {
  window.localStorage.removeItem(LANGUAGE_KEY);
  window.localStorage.removeItem(LEGACY_LANGUAGE_KEY);
  browserLanguage("en-US");
});
afterEach(() => {
  window.localStorage.removeItem(LANGUAGE_KEY);
  window.localStorage.removeItem(LEGACY_LANGUAGE_KEY);
  if (navigatorLanguageDescriptor) Object.defineProperty(window.navigator, "language", navigatorLanguageDescriptor);
  vi.restoreAllMocks();
});

describe("signed-out device language (pilot finding 20261003)", () => {
  it.each([["en-US", "en"], ["es-MX", "es"]])("uses the %s browser locale when there is no explicit choice", (locale, expected) => {
    browserLanguage(locale);
    expect(bootLanguage()).toBe(expected);
    render(authView(bootLanguage()));
    expect(screen.getByRole("heading", { name: expected === "es" ? "Inicia sesión en Union Ground" : "Sign in to Union Ground" })).toBeInTheDocument();
  });

  // A11Y-UG-SIGNIN-LANGUAGE-BUTTONS-LANG-ATTRIBUTE-20261108: each
  // button names its language in that language, so it carries that lang.
  it.each(["en", "es"])("marks each language button with its own language on the %s page", (lang) => {
    render(authView(lang, vi.fn()));
    expect(screen.getByRole("button", { name: "English" })).toHaveAttribute("lang", "en");
    expect(screen.getByRole("button", { name: "Español" })).toHaveAttribute("lang", "es");
  });

  it("persists explicit Spanish and then English across auth-screen remounts", () => {
    let selected = bootLanguage();
    let attempts = 0;
    const changeLanguage = expression(changeBootLanguageNode, {
      window, setBootLang: (next) => { selected = next; }, setLanguageAttempt: (advance) => { attempts = advance(attempts); },
    });
    const first = render(authView(selected, changeLanguage));
    fireEvent.click(screen.getByRole("button", { name: "Español" }));
    first.rerender(authView(selected, changeLanguage));
    expect(screen.getByRole("heading", { name: "Inicia sesión en Union Ground" })).toBeInTheDocument();
    expect(window.localStorage.getItem(LANGUAGE_KEY)).toBe("es");
    // every selection is a fresh load attempt, so a failed catalogue retries
    expect(attempts).toBe(1);
    first.unmount();
    const reloaded = render(authView(bootLanguage(), changeLanguage));
    expect(screen.getByRole("button", { name: "Español" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "English" }));
    reloaded.unmount();
    render(authView(bootLanguage(), changeLanguage));
    expect(window.localStorage.getItem(LANGUAGE_KEY)).toBe("en");
    expect(screen.getByRole("heading", { name: "Sign in to Union Ground" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "English" })).toHaveAttribute("aria-pressed", "true");
  });

  it.each([["es", "en", "Inicia sesión en Union Ground"], ["en", "es", "Sign in to Union Ground"]])(
    "preserves explicit device %s after signing out a member whose saved language is %s",
    async (deviceChoice, memberLanguage, heading) => {
      window.localStorage.setItem(LANGUAGE_KEY, deviceChoice);
      let data = { member: { language: memberLanguage } };
      expect(expression(memberLanguageNode, { visitorLanguage: false, data, bootLang: bootLanguage() })).toBe(memberLanguage);
      expect(window.localStorage.getItem(LANGUAGE_KEY)).toBe(deviceChoice);
      const capturedSession = { user: { id: "synthetic-member" } };
      const sessionRef = { current: capturedSession };
      const operation = { isCurrent: () => true };
      const setSession = vi.fn();
      const setLoading = vi.fn();
      const setAuthRestorePending = vi.fn();
      const setNotice = vi.fn();
      const signOutSafely = vi.fn(async (_client, options) => { await options.onLocalSessionCleared(); });
      // Sign-out forgets the chapter-notice colours read
      // for this member, so the next member on this device reads their own.
      const forgetNoticeChapters = vi.fn();
      const signOut = appFunction("signOutAndForget", {
        window, navigator: window.navigator, sessionRef,
        departedSessionIDRef: { current: null }, sessionIDFromAccessToken,
        appAuthStorageKey: "synthetic-auth-storage",
        clearNavUsageForUser: vi.fn(), clearNavPinsForUser: vi.fn(), clearActingHat: vi.fn(), forgetNoticeChapters,
        guardRef: { current: { captureOperation: () => operation } },
        outboxStoreRef: { current: {} }, deleteSnapshot: vi.fn().mockResolvedValue(undefined),
        purgeSensitiveEntries: vi.fn().mockResolvedValue(undefined), setNotice,
        signOutNoticeKey: appFunction("signOutNoticeKey"),
        signOutSafely, supabase: { realtime: { setAuth: vi.fn() } },
        createCapturedAppSessionRpcClient: vi.fn(), verifyCapturedAppSession: vi.fn(),
        clearCapturedAppSessionLocally: vi.fn(), landSignedOutAtRoot: vi.fn(),
        sameAuthSessionLineage: (current, captured) => current === captured,
        beginSessionGeneration: () => { data = null; }, setSession, setLoading, setAuthRestorePending, tr: (key) => key,
      });
      await signOut();
      expect(signOutSafely).toHaveBeenCalledOnce();
      expect(forgetNoticeChapters).toHaveBeenCalledOnce();
      expect(sessionRef.current).toBeNull();
      expect(setSession).toHaveBeenCalledWith(null);
      expect(setLoading).toHaveBeenCalledWith(false);
      expect(setAuthRestorePending).toHaveBeenCalledWith(false);
      expect(setNotice).not.toHaveBeenCalled();
      expect(data).toBeNull();
      expect(window.localStorage.getItem(LANGUAGE_KEY)).toBe(deviceChoice);
      render(authView(bootLanguage()));
      expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
    },
  );

  it("reads a legacy sg-lang choice once and leaves the explicit Union Ground key to win", () => {
    browserLanguage("en-US");
    window.localStorage.setItem(LEGACY_LANGUAGE_KEY, "es");
    expect(bootLanguage()).toBe("es");
    window.localStorage.setItem(LANGUAGE_KEY, "en");
    expect(bootLanguage()).toBe("en");
  });

  it("falls back to browser locale if storage is blocked or the stored choice is unsupported", () => {
    browserLanguage("es-MX");
    window.localStorage.setItem(LANGUAGE_KEY, "fr");
    expect(bootLanguage()).toBe("es");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked storage"); });
    expect(bootLanguage()).toBe("es");
  });

  it("wires the signed-out AuthScreen to the device state and its explicit-choice callback", () => {
    const auth = findNode(appAst, (node) => node.type === "JSXOpeningElement" && node.name.name === "AuthScreen");
    const prop = (name) => auth.attributes.find((attribute) => attribute.name?.name === name).value.expression.name;
    // bootLang as rendered: the device choice once its catalogue has loaded.
    expect(prop("lang")).toBe("shownBootLang");
    const shown = findNode(appAst, (node) => node.type === "VariableDeclarator"
      && node.id?.type === "ObjectPattern"
      && node.id.properties.some((property) => property.value?.name === "shownBootLang"));
    expect(shown.init.callee.name).toBe("useLoadedLanguage");
    expect(shown.init.arguments.map((argument) => argument.name)).toEqual(["bootLang", "loadLanguage", "languageAttempt"]);
    expect(prop("onLanguageChange")).toBe("changeBootLanguage");
  });
});
