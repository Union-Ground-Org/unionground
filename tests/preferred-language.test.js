import { afterEach, describe, expect, it } from "vitest";
import { preferredLanguage } from "../src/lib/preferredLanguage.js";

function windowStub({ stored, language, throwOnGet = false } = {}) {
  return {
    localStorage: {
      getItem(key) {
        if (throwOnGet) throw new Error("blocked storage");
        return key === "sg-lang" ? stored ?? null : null;
      },
    },
    navigator: { language },
  };
}

const navigatorLanguageDescriptor =
  Object.getOwnPropertyDescriptor(window.navigator, "language")
  ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(window.navigator), "language");

function stubNavigatorLanguage(value) {
  Object.defineProperty(window.navigator, "language", {
    configurable: true,
    enumerable: true,
    get: () => value,
  });
}

function restoreNavigatorLanguage() {
  if (navigatorLanguageDescriptor) {
    Object.defineProperty(window.navigator, "language", navigatorLanguageDescriptor);
  }
}

afterEach(() => {
  restoreNavigatorLanguage();
});

describe("preferredLanguage", () => {
  it("lets a saved sg-lang beat the device language", () => {
    expect(preferredLanguage(windowStub({ stored: "es", language: "en-US" }))).toBe("es");
    expect(preferredLanguage(windowStub({ stored: "en", language: "es-MX" }))).toBe("en");
  });

  it("falls through an unrecognized stored value to the device language", () => {
    expect(preferredLanguage(windowStub({ stored: "fr", language: "es-MX" }))).toBe("es");
  });

  it("maps device-language region variants onto en or es", () => {
    expect(preferredLanguage(windowStub({ language: "es-MX" }))).toBe("es");
    expect(preferredLanguage(windowStub({ language: "en-GB" }))).toBe("en");
  });

  it("defaults to English when there is no stored or device signal", () => {
    stubNavigatorLanguage("");
    expect(preferredLanguage(windowStub({ stored: null, language: "" }))).toBe("en");
    expect(preferredLanguage(null)).toBe("en");
  });

  it("falls through a throwing localStorage.getItem instead of crashing", () => {
    expect(preferredLanguage(windowStub({ throwOnGet: true, language: "es-MX" }))).toBe("es");
    expect(preferredLanguage(windowStub({ throwOnGet: true, language: "en-US" }))).toBe("en");
  });
});
