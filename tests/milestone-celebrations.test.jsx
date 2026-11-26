import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// REQ-UG-MILESTONE-CONFETTI-CELEBRATIONS-20261102: a brief
// aubergine-and-gold celebration on confirmed milestones only. The supported
// triggers are the existing ones: an org-start milestone the server reports
// done (small burst), the organization going live (side cannons, once per
// organization and account on this browser), and an acknowledged pulse answer
// (small burst, replacing the dialog's own CSS confetti). Reduced motion draws
// nothing and keeps the success text.

const spies = vi.hoisted(() => ({ celebrate: vi.fn(() => true), celebrateOnce: vi.fn(() => true) }));
vi.mock("../src/lib/celebrate.js", async (importOriginal) => ({ ...(await importOriginal()), celebrate: spies.celebrate, celebrateOnce: spies.celebrateOnce }));

const { celebrate, celebrateOnce } = await vi.importActual("../src/lib/celebrate.js");
const { OrgStartGuide } = await import("../src/features/onboardingGuideEngine/OrgStartGuide.jsx");
const { orgStartGuide } = await import("../src/features/onboardingGuideEngine/orgStart.js");
const { ChoiceDialog } = await import("../src/components/Dialogs.jsx");
const { clearDeviceParityState } = await import("../src/lib/deviceParity.js");
const { LanguageProvider } = await import("../src/lib/LanguageContext.jsx");

const check = (id, done, count = 0, adminOnly = false) => ({ id, done, count, adminOnly });
// The fictional organization of the org-start scenario bank: milestones 1 to 3
// done; `contentDone` finishes milestone 4.
function payload(contentDone = false) {
  return {
    state: "active", organizationId: "50913000-0000-4000-8000-000000000001", organizationName: "Tamarack Valley",
    viewer: { isAdmin: true, canNameContacts: true }, adminName: "Stacy Paquette",
    milestones: [
      { id: "structure", checks: [check("chapters", true, 2, true), check("worksites", true, 5, true)] },
      { id: "people", checks: [check("staffGrants", true, 5, true), check("invitationsSent", true, 2, true)] },
      { id: "onboarding", checks: [check("activeSteps", true, 6), check("switchesReviewed", true, 0, true)] },
      { id: "content", checks: [check("announcements", contentDone, contentDone ? 1 : 0), check("events", true, 1), check("knowledgeItems", contentDone, contentDone ? 1 : 0)] },
      { id: "ballot", checks: [check("ballotDraftWithSecrecy", false)] },
      { id: "support", checks: [check("supportPrograms", false)] },
      { id: "backups", checks: [check("backupNamed", false), check("spokespeople", false)] },
    ],
    people: [], members: [], contacts: { backupUserId: null, spokespersonUserIds: [] },
  };
}
const view = (input) => orgStartGuide(input, { reachable: () => true }).view;
const guide = (v, key = "user-1:org-1") => <LanguageProvider lang="en"><OrgStartGuide guide={{ view: v }} onOpen={vi.fn()} onReviewSwitches={vi.fn()} onSaveContacts={vi.fn()} onCelebrated={vi.fn(async () => null)} celebrationKey={key} /></LanguageProvider>;

beforeEach(() => { spies.celebrate.mockClear(); spies.celebrateOnce.mockClear(); });
afterEach(() => { cleanup(); clearDeviceParityState(); vi.useRealTimers(); });

