// #9465 slice 2: failures say so with Try again; refusals keep Main.
import * as React from "react";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import { AnnouncementReaderSession } from "../src/features/platformAnnouncements/PlatformAnnouncements.jsx";
import { announcementCopy } from "../src/features/platformAnnouncements/copy.js";
import { useAnnouncementFeedWith } from "../src/features/platformAnnouncements/useAnnouncementFeed.js";
import { CommandPalette, REMOTE_DEBOUNCE_MS } from "../src/components/CommandPalette.jsx";
import { keepKeyboardShortcutsOn } from "./helpers/keyboardShortcuts.js";

const wrap = (node) => render(<LanguageProvider lang="en">{node}</LanguageProvider>);
const err = (message, code = "") => Object.assign(new Error(message), { code });
const wait = { timeout: REMOTE_DEBOUNCE_MS + 1000 };
const deferred = () => { let resolve, reject; const promise = new Promise((ok, no) => { resolve = ok; reject = no; }); return { promise, resolve, reject }; };
const item = { id: "p1", title: "Faster", body: "B.", publishedAt: "2026-11-01", expiresAt: "2099-01-01" };
const denied = () => Promise.reject(Object.assign(new Error("denied"), { denied: true }));

describe("W7-26 Union Ground updates", () => {
  it("a failed hide keeps the list and says it did not save", async () => {
    const c = announcementCopy("en");
    render(<AnnouncementReaderSession locale="en" api={{
      feed: vi.fn().mockResolvedValue({ items: [item], generation: 1, hidden: false }),
      settings: vi.fn(() => Promise.reject(Object.assign(new Error("denied"), { denied: true }))),
      preference: vi.fn().mockRejectedValue(err("offline")),
    }} />);
    expect(await screen.findByText("Faster")).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: c.hide })); });
    expect(await screen.findByRole("alert")).toHaveTextContent(c.saveFailed);
    expect(screen.getByText("Faster")).toBeInTheDocument();
    expect(screen.queryByText(c.unavailable)).toBeNull();
    expect(announcementCopy("es").saveFailed).not.toBe(c.saveFailed);
  });

  it("keeps the not-saved alert through a retry, never the unavailable line, and clears it when the hide saves", async () => {
    const c = announcementCopy("en");
    const retry = deferred();
    const feed = vi.fn().mockResolvedValue({ items: [item], generation: 1, hidden: false });
    const preference = vi.fn().mockRejectedValueOnce(err("offline")).mockReturnValueOnce(retry.promise);
    render(<AnnouncementReaderSession locale="en" api={{ feed, settings: vi.fn(denied), preference }} />);
    await screen.findByText("Faster");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: c.hide })); });
    await screen.findByRole("alert");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: c.hide })); });
    expect(preference).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("alert")).toHaveTextContent(c.saveFailed);
    expect(screen.queryByText(c.unavailable)).toBeNull();
    feed.mockResolvedValue({ items: [], generation: 1, hidden: true });
    await act(async () => { retry.resolve({ hidden: true }); });
    expect(await screen.findByText(c.hidden)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("without the website's option (the phone), a failed hide keeps Main's state: empty list and the load error", async () => {
    const api = { feed: vi.fn().mockResolvedValue({ items: [item], generation: 1, hidden: false }), preference: vi.fn().mockRejectedValue(err("offline")) };
    const { result } = renderHook(() => useAnnouncementFeedWith(React, api, "en", true));
    await waitFor(() => expect(result.current.state.items).toHaveLength(1));
    await act(async () => { await result.current.preference(true); });
    expect(result.current.state).toMatchObject({ items: [], error: true, busy: false, hidden: false });
    expect(result.current.state.saveFailed).toBeFalsy();
  });

  describe("when the 30 second lease ends", () => {
    afterEach(() => { vi.useRealTimers(); });
    const flush = () => act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); });

    it("with the website's option, the posts leave and the not-saved alert stays beside the refresh line", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const c = announcementCopy("en");
      render(<AnnouncementReaderSession locale="en" api={{ feed: vi.fn().mockResolvedValue({ items: [item], generation: 1, hidden: false }), settings: vi.fn(denied), preference: vi.fn().mockRejectedValue(err("offline")) }} />);
      await flush();
      expect(screen.getByText("Faster")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: c.hide }));
      await flush();
      expect(screen.getByRole("alert")).toHaveTextContent(c.saveFailed);
      await act(async () => { vi.advanceTimersByTime(30_000); });
      expect(screen.queryByText("Faster")).toBeNull();
      expect(screen.getByRole("alert")).toHaveTextContent(c.saveFailed);
      expect(screen.getByRole("status")).toHaveTextContent(c.expired);
    });

    it("without it (the phone), the expiry state is Main's", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const api = { feed: vi.fn().mockResolvedValue({ items: [item], generation: 1, hidden: false }), preference: vi.fn() };
      const { result } = renderHook(() => useAnnouncementFeedWith(React, api, "en", true));
      await flush();
      expect(result.current.state.items).toHaveLength(1);
      await act(async () => { vi.advanceTimersByTime(30_000); });
      expect(result.current.state).toMatchObject({ items: [], expired: true, error: false, busy: false, hidden: false, generation: null });
      expect(result.current.state.saveFailed).toBeFalsy();
    });
  });

  it("says it in Spanish", async () => {
    render(<AnnouncementReaderSession locale="es" api={{ feed: vi.fn().mockResolvedValue({ items: [item], generation: 1, hidden: false }), settings: vi.fn(denied), preference: vi.fn().mockRejectedValue(err("offline")) }} />);
    await screen.findByText("Faster");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Ocultar estas novedades" })); });
    expect(await screen.findByRole("alert")).toHaveTextContent("No se guardó tu elección. Vuelve a intentarlo.");
  });
});

