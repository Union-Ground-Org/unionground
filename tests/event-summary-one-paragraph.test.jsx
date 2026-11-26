import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EventAuthoringCard } from "../src/components/EventAuthoringCard.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { keepOneParagraph, oneParagraph } from "../src/lib/eventSummary.js";
import { StewardView } from "../src/views/StewardView.jsx";
import { openPastEvents } from "./helpers/openPastEvents.js";

// BUG-UG-EVENT-SUMMARY-LINE-BREAK-REFUSED-WITH-ONLY-A-TOAST-20261108:
// create_member_event and update_member_event refuse any control character in
// the summary, so both summary boxes keep one paragraph and say so.

const HELP = "Shown as one paragraph, so line breaks become spaces.";

describe("oneParagraph", () => {
  it("turns every run of line breaks, tabs and other control characters into one space", () => {
    expect(oneParagraph("Bring your badge\r\n\r\n  and lunch\tplease")).toBe("Bring your badge and lunch please");
    expect(oneParagraph("C1\u0085next\u0000end\u007f")).toBe("C1 next end ");
    expect(oneParagraph("Plain text stays")).toBe("Plain text stays");
    expect(oneParagraph(null)).toBe("");
  });

  it("makes Enter type one space at the caret instead of a line break, except while an input method is composing", () => {
    const box = document.createElement("textarea");
    const inputs = vi.fn();
    box.addEventListener("input", inputs);
    const press = (key, isComposing = false) => {
      const event = { key, nativeEvent: { isComposing }, currentTarget: box, preventDefault: vi.fn() };
      keepOneParagraph(event);
      return event.preventDefault.mock.calls.length > 0;
    };
    box.value = "Agenda.Questions";
    box.setSelectionRange(7, 7);
    expect(press("Enter")).toBe(true);
    expect(box.value).toBe("Agenda. Questions");
    expect(box.selectionStart).toBe(8);
    expect(inputs).toHaveBeenCalledOnce();
    // No second space after one, and none at the very start.
    expect(press("Enter")).toBe(true);
    expect(box.value).toBe("Agenda. Questions");
    box.setSelectionRange(0, 0);
    expect(press("Enter")).toBe(true);
    expect(box.value).toBe("Agenda. Questions");
    expect(inputs).toHaveBeenCalledOnce();
    // A selection is replaced by the space.
    box.setSelectionRange(6, 8);
    press("Enter");
    expect(box.value).toBe("Agenda Questions");
    expect(press("Enter", true)).toBe(false);
    expect(press("a")).toBe(false);
  });
});

describe("event form summary box", () => {
  function openCreate(lang = "en") {
    const api = { createEvent: vi.fn().mockResolvedValue({ created: true }), updateEvent: vi.fn() };
    render(<LanguageProvider lang={lang}><EventAuthoringCard events={[]} api={api} onNotice={vi.fn()} reload={vi.fn()} /></LanguageProvider>);
    fireEvent.click(screen.getByRole("button", { name: lang === "en" ? "New meeting" : "Nueva reunión" }));
    return api;
  }

  it("keeps a pasted two-line summary as one paragraph, ignores Enter, says so, and saves it", async () => {
    const api = openCreate();
    for (const [label, value] of [
      ["Web name", "general-meeting"], ["Title", "General meeting"],
      ["Starts", "2026-11-20T18:00"], ["Location", "Union hall"],
    ]) fireEvent.change(screen.getByLabelText(label), { target: { value } });
    const summary = screen.getByLabelText("Summary");
    expect(summary).toHaveAccessibleDescription(HELP);
    fireEvent.change(summary, { target: { value: "Agenda: contract update.\nBring your questions." } });
    expect(summary).toHaveValue("Agenda: contract update. Bring your questions.");
    summary.setSelectionRange(summary.value.length, summary.value.length);
    expect(fireEvent.keyDown(summary, { key: "Enter" })).toBe(false);
    expect(summary).toHaveValue("Agenda: contract update. Bring your questions. ");
    fireEvent.change(summary, { target: { value: "Agenda: contract update. Bring your questions." } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.createEvent).toHaveBeenCalledWith(expect.objectContaining({ summary: "Agenda: contract update. Bring your questions." })));
  });


  it("says so in Spanish", () => {
    openCreate("es");
    expect(screen.getByLabelText("Resumen")).toHaveAccessibleDescription("Se muestra como un solo párrafo, así que los saltos de línea se convierten en espacios.");
  });
});