describe("the shared celebration", () => {
  const fire = () => vi.fn();
  const motion = (reduce) => vi.stubGlobal("matchMedia", (query) => ({ matches: reduce && query.includes("reduce"), addEventListener() {}, removeEventListener() {} }));
  afterEach(() => vi.unstubAllGlobals());

  it("fires one small burst, or two side cannons for a major milestone, in the identity colors", () => {
    motion(false);
    document.documentElement.style.setProperty("--sg-light-brand", "#0e4034");
    document.documentElement.style.setProperty("--sg-light-accent", "#efa738");
    const small = fire();
    expect(celebrate("small", { fire: small, canvas: () => true })).toBe(true);
    expect(small).toHaveBeenCalledTimes(1);
    expect(small.mock.calls[0][0]).toMatchObject({ colors: ["#0e4034", "#efa738"], disableForReducedMotion: true });
    const major = fire();
    celebrate("major", { fire: major, canvas: () => true });
    expect(major.mock.calls.map(([options]) => options.origin.x)).toEqual([0, 1]);
  });

  it("draws nothing under reduced motion or without a canvas", () => {
    motion(true);
    const reduced = fire();
    expect(celebrate("major", { fire: reduced, canvas: () => true })).toBe(false);
    expect(reduced).not.toHaveBeenCalled();
    motion(false);
    const noCanvas = fire();
    expect(celebrate("small", { fire: noCanvas, canvas: () => false })).toBe(false);
    expect(noCanvas).not.toHaveBeenCalled();
  });

  it("celebrates a milestone key once, and remembers it even when motion is reduced", () => {
    const store = new Map();
    const storage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
    motion(false);
    const first = fire();
    expect(celebrateOnce("org-start:u:o", "major", { storage, fire: first, canvas: () => true })).toBe(true);
    expect(celebrateOnce("org-start:u:o", "major", { storage, fire: first, canvas: () => true })).toBe(false);
    expect(first).toHaveBeenCalledTimes(2);
    motion(true);
    const reduced = fire();
    celebrateOnce("org-start:u:other", "major", { storage, fire: reduced, canvas: () => true });
    expect(reduced).not.toHaveBeenCalled();
    expect(store.get("union-ground:celebrated:org-start:u:other")).toBe("1");
  });
});

describe("a browser that blocks storage", () => {
  //  on #6919: the localStorage getter itself throws (SecurityError)
  // in a browser that blocks storage; the default parameter used to read it
  // outside the try and crashed the guide's effect.
  it("celebrates at most once per key without throwing when the localStorage getter throws", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new DOMException("The operation is insecure.", "SecurityError"); } });
    try {
      const fire = vi.fn();
      expect(() => celebrateOnce("org-start:blocked:org", "major", { fire, canvas: () => true })).not.toThrow();
      expect(celebrateOnce("org-start:blocked:org", "major", { fire, canvas: () => true })).toBe(false);
      expect(fire).toHaveBeenCalledTimes(2);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
      vi.unstubAllGlobals();
    }
  });
});

describe("org-start milestones", () => {
  it("bursts when the server reports a milestone newly done, not on first sight", () => {
    const view1 = view(payload());
    const result = render(guide(view1));
    expect(spies.celebrate).not.toHaveBeenCalled();
    result.rerender(guide(view(payload(true))));
    expect(spies.celebrate).toHaveBeenCalledTimes(1);
    expect(spies.celebrate).toHaveBeenCalledWith("small");
    result.rerender(guide(view(payload(true))));
    expect(spies.celebrate).toHaveBeenCalledTimes(1);
  });

  it("fires the major celebration once per organization key when the organization goes live", () => {
    const live = view({ state: "live", organizationName: "Tamarack Valley" });
    const result = render(guide(live));
    expect(screen.getByText("Tamarack Valley is live")).toBeInTheDocument();
    expect(spies.celebrateOnce).toHaveBeenCalledTimes(1);
    expect(spies.celebrateOnce).toHaveBeenCalledWith("org-start:user-1:org-1", "major");
    result.rerender(guide(live));
    expect(spies.celebrateOnce).toHaveBeenCalledTimes(1);
    expect(spies.celebrate).not.toHaveBeenCalled();
  });
});

describe("pulse answers", () => {
  const PULSE = { id: "p1", kind: "pulse", title: "Weekend pulse", options: [{ id: "a", label: "Fair" }, { id: "b", label: "Unfair" }] };
  async function answer(onSubmit) {
    render(<LanguageProvider lang="en"><ChoiceDialog item={PULSE} onClose={vi.fn()} onSubmit={onSubmit} /></LanguageProvider>);
    fireEvent.click(screen.getByRole("radio", { name: "Fair" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Submit answer" })); });
  }

  it("bursts once after the answer is acknowledged, keeping the seal and text", async () => {
    await answer(vi.fn().mockResolvedValue({ awardedPoints: 0 }));
    expect(screen.getByRole("status")).toHaveTextContent("Answer in!");
    expect(spies.celebrate).toHaveBeenCalledTimes(1);
    expect(spies.celebrate).toHaveBeenCalledWith("small");
    expect(document.querySelector(".pulse-done__confetti")).toBeNull();
  });

  it("does not celebrate a failed or refused answer", async () => {
    await answer(vi.fn().mockResolvedValue(null));
    cleanup();
    await answer(vi.fn().mockResolvedValue({ refused: "closed" }));
    expect(spies.celebrate).not.toHaveBeenCalled();
  });
});
