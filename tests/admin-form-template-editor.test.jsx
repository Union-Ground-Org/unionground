import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AdminFormTemplateEditor } from "../src/components/AdminFormTemplateEditor.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { templateFromDbRow } from "../src/lib/formTemplates.js";
import { upsertDemoFormTemplate } from "../src/lib/demoFormTemplateRegistry.js";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";

const ROWS = [
  {
    key: "grievance",
    version: 1,
    label_en: "Old grievance",
    label_es: "Queja anterior",
    blurb_en: "Old instructions",
    blurb_es: "Instrucciones anteriores",
    icon: "⚖",
    points: 20,
    active: false,
    sort: 1,
    field_schema: {
      steps: [{
        title: { en: "Old issue", es: "Asunto anterior" },
        fields: [{ key: "summary", type: "text", label: { en: "Summary", es: "Resumen" }, required: true, maxLength: 200 }],
      }],
    },
  },
  {
    key: "grievance",
    version: 2,
    label_en: "Grievance report",
    label_es: "Reporte de queja",
    blurb_en: "Report a contract violation.",
    blurb_es: "Reporta una violación del contrato.",
    icon: "⚖",
    points: 25,
    active: true,
    sort: 1,
    field_schema: {
      steps: [{
        title: { en: "The issue", es: "El asunto" },
        fields: [{ key: "summary", type: "text", label: { en: "Issue summary", es: "Resumen del asunto" }, required: true, maxLength: 200 }],
      }],
    },
  },
];

function makeApi(overrides = {}) {
  return {
    loadFormTemplates: vi.fn().mockResolvedValue(ROWS),
    upsertFormTemplate: vi.fn().mockResolvedValue({ key: "leave_request", version: 1, active: true }),
    deactivateFormTemplate: vi.fn().mockResolvedValue({ key: "grievance", active: false }),
    reactivateFormTemplate: vi.fn().mockResolvedValue({ key: "grievance", active: true }),
    ...overrides,
  };
}

function renderEditor({ lang = "en", demo = false, api = makeApi() } = {}) {
  render(
    <LanguageProvider lang={lang}>
      <AdminFormTemplateEditor api={api} demo={demo} />
    </LanguageProvider>,
  );
  return api;
}

