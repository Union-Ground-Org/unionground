import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";
// BUG-UG-CHAPTER-NOTICE-COLOUR-SETTING-VANISHES-ON-A-FAILED-READ-20261125
// (#9995, from #9465): the Hub's Notice colour setting swallowed every error
// from its first read and rendered nothing, so a failed read looked the same
// as a person who may not change the colour. A refusal for role or scope and
// an older backend still show nothing; any other failure says so, with Try
// again. Fictional data; the client answers the way supabase-js does.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useLayoutEffect, useRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { NoticeGlowControl } from "../src/features/chapterNotices/NoticeGlow.jsx";

const ready = (chapterId = "chapter-spruce") => ({ data: { chapterId, glow: "blue", canChange: true }, error: null, status: 200 });
const offline = () => ({ data: null, error: { message: "Failed to fetch", code: "" }, status: 0 });
// #9995: each refusal alone. Codes answer with a status that would not
// hide on its own (500), so only the code can hide the control.
const answers = {
  "42501": () => ({ data: null, error: { message: "chapter notice role required", code: "42501" }, status: 500 }),
  not_authorized: () => ({ data: null, error: { message: "not authorized", code: "not_authorized" }, status: 500 }),
  PGRST202: () => ({ data: null, error: { message: "Could not find the function", code: "PGRST202" }, status: 500 }),
  "42883": () => ({ data: null, error: { message: "function does not exist", code: "42883" }, status: 500 }),
  "a bare 403": () => ({ data: null, error: { message: "Forbidden" }, status: 403 }),
  "a bare 404": () => ({ data: null, error: { message: "Not Found" }, status: 404 }),
};
const show = (client, lang = "en", chapterId = "chapter-spruce") => <LanguageProvider lang={lang}><NoticeGlowControl client={client} chapterId={chapterId} /></LanguageProvider>;

// An rpc whose read answer the test switches between calls; held by mockImplementation, never a queued Once value.
function switchableClient(first) {
  let next = first;
  const rpc = vi.fn(async () => next());
  return { client: { rpc }, rpc, set: (answer) => { next = answer; } };
}
function heldAnswer(answer) {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  return { run: async () => { await gate; return answer(); }, release: () => release() };
}
async function settle() {
  await act(async () => {});
  await act(async () => {});
}

