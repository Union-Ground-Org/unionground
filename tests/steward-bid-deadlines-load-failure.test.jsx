import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";
// BUG-UG-STEWARD-BID-DEADLINES-VANISH-ON-A-FAILED-READ-20261125 (#9968,
// from #9465): the Steward desk's Bid deadlines section turned a failed read
// into an empty list and rendered nothing, the same as a chapter with no bid
// closing soon. A refusal for role or scope still shows nothing; any other
// failure says so, with Try again. Fictional data.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { BidDeadlines } from "../src/features/seniority/SeniorityPanel.jsx";
import { notifyBidsChanged } from "../src/features/seniority/api.js";

const NOW = Date.parse("2026-10-30T22:00:00Z");
const OPEN = { id: "w-cedar", subject: "Cedar Street shift bid", opensAt: "2026-10-29T12:00:00Z", closesAt: "2026-11-02T12:00:00Z", status: "open" };
const offline = () => Object.assign(new Error("Failed to fetch"), { code: "" });
const refusal = () => Object.assign(new Error("not authorized"), { code: "42501" });
const wrap = (node, lang = "en") => <LanguageProvider lang={lang}>{node}</LanguageProvider>;

// A read whose outcome the test switches between calls; held by mockImplementation, never a queued Once value.
function switchableRead(first) {
  let outcome = first;
  const read = vi.fn(async () => { if (outcome instanceof Error) throw outcome; return outcome; });
  return { read, next: (value) => { outcome = value; } };
}

async function settle() {
  await act(async () => {});
  await act(async () => {});
}