describe("admin form template editor", () => {
  it("shows pending, then groups the complete registry on each latest version", async () => {
    let resolve;
    const api = makeApi({ loadFormTemplates: vi.fn(() => new Promise((done) => { resolve = done; })) });
    renderEditor({ api });
    expect(screen.getByText("Loading form templates…")).toBeInTheDocument();
    resolve(ROWS);
    expect(await screen.findByRole("heading", { name: "Grievance report" })).toBeInTheDocument();
    expect(screen.getByText("Version 2 · 2 versions")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Old grievance" })).toBeNull();
    // Union Ground has no points economy: a stored row's legacy points
    // value never reaches the registry card.
    expect(screen.queryByText(/\bpoints?\b/i)).toBeNull();
    expect(screen.queryByText(/\b25\b/)).toBeNull();
  });

  it("keeps the template key behind a details control and says a single version once", async () => {
    const single = { ...ROWS[1], key: "fmla_self", label_en: "Family leave", label_es: "Licencia familiar", version: 1 };
    for (const [lang, heading, summary, name, keyLine, versionLine] of [
      ["en", "Family leave", "Technical details", "Technical details for Family leave", "Template key: fmla_self", "Version 1"],
      ["es", "Licencia familiar", "Detalles técnicos", "Detalles técnicos de Licencia familiar", "Clave de la plantilla: fmla_self", "Versión 1"],
    ]) {
      const view = render(
        <LanguageProvider lang={lang}>
          <AdminFormTemplateEditor api={makeApi({ loadFormTemplates: vi.fn().mockResolvedValue([single]) })} demo={false} />
        </LanguageProvider>,
      );
      const card = (await screen.findByRole("heading", { name: heading })).closest("article");
      // The owner's screenshot: "fmla_self" in typewriter text under the title, then "Version 1 · 1 version".
      expect(within(card).getByText(versionLine)).toBeInTheDocument();
      expect(card.textContent).not.toMatch(/1 version\b|1 versión\b/);
      const key = within(card).getByText(keyLine);
      expect(key).not.toBeVisible();
      const control = within(card).getByText(summary);
      expect(control.tagName).toBe("SUMMARY");
      expect(control).toHaveAttribute("aria-label", name);
      fireEvent.click(control);
      expect(key).toBeVisible();
      view.unmount();
    }
  });

  it("edits the organization's FMLA copy ahead of a newer seed and sorts by the chosen rows", async () => {
    const owned = {
      ...ROWS[1], key: "fmla_self", label_en: "Local leave", version: 2,
      organization_id: "organization-a", is_platform_seed: false, active: false, sort: 1,
    };
    const api = makeApi({ loadFormTemplates: vi.fn().mockResolvedValue([
      { ...ROWS[1], sort: 2 },
      { ...owned, label_en: "New platform leave", version: 3, organization_id: null, is_platform_seed: true, active: true, sort: 50 },
      owned,
      { ...ROWS[1], key: "accommodation", label_en: "Accommodation", sort: 1 },
    ]) });
    renderEditor({ api });
    const heading = await screen.findByRole("heading", { name: "Local leave" });
    expect(screen.getAllByRole("heading", { level: 3 }).map((node) => node.textContent))
      .toEqual(["Accommodation", "Local leave", "Grievance report"]);
    expect(screen.queryByRole("heading", { name: "New platform leave" })).toBeNull();
    const card = heading.closest("article");
    expect(within(card).getByText("Version 2 · 2 versions")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Reactivate Local leave" })).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Edit / new version" }));
    expect(screen.getByLabelText("English label")).toHaveValue("Local leave");
    expect(screen.getByLabelText("Sort order")).toHaveValue(1);
  });

  it("distinguishes load failure from empty and retries in place", async () => {
    const api = makeApi({
      loadFormTemplates: vi.fn()
        .mockRejectedValueOnce(new Error("Form templates: denied"))
        .mockResolvedValueOnce([]),
    });
    renderEditor({ api });
    expect(await screen.findByRole("alert")).toHaveTextContent("Form templates could not load.");
    expect(screen.getByRole("alert")).not.toHaveTextContent("denied");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("No templates yet. Create the first form template.")) .toBeInTheDocument();
    expect(api.loadFormTemplates).toHaveBeenCalledTimes(2);
  });

  it("builds and saves a bilingual choice field through the structured editor", async () => {
    const api = makeApi({ loadFormTemplates: vi.fn().mockResolvedValue([]) });
    renderEditor({ api });
    await screen.findByText("No templates yet. Create the first form template.");
    fireEvent.click(screen.getByRole("button", { name: "New template" }));

    fireEvent.change(screen.getByLabelText("Template key"), { target: { value: "leave_request" } });
    fireEvent.change(screen.getByLabelText("English label"), { target: { value: "Leave request" } });
    fireEvent.change(screen.getByLabelText("Spanish label"), { target: { value: "Solicitud de licencia" } });
    fireEvent.change(screen.getByLabelText("English description"), { target: { value: "Ask for protected leave." } });
    fireEvent.change(screen.getByLabelText("Spanish description"), { target: { value: "Solicita licencia protegida." } });
    fireEvent.change(screen.getByLabelText("Icon"), { target: { value: "🗓" } });
    // No Points field: form templates never carry points in Union Ground.
    expect(screen.queryByLabelText("Points")).toBeNull();
    expect(screen.queryByText("Points")).toBeNull();
    fireEvent.change(screen.getByLabelText("Sort order"), { target: { value: "8" } });
    fireEvent.change(screen.getByLabelText("Step 1 English title"), { target: { value: "Leave details" } });
    fireEvent.change(screen.getByLabelText("Step 1 Spanish title"), { target: { value: "Detalles de licencia" } });
    fireEvent.change(screen.getByLabelText("Step 1 field 1 key"), { target: { value: "leave_pattern" } });
    expect(screen.getByLabelText("Step 1 field 1 key")).toHaveAccessibleDescription("Use 2-61 characters from a-z, 0-9, or _. Start with a letter from a-z.");
    fireEvent.change(screen.getByLabelText("Step 1 field 1 type"), { target: { value: "select" } });
    fireEvent.change(screen.getByLabelText("Step 1 field 1 English label"), { target: { value: "Leave pattern" } });
    fireEvent.change(screen.getByLabelText("Step 1 field 1 Spanish label"), { target: { value: "Tipo de licencia" } });
    fireEvent.click(screen.getByRole("button", { name: "Add option to field 1" }));
    expect(screen.getByLabelText("Field 1 option 1 value")).toHaveAccessibleDescription("Use 1-60 characters from a-z, 0-9, _ or -.");
    fireEvent.change(screen.getByLabelText("Field 1 option 1 value"), { target: { value: "continuous" } });
    fireEvent.change(screen.getByLabelText("Field 1 option 1 English label"), { target: { value: "Continuous" } });
    fireEvent.change(screen.getByLabelText("Field 1 option 1 Spanish label"), { target: { value: "Continua" } });
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));

    await vi.waitFor(() => expect(api.upsertFormTemplate).toHaveBeenCalledTimes(1));
    expect(api.upsertFormTemplate).toHaveBeenCalledWith({
      key: "leave_request",
      labelEn: "Leave request",
      labelEs: "Solicitud de licencia",
      blurbEn: "Ask for protected leave.",
      blurbEs: "Solicita licencia protegida.",
      icon: "🗓",
      sort: 8,
      active: true,
      fieldSchema: {
        steps: [{
          title: { en: "Leave details", es: "Detalles de licencia" },
          fields: [{
            key: "leave_pattern",
            type: "select",
            label: { en: "Leave pattern", es: "Tipo de licencia" },
            required: false,
            options: [{ value: "continuous", label: { en: "Continuous", es: "Continua" } }],
          }],
        }],
      },
    });
    expect(api.upsertFormTemplate.mock.calls[0][0]).not.toHaveProperty("points");
    const saved = await screen.findByText("Template saved as a new version.");
    expect(saved.closest('[role="status"]').previousElementSibling).toContainElement(screen.getByRole("button", { name: "New template" }));
    expect(api.loadFormTemplates).toHaveBeenCalledTimes(2);
  });

  it("validates rendered field keys and option values with the browser's pattern syntax", async () => {
    renderEditor();
    fireEvent.click(await screen.findByRole("button", { name: "New template" }));
    fireEvent.change(screen.getByLabelText("Step 1 field 1 type"), { target: { value: "select" } });
    fireEvent.click(screen.getByRole("button", { name: "Add option to field 1" }));

    const fields = [
      ["Step 1 field 1 key", ["a0", "field_name", "a".repeat(61)], ["a", "a".repeat(62), "1key", "field-name", "FIELD"]],
      ["Field 1 option 1 value", ["a", "paid_leave-2", "a".repeat(60)], ["a".repeat(61), "paid leave", "Paid", "paid/leave"]],
    ];
    for (const [label, accepted, rejected] of fields) {
      const input = screen.getByLabelText(label);
      const pattern = input.getAttribute("pattern");
      expect(pattern).toBeTruthy();
      const htmlPattern = new RegExp(`^(?:${pattern})$`, "v");
      for (const [values, matches] of [[accepted, true], [rejected, false]]) {
        for (const value of values) {
          fireEvent.change(input, { target: { value } });
          expect(htmlPattern.test(value), `${label}: ${value}`).toBe(matches);
          expect(input.validity.patternMismatch, `${label}: ${value}`).toBe(!matches);
        }
      }
    }
  });

  // REQ-UG-FORM-BUILDER-SPANISH-OPTIONAL-20261006: an English-only
  // organization could not save a survey without Spanish on every step, field
  // and choice.
  it("saves an English-only template and members reading Spanish see the English", async () => {
    const api = makeApi({ loadFormTemplates: vi.fn().mockResolvedValue([]) });
    renderEditor({ api });
    await screen.findByText("No templates yet. Create the first form template.");
    fireEvent.click(screen.getByRole("button", { name: "New template" }));
    expect(screen.getByText("Spanish is optional. A Spanish box left blank is saved with the English text, and a Spanish box that matches the English changes with it when you edit the English. Type your own Spanish to keep it separate.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Template key"), { target: { value: "shift_survey" } });
    fireEvent.change(screen.getByLabelText("English label"), { target: { value: "Shift survey" } });
    fireEvent.change(screen.getByLabelText("English description"), { target: { value: "Tell us about your shifts." } });
    fireEvent.change(screen.getByLabelText("Step 1 English title"), { target: { value: "Your shifts" } });
    fireEvent.change(screen.getByLabelText("Step 1 field 1 key"), { target: { value: "shift" } });
    fireEvent.change(screen.getByLabelText("Step 1 field 1 type"), { target: { value: "radio" } });
    fireEvent.change(screen.getByLabelText("Step 1 field 1 English label"), { target: { value: "Which shift?" } });
    fireEvent.click(screen.getByRole("button", { name: "Add option to field 1" }));
    fireEvent.change(screen.getByLabelText("Field 1 option 1 value"), { target: { value: "nights" } });
    fireEvent.change(screen.getByLabelText("Field 1 option 1 English label"), { target: { value: "Nights" } });
    for (const label of ["Spanish label", "Step 1 Spanish title", "Step 1 field 1 Spanish label", "Field 1 option 1 Spanish label"]) {
      expect(screen.getByLabelText(label)).not.toBeRequired();
    }
    expect(screen.getByRole("button", { name: "Save template" }).closest("form").checkValidity()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));

    await vi.waitFor(() => expect(api.upsertFormTemplate).toHaveBeenCalledTimes(1));
    const saved = api.upsertFormTemplate.mock.calls[0][0];
    expect(saved.labelEs).toBe("Shift survey");
    expect(saved.blurbEs).toBe("Tell us about your shifts.");
    expect(saved.fieldSchema.steps[0].title).toEqual({ en: "Your shifts", es: "Your shifts" });
    expect(saved.fieldSchema.steps[0].fields[0].label).toEqual({ en: "Which shift?", es: "Which shift?" });
    expect(saved.fieldSchema.steps[0].fields[0].options).toEqual([{ value: "nights", label: { en: "Nights", es: "Nights" } }]);

    const member = templateFromDbRow({
      key: saved.key, version: 1, label_en: saved.labelEn, label_es: saved.labelEs,
      blurb_en: saved.blurbEn, blurb_es: saved.blurbEs, field_schema: saved.fieldSchema,
    }, "es");
    expect(member.titleKey).toBe("Shift survey");
    expect(member.steps[0].titleKey).toBe("Your shifts");
    expect(member.steps[0].fields[0].labelKey).toBe("Which shift?");
    expect(member.steps[0].fields[0].options[0].labelKey).toBe("Nights");
  });

  it("reopens stored Spanish as saved, and Spanish that matches the English follows English edits on screen", async () => {
    // Gate round 1: stored Spanish must reopen as saved, never
    // blanked. Gate round 2: a saved copy of the English must not go
    // stale when the English is corrected, so a Spanish box that matches the
    // English changes with it, visibly, until the admin types other Spanish.
    const englishOnly = {
      ...ROWS[1],
      field_schema: { steps: [{ title: { en: "Your shifts", es: "Your shifts" }, fields: [{ key: "agree", type: "radio", label: { en: "Agree?", es: "¿De acuerdo?" }, required: true, options: [{ value: "no", label: { en: "No", es: "No" } }, { value: "maybe", label: { en: "Maybe", es: "Maybe" } }] }] }] },
    };
    const api = makeApi({ loadFormTemplates: vi.fn().mockResolvedValue([englishOnly]) });
    renderEditor({ api });
    fireEvent.click(await screen.findByRole("button", { name: "Edit / new version" }));
    expect(screen.getByLabelText("Field 1 option 1 Spanish label")).toHaveValue("No");
    expect(screen.getByLabelText("Spanish label")).toHaveValue("Reporte de queja");
    fireEvent.change(screen.getByLabelText("Step 1 English title"), { target: { value: "Your work shifts" } });
    expect(screen.getByLabelText("Step 1 Spanish title")).toHaveValue("Your work shifts");
    fireEvent.change(screen.getByLabelText("Field 1 option 1 English label"), { target: { value: "No, never" } });
    expect(screen.getByLabelText("Field 1 option 1 Spanish label")).toHaveValue("No, never");
    fireEvent.change(screen.getByLabelText("Step 1 field 1 English label"), { target: { value: "Do you agree?" } });
    fireEvent.change(screen.getByLabelText("Field 1 option 2 Spanish label"), { target: { value: "Quizás" } });
    fireEvent.change(screen.getByLabelText("Field 1 option 2 English label"), { target: { value: "Maybe later" } });
    fireEvent.change(screen.getByLabelText("English label"), { target: { value: "Grievance report form" } });
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));

    await vi.waitFor(() => expect(api.upsertFormTemplate).toHaveBeenCalledTimes(1));
    const saved = api.upsertFormTemplate.mock.calls[0][0];
    const step = saved.fieldSchema.steps[0];
    expect(step.title).toEqual({ en: "Your work shifts", es: "Your work shifts" });
    expect(step.fields[0].label).toEqual({ en: "Do you agree?", es: "¿De acuerdo?" });
    expect(step.fields[0].options.map((option) => option.label)).toEqual([
      { en: "No, never", es: "No, never" },
      { en: "Maybe later", es: "Quizás" },
    ]);
    expect(saved.labelEs).toBe("Reporte de queja");
  });

  it.each([
    ["empty", ""],
    ["whitespace-only", "   "],
    ["overlong", "x".repeat(121)],
    ["overlong in Unicode code points", "x".repeat(62) + "😀".repeat(59)],
  ])("refuses a %s English label in the demo and saves after correction with Spanish blank", async (_, labelEn) => {
    let rows = [];
    const api = makeApi({
      loadFormTemplates: vi.fn(async () => rows),
      upsertFormTemplate: vi.fn(async (fields) => {
        const update = upsertDemoFormTemplate(rows, fields);
        rows = update.rows;
        return update.result;
      }),
    });
    renderEditor({ api, demo: true });
    fireEvent.click(await screen.findByRole("button", { name: "New template" }));
    fireEvent.change(screen.getByLabelText("Template key"), { target: { value: "shift_survey" } });
    fireEvent.change(screen.getByLabelText("Step 1 English title"), { target: { value: "Your shifts" } });
    fireEvent.change(screen.getByLabelText("Step 1 field 1 key"), { target: { value: "shift" } });
    fireEvent.change(screen.getByLabelText("Step 1 field 1 English label"), { target: { value: "Which shift?" } });
    fireEvent.change(screen.getByLabelText("English label"), { target: { value: labelEn } });
    const save = screen.getByRole("button", { name: "Save template" });
    if (labelEn === "   ") {
      // Spaces pass native required validation: exercise the actual save click.
      expect(save.closest("form").checkValidity()).toBe(true);
      fireEvent.click(save);
    } else {
      // Exercise the application guard independently of required/maxLength.
      fireEvent.submit(save.closest("form"));
    }
    expect(await screen.findByRole("alert")).toHaveTextContent("English label must contain 1–120 characters.");
    expect(api.upsertFormTemplate).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
    expect(screen.getByLabelText("English label")).toHaveValue(labelEn);

    expect(screen.getByLabelText("Spanish label")).not.toBeRequired();
    expect(screen.getByLabelText("Spanish label")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("English label"), { target: { value: "  Shift survey  " } });
    fireEvent.click(save);
    await vi.waitFor(() => expect(rows).toHaveLength(1));
    expect(api.upsertFormTemplate).toHaveBeenCalledTimes(1);
    expect(rows[0]).toMatchObject({ label_en: "Shift survey", label_es: "Shift survey" });
    expect(await screen.findByText("Preview template saved. It will reset when you leave the demo.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("saves a trimmed 120-code-point English label containing astral characters in the demo", async () => {
    let rows = [];
    const api = makeApi({
      loadFormTemplates: vi.fn(async () => rows),
      upsertFormTemplate: vi.fn(async (fields) => {
        const update = upsertDemoFormTemplate(rows, fields);
        rows = update.rows;
        return update.result;
      }),
    });
    renderEditor({ api, demo: true });
    fireEvent.click(await screen.findByRole("button", { name: "New template" }));
    fireEvent.change(screen.getByLabelText("Template key"), { target: { value: "shift_survey" } });
    fireEvent.change(screen.getByLabelText("Step 1 English title"), { target: { value: "Your shifts" } });
    fireEvent.change(screen.getByLabelText("Step 1 field 1 key"), { target: { value: "shift" } });
    fireEvent.change(screen.getByLabelText("Step 1 field 1 English label"), { target: { value: "Which shift?" } });
    const labelEn = "x".repeat(62) + "😀".repeat(58);
    fireEvent.change(screen.getByLabelText("English label"), { target: { value: `  ${labelEn}  ` } });
    // Exercise the application guard independently of HTML's UTF-16 maxLength.
    fireEvent.submit(screen.getByRole("button", { name: "Save template" }).closest("form"));
    await vi.waitFor(() => expect(api.upsertFormTemplate).toHaveBeenCalledTimes(1));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label_en: labelEn, label_es: labelEn });
    expect(await screen.findByText("Preview template saved. It will reset when you leave the demo.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // BUG-UG-DEMO-FORM-TEMPLATE-UNTRIMMED-ENGLISH-20261008: the demo
  // registry kept "Shift survey " beside the trimmed Spanish "Shift survey",
  // so after reload the pair no longer matched and stopped following edits.
  it("saves trimmed English in the demo so a blank-Spanish label reloads as a pair that follows English edits", async () => {
    let rows = [];
    const api = makeApi({
      loadFormTemplates: vi.fn(async () => rows),
      upsertFormTemplate: vi.fn(async (fields) => {
        const update = upsertDemoFormTemplate(rows, fields, "2026-10-08T15:00:00.000Z");
        rows = update.rows;
        return update.result;
      }),
    });
    renderEditor({ api, demo: true });
    fireEvent.click(await screen.findByRole("button", { name: "New template" }));
    fireEvent.change(screen.getByLabelText("Template key"), { target: { value: "shift_survey" } });
    fireEvent.change(screen.getByLabelText("English label"), { target: { value: "Shift survey  " } });
    fireEvent.change(screen.getByLabelText("English description"), { target: { value: "Tell us about your shifts.\n" } });
    fireEvent.change(screen.getByLabelText("Step 1 English title"), { target: { value: "Your shifts" } });
    fireEvent.change(screen.getByLabelText("Step 1 field 1 key"), { target: { value: "shift" } });
    fireEvent.change(screen.getByLabelText("Step 1 field 1 English label"), { target: { value: "Which shift?" } });
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));

    await vi.waitFor(() => expect(rows).toHaveLength(1));
    expect(rows[0]).toMatchObject({
      key: "shift_survey",
      label_en: "Shift survey", label_es: "Shift survey",
      blurb_en: "Tell us about your shifts.", blurb_es: "Tell us about your shifts.",
    });

    fireEvent.click(await screen.findByRole("button", { name: "Edit / new version" }));
    expect(screen.getByLabelText("English label")).toHaveValue("Shift survey");
    expect(screen.getByLabelText("Spanish label")).toHaveValue("Shift survey");
    fireEvent.change(screen.getByLabelText("English label"), { target: { value: "Shift and overtime survey" } });
    expect(screen.getByLabelText("Spanish label")).toHaveValue("Shift and overtime survey");
    fireEvent.change(screen.getByLabelText("English description"), { target: { value: "Tell us about your shifts and overtime." } });
    expect(screen.getByLabelText("Spanish description")).toHaveValue("Tell us about your shifts and overtime.");
  });

  it("tells admins on the steps section that Spanish is optional, in both languages", async () => {
    renderEditor({ api: makeApi({ loadFormTemplates: vi.fn().mockResolvedValue([]) }) });
    fireEvent.click(await screen.findByRole("button", { name: "New template" }));
    expect(screen.getByText("English is required for every step, field, and choice. Spanish is optional; a blank Spanish entry is saved with the English, and Spanish that matches the English follows your English edits.")).toBeInTheDocument();
    expect(screen.queryByText(/Both languages are required/)).toBeNull();
  });

  it("keeps the form pending, preserves failures, and supports cancel", async () => {
    let rejectSave;
    const api = makeApi({ upsertFormTemplate: vi.fn(() => new Promise((_, reject) => { rejectSave = reject; })) });
    renderEditor({ api });
    await screen.findByRole("heading", { name: "Grievance report" });
    fireEvent.click(screen.getByRole("button", { name: "Edit / new version" }));
    const save = screen.getByRole("button", { name: "Save template" });
    fireEvent.click(save);
    expect(screen.getByRole("button", { name: "Saving…" })).toHaveAttribute("aria-disabled", "true");
    rejectSave(new Error("Save form template: admin role required"));
    const error = await within(save.closest(".ftm-actions")).findByText("The template could not be saved.");
    expect(error.closest('[role="alert"]')).not.toBeNull();
    expect(error).not.toHaveTextContent("admin role required");
    expect(screen.getByDisplayValue("Grievance report")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel editing" })[0]);
    expect(screen.queryByDisplayValue("Grievance report")).toBeNull();
  });

  it.each([
    ["en", "Edit / new version", "Save template", "English label", "Your role does not allow this change, so nothing was changed.", "Template saved as a new version."],
    ["es", "Editar / nueva versión", "Guardar plantilla", "Etiqueta en inglés", "Tu rol no permite este cambio, así que no se cambió nada.", "Plantilla guardada como una versión nueva."],
  ])("keeps the template save result beside its control in %s", async (lang, edit, save, label, refusal, success) => {
    const api = makeApi();
    api.upsertFormTemplate.mockRejectedValueOnce(Object.assign(new Error("internal policy detail"), { code: "42501" }));
    renderEditor({ api, lang });
    const opener = await screen.findByRole("button", { name: edit });
    fireEvent.click(opener);
    const submit = screen.getByRole("button", { name: save });
    const title = screen.getByLabelText(label);
    fireEvent.change(title, { target: { value: "Updated template" } });
    fireEvent.click(submit);
    const error = await within(submit.closest(".ftm-actions")).findByText(refusal);
    expect(error.closest('[role="alert"]')).toBeInTheDocument();
    expect(title).toHaveValue("Updated template");
    fireEvent.change(title, { target: { value: "Revised template" } });
    expect(error).not.toBeInTheDocument();
    fireEvent.click(submit);
    const confirmation = await within(opener.closest("article")).findByText(success);
    expect(confirmation.closest('[role="status"]')).toBeInTheDocument();
    expect(opener).toHaveFocus();
    fireEvent.click(opener);
    expect(confirmation).not.toBeInTheDocument();
  });

  it("keeps newer template edits when the previous save finishes", async () => {
    let finish;
    const api = makeApi({ upsertFormTemplate: vi.fn(() => new Promise((resolve) => { finish = resolve; })) });
    renderEditor({ api });
    fireEvent.click(await screen.findByRole("button", { name: "Edit / new version" }));
    const label = screen.getByLabelText("English label");
    fireEvent.change(label, { target: { value: "Submitted title" } });
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    fireEvent.change(label, { target: { value: "Newer title" } });
    finish();
    await screen.findByRole("button", { name: "Save template" });
    expect(label).toHaveValue("Newer title");
    expect(screen.queryByText("Template saved as a new version.")).not.toBeInTheDocument();
    expect(api.upsertFormTemplate).toHaveBeenCalledWith(expect.objectContaining({ labelEn: "Submitted title" }));
  });

  it.each(["pending", "rejected"])("confirms a template save when its refresh is %s", async (refresh) => {
    const api = makeApi();
    api.loadFormTemplates.mockImplementationOnce(async () => ROWS).mockImplementationOnce(() => (
      refresh === "pending" ? new Promise(() => {}) : Promise.reject(new Error("read refused"))
    ));
    renderEditor({ api });
    fireEvent.click(await screen.findByRole("button", { name: "Edit / new version" }));
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    expect(await screen.findByText("Template saved as a new version.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Saving…" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New template" })).not.toHaveAttribute("aria-disabled", "true");
    expect(api.loadFormTemplates).toHaveBeenCalledTimes(2);
    if (refresh === "rejected") expect(await screen.findByText("Form templates could not load.")).toBeInTheDocument();
    expect(screen.queryByText("The template could not be saved.")).not.toBeInTheDocument();
  });

  it("requires confirmation before deactivation and can reactivate the latest version", async () => {
    const api = makeApi({
      loadFormTemplates: vi.fn()
        .mockResolvedValueOnce(ROWS)
        .mockResolvedValueOnce([{ ...ROWS[1], active: false }])
        .mockResolvedValueOnce([{ ...ROWS[1], active: true }]),
    });
    renderEditor({ api });
    await screen.findByRole("heading", { name: "Grievance report" });
    fireEvent.click(screen.getByRole("button", { name: "Deactivate Grievance report" }));
    expect(api.deactivateFormTemplate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm deactivation" }));
    await vi.waitFor(() => expect(api.deactivateFormTemplate).toHaveBeenCalledWith("grievance"));

    fireEvent.click(await screen.findByRole("button", { name: "Reactivate Grievance report" }));
    await vi.waitFor(() => expect(api.reactivateFormTemplate).toHaveBeenCalledWith("grievance"));
  });

  it("localizes the complete surface and labels demo writes as resettable preview data", async () => {
    renderEditor({ lang: "es", demo: true });
    expect(await screen.findByRole("heading", { name: "Reporte de queja" })).toBeInTheDocument();
    expect(screen.getByText("Vista previa solamente — los cambios de plantillas se restablecen al salir de la demo.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Editar / nueva versión" })).toBeInTheDocument();
    expect(screen.getByText("Activa")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Editar / nueva versión" }));
    expect(screen.getByLabelText("Clave del campo 1 del paso 1")).toHaveAccessibleDescription("Usa de 2 a 61 caracteres de a-z, 0-9 o _. Empieza con una letra de a-z.");
    fireEvent.change(screen.getByLabelText("Tipo del campo 1 del paso 1"), { target: { value: "select" } });
    fireEvent.click(screen.getByRole("button", { name: "Añadir opción al campo 1" }));
    expect(screen.getByLabelText("Valor de la opción 1 del campo 1")).toHaveAccessibleDescription("Usa de 1 a 60 caracteres de a-z, 0-9, _ o -.");
  });

  // The generic role of a div does not support an accessible name, so a named
  // container has to say what it is before assistive technology will keep the
  // name. This guard also fails on any future named div or span added without
  // an explicit role.
  it("exposes every named container with a supported role", async () => {
    renderEditor();
    const registry = await screen.findByRole("list", { name: "Form template registry" });
    expect(within(registry).getAllByRole("listitem")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "New template" }));
    expect(screen.getByRole("group", { name: "Reorder step 1" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Reorder field 1" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Deactivate Grievance report" }));

    const named = [...document.body.querySelectorAll("div[aria-label], div[aria-labelledby], span[aria-label], span[aria-labelledby]")];
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((node) => !node.getAttribute("role")).map((node) => node.outerHTML)).toEqual([]);
  });

  it.each([
    ["en", "Edit / new version", "Step 1", ["Add step", "Add field", "Add option to field 1"],
      ["11 of 12 steps", "29 of 30 fields in this step", "39 of 40 options for this field"],
      ["12 of 12 steps", "30 of 30 fields in this step", "40 of 40 options for this field"],
      "Limit reached", "Remove option 1"],
    ["es", "Editar / nueva versión", "Paso 1", ["Añadir paso", "Añadir campo", "Añadir opción al campo 1"],
      ["11 de 12 pasos", "29 de 30 campos en este paso", "39 de 40 opciones para este campo"],
      ["12 de 12 pasos", "30 de 30 campos en este paso", "40 de 40 opciones para este campo"],
      "Límite alcanzado", "Quitar opción 1"],
  ])("states the template caps before and after each Add reaches its limit in %s",
    async (lang, edit, stepName, add, before, capped, reached, removeOption) => {
      const standardField = ROWS[1].field_schema.steps[0].fields[0];
      const fields = Array.from({ length: 29 }, (_, index) => ({ ...standardField, key: `field_${index}` }));
      fields[0] = {
        key: "choice", type: "select", label: { en: "Choice", es: "Opción" }, required: true,
        options: Array.from({ length: 39 }, (_, index) => ({ value: `option_${index}`, label: { en: `Option ${index}`, es: `Opción ${index}` } })),
      };
      const steps = Array.from({ length: 11 }, (_, index) => ({
        title: { en: `Section ${index + 1}`, es: `Sección ${index + 1}` },
        fields: index === 0 ? fields : [{ ...standardField, key: `summary_${index}` }],
      }));
      renderEditor({ lang, api: makeApi({ loadFormTemplates: vi.fn().mockResolvedValue([{ ...ROWS[1], field_schema: { steps } }]) }) });
      fireEvent.click(await screen.findByRole("button", { name: edit }));
      const firstStep = within(screen.getByRole("group", { name: stepName }));
      const buttons = [
        screen.getByRole("button", { name: add[0] }),
        firstStep.getByRole("button", { name: add[1] }),
        firstStep.getByRole("button", { name: add[2] }),
      ];
      buttons.forEach((button, index) => {
        expect(button).toBeEnabled();
        expect(button).toHaveAccessibleDescription(expect.stringContaining(before[index]));
        fireEvent.click(button);
        expect(button).toBeDisabled();
        expect(button).toHaveAccessibleDescription(expect.stringContaining(capped[index]));
        expect(button).toHaveAccessibleDescription(expect.stringContaining(reached));
      });
      fireEvent.click(firstStep.getByRole("button", { name: removeOption }));
      expect(buttons[2]).toBeEnabled();
      expect(buttons[2]).toHaveAccessibleDescription(expect.stringContaining(before[2]));
    },
  );

  it("edits the normalized schema with ordered steps, fields, and choice options", async () => {
    const api = makeApi();
    renderEditor({ api });
    await screen.findByRole("heading", { name: "Grievance report" });
    fireEvent.click(screen.getByRole("button", { name: "Edit / new version" }));

    fireEvent.change(screen.getByLabelText("Icon"), { target: { value: "!" } });
    // Editing a stored row that still carries points offers no Points field.
    expect(screen.queryByLabelText("Points")).toBeNull();
    fireEvent.change(screen.getByLabelText("Sort order"), { target: { value: "4" } });
    fireEvent.click(screen.getByLabelText("Accept new starts after saving"));
    fireEvent.change(screen.getByLabelText("Maximum length"), { target: { value: "300" } });

    fireEvent.change(screen.getByLabelText("Step 1 field 1 type"), { target: { value: "select" } });
    fireEvent.click(screen.getByRole("button", { name: "Add option to field 1" }));
    fireEvent.change(screen.getByLabelText("Field 1 option 1 value"), { target: { value: "dropped" } });
    fireEvent.change(screen.getByLabelText("Field 1 option 1 English label"), { target: { value: "Dropped" } });
    fireEvent.change(screen.getByLabelText("Field 1 option 1 Spanish label"), { target: { value: "Descartada" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove option 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Add at least one option");

    fireEvent.click(screen.getByRole("button", { name: "Add option to field 1" }));
    fireEvent.change(screen.getByLabelText("Field 1 option 1 value"), { target: { value: "contract" } });
    fireEvent.change(screen.getByLabelText("Field 1 option 1 English label"), { target: { value: "Contract" } });
    fireEvent.change(screen.getByLabelText("Field 1 option 1 Spanish label"), { target: { value: "Contrato" } });

    fireEvent.click(screen.getByRole("button", { name: "Add field" }));
    fireEvent.change(screen.getByLabelText("Step 1 field 2 key"), { target: { value: "detail" } });
    fireEvent.change(screen.getByLabelText("Step 1 field 2 English label"), { target: { value: "Detail" } });
    fireEvent.change(screen.getByLabelText("Step 1 field 2 Spanish label"), { target: { value: "Detalle" } });
    fireEvent.click(screen.getByRole("button", { name: "Add field" }));
    fireEvent.change(screen.getByLabelText("Step 1 field 3 key"), { target: { value: "witness" } });
    fireEvent.change(screen.getByLabelText("Step 1 field 3 English label"), { target: { value: "Witness" } });
    fireEvent.change(screen.getByLabelText("Step 1 field 3 Spanish label"), { target: { value: "Testigo" } });
    // Up then down on the same slot only after a third field exists, so the
    // surviving order changes if either move is a no-op. Witness is then removed.
    fireEvent.click(screen.getByRole("button", { name: "Move field 2 up" }));
    fireEvent.click(screen.getByRole("button", { name: "Move field 2 down" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Remove field" })[1]);

    fireEvent.click(screen.getByRole("button", { name: "Add step" }));
    fireEvent.change(screen.getByLabelText("Step 2 English title"), { target: { value: "Review" } });
    fireEvent.change(screen.getByLabelText("Step 2 Spanish title"), { target: { value: "Revisión" } });
    fireEvent.change(screen.getByLabelText("Step 2 field 1 key"), { target: { value: "review" } });
    fireEvent.change(screen.getByLabelText("Step 2 field 1 English label"), { target: { value: "Review" } });
    fireEvent.change(screen.getByLabelText("Step 2 field 1 Spanish label"), { target: { value: "Revisión" } });
    fireEvent.click(screen.getByRole("button", { name: "Add step" }));
    fireEvent.change(screen.getByLabelText("Step 3 English title"), { target: { value: "Evidence" } });
    fireEvent.change(screen.getByLabelText("Step 3 Spanish title"), { target: { value: "Evidencia" } });
    fireEvent.change(screen.getByLabelText("Step 3 field 1 key"), { target: { value: "evidence" } });
    fireEvent.change(screen.getByLabelText("Step 3 field 1 English label"), { target: { value: "Evidence" } });
    fireEvent.change(screen.getByLabelText("Step 3 field 1 Spanish label"), { target: { value: "Evidencia" } });
    // Same non-cancelling up/down pattern for steps. Evidence is then removed.
    fireEvent.click(screen.getByRole("button", { name: "Move step 2 up" }));
    fireEvent.click(screen.getByRole("button", { name: "Move step 2 down" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Remove step" })[1]);
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));

    await vi.waitFor(() => expect(api.upsertFormTemplate).toHaveBeenCalledTimes(1));
    expect(api.upsertFormTemplate.mock.calls[0][0]).not.toHaveProperty("points");
    expect(api.upsertFormTemplate).toHaveBeenCalledWith({
      key: "grievance",
      labelEn: "Grievance report",
      labelEs: "Reporte de queja",
      blurbEn: "Report a contract violation.",
      blurbEs: "Reporta una violación del contrato.",
      icon: "!",
      sort: 4,
      active: false,
      fieldSchema: {
        steps: [
          {
            title: { en: "Review", es: "Revisión" },
            fields: [{
              key: "review",
              type: "text",
              label: { en: "Review", es: "Revisión" },
              required: false,
              maxLength: 200,
            }],
          },
          {
            title: { en: "The issue", es: "El asunto" },
            fields: [
              {
                key: "detail",
                type: "text",
                label: { en: "Detail", es: "Detalle" },
                required: false,
                maxLength: 200,
              },
              {
                key: "summary",
                type: "select",
                label: { en: "Issue summary", es: "Resumen del asunto" },
                required: true,
                options: [{ value: "contract", label: { en: "Contract", es: "Contrato" } }],
              },
            ],
          },
        ],
      },
    });
  });

  it("keeps reorder focus on the step or field that moved, including at either end", async () => {
    const api = makeApi();
    renderEditor({ api });
    await screen.findByRole("heading", { name: "Grievance report" });
    fireEvent.click(screen.getByRole("button", { name: "Edit / new version" }));

    fireEvent.change(screen.getByLabelText("Step 1 English title"), { target: { value: "First step" } });
    fireEvent.change(screen.getByLabelText("Step 1 Spanish title"), { target: { value: "Primer paso" } });
    fireEvent.click(screen.getByRole("button", { name: "Add field" }));
    fireEvent.change(screen.getByLabelText("Step 1 field 2 key"), { target: { value: "detail" } });
    fireEvent.change(screen.getByLabelText("Step 1 field 2 English label"), { target: { value: "Detail" } });
    fireEvent.change(screen.getByLabelText("Step 1 field 2 Spanish label"), { target: { value: "Detalle" } });

    activateReorder("Move field 1 down");
    expect(screen.getByLabelText("Step 1 field 1 key")).toHaveValue("detail");
    expect(screen.getByLabelText("Step 1 field 2 key")).toHaveValue("summary");
    expect(focusedReorder("fieldset.ftm-field-card", "Step 1 field 2 key")).toBe("Move field 2 up");

    fireEvent.click(screen.getByRole("button", { name: "Add step" }));
    fireEvent.change(screen.getByLabelText("Step 2 English title"), { target: { value: "Second step" } });
    fireEvent.change(screen.getByLabelText("Step 2 Spanish title"), { target: { value: "Segundo paso" } });
    fireEvent.change(screen.getByLabelText("Step 2 field 1 key"), { target: { value: "review" } });
    fireEvent.change(screen.getByLabelText("Step 2 field 1 English label"), { target: { value: "Review" } });
    fireEvent.change(screen.getByLabelText("Step 2 field 1 Spanish label"), { target: { value: "Revisión" } });

    activateReorder("Move step 1 down");
    expect(screen.getByLabelText("Step 1 English title")).toHaveValue("Second step");
    expect(screen.getByLabelText("Step 2 English title")).toHaveValue("First step");
    expect(focusedReorder("fieldset.ftm-step", "Step 2 English title")).toBe("Move step 2 up");

    activateReorder("Move step 2 up");
    expect(screen.getByLabelText("Step 1 English title")).toHaveValue("First step");
    expect(screen.getByLabelText("Step 2 English title")).toHaveValue("Second step");
    expect(focusedReorder("fieldset.ftm-step", "Step 1 English title")).toBe("Move step 1 down");

    fireEvent.click(screen.getByRole("button", { name: "Add step" }));
    fireEvent.change(screen.getByLabelText("Step 3 English title"), { target: { value: "Third step" } });
    fireEvent.change(screen.getByLabelText("Step 3 Spanish title"), { target: { value: "Tercer paso" } });
    fireEvent.change(screen.getByLabelText("Step 3 field 1 key"), { target: { value: "note" } });
    fireEvent.change(screen.getByLabelText("Step 3 field 1 English label"), { target: { value: "Note" } });
    fireEvent.change(screen.getByLabelText("Step 3 field 1 Spanish label"), { target: { value: "Nota" } });

    activateReorder("Move step 1 down");
    expect(screen.getByLabelText("Step 1 English title")).toHaveValue("Second step");
    expect(screen.getByLabelText("Step 2 English title")).toHaveValue("First step");
    expect(screen.getByLabelText("Step 3 English title")).toHaveValue("Third step");
    expect(focusedReorder("fieldset.ftm-step", "Step 2 English title")).toBe("Move step 2 down");

    fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    await vi.waitFor(() => expect(api.upsertFormTemplate).toHaveBeenCalledTimes(1));
    expect(api.upsertFormTemplate.mock.calls[0][0]).not.toHaveProperty("points");
    expect(api.upsertFormTemplate).toHaveBeenCalledWith({
      key: "grievance",
      labelEn: "Grievance report",
      labelEs: "Reporte de queja",
      blurbEn: "Report a contract violation.",
      blurbEs: "Reporta una violación del contrato.",
      icon: "⚖",
      sort: 1,
      active: true,
      fieldSchema: {
        steps: [
          {
            title: { en: "Second step", es: "Segundo paso" },
            fields: [{
              key: "review",
              type: "text",
              label: { en: "Review", es: "Revisión" },
              required: false,
              maxLength: 200,
            }],
          },
          {
            title: { en: "First step", es: "Primer paso" },
            fields: [
              {
                key: "detail",
                type: "text",
                label: { en: "Detail", es: "Detalle" },
                required: false,
                maxLength: 200,
              },
              {
                key: "summary",
                type: "text",
                label: { en: "Issue summary", es: "Resumen del asunto" },
                required: true,
                maxLength: 200,
              },
            ],
          },
          {
            title: { en: "Third step", es: "Tercer paso" },
            fields: [{
              key: "note",
              type: "text",
              label: { en: "Note", es: "Nota" },
              required: false,
              maxLength: 200,
            }],
          },
        ],
      },
    });
  });

  it("moves focus into the template editor and back to the control that opened it", async () => {
    const api = makeApi();
    renderEditor({ api });
    const create = await screen.findByRole("button", { name: "New template" });

    fireEvent.click(create);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Create form template" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel editing" })[0]);
    expect(document.activeElement).toBe(create);

    const edit = screen.getByRole("button", { name: "Edit / new version" });
    fireEvent.click(edit);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Edit as a new version" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel editing" })[1]);
    expect(document.activeElement).toBe(edit);

    fireEvent.click(edit);
    fireEvent.click(screen.getByRole("button", { name: "Save template" }));
    const saved = await within(edit.closest("article")).findByText("Template saved as a new version.");
    expect(saved.closest('[role="status"]')).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "Edit as a new version" })).toBeNull();
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit / new version" }));
    });
    expect(document.activeElement).not.toBe(document.body);
  });

  it("moves focus into deactivation confirmation and back to the row control", async () => {
    const api = makeApi({
      loadFormTemplates: vi.fn()
        .mockResolvedValueOnce(ROWS)
        .mockResolvedValueOnce([{ ...ROWS[1], active: false }]),
    });
    renderEditor({ api });
    const deactivate = await screen.findByRole("button", { name: "Deactivate Grievance report" });

    fireEvent.click(deactivate);
    const confirmation = screen.getByRole("group", { name: "Confirm deactivation of Grievance report" });
    expect(confirmation.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));
    expect(screen.queryByRole("group", { name: "Confirm deactivation of Grievance report" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Deactivate Grievance report" }));

    fireEvent.click(screen.getByRole("button", { name: "Deactivate Grievance report" }));
    expect(screen.getByRole("group", { name: "Confirm deactivation of Grievance report" }).contains(document.activeElement)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Confirm deactivation" }));
    expect(await screen.findByText("Template deactivated for new starts.")).toHaveAttribute("role", "status");
    expect(screen.queryByRole("group", { name: "Confirm deactivation of Grievance report" })).toBeNull();
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Reactivate Grievance report" }));
    });
    expect(document.activeElement).not.toBe(document.body);
  });
});

function activateReorder(name) {
  const control = screen.getByRole("button", { name });
  control.focus();
  fireEvent.click(control);
}

function focusedReorder(itemSelector, label) {
  const item = screen.getByLabelText(label).closest(itemSelector);
  expect(document.activeElement).not.toBe(document.body);
  expect(document.activeElement.disabled).toBe(false);
  expect(item.contains(document.activeElement)).toBe(true);
  return document.activeElement.getAttribute("aria-label");
}

describe("template saves keep focus while they run (#8435)", () => {
  it("keeps Save template focused while the template is saved, and saves it once", async () => {
    const api = makeApi();
    renderEditor({ api });
    await screen.findByRole("heading", { name: "Grievance report" });
    fireEvent.click(screen.getByRole("button", { name: "Edit / new version" }));
    await expectHeldWriteFocus(api.upsertFormTemplate, screen.getByRole("button", { name: "Save template" }));
    expect(api.upsertFormTemplate).toHaveBeenCalledTimes(1);
  });
});
