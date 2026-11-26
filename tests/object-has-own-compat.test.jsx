// BUG-UG-BOOTSTRAP-MISSING-HASOWN-COMPATIBILITY-20261020: the supported
// browser floor (Safari 14, Chrome 87, Firefox 78, Edge 88) has no
// Object.hasOwn, and the web bootstrap called it before React mounted.
import { readFileSync } from "node:fs";
import React from "react";
import { act, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installObjectHasOwn, objectHasOwnFallback } from "../src/lib/objectHasOwnCompat.js";

const nativeDescriptor = Object.getOwnPropertyDescriptor(Object, "hasOwn");

function removeNativeHasOwn() {
  Object.defineProperty(Object, "hasOwn", { configurable: true, writable: true, value: undefined });
}

describe("Object.hasOwn fallback", () => {
  it("counts own keys only, works on null-prototype objects and refuses nullish targets", () => {
    const parent = { inherited: 1 };
    const child = Object.create(parent);
    child.own = undefined;
    expect(objectHasOwnFallback(child, "own")).toBe(true);
    expect(objectHasOwnFallback(child, "inherited")).toBe(false);
    expect(objectHasOwnFallback({}, "toString")).toBe(false);
    expect(objectHasOwnFallback({}, "constructor")).toBe(false);
    expect(objectHasOwnFallback({}, "__proto__")).toBe(false);
    expect(objectHasOwnFallback({ constructor: 1 }, "constructor")).toBe(true);
    expect(objectHasOwnFallback(JSON.parse('{"__proto__":1}'), "__proto__")).toBe(true);

    const bare = Object.create(null);
    bare.en = {};
    expect(objectHasOwnFallback(bare, "en")).toBe(true);
    expect(objectHasOwnFallback(bare, "es")).toBe(false);

    const symbol = Symbol("key");
    expect(objectHasOwnFallback({ [symbol]: 1 }, symbol)).toBe(true);
    expect(objectHasOwnFallback("ab", "length")).toBe(true);
    expect(objectHasOwnFallback("ab", 1)).toBe(true);
    expect(objectHasOwnFallback(["x"], 0)).toBe(true);

    for (const target of [null, undefined]) {
      expect(() => objectHasOwnFallback(target, "x")).toThrow(TypeError);
      expect(() => nativeDescriptor.value(target, "x")).toThrow(TypeError);
    }
    expect(objectHasOwnFallback).toHaveLength(2);
  });

  it("matches the native method on every case it covers", () => {
    const cases = [[{ a: 1 }, "a"], [Object.create({ a: 1 }), "a"], [Object.create(null), "a"], ["ab", "length"], [[1], "0"], [{ constructor: 1 }, "constructor"]];
    for (const [target, key] of cases) expect(objectHasOwnFallback(target, key)).toBe(nativeDescriptor.value(target, key));
  });

  it("leaves a working native implementation unchanged and installs only when it is missing", () => {
    const native = vi.fn(() => true);
    const withNative = { hasOwn: native };
    expect(installObjectHasOwn(withNative)).toBe(false);
    expect(withNative.hasOwn).toBe(native);
    expect(Object.hasOwn).toBe(nativeDescriptor.value);

    const without = {};
    expect(installObjectHasOwn(without)).toBe(true);
    expect(without.hasOwn).toBe(objectHasOwnFallback);
    expect(Object.getOwnPropertyDescriptor(without, "hasOwn")).toMatchObject({ writable: true, configurable: true, enumerable: false });
  });

  it("is the first module the web entry imports", () => {
    const main = readFileSync("src/main.jsx", "utf8");
    const imports = [...main.matchAll(/^import\s.*$/gm)].map((match) => match[0]);
    expect(imports[0]).toBe('import "./lib/objectHasOwnCompat.js";');
  });
});

describe("web bootstrap without the native static method", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  const roots = [];

  afterEach(() => {
    act(() => roots.splice(0).forEach((root) => root.unmount()));
    Object.defineProperty(Object, "hasOwn", nativeDescriptor);
    vi.doUnmock("react-dom/client");
    vi.doUnmock("../src/AppRouter.jsx");
    vi.doUnmock("../src/lib/observability.js");
    vi.resetModules();
    window.localStorage.removeItem("sg-lang");
    document.body.innerHTML = "";
  });

  it("loads English and Spanish and translates once the compatibility module has run", async () => {
    removeNativeHasOwn();
    const compat = await import("../src/lib/objectHasOwnCompat.js");
    expect(Object.hasOwn).toBe(compat.objectHasOwnFallback);
    const { loadLanguage, languageLoaded, t } = await import("../src/lib/i18n.js");
    await expect(loadLanguage("en")).resolves.toBe(true);
    await expect(loadLanguage("es")).resolves.toBe(true);
    expect(languageLoaded("es")).toBe(true);
    expect(languageLoaded("constructor")).toBe(false);
    expect(t("en", "auth.passkeyCta")).toBe("Use a passkey or security key");
    expect(t("es", "auth.passkeyCta")).not.toBe("Use a passkey or security key");
  });

  it.each(["en", "es"])("mounts the sign-in screen through src/main.jsx in %s", async (lang) => {
    window.localStorage.setItem("sg-lang", lang);
    document.body.innerHTML = '<div id="root"></div>';
    // Vitest 5's module loader also needs Object.hasOwn. Load the real
    // installer before simulating the older browser, then mount with its
    // fallback. The assertion above pins the entry's first-import order.
    const bootstrapCompat = await import("../src/lib/objectHasOwnCompat.js");
    removeNativeHasOwn();
    expect(bootstrapCompat.installObjectHasOwn()).toBe(true);
    vi.doMock("../src/lib/observability.js", () => ({
      initObservability: () => {},
      posthogClient: null,
      Sentry: { ErrorBoundary: ({ children }) => children },
    }));
    // The real createRoot, recorded so each mounted root is unmounted afterwards.
    vi.doMock("react-dom/client", async (importOriginal) => {
      const actual = await importOriginal();
      return { ...actual, createRoot: (element) => { const root = actual.createRoot(element); roots.push(root); return root; } };
    });
    vi.doMock("../src/AppRouter.jsx", async () => {
      const { AuthScreen } = await import("../src/components/AuthScreen.jsx");
      const { LanguageProvider } = await import("../src/lib/LanguageContext.jsx");
      const client = { auth: { setSession: vi.fn(), signInWithPasskey: vi.fn() } };
      return { App: () => <LanguageProvider lang={lang}><AuthScreen client={client} lang={lang} /></LanguageProvider> };
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await import("../src/main.jsx");
      const { loadLanguage, t } = await import("../src/lib/i18n.js");
      await expect(loadLanguage(lang)).resolves.toBe(true);
      // This mock offers no Apple or Google, so since #7388 the email form
      // shows directly once the provider list settles; the "Sign in with other
      // options" disclosure is only a transient loading state here
      // (BUG-UG-ROOT-COVERAGE-FLAKY-INVITATION-ES-AND-SIGNIN-MOUNT-20261021).
      expect(await screen.findByLabelText(t(lang, "auth.email"))).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: t(lang, "auth.otherMethods") })).toBeNull();
      const compat = await import("../src/lib/objectHasOwnCompat.js");
      expect(Object.hasOwn).toBe(compat.objectHasOwnFallback);
      expect(errors.mock.calls.flat().some((value) => value instanceof TypeError)).toBe(false);
    } finally {
      errors.mockRestore();
    }
  });
});
