import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { FormsView } from "../src/views/FormsView.jsx";

function editor(lang, props = {}) {
  const onSaveDraft = vi.fn().mockResolvedValue("fixture-draft");
  render(<LanguageProvider lang={lang}><FormsView
    data={{ member: { initials: "FT" }, forms: [] }}
    focus={{ templateKey: "alt_work" }}
    onSaveDraft={onSaveDraft} onSubmit={vi.fn()} {...props}
  /></LanguageProvider>);
  return onSaveDraft;
}

describe("guided form requirement instructions", () => {
  it.each([
    ["en", "Requested arrangement", "Current schedule", "Reason", "Required", "Optional", "Next"],
    ["es", "Arreglo solicitado", "Horario actual", "Motivo", "Obligatorio", "Opcional", "Siguiente"],
  ])("announces mandatory and optional answers in %s while saving incomplete drafts", async (lang, requested, schedule, reason, required, optional, next) => {
    const save = editor(lang);
    expect(screen.getByRole("textbox", { name: requested })).toBeRequired();
    // A limited text field also describes its character count (UX-UG-FORMS-SILENT-200-CHARACTER-CUT-AND-DOUBLE-EDITOR-20261111).
    expect(screen.getByRole("textbox", { name: requested })).toHaveAccessibleDescription(new RegExp(`^${required}( |$)`));
    expect(screen.getByRole("textbox", { name: schedule })).not.toBeRequired();
    expect(screen.getByRole("textbox", { name: schedule })).toHaveAccessibleDescription(new RegExp(`^${optional}( |$)`));
    const days = screen.getByRole("group");
    expect(days).toHaveAccessibleDescription(optional);
    for (const choice of within(days).getAllByRole("button")) expect(choice).toHaveAccessibleDescription(optional);

    fireEvent.change(screen.getByRole("textbox", { name: schedule }), { target: { value: "Fixture schedule" } });
    fireEvent.click(screen.getByRole("button", { name: next }));
    expect(screen.getByRole("textbox", { name: reason })).toBeRequired();
    expect(screen.getByRole("textbox", { name: reason })).toHaveAccessibleDescription(new RegExp(`^${required}( |$)`));
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({
      step: 1, answers: { schedule: "Fixture schedule" },
    })));
    fireEvent.click(screen.getByRole("button", { name: next }));
    expect(screen.getByRole("button", { name: /Submit for committee review|Enviar para revisión del comité/ })).toBeDisabled();
  });

  it.each(["en", "es"])("describes every configured field and choice in %s using supported semantics", (lang) => {
    const types = ["text", "textarea", "select", "radio", "multiselect", "checkbox", "number", "date"];
    const fields = types.flatMap((type) => [true, false].map((required) => ({
      key: `${type}-${required}`, type, required, labelKey: `${type}-${required}`,
      options: [{ value: "one", labelKey: "One" }, { value: "two", labelKey: "Two" }],
    })));
    editor(lang, {
      data: { member: { initials: "FT" }, forms: [], formTemplates: [{
        key: "fixture", titleKey: "Fixture form", steps: [{ titleKey: "Fixture step", fields }],
      }] },
      focus: { templateKey: "fixture" },
    });
    for (const field of fields) {
      const control = screen.getByLabelText(field.labelKey);
      const description = field.required
        ? (lang === "en" ? "Required" : "Obligatorio")
        : (lang === "en" ? "Optional" : "Opcional");
      expect(control).toHaveAccessibleDescription(description);
      if (["checkbox", "multiselect"].includes(field.type)) {
        // Switch and group do not support aria-required. Their associated
        // localized instructions still announce the requirement on focus.
        expect(control).not.toHaveAttribute("aria-required");
      } else expect(control).toHaveAttribute("aria-required", String(field.required));
      if (["radio", "multiselect"].includes(field.type)) {
        for (const choice of within(control).getAllByRole(field.type === "radio" ? "radio" : "button")) {
          expect(choice).toHaveAccessibleDescription(description);
        }
      }
    }
    fireEvent.click(screen.getByRole("switch", { name: "checkbox-true" }));
    expect(screen.getByRole("switch", { name: "checkbox-true" })).toBeChecked();
  });
});
