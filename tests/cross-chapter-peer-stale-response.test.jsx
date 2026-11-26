import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CrossChapterPeersSection } from "../src/features/messaging/CrossChapterPeersSection.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { createResponseQueue } from "./helpers/responseQueue.js";

afterEach(cleanup);
const page = (name, nextOffset = null) => ({
  available: true, levels: ["vp"], muted: false, nextOffset,
  peers: [{ id: name, name, title: null, chapters: ["North"], levels: ["vp"] }],
});
const api = (load) => ({ load, send: vi.fn(), setMute: vi.fn() });
const section = (source) => <LanguageProvider lang="en"><CrossChapterPeersSection api={source} /></LanguageProvider>;
async function settle(queue, label, value, fail = false) {
  await act(async () => {
    if (fail) queue.reject(label, new Error("controlled failure"));
    else queue.resolve(label, value);
  });
}

describe("cross-chapter shared request guard", () => {
  it.each([false, true])("ignores a retired first page after the API changes (failure: %s)", async (fail) => {
    const queue = createResponseQueue();
    const older = queue.request("old");
    const current = queue.request("current");
    const first = api(vi.fn(() => older));
    const second = api(vi.fn(() => current));
    const view = render(section(first));
    view.rerender(section(second));
    await settle(queue, "current", page("Current lead"));
    expect(screen.getByText("Current lead")).toBeInTheDocument();
    await settle(queue, "old", page("Old lead"), fail);
    expect(screen.getByText("Current lead")).toBeInTheDocument();
    expect(screen.queryByText("Old lead")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(first.load).toHaveBeenCalledTimes(1);
    expect(second.load).toHaveBeenCalledTimes(1);
  });

  it("does not revive the first A read when an API returns from A to B to A", async () => {
    const queue = createResponseQueue();
    const firstA = queue.request("first A");
    const b = queue.request("B");
    const currentA = queue.request("current A");
    const a = api(vi.fn().mockReturnValueOnce(firstA).mockReturnValueOnce(currentA));
    const other = api(vi.fn(() => b));
    const view = render(section(a));
    view.rerender(section(other));
    view.rerender(section(a));
    await settle(queue, "current A", page("Current A"));
    await settle(queue, "B", page("Retired B"));
    await settle(queue, "first A", page("Retired A"));
    expect(screen.getByText("Current A")).toBeInTheDocument();
    expect(screen.queryByText("Retired A")).toBeNull();
    expect(screen.queryByText("Retired B")).toBeNull();
  });

  it.each([false, true])("drops a page from before a newer search (failure: %s)", async (fail) => {
    const queue = createResponseQueue();
    const more = queue.request("more");
    const search = queue.request("search");
    const source = api(vi.fn(({ query = "", offset = 0 }) => offset ? more : query ? search : Promise.resolve(page("Initial lead", 1))));
    render(section(source));
    fireEvent.click(await screen.findByRole("button", { name: "Show more" }));
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "East" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await settle(queue, "search", page("Current East lead"));
    await settle(queue, "more", page("Retired page lead", 2), fail);
    expect(screen.getByText("Current East lead")).toBeInTheDocument();
    expect(screen.queryByText("Retired page lead")).toBeNull();
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([false, true])("drops a retired search after an API change (failure: %s)", async (fail) => {
    const queue = createResponseQueue();
    const search = queue.request("search");
    const first = api(vi.fn(({ query }) => query ? search : Promise.resolve(page("Initial lead"))));
    const second = api(vi.fn(async () => page("New scope lead")));
    const view = render(section(first));
    await screen.findByText("Initial lead");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "East" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    view.rerender(section(second));
    await screen.findByText("New scope lead");
    await settle(queue, "search", page("Retired search lead"), fail);
    expect(screen.getByText("New scope lead")).toBeInTheDocument();
    expect(screen.queryByText("Retired search lead")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows a current search failure and retries the same query", async () => {
    const queue = createResponseQueue();
    const search = queue.request("search");
    const retry = queue.request("retry");
    const source = api(vi.fn().mockResolvedValueOnce(page("Initial lead")).mockReturnValueOnce(search).mockReturnValueOnce(retry));
    render(section(source));
    await screen.findByText("Initial lead");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "East" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await settle(queue, "search", null, true);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle(queue, "retry", page("East lead"));
    expect(screen.getByText("East lead")).toBeInTheDocument();
    expect(source.load).toHaveBeenLastCalledWith({ query: "East" });
  });

  it("keeps current failures visible and retries the first page and paging", async () => {
    const queue = createResponseQueue();
    const initial = queue.request("initial");
    const retry = queue.request("retry");
    const failedMore = queue.request("failed more");
    const moreRetry = queue.request("more retry");
    const source = api(vi.fn().mockReturnValueOnce(initial).mockReturnValueOnce(retry).mockReturnValueOnce(failedMore).mockReturnValueOnce(moreRetry));
    render(section(source));
    await settle(queue, "initial", null, true);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle(queue, "retry", page("First lead", 1));
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await settle(queue, "failed more", null, true);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("First lead")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await settle(queue, "more retry", page("Second lead"));
    expect(screen.getByText("First lead")).toBeInTheDocument();
    expect(screen.getByText("Second lead")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(source.load).toHaveBeenLastCalledWith({ query: "", offset: 1 });
  });
});
