import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { MessagesView } from "../src/views/MessagesView.jsx";
import { NoticeGlowControl } from "../src/features/chapterNotices/NoticeGlow.jsx";
import {
  CHAPTER_NOTICE_GLOWS, chapterNoticeGlow, createNoticeGlowApi, forgetNoticeChapters, loadNoticeChapters, noticeChaptersFor, noticeTileGlow,
} from "../src/features/chapterNotices/noticeGlow.js";

// REQ-UG-CHAPTER-NOTICE-GLOW-COLOURS-20261113 (#8627): a chapter's
// notices glow in the colour the chapter picks (green, blue, gold or violet);
// amber and red follow the notice, and the chapter's name is in the words.

function table(result, calls = []) {
  const chain = {
    select: () => chain, is: () => chain, order: () => chain, limit: () => chain,
    in: (...args) => { calls.push(["in", args]); return chain; },
    then: (resolve, reject) => Promise.resolve(result).then(resolve, reject),
  };
  return chain;
}

function fakeClient({ broadcasts = [], chapters = [], rpc = vi.fn() } = {}) {
  return {
    from: vi.fn((name) => table(name === "member_broadcasts" ? { data: broadcasts, error: null } : { data: chapters, error: null })),
    rpc,
  };
}

afterEach(() => cleanup());

describe("notice glow choices", () => {
  it("offers exactly the four chapter colours and falls back to green", () => {
    expect(CHAPTER_NOTICE_GLOWS).toEqual(["green", "blue", "gold", "violet"]);
    expect(chapterNoticeGlow("violet")).toBe("violet");
    for (const value of ["red", "amber", "", null, undefined, "Blue"]) expect(chapterNoticeGlow(value)).toBe("green");
  });

  it("lets urgency decide before the chapter, with the word that says it", () => {
    const chapter = { name: "Cedar chapter", glow: "gold" };
    expect(noticeTileGlow({}, chapter)).toEqual({ glow: "gold", breathe: false, wordKey: null });
    expect(noticeTileGlow({ urgent: true }, chapter)).toEqual({ glow: "red", breathe: true, wordKey: "noticeGlow.urgent" });
    expect(noticeTileGlow({ dueToday: true }, chapter)).toEqual({ glow: "amber", breathe: false, wordKey: "noticeGlow.dueToday" });
    expect(noticeTileGlow({}, null)).toBeNull();
    expect(noticeTileGlow({}, { name: "Cedar chapter", glow: "red" }).glow).toBe("green");
  });
});

