import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AltNowPage from "../src/alt/AltNowPage.jsx";
import { ChoosePasswordCard, choosePasswordFor } from "../src/features/memberHome/ChoosePasswordCard.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { TodayView } from "../src/views/TodayView.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { PASSWORD_ISSUED_KEY, createPasswordAuthUser, stageAuthUserPassword } from "../api/_lib/memberInvitations.js";

// REQ-UG-TEMPORARY-PASSWORD-CHANGE-PROMPT-20261018
const ISSUED = "2026-10-19T14:00:00.000Z";

function renderCard(props, lang = "en") {
  return render(<LanguageProvider lang={lang}><ChoosePasswordCard userId="member-1" onChoose={() => {}} {...props} /></LanguageProvider>);
}

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("choose-your-password Home card", () => {
  it("shows for a member still on the emailed password and sends them to the password form", () => {
    const onChoose = vi.fn();
    renderCard({ issuedAt: ISSUED, onChoose });
    expect(screen.getByRole("heading", { name: "Choose your own password" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Choose a password" }));
    expect(onChoose).toHaveBeenCalledTimes(1);
  });

  it("is absent once the password was changed (no marker)", () => {
    const { container } = renderCard({ issuedAt: null });
    expect(container).toBeEmptyDOMElement();
  });

  it("stays hidden after Not now, but a reissued password asks again", () => {
    const { rerender } = renderCard({ issuedAt: ISSUED });
    fireEvent.click(screen.getByRole("button", { name: "Not now: hide the password reminder" }));
    expect(screen.queryByRole("heading", { name: "Choose your own password" })).toBeNull();
    rerender(<LanguageProvider lang="en"><ChoosePasswordCard userId="member-1" issuedAt={ISSUED} /></LanguageProvider>);
    expect(screen.queryByRole("heading", { name: "Choose your own password" })).toBeNull();
    rerender(<LanguageProvider lang="en"><ChoosePasswordCard userId="member-1" issuedAt="2026-10-20T09:00:00.000Z" /></LanguageProvider>);
    expect(screen.getByRole("heading", { name: "Choose your own password" })).toBeInTheDocument();
  });

  it("keeps one nudge at a time: it goes first, and the regular nudge takes its place once it is gone", () => {
    const view = renderCard({ issuedAt: ISSUED, children: <p>regular nudge</p> });
    expect(screen.getByRole("heading", { name: "Choose your own password" })).toBeInTheDocument();
    expect(screen.queryByText("regular nudge")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Not now: hide the password reminder" }));
    expect(screen.getByText("regular nudge")).toBeInTheDocument();
    view.unmount();
    renderCard({ issuedAt: null, children: <p>regular nudge</p> });
    expect(screen.getByText("regular nudge")).toBeInTheDocument();
  });

  it("speaks Spanish", () => {
    renderCard({ issuedAt: ISSUED }, "es");
    expect(screen.getByRole("heading", { name: "Elige tu propia contraseña" })).toBeInTheDocument();
  });
});

describe("Home", () => {
  it.each([true, false])("shows the card on desktop and phone Home until it is dismissed (desktop=%s)", (desktop) => {
    const homeNudges = { onOpenOnboarding: vi.fn() };
    const choosePassword = { issuedAt: ISSUED, userId: "member-1", onChoose: vi.fn() };
    render(<LanguageProvider><TodayView data={fallbackData} desktop={desktop} onPlanAction={() => {}} homeNudges={homeNudges} choosePassword={choosePassword} /></LanguageProvider>);
    expect(screen.getByRole("heading", { name: "Choose your own password" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Not now: hide the password reminder" }));
    expect(screen.queryByRole("heading", { name: "Choose your own password" })).toBeNull();
  });
});

describe("Alternate Home and the App hand-off", () => {
  it("shows the card on the alternate Now page", () => {
    const data = {
      member: { id: "m1", fullName: "Alex Member", chapterId: "one", chapterName: "Chapter One" },
      events: [], planItems: [], broadcasts: [], tasks: [], notifications: [], conversations: [], cases: [],
      metrics: { openCases: 0 }, rights: { lessons: [] },
      rewards: { totalPoints: 1200, tierNumber: 2, tierName: "Builder", actionsYtd: 42 },
      rewardsCatalog: { tiers: [] }, weekly: { done: 3, goal: 5 },
    };
    render(<LanguageProvider lang="en"><AltNowPage data={data} chapters={[{ id: "one", name: "Chapter One" }]} selectedChapterId="one" choosePassword={{ issuedAt: ISSUED, userId: "member-1" }} /></LanguageProvider>);
    expect(screen.getByRole("heading", { name: "Choose your own password" })).toBeInTheDocument();
  });

  it("builds the Home props only from a session that carries the stamp, never in the preview", () => {
    const navigate = vi.fn();
    const session = { user: { id: "member-1", user_metadata: { union_ground_password_issued_at: ISSUED } } };
    const props = choosePasswordFor(session, false, navigate);
    expect(props).toMatchObject({ issuedAt: ISSUED, userId: "member-1" });
    props.onChoose();
    expect(navigate).toHaveBeenCalledWith("settings", "/m/settings/security");
    expect(choosePasswordFor(session, true, navigate)).toBeNull();
    expect(choosePasswordFor({ user: { id: "member-1", user_metadata: {} } }, false, navigate)).toBeNull();
    expect(choosePasswordFor({ user: { id: "member-1", user_metadata: { union_ground_password_issued_at: "" } } }, false, navigate)).toBeNull();
    expect(choosePasswordFor(null, false, navigate)).toBeNull();
    expect(choosePasswordFor({ user: { user_metadata: { union_ground_password_issued_at: ISSUED } } }, false, navigate).userId).toBeNull();
  });
});

describe("emailed-password marker", () => {
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });

  it("is stamped on the user created at invitation acceptance", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ id: "10000000-0000-4000-8000-000000000001" }));
    vi.stubGlobal("fetch", fetchMock);
    await createPasswordAuthUser("https://project.supabase.co", "service", {
      normalizedEmail: "a@example.org", fullName: "A", firstName: "A", initials: "A", chapterId: "c", invitationId: "i",
    }, "secret");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(Date.parse(body.user_metadata[PASSWORD_ISSUED_KEY])).not.toBeNaN();
    expect(body.user_metadata.union_base_invitation_id).toBe("i");
  });

  it("is re-stamped when an administrator reissues the password, without dropping other metadata keys", async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok({ id: "u" }));
    vi.stubGlobal("fetch", fetchMock);
    await stageAuthUserPassword("https://project.supabase.co", "service", { id: "u", app_metadata: {} }, "secret", "op");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(Object.keys(body.user_metadata)).toEqual([PASSWORD_ISSUED_KEY]);
    expect(Date.parse(body.user_metadata[PASSWORD_ISSUED_KEY])).not.toBeNaN();
  });
});
