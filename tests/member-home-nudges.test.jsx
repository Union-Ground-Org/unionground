// REQ-UG-HOME-NUDGES-20261001: one-at-a-time Home nudges.
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { GUIDE_RPC, NUDGES_RPC, PASSKEY_NUDGE_DELAY_MS, chooseHomeNudge, normalizeHomeNudges, nudgeAllowedByHistory, starterListApplies } from "../src/features/memberHome/nudges.js";
import { HomeNudgeSlot } from "../src/features/memberHome/HomeNudgeSlot.jsx";
import { TodayView } from "../src/views/TodayView.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { catalogue } from "../src/lib/i18n.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 2, 12);
const server = (patch = {}) => ({ passkey: true, onboarding: null, guidedFirstRun: false, snoozeDays: 28, ...patch });

function transport(payload, { signedInAt = new Date(Date.now() - 60 * 60 * 1000).toISOString(), error = null, guide = null, guideError = null } = {}) {
  const rpc = vi.fn(async (name) => (name === GUIDE_RPC ? { data: guide, error: guideError } : { data: payload, error }));
  return { rpc, transport: { createSessionClient: () => ({ rpc }), session: { access_token: "t", user: { last_sign_in_at: signedInAt } } } };
}

const authClient = (keys) => ({ auth: { passkey: { list: vi.fn(async () => ({ data: keys, error: null })) } } });
const data = { member: { id: "member-1" } };

beforeEach(() => { window.PublicKeyCredential = function PublicKeyCredential() {}; });
afterEach(() => { delete window.PublicKeyCredential; window.localStorage.clear(); window.sessionStorage.clear(); vi.useRealTimers(); });