describe("steward message-to-event summary box", () => {
  async function openMessageEvent(lang = "en") {
    const api = {
      loadDesk: vi.fn().mockResolvedValue({
        queue: [], broadcasts: [], formsInbox: [],
        threads: [{
          id: "conv-1", memberName: "Renata Cole", memberInitials: "RC", preview: "Can we meet about overtime?", updatedAt: "2026-07-21T09:00:00Z", awaitingReply: true,
          messages: [{ id: "m-1", sender_kind: "member", sender_name: "Renata Cole", body: "Can we meet about overtime?", created_at: "2026-07-21T09:00:00Z" }],
        }],
        kpis: { openRequests: 0, membersCovered: 1, awaitingReply: 1, broadcasts30d: 0 },
      }),
      listScheduled: vi.fn().mockResolvedValue([]),
      createEventFromMessage: vi.fn().mockResolvedValue({ created: true }),
    };
    render(<LanguageProvider lang={lang}><StewardView data={{ member: { id: "steward-1", initials: "SO" } }} api={api} onNotice={() => {}} canCreateMessageEvent /></LanguageProvider>);
    fireEvent.click(await screen.findByText("Can we meet about overtime?"));
    const dialog = await screen.findByRole("dialog", { name: "Renata Cole" });
    fireEvent.click(within(dialog).getByRole("button", { name: lang === "en" ? "Create meeting" : "Crear reunión" }));
    return { api, dialog: within(dialog) };
  }

  it.each([
    ["en", "Meeting ID", "Meeting title", "Check-in code", "Create campaign-only meeting",
      "Use 3–64 lowercase letters (a–z), digits (0–9), or hyphens",
      "Use at least 3 characters after trimming spaces at the start and end",
      "Start with SG- and add 3–12 uppercase letters (A–Z) or digits (0–9)"],
    ["es", "ID de la reunión", "Título de la reunión", "Código de registro", "Crear reunión solo para la campaña",
      "Usa entre 3 y 64 letras minúsculas (a–z), dígitos (0–9) o guiones",
      "Escribe al menos 3 caracteres sin contar los espacios del principio y del final",
      "Empieza con SG- y añade entre 3 y 12 letras mayúsculas (A–Z) o dígitos (0–9)"],
  ])("states the message-to-event formats and names rejected fields on submit in %s",
    async (lang, idLabel, titleLabel, codeLabel, submitLabel, idRule, titleRule, codeRule) => {
      const { api, dialog } = await openMessageEvent(lang);
      const id = dialog.getByLabelText(idLabel);
      const title = dialog.getByLabelText(titleLabel);
      const code = dialog.getByLabelText(codeLabel);
      expect(id).toHaveAccessibleDescription(expect.stringContaining(idRule));
      expect(title).toHaveAccessibleDescription(expect.stringContaining(titleRule));
      expect(title).toHaveAccessibleDescription(expect.stringContaining(lang === "en"
        ? "Some characters, such as emoji, can count as more than one toward that limit."
        : "Algunos caracteres, como los emojis, pueden contar como más de uno para ese límite."));
      expect(code).toHaveAccessibleDescription(expect.stringContaining(codeRule));
      fireEvent.input(title, { target: { value: "😀".repeat(60) } });
      expect(title).toHaveAccessibleDescription(expect.stringContaining(lang === "en" ? "120 of 120" : "120 de 120"));
      fireEvent.input(id, { target: { value: "reunión-123" } });
      fireEvent.input(code, { target: { value: "SG-lowercase" } });
      fireEvent.click(dialog.getByRole("button", { name: submitLabel }));
      const alerts = dialog.getAllByRole("alert");
      expect(alerts).toHaveLength(2);
      expect(alerts[0]).toHaveTextContent(idRule);
      expect(alerts[1]).toHaveTextContent(codeRule);
      expect(id).toHaveValue("reunión-123");
      expect(code).toHaveValue("SG-lowercase");
      expect(code).toHaveAttribute("aria-invalid", "true");
      expect(api.createEventFromMessage).not.toHaveBeenCalled();
      fireEvent.input(id, { target: { value: "reunion-123" } });
      fireEvent.input(code, { target: { value: "SG-VALID" } });
      expect(dialog.queryByRole("alert")).toBeNull();
      expect(code).not.toHaveAttribute("aria-invalid");
    },
  );

  it.each([
    ["en", "Meeting title", "Create campaign-only meeting", "Use at least 3 characters after trimming spaces at the start and end", " abc "],
    ["es", "Título de la reunión", "Crear reunión solo para la campaña", "Escribe al menos 3 caracteres sin contar los espacios del principio y del final", " 😀😀😀 "],
  ])("keeps titles below the trimmed minimum at the Steward form in %s",
    async (lang, titleLabel, submitLabel, titleRule, validTitle) => {
      const { api, dialog } = await openMessageEvent(lang);
      const title = dialog.getByLabelText(titleLabel);
      const submit = dialog.getByRole("button", { name: submitLabel });
      const fields = title.form.elements;
      for (const [name, value] of [
        ["id", "overtime-meeting"], ["startsAt", "2026-11-20T18:00"],
        ["location", "Union hall"], ["summary", "Bring your schedule."], ["checkInCode", "SG-ABC123"],
      ]) fireEvent.input(fields.namedItem(name), { target: { value } });

      for (const value of [" ab", "   ", "😀😀"]) {
        fireEvent.input(title, { target: { value } });
        fireEvent.click(submit);
        expect(api.createEventFromMessage).not.toHaveBeenCalled();
        expect(dialog.getByRole("alert")).toHaveTextContent(titleRule);
        expect(title).toHaveAttribute("aria-invalid", "true");
        expect(title).toHaveValue(value);
      }

      fireEvent.input(title, { target: { value: validTitle } });
      expect(dialog.queryByRole("alert")).toBeNull();
      expect(title).not.toHaveAttribute("aria-invalid");
      fireEvent.click(submit);
      await waitFor(() => expect(api.createEventFromMessage).toHaveBeenCalledExactlyOnceWith(
        "m-1", expect.objectContaining({ title: validTitle }),
      ));
    },
  );

  it("keeps browser patterns on both rendered message-to-event inputs", async () => {
    const { dialog } = await openMessageEvent();
    const fields = [
      ["Meeting ID", [["a-1", true], ["ab", false], ["a".repeat(64), true],
        ["a".repeat(65), false], ["-abc", false], ["reunión-123", false], ["A-1", false]]],
      ["Check-in code", [["SG-AB1", true], ["SG-A".padEnd(15, "9"), true], ["SG-A".padEnd(16, "9"), false],
        ["SG-A1", false], ["SG-Ab1", false], ["SG-１２３", false], ["SG-ÁB1", false]]],
    ];
    for (const [label, examples] of fields) {
      const input = dialog.getByLabelText(label);
      expect(input.getAttribute("pattern")).toBeTruthy();
      const htmlPattern = new RegExp(`^(?:${input.getAttribute("pattern")})$`, "v");
      for (const [value, valid] of examples) {
        fireEvent.input(input, { target: { value } });
        expect(htmlPattern.test(input.value), `${label}: ${value}`).toBe(valid);
        expect(input.validity.patternMismatch, `${label}: ${value}`).toBe(!valid);
      }
    }
  });

  it("keeps the public summary one paragraph and sends it that way", async () => {
    const { api, dialog } = await openMessageEvent();
    for (const [label, value] of [
      ["Meeting ID", "overtime-meeting"], ["Meeting title", "Overtime meeting"], ["Starts", "2026-11-20T18:00"],
      ["Location", "Union hall"], ["Check-in code", "SG-ABC123"],
    ]) fireEvent.change(dialog.getByLabelText(label), { target: { value } });
    const summary = dialog.getByLabelText("Public summary");
    expect(summary).toHaveAccessibleDescription(HELP);
    fireEvent.input(summary, { target: { value: "Overtime rules." } });
    summary.setSelectionRange(15, 15);
    expect(fireEvent.keyDown(summary, { key: "Enter" })).toBe(false);
    expect(summary).toHaveValue("Overtime rules. ");
    fireEvent.input(summary, { target: { value: "Overtime rules.\nBring your schedule." } });
    expect(summary).toHaveValue("Overtime rules. Bring your schedule.");
    fireEvent.input(summary, { target: { value: "Overtime rules. Bring your schedule." } });
    expect(summary).toHaveValue("Overtime rules. Bring your schedule.");
    summary.value = "Overtime rules.\nBring your schedule.";
    fireEvent.click(dialog.getByRole("button", { name: "Create campaign-only meeting" }));
    await waitFor(() => expect(api.createEventFromMessage).toHaveBeenCalledWith("m-1", expect.objectContaining({ summary: "Overtime rules. Bring your schedule." })));
  });
});
