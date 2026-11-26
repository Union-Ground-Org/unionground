// REQ-UG-SPANISH-SPACES-AND-POSTS-20261030: chapter staff give a
// space a Spanish name and description, anyone posting can add a Spanish
// version of a reply, and readers on the Spanish view see those versions
// where they exist. The live half is tests/spanish-spaces-and-posts-db.test.js.
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  carriesSpanishEdit, inReaderLanguage, postBody, spaceDescription, spaceName, spanishSpaceEdit, spanishValue,
} from "../src/lib/bilingualContent.js";
import { catalogue } from "../src/lib/i18n/allLanguages.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { createChapterSpace, sendChapterThreadPost, updateChapterSpaceContent } from "../src/lib/memberApi.js";
import { ProductHubView } from "../src/views/ProductHubView.jsx";
import { MentionSearchPanel } from "../src/features/messaging/ChannelControls.jsx";
import { t as translate } from "../src/lib/i18n.js";

const space = { id: "space-1", name: "Night shift", description: "Overnight staffing", name_es: "Turno de noche", description_es: "Personal de noche", visibility: "chapter" };
const post = { id: "post-1", body: "Rest before the next shift?", body_es: "¿Descanso antes del siguiente turno?", created_at: "2026-10-30T12:00:00Z" };

describe("choosing the reader's version", () => {
  it("shows the Spanish version only to Spanish readers, and only when there is one", () => {
    expect(spaceName(space, "es")).toBe("Turno de noche");
    expect(spaceName(space, "en")).toBe("Night shift");
    expect(spaceDescription(space, "es")).toBe("Personal de noche");
    expect(postBody(post, "es")).toBe(post.body_es);
    expect(postBody(post, "en")).toBe(post.body);
    expect(postBody({ body: "Only English", body_es: "   " }, "es")).toBe("Only English");
    expect(postBody({ body: "Only English", body_es: null }, "es")).toBe("Only English");
    expect(inReaderLanguage("es", "x", 42)).toBe("x");
    expect(spaceName(undefined, "es")).toBeUndefined();
    expect(postBody(undefined, "en")).toBeUndefined();
  });

  it("treats an empty Spanish field as no Spanish version", () => {
    expect(spanishValue("  Hola  ")).toBe("Hola");
    for (const value of ["", "   ", null, undefined, 3]) expect(spanishValue(value)).toBeNull();
  });

  it("keeps a space edit's Spanish fields only when they change the space", () => {
    const base = { name: "Night shift", description: "Overnight staffing", visibility: "chapter" };
    expect(spanishSpaceEdit({ ...base, nameEs: " Turno de noche ", descriptionEs: "Personal de noche" }, space)).toEqual(base);
    expect(spanishSpaceEdit({ ...base, nameEs: "Turno nocturno", descriptionEs: "Personal de noche" }, space))
      .toEqual({ ...base, nameEs: "Turno nocturno", descriptionEs: "Personal de noche" });
    expect(spanishSpaceEdit({ ...base, nameEs: "", descriptionEs: "" }, space)).toEqual({ ...base, nameEs: null, descriptionEs: null });
    expect(spanishSpaceEdit({ ...base, nameEs: "", descriptionEs: "" }, { name: "x" })).toEqual(base);
    expect(spanishSpaceEdit(undefined, undefined)).toEqual({});
    expect(carriesSpanishEdit({ nameEs: null })).toBe(true);
    expect(carriesSpanishEdit(base)).toBe(false);
    expect(carriesSpanishEdit(null)).toBe(false);
  });

  it("declares every label in English and Spanish", () => {
    const keys = (lang) => Object.keys(catalogue[lang]).filter((key) => key.startsWith("bilingualContent.")).sort();
    expect(keys("en")).toHaveLength(6);
    expect(keys("es")).toEqual(keys("en"));
  });
});

