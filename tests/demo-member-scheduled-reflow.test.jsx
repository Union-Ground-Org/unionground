import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { t } from "../src/lib/i18n.js";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";

let resize;
beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState({}, "", "/m/messages?demo=1");
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline fixture")));
  let width = 1440;
  const queries = new Map();
  const matches = (query) => query.includes("min-width: 1024px") ? width >= 1024
    : query.includes("min-width: 768px") && query.includes("max-width: 1023px") && width >= 768 && width <= 1023;
  vi.stubGlobal("matchMedia", (query) => {
    if (!queries.has(query)) queries.set(query, {
      media: query, get matches() { return matches(query); }, listeners: new Set(),
      addEventListener(_type, listener) { this.listeners.add(listener); },
      removeEventListener(_type, listener) { this.listeners.delete(listener); },
    });
    return queries.get(query);
  });
  resize = (next) => act(() => {
    width = next;
    for (const [query, media] of queries) for (const listener of media.listeners) listener({ matches: matches(query) });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe.each(["en", "es"])("Member fixture scheduled messages (%s)", (lang) => {
  it("keeps pending sends through layout remounts and navigation, cancels only the chosen send, and resets with the preview", async () => {
    window.localStorage.setItem("sg-lang", lang);
    const mounted = render(<App />);
    const open = async () => fireEvent.click(await screen.findByRole("button", { name: t(lang, "inbox.messageSteward") }));
    await open();
    const bodies = ["Tamarack schedule follow-up A", "Tamarack schedule follow-up B"];
    const schedule = async (body) => {
      const composer = screen.getByRole("textbox", { name: t(lang, "inbox.composerPlaceholder") });
      fireEvent.change(composer, { target: { value: body } });
      fireEvent.change(document.querySelector('.inbox-composer input[type="datetime-local"]'), { target: { value: "2099-11-10T09:00" } });
      fireEvent.submit(composer.closest("form"));
      await waitFor(() => expect(screen.getByRole("region", { name: t(lang, "inbox.scheduledMessages") })).toHaveTextContent(body));
    };
    for (const body of bodies) await schedule(body);
    const pending = () => screen.getByRole("region", { name: t(lang, "inbox.scheduledMessages") });
    const expectBoth = () => {
      for (const body of bodies) expect(pending()).toHaveTextContent(body);
      expect(within(pending()).getAllByRole("button", { name: t(lang, "inbox.cancelScheduled") })).toHaveLength(2);
    };
    expectBoth();
    resize(320);
    expectBoth();
    resize(1440);
    expectBoth();
    const navigate = (path) => act(() => {
      window.history.pushState({}, "", path);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    navigate("/m");
    await waitFor(() => expect(screen.queryByRole("heading", { name: t(lang, "inbox.title"), exact: true })).not.toBeInTheDocument());
    navigate("/m/messages");
    await open();
    expectBoth();
    fireEvent.click(within(pending()).getAllByRole("button", { name: t(lang, "inbox.cancelScheduled") })[0]);
    await waitFor(() => expect(pending()).not.toHaveTextContent(bodies[0]));
    expect(pending()).toHaveTextContent(bodies[1]);
    resize(320);
    expect(pending()).not.toHaveTextContent(bodies[0]);
    expect(pending()).toHaveTextContent(bodies[1]);
    fireEvent.click(within(pending()).getByRole("button", { name: t(lang, "inbox.cancelScheduled") }));
    await waitFor(() => expect(screen.queryByRole("region", { name: t(lang, "inbox.scheduledMessages") })).not.toBeInTheDocument());
    resize(1440);
    navigate("/m");
    navigate("/m/messages");
    await open();
    expect(screen.queryByRole("region", { name: t(lang, "inbox.scheduledMessages") })).not.toBeInTheDocument();
    await schedule("Tamarack pending send at preview reset");
    expect(fallbackData.conversations.every((conversation) => !conversation.scheduled?.some((row) => row.body.startsWith("Tamarack")))).toBe(true);
    mounted.unmount();
    window.history.replaceState({}, "", "/m/messages?demo=1");
    render(<App />);
    await open();
    expect(screen.queryByRole("region", { name: t(lang, "inbox.scheduledMessages") })).not.toBeInTheDocument();
  });
});
