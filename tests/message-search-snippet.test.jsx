import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildSearchIndex, searchEntries } from "../src/lib/searchIndex.js";
import { SearchView } from "../src/views/SearchView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

const conversation = (body, sender = "Tamarack colleague") => ({ id: "tamarack-thread", sender, preview: "Thank you for the information.", messages: [{ id: "earlier-message", body }, { id: "latest-message", body: "Thank you for the information." }] });
const result = (thread, query) => searchEntries(buildSearchIndex({ conversations: [thread] }), query).find(group => group.type === "conversation").items[0];

describe("message search excerpts", () => {
  it("shows the earlier matching message, marks it, and targets its message id", () => {
    const thread = conversation("Ask about your Weingarten rights before the meeting.");
    const hit = result(thread, "weingarten");
    expect(hit.snippet).toContain("Weingarten");
    expect(hit.snippet).not.toContain(thread.preview);
    expect(hit.snippetSegments).toContainEqual({ text: "Weingarten", highlight: true });
    expect(hit.focus).toMatchObject({ conversationId: thread.id, messageId: "earlier-message", view: "messages" });
    expect(thread.messages[0].body).toContain("Weingarten");
  });
  it("centers late matches and preserves accents, case and literal markup", () => {
    const hit = result(conversation("Earlier context. ".repeat(50) + "<b>Reunión</b> with your steward. " + "Later context. ".repeat(50)), "reunion");
    expect(hit.snippet).toContain("<b>Reunión</b>");
    expect(hit.snippetSegments.some(segment => segment.highlight && segment.text.includes("Reunión"))).toBe(true);
    expect(hit.snippet.length).toBeLessThan(250);
    expect(hit.snippet.startsWith("…")).toBe(true);
    expect(hit.snippet.endsWith("…")).toBe(true);
  });
  it("keeps the preview for a sender-only hit and marks the sender", () => {
    const thread = conversation("No keyword here.", "Weingarten colleague");
    const hit = result(thread, "weingarten");
    expect(hit.snippet).toBe(thread.preview);
    expect(hit.titleSegments).toContainEqual({ text: "Weingarten", highlight: true });
    expect(hit.focus.messageId).toBeUndefined();
  });
  it("finds a late preview-only match when messages have not loaded", () => {
    const hit = result({ id: "preview-only", sender: "Tamarack colleague", preview: "Earlier context. ".repeat(50) + "Weingarten rights apply.", messages: [] }, "weingarten");
    expect(hit.snippet).toContain("Weingarten");
    expect(hit.focus.messageId).toBeUndefined();
  });
  it("keeps legacy sender-only entries with an empty preview usable", () => {
    const item = { id: "conversation:legacy", type: "conversation", title: "Tamarack colleague", snippet: "", haystack: "tamarack colleague", focus: { conversationId: "legacy" } };
    const hit = searchEntries([item], "tamarack")[0].items[0];
    expect(hit.snippet).toBe("");
    expect(hit.snippetSegments).toEqual([]);
    expect(hit.focus).toEqual(item.focus);
  });
  it.each([["en", "Weingarten"], ["es", "reunión"]])("renders semantic text marks and opens the matching conversation in %s", (lang, query) => {
    const onOpenResult = vi.fn();
    render(<LanguageProvider lang={lang}><SearchView data={{ conversations: [conversation("Weingarten: pide una reunión con tu delegado.")] }} onOpenResult={onOpenResult} /></LanguageProvider>);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: query } });
    const button = screen.getByRole("button", { name: /Tamarack colleague/ });
    expect(button.querySelector("mark").textContent.toLowerCase()).toContain(query.toLowerCase());
    expect(button.querySelector("small")).toHaveStyle({ whiteSpace: "normal" });
    fireEvent.click(button);
    expect(onOpenResult).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "tamarack-thread", messageId: "earlier-message" }));
  });
});

describe("guide-thread search excerpts", () => {
  const guide = (messages = [{ id: "guide-message", body: "Ask about Weingarten rights and your reunión." }]) => ({ id: "tamarack-guide", title: "Tamarack guidance", messages });
  const hit = (thread, query) => searchEntries(buildSearchIndex({ guideThreads: [thread] }), query).find(group => group.type === "guide").items[0];

  it("shows the distinctive matching message and preserves the guide destination", () => {
    const thread = guide();
    const result = hit(thread, "weingarten");
    expect(result.snippet).toContain("Weingarten");
    expect(result.snippetSegments).toContainEqual({ text: "Weingarten", highlight: true });
    expect(result.focus).toEqual({ assistant: true, guideThreadId: "tamarack-guide", messageId: "guide-message" });
    expect(thread.messages[0].body).toContain("Weingarten");
  });
  it("centers a late match and picks the message matching all query words", () => {
    const result = hit(guide([
      { body: "Weingarten question" },
      { body: "Earlier context. ".repeat(50) + "Weingarten representación <b>literal</b>. " + "Later context. ".repeat(50) },
      { body: "Thank you" }, { body: "" }, {}, { body: 42 },
    ]), "weingarten representacion");
    expect(result.snippet).toContain("representación");
    expect(result.snippet).toContain("<b>literal</b>");
    expect(result.snippet.length).toBeLessThan(250);
    expect(result.snippet.startsWith("…")).toBe(true);
  });
  it.each([guide(), guide([]), { id: "tamarack-guide", title: "Tamarack guidance" }])("leaves title-only matches without an invented snippet", thread => {
    const result = hit(thread, "tamarack");
    expect(result.snippet).toBe("");
    expect(result.snippetSegments).toEqual([]);
    expect(result.titleSegments).toContainEqual({ text: "Tamarack", highlight: true });
  });
  it("keeps sealed form answers out while guide messages are searchable", () => {
    const entries = buildSearchIndex({ guideThreads: [guide()], forms: [{ id: "sealed", templateKey: "fmla_self", sealed: true, answers: { reason: "sealedtripwire" } }] });
    expect(JSON.stringify(entries)).not.toContain("sealedtripwire");
    expect(searchEntries(entries, "sealedtripwire")).toEqual([]);
    expect(searchEntries(entries, "weingarten")[0].items[0].snippet).toContain("Weingarten");
  });
  it.each([["en", "Weingarten"], ["es", "reunión"]])("renders the matching guide text safely and opens the guide in %s", (lang, query) => {
    const onOpenResult = vi.fn();
    render(<LanguageProvider lang={lang}><SearchView data={{ guideThreads: [guide()] }} onOpenResult={onOpenResult} /></LanguageProvider>);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: query } });
    const button = screen.getByRole("button", { name: /Tamarack guidance/ });
    expect(button.querySelector("mark").textContent.toLowerCase()).toContain(query.toLowerCase());
    fireEvent.click(button);
    expect(onOpenResult).toHaveBeenCalledWith({ assistant: true, guideThreadId: "tamarack-guide", messageId: "guide-message" });
  });
});
