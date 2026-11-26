// BUG-UG-SERVICE-REQUEST-DUES-CATEGORY-WITHOUT-DUES-20261108: the
// member service request offers no Dues category, and its default description
// does not name dues, for an organization that runs no dues; an organization
// that runs dues (or an unknown answer) keeps both.
import { describe, expect, it } from "vitest";
import { catalogue } from "../src/lib/i18n.js";
import { FORM_TEMPLATES, formTemplatesForDues, templateFromDbRow } from "../src/lib/formTemplates.js";
import { FORM_TEMPLATES as NATIVE_FORM_TEMPLATES, formTemplateBlurb } from "../apps/mobile/src/lib/featureCatalog.ts";

const service = (templates) => templates.find((template) => template.key === "service_request");
const categories = (template) => template.steps[0].fields.find((field) => field.key === "category").options.map((option) => option.value);

// The form_templates registry row (20260723110000_form_templates_registry.sql).
const registryRow = {
  key: "service_request", version: 1, label_en: "Member service request", label_es: "Solicitud de servicio",
  blurb_en: "Ask the chapter for help with dues, benefits, or training.", blurb_es: "Pide ayuda al capítulo con cuotas, beneficios o capacitación.",
  icon: "🧰", points: 10,
  field_schema: { steps: [{ title: { en: "Your request", es: "Tu solicitud" }, fields: [
    { key: "category", type: "select", label: { en: "Category", es: "Categoría" }, required: true, options: [
      { value: "dues", label: { en: "Dues / membership", es: "Cuotas / membresía" } },
      { value: "benefits", label: { en: "Benefits", es: "Beneficios" } },
      { value: "training", label: { en: "Training", es: "Capacitación" } },
      { value: "other", label: { en: "Other", es: "Otro" } },
    ] },
    { key: "description", type: "textarea", label: { en: "Description", es: "Descripción" }, required: true },
  ] }] },
};

describe("service request for an organization without dues", () => {
  it("drops the Dues category and the dues wording from the built-in and registry templates", () => {
    for (const templates of [FORM_TEMPLATES, [templateFromDbRow(registryRow, "en")], [templateFromDbRow(registryRow, "es")]]) {
      const filtered = service(formTemplatesForDues(templates, false));
      expect(categories(filtered)).toEqual(["benefits", "training", "other"]);
      expect(filtered.blurbKey).toBe("forms.blurb.service_request");
    }
    expect(catalogue.en["forms.blurb.service_request"]).not.toMatch(/dues/i);
    expect(catalogue.es["forms.blurb.service_request"]).not.toMatch(/cuota/i);
  });

  it("keeps a description the organization wrote itself", () => {
    const custom = { ...templateFromDbRow(registryRow, "en"), blurbKey: "Questions for the office." };
    expect(formTemplatesForDues([custom], false)[0].blurbKey).toBe("Questions for the office.");
  });


  it("gives the iOS forms list the same description rule", () => {
    const native = NATIVE_FORM_TEMPLATES.find((template) => template.key === "service_request");
    expect(formTemplateBlurb(native, false)).not.toMatch(/dues/i);
    expect(formTemplateBlurb(native, true)).toBe(native.blurb);
    expect(formTemplateBlurb(native, null)).toBe(native.blurb);
    const grievance = NATIVE_FORM_TEMPLATES.find((template) => template.key === "grievance");
    expect(formTemplateBlurb(grievance, false)).toBe(grievance.blurb);
  });
});