describe("the chapter's notice colour after a failed read", () => {
  it("says it could not be loaded, keeps focus on Try again while it reads again, then offers the colours with focus on the chosen one", async () => {
    const { client, rpc, set } = switchableClient(offline);
    render(show(client));
    expect(await screen.findByRole("alert")).toHaveTextContent("The notice colour could not be loaded.");
    expect(screen.getByRole("heading", { name: "Notice colour" })).toBeInTheDocument();
    set(ready);
    await expectHeldWriteFocus(rpc, screen.getByRole("button", { name: "Try again" }));
    const blue = await screen.findByRole("radio", { name: "Blue" });
    expect(blue).toBeChecked();
    expect(blue).toHaveFocus();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(rpc).toHaveBeenLastCalledWith("get_chapter_notice_glow", { p_chapter_id: "chapter-spruce" });
  });

  it("says it in Spanish", async () => {
    render(show({ rpc: vi.fn(async () => offline()) }, "es"));
    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo cargar el color de los avisos.");
    expect(screen.getByRole("button", { name: "Intentar de nuevo" })).toBeEnabled();
  });

  it.each(Object.keys(answers))("still shows nothing after %s", async (name) => {
    const rpc = vi.fn(async () => answers[name]());
    const { container } = render(show({ rpc }));
    await settle();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(container).toBeEmptyDOMElement();
  });

  it.each([403, 404])("shows the alert for an unrelated code that arrives with HTTP %i", async (status) => {
    render(show({ rpc: vi.fn(async () => ({ data: null, error: { message: "canceling statement due to statement timeout", code: "57014" }, status })) }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The notice colour could not be loaded.");
  });

  it("hides the control when the read again is refused", async () => {
    const { client, set } = switchableClient(offline);
    const { container } = render(show(client));
    const retry = await screen.findByRole("button", { name: "Try again" });
    set(answers["42501"]);
    fireEvent.click(retry);
    await settle();
    expect(container).toBeEmptyDOMElement();
  });

  it("replaces the alert with a loading line while a retry runs and inserts it again when the retry fails", async () => {
    const slow = heldAnswer(offline);
    const rpc = vi.fn().mockResolvedValueOnce(offline()).mockImplementation(slow.run);
    render(show({ rpc }, "es"));
    const first = await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Intentar de nuevo" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Cargando el color de los avisos…");
    await act(async () => { slow.release(); });
    const again = await screen.findByRole("alert");
    expect(again).toHaveTextContent("No se pudo cargar el color de los avisos.");
    expect(again).not.toBe(first);
  });

  it("leaves focus where the person moved it: during the retry, after its read landed, or off Try again to the page", async () => {
    for (const move of ["during", "afterLanding", "blurToPage"]) {
      const moveAfterLanding = move !== "during";
      const slow = heldAnswer(ready);
      const rpc = vi.fn().mockResolvedValueOnce(offline()).mockImplementation(slow.run);
      const view = render(<><button type="button">Elsewhere</button>{show({ rpc })}</>);
      const retry = await screen.findByRole("button", { name: "Try again" });
      const elsewhere = screen.getByRole("button", { name: "Elsewhere" });
      retry.focus();
      fireEvent.click(retry);
      if (move === "during") elsewhere.focus();
      await act(async () => {
        slow.release();
        for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
        if (moveAfterLanding) expect(retry).toHaveFocus();
        if (move === "afterLanding") elsewhere.focus();
        if (move === "blurToPage") retry.blur();
      });
      const blue = await screen.findByRole("radio", { name: "Blue" });
      if (move === "blurToPage") {
        expect(blue).not.toHaveFocus();
        expect(document.activeElement).toBe(document.body);
      } else {
        expect(elsewhere).toHaveFocus();
      }
      view.unmount();
    }
  });

  it("lets a new chapter's Try again read while a retry for the previous chapter is still running", async () => {
    const slow = heldAnswer(() => ready("chapter-spruce"));
    const rpc = vi.fn(async (_name, args) => {
      if (args.p_chapter_id === "chapter-spruce" && rpc.mock.calls.length === 2) return slow.run();
      return offline();
    });
    const view = render(show({ rpc }));
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await settle();
    expect(rpc).toHaveBeenCalledTimes(2);
    view.rerender(show({ rpc }, "en", "chapter-larch"));
    const retry = await screen.findByRole("button", { name: "Try again" });
    expect(retry).not.toHaveAttribute("aria-disabled");
    fireEvent.click(retry);
    await settle();
    expect(rpc).toHaveBeenCalledTimes(4);
    expect(rpc).toHaveBeenLastCalledWith("get_chapter_notice_glow", { p_chapter_id: "chapter-larch" });
    await act(async () => { slow.release(); });
    await settle();
    expect(screen.queryByRole("radio", { name: "Blue" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).not.toHaveAttribute("aria-disabled");
  });

  // #9995: the failure belongs to one chapter. The first render for
  // another chapter shows nothing of the previous one's alert or retry.
  it("shows nothing of the previous chapter's failure in the first render for another chapter", async () => {
    const log = [];
    function Probe({ client, chapterId }) {
      const box = useRef(null);
      useLayoutEffect(() => { log.push({ chapterId, text: box.current.textContent }); });
      return <div ref={box}><NoticeGlowControl client={client} chapterId={chapterId} /></div>;
    }
    const rpc = vi.fn(async (_name, args) => (args.p_chapter_id === "chapter-spruce" ? offline() : new Promise(() => {})));
    const view = render(<LanguageProvider lang="en"><Probe client={{ rpc }} chapterId="chapter-spruce" /></LanguageProvider>);
    expect(await screen.findByRole("alert")).toHaveTextContent("The notice colour could not be loaded.");
    view.rerender(<LanguageProvider lang="en"><Probe client={{ rpc }} chapterId="chapter-larch" /></LanguageProvider>);
    const larch = log.filter((entry) => entry.chapterId === "chapter-larch");
    expect(larch.length).toBeGreaterThan(0);
    expect(larch[0].text).toBe("");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });
});
