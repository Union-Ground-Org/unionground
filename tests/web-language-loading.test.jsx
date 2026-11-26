import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

// PERF-UG-WEB-SHELL-AND-PER-LANGUAGE-BUNDLES-20261011: the web entry
// carries English only; Spanish is its own chunk, fetched by loadLanguage().
// tests/setup.js registers Spanish for every other suite, so each case here
// imports a FRESH src/lib/i18n.js (vi.resetModules) to start the way a browser
// does: English registered, Spanish not yet.
async function freshI18n() {
  vi.resetModules();
  const i18n = await import("../src/lib/i18n.js");
  const { useLoadedLanguage } = await import("../src/lib/useLoadedLanguage.js");
  const { spanishCatalogue } = await import("../src/lib/i18n/es.js");
  return { ...i18n, useLoadedLanguage, spanish: spanishCatalogue.es };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("per-language catalogue loading", () => {
  it("starts with English only and resolves an unloaded language to English copy, never a key", async () => {
    const { catalogue, languageLoaded, t } = await freshI18n();
    expect(languageLoaded("en")).toBe(true);
    expect(languageLoaded("es")).toBe(false);
    expect(Object.hasOwn(catalogue, "es")).toBe(false);
    expect(t("es", "app.loading")).toBe(t("en", "app.loading"));
    expect(t("es", "app.loading")).not.toBe("app.loading");
    // interpolation and the verbatim unknown-key fallback are unchanged
    expect(t("es", "no.such.key", { name: "x" })).toBe("no.such.key");
  });

  it("registers Spanish from its own chunk and then translates, with interpolation", async () => {
    const { loadLanguage, languageLoaded, t, spanish } = await freshI18n();
    await expect(loadLanguage("es")).resolves.toBe(true);
    expect(languageLoaded("es")).toBe(true);
    expect(t("es", "app.loading")).toBe(spanish["app.loading"]);
    expect(t("es", "app.loading")).not.toBe(t("en", "app.loading"));
    const interpolated = Object.keys(spanish).find((key) => /\{name\}/.test(spanish[key]));
    expect(t("es", interpolated, { name: "Ana" })).toBe(spanish[interpolated].replace(/\{name\}/g, "Ana").replace(/\{\w+\}/g, ""));
  });

  it("shares one fetch between concurrent requests for the same language", async () => {
    const { loadLanguage, spanish } = await freshI18n();
    const load = vi.fn(async () => spanish);
    const results = await Promise.all([loadLanguage("es", { load }), loadLanguage("es", { load }), loadLanguage("es", { load })]);
    expect(results).toEqual([true, true, true]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("retries a failed chunk once and succeeds on the retry", async () => {
    const { loadLanguage, t, spanish } = await freshI18n();
    const load = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch dynamically imported module"))
      .mockResolvedValueOnce(spanish);
    await expect(loadLanguage("es", { load, retryDelayMs: 0 })).resolves.toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
    expect(t("es", "app.loading")).toBe(spanish["app.loading"]);
  });

  it("falls back to English after the retry fails, and a later request tries again", async () => {
    const { loadLanguage, languageLoaded, t, spanish } = await freshI18n();
    const failing = vi.fn().mockRejectedValue(new TypeError("Failed to fetch dynamically imported module"));
    await expect(loadLanguage("es", { load: failing, retryDelayMs: 0 })).resolves.toBe(false);
    expect(failing).toHaveBeenCalledTimes(2);
    expect(languageLoaded("es")).toBe(false);
    expect(t("es", "app.loading")).toBe(t("en", "app.loading"));
    await expect(loadLanguage("es", { load: async () => spanish, retryDelayMs: 0 })).resolves.toBe(true);
    expect(languageLoaded("es")).toBe(true);
  });

  it("answers false for a language that has no catalogue chunk", async () => {
    const { loadLanguage, languageLoaded } = await freshI18n();
    await expect(loadLanguage("fr")).resolves.toBe(false);
    await expect(loadLanguage("constructor")).resolves.toBe(false);
    expect(languageLoaded("fr")).toBe(false);
  });

  it("answers true for a language already registered without fetching its chunk again", async () => {
    const { loadLanguage, languageLoaded, t, spanish } = await freshI18n();
    await expect(loadLanguage("en", { load: vi.fn() })).resolves.toBe(true);
    await expect(loadLanguage("es", { load: async () => spanish })).resolves.toBe(true);
    const load = vi.fn(async () => ({ "app.loading": "replaced" }));
    await expect(loadLanguage("es", { load })).resolves.toBe(true);
    expect(load).not.toHaveBeenCalled();
    expect(languageLoaded("es")).toBe(true);
    expect(t("es", "app.loading")).toBe(spanish["app.loading"]);
  });

  it("does not register a chunk that resolves to something other than a table, and a later request tries again", async () => {
    const { loadLanguage, languageLoaded, t, spanish } = await freshI18n();
    for (const table of [undefined, null, "es", 0]) {
      const load = vi.fn(async () => table);
      await expect(loadLanguage("es", { load, retryDelayMs: 0 })).resolves.toBe(false);
      // a resolved non-table is not a failed fetch, so it is not retried
      expect(load).toHaveBeenCalledTimes(1);
      expect(languageLoaded("es")).toBe(false);
      expect(t("es", "app.loading")).toBe(t("en", "app.loading"));
    }
    await expect(loadLanguage("es", { load: async () => spanish })).resolves.toBe(true);
    expect(t("es", "app.loading")).toBe(spanish["app.loading"]);
  });
});

describe("loadLanguage deadline", () => {
  it("settles false when the chunk request never settles, so the first paint is not held blank", async () => {
    const { loadLanguage, languageLoaded, spanish } = await freshI18n();
    const stalled = () => new Promise(() => {});
    await expect(loadLanguage("es", { load: stalled, retryDelayMs: 0, deadlineMs: 20 })).resolves.toBe(false);
    expect(languageLoaded("es")).toBe(false);
    // the stalled attempt does not block the next one
    await expect(loadLanguage("es", { load: async () => spanish, deadlineMs: 20 })).resolves.toBe(true);
  });
});

describe("useLoadedLanguage", () => {
  async function harness() {
    const fresh = await freshI18n();
    const chunk = { current: deferred(), calls: 0 };
    const load = (lang) => fresh.loadLanguage(lang, {
      retryDelayMs: 0,
      load: () => { chunk.calls += 1; return chunk.current.promise; },
    });
    function Probe({ requested, attempt = 0 }) {
      const { lang, pending } = fresh.useLoadedLanguage(requested, load, attempt);
      return <p data-testid="probe" data-lang={lang} data-pending={String(pending)}>{fresh.t(lang, "app.loading")}</p>;
    }
    const probe = () => screen.getByTestId("probe");
    return { ...fresh, chunk, Probe, probe };
  }

  it("keeps the language on screen until the requested catalogue arrives, then switches whole", async () => {
    const { Probe, probe, chunk, t, spanish } = await harness();
    const view = render(<Probe requested="en" />);
    expect(probe()).toHaveAttribute("data-lang", "en");
    view.rerender(<Probe requested="es" />);
    // no mixed state: still entirely English, flagged as pending
    expect(probe()).toHaveAttribute("data-lang", "en");
    expect(probe()).toHaveAttribute("data-pending", "true");
    expect(probe()).toHaveTextContent(t("en", "app.loading"));
    await act(async () => { chunk.current.resolve(spanish); });
    expect(probe()).toHaveAttribute("data-lang", "es");
    expect(probe()).toHaveAttribute("data-pending", "false");
    expect(probe()).toHaveTextContent(spanish["app.loading"]);
  });

  it("lets the last selection win when a slow Spanish chunk lands after a switch back to English", async () => {
    const { Probe, probe, chunk, spanish, languageLoaded } = await harness();
    const view = render(<Probe requested="en" />);
    view.rerender(<Probe requested="es" />);
    view.rerender(<Probe requested="en" />);
    expect(probe()).toHaveAttribute("data-lang", "en");
    expect(probe()).toHaveAttribute("data-pending", "false");
    await act(async () => { chunk.current.resolve(spanish); });
    // the stale Spanish response registers its table but does not repaint
    expect(languageLoaded("es")).toBe(true);
    expect(probe()).toHaveAttribute("data-lang", "en");
    // and choosing Spanish again is immediate, with no second fetch
    view.rerender(<Probe requested="es" />);
    expect(probe()).toHaveAttribute("data-lang", "es");
    expect(chunk.calls).toBe(1);
  });

  it("reports a boot-time load as pending and settles on English when the chunk fails twice", async () => {
    const { Probe, probe, chunk, t } = await harness();
    render(<Probe requested="es" />);
    expect(probe()).toHaveAttribute("data-lang", "en");
    expect(probe()).toHaveAttribute("data-pending", "true");
    await act(async () => {
      chunk.current.reject(new TypeError("Failed to fetch dynamically imported module"));
      // let loadLanguage's retry timer (0 ms here) fire and its second fetch settle
      await new Promise((resolve) => { setTimeout(resolve, 10); });
    });
    expect(chunk.calls).toBe(2);
    expect(probe()).toHaveAttribute("data-lang", "en");
    expect(probe()).toHaveAttribute("data-pending", "false");
    expect(probe()).toHaveAttribute("data-pending", "false");
    expect(probe()).toHaveTextContent(t("en", "app.loading"));
  });

  it("retries when the member selects the failed language again", async () => {
    const { Probe, probe, chunk, spanish } = await harness();
    const view = render(<Probe requested="es" attempt={1} />);
    await act(async () => {
      chunk.current.reject(new TypeError("Failed to fetch dynamically imported module"));
      await new Promise((resolve) => { setTimeout(resolve, 10); });
    });
    expect(chunk.calls).toBe(2);
    expect(probe()).toHaveAttribute("data-lang", "en");
    // Selecting Spanish again keeps `requested` at "es"; the new attempt is
    // what starts a fresh fetch.
    chunk.current = deferred();
    await act(async () => { view.rerender(<Probe requested="es" attempt={2} />); });
    expect(chunk.calls).toBe(3);
    expect(probe()).toHaveAttribute("data-pending", "true");
    expect(probe()).toHaveAttribute("data-lang", "en");
    await act(async () => { chunk.current.resolve(spanish); });
    expect(probe()).toHaveAttribute("data-lang", "es");
    expect(probe()).toHaveAttribute("data-pending", "false");
    expect(probe()).toHaveTextContent(spanish["app.loading"]);
  });
});

describe("bilingual defaults built outside the screen language", () => {
  it("keeps Spanish fixture schemas lazy through cold English boot and admin copying", async () => {
    const { languageLoaded, loadLanguage, spanish, t } = await freshI18n();
    // Import before Spanish, exactly the ordering that froze English strings.
    const { fallbackData } = await import("./fixtures/retired-pre-bot/src/data/fallback.js");
    const { loadDemoData, cloneDemoFormTemplates } = await import("../src/data/demoData.js");
    expect(languageLoaded("es")).toBe(false);
    const isolated = await import('./fixtures/retired-pre-bot/src/data/fallback.js');
    const { primeDemoData } = await import('../src/data/demoData.js');
    primeDemoData(isolated.fallbackData);
    const fixtures = await loadDemoData();
    expect(languageLoaded("es")).toBe(false);
    const rows = cloneDemoFormTemplates(fixtures.adminDesk.formTemplates);
    const row = rows.find((item) => item.key === "alt_work");
    expect(row.label_es).toBe("");
    await loadLanguage("es", { load: async () => spanish });
    const { templateByKey } = await import("../src/lib/formTemplates.js");
    const template = templateByKey("alt_work");
    expect(row.label_es).toBe(t("es", template.titleKey));
    expect(row.label_es).not.toBe(row.label_en);
    for (const [index, step] of template.steps.entries()) {
      expect(row.field_schema.steps[index].title.es).toBe(t("es", step.titleKey));
      for (const [fieldIndex, field] of step.fields.entries()) {
        const rendered = row.field_schema.steps[index].fields[fieldIndex];
        expect(rendered.label.es).toBe(t("es", field.labelKey));
        for (const [optionIndex, option] of (field.options || []).entries()) {
          expect(rendered.options[optionIndex].label.es).toBe(t("es", option.labelKey));
        }
      }
    }
    expect(fallbackData.adminDesk.formTemplates.find((item) => item.key === "alt_work").label_es).toBe(row.label_es);
  });

  it("opens the English demo when Spanish fails and localizes its existing cache after a retry", async () => {
    const { loadLanguage, spanish } = await freshI18n();
    const broken = deferred();
    const language = loadLanguage("es", { load: () => broken.promise, retryDelayMs: 0 });
    const { loadDemoData, demoData } = await import("../src/data/demoData.js");
    const isolated = await import('./fixtures/retired-pre-bot/src/data/fallback.js');
    const { primeDemoData } = await import('../src/data/demoData.js');
    primeDemoData(isolated.fallbackData);
    const fixtures = await loadDemoData();
    expect(fixtures.member.fullName).toBe("Darnell Foster");
    expect(fixtures.adminDesk.formTemplates[0].label_es).toBe("");
    broken.reject(new TypeError("offline chunk"));
    await expect(language).resolves.toBe(false);
    expect(demoData()).toBe(fixtures);
    await loadLanguage("es", { load: async () => spanish });
    expect(await loadDemoData()).toBe(fixtures);
    expect(fixtures.adminDesk.formTemplates[0].label_es).not.toBe(fixtures.adminDesk.formTemplates[0].label_en);
    expect(fixtures.adminDesk.formTemplates[0].label_es).not.toBe("");
  });

  it("waits for Spanish before deriving the demo filing PDF's bilingual schema", async () => {
    const { loadLanguage, spanish, t } = await freshI18n();
    const chunk = deferred();
    const pending = loadLanguage("es", { load: () => chunk.promise });
    const { demoFilingTemplate } = await import("../src/App.jsx");
    let settled = false;
    const filing = demoFilingTemplate("alt_work", 1, undefined, "es").then((row) => { settled = true; return row; });
    await Promise.resolve();
    expect(settled).toBe(false);
    chunk.resolve(spanish);
    await pending;
    const row = await filing;
    const { templateByKey } = await import("../src/lib/formTemplates.js");
    expect(row.label_es).toBe(t("es", templateByKey("alt_work").titleKey));
    expect(row.label_es).not.toBe(row.label_en);
    expect(row.field_schema.steps[0].title.es).not.toBe(row.field_schema.steps[0].title.en);
  });

  it.each(["activate", "reactivate", "save"])("keeps existing lazy Spanish labels through %s before a failed load and successful retry", async (operation) => {
    const { loadLanguage, languageLoaded, spanish, t } = await freshI18n();
    const { loadDemoData, cloneDemoFormTemplates } = await import("../src/data/demoData.js");
    const { setDemoFormTemplateActive, upsertDemoFormTemplate } = await import("../src/lib/demoFormTemplateRegistry.js");
    const { templateByKey } = await import("../src/lib/formTemplates.js");
    const isolated = await import('./fixtures/retired-pre-bot/src/data/fallback.js');
    const { primeDemoData } = await import('../src/data/demoData.js');
    primeDemoData(isolated.fallbackData);
    const fixtures = await loadDemoData();
    const rows = cloneDemoFormTemplates(fixtures.adminDesk.formTemplates);
    const target = rows.find((row) => row.key === "alt_work");
    if (operation === "reactivate") target.active = false;
    const previousActive = target.active;
    const chunk = deferred();
    const loading = loadLanguage("es", { load: () => chunk.promise, retryDelayMs: 0 });
    const update = operation === "save"
      ? upsertDemoFormTemplate(rows, {
        key: target.key, labelEn: "Edited arrangement", labelEs: "Arreglo editado", active: true,
        fieldSchema: { steps: [{ title: { en: "Details", es: "Detalles" }, fields: [] }] },
      })
      : setDemoFormTemplateActive(rows, target.key, operation === "reactivate");
    const existing = update.rows.filter((row) => row.version === 1);
    expect(target.active).toBe(previousActive);
    expect(existing.every((row) => row.label_es === "" && row.blurb_es === "")).toBe(true);
    chunk.reject(new TypeError("offline Spanish chunk"));
    await expect(loading).resolves.toBe(false);
    expect(languageLoaded("es")).toBe(false);
    await expect(loadLanguage("es", { load: async () => spanish })).resolves.toBe(true);
    for (const row of existing) {
      const template = templateByKey(row.key);
      expect(row.label_es).toBe(t("es", template.titleKey));
      expect(row.blurb_es).toBe(t("es", template.blurbKey));
      expect(row.field_schema.steps[0].title.es).toBe(t("es", template.steps[0].titleKey));
    }
    if (operation === "save") expect(update.rows.at(-1).label_es).toBe("Arreglo editado");
  });

  it("can derive an English filing schema without waiting for a stalled Spanish bundle", async () => {
    const { languageLoaded } = await freshI18n();
    const { demoFilingTemplate } = await import("../src/App.jsx");
    const row = await demoFilingTemplate("alt_work", 1);
    expect(languageLoaded("es")).toBe(false);
    expect(row.label_en).toBe("Alternative work arrangement");
    expect(row.label_es).toBe("");
  });

  it("copies editable template values independently while preserving lazy labels", async () => {
    const { cloneDemoFormTemplates } = await import("../src/data/demoData.js");
    let spanish = "";
    const source = [{ get label_es() { return spanish; }, optional: null, field_schema: { steps: [{ fields: [{ required: true }] }] } }];
    const copy = cloneDemoFormTemplates(source);
    source[0].field_schema.steps[0].fields[0].required = false;
    expect(copy[0].field_schema.steps[0].fields[0].required).toBe(true);
    expect(copy[0].optional).toBeNull();
    spanish = "Queja";
    expect(copy[0].label_es).toBe("Queja");
  });

  it("leaves the default Spanish removal title blank until Spanish is loaded, never English", async () => {
    const { loadLanguage, spanish } = await freshI18n();
    const { defaultRemovalTitles } = await import("../src/features/governance/OfficerRemovalEditor.jsx");
    const target = { name: "Ana Ruiz", role: "steward" };
    expect(defaultRemovalTitles(target)).toEqual({ titleEn: "Remove Ana Ruiz as committee member?", titleEs: "" });
    await loadLanguage("es", { load: async () => spanish });
    expect(defaultRemovalTitles(target)).toEqual({
      titleEn: "Remove Ana Ruiz as committee member?", titleEs: "¿Destituir a Ana Ruiz como miembro del comité?",
    });
  });
});

// The editor asks for Spanish on mount; an officer chosen before it lands gets
// a blank Spanish title, which must fill in once the catalogue arrives (and
// never with English). Each case seeds the shared in-flight load first, so the
// editor's own loadLanguage("es") call joins it.
describe("officer removal editor while Spanish is loading", () => {
  const TARGETS = [{ userId: "u-1", name: "Ana Ruiz", role: "steward" }, { userId: "u-2", name: "Luis Paz", role: "vp" }];

  async function renderEditor() {
    const { OfficerRemovalEditor, emptyRemovalDraft } = await import("../src/features/governance/OfficerRemovalEditor.jsx");
    const onSave = vi.fn();
    const loadTargets = vi.fn(async () => ({ items: TARGETS }));
    function Harness() {
      const [draft, setDraft] = useState(emptyRemovalDraft);
      return <OfficerRemovalEditor draft={draft} setDraft={setDraft} canManageUnion={false} busy={false} loadTargets={loadTargets} onCancel={() => {}} onSave={onSave} />;
    }
    render(<Harness />);
    await screen.findByRole("option", { name: /Ana Ruiz/ });
    const choose = (userId) => fireEvent.change(screen.getByRole("combobox"), { target: { value: userId } });
    return { onSave, choose, titleEn: () => screen.getByLabelText("English title"), titleEs: () => screen.getByLabelText("Spanish title") };
  }

  it("fills the Spanish title when the catalogue lands after the officer was chosen, and saves it", async () => {
    const { loadLanguage, spanish } = await freshI18n();
    const chunk = deferred();
    loadLanguage("es", { load: () => chunk.promise });
    const editor = await renderEditor();
    editor.choose("u-1");
    expect(editor.titleEn()).toHaveValue("Remove Ana Ruiz as committee member?");
    expect(editor.titleEs()).toHaveValue("");
    await act(async () => { chunk.resolve(spanish); });
    expect(editor.titleEs()).toHaveValue("¿Destituir a Ana Ruiz como miembro del comité?");
    fireEvent.submit(screen.getByTestId("officer-removal-editor"));
    expect(editor.onSave).toHaveBeenCalledTimes(1);
    expect(editor.onSave.mock.calls[0][0]).toMatchObject({
      targetUserId: "u-1", titleEn: "Remove Ana Ruiz as committee member?", titleEs: "¿Destituir a Ana Ruiz como miembro del comité?",
    });
  });

  it("leaves a title staff wrote alone when Spanish lands", async () => {
    const { loadLanguage, spanish } = await freshI18n();
    const chunk = deferred();
    loadLanguage("es", { load: () => chunk.promise });
    const editor = await renderEditor();
    editor.choose("u-1");
    fireEvent.change(editor.titleEn(), { target: { value: "Remove Ana?" } });
    await act(async () => { chunk.resolve(spanish); });
    expect(editor.titleEs()).toHaveValue("");
  });

  it("keeps the Spanish title blank and required, never English, when Spanish failed, and fills it after a later load", async () => {
    const { loadLanguage, spanish } = await freshI18n();
    // Both fetches of the one load (first try and its retry) fail, after the
    // officer was chosen; the editor's mount request and its re-request on the
    // choice both join that load.
    const broken = deferred();
    const failed = loadLanguage("es", { load: () => broken.promise, retryDelayMs: 0 });
    const editor = await renderEditor();
    editor.choose("u-1");
    await act(async () => {
      broken.reject(new TypeError("Failed to fetch dynamically imported module"));
      await expect(failed).resolves.toBe(false);
    });
    expect(editor.titleEn()).toHaveValue("Remove Ana Ruiz as committee member?");
    expect(editor.titleEs()).toHaveValue("");
    // required, 3 to 160 characters: the browser will not submit it blank and
    // save_officer_removal_ballot_draft refuses a blank title_es.
    expect(editor.titleEs()).toBeRequired();
    expect(editor.titleEs()).toHaveAttribute("minLength", "3");
    // Choosing again asks for Spanish again; this time it arrives.
    const chunk = deferred();
    loadLanguage("es", { load: () => chunk.promise });
    editor.choose("u-2");
    expect(editor.titleEs()).toHaveValue("");
    await act(async () => { chunk.resolve(spanish); });
    expect(editor.titleEs()).toHaveValue("¿Destituir a Luis Paz como líder de la campaña?");
  });
});

describe("Spanish stays out of the web entry chunk", () => {
  it("is reached from src/ only through loadLanguage's dynamic import", () => {
    const root = resolve(process.cwd(), "src");
    const files = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(jsx?|mjs|tsx?)$/.test(entry)) files.push(path);
      }
    };
    walk(root);
    const offenders = files
      .map((path) => [relative(process.cwd(), path).replaceAll("\\", "/"), readFileSync(path, "utf8")])
      .filter(([path]) => path !== "src/lib/i18n/allLanguages.js")
      .filter(([, source]) => /(?:^|\n)\s*(?:import|export)\b[^;]*?["'][^"']*i18n\/(?:es|allLanguages)\.js["']/.test(source))
      .map(([path]) => path);
    expect(offenders, "a static import of the Spanish catalogue puts it back in the entry chunk").toEqual([]);
    const barrel = readFileSync(resolve(root, "lib/i18n.js"), "utf8");
    expect(barrel).toContain('import("./i18n/es.js")');
  });
});
