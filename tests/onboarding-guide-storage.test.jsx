import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INACTIVE_GUIDE,
  forgetGuideCompleteDismissedThisSession,
  readGuideCompleteDismissed,
  readGuideShowAll,
  readGuideShowAllChoice,
  writeGuideCompleteDismissed,
  writeGuideShowAll,
  writeGuideShowAllChoice,
} from "../src/lib/onboardingGuide.js";
import { useMemberOnboardingGuide } from "../src/lib/useMemberOnboardingGuide.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function denyStorage() {
  return vi.spyOn(globalThis, "localStorage", "get").mockImplementation(() => {
    throw new DOMException("Storage access denied", "SecurityError");
  });
}

describe("onboarding preferences when browser storage is denied", () => {
  it.each([
    ["show-all reader", () => readGuideShowAll("member-a"), false],
    ["show-all writer", () => writeGuideShowAll("member-a", true), undefined],
    ["choice reader", () => readGuideShowAllChoice("member-a"), null],
    ["choice writer", () => writeGuideShowAllChoice("member-a", false), undefined],
    ["dismissal reader", () => readGuideCompleteDismissed("member-a"), false],
    ["dismissal writer", () => writeGuideCompleteDismissed("member-a"), undefined],
  ])("keeps the %s usable when accessing localStorage throws", (_label, call, fallback) => {
    denyStorage();
    expect(call()).toBe(fallback);
  });

  it.each([false, true])("keeps Show everything usable in memory (default=%s)", (showAllByDefault) => {
    denyStorage();
    const { result } = renderHook(() => useMemberOnboardingGuide({
      client: null, enabled: false, memberId: "member-a", showAllByDefault,
    }));
    expect(result.current.guide).toBe(INACTIVE_GUIDE);
    expect(result.current.showAll).toBe(showAllByDefault);
    act(() => result.current.setShowAll(!showAllByDefault));
    expect(result.current.showAll).toBe(!showAllByDefault);
    act(() => result.current.setShowAll(showAllByDefault));
    expect(result.current.showAll).toBe(showAllByDefault);
  });

  it("initializes without a member when storage is denied", () => {
    denyStorage();
    const { result } = renderHook(() => useMemberOnboardingGuide({ client: null, enabled: false, memberId: null }));
    expect(result.current.guide).toBe(INACTIVE_GUIDE);
    expect(result.current.showAll).toBe(false);
  });

  it("uses injected storage and preserves member isolation without accessing the denied browser store", () => {
    const denied = denyStorage();
    const rows = new Map();
    const storage = {
      getItem: (key) => rows.get(key) ?? null,
      setItem: (key, value) => rows.set(key, value),
      removeItem: (key) => rows.delete(key),
    };
    writeGuideShowAll("member-a", true, storage);
    expect(readGuideShowAll("member-a", storage)).toBe(true);
    expect(readGuideShowAll("member-b", storage)).toBe(false);
    writeGuideShowAll("member-a", false, storage);
    expect(readGuideShowAll("member-a", storage)).toBe(false);
    writeGuideShowAllChoice("member-a", false, storage);
    expect(readGuideShowAllChoice("member-a", storage)).toBe(false);
    expect(readGuideShowAllChoice("member-b", storage)).toBeNull();
    writeGuideCompleteDismissed("member-a", storage);
    expect(readGuideCompleteDismissed("member-a", storage)).toBe(true);
    expect(readGuideCompleteDismissed("member-b", storage)).toBe(false);
    expect(readGuideShowAll("member-a", null)).toBe(false);
    expect(readGuideShowAllChoice("member-a", null)).toBeNull();
    expect(denied).not.toHaveBeenCalled();
  });
});

// BUG-UG-HOME-GUIDE-DISMISSAL-SESSION-AND-FAILED-READ-NUDGE-TEST-20261027
describe("completed-guide dismissal when the device write fails", () => {
  function storageThatRefusesWrites() {
    const rows = new Map();
    return {
      getItem: (key) => rows.get(key) ?? null,
      setItem: () => { throw new DOMException("QuotaExceededError", "QuotaExceededError"); },
      removeItem: (key) => rows.delete(key),
    };
  }

  it("holds the choice for the session on the storage that refused it, and nowhere else", () => {
    const refusing = storageThatRefusesWrites();
    expect(() => writeGuideCompleteDismissed("member-a", refusing)).not.toThrow();
    expect(refusing.getItem("sg:member:member-a:onboarding-guide:complete-dismissed")).toBeNull();
    expect(readGuideCompleteDismissed("member-a", refusing)).toBe(true);
    expect(readGuideCompleteDismissed("member-b", refusing)).toBe(false);
    const other = storageThatRefusesWrites();
    expect(readGuideCompleteDismissed("member-a", other)).toBe(false);
    forgetGuideCompleteDismissedThisSession(refusing);
    expect(readGuideCompleteDismissed("member-a", refusing)).toBe(false);
  });

  it("holds the choice for the session when the browser denies storage entirely", () => {
    denyStorage();
    expect(() => writeGuideCompleteDismissed("member-a")).not.toThrow();
    expect(readGuideCompleteDismissed("member-a")).toBe(true);
    expect(readGuideCompleteDismissed("member-b")).toBe(false);
    forgetGuideCompleteDismissedThisSession();
    expect(readGuideCompleteDismissed("member-a")).toBe(false);
  });

  it("still prefers the durable write when it succeeds", () => {
    const rows = new Map();
    const storage = { getItem: (key) => rows.get(key) ?? null, setItem: (key, value) => rows.set(key, value), removeItem: (key) => rows.delete(key) };
    writeGuideCompleteDismissed("member-a", storage);
    expect(storage.getItem("sg:member:member-a:onboarding-guide:complete-dismissed")).toBe("true");
    forgetGuideCompleteDismissedThisSession(storage);
    expect(readGuideCompleteDismissed("member-a", storage)).toBe(true);
  });
});
