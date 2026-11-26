import { readFileSync } from "node:fs";
import { useRef } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import AltShell from "../src/alt/AltShell.jsx";
import AltCalendar from "../src/alt/AltCalendar.jsx";
import AltMarquee from "../src/alt/AltMarquee.jsx";
import AltTimeline from "../src/alt/AltTimeline.jsx";
import { TYPE_CALM_MS, TYPE_ERASE_MS, TYPE_HOLD_MS, TYPE_LETTER_MS, TYPE_REST_MS, TooltipLayer, Typewriter } from "../src/alt/motion.jsx";
import { RECORD_TYPES, dayIndex, itemsInLastDays, recordItems, recordTarget, timelineDaysFor } from "../src/alt/recordIndex.js";
import { dueSoonCount, workTab } from "../src/alt/tabbar.js";
import { altShellCatalogue } from "../src/lib/i18n/altShell.js";
import { eventTypeText } from "../src/lib/i18n/eventTypes.js";

// REQ-UG-ALT-PORT-SHELL-MOTION-HOME-20261030: the prototype's motion
// system, phone tab bar and Home widgets, ported onto the member's own record.

const NOW = new Date(2026, 9, 15, 12, 0, 0);
const inLang = (node, lang = "en") => <LanguageProvider lang={lang}>{node}</LanguageProvider>;
const realMatchMedia = window.matchMedia;

