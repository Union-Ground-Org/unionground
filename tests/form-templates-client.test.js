import { describe, expect, it } from "vitest";
import { FORM_TEMPLATES, resolveFormTemplates, templateFromDbRow } from "../src/lib/formTemplates.js";
import { t } from "../src/lib/i18n.js";

const dbRow = {
  key: "custom_intake",
  version: 3,
  label_en: "Custom intake",
  label_es: "Ingreso personalizado",
  blurb_en: "A DB-authored template.",
  blurb_es: "Una plantilla creada en la base.",
  icon: "🧾",
  points: 20,
  field_schema: {
    steps: [
      {
        title: { en: "Basics", es: "Básicos" },
        fields: [
          { key: "summary", type: "text", label: { en: "Summary", es: "Resumen" }, required: true, maxLength: 200 },
          {
            key: "kind",
            type: "select",
            label: { en: "Kind", es: "Tipo" },
            required: true,
            options: [
              { value: "a", label: { en: "Option A", es: "Opción A" } },
              { value: "b", label: { en: "Option B", es: "Opción B" } },
            ],
          },
        ],
      },
      {
        title: { en: "Detail", es: "Detalle" },
        fields: [{ key: "narrative", type: "textarea", label: { en: "What happened", es: "Qué pasó" }, required: false }],
      },
    ],
  },
};

describe("templateFromDbRow", () => {
  it("resolves English strings into the *Key slots as plain text", () => {
    const tpl = templateFromDbRow(dbRow, "en");
    expect(tpl.key).toBe("custom_intake");
    expect(tpl.version).toBe(3);
    expect(tpl.source).toBe("db");
    // A stored row's legacy points value is dropped: no points economy.
    expect(tpl).not.toHaveProperty("points");
    expect(tpl.titleKey).toBe("Custom intake");
    expect(tpl.blurbKey).toBe("A DB-authored template.");
    expect(tpl.steps[0].titleKey).toBe("Basics");
    expect(tpl.steps[0].fields[0]).toMatchObject({ key: "summary", type: "text", labelKey: "Summary", required: true, maxLength: 200 });
    expect(tpl.steps[0].fields[1].options).toEqual([
      { value: "a", labelKey: "Option A" },
      { value: "b", labelKey: "Option B" },
    ]);
    expect(tpl.steps[1].fields[0].maxLength).toBeUndefined();
  });

  it("resolves Spanish strings when lang is es", () => {
    const tpl = templateFromDbRow(dbRow, "es");
    expect(tpl.titleKey).toBe("Ingreso personalizado");
    expect(tpl.steps[0].titleKey).toBe("Básicos");
    expect(tpl.steps[0].fields[1].options[1].labelKey).toBe("Opción B");
  });

  it("round-trips through t()'s verbatim fallback so views need no changes", () => {
    const tpl = templateFromDbRow(dbRow, "es");
    expect(t("es", tpl.titleKey)).toBe("Ingreso personalizado");
    expect(t("en", tpl.steps[0].fields[0].labelKey)).toBe("Resumen");
  });

  it("keeps brace-delimited field and option labels intact through the verbatim fallback", () => {
    const row = {
      ...dbRow,
      field_schema: {
        steps: [{
          title: { en: "Basics", es: "Básicos" },
          fields: [
            { key: "full_name", type: "text", label: { en: "Nombre {completo}", es: "Nombre {completo}" }, required: true },
            {
              key: "kind",
              type: "select",
              label: { en: "Kind", es: "Tipo" },
              options: [{ value: "a", label: { en: "Opción {especial}", es: "Opción {especial}" } }],
            },
          ],
        }],
      },
    };
    for (const lang of ["en", "es"]) {
      const tpl = templateFromDbRow(row, lang);
      expect(t(lang, tpl.steps[0].fields[0].labelKey)).toBe("Nombre {completo}");
      expect(t(lang, tpl.steps[0].fields[1].options[0].labelKey)).toBe("Opción {especial}");
      expect(t(lang, tpl.steps[0].fields[0].labelKey, { completo: "X" })).toBe("Nombre {completo}");
    }
  });
});

describe("templateFromDbRow junk tolerance (a bad admin row must never crash loadMemberApp)", () => {
  const withSchema = (field_schema) => ({ ...dbRow, field_schema });

  it("ignores a non-array options value on a non-choice field", () => {
    const tpl = templateFromDbRow(withSchema({
      steps: [{ title: { en: "S", es: "S" }, fields: [{ key: "a", type: "text", label: { en: "A", es: "A" }, required: true, options: 5 }] }],
    }), "en");
    expect(tpl.steps[0].fields[0].options).toBeUndefined();
  });

  it("degrades non-string titles/labels to empty strings instead of throwing", () => {
    const row = withSchema({
      steps: [{ title: { en: { x: 1 }, es: "Paso" }, fields: [{ key: "a", type: "text", label: { en: { bad: true }, es: 2 }, required: true }] }],
    });
    const tplEn = templateFromDbRow(row, "en");
    expect(tplEn.steps[0].titleKey).toBe("");
    expect(tplEn.steps[0].fields[0].labelKey).toBe("");
    expect(templateFromDbRow(row, "es").steps[0].titleKey).toBe("Paso");
  });

  it("tolerates non-array steps/fields and a missing schema", () => {
    expect(templateFromDbRow(withSchema({ steps: {} }), "en").steps).toEqual([]);
    expect(templateFromDbRow(withSchema(null), "en").steps).toEqual([]);
    expect(templateFromDbRow(withSchema({ steps: [{ title: { en: "S", es: "S" }, fields: "junk" }] }), "en").steps[0].fields).toEqual([]);
  });
});

describe("resolveFormTemplates", () => {
  it("returns the static array unchanged for an empty or missing fetch", () => {
    expect(resolveFormTemplates([], "en")).toBe(FORM_TEMPLATES);
    expect(resolveFormTemplates(null, "en")).toBe(FORM_TEMPLATES);
    expect(resolveFormTemplates(undefined, "es")).toBe(FORM_TEMPLATES);
  });

  it("maps DB rows when present", () => {
    const resolved = resolveFormTemplates([dbRow], "en");
    expect(resolved).toHaveLength(1);
    expect(resolved[0].titleKey).toBe("Custom intake");
  });
});
