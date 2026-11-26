import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { EventAuthoringCard, EventForm, draftFieldError } from "../src/components/EventAuthoringCard.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { applyDeviceParityState, deviceParityValue } from "../src/lib/deviceParity.js";
import { openPastEvents } from "./helpers/openPastEvents.js";

function setup(lang = "en") {
  const api = { createEvent: vi.fn().mockResolvedValue({ created: true }), updateEvent: vi.fn() };
  const onNotice = vi.fn();
  render(<LanguageProvider lang={lang}><EventAuthoringCard events={[]} api={api} onNotice={onNotice} reload={vi.fn()} /></LanguageProvider>);
  fireEvent.click(screen.getByRole("button", { name: lang === "en" ? "New meeting" : "Nueva reunión" }));
  return { api, onNotice };
}

function fillRequired() {
  for (const [label, value] of [
    ["Web name", "survey-deadline"], ["Title", "Survey deadline"],
    ["Starts", "2026-11-01T12:30"], ["Location", "Online"],
    ["Summary", "Submit your survey by noon"],
  ]) fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

// UX-UG-NEW-EVENT-ASKS-FOR-A-LOWERCASE-SLUG-FIRST-20261125 (,
// D1-5 of): New event opened on "Event id (lowercase slug)" before the
// title, and a taken id read as the server's "event id already exists".
// Fictional events only.
describe("new event web name (#9985)", () => {
  it.each([
    ["en", { title: "Title", web: "Web name", starts: "Starts", location: "Location", summary: "Summary", save: "Save",
      taken: "Another meeting already uses this web name. Change the web name and save again." }],
    ["es", { title: "Título", web: "Nombre web", starts: "Comienza", location: "Lugar", summary: "Resumen", save: "Guardar",
      taken: "Otro reunión ya usa este nombre web. Cambia el nombre web y vuelve a guardar." }],
  ])("asks for the title first, fills the web name from it and says when it is taken (%s)", async (lang, labels) => {
    const { api, onNotice } = setup(lang);
    const title = screen.getByLabelText(labels.title);
    const web = screen.getByLabelText(labels.web);
    expect(title.compareDocumentPosition(web) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText(/slug/i)).toBeNull();
    expect(web).toHaveAccessibleDescription(expect.stringContaining(lang === "en"
      ? "Filled in from the title, and part of the meeting's web address. You can change it."
      : "Se completa con el título y forma parte de la dirección web de la reunión. Puedes cambiarlo."));
    fireEvent.change(title, { target: { value: "Mañana: Spring Rally 2026!" } });
    expect(web).toHaveValue("manana-spring-rally-2026");
    fireEvent.change(web, { target: { value: "spring-rally" } });
    fireEvent.change(title, { target: { value: "Spring rally at the depot" } });
    expect(web).toHaveValue("spring-rally");
    fireEvent.change(screen.getByLabelText(labels.starts), { target: { value: "2026-11-01T12:30" } });
    fireEvent.change(screen.getByLabelText(labels.location), { target: { value: "Tamarack depot" } });
    fireEvent.change(screen.getByLabelText(labels.summary), { target: { value: "Bring a sign" } });
    api.createEvent.mockRejectedValueOnce(Object.assign(new Error("Create meeting: event id already exists"), { code: "22023" }));
    fireEvent.click(screen.getByRole("button", { name: labels.save }));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith(labels.taken));
    expect(api.createEvent).toHaveBeenCalledWith(expect.objectContaining({ id: "spring-rally", title: "Spring rally at the depot" }));
  });

  // Sol read of e3e54e26 (P1): comparing values let a later title edit
  // overwrite a web name the person had touched. Any change in the field ends
  // the following, whatever the value.
  it("keeps a web name the person cleared on purpose", () => {
    setup();
    const title = screen.getByLabelText("Title");
    const web = screen.getByLabelText("Web name");
    fireEvent.change(title, { target: { value: "Tamarack picnic" } });
    expect(web).toHaveValue("tamarack-picnic");
    fireEvent.change(web, { target: { value: "" } });
    fireEvent.change(title, { target: { value: "Tamarack picnic and games" } });
    expect(web).toHaveValue("");
  });

  it("keeps a typed web name that equals the one the title would make", () => {
    setup();
    const title = screen.getByLabelText("Title");
    const web = screen.getByLabelText("Web name");
    fireEvent.change(web, { target: { value: "tamarack-picnic" } });
    fireEvent.change(title, { target: { value: "Tamarack picnic" } });
    expect(web).toHaveValue("tamarack-picnic");
    fireEvent.change(title, { target: { value: "Tamarack picnic and games" } });
    expect(web).toHaveValue("tamarack-picnic");
  });

  it("starts following the title again on a new event", () => {
    setup();
    fireEvent.change(screen.getByLabelText("Web name"), { target: { value: "kept-name" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "New meeting" }));
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Fresh event" } });
    expect(screen.getByLabelText("Web name")).toHaveValue("fresh-event");
  });
});