describe("nudge model", () => {
  it("normalizes the server answer and keeps the old 28-day snooze as the fallback", () => {
    expect(normalizeHomeNudges(null)).toEqual({ passkey: false, onboarding: null, starterList: false, guidedFirstRun: false, snoozeDays: 28 });
    expect(normalizeHomeNudges({ passkey: true, onboarding: { completed: 3, total: 3 }, snoozeDays: 7 })).toEqual({ passkey: true, onboarding: null, starterList: false, guidedFirstRun: false, snoozeDays: 7 });
    expect(normalizeHomeNudges({ onboarding: { completed: 1, total: 4 }, guidedFirstRun: true })).toMatchObject({ onboarding: { completed: 1, total: 4 }, guidedFirstRun: true });
  });

  // BUG-UG-ESTABLISHED-MEMBER-BADGED-NEW-MEMBER-20261106 (G6 r1s1/r2s1).
  it("never offers the onboarding reminder to the guide's established member, and keeps it for a member who is not", () => {
    const answer = { passkey: true, onboarding: { completed: 0, total: 7 }, snoozeDays: 28 };
    const guide = { state: "ready", memberOnly: true, programConfigured: true, applies: false };
    const established = normalizeHomeNudges(answer, { ...guide, establishedMember: true });
    expect(established).toMatchObject({ passkey: true, onboarding: null, starterList: false });
    expect(chooseHomeNudge({ server: established, now: 0 })).toBeNull();
    expect(normalizeHomeNudges(answer, { ...guide, establishedMember: false })).toMatchObject({ onboarding: { completed: 0, total: 7 } });
  });

  it("snoozes after Not now and caps a nudge shown in an earlier session to once a week", () => {
    expect(nudgeAllowedByHistory({ dismissedAt: NOW - 27 * DAY, now: NOW, snoozeDays: 28 })).toBe(false);
    expect(nudgeAllowedByHistory({ dismissedAt: NOW - 29 * DAY, now: NOW, snoozeDays: 28 })).toBe(true);
    expect(nudgeAllowedByHistory({ shownAt: NOW - 2 * DAY, now: NOW, snoozeDays: 28 })).toBe(false);
    expect(nudgeAllowedByHistory({ shownAt: NOW - 2 * DAY, shownThisSession: true, now: NOW, snoozeDays: 28 })).toBe(true);
    expect(nudgeAllowedByHistory({ shownAt: NOW - 8 * DAY, now: NOW, snoozeDays: 28 })).toBe(true);
  });

  it("shows one nudge at a time: onboarding first, then passkey", () => {
    const base = { passkeySupported: true, hasPasskey: false, signedInAt: NOW - DAY, now: NOW };
    expect(chooseHomeNudge({ ...base, server: server({ onboarding: { completed: 1, total: 4 } }) })).toEqual({ kind: "onboarding", completed: 1, total: 4 });
    expect(chooseHomeNudge({ ...base, server: server() })).toEqual({ kind: "passkey" });
    expect(chooseHomeNudge({ ...base, server: server({ onboarding: { completed: 1, total: 4 } }), history: { onboarding: { dismissedAt: NOW - DAY } } })).toEqual({ kind: "passkey" });
  });

  // REQ-UG-FIRST-RUN-GUIDE-WITHOUT-ORG-CHECKLIST-20261018: the
  // zero-step organization.
  it("offers the starting list only to a member of an organization with no active step", () => {
    const zeroSteps = { state: "ready", applies: false, memberOnly: true, programConfigured: false, totalSteps: 0 };
    expect(starterListApplies(zeroSteps)).toBe(true);
    expect(starterListApplies({ ...zeroSteps, memberOnly: false })).toBe(false);
    expect(starterListApplies({ ...zeroSteps, programConfigured: true, totalSteps: 3 })).toBe(false);
    expect(starterListApplies({ state: "unavailable", applies: false })).toBe(false);
    expect(starterListApplies({ memberOnly: true })).toBe(false);
    expect(starterListApplies(null)).toBe(false);
    expect(normalizeHomeNudges({ passkey: true, snoozeDays: 28 }, zeroSteps)).toMatchObject({ starterList: true });
    // An organization that wrote its own checklist keeps its own nudge.
    expect(normalizeHomeNudges({ onboarding: { completed: 0, total: 3 } }, zeroSteps)).toMatchObject({ onboarding: { completed: 0, total: 3 }, starterList: false });

    const base = { passkeySupported: true, hasPasskey: false, signedInAt: NOW - DAY, now: NOW };
    expect(chooseHomeNudge({ ...base, server: server({ starterList: true }) })).toEqual({ kind: "starter" });
    // No weekly cap and no snooze expiry: it stays until dismissed, then never returns.
    expect(chooseHomeNudge({ ...base, server: server({ starterList: true }), history: { starter: { shownAt: NOW - DAY } } })).toEqual({ kind: "starter" });
    expect(chooseHomeNudge({ ...base, server: server({ starterList: true }), history: { starter: { dismissedAt: NOW - 400 * DAY } } })).toEqual({ kind: "passkey" });
    expect(chooseHomeNudge({ ...base, server: server({ starterList: true }), welcomeTourActive: true })).toBeNull();
  });

  it("never nudges during the welcome tour or the guided first run", () => {
    const base = { passkeySupported: true, hasPasskey: false, signedInAt: NOW - DAY, now: NOW };
    expect(chooseHomeNudge({ ...base, server: server({ onboarding: { completed: 0, total: 2 } }), welcomeTourActive: true })).toBeNull();
    expect(chooseHomeNudge({ ...base, server: server({ guidedFirstRun: true }) })).toBeNull();
  });

  it("offers a passkey only when allowed, supported, absent, and ten minutes after sign-in", () => {
    const base = { server: server(), passkeySupported: true, hasPasskey: false, signedInAt: NOW - DAY, now: NOW };
    expect(chooseHomeNudge({ ...base, server: server({ passkey: false }) })).toBeNull();
    expect(chooseHomeNudge({ ...base, passkeySupported: false })).toBeNull();
    expect(chooseHomeNudge({ ...base, hasPasskey: true })).toBeNull();
    expect(chooseHomeNudge({ ...base, hasPasskey: null })).toBeNull();
    expect(chooseHomeNudge({ ...base, signedInAt: NOW - PASSKEY_NUDGE_DELAY_MS + 1000 })).toBeNull();
    expect(chooseHomeNudge(base)).toEqual({ kind: "passkey" });
  });

  // UX-UG-STARTING-LIST-HOME-CARD-BODY-TOO-LONG-20261020: the card's
  // button opens the four steps, so the body does not list them again.
  it("keeps the starting-list body to one sentence that leaves the steps to its button", () => {
    expect(catalogue.en["homeNudge.starterBody"]).toBe("Your campaign has not added its own onboarding checklist yet, so here is where most new workers start.");
    expect(catalogue.es["homeNudge.starterBody"]).toBe("Tu campaña todavía no ha agregado su propia lista de incorporación, así que aquí empieza la mayoría de los trabajadores nuevos.");
    for (const lang of ["en", "es"]) expect(catalogue[lang]["homeNudge.starterBody"]).not.toMatch(/profile|perfil|steward|delegado/u);
  });

  it("has Spanish copy for every English key", () => {
    const keys = Object.keys(catalogue.en).filter((key) => key.startsWith("homeNudge.") || /^settings\.def\.(features\.home\.(passkey|onboarding)_nudge|limits\.home\.nudge_snooze_days)\./.test(key));
    expect(keys).toHaveLength(23);
    for (const key of keys) expect(catalogue.es[key], key).toBeTruthy();
  });
});