describe("writing Spanish versions", () => {
  function tableClient(result) {
    const calls = [];
    const chain = {
      insert: (row) => { calls.push(["insert", row]); return chain; },
      update: (row) => { calls.push(["update", row]); return chain; },
      eq: (column, value) => { calls.push(["eq", column, value]); return chain; },
      select: () => chain,
      single: async () => ({ data: result, error: null }),
    };
    return { calls, client: { from: (table) => { calls.push(["from", table]); return chain; } } };
  }

  it("creates a space with its Spanish version only when one was typed", async () => {
    const plain = tableClient({ id: "s" });
    await createChapterSpace(plain.client, { name: " Space ", description: " D ", visibility: "chapter", nameEs: " ", descriptionEs: "" });
    expect(plain.calls).toContainEqual(["insert", { name: "Space", description: "D", visibility: "chapter" }]);
    const spanish = tableClient({ id: "s" });
    await createChapterSpace(spanish.client, { name: "Space", description: "", visibility: "chapter", nameEs: " Espacio ", descriptionEs: " Descripción " });
    expect(spanish.calls).toContainEqual(["insert", { name: "Space", description: "", visibility: "chapter", name_es: "Espacio", description_es: "Descripción" }]);
  });

  it("saves a space's Spanish version in the same call as the space, never on archive", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { id: "s" }, error: null });
    await updateChapterSpaceContent({ rpc }, "s", { name: " Space ", description: " D ", visibility: "chapter" }, false);
    expect(rpc).toHaveBeenLastCalledWith("update_chapter_space_content", { p_id: "s", p_name: "Space", p_description: "D", p_visibility: "chapter", p_archive: false });
    await updateChapterSpaceContent({ rpc }, "s", { name: "Space", description: "D", visibility: "private", nameEs: " Espacio ", descriptionEs: null }, false);
    expect(rpc).toHaveBeenLastCalledWith("update_chapter_space_content", {
      p_id: "s", p_name: "Space", p_description: "D", p_visibility: "private", p_archive: false, p_name_es: "Espacio", p_description_es: "",
    });
    await updateChapterSpaceContent({ rpc }, "s", { name: "Space", description: "D", visibility: "chapter", nameEs: "Espacio" }, true);
    expect(rpc).toHaveBeenLastCalledWith("update_chapter_space_content", { p_id: "s", p_name: "Space", p_description: "D", p_visibility: "chapter", p_archive: true });
  });

  it("posts a Spanish version only when one was typed", async () => {
    const plain = tableClient({ id: "p" });
    await sendChapterThreadPost(plain.client, "t", " Hello ", [], "  ");
    expect(plain.calls).toContainEqual(["insert", { thread_id: "t", body: "Hello" }]);
    const spanish = tableClient({ id: "p" });
    await sendChapterThreadPost(spanish.client, "t", "Hello", ["u-1"], " Hola ");
    expect(spanish.calls).toContainEqual(["insert", { thread_id: "t", body: "Hello", mentioned_user_ids: ["u-1"], body_es: "Hola" }]);
  });

  it("saves the Spanish edit with the space, never on archive", () => {
    const source = readFileSync("src/App.jsx", "utf8");
    expect(source).toContain("const spanish = !archive && carriesSpanishEdit(fields);");
    expect(source).not.toContain("updateChapterSpaceSpanish");
    expect(source).toContain("sendChapterThreadPost(sessionDataClient, threadId, body, mentionIds, bodyEs)");
  });
});

