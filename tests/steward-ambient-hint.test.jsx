// REQ-UG-STEWARD-AMBIENT-HINTS-20261001: the steward side of the old
// ambient knowledge hint.
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { STEWARD_HINTS_SWITCH, StewardAmbientHint, pickStewardHint } from "../src/features/memberHome/StewardAmbientHint.jsx";
import { catalogue } from "../src/lib/i18n.js";

// Built at runtime so the secret scanner does not read a JWT-shaped literal; payload is {"session_id":"s1"}.
const fakeJwtPayload = Buffer.from(JSON.stringify({ session_id: "s1" })).toString("base64").replace(/=+$/, "");
const session = { access_token: ["header", fakeJwtPayload, "sig"].join("."), user: { id: "steward-1" } };

function wiring(items, overrides = {}) {
  const listContent = vi.fn(async () => ({ items: items.map((item) => ({
    status: "published", locale_state: "reviewed", starts_at: "2026-01-01T00:00:00-05:00", ends_at: null, ...item,
  })), hasMore: false, dropped: 0 }));
  return {
    listContent,
    learningContent: { session, createSessionClient: () => ({ rpc: vi.fn() }), organizationId: "org-1", chapterId: "ch-1", locale: "en", override: { listContent }, ...overrides },
  };
}

const ON = { organizationConfiguration: { switches: { [STEWARD_HINTS_SWITCH]: true } } };

describe("pickStewardHint", () => {
  it("prefers a staff-audience item, then an everyone item, never a members-only one", () => {
    const all = { id: "a", title: "For everyone", audience: "all" };
    const staff = { id: "s", title: "For the committee", audience: "staff" };
    const members = { id: "m", title: "Members only", audience: "members" };
    expect(pickStewardHint([all, staff])).toBe(staff);
    expect(pickStewardHint([members, all])).toBe(all);
    expect(pickStewardHint([members])).toBeNull();
    expect(pickStewardHint(null)).toBeNull();
  });
});

describe("StewardAmbientHint", () => {
  it("shows one quiet hint from the learning library the steward can read", async () => {
    const { listContent, learningContent } = wiring([
      { id: "q", kind: "quote", title: "Listen first", body: "Ask what happened before you advise.", attribution: "Campaign training", audience: "staff" },
    ]);
    render(<LanguageProvider><StewardAmbientHint data={ON} learningContent={learningContent} /></LanguageProvider>);
    expect(await screen.findByRole("heading", { name: "Listen first" })).toBeTruthy();
    expect(screen.getByText("Committee hint")).toBeTruthy();
    expect(screen.getByText("Campaign training")).toBeTruthy();
    expect(listContent).toHaveBeenCalledWith({ chapterId: "ch-1", locale: "en", limit: 20 });
  });

  it("bounds a long lesson body", async () => {
    const { learningContent } = wiring([{ id: "l", kind: "mini_lesson", title: "Weingarten", body: "x".repeat(400), audience: "all" }]);
    render(<LanguageProvider><StewardAmbientHint data={ON} learningContent={learningContent} /></LanguageProvider>);
    await screen.findByRole("heading", { name: "Weingarten" });
    expect(screen.getByText(/^x+…$/).textContent).toHaveLength(281);
  });

  it("renders nothing with the switch off, without a chapter, or with nothing published", async () => {
    const off = wiring([{ id: "s", title: "Hint", audience: "staff" }]);
    const first = render(<LanguageProvider><StewardAmbientHint data={{ organizationConfiguration: { switches: { [STEWARD_HINTS_SWITCH]: false } } }} learningContent={off.learningContent} /></LanguageProvider>);
    expect(first.container.firstChild).toBeNull();
    expect(off.listContent).not.toHaveBeenCalled();
    const chapterless = wiring([{ id: "s", title: "Hint", audience: "staff" }], { chapterId: null });
    const second = render(<LanguageProvider><StewardAmbientHint data={ON} learningContent={chapterless.learningContent} /></LanguageProvider>);
    expect(second.container.firstChild).toBeNull();
    const empty = wiring([]);
    const third = render(<LanguageProvider><StewardAmbientHint data={ON} learningContent={empty.learningContent} /></LanguageProvider>);
    await waitFor(() => expect(empty.listContent).toHaveBeenCalled());
    expect(third.container.firstChild).toBeNull();
  });

  it("has Spanish copy for every English key", () => {
    const keys = Object.keys(catalogue.en).filter((key) => key.startsWith("stewardHint.") || key.startsWith(`settings.def.${STEWARD_HINTS_SWITCH}.`));
    expect(keys).toHaveLength(3);
    for (const key of keys) expect(catalogue.es[key], key).toBeTruthy();
  });
});