describe("loading each notice's chapter", () => {
  it("names the chapter and colour of chapter notices only, from the same bounded broadcast read", async () => {
    const client = fakeClient({
      broadcasts: [
        { id: "b-1", chapter_id: "cedar", audience_scope: "chapter" },
        { id: "b-2", chapter_id: "cedar", audience_scope: "organization" },
        { id: "b-3", chapter_id: "gone", audience_scope: "chapter" },
        { id: "b-4", chapter_id: "birch", audience_scope: null },
      ],
      chapters: [{ id: "cedar", name: "Cedar chapter", notice_glow: "violet" }, { id: "birch", name: "Birch chapter", notice_glow: null }],
    });
    expect(await loadNoticeChapters(client)).toEqual({
      "b-1": { name: "Cedar chapter", glow: "violet" },
      "b-4": { name: "Birch chapter", glow: "green" },
    });
    expect(client.from.mock.calls.map(([name]) => name)).toEqual(["member_broadcasts", "chapters"]);
  });

  it("fails when either read fails, so the caller shows no glow", async () => {
    const client = { from: (name) => table(name === "chapters" ? { data: null, error: { code: "42703" } } : { data: [{ id: "b-1", chapter_id: "cedar", audience_scope: "chapter" }], error: null }) };
    await expect(loadNoticeChapters(client)).rejects.toMatchObject({ code: "42703" });
  });

  it("reads once per session, again for an announcement it did not cover, and after a colour change", async () => {
    const client = fakeClient({ broadcasts: [{ id: "b-1", chapter_id: "cedar", audience_scope: "chapter" }], chapters: [{ id: "cedar", name: "Cedar chapter", notice_glow: "blue" }] });
    expect(await noticeChaptersFor(client, ["b-1"], "member-a")).toEqual({ "b-1": { name: "Cedar chapter", glow: "blue" } });
    await noticeChaptersFor(client, ["b-1"], "member-a");
    expect(client.from).toHaveBeenCalledTimes(2);
    await noticeChaptersFor(client, ["b-1", "b-2"], "member-a");
    expect(client.from).toHaveBeenCalledTimes(4);
    forgetNoticeChapters();
    await noticeChaptersFor(client, ["b-1", "b-2"], "member-a");
    expect(client.from).toHaveBeenCalledTimes(6);
  });

  // The cache belongs to the member it was read for.
  it("never serves one member's read to another on the same client, and caches nothing without a member", async () => {
    let answer = { broadcasts: [{ id: "b-a", chapter_id: "cedar", audience_scope: "chapter" }], chapters: [{ id: "cedar", name: "Cedar chapter", notice_glow: "blue" }] };
    const client = { from: vi.fn((name) => table(name === "member_broadcasts" ? { data: answer.broadcasts, error: null } : { data: answer.chapters, error: null })) };
    expect(await noticeChaptersFor(client, ["b-a"], "member-a")).toEqual({ "b-a": { name: "Cedar chapter", glow: "blue" } });
    // Another member signs in on the same client: their own read, never member A's.
    answer = { broadcasts: [{ id: "b-b", chapter_id: "birch", audience_scope: "chapter" }], chapters: [{ id: "birch", name: "Birch chapter", notice_glow: "gold" }] };
    expect(await noticeChaptersFor(client, ["b-a"], "member-b")).toEqual({ "b-b": { name: "Birch chapter", glow: "gold" } });
    expect(client.from).toHaveBeenCalledTimes(4);
    // Without a member nothing is kept: each call reads.
    forgetNoticeChapters();
    await noticeChaptersFor(client, ["b-b"]);
    await noticeChaptersFor(client, ["b-b"]);
    expect(client.from).toHaveBeenCalledTimes(8);
  });

  // Only the chapters the notices name are read, so the
  // API's 1,000-row cap cannot cut the lookup short.
  it("reads only the chapters the notices name, and none for organization-wide notices", async () => {
    const calls = [];
    const client = { from: vi.fn((name) => table(name === "member_broadcasts"
      ? { data: [{ id: "b-1", chapter_id: "cedar", audience_scope: "chapter" }, { id: "b-2", chapter_id: "cedar", audience_scope: "chapter" }, { id: "b-3", chapter_id: "birch", audience_scope: "organization" }], error: null }
      : { data: [{ id: "cedar", name: "Cedar chapter", notice_glow: "blue" }], error: null }, calls)) };
    await loadNoticeChapters(client);
    expect(calls).toEqual([["in", ["id", ["cedar"]]]]);
    const none = { from: vi.fn((name) => table(name === "member_broadcasts" ? { data: [{ id: "b-3", chapter_id: "birch", audience_scope: "organization" }], error: null } : { data: [], error: null })) };
    expect(await loadNoticeChapters(none)).toEqual({});
    expect(none.from.mock.calls.map(([name]) => name)).toEqual(["member_broadcasts"]);
  });

  it("calls the two chapter-setting functions by name", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "blue", error: null });
    const api = createNoticeGlowApi({ rpc });
    await api.save("cedar", "blue");
    await api.load("cedar");
    expect(rpc.mock.calls).toEqual([
      ["set_chapter_notice_glow", { p_chapter_id: "cedar", p_colour: "blue" }],
      ["get_chapter_notice_glow", { p_chapter_id: "cedar" }],
    ]);
    expect(createNoticeGlowApi(null)).toBeNull();
  });
});