describe("the Steward desk's bid deadlines after a failed read", () => {
  it("says they could not be loaded, keeps focus on Try again while it reads again, then lists them with focus on the section", async () => {
    const { read, next } = switchableRead(offline());
    render(wrap(<BidDeadlines api={{ deadlines: read }} chapterId="chapter-cedar" now={NOW} />));
    expect(await screen.findByRole("alert")).toHaveTextContent("Bid deadlines could not be loaded.");
    expect(screen.getByRole("heading", { name: "Bid deadlines" })).toBeInTheDocument();
    next([OPEN]);
    await expectHeldWriteFocus(read, screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(/Cedar Street shift bid closes/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Bid deadlines" })).toHaveFocus();
    expect(read).toHaveBeenCalledWith("chapter-cedar");
  });

  it("says in Spanish when a retry finds no bid closing soon", async () => {
    const { read, next } = switchableRead(offline());
    render(wrap(<BidDeadlines api={{ deadlines: read }} chapterId="chapter-cedar" now={NOW} />, "es"));
    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudieron cargar las fechas límite de licitaciones.");
    next([]);
    const retry = screen.getByRole("button", { name: "Intentar de nuevo" });
    retry.focus();
    fireEvent.click(retry);
    expect(await screen.findByText("Ninguna licitación cierra en los próximos 30 días.")).toHaveAttribute("role", "status");
    expect(screen.getByRole("heading", { name: "Fechas límite de licitaciones" })).toHaveFocus();
  });

  it("keeps the deadlines shown when a refresh after a bid change fails, and says they may be out of date", async () => {
    const { read, next } = switchableRead([OPEN]);
    render(wrap(<BidDeadlines api={{ deadlines: read }} chapterId="chapter-cedar" now={NOW} />));
    expect(await screen.findByText(/Cedar Street shift bid closes/)).toBeInTheDocument();
    next(offline());
    act(() => notifyBidsChanged("chapter-cedar"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Bid deadlines could not be refreshed. Those shown may be out of date.");
    expect(screen.getByText(/Cedar Street shift bid closes/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("still shows nothing after a refusal for role or scope, also on a retry", async () => {
    const { container } = render(wrap(<BidDeadlines api={{ deadlines: vi.fn(async () => { throw refusal(); }) }} chapterId="chapter-cedar" now={NOW} />));
    await settle();
    expect(container).toBeEmptyDOMElement();

    const { read, next } = switchableRead(offline());
    const second = render(wrap(<BidDeadlines api={{ deadlines: read }} chapterId="chapter-birch" now={NOW} />));
    const retry = await screen.findByRole("button", { name: "Try again" });
    next(refusal());
    fireEvent.click(retry);
    await settle();
    expect(second.container).toBeEmptyDOMElement();
  });

  it("still shows nothing when the read succeeds with no bid closing soon", async () => {
    const { container } = render(wrap(<BidDeadlines api={{ deadlines: vi.fn(async () => []) }} chapterId="chapter-cedar" now={NOW} />));
    await settle();
    expect(container).toBeEmptyDOMElement();
  });

  // #9968, P1: the retry lock and pending state belong to one chapter.
  it("lets a new chapter's Try again read while a retry for the previous chapter is still running", async () => {
    let releaseOld;
    const heldOld = new Promise((resolve) => { releaseOld = resolve; });
    const deadlines = vi.fn(async (chapter) => {
      if (chapter === "chapter-cedar" && deadlines.mock.calls.length === 2) { await heldOld; return [OPEN]; }
      throw offline();
    });
    const api = { deadlines };
    const view = render(wrap(<BidDeadlines api={api} chapterId="chapter-cedar" now={NOW} />));
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await settle();
    expect(deadlines).toHaveBeenCalledTimes(2);
    view.rerender(wrap(<BidDeadlines api={api} chapterId="chapter-birch" now={NOW} />));
    const birchRetry = await screen.findByRole("button", { name: "Try again" });
    expect(birchRetry).not.toHaveAttribute("aria-disabled");
    fireEvent.click(birchRetry);
    await settle();
    expect(deadlines).toHaveBeenCalledTimes(4);
    expect(deadlines).toHaveBeenLastCalledWith("chapter-birch");
    await act(async () => { releaseOld(); });
    await settle();
    expect(await screen.findByRole("alert")).toHaveTextContent("Bid deadlines could not be loaded.");
    expect(screen.queryByText(/Cedar Street shift bid closes/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).not.toHaveAttribute("aria-disabled");
  });

  // #9968, P1: "none" is the server's answer, never the browser clock's.
  it("makes no claim and moves no focus when the server returned rows the clock filters out", async () => {
    const { read, next } = switchableRead(offline());
    const { container } = render(wrap(<BidDeadlines api={{ deadlines: read }} chapterId="chapter-cedar" now={Date.parse("2026-11-02T12:05:00Z")} />));
    const retry = await screen.findByRole("button", { name: "Try again" });
    next([OPEN]);
    retry.focus();
    fireEvent.click(retry);
    await settle();
    expect(screen.queryByText("No bid closes in the next 30 days.")).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  // #9968, P2: focus moves only when Try again still holds it.
  it("leaves focus where the steward moved it while the retry ran", async () => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const deadlines = vi.fn().mockRejectedValueOnce(offline()).mockImplementation(async () => { await held; return [OPEN]; });
    render(wrap(<><BidDeadlines api={{ deadlines }} chapterId="chapter-cedar" now={NOW} /><button type="button">Elsewhere</button></>));
    const retry = await screen.findByRole("button", { name: "Try again" });
    retry.focus();
    fireEvent.click(retry);
    const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
    elsewhere.focus();
    await act(async () => { release(); });
    expect(await screen.findByText(/Cedar Street shift bid closes/)).toBeInTheDocument();
    expect(elsewhere).toHaveFocus();
  });

  // #9968, P2: a second failure inserts the alert again, so it is announced.
  it("replaces the alert with a loading line while a retry runs and inserts it again when the retry fails", async () => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    const deadlines = vi.fn().mockRejectedValueOnce(offline()).mockImplementation(async () => { await held; throw offline(); });
    render(wrap(<BidDeadlines api={{ deadlines }} chapterId="chapter-cedar" now={NOW} />, "es"));
    const first = await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Intentar de nuevo" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Cargando las fechas límite de licitaciones…");
    await act(async () => { release(); });
    const again = await screen.findByRole("alert");
    expect(again).toHaveTextContent("No se pudieron cargar las fechas límite de licitaciones.");
    expect(again).not.toBe(first);
    expect(first).not.toBeInTheDocument();
  });
});
