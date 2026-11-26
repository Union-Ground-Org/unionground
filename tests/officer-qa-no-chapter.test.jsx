import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NoChapterYetNotice } from "../src/components/NoChapterYetNotice.jsx";
import { WorkspacePages } from "../src/components/WorkspacePages.jsx";
import { OfficerQaQueue, isQaOfficerWithoutChapter } from "../src/features/qa/OfficerQaQueue.jsx";
import { canSeeOfficerQaQueue } from "../src/features/qa/authorization.js";
import { t } from "../src/lib/i18n.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { buildQaActor } from "../src/lib/mi1QaWiring.js";
import { OfficerQaView } from "../src/views/OfficerQaView.jsx";

// BUG-UG-NO-CHAPTER-PAGES-GO-BLANK-OR-BLAME-PERMISSIONS-20261122
// (#9594, D1-14): the Admin rail offers Q&A queue, and for a new
// organization's founder, who holds the Administrator role and is in no
// chapter yet, the whole page was "You cannot do that in this role." It now
// says there are no member questions yet and why, once the membership read
// has answered.

afterEach(cleanup);

// The founder as the fixture app builds the Q&A actor (App.jsx qaActor):
// the worn hat is the chapter grant and there is no chapter.
const founder = buildQaActor({
  userId: "founder-a",
  organizationId: "org-new",
  chapterId: null,
  roles: ["admin"],
  chapterRoles: ["admin"],
  mfaSatisfied: true,
  selectedHat: "admin",
});

const NO_CHAPTER_EN = "No worker questions yet. Workers ask their questions inside a campaign, and you are not in a campaign yet, so none can reach this queue.";
const FORBIDDEN_EN = "You cannot do that in this role.";

function renderQueuePage({ actor = founder, lang = "en", navigate = vi.fn() } = {}) {
  window.history.replaceState({}, "", "/m/qa-queue");
  const api = { officerQueue: vi.fn().mockResolvedValue({ ok: true, value: [] }) };
  render(
    <LanguageProvider lang={lang}>
      <WorkspacePages view="qaQueue" hat={actor.selectedHat} location={window.location.href} navigate={navigate}>
        <OfficerQaView lang={lang} actor={actor} client={null} api={api} />
      </WorkspacePages>
    </LanguageProvider>,
  );
  return { navigate, api };
}

describe("Q&A queue for an officer who is in no chapter yet (#9594 D1-14)", () => {
  it("tells the founder on the Admin hat why the queue is empty, not that the role cannot do it", async () => {
    renderQueuePage();
    expect(await screen.findByText(NO_CHAPTER_EN)).toBeInTheDocument();
    expect(screen.queryByText(FORBIDDEN_EN)).not.toBeInTheDocument();
    // It grants nothing: no reply box and no question list. And no link:
    // Organization & campaigns refuses a reader with no chapter on a live
    // backend (get_admin_org_structure needs the caller's chapter), so a link
    // there would lead to "could not be loaded".
    expect(screen.queryByLabelText("Post official reply")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Questions waiting" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("says the same in Spanish", async () => {
    renderQueuePage({ lang: "es" });
    expect(await screen.findByText(t("es", "steward.qaQueueNoChapter"))).toBeInTheDocument();
    expect(t("es", "steward.qaQueueNoChapter")).not.toBe(NO_CHAPTER_EN);
    expect(screen.queryByText(t("es", "qa.forbidden"))).not.toBeInTheDocument();
  });

  // Live, the page's bootstrap actor is only a guess until the membership read
  // (get_my_chapter_memberships) answers. A founder with an organization and
  // no chapter gets one organization-level row with chapterId null
  // (migration 20261103112000). Pending or failed, nothing proves there is no
  // chapter, so the sentence waits; Main's refusal line stays meanwhile.
  it("shows the sentence only after the membership read answers, never while it is pending or after it failed", async () => {
    const api = { officerQueue: vi.fn().mockResolvedValue({ ok: true, value: [] }) };
    const view = (client) => (
      <LanguageProvider lang="en">
        <OfficerQaView lang="en" actor={founder} client={client} api={api} />
      </LanguageProvider>
    );
    const settle = [];
    const pending = { rpc: () => new Promise((resolve) => settle.push(resolve)) };
    const { unmount } = render(view(pending));
    await screen.findByText(FORBIDDEN_EN);
    expect(screen.queryByText(NO_CHAPTER_EN)).not.toBeInTheDocument();
    await act(async () => {
      settle[0]({
        data: [{ chapterId: null, selected: true, organizationId: "org-new", organizationRoles: ["admin"], chapterRoles: [] }],
        error: null,
      });
    });
    expect(await screen.findByText(NO_CHAPTER_EN)).toBeInTheDocument();
    unmount();

    for (const failed of [
      { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "timeout" } }) },
      { rpc: vi.fn().mockRejectedValue(new Error("offline")) },
    ]) {
      const rendered = render(view(failed));
      await waitFor(() => expect(failed.rpc).toHaveBeenCalled());
      await act(async () => {});
      expect(screen.getByText(FORBIDDEN_EN)).toBeInTheDocument();
      expect(screen.queryByText(NO_CHAPTER_EN)).not.toBeInTheDocument();
      rendered.unmount();
    }
  });

  // At 320 px the label is wider than the card, and a plain xus-btn does not
  // wrap: on Main the notice's link ran about 40 px past the card's edge on
  // Invite a worker.
  it("draws the admin no-chapter notice's link as a wrapping button", () => {
    render(<NoChapterYetNotice />);
    expect(screen.getByRole("link", { name: "Add a campaign in Organization & campaigns" })).toHaveClass("xus-btn", "xus-btn--wrap");
  });


  it("still refuses a member with no officer grant, and anyone missing two-step sign-in or an active membership", () => {
    const member = buildQaActor({ userId: "m-1", organizationId: "org-new", chapterId: null, mfaSatisfied: true });
    const noMfa = { ...founder, mfaSatisfied: false };
    const revoked = { ...founder, membershipStatus: "revoked" };
    for (const actor of [member, noMfa, revoked]) {
      expect(isQaOfficerWithoutChapter(actor)).toBe(false);
      const { unmount } = render(<OfficerQaQueue actor={actor} />);
      expect(screen.getByText(FORBIDDEN_EN)).toBeInTheDocument();
      expect(screen.queryByText(NO_CHAPTER_EN)).not.toBeInTheDocument();
      unmount();
    }
  });

  it("leaves an officer who is in a chapter on the queue itself", () => {
    const inChapter = { ...founder, chapterId: "ch-1" };
    expect(canSeeOfficerQaQueue(inChapter)).toBe(true);
    expect(isQaOfficerWithoutChapter(inChapter)).toBe(false);
    render(<OfficerQaQueue actor={inChapter} questions={[]} />);
    expect(screen.getByRole("heading", { name: "Questions waiting" })).toBeInTheDocument();
    expect(screen.queryByText(NO_CHAPTER_EN)).not.toBeInTheDocument();
  });
});
