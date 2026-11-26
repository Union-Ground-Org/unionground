import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeAppNudge } from "../src/components/NativeAppNudge.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { nativeAppHref, smartAppBannerContent, NATIVE_NUDGE_DISMISSED } from "../src/lib/nativeAppNudge.js";
import { parseAppRoute } from "../apps/mobile/src/lib/routes";

// Union Ground has no App Store listing yet, so the shipped config carries
// no store identity (the sibling product's listing id must never appear). The
// banner tests run against a fictional listing id so the eligibility rules
// stay covered; the shipped config itself is pinned below.
const FICTIONAL_STORE_ID = "1234567890";
vi.mock("../config/mobile-web-support.json", async (importOriginal) => {
  const original = await importOriginal();
  return { default: { ...original.default, iosAppStoreId: "1234567890" } };
});
const shippedSupport = JSON.parse(readFileSync(resolve(process.cwd(), "config/mobile-web-support.json"), "utf8"));

let change;
let media;
beforeEach(() => {
  sessionStorage.clear();
  media = { matches: true, addEventListener: vi.fn((_event, fn) => { change = fn; }), removeEventListener: vi.fn() };
  vi.stubGlobal("matchMedia", vi.fn(() => media));
});
afterEach(() => vi.unstubAllGlobals());
const nudge = (props = {}, lang = "en") => <LanguageProvider lang={lang}><NativeAppNudge pathname="/m" {...props} /></LanguageProvider>;

describe("optional native app opening", () => {
  it("offers an explicit native destination and persists Stay on web across remounts", () => {
    const { unmount } = render(nudge());
    expect(screen.getByRole("link", { name: "Open in app" })).toHaveAttribute("href", "unionground://home");
    fireEvent.click(screen.getByRole("button", { name: "Stay on web" }));
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(sessionStorage.getItem(NATIVE_NUDGE_DISMISSED)).toBe("1");
    unmount();
    render(nudge());
    expect(screen.queryByRole("complementary")).toBeNull();
  });
  it("dismisses without storage access", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw Error("blocked"); });
    render(nudge());
    fireEvent.click(screen.getByRole("button", { name: "Stay on web" }));
    expect(screen.queryByRole("complementary")).toBeNull();
    vi.restoreAllMocks();
  });
  it("uses Spanish and hides when resized to tablet", () => {
    const { unmount } = render(nudge({}, "es"));
    expect(screen.getByRole("link", { name: "Abrir en la app" })).toHaveAttribute("href", "unionground://home");
    media.matches = false;
    act(() => change());
    expect(screen.queryByRole("complementary")).toBeNull();
    unmount();
    sessionStorage.clear();
    render(nudge());
    expect(screen.queryByRole("complementary")).toBeNull();
  });
  it.each([{ enabled: false }, { selectedHat: "steward", pathname: "/m/messages" }, { pathname: "/auth/callback" }, { pathname: "/m/admin" }, { search: "?demo=1" }, { hash: "#access_token=secret" }])("does not suggest unsupported or sensitive context %j", (props) => {
    render(nudge(props));
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(document.querySelector('meta[name="apple-itunes-app"]')).toBeNull();
  });
  it("emits the banner now that the app is on sale, keeps it off when told so, and limits metadata to eligible context", () => {
    const { rerender, unmount } = render(nudge({ appStoreAvailable: false }));
    expect(document.querySelector('meta[name="apple-itunes-app"]')).toBeNull();
    rerender(nudge({ appStoreAvailable: true }));
    expect(document.querySelector('meta[name="apple-itunes-app"]')).toHaveAttribute("content", `app-id=${FICTIONAL_STORE_ID}, app-argument=unionground://home`);
    rerender(nudge({ appStoreAvailable: true, enabled: false }));
    expect(document.querySelector('meta[name="apple-itunes-app"]')).toBeNull();
    rerender(nudge({ appStoreAvailable: true }));
    media.matches = false;
    act(() => change());
    expect(document.querySelector('meta[name="apple-itunes-app"]')).toBeNull();
    unmount();
  });
  it("does not transfer queries or fragments into native links", () => {
    expect(nativeAppHref("/m/messages")).toBe("unionground://messages");
    expect(nativeAppHref("/m/events")).toBe("unionground://feature/events");
    expect(nativeAppHref("/m/rights")).toBe("unionground://feature/rights");
    expect(nativeAppHref("/m/cases")).toBe("unionground://feature/cases");
    expect(nativeAppHref("/m", "?code=secret")).toBeNull();
    expect(nativeAppHref("//evil.invalid/m")).toBeNull();
    expect(nativeAppHref("toString")).toBeNull();
    expect(nativeAppHref("__proto__")).toBeNull();
    for (const pathname of ["/m", "/m/messages", "/m/events", "/m/rights", "/m/cases"]) {
      expect(parseAppRoute(nativeAppHref(pathname))).not.toBeNull();
    }
  });
  it("requires a real numeric store identity before emitting banner metadata", () => {
    expect(smartAppBannerContent("unionground://home", null, true)).toBeNull();
    expect(smartAppBannerContent()).toBeNull();
    expect(smartAppBannerContent(null, undefined, true)).toBe(`app-id=${FICTIONAL_STORE_ID}`);
    expect(smartAppBannerContent("unionground://home", "org.unionground.app", true)).toBeNull();
    expect(smartAppBannerContent("unionground://messages", "1234567890", true)).toBe("app-id=1234567890, app-argument=unionground://messages");
    expect(smartAppBannerContent(null, "1234567890", true)).toBe("app-id=1234567890");
  });
  it("ships no App Store identity until Union Ground has its own listing", () => {
    expect(shippedSupport.iosAppStoreId).toBe("");
    expect(shippedSupport.iosAppStoreAvailable).toBe(false);
    expect(JSON.stringify(shippedSupport)).not.toContain("1000000001");
    expect(smartAppBannerContent("unionground://home", shippedSupport.iosAppStoreId, true)).toBeNull();
    expect(smartAppBannerContent(null, shippedSupport.iosAppStoreId, true)).toBeNull();
  });
});
