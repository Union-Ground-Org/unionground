// @vitest-environment node
import { describe, expect, it } from "vitest";
// tests/setup.js registers Spanish only for DOM files; this node file reads it.
import "../src/lib/i18n/allLanguages.js";
import { catalogue } from "../src/lib/i18n.js";
import { DEMO_TASK_TEMPLATES } from "../src/lib/taskTemplates.js";

const REQUIRED_KEYS = [
  "open", "dialogTitle", "dialogIntro", "unavailable", "choose", "title", "workstream",
  "safety", "checklist", "fieldCount", "startsAt", "create", "creating", "cancel", "close",
  "required", "error", "created", "detailsTitle", "edit", "save", "saving", "editCancel",
  "detailsUnavailable", "fieldsUpdated",
  "flowTitle", "currentStep", "nextStep", "flowConfirm", "flowOnly", "flowAndStatus",
  "flowCancel", "updating", "updateError", "flowUpdated", "noNext", "typeLocked",
];

describe("specialized task template localization", () => {
  it("ships every chooser, editor, flow, pending, empty, and error key in English and Spanish", () => {
    for (const suffix of REQUIRED_KEYS) {
      const key = `taskTemplates.${suffix}`;
      expect(catalogue.en[key], `missing English ${key}`).toBeTruthy();
      expect(catalogue.es[key], `missing Spanish ${key}`).toBeTruthy();
      expect(catalogue.es[key], `Spanish ${key} copied from English`).not.toBe(catalogue.en[key]);
    }
  });

  it("keeps all five catalog labels, descriptions, fields, flow steps, and checklist items bilingual", () => {
    for (const template of DEMO_TASK_TEMPLATES) {
      for (const value of [template.label, template.description]) {
        expect(value.en).toBeTruthy();
        expect(value.es).toBeTruthy();
      }
      for (const value of [
        ...template.fields.map((field) => field.label),
        ...template.flow.map((step) => step.label),
        ...template.checklist.map((item) => item.label),
      ]) {
        expect(value.en).toBeTruthy();
        expect(value.es).toBeTruthy();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// UX-UG-TASK-TEMPLATES-I18N-REGISTER-COVERAGE-GAP-20260920
//
// The two describes above only prove the Spanish strings exist and differ from
// English, so a translation drifting into formal `usted` address kept this
// suite green. The task-template surface is member-facing and ships in tú, the
// same register tests/i18n-coverage.test.jsx and
// tests/qa-entry-points-register.test.jsx already guard for qa.*.
//
// The qa.* word list cannot be reused unchanged: it carries `su`/`sus`, and two
// DEMO_TASK_TEMPLATES descriptions use `su` as a correct third-person
// possessive ("guarda solo su etapa operativa"). The list below is therefore
// the formal address pronouns plus, for every tú imperative this surface
// actually ships, its usted counterpart — add the counterpart here whenever new
// template copy introduces a new imperative.
//
// Boundaries are letter-class, not `\b`: `\b` is ASCII-only, so `\bdé\b` can
// never match (the accent is a non-word character to it) while `\ble\b`
// false-positives inside `leí`. The self-tests below keep both properties.
const TEMPLATE_USTED_WORDS = [
  // Formal address pronouns. `su`/`sus` are deliberately absent.
  "usted", "ustedes", "le", "les",
  // Formal imperatives carried by the sibling qa.* guards.
  "pregunte", "publique", "envíe", "busque", "haga", "dé", "escriba", "añada",
  "vuelva", "inténtelo", "seleccione", "complete", "revise", "ingrese",
  // Formal counterparts of the tú imperatives this surface ships today:
  // Elige, agrega, Conserva, Planifica, guarda, Programa, Coordina, Usa.
  "elija", "agregue", "conserve", "planifique", "guarde", "programe",
  "coordine", "use",
];
const TEMPLATE_LETTER = "A-Za-zÁÉÍÓÚÜÑáéíóúüñ";
const TEMPLATE_USTED_MARKERS = new RegExp(
  `(?<![${TEMPLATE_LETTER}])(?:${TEMPLATE_USTED_WORDS.join("|")})(?![${TEMPLATE_LETTER}])`,
  "i",
);

// Every Spanish string the task-template surface renders, labelled so a failure
// names the value that drifted. Field help text is included: it is on screen
// and neither describe above reads it.
function spanishTemplateStrings() {
  const strings = Object.keys(catalogue.en)
    .filter((key) => key.startsWith("taskTemplates."))
    .map((key) => [key, catalogue.es[key]]);
  for (const template of DEMO_TASK_TEMPLATES) {
    strings.push([`${template.key}.label`, template.label.es]);
    strings.push([`${template.key}.description`, template.description.es]);
    for (const field of template.fields) {
      strings.push([`${template.key}.field.${field.key}`, field.label.es]);
      if (field.help?.es) strings.push([`${template.key}.field.${field.key}.help`, field.help.es]);
    }
    for (const stepDefinition of template.flow) {
      strings.push([`${template.key}.flow.${stepDefinition.key}`, stepDefinition.label.es]);
    }
    template.checklist.forEach((item, index) => {
      strings.push([`${template.key}.checklist.${index}`, item.label.es]);
    });
  }
  return strings;
}

describe("specialized task templates speak tú", () => {
  it("uses letter-class boundaries that `\\b` cannot provide", () => {
    // The accented imperative is reachable here and unreachable with `\b`.
    expect("Dé los hechos").toMatch(TEMPLATE_USTED_MARKERS);
    expect(/\bdé\b/i.test("Dé los hechos")).toBe(false);
    // And the boundary does not fire inside a longer word, where `\b` would.
    expect("Leí la plantilla").not.toMatch(TEMPLATE_USTED_MARKERS);
    expect(/\ble\b/i.test("Leí la plantilla")).toBe(true);
    expect("Usar una plantilla").not.toMatch(TEMPLATE_USTED_MARKERS);
  });

  it("does not fire on the third-person possessive su this surface ships", () => {
    expect(TEMPLATE_USTED_WORDS).not.toContain("su");
    expect(TEMPLATE_USTED_WORDS).not.toContain("sus");
    const possessive = DEMO_TASK_TEMPLATES
      .map((template) => template.description.es)
      .filter((text) => /(?<![A-Za-z])su(?![A-Za-z])/i.test(text));
    expect(possessive.length, "the su descriptions moved; re-pin this case").toBe(2);
    for (const text of possessive) {
      expect(text, `informal su flagged as formal: ${text}`).not.toMatch(TEMPLATE_USTED_MARKERS);
    }
  });

  it("fails on formal rewrites of the copy it guards", () => {
    const formalRewrites = [
      "Usted puede usar una plantilla",
      "Ustedes pueden usar una plantilla",
      "Elija un tipo de tarea guiada y agregue solo los detalles operativos que necesita.",
      "Conserve identidades y otros detalles protegidos en un registro autorizado enlazado.",
      "Use la hora local del capítulo.",
      "No escriba aquí una narración del incidente.",
      "Complete los campos obligatorios.",
    ];
    for (const text of formalRewrites) {
      expect(text, `formal rewrite not caught: ${text}`).toMatch(TEMPLATE_USTED_MARKERS);
    }
  });

  it("keeps every taskTemplates.* value and catalog string in the informal register", () => {
    const strings = spanishTemplateStrings();
    // Non-vacuity: a renamed prefix or an emptied catalog must fail here rather
    // than silently checking nothing.
    expect(strings.length).toBeGreaterThanOrEqual(REQUIRED_KEYS.length + 5 * 10);
    expect(strings.some(([label]) => label.startsWith("taskTemplates."))).toBe(true);
    expect(strings.some(([label]) => label.endsWith(".help"))).toBe(true);
    for (const [label, text] of strings) {
      expect(typeof text, `${label} is not a Spanish string`).toBe("string");
      expect(text, `${label} uses formal usted address`).not.toMatch(TEMPLATE_USTED_MARKERS);
    }
  });
});