describe("the chapter's notice colour setting", () => {
  function settingClient(state, { refuse = false } = {}) {
    return {
      rpc: vi.fn(async (name, args) => {
        if (name === "get_chapter_notice_glow") return { data: { chapterId: args.p_chapter_id, glow: state.glow, canChange: state.canChange }, error: null };
        if (refuse) return { data: null, error: { code: "42501" } };
        state.glow = args.p_colour;
        return { data: args.p_colour, error: null };
      }),
    };
  }
  const show = (client, lang = "en") => render(<LanguageProvider lang={lang}><NoticeGlowControl client={client} chapterId="cedar" /></LanguageProvider>);

  it("is not offered to someone who cannot publish the chapter's announcements, or when the read is refused", async () => {
    const client = settingClient({ glow: "green", canChange: false });
    const { container } = show(client);
    await waitFor(() => expect(client.rpc).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
    cleanup();
    const refused = { rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "42501" } }) };
    const second = show(refused);
    await waitFor(() => expect(refused.rpc).toHaveBeenCalled());
    expect(second.container).toBeEmptyDOMElement();
  });

  it("offers the four named colours, saves the choice and shows the saved colour", async () => {
    const state = { glow: "green", canChange: true };
    const client = settingClient(state);
    show(client);
    const group = await screen.findByRole("group", { name: "Notice colour" });
    const radios = ["Green", "Blue", "Gold", "Violet"].map((name) => screen.getByRole("radio", { name }));
    expect(radios.map((radio) => radio.value)).toEqual(["green", "blue", "gold", "violet"]);
    expect(radios[0]).toBeChecked();
    expect(group.textContent).not.toMatch(/\b(Red|Amber)\b/u);
    fireEvent.click(screen.getByRole("radio", { name: "Violet" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Notice colour saved.");
    expect(screen.getByRole("radio", { name: "Violet" })).toBeChecked();
    expect(client.rpc).toHaveBeenCalledWith("set_chapter_notice_glow", { p_chapter_id: "cedar", p_colour: "violet" });
  });

  it("says so when the save is refused and keeps the stored colour", async () => {
    const client = settingClient({ glow: "blue", canChange: true }, { refuse: true });
    show(client);
    fireEvent.click(await screen.findByRole("radio", { name: "Gold" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The notice colour was not saved.");
    expect(screen.getByRole("radio", { name: "Blue" })).toBeChecked();
  });

  it("speaks Spanish", async () => {
    show(settingClient({ glow: "gold", canChange: true }), "es");
    expect(await screen.findByRole("group", { name: "Color de los avisos" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Dorado" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Violeta" })).toBeInTheDocument();
  });
});

describe("a chapter notice in Messages", () => {
  const broadcast = { id: "b-1", title: "July chapter meeting", sender: "Chapter steward", body: "Thursday 6pm at the hall.", unread: false, publishedAt: "2026-07-10T18:00:00.000Z" };
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, "", "/m/messages?broadcast=b-1");
  });
  afterEach(() => window.history.replaceState({}, "", "/"));
  const show = ({ client = null, noticeChapters, lang = "en", desktop = true } = {}) => render(
    <LanguageProvider lang={lang}>
      <MessagesView
        desktop={desktop}
        data={{ member: { id: "member-1" }, conversations: [], broadcasts: [broadcast], product: { spaces: [], documents: [] }, ...(noticeChapters ? { noticeChapters } : {}) }}
        onSendMessage={vi.fn()}
        onReadConversation={vi.fn().mockResolvedValue(null)}
        onReadBroadcast={vi.fn().mockResolvedValue(null)}
        onOpenTopics={vi.fn()}
        engagementClient={client}
      />
    </LanguageProvider>,
  );

  it("glows in the chapter's colour and names the chapter in text", async () => {
    const client = fakeClient({
      broadcasts: [{ id: "b-1", chapter_id: "cedar", audience_scope: "chapter" }],
      chapters: [{ id: "cedar", name: "Cedar chapter", notice_glow: "gold" }],
    });
    show({ client });
    const from = await screen.findByText("From Cedar chapter");
    const tile = from.closest("article");
    expect(tile).toHaveClass("notice-glow");
    expect(tile).toHaveAttribute("data-glow", "gold");
    expect(tile).not.toHaveAttribute("data-glow-breathe");
    expect(tile).toHaveTextContent("Thursday 6pm at the hall.");
  });

  // The view keeps its loaded colours with the member
  // they were read for, so a member change on the same view never shows them.
  it("never shows one member's loaded colours to the next member on the same view", async () => {
    const first = fakeClient({ broadcasts: [{ id: "b-1", chapter_id: "cedar", audience_scope: "chapter" }], chapters: [{ id: "cedar", name: "Cedar chapter", notice_glow: "gold" }] });
    const pendingRead = { from: vi.fn(() => ({ select: () => pendingRead.chain, then: () => {} })), chain: null };
    pendingRead.chain = { is: () => pendingRead.chain, order: () => pendingRead.chain, limit: () => pendingRead.chain, in: () => pendingRead.chain, then: () => {} };
    const page = (member, client) => (
      <LanguageProvider lang="en">
        <MessagesView desktop data={{ member: { id: member }, conversations: [], broadcasts: [broadcast], product: { spaces: [], documents: [] } }}
          onSendMessage={vi.fn()} onReadConversation={vi.fn().mockResolvedValue(null)} onReadBroadcast={vi.fn().mockResolvedValue(null)} onOpenTopics={vi.fn()} engagementClient={client} />
      </LanguageProvider>
    );
    const view = render(page("member-a", first));
    expect(await screen.findByText("From Cedar chapter")).toBeInTheDocument();
    // The next member's read has not answered yet.
    view.rerender(page("member-b", pendingRead));
    await waitFor(() => expect(screen.queryByText("From Cedar chapter")).toBeNull());
    expect(document.querySelector("article[data-glow]")).toBeNull();
  });

  it("names the chapter in Spanish", async () => {
    show({ noticeChapters: { "b-1": { name: "Cedar chapter", glow: "violet" } }, lang: "es" });
    const from = await screen.findByText("De Cedar chapter");
    expect(from.closest("article")).toHaveAttribute("data-glow", "violet");
  });

  it("glows in the phone's announcement dialog too", async () => {
    show({ noticeChapters: { "b-1": { name: "Cedar chapter", glow: "blue" } }, desktop: false });
    const from = await screen.findByText("From Cedar chapter");
    expect(from.closest(".app-dialog__body article")).toHaveAttribute("data-glow", "blue");
  });

  it("keeps an organization-wide notice, or one whose chapter cannot be read, without a glow", async () => {
    const client = fakeClient({
      broadcasts: [{ id: "b-1", chapter_id: "cedar", audience_scope: "organization" }],
      chapters: [{ id: "cedar", name: "Cedar chapter", notice_glow: "gold" }],
    });
    show({ client });
    // No notice names a chapter, so no chapter lookup is read.
    await waitFor(() => expect(client.from).toHaveBeenCalledTimes(1));
    const tile = await waitFor(() => { const found = document.querySelector("article.broadcast-detail"); expect(found).not.toBeNull(); return found; });
    expect(tile).not.toHaveAttribute("data-glow");
    expect(screen.queryByText(/^From /u)).toBeNull();
  });
});

describe("the glow drawing", () => {
  const css = readFileSync("src/features/chapterNotices/noticeGlow.css", "utf8");
  const tokens = readFileSync("src/sg-tokens.css", "utf8");

  it("takes the promo package's glow colours and strengths", () => {
    const values = { green: "#1a7a52", blue: "#1473e6", gold: "#efa738", violet: "#7d3fb5", amber: "#f08a24", red: "#e5262f" };
    for (const [name, hex] of Object.entries(values)) {
      expect(tokens).toContain(`--sg-light-glow-${name}: ${hex};`);
    }
    for (const [name, strength] of Object.entries({ green: 40, blue: 40, gold: 46, violet: 40, amber: 38, red: 46 })) {
      expect(css).toContain(`.notice-glow[data-glow="${name}"] { --glow: var(--sg-light-glow-${name}); --glow-fill: var(--sg-light-glow-${name}-fill); --glow-strength: ${strength}%; }`);
    }
  });

  it("draws the border, ring and outer light, breathes red on 2.8 seconds and stops under reduced motion", () => {
    expect(css).toContain("border: 1px solid color-mix(in srgb, var(--glow) 62%, var(--notice-glow-line));");
    expect(css).toContain("box-shadow: 0 0 0 1px color-mix(in srgb, var(--glow) 30%, transparent), 0 0 20px 3px color-mix(in srgb, var(--glow) var(--glow-strength), transparent);");
    expect(css).toContain(".notice-glow[data-glow-breathe] { animation: notice-glow-breathe 2.8s ease-in-out infinite alternate; }");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.notice-glow\[data-glow-breathe\] \{ animation: none; \}/u);
  });
});