describe("event authoring validation feedback", () => {
  const examples = [
    ["en", ["Web name", "Title", "Check-in code (SG-…)", "Monthly dates (including the first)"], "Save",
      ["Use 3–64 lowercase letters (a–z), digits (0–9), or hyphens", "Use at least 3 characters after trimming spaces at the start and end", "Start with SG- and add 3–12 letters (A–Z or a–z) or digits (0–9)", "Enter a whole number from 1 to 12"]],
    ["es", ["Nombre web", "Título", "Código de registro (SG-…)", "Fechas mensuales (incluida la primera)"], "Guardar",
      ["Usa entre 3 y 64 letras minúsculas (a–z), dígitos (0–9) o guiones", "Escribe al menos 3 caracteres sin contar los espacios del principio y del final", "Empieza con SG- y añade entre 3 y 12 letras (A–Z o a–z) o dígitos (0–9)", "Ingresa un número entero del 1 al 12"]],
  ];

  it.each(examples)("explains event title, ID, check-in and repeat rules before editing in %s", (lang, labels, _save, rules) => {
    setup(lang);
    labels.forEach((label, index) => {
      expect(screen.getByLabelText(label)).toHaveAccessibleDescription(expect.stringContaining(rules[index]));
    });
    const title = screen.getByLabelText(labels[1]);
    expect(title).toHaveAccessibleDescription(expect.stringContaining(lang === "en"
      ? "Some characters, such as emoji, can count as more than one toward that limit."
      : "Algunos caracteres, como los emojis, pueden contar como más de uno para ese límite."));
    expect(screen.getByLabelText(labels[3])).toHaveAccessibleDescription(expect.stringContaining(lang === "en"
      ? "A single date means a one-time meeting."
      : "Con una sola fecha, la reunión se realiza una vez."));
    fireEvent.change(title, { target: { value: "😀".repeat(60) } });
    expect(title).toHaveAccessibleDescription(expect.stringContaining(lang === "en" ? "120 of 120" : "120 de 120"));
  });

  it.each(examples)("names the rejected event rules in %s", (lang, labels, save, rules) => {
    const { api } = setup(lang);
    labels.forEach((label, index) => {
      fireEvent.change(screen.getByLabelText(label), { target: { value: ["reunión-123", " ab ", "SG-１２３", "13"][index] } });
    });
    fireEvent.click(screen.getByRole("button", { name: save }));
    const alert = screen.getByRole("alert");
    rules.forEach((rule) => expect(alert).toHaveTextContent(rule));
    expect(screen.getByLabelText(labels[0])).toHaveValue("reunión-123");
    expect(screen.getByLabelText(labels[1])).toHaveValue(" ab ");
    expect(api.createEvent).not.toHaveBeenCalled();
  });

  it('describes an invalid monthly count with both its help and error', () => {
    const { api } = setup();
    fillRequired();
    const input = screen.getByLabelText('Monthly dates (including the first)');
    fireEvent.change(input, { target: { value: '13' } });
    fireEvent.submit(input.closest('form'));
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const ids = input.getAttribute('aria-describedby').split(' ');
    expect(ids).toHaveLength(2);
    expect(ids).toContain(screen.getByRole('alert').id);
    expect(document.getElementById(ids[0])).toHaveTextContent('Enter a whole number from 1 to 12');
    expect(api.createEvent).not.toHaveBeenCalled();
  });

  it("names every missing field in-page, focuses the first, and does not call the API", () => {
    const { api } = setup();
    // The title comes first, then the web name made from it.
    const names = ["Title", "Web name", "Starts", "Location", "Summary"];
    // The alert renders in its own conditional slot above the fields, so every
    // field keeps its DOM node and the focused one keeps focus (gate round 2).
    const before = names.map((name) => screen.getByLabelText(name));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const alert = screen.getByRole("alert");
    expect(names.map((name) => screen.getByLabelText(name))).toEqual(before);
    names.forEach((name, index) => expect(screen.getByLabelText(name)).toBe(before[index]));
    expect(document.activeElement).toBe(before[0]);
    for (const name of names) {
      expect(alert).toHaveTextContent(name);
      expect(screen.getByLabelText(name)).toHaveAttribute("aria-invalid", "true");
      // The summary box is also described by its one-paragraph note.
      expect(screen.getByLabelText(name).getAttribute("aria-describedby").split(" ")[0]).toBe(alert.id);
    }
    expect(screen.getByLabelText("Title")).toHaveFocus();
    // The check-in code is optional, so it is never named as missing.
    expect(alert).not.toHaveTextContent("Check-in code");
    expect(screen.getByLabelText("Check-in code (SG-…)")).not.toBeRequired();
    expect(screen.getByLabelText("Check-in code (SG-…)")).not.toHaveAttribute("aria-invalid");
    expect(api.createEvent).not.toHaveBeenCalled();
  });

  it("brings the alert into view, then focuses the first invalid field without scrolling it away", () => {
    // Gate round 2 on: on a phone the alert that names the
    // missing field sat above the fold while focus scrolled to the field.
    const scrolled = [];
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = function scrollIntoView(options) { scrolled.push([this, options]); };
    try {
      setup();
      fillRequired();
      const summary = screen.getByLabelText("Summary");
      fireEvent.change(summary, { target: { value: "" } });
      const focus = vi.spyOn(summary, "focus");
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(scrolled).toEqual([[screen.getByRole("alert"), { block: "nearest" }]]);
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(summary).toHaveFocus();
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });

  it("restores the alert after keyboard viewport resizes only while the rejected field has focus", () => {
    const viewport = new EventTarget();
    const remove = vi.spyOn(viewport, "removeEventListener");
    const descriptor = Object.getOwnPropertyDescriptor(window, "visualViewport");
    const original = HTMLElement.prototype.scrollIntoView;
    const scrolled = [];
    Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
    HTMLElement.prototype.scrollIntoView = function scrollIntoView(options) { scrolled.push([this, options]); };
    try {
      const { api } = setup();
      fillRequired();
      fireEvent.change(screen.getByLabelText("Check-in code (SG-…)"), { target: { value: "SG-VALID" } });
      const title = screen.getByLabelText("Title");
      fireEvent.change(title, { target: { value: "ab" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      const alert = screen.getByRole("alert");
      expect(title).toHaveFocus();
      act(() => { viewport.dispatchEvent(new Event("resize")); });
      act(() => { viewport.dispatchEvent(new Event("resize")); });
      expect(scrolled).toEqual(Array.from({ length: 3 }, () => [alert, { block: "nearest" }]));
      expect(api.createEvent).not.toHaveBeenCalled();
      screen.getByLabelText("Location").focus();
      act(() => { viewport.dispatchEvent(new Event("resize")); });
      expect(scrolled).toHaveLength(3);
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(remove).toHaveBeenCalledWith("resize", expect.any(Function));
      act(() => { viewport.dispatchEvent(new Event("resize")); });
      expect(scrolled).toHaveLength(3);
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
      if (descriptor) Object.defineProperty(window, "visualViewport", descriptor);
      else delete window.visualViewport;
    }
  });

  it("paints every field the alert names, not only the focused one", () => {
    const css = readFileSync(`${process.cwd()}/src/styles.css`, "utf8");
    expect(css).toMatch(/\.event-authoring-form \.xus-input\[aria-invalid="true"\] \{ border-color: var\(--destructive\);/);
    setup();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByLabelText("Title").closest("form")).toHaveClass("event-authoring-form");
  });

  it("saves a deadline with no check-in code and says the code is optional", async () => {
    // BUG-UG-EVENT-SAVE-SILENT-WITHOUT-CHECKIN-CODE-20261006: a
    // deadline needed a made-up door code; the database now stores none and
    // refuses every check-in for it.
    // A new meeting opens with a generated door code (REQ-UNIONGROUND-EVENTS-
    // RSVP-CHECK-IN-AND-VISIBILITY-20261030); clearing it is still allowed.
    const { api, onNotice } = setup();
    fireEvent.change(screen.getByLabelText("Check-in code (SG-…)"), { target: { value: "" } });
    expect(screen.getByText("Optional. Leave it blank for a deadline or reminder. Without a code, nobody can check in.")).toBeInTheDocument();
    expect(screen.getByLabelText("Check-in code (SG-…)")).toHaveAccessibleDescription(expect.stringContaining("Optional. Leave it blank for a deadline or reminder. Without a code, nobody can check in."));
    fillRequired();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.createEvent).toHaveBeenCalledOnce());
    expect(api.createEvent).toHaveBeenCalledWith(expect.objectContaining({ id: "survey-deadline", checkInCode: "" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Meeting created"));
  });

  it("names malformed values when submitting and keeps the entered draft", () => {
    const { api } = setup();
    fillRequired();
    fireEvent.change(screen.getByLabelText("Web name"), { target: { value: "Not a slug" } });
    fireEvent.change(screen.getByLabelText("Check-in code (SG-…)"), { target: { value: "bad-code" } });
    fireEvent.submit(screen.getByRole("button", { name: "Save" }).closest("form"));
    expect(screen.getByRole("alert")).toHaveTextContent("Web name");
    expect(screen.getByRole("alert")).toHaveTextContent("Check-in code (SG-…)");
    expect(screen.getByLabelText("Summary")).toHaveValue("Submit your survey by noon");
    expect(api.createEvent).not.toHaveBeenCalled();
  });

  it("treats whitespace-only required text as missing", () => {
    const { api } = setup();
    fillRequired();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "   " } });
    fireEvent.change(screen.getByLabelText("Check-in code (SG-…)"), { target: { value: "SG-VALID" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Title");
    expect(api.createEvent).not.toHaveBeenCalled();
  });

  it("uses Spanish field names and validation copy", () => {
    setup("es");
    fireEvent.change(screen.getByLabelText("Código de registro (SG-…)"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Título");
    expect(screen.getByRole("alert")).not.toHaveTextContent("Código de registro");
    expect(screen.getByText("Opcional. Déjalo en blanco para una fecha límite o un recordatorio. Sin código, nadie puede registrar su asistencia.")).toBeInTheDocument();
    expect(screen.getByRole("alert")).not.toHaveTextContent("required");
  });

  it("validates title length even when a draft supplies the value programmatically", () => {
    const { api } = setup();
    fillRequired();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "ab" } });
    fireEvent.change(screen.getByLabelText("Check-in code (SG-…)"), { target: { value: "SG-VALID" } });
    fireEvent.submit(screen.getByRole("button", { name: "Save" }).closest("form"));
    expect(screen.getByRole("alert")).toHaveTextContent("Use at least 3 characters after trimming spaces at the start and end");
    expect(api.createEvent).not.toHaveBeenCalled();
  });

  it("removes a saved code the edit clears and keeps the original timestamp instead of requiring create fields", async () => {
    const updateEvent = vi.fn().mockResolvedValue({ updated: true });
    render(<LanguageProvider lang="en"><EventAuthoringCard
      events={[{ id: "meeting", title: "Meeting", startsAt: "2026-11-01T15:00:27Z", location: "Hall", summary: "Agenda", checkInCode: "SG-VALID" }]}
      api={{ updateEvent }} onNotice={vi.fn()} reload={vi.fn()}
    /></LanguageProvider>);
    openPastEvents();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByText("Clear it to remove the code. Without a code, nobody can check in.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Check-in code (SG-…)"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Location"), { target: { value: "New hall" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateEvent).toHaveBeenCalledWith("meeting", expect.objectContaining({ checkInCode: null, removeCheckInCode: true, startsAt: null, location: "New hall" })));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps a saved code an edit leaves alone, and shows an event without one as having no check-in", async () => {
    const updateEvent = vi.fn().mockResolvedValue({ updated: true });
    render(<LanguageProvider lang="en"><EventAuthoringCard
      events={[
        { id: "meeting", title: "Meeting", startsAt: "2026-11-01T15:00:27Z", location: "Hall", summary: "Agenda", checkInCode: "SG-VALID" },
        { id: "deadline", title: "Survey deadline", startsAt: "2026-11-02T17:00:00Z", location: "Online", summary: "Submit", checkInCode: null },
      ]}
      api={{ updateEvent }} onNotice={vi.fn()} reload={vi.fn()}
    /></LanguageProvider>);
    openPastEvents();
    expect(screen.getByText("SG-VALID")).toBeInTheDocument();
    expect(screen.getAllByText("No check-in")).toHaveLength(1);
    fireEvent.click(within(document.querySelector('[data-automation-source-id="meeting"]')).getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Location"), { target: { value: "New hall" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateEvent).toHaveBeenCalledWith("meeting", expect.objectContaining({ checkInCode: "SG-VALID", removeCheckInCode: false })));
    fireEvent.click(within(document.querySelector('[data-automation-source-id="deadline"]')).getByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Check-in code (SG-…)")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updateEvent).toHaveBeenLastCalledWith("deadline", expect.objectContaining({ checkInCode: null, removeCheckInCode: false })));
  });

  it("ships an id pattern the browser compiles with the v flag and that rejects a non-slug id", () => {
    // Gate round 1 on  read pattern="[a-z0-9][a-z0-9\-]{2,63}"
    // as a JS string that drops the backslash. It is a JSX attribute string,
    // which keeps it; this checks the rendered attribute, not the source text.
    setup();
    const pattern = screen.getByLabelText("Web name").getAttribute("pattern");
    expect(pattern).toBe("[a-z0-9][a-z0-9\\-]{2,63}");
    const html = new RegExp(`^(?:${pattern})$`, "v");
    expect(["survey-deadline", "abc"].every((id) => html.test(id))).toBe(true);
    expect(["Not a slug", "AB", "ab", "-abc"].some((id) => html.test(id))).toBe(false);
  });

  it("drops a field's error when the paired device fills the draft", () => {
    // Gate round 1 on: the draft is device-parity state, so it
    // can change without this form's onChange running.
    const empty = { id: "", title: "", startsAt: "", location: "", summary: "", checkInCode: "", isPublic: false, isPublicAcrossAgencies: false };
    const props = { mode: "create", setForm: vi.fn(), onSubmit: vi.fn(), onCancel: vi.fn(), busy: false, chapterName: "Harborview Care United" };
    const view = render(<LanguageProvider lang="en"><EventForm {...props} form={empty} t={(key, vars) => `${key}${vars?.field ? `:${vars.field}` : ""}`} /></LanguageProvider>);
    fireEvent.submit(view.container.querySelector("form"));
    expect(screen.getByRole("alert")).toHaveTextContent("admin.fieldTitle");
    const filled = { ...empty, id: "survey-deadline", title: "Survey deadline", startsAt: "2026-11-01T12:30", location: "Online" };
    view.rerender(<LanguageProvider lang="en"><EventForm {...props} form={filled} t={(key, vars) => `${key}${vars?.field ? `:${vars.field}` : ""}`} /></LanguageProvider>);
    const alert = screen.getByRole("alert");
    expect(within(alert).getAllByRole("listitem")).toHaveLength(1);
    expect(alert).toHaveTextContent("admin.fieldSummary");
    expect(view.container.querySelectorAll("[aria-invalid='true']")).toHaveLength(1);
    expect(props.onSubmit).not.toHaveBeenCalled();
  });
});

describe("optional code with normalized validation", () => {
  it("accepts an empty create code, trims ids and uppercases codes", () => {
    for (const mode of ["create", "edit"]) {
      expect(draftFieldError("checkInCode", "   ", mode)).toBeNull();
      expect(draftFieldError("checkInCode", " sg-valid ", mode)).toBeNull();
    }
    expect(draftFieldError("id", " survey-deadline ", "create")).toBeNull();
    expect(draftFieldError("id", " Survey-deadline ", "create")).toBe("admin.eventFormInvalid");
    expect(draftFieldError("title", "   ", "create")).toBe("admin.eventFormRequired");
  });

  it("clears a rejected code when emptied, then saves the code-free draft", async () => {
    const { api } = setup();
    fillRequired();
    const code = screen.getByLabelText("Check-in code (SG-…)");
    fireEvent.change(code, { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Check-in code");
    fireEvent.change(code, { target: { value: "   " } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.createEvent).toHaveBeenCalledOnce());
  });
});

describe("a named field's error after a rejected save", () => {
  // BUG-UG-EVENT-FIELD-ERROR-CLEARS-ON-ANY-EDIT-20261008: any edit
  // cleared the error, even an edit to another invalid value.
  function rejectTitle(value) {
    setup();
    fillRequired();
    fireEvent.change(screen.getByLabelText("Check-in code (SG-…)"), { target: { value: "SG-VALID" } });
    fireEvent.change(screen.getByLabelText("Title"), { target: { value } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Title");
    return screen.getByLabelText("Title");
  }

  it("stays while the title is edited to another too-short value and clears on a valid one", () => {
    const title = rejectTitle("ab");
    fireEvent.change(title, { target: { value: "a" } });
    expect(screen.getByRole("alert")).toHaveTextContent("Use at least 3 characters after trimming spaces at the start and end");
    expect(title).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(title, { target: { value: "Survey deadline" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(title).not.toHaveAttribute("aria-invalid");
  });

  it("stays while a blank title loses one of its spaces", () => {
    const title = rejectTitle("   ");
    fireEvent.change(title, { target: { value: "  " } });
    expect(screen.getByRole("alert")).toHaveTextContent("Title is required.");
    expect(title).toHaveAttribute("aria-invalid", "true");
  });

  it("re-judges a value the paired device sets: invalid keeps the error, valid clears it", () => {
    const empty = { id: "", title: "", startsAt: "", location: "", summary: "", checkInCode: "", isPublic: false, isPublicAcrossAgencies: false };
    const props = { mode: "create", setForm: vi.fn(), onSubmit: vi.fn(), onCancel: vi.fn(), busy: false, chapterName: "Harborview Care United" };
    const tr = (key, vars) => `${key}${vars?.field ? `:${vars.field}` : ""}`;
    const view = render(<LanguageProvider lang="en"><EventForm {...props} form={empty} t={tr} /></LanguageProvider>);
    fireEvent.submit(view.container.querySelector("form"));
    const filled = { ...empty, id: "Not a slug", title: "Survey deadline", startsAt: "2026-11-01T12:30", location: "Online", summary: "Submit by noon", checkInCode: "bad" };
    view.rerender(<LanguageProvider lang="en"><EventForm {...props} form={filled} t={tr} /></LanguageProvider>);
    const alert = screen.getByRole("alert");
    // The empty code was never an error, so only the id the save rejected is
    // re-judged; a malformed code is named at the next save.
    expect(within(alert).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "admin.fieldId — admin.eventIdRule",
    ]);
    view.rerender(<LanguageProvider lang="en"><EventForm {...props} form={{ ...filled, id: "survey-deadline", checkInCode: "SG-VALID" }} t={tr} /></LanguageProvider>);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("judges draft values with the patterns the inputs carry", () => {
    setup();
    const fields = [
      ["Web name", "id", [["a-1", true], ["ab", false], ["a".repeat(64), true],
        ["a".repeat(65), false], ["-abc", false], ["reunión-123", false], ["A-1", false]]],
      ["Check-in code (SG-…)", "checkInCode", [["SG-Ab1", true], ["SG-a".padEnd(15, "9"), true],
        ["SG-a".padEnd(16, "9"), false], ["SG-ab", false], ["SG-１２３", false], ["SG-áB1", false]]],
    ];
    for (const [label, name, examples] of fields) {
      const input = screen.getByLabelText(label);
      expect(input.getAttribute("pattern")).toBeTruthy();
      const htmlPattern = new RegExp(`^(?:${input.getAttribute("pattern")})$`, "v");
      for (const [value, valid] of examples) {
        fireEvent.change(input, { target: { value } });
        expect(htmlPattern.test(input.value), `${name}: ${value}`).toBe(valid);
        expect(input.validity.patternMismatch, `${name}: ${value}`).toBe(!valid);
        expect(draftFieldError(name, input.value, "create") === null).toBe(valid);
      }
    }
    expect(draftFieldError("title", "", "edit")).toBeNull();
    expect(draftFieldError("checkInCode", "", "create")).toBeNull();
    expect(draftFieldError("title", "", "create")).toBe("admin.eventFormRequired");
    expect(draftFieldError("title", "ab", "edit")).toBe("admin.eventFormInvalid");
  });
});

describe("sharing an event across all agencies", () => {
  // REQ-UG-EVENT-SHARE-ACROSS-ALL-AGENCIES-WORDING-20261006: an
  // officer left the box off fearing strangers could RSVP. The audience is
  // every chapter in this organization, and turning it on takes a confirmation.
  function fillValid() {
    fillRequired();
    fireEvent.change(screen.getByLabelText("Check-in code (SG-…)"), { target: { value: "SG-VALID" } });
  }

  it("says who can see it, and cancelling the confirmation keeps sharing off", async () => {
    const { api } = setup();
    fillValid();
    const box = screen.getByLabelText("Share across all agencies in this organization");
    expect(screen.getByText("Every signed-in worker of any campaign in this organization, at every agency, can see it and RSVP. It isn't shown to the public or to other organizations.")).toBeInTheDocument();
    fireEvent.click(box);
    expect(box).not.toBeChecked();
    const confirm = screen.getByRole("group", { name: "Share this meeting across every agency?" });
    expect(confirm).toHaveTextContent("People outside this organization still can't see it.");
    // Gate round 2 on PR 4085: a repeated Space must not confirm.
    expect(within(confirm).getByRole("button", { name: "Keep it off" })).toHaveFocus();
    fireEvent.click(within(confirm).getByRole("button", { name: "Keep it off" }));
    expect(screen.queryByRole("group", { name: "Share this meeting across every agency?" })).toBeNull();
    expect(box).not.toBeChecked();
    expect(box).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.createEvent).toHaveBeenCalledWith(expect.objectContaining({ isPublicAcrossAgencies: false })));
  });

  it("turns sharing on only after the operator confirms", async () => {
    const { api } = setup();
    fillValid();
    const box = screen.getByLabelText("Share across all agencies in this organization");
    fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.createEvent).toHaveBeenCalledTimes(1));
    expect(api.createEvent.mock.calls[0][0]).toMatchObject({ isPublicAcrossAgencies: false });
  });

  it("saves the wider audience once confirmed", async () => {
    const { api } = setup();
    fillValid();
    const box = screen.getByLabelText("Share across all agencies in this organization");
    fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", { name: "Yes, share across all agencies" }));
    expect(box).toBeChecked();
    expect(screen.getByLabelText("Share with every campaign in this agency")).toBeChecked();
    fireEvent.click(box);
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", { name: "Yes, share across all agencies" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.createEvent).toHaveBeenCalledWith(expect.objectContaining({ isPublic: true, isPublicAcrossAgencies: true })));
  });

  it("restores an already-shared event's audience without a confirmation when re-checked", async () => {
    // Gate round 1 on PR 4085: re-checking only opened the
    // confirmation, so a save without confirming unshared the event.
    const shared = {
      id: "town-hall", title: "Town hall", startsAt: "2026-08-14T16:00:00Z", startsLabel: "Aug 14, noon",
      location: "Union hall", summary: "Updates", checkInCode: "SG-MEET", isPublic: true, isPublicAcrossAgencies: true,
      chapterName: "Harborview Care United", rsvpCount: 0, checkinCount: 0,
    };
    const api = { createEvent: vi.fn(), updateEvent: vi.fn().mockResolvedValue({ updated: true }) };
    render(<LanguageProvider lang="en"><EventAuthoringCard events={[shared]} api={api} onNotice={vi.fn()} reload={vi.fn()} /></LanguageProvider>);
    openPastEvents();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const box = screen.getByLabelText("Share across all agencies in this organization");
    expect(box).toBeChecked();
    fireEvent.click(box);
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    expect(box).toBeChecked();
    expect(screen.queryByRole("group", { name: "Share this meeting across every agency?" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Location"), { target: { value: "New hall" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.updateEvent).toHaveBeenCalledWith("town-hall", expect.objectContaining({ isPublicAcrossAgencies: null })));
  });

  it.each([false, true])("Keep it off restores agency sharing to %s after a paired-device confirmation", async (isPublic) => {
    // Restore the choice at confirmation time, including an unsaved agency
    // choice, rather than leaving the paired device's wider audience enabled.
    const { api } = setup();
    fillValid();
    const agency = screen.getByLabelText("Share with every campaign in this agency");
    if (isPublic) fireEvent.click(agency);
    const box = screen.getByLabelText("Share across all agencies in this organization");
    fireEvent.click(box);
    act(() => { applyDeviceParityState("admin.eventForm", { ...deviceParityValue("admin.eventForm"), isPublicAcrossAgencies: true, isPublic: true }); });
    expect(box).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Keep it off" }));
    expect(box).not.toBeChecked();
    expect(agency.checked).toBe(isPublic);
    expect(agency).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.createEvent).toHaveBeenCalledWith(expect.objectContaining({ isPublic, isPublicAcrossAgencies: false })));
  });

  it("shows the disclosure and the confirmation in Spanish", () => {
    setup("es");
    expect(screen.getByText(/No se muestra al público ni a otras organizaciones\./)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Compartir con todas las agencias de esta organización"));
    const confirm = screen.getByRole("group", { name: "¿Compartir esta reunión con todas las agencias?" });
    expect(within(confirm).getByRole("button", { name: "Sí, compartir con todas las agencias" })).toBeInTheDocument();
    expect(within(confirm).getByRole("button", { name: "Dejarlo desactivado" })).toBeInTheDocument();
  });
});

describe("an id or code with surrounding spaces", () => {
  // BUG-UG-EVENT-ID-CODE-UNTRIMMED-PATTERN-20261008: the pattern was
  // tested on the raw input, so a trailing space the API trims away blocked
  // the save.
  function editMeeting() {
    const updateEvent = vi.fn().mockResolvedValue({ updated: true });
    render(<LanguageProvider lang="en"><EventAuthoringCard
      events={[{ id: "meeting", title: "Meeting", startsAt: "2026-11-01T15:00:27Z", location: "Hall", summary: "Agenda", checkInCode: "SG-VALID" }]}
      api={{ updateEvent }} onNotice={vi.fn()} reload={vi.fn()}
    /></LanguageProvider>);
    openPastEvents();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    return updateEvent;
  }

  it("saves a new event whose id and code carry a trailing space", async () => {
    const { api } = setup();
    fillRequired();
    fireEvent.change(screen.getByLabelText("Web name"), { target: { value: "survey-deadline " } });
    fireEvent.change(screen.getByLabelText("Check-in code (SG-…)"), { target: { value: "SG-VALID " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(api.createEvent).toHaveBeenCalledTimes(1));
  });

  it("keeps the code when an edit leaves only spaces in it", async () => {
    const updateEvent = editMeeting();
    fireEvent.change(screen.getByLabelText("Check-in code (SG-…)"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(updateEvent).toHaveBeenCalledWith("meeting", expect.objectContaining({ checkInCode: null })));
  });

  it("drops a rejected code's error once an edit leaves only spaces, and the save agrees", async () => {
    //  gate round 1 (P3): the draft check cleared this error while Save
    // still refused the spaces.
    const updateEvent = editMeeting();
    const code = screen.getByLabelText("Check-in code (SG-…)");
    fireEvent.change(code, { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Check-in code (SG-…)");
    fireEvent.change(code, { target: { value: "   " } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.queryByRole("alert")).toBeNull();
    await waitFor(() => expect(updateEvent).toHaveBeenCalledWith("meeting", expect.objectContaining({ checkInCode: null })));
  });

  it("judges the draft the way the API sends it", () => {
    expect(draftFieldError("id", "survey-deadline ", "create")).toBeNull();
    expect(draftFieldError("checkInCode", " SG-VALID ", "create")).toBeNull();
    expect(draftFieldError("checkInCode", "sg-valid", "create")).toBeNull();
    expect(draftFieldError("checkInCode", "   ", "edit")).toBeNull();
    expect(draftFieldError("checkInCode", "   ", "create")).toBeNull();
    expect(draftFieldError("id", "Survey-deadline ", "create")).toBe("admin.eventFormInvalid");
  });
});

describe("event schedule authoring", () => {
  it("rejects an end before the start, then saves a valid end", async () => {
    const { api } = setup(); fillRequired();
    fireEvent.change(screen.getByLabelText("Ends (optional)"), { target: { value: '2026-11-01T12:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByRole('alert')).toHaveTextContent('End time must be after the start.');
    expect(api.createEvent).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Ends (optional)'), { target: { value: '2026-11-01T13:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.createEvent).toHaveBeenCalledWith(expect.objectContaining({ endsAt: new Date('2026-11-01T13:30').toISOString() })));
  });
  it.each(['deadline', 'date_only'])("saves %s with a date and no hour or code", async (kind) => {
    const { api } = setup(); fillRequired();
    fireEvent.change(screen.getByLabelText("Meeting type"), { target: { value: kind } });
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-11-01' } });
    expect(screen.queryByLabelText('Starts')).toBeNull();
    expect(screen.queryByLabelText('Check-in code (SG-…)')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.createEvent).toHaveBeenCalledWith(expect.objectContaining({ eventKind: kind, eventDate: '2026-11-01', startsAt: null, endsAt: null, checkInCode: '' })));
  });
  it("sends the finite monthly count with the author's timezone", async () => {
    const { api } = setup(); fillRequired();
    fireEvent.change(screen.getByLabelText('Monthly dates (including the first)'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.createEvent).toHaveBeenCalledWith(expect.objectContaining({ occurrences: '3', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })));
  });
  it("clears an end without rescheduling the stored seconds", async () => {
    const updateEvent = vi.fn().mockResolvedValue({ updated: true });
    render(<LanguageProvider lang="en"><EventAuthoringCard events={[{ id: 'meeting', title: 'Meeting', startsAt: '2026-11-01T15:00:27Z', endsAt: '2026-11-01T16:00:37Z', location: 'Hall', summary: 'Agenda', checkInCode: '' }]} api={{ updateEvent }} onNotice={vi.fn()} reload={vi.fn()} /></LanguageProvider>);
    openPastEvents();
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Ends (optional)'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(updateEvent).toHaveBeenCalledWith('meeting', expect.objectContaining({ schedule: { kind: 'meeting', startsAt: '2026-11-01T15:00:27Z', endsAt: null, eventDate: null } })));
  });
});