describe("HomeNudgeSlot", () => {
  it("shows the onboarding nudge with the next step and opens the checklist", async () => {
    const { rpc, transport: live } = transport({ passkey: true, onboarding: { completed: 1, total: 4 }, guidedFirstRun: false, snoozeDays: 28 });
    const onOpenOnboarding = vi.fn();
    render(<LanguageProvider><HomeNudgeSlot data={data} transport={live} authClient={authClient([])} onOpenOnboarding={onOpenOnboarding} onAddPasskey={vi.fn()} /></LanguageProvider>);
    expect(await screen.findByRole("heading", { name: "Complete your onboarding" })).toBeTruthy();
    expect(rpc).toHaveBeenCalledWith(NUDGES_RPC);
    expect(screen.getByText("Step 2 of 4. Pick up your checklist where you left off.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Sign in faster with a passkey" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue onboarding" }));
    expect(onOpenOnboarding).toHaveBeenCalled();
  });


  it("never offers a passkey on web, and snoozes the onboarding nudge on Not now", async () => {
    const { rpc, transport: live } = transport({ passkey: true, onboarding: null, guidedFirstRun: false, snoozeDays: 28 });
    const keys = authClient([]);
    const passkeyOnly = render(<LanguageProvider><HomeNudgeSlot data={data} transport={live} authClient={keys} onAddPasskey={vi.fn()} /></LanguageProvider>);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith(NUDGES_RPC));
    await act(async () => {});
    expect(passkeyOnly.container.firstChild).toBeNull();
    expect(screen.queryByRole("heading", { name: "Sign in faster with a passkey" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add a passkey" })).toBeNull();
    expect(keys.auth.passkey.list).not.toHaveBeenCalled();
    passkeyOnly.unmount();

    const both = transport({ passkey: true, onboarding: { completed: 1, total: 4 }, guidedFirstRun: false, snoozeDays: 28 });
    render(<LanguageProvider><HomeNudgeSlot data={data} transport={both.transport} authClient={authClient([])} onOpenOnboarding={vi.fn()} onAddPasskey={vi.fn()} /></LanguageProvider>);
    expect(await screen.findByRole("heading", { name: "Complete your onboarding" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Not now: hide the onboarding reminder for a while" }));
    expect(screen.queryByRole("heading", { name: "Complete your onboarding" })).toBeNull();
    // Dismissing onboarding must not fall through to a passkey suggestion.
    expect(screen.queryByRole("heading", { name: "Sign in faster with a passkey" })).toBeNull();
    expect(JSON.parse(window.localStorage.getItem("ug-home-nudges:v1:member-1")).onboarding.dismissedAt).toBeGreaterThan(0);
  });

  it("stays silent during the welcome tour and in preview", async () => {
    const tour = transport({ passkey: true, onboarding: { completed: 0, total: 3 }, snoozeDays: 28 });
    const second = render(<LanguageProvider><HomeNudgeSlot data={data} transport={tour.transport} authClient={authClient([])} welcomeTourActive onAddPasskey={vi.fn()} /></LanguageProvider>);
    await waitFor(() => expect(tour.rpc).toHaveBeenCalled());
    expect(second.container.firstChild).toBeNull();
    second.unmount();
    const preview = transport({ passkey: true, onboarding: { completed: 0, total: 3 }, snoozeDays: 28 });
    render(<LanguageProvider><HomeNudgeSlot data={data} transport={{ ...preview.transport, preview: true }} authClient={authClient([])} /></LanguageProvider>);
    await act(async () => {});
    expect(preview.rpc).not.toHaveBeenCalled();
  });

  it("does not suggest a passkey even after the ten-minute sign-in delay", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(NOW);
    const { rpc, transport: live } = transport({ passkey: true, onboarding: null, snoozeDays: 28 }, { signedInAt: new Date(NOW - 60_000).toISOString() });
    const view = render(<LanguageProvider><HomeNudgeSlot data={data} transport={live} authClient={authClient([])} onAddPasskey={vi.fn()} /></LanguageProvider>);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(rpc).toHaveBeenCalledWith(NUDGES_RPC);
    expect(screen.queryByRole("heading", { name: "Sign in faster with a passkey" })).toBeNull();
    await act(async () => { vi.advanceTimersByTime(PASSKEY_NUDGE_DELAY_MS); });
    expect(screen.queryByRole("heading", { name: "Sign in faster with a passkey" })).toBeNull();
    expect(view.container.firstChild).toBeNull();
  });

  it("renders in the same place on desktop and phone Home", async () => {
    for (const desktop of [true, false]) {
      const { transport: live } = transport({ passkey: false, onboarding: { completed: 0, total: 2 }, snoozeDays: 28 });
      const { unmount } = render(<LanguageProvider><TodayView data={fallbackData} desktop={desktop} onPlanAction={() => {}} learningContent={live} homeNudges={{ onOpenOnboarding: vi.fn() }} /></LanguageProvider>);
      expect(await screen.findByRole("heading", { name: "Complete your onboarding" })).toBeTruthy();
      unmount();
      window.sessionStorage.clear();
      window.localStorage.clear();
    }
  });
});