describe("W3a-25 search palette", () => {
  keepKeyboardShortcutsOn();
  const open = (resolveRemoteResults) => {
    wrap(<CommandPalette commands={[{ id: "today", label: "Home", onSelect: vi.fn() }]} searchResults={[]} resolveRemoteResults={resolveRemoteResults} />);
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "overtime" } });
  };

  it("a failed search says so, with Try again", async () => {
    const search = vi.fn().mockRejectedValueOnce(err("Failed to fetch")).mockResolvedValue([]);
    open(search);
    expect(await screen.findByRole("alert", {}, wait)).toHaveTextContent("Issue search could not be reached. Commands still work.");
    expect(screen.queryByText("No results.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No results.", {}, wait)).toBeInTheDocument();
    expect(search.mock.calls.map(([query]) => query)).toEqual(["overtime", "overtime"]);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(t("es", "command.caseSearchFailed")).not.toBe(t("en", "command.caseSearchFailed"));
  });

  it.each(["failure", "answer"])("a late %s of an older search does not replace a newer answer", async (late) => {
    const older = deferred();
    const search = vi.fn().mockReturnValueOnce(older.promise).mockResolvedValueOnce([{ id: "result:b", label: "Beta case", onSelect: vi.fn() }]);
    open(search);
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1), wait);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "beta" } });
    expect(await screen.findByRole("option", { name: /Beta case/ }, wait)).toBeInTheDocument();
    await act(async () => { if (late === "failure") older.reject(err("Failed to fetch")); else older.resolve([{ id: "result:a", label: "Alpha case", onSelect: vi.fn() }]); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("option", { name: /Alpha case/ })).toBeNull();
    expect(screen.getByRole("option", { name: /Beta case/ })).toBeInTheDocument();
  });

  it("a refusal keeps No results", async () => {
    const search = vi.fn().mockRejectedValue(err("not permitted", "42501"));
    open(search);
    expect(await screen.findByText("No results.", {}, wait)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

// W9-9 (the union-catalog vouch list) is left out with the public union catalog.
