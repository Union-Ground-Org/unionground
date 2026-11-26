import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { MessagesView } from "../src/views/MessagesView.jsx";
import { OfficerNoticeDesk } from "../src/features/notices/OfficerNoticeDesk.jsx";

// REQ-UG-MESSAGES-COMPOSER-LAYOUT-20261102: on the classic desktop
// split the notice composer was squeezed into the list column under the
// Announcements filter while the reading pane sat empty, with the product
// updates stacked beneath it. Both now open in the pane from entry points in
// the list; the phone and the alternate shell keep their own layouts.

const broadcast = { id: "b-1", title: "July chapter meeting", sender: "Tamarack Local 100", body: "Thursday 6pm at the hall.", unread: false, publishedAt: "2026-07-10T18:00:00.000Z" };
const update = { id: "delivery", announcementId: "release", revision: 1, title: "Product release", body: "New product controls", publishedAt: "2026-10-29T10:00:00-04:00", expiresAt: "2099-10-29T10:00:00-04:00" };

function noticeApi() {
  return {
    loadAudiences: vi.fn().mockResolvedValue([{ value: "chapter", kind: "chapter", name: "My unit" }]),
    publish: vi.fn().mockResolvedValue({ broadcastId: "bc-2" }),
    listMine: vi.fn().mockResolvedValue({ notices: [], hasMore: false }),
    receipts: vi.fn().mockResolvedValue({ readCount: 0, audienceCount: 0, readers: [] }),
    listDrafts: vi.fn().mockResolvedValue([]),
    resolveDraft: vi.fn().mockResolvedValue({}),
  };
}

function updatesContext() {
  const rpc = vi.fn().mockImplementation(async (_name, args) => args.p_action === "list_my_platform_announcements"
    ? { data: { items: [update], generation: 1, hidden: false }, error: null }
    : { data: null, error: { code: "42501" } });
  return {
    session: { user: { id: "member-1" }, access_token: `header.${btoa(JSON.stringify({ session_id: "announcements" }))}.signature` },
    organizationId: "organization", chapterId: "chapter", hat: "steward", createClient: () => ({ rpc }),
  };
}

function show({ desktop = true, officer = true, context = updatesContext(), lang = "en" } = {}) {
  const api = noticeApi();
  render(
    <LanguageProvider lang={lang}>
      <MessagesView
        desktop={desktop}
        data={{ member: { id: "member-1" }, conversations: [], broadcasts: [broadcast], product: { spaces: [], documents: [] } }}
        onSendMessage={vi.fn()}
        onReadConversation={vi.fn().mockResolvedValue(null)}
        onReadBroadcast={vi.fn().mockResolvedValue(null)}
        onOpenTopics={vi.fn()}
        staffAccess
        announcementContext={context}
        noticeDesk={officer ? <OfficerNoticeDesk api={api} chapterAudienceLabel="My unit" /> : null}
      />
    </LanguageProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: lang === "es" ? /^Comunicados/ : /^Announcements/ }));
  return api;
}

const pane = () => screen.getByRole("region", { name: "Message detail" });
const list = () => document.querySelector(".inbox-panel");
const actions = () => within(screen.getByRole("group", { name: "Announcement actions" }));

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, "", "/m/messages");
});
afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

describe("Announcements on the classic desktop split", () => {
  it("opens the notice composer in the reading pane, not the list column", async () => {
    show();
    const composer = await within(pane()).findByRole("form", { name: "Post a notice" });
    expect(composer).toBeVisible();
    expect(within(list()).queryByRole("form", { name: "Post a notice" })).toBeNull();
    expect(within(pane()).queryByText("Your messages")).toBeNull();
    expect(actions().getByRole("button", { name: "Post a notice" })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps the audience choice beside its label with a selected state", async () => {
    show();
    const audience = within(pane()).getByRole("group", { name: "Who receives it" });
    const unit = await within(audience).findByRole("radio", { name: "My unit" });
    expect(unit).toBeChecked();
    expect(unit.closest("label")).toHaveTextContent("My unit");
  });

  it("moves product updates to their own entry point and keeps an unsent notice across them", async () => {
    show();
    const title = within(pane()).getByLabelText("Title");
    fireEvent.change(title, { target: { value: "Shift swap rules" } });
    expect(within(list()).queryByText(update.body)).toBeNull();

    fireEvent.click(actions().getByRole("button", { name: "Union Ground updates" }));
    expect(await within(pane()).findByText(update.body)).toBeInTheDocument();
    expect(within(pane()).queryByRole("form", { name: "Post a notice" })).toBeNull();
    expect(actions().getByRole("button", { name: "Union Ground updates" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(actions().getByRole("button", { name: "Post a notice" }));
    expect(within(pane()).getByLabelText("Title")).toHaveValue("Shift swap rules");
  });

  it("reads an opened announcement in the pane and returns to the composer from its entry point", async () => {
    show();
    fireEvent.change(within(pane()).getByLabelText("Title"), { target: { value: "Draft kept" } });
    fireEvent.click(within(list()).getByRole("button", { name: /July chapter meeting/ }));
    expect(within(pane()).getByText(broadcast.body)).toBeInTheDocument();
    expect(within(pane()).queryByRole("form", { name: "Post a notice" })).toBeNull();
    expect(actions().getByRole("button", { name: "Post a notice" })).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(actions().getByRole("button", { name: "Post a notice" }));
    expect(within(pane()).queryByText(broadcast.body)).toBeNull();
    expect(within(pane()).getByLabelText("Title")).toHaveValue("Draft kept");
  });

  it("publishes from the pane", async () => {
    const api = show();
    fireEvent.change(within(pane()).getByLabelText("Title"), { target: { value: "Shift swap rules" } });
    fireEvent.change(within(pane()).getByLabelText("Notice"), { target: { value: "Read before Friday" } });
    await waitFor(() => expect(within(pane()).getByRole("button", { name: "Post notice" })).toBeEnabled());
    fireEvent.click(within(pane()).getByRole("button", { name: "Post notice" }));
    await waitFor(() => expect(api.publish).toHaveBeenCalledWith("Shift swap rules", "Read before Friday", "en", "chapter", expect.any(String)));
  });

  it("shows a member without a composer the product updates in the pane", async () => {
    show({ officer: false });
    expect(await within(pane()).findByText(update.body)).toBeInTheDocument();
    expect(actions().queryByRole("button", { name: "Post a notice" })).toBeNull();
  });

  it("offers no entry point that would open an empty pane", () => {
    show({ officer: false, context: null });
    expect(screen.queryByRole("group", { name: "Announcement actions" })).toBeNull();
    expect(within(pane()).getByText("Your messages")).toBeInTheDocument();
  });

  it("names the entry points in Spanish", async () => {
    show({ lang: "es" });
    expect(screen.getByRole("group", { name: "Acciones de anuncios" })).toBeInTheDocument();
  });
});

describe("Announcements on the phone", () => {
  it("keeps the composer and product updates in the list", async () => {
    show({ desktop: false });
    expect(within(list()).getByRole("form", { name: "Post a notice" })).toBeVisible();
    expect(await within(list()).findByText(update.body)).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Announcement actions" })).toBeNull();
  });
});