describe("the hub in Spanish and English", () => {
  const thread = { id: "thread-1", space_id: "space-1", title: "Holdover rest", kind: "topic", status: "open", posts: [post] };
  const data = (roles = ["steward"]) => ({
    member: { id: "user-1", initials: "SA", fullName: "Steward A" },
    roles,
    conversations: [],
    broadcasts: [],
    product: { spaces: [{ ...space, threads: [thread] }], documents: [], records: [], intake: [], handshakes: [], governance: [], partnerOrgs: [] },
  });
  const hub = (lang, props = {}) => render(<LanguageProvider lang={lang}><ProductHubView data={data()} onSendPost={vi.fn()} onCreateSpace={vi.fn()} onCreateThread={vi.fn()} onUpdateSpace={vi.fn()} {...props} /></LanguageProvider>);

  it("shows the space and the post in the reader's language", () => {
    const { unmount } = hub("es");
    expect(screen.getByText("Turno de noche")).toBeInTheDocument();
    expect(screen.getByText("Personal de noche")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Holdover rest/ }));
    expect(screen.getByText(post.body_es)).toBeInTheDocument();
    expect(screen.queryByText(post.body)).toBeNull();
    unmount();
    hub("en");
    expect(screen.getByText("Night shift")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Holdover rest/ }));
    expect(screen.getByText(post.body)).toBeInTheDocument();
  });

  it("sends a reply's Spanish version only while it is open, then clears it", async () => {
    const onSendPost = vi.fn().mockResolvedValue({ id: "post-2", body: "Yes", body_es: "Sí", created_at: "2026-10-30T13:00:00Z" });
    hub("en", { onSendPost });
    fireEvent.click(screen.getByRole("button", { name: /Holdover rest/ }));
    const dialog = screen.getByRole("dialog");
    const toggle = within(dialog).getByRole("button", { name: "Add a Spanish version (optional)" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(dialog).queryByRole("textbox", { name: "Reply in Spanish" })).toBeNull();
    fireEvent.click(toggle);
    const spanish = within(dialog).getByRole("textbox", { name: "Reply in Spanish" });
    expect(spanish).toHaveAttribute("lang", "es");
    expect(spanish).toHaveAccessibleDescription(catalogue.en["bilingualContent.postSpanishHint"]);
    fireEvent.change(spanish, { target: { value: " Sí " } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Reply" }), { target: { value: "Yes" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reply" }));
    await waitFor(() => expect(onSendPost).toHaveBeenCalledWith("thread-1", "Yes", [], "Sí"));
    await waitFor(() => expect(within(dialog).queryByRole("textbox", { name: "Reply in Spanish" })).toBeNull());
    // Typed, then closed: nothing Spanish is sent.
    fireEvent.click(toggle);
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Reply in Spanish" }), { target: { value: "Hola" } });
    fireEvent.click(toggle);
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Reply" }), { target: { value: "Hello" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reply" }));
    await waitFor(() => expect(onSendPost).toHaveBeenLastCalledWith("thread-1", "Hello", [], null));
  });

  it("lets staff edit a space's Spanish version and saves only a change", async () => {
    const onUpdateSpace = vi.fn().mockResolvedValue({});
    hub("en", { onUpdateSpace });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("textbox", { name: "Name in Spanish (optional)" })).toHaveValue("Turno de noche");
    expect(within(dialog).getByRole("textbox", { name: "Description in Spanish (optional)" })).toHaveValue("Personal de noche");
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name in Spanish (optional)" }), { target: { value: "Turno nocturno" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onUpdateSpace).toHaveBeenCalledWith("space-1", expect.objectContaining({ name: "Night shift", nameEs: "Turno nocturno", descriptionEs: "Personal de noche" }), false));
  });
});

describe("Your mentions in the reader's language", () => {
  it.each([["es", "@here Reunión al mediodía", "Turno de noche"], ["en", "Meeting at noon", "Night shift"]])("shows the %s version of each hit", async (lang, body, spaceLabel) => {
    const hit = { postId: "p", threadId: "t", spaceId: "s", threadTitle: "Holdover rest", spaceName: "Night shift", spaceNameEs: "Turno de noche",
      body: "Meeting at noon", bodyEs: "@here Reunión al mediodía", authorName: "Ana", authorInitials: "A", createdAt: "2026-10-30T12:00:00Z", reason: "here" };
    render(<LanguageProvider lang={lang}><MentionSearchPanel t={(key, vars) => translate(lang, key, vars)} lang={lang} api={{ searchMentions: vi.fn().mockResolvedValue([hit]) }} onOpenPost={vi.fn()} /></LanguageProvider>);
    expect(await screen.findByText(body)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(spaceLabel))).toBeInTheDocument();
  });
});