function stubMedia({ wide = true, reduce = false } = {}) {
  window.matchMedia = vi.fn((query) => ({
    matches: query.includes("reduced-motion") ? reduce : wide,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

const DATA = {
  broadcasts: [{ id: "b1", title: "Contract ratified", sender: "Chapter office", publishedAt: "2026-10-14T15:00:00Z" }],
  events: [
    { id: "e1", title: "Steward huddle", startsAt: "2026-10-15T19:00:00Z", chapterName: "North", location: "Hall", checkedIn: false },
    { id: "e2", title: "Open forum", startsAt: "2026-10-02T19:00:00Z", chapterName: "North", checkedIn: true },
    { id: "e3", title: "Cancelled", startsAt: "2026-10-03T19:00:00Z", cancelledAt: "2026-10-01T00:00:00Z" },
    { id: "e4", title: "Picnic", eventDate: "2026-10-20" },
    { id: "e5", title: "Safety walk", startsAt: "2026-10-08T15:00:00Z", chapterName: "North", checkedIn: false },
  ],
  planItems: [{ id: "p1", kind: "ballot", title: "Ratify", closesAt: "2026-10-16T21:00:00Z" }, { id: "p2", kind: "task", title: "Not a vote" }],
  cases: [{ id: "c1", title: "Overtime", updates: [{ id: "u1", body: "Filed", created_at: "2026-10-10T14:00:00Z" }] }],
};

beforeEach(() => { stubMedia(); });
afterEach(() => { window.matchMedia = realMatchMedia; vi.useRealTimers(); });

describe("recordIndex", () => {
  it("opens each record where it lives: the broadcast itself, an open ballot's choice, a closed ballot's result", () => {
    // BUG-UG-ALT-UPDATES-CARDS-OPEN-NOTHING-20261102: an update used to
    // open the inbox with no broadcast, and a closed ballot called the choice
    // dialog, which refuses closed ballots, so the card did nothing.
    expect(recordTarget({ type: "update", source: { id: "b1" } })).toEqual({ broadcastId: "b1" });
    const open = { id: "p1", kind: "ballot" };
    expect(recordTarget({ type: "vote", source: open })).toEqual({ planItem: open });
    expect(recordTarget({ type: "vote", source: { id: "p2", kind: "ballot", closed: true } })).toEqual({ navigate: ["voting", "/m/voting/past"] });
    expect(recordTarget({ type: "event", source: { id: "e 1" } })).toEqual({ navigate: ["events", "/m/events?event=e%201"] });
    expect(recordTarget({ type: "case", source: { id: "c1" } })).toEqual({ navigate: ["cases", "/m/cases", { view: "cases", caseId: "c1" }] });
  });

  it("wires the alternate shell's record opener to recordTarget and the Now page's broadcast focus", () => {
    const app = readFileSync("src/App.jsx", "utf8");
    const opener = app.slice(app.indexOf("const openAltRecord = (item) => {"), app.indexOf("const altPageProps"));
    expect(opener).toContain("const target = recordTarget(item);");
    expect(opener).toContain("homeTakeover.onOpenBroadcast(target.broadcastId)");
    expect(opener).not.toContain('navigate("messages", "/m/messages")');
    expect(app).toContain('onOpenBroadcast: (broadcastId) => navigate("messages", "/m/messages", { view: "messages", broadcastId }),');
  });

  it("indexes broadcasts, events, ballots and case notes, never cancelled events or other plan items", () => {
    const items = recordItems(DATA);
    expect(items.map((item) => item.id)).toEqual(["event-e2", "event-e5", "case-c1-u1", "update-b1", "event-e1", "vote-p1", "event-e4"]);
    expect(items.find((item) => item.id === "event-e4").at.getHours()).toBe(12);
    expect(recordItems(null)).toEqual([]);
    expect(recordItems({ broadcasts: [{ id: "x", publishedAt: "not a date" }], events: [{ id: "y" }] })).toEqual([]);
    const map = dayIndex(items);
    expect(map.get(new Date(2026, 9, 2).getTime()).map((item) => item.id)).toEqual(["event-e2"]);
    expect(itemsInLastDays(items, 30, NOW).map((item) => item.id)).toEqual(["event-e2", "event-e5", "case-c1-u1", "update-b1", "event-e1"]);
    expect([timelineDaysFor(500), timelineDaysFor(900), timelineDaysFor(1400)]).toEqual([30, 60, 90]);
  });
});

describe("tab bar Work entry", () => {
  const tasks = [
    { id: "t1", status: "open", dueDate: "2026-10-16", assigneeIds: ["me"] },
    { id: "t2", status: "open", dueDate: "2026-10-10", assigneeId: "me" },
    { id: "t3", status: "done", dueDate: "2026-10-16", assigneeIds: ["me"] },
    { id: "t4", status: "open", dueDate: "2026-10-30", assigneeIds: ["me"] },
    { id: "t5", status: "open", dueDate: "2026-10-16", assigneeIds: ["someone"] },
    { id: "t6", status: "open", assigneeIds: ["me"] },
  ];
  it("counts the member's open tasks due by the day after tomorrow, overdue included", () => {
    expect(dueSoonCount(tasks, "me", NOW)).toBe(2);
    expect(dueSoonCount(tasks, null, NOW)).toBe(0);
    expect(dueSoonCount(null, "me", NOW)).toBe(0);
  });
  it("is offered only to an account whose roles open the Tasks tool", () => {
    expect(workTab({ roles: [], tasks, memberId: "me", now: NOW })).toBeNull();
    expect(workTab({ roles: ["member"], tasks, memberId: "me", now: NOW })).toBeNull();
    expect(workTab({ roles: ["steward"], tasks, memberId: "me", now: NOW })).toEqual({ viewKey: "tasks", path: "/m/tasks", badge: 2 });
    expect(workTab({ roles: ["steward"], tasks: [], memberId: "me", now: NOW }).badge).toBeNull();
    expect(workTab()).toBeNull();
  });
});

describe("Typewriter", () => {
  it("holds, erases, rests and types each word in turn", () => {
    vi.useFakeTimers();
    const { container } = render(<Typewriter words={["North", "Bay"]} />);
    const word = () => container.querySelector(".ug-type-word").textContent;
    expect(container.querySelector(".ug-tw")).toHaveAttribute("aria-hidden", "true");
    expect([...container.querySelectorAll(".ug-tw-size span")].map((node) => node.textContent)).toEqual(["North", "Bay"]);
    expect(word()).toBe("North");
    expect(container.querySelector(".ug-caret")).not.toBeNull();
    act(() => { vi.advanceTimersByTime(TYPE_HOLD_MS); });
    expect(word()).toBe("Nort");
    for (let step = 0; step < 4; step += 1) act(() => { vi.advanceTimersByTime(TYPE_ERASE_MS); });
    expect(word()).toBe("");
    act(() => { vi.advanceTimersByTime(TYPE_REST_MS); });
    act(() => { vi.advanceTimersByTime(TYPE_LETTER_MS); });
    expect(word()).toBe("B");
    act(() => { vi.advanceTimersByTime(TYPE_LETTER_MS); });
    act(() => { vi.advanceTimersByTime(TYPE_LETTER_MS); });
    expect(word()).toBe("Bay");
  });

  it("swaps whole words without typing under reduced motion, and draws one word still", () => {
    vi.useFakeTimers();
    stubMedia({ reduce: true });
    const { container, rerender } = render(<Typewriter words={["North", "Bay"]} />);
    expect(container.querySelector(".ug-caret")).toBeNull();
    act(() => { vi.advanceTimersByTime(TYPE_CALM_MS); });
    expect(container.querySelector(".ug-type-word").textContent).toBe("Bay");
    rerender(<Typewriter words={["Solo"]} />);
    act(() => { vi.advanceTimersByTime(TYPE_CALM_MS * 2); });
    expect(container.querySelector(".ug-type-word").textContent).toBe("Solo");
    rerender(<Typewriter words={[]} />);
    expect(container.querySelector(".ug-tw")).toBeNull();
  });
});

describe("TooltipLayer", () => {
  function Host() {
    const ref = useRef(null);
    return (
      <div className="ugalt">
        <span ref={ref} />
        <button type="button" data-tip="Oct 14: Updates" data-tip-sub="Contract ratified">tick</button>
        <button type="button">plain</button>
        <TooltipLayer rootRef={ref} />
      </div>
    );
  }
  it("shows the data-tip on hover or focus and hides it on leave, focus elsewhere and scroll", () => {
    render(<><Host /><button type="button" data-tip="outside">outside</button></>);
    const tick = screen.getByText("tick");
    fireEvent.pointerOver(tick);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Oct 14: UpdatesContract ratified");
    expect(screen.getByRole("tooltip")).toHaveClass("ug-on");
    fireEvent.pointerOut(tick);
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.focusIn(tick);
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.focusIn(screen.getByText("plain"));
    expect(screen.queryByRole("tooltip")).toBeNull();
    // A data-tip outside the alternate shell is not this layer's.
    fireEvent.pointerOver(screen.getByText("outside"));
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.focusIn(tick);
    fireEvent.scroll(window);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });
});

describe("AltTimeline", () => {

  it("says when nothing is on the record and draws plain row names without a handler", () => {
    render(inLang(<AltTimeline items={[]} now={NOW} width={1400} />, "es"));
    expect(screen.getByText("Todavía no hay nada en tu registro en los últimos 90 días.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Votaciones" })).toBeNull();
  });

  it("keeps dense dates individually named and reachable in the 90-day range", () => {
    const onOpenItem = vi.fn();
    const broadcasts = Array.from({ length: 18 }, (_, index) => ({
      id: `tamarack-${index}`, title: `Tamarack record ${index}`, publishedAt: new Date(NOW.getTime() - (index + 1) * 86_400_000).toISOString(),
    }));
    render(inLang(<AltTimeline items={recordItems({ broadcasts })} now={NOW} width={320} onOpenItem={onOpenItem} />));
    fireEvent.click(screen.getByRole("button", { name: "90 days" }));
    const track = within(screen.getByRole("group", { name: "Updates: 18 in the last 90 days" }));
    expect(track.getAllByRole("button")).toHaveLength(18);
    for (const record of broadcasts) {
      const control = track.getByRole("button", { name: new RegExp(`Updates: ${record.title}$`) });
      control.focus();
      expect(control).toHaveFocus();
      fireEvent.click(control);
      expect(onOpenItem).toHaveBeenLastCalledWith(expect.objectContaining({ id: `update-${record.id}` }));
    }
  });
});

describe("Codex findings on #6533", () => {

  it("keeps every same-day record of a row reachable behind one control", () => {
    const onOpenItem = vi.fn();
    const items = recordItems({ broadcasts: [
      { id: "a", title: "Morning notice", sender: "Office", publishedAt: "2026-10-14T13:00:00Z" },
      { id: "b", title: "Evening notice", sender: "Office", publishedAt: "2026-10-14T21:00:00Z" },
    ] });
    render(inLang(<AltTimeline items={items} now={NOW} width={500} onOpenItem={onOpenItem} />));
    const track = within(screen.getByRole("group", { name: "Updates: 2 in the last 30 days" }));
    const day = track.getByRole("button", { name: /Updates: 2 records/ });
    expect(day).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(day);
    const list = track.getByRole("list");
    const entries = within(list).getAllByRole("button");
    expect(entries.map((button) => button.textContent)).toEqual(["Morning notice", "Evening notice"]);
    fireEvent.click(entries[0]);
    expect(onOpenItem).toHaveBeenLastCalledWith(expect.objectContaining({ id: "update-a" }));
    fireEvent.click(day);
    fireEvent.click(within(track.getByRole("list")).getByRole("button", { name: "Evening notice" }));
    expect(onOpenItem).toHaveBeenLastCalledWith(expect.objectContaining({ id: "update-b" }));
    fireEvent.click(day);
    fireEvent.keyDown(track.getByRole("list"), { key: "Escape" });
    expect(track.queryByRole("list")).toBeNull();
    expect(day).toHaveFocus();
  });
});

describe("AltMarquee", () => {
  const lessons = [{ id: "l1", label: "Weingarten rights" }];
  it("runs two tracks, hides the loop copy, pauses and opens items", () => {
    const onOpenItem = vi.fn();
    const onOpenLesson = vi.fn();
    const { container } = render(inLang(<AltMarquee items={recordItems(DATA)} lessons={lessons} onOpenItem={onOpenItem} onOpenLesson={onOpenLesson} />));
    const tracks = container.querySelectorAll(".ug-mq-track");
    expect(tracks).toHaveLength(2);
    expect(tracks[0].style.getPropertyValue("--ug-mq-dur")).toBe("70s");
    expect(tracks[1]).toHaveClass("ug-rev");
    // Case notes stay out of the public-facing ticker; the copy is not focusable.
    expect(screen.getAllByRole("button", { name: /Contract ratified/ })).toHaveLength(1);
    expect(container.querySelectorAll('[aria-hidden="true"][tabindex="-1"]').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /Contract ratified/ }));
    expect(onOpenItem).toHaveBeenCalledWith(expect.objectContaining({ id: "update-b1" }));
    fireEvent.click(screen.getByRole("button", { name: /Weingarten rights/ }));
    expect(onOpenLesson).toHaveBeenCalledWith(lessons[0]);
    fireEvent.click(screen.getByRole("button", { name: "Pause scrolling" }));
    expect(tracks[0].style.animationPlayState).toBe("paused");
    fireEvent.click(screen.getByRole("button", { name: "Resume scrolling" }));
    expect(tracks[0].style.animationPlayState).toBe("");
  });
  it("renders nothing without records or lessons", () => {
    const { container } = render(inLang(<AltMarquee items={[]} lessons={[]} />));
    expect(container).toBeEmptyDOMElement();
  });
});

describe("AltCalendar", () => {

  it("keeps at least one kind on and caps the marks at three a day", () => {
    const busy = Array.from({ length: 5 }, (_, index) => ({ id: `b${index}`, title: `Update ${index}`, publishedAt: "2026-10-15T15:00:00Z" }));
    const { container } = render(inLang(<AltCalendar items={recordItems({ broadcasts: busy })} now={NOW} />));
    expect(container.querySelector(".ug-cal-day.ug-today .ug-more")).toHaveTextContent("+2");
    for (const type of RECORD_TYPES.slice(1)) fireEvent.click(screen.getByRole("button", { name: altShellCatalogue.en[`altShell.typePlural_${type}`] }));
    fireEvent.click(screen.getByRole("button", { name: "Updates" }));
    expect(screen.getByRole("button", { name: "Updates" })).toHaveAttribute("aria-pressed", "true");
  });
});

describe("AltShell phone tab bar", () => {
  const props = (overrides = {}) => ({
    active: "today", activePath: "/m", onNavigate: vi.fn(), badges: { messages: 4 },
    user: { initials: "TM", name: "Taylor Member", onProfile: vi.fn() }, ...overrides,
  });

  it("offers Now, Messages with its unread badge, Work for staff and Menu, and marks the root", () => {
    stubMedia({ wide: false });
    const onNavigate = vi.fn();
    const { container } = render(inLang(<div className="ugalt"><AltShell {...props({ onNavigate, tabWork: { viewKey: "tasks", path: "/m/tasks", badge: 2 } })}><p>page</p></AltShell></div>));
    const tabbar = within(document.getElementById("ug-tabbar"));
    expect(container.querySelector(".ugalt")).toHaveClass("ug-has-tabbar");
    expect(tabbar.getByRole("link", { name: "Now" })).toHaveAttribute("aria-current", "page");
    expect(tabbar.getByRole("link", { name: "Messages, 4 waiting" })).toBeInTheDocument();
    fireEvent.click(tabbar.getByRole("link", { name: "Work, 2 waiting" }));
    expect(onNavigate).toHaveBeenCalledWith("tasks", "/m/tasks", "");
    const menu = tabbar.getByRole("button", { name: "Menu" });
    fireEvent.click(menu);
    expect(document.getElementById("ug-msheet")).toHaveClass("ug-open");
  });

  it("has no Work entry for a member and no bar without a signed-in visitor", () => {
    const { container, unmount } = render(inLang(<div className="ugalt"><AltShell {...props()}><p>page</p></AltShell></div>));
    expect(within(document.getElementById("ug-tabbar")).queryByRole("link", { name: /^Work/ })).toBeNull();
    unmount();
    const signedOut = render(inLang(<div className="ugalt"><AltShell {...props({ user: null })}><p>page</p></AltShell></div>));
    expect(document.getElementById("ug-tabbar")).toBeNull();
    expect(signedOut.container.querySelector(".ugalt")).not.toHaveClass("ug-has-tabbar");
    expect(container).toBeDefined();
  });
});

describe("motion stylesheet", () => {
  const design = readFileSync("src/alt/styles/design.css", "utf8");
  const shell = readFileSync("src/alt/styles/shell.css", "utf8");
  it("keeps the prototype's keyframes and its global reduced-motion rule", () => {
    for (const name of ["ug-tin", "ug-mq", "ug-blink", "ug-pulse"]) expect(design).toContain(`@keyframes ${name}`);
    expect(design).toMatch(/@media \(prefers-reduced-motion:reduce\)\{\.ugalt\{scroll-behavior:auto\}[^@]*animation-duration:\.001ms!important;animation-iteration-count:1!important;transition-duration:\.001ms!important/);
  });
  it("gives the app's toast the prototype's entrance, and invents no page-level motion", () => {
    expect(shell).toMatch(/\.ugalt \.toast \{[^}]*animation: ug-tin \.35s var\(--ug-ease\);/);
    // The prototype animates toasts and its notice, never a whole page.
    expect(shell).not.toContain("ug-page-in");
    expect(shell).toMatch(/\.ugalt\.ug-has-tabbar \.toast \{ bottom: calc\(84px \+ env\(safe-area-inset-bottom\)\); \}/);
  });
  it("adds every new string in English and Spanish", () => {
    const keys = Object.keys(altShellCatalogue.en).filter((key) => /^altShell\.(tab|tl|type|mq|cal|comingUp)/.test(key));
    expect(keys.length).toBeGreaterThan(30);
    for (const key of keys) expect(altShellCatalogue.es[key], key).toBeTruthy();
  });
});
