import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EARLIER_HISTORY_RECONCILE_MS, useEarlierHistory } from "../src/features/messaging/earlierHistory.js";

// BUG-UG-WEB-CHANNEL-HIDES-POSTS-PAST-NEWEST-1000-20261110: the web
// earlier-history hook is the native hook compiled to JavaScript
// (apps/mobile/src/features/useConversationHistory.ts). These cases replay the
// native suite's rules against it: the 60 s bound, the re-read timer, a held
// older read that never restores a removed post, and the cut when the page
// becomes visible again. Pages of 50 keep the runs short. Fictional posts only.

const PAGE = 50;
const STALE_MS = 2 * EARLIER_HISTORY_RECONCILE_MS;
const BASE = Date.parse("2026-11-02T14:00:00.000Z");
const row = (number) => ({ id: `post-${String(number).padStart(3, "0")}`, body: `Post ${number}`, createdAt: new Date(BASE + number * 60_000).toISOString() });

let root; let host; let latest; let catalog; let thread; let latency; let snapshot; let revalidateMs;
const newestFirst = () => [...catalog].sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1));
function newestPage() {
  const page = newestFirst().slice(0, PAGE);
  const oldest = page[page.length - 1];
  return { messages: [...page].reverse(), earlierCursor: page.length >= PAGE && oldest ? { createdAt: oldest.createdAt, id: oldest.id } : null };
}
function load(before) {
  const source = snapshot ? newestFirst() : null;
  return new Promise((resolve) => {
    setTimeout(() => {
      const older = (source ?? newestFirst()).filter((item) => item.createdAt < before.createdAt || (item.createdAt === before.createdAt && item.id < before.id)).slice(0, PAGE);
      const oldest = older[older.length - 1];
      resolve({ messages: [...older].reverse(), earlierCursor: older.length >= PAGE && oldest ? { createdAt: oldest.createdAt, id: oldest.id } : null });
    }, latency);
  });
}
function Harness() {
  latest = useEarlierHistory({ scopeKey: "thread-1|user-1", thread, load, staleAfterMs: STALE_MS, revalidateMs });
  return null;
}
const rerender = () => act(async () => { root.render(createElement(Harness)); });
const seconds = (count) => act(async () => { await vi.advanceTimersByTimeAsync(count * 1_000); });
async function open() {
  act(() => { latest.loadEarlier(); });
  for (let step = 0; step < 60 && latest.status === "loading"; step += 1) await seconds(1);
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
  vi.setSystemTime(BASE + 30 * 86_400_000);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  catalog = Array.from({ length: 101 }, (_unused, index) => row(index + 1));
  latency = 0; snapshot = false; revalidateMs = undefined;
  thread = newestPage();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await rerender();
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

it("keeps nothing past the bound when no read confirms it, and offers the page again", async () => {
  await open();
  expect(latest.messages).toHaveLength(100);
  await seconds(61);
  expect(latest.messages).toHaveLength(50);
  expect(latest.hasEarlier).toBe(true);
  expect(latest.status).toBe("idle");
});

it("re-reads opened history on its timer, keeps it past the bound and lets a removed post leave within it", async () => {
  revalidateMs = EARLIER_HISTORY_RECONCILE_MS;
  latency = 1_000;
  await rerender();
  await open();
  expect(latest.messages).toHaveLength(100);
  await seconds(150);
  expect(latest.messages).toHaveLength(100);
  catalog = catalog.filter((item) => item.id !== "post-020");
  await seconds(STALE_MS / 1_000);
  expect(latest.messages.some((item) => item.id === "post-020")).toBe(false);
  // The page read again reaches one post deeper in its place.
  expect(latest.messages.map((item) => item.id)).toEqual(newestFirst().slice(0, 100).reverse().map((item) => item.id));
});

it("never brings back a post the newest page removed from an older read that lands later", async () => {
  await open();
  // A cycle's read starts with the conversation as it is, and lands 15 s later.
  snapshot = true; latency = 15_000;
  thread = newestPage();
  await rerender();
  latency = 600_000;
  // The newest post goes, so post 51 joins the newest page; then it is removed there.
  catalog = catalog.filter((item) => item.id !== "post-101" && item.id !== "post-051");
  thread = newestPage();
  await rerender();
  await seconds(16);
  expect(latest.messages.some((item) => item.id === "post-051")).toBe(false);
});

it("cuts what aged out while the page was hidden as soon as it shows again", async () => {
  await open();
  expect(latest.messages).toHaveLength(100);
  // Hidden pages throttle timers: the clocks move without the cut timer firing.
  vi.setSystemTime(Date.now() + STALE_MS + 1_000);
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(latest.messages).toHaveLength(50);
  delete document.visibilityState;
});
