import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChannelPollCard } from "../src/components/ChannelPollCard.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";

const DAY = 86_400_000;
const CAP = 2_147_000_000;
const start = new Date("2026-10-20T12:00:00-04:00").getTime();
const poll = (wait) => ({
  pollId: "long-poll", question: "Keep this schedule?", mine: null,
  closesAt: wait == null ? null : new Date(start + wait).toISOString(),
  options: [{ id: "yes", label: "Yes", votes: 1 }, { id: "no", label: "No", votes: 0 }],
});
const card = (value) => <LanguageProvider lang="en"><ChannelPollCard poll={value} onVote={vi.fn()} /></LanguageProvider>;
const advance = async (ms) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };

beforeEach(() => { vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: start }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("channel poll deadline scheduling", () => {
  it("closes a thirty-day poll after crossing the capped timeout without a parent refresh", async () => {
    render(card(poll(30 * DAY)));
    expect(screen.getAllByRole("button")).toHaveLength(2);
    await advance(CAP);
    expect(screen.getAllByRole("button")).toHaveLength(2);
    await advance(30 * DAY - CAP + 100);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByRole("region")).toHaveTextContent("This poll has closed. 1 vote in total.");
  });

  it("rearms through multiple caps until a seventy-day deadline", async () => {
    render(card(poll(70 * DAY)));
    await advance(CAP);
    await advance(CAP);
    expect(screen.getAllByRole("button")).toHaveLength(2);
    await advance(70 * DAY - 2 * CAP + 100);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("still closes an ordinary short poll", async () => {
    render(card(poll(60_000)));
    await advance(59_000);
    expect(screen.getAllByRole("button")).toHaveLength(2);
    await advance(1_100);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("cancels a retired deadline when the poll is extended", async () => {
    const view = render(card(poll(60_000)));
    await advance(30_000);
    view.rerender(card(poll(120_000)));
    expect(vi.getTimerCount()).toBe(1);
    await advance(31_000);
    expect(screen.getAllByRole("button")).toHaveLength(2);
    await advance(59_100);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("replaces a rearmed long deadline with an earlier deadline", async () => {
    const view = render(card(poll(30 * DAY)));
    await advance(CAP);
    view.rerender(card(poll(CAP + 60_000)));
    expect(vi.getTimerCount()).toBe(1);
    await advance(60_100);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the rearmed timer on unmount", async () => {
    const view = render(card(poll(30 * DAY)));
    await advance(CAP);
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    await advance(30 * DAY);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not schedule a timer for an undated or already closed poll", () => {
    const view = render(card(poll(null)));
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
    view.rerender(card(poll(-1)));
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("a poll vote keeps focus while it is saved (#8435)", () => {
  it("keeps the chosen option focused while the vote is recorded, and votes once", async () => {
    vi.useRealTimers();
    const onVote = vi.fn(async () => ({ mine: "yes" }));
    render(<LanguageProvider lang="en"><ChannelPollCard poll={poll(null)} onVote={onVote} /></LanguageProvider>);
    await expectHeldWriteFocus(onVote, screen.getAllByRole("button")[0]);
    expect(onVote).toHaveBeenCalledTimes(1);
  });
});
