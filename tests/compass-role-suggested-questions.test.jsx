// REQ-UG-COMPASS-ROLE-SUGGESTED-QUESTIONS-20261001
import { fireEvent, render, screen } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { buildGuideMessages } from "../api/_lib/compassPrompts.js";
import { Assistant } from "../src/components/FloatingControls.jsx";
import {
  DEFAULT_SUGGESTED_QUESTIONS,
  SUGGESTED_QUESTION_LIST_KEYS,
  SUGGESTED_QUESTIONS_SWITCH,
  suggestedQuestionRole,
  suggestedQuestionsFor,
} from "../src/features/compass/suggestedQuestions.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import { compassAssistantCatalogue } from "../src/lib/i18n/compassAssistant.js";

const migration = readFileSync("supabase/migrations/20261003054000_compass_role_suggested_questions.sql", "utf8");
const nativeDefaults = readFileSync("apps/mobile/src/lib/compassSuggestions.ts", "utf8");
const source = [{ source_id: "kb:1", kind: "kb", title: "Weingarten rights", ref: "Article 12", snippet: "Use this if management pulls you into a meeting that could lead to discipline." }];

// Union Ground's organizing seed-copy migration (database group) moves each
// list's definition default onto the web defaults. When it is present its
// update is the live default; otherwise the historical registration is.
const SEED_COPY_MIGRATION = "supabase/migrations/20261014013000_unionground_organizing_seed_copy.sql";
const seedCopy = existsSync(SEED_COPY_MIGRATION) ? readFileSync(SEED_COPY_MIGRATION, "utf8") : null;

function latestDefault(key) {
  if (!seedCopy) return null;
  for (const statement of seedCopy.split(/;\s*\n/)) {
    if (!new RegExp(`where\\s+key\\s*=\\s*'${key.replaceAll(".", "\\.")}'`).test(statement)) continue;
    const match = statement.match(/default_value\s*=\s*'(\[[\s\S]*?\])'::jsonb/);
    if (match) return JSON.parse(match[1].replaceAll("''", "'"));
  }
  return null;
}

function definitionDefault(key) {
  const latest = latestDefault(key);
  if (latest) return latest;
  const match = migration.match(new RegExp(`\\('${key.replaceAll(".", "\\.")}', 'text_list',[\\s\\S]*?\\n\\s*'(\\[[^\\n]*\\])',`));
  if (!match) throw new Error(`no definition for ${key}`);
  return JSON.parse(match[1].replaceAll("''", "'"));
}

// A native string literal in either quote style (a question with an
// apostrophe is written in double quotes).
function nativeHasLiteral(question) {
  return nativeDefaults.includes(`'${question}'`) || nativeDefaults.includes(JSON.stringify(question));
}

function configuration(switches) {
  return { switches };
}

describe("role suggested questions", () => {
  // The database definition default is what get_member_organization_configuration
  // returns for an organization that never edited a list, so it must be the
  // client's product default or a worker sees a different list than the one
  // the client localizes.
  it("registers each role list with the product defaults verbatim, and the switch defaults on", () => {
    for (const role of ["member", "steward", "admin"]) {
      expect(definitionDefault(SUGGESTED_QUESTION_LIST_KEYS[role])).toEqual([...DEFAULT_SUGGESTED_QUESTIONS[role]]);
    }
    expect(migration).toMatch(/\('features\.ai_assistant\.suggested_questions', 'boolean',[\s\S]*?'true', null, null, null, 100, 'ai_assistant', true\)/);
  });

  it("ships the organizing defaults in both locales and on native", () => {
    for (const role of ["member", "steward", "admin"]) {
      DEFAULT_SUGGESTED_QUESTIONS[role].forEach((question, index) => {
        expect(compassAssistantCatalogue.en[`compass.suggested.${role}.${index + 1}`]).toBe(question);
        expect(compassAssistantCatalogue.es[`compass.suggested.${role}.${index + 1}`]).toMatch(/\S/);
        expect(question.length).toBeLessThanOrEqual(80);
      });
    }
    for (const question of DEFAULT_SUGGESTED_QUESTIONS.member) expect(nativeHasLiteral(question), question).toBe(true);
    for (const question of Object.values(DEFAULT_SUGGESTED_QUESTIONS).flat()) {
      expect(question).not.toMatch(/Weingarten|grievance|Loudermill|contract articles|steward|constitution/i);
    }
  });

  // Legal response deadlines are on the
  // left-out list, so no starter asks how long a worker has to respond. The
  // disciplinary-notice question asks what to do instead, in both languages,
  // on native, and as the database definition default.
  it("asks what to do about a disciplinary notice, never how long there is to respond", () => {
    expect(DEFAULT_SUGGESTED_QUESTIONS.member).toContain("What should I do if I get a disciplinary notice?");
    expect(compassAssistantCatalogue.es["compass.suggested.member.4"]).toBe("¿Qué debo hacer si recibo un aviso disciplinario?");
    expect(nativeHasLiteral("What should I do if I get a disciplinary notice?")).toBe(true);
    expect(definitionDefault(SUGGESTED_QUESTION_LIST_KEYS.member)).toContain("What should I do if I get a disciplinary notice?");
    for (const lang of ["en", "es"]) {
      for (const [key, question] of Object.entries(compassAssistantCatalogue[lang]).filter(([key]) => key.startsWith("compass.suggested."))) {
        expect(question, `${lang} ${key}`).not.toMatch(/how long do I have|deadline to respond|time to respond|cuánto tiempo tengo|plazo para responder/i);
      }
    }
    expect(nativeDefaults).not.toMatch(/how long do I have to respond/i);
    expect(seedCopy ?? "").not.toMatch(/how long do I have to respond/i);
  });

  it("carries EN and ES admin copy for every definition this migration adds", () => {
    const keys = [...migration.matchAll(/\('((?:features|lists)\.ai_assistant\.[a-z_]+)'/g)].map((match) => match[1]);
    expect(keys).toHaveLength(4);
    for (const key of keys) {
      for (const lang of ["en", "es"]) {
        expect(t(lang, `settings.def.${key}.label`)).not.toBe(`settings.def.${key}.label`);
        expect(t(lang, `settings.def.${key}.description`)).not.toBe(`settings.def.${key}.description`);
      }
    }
  });

  it("maps hats onto the three old role lists", () => {
    expect(suggestedQuestionRole("member")).toBe("member");
    expect(suggestedQuestionRole(undefined)).toBe("member");
    for (const hat of ["steward", "coordinator", "advisor"]) expect(suggestedQuestionRole(hat)).toBe("steward");
    for (const hat of ["admin", "vp"]) expect(suggestedQuestionRole(hat)).toBe("admin");
  });

  it("shows product defaults in the reader's language and an admin's own list verbatim", () => {
    const es = (key) => t("es", key);
    expect(suggestedQuestionsFor(configuration({}), "member", (key) => t("en", key))).toEqual([...DEFAULT_SUGGESTED_QUESTIONS.member]);
    expect(suggestedQuestionsFor(configuration({}), "steward", es)[0]).toBe("¿Cuántos asuntos están abiertos y cuántos están resueltos?");
    const edited = ["Who is my steward?", "When is the next meeting?"];
    expect(suggestedQuestionsFor(configuration({ [SUGGESTED_QUESTION_LIST_KEYS.admin]: edited }), "vp", es)).toEqual(edited);
    expect(suggestedQuestionsFor(configuration({ [SUGGESTED_QUESTION_LIST_KEYS.member]: edited }), "admin", es)).toEqual(
      DEFAULT_SUGGESTED_QUESTIONS.admin.map((_, index) => t("es", `compass.suggested.admin.${index + 1}`)),
    );
  });

  it("returns none when the admin turns suggestions off, and defers to built-ins without configuration", () => {
    expect(suggestedQuestionsFor(configuration({ [SUGGESTED_QUESTIONS_SWITCH]: false }), "member", (key) => key)).toEqual([]);
    expect(suggestedQuestionsFor(null, "member", (key) => key)).toBeNull();
  });

  it("lets every product default (EN and ES) reach the model as the canonical starter", () => {
    for (const lang of ["en", "es"]) {
      for (const [key, question] of Object.entries(compassAssistantCatalogue[lang])) {
        if (!key.startsWith("compass.suggested.")) continue;
        const messages = buildGuideMessages(question, {}, [], source);
        expect(messages.at(-1).content).toBe(question);
      }
    }
  });

  it("keeps an admin-written question under the ordinary minimizer", () => {
    // Fully withheld text refuses rather than reaching the provider.
    expect(() => buildGuideMessages("What did Jordan Smith say about my overtime case?", {}, [], source)).toThrow(/minimization/);
  });
});

describe("Compass panel suggestions", () => {
  it("renders the organization's list as starters that only fill the composer", () => {
    const onSend = vi.fn();
    const list = ["How do I file a grievance?", "How do I find my steward?"];
    render(<LanguageProvider lang="en"><Assistant threads={[]} onClose={vi.fn()} onSend={onSend} suggestions={list} /></LanguageProvider>);
    const group = screen.getByRole("group", { name: t("en", "compass.chipsLabel") });
    expect(group.querySelectorAll("button")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "How do I find my steward?" }));
    expect(screen.getByRole("textbox", { name: t("en", "compass.askAria") })).toHaveValue("How do I find my steward?");
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.queryByText(t("en", "compass.chipTelework"))).toBeNull();
  });

  it("renders no suggestion group when the organization turned them off", () => {
    render(<LanguageProvider lang="en"><Assistant threads={[]} onClose={vi.fn()} onSend={vi.fn()} suggestions={[]} /></LanguageProvider>);
    expect(screen.queryByRole("group", { name: t("en", "compass.chipsLabel") })).toBeNull();
  });

  it("keeps the built-in starters when no list is provided (demo)", () => {
    render(<LanguageProvider lang="en"><Assistant threads={[]} onClose={vi.fn()} onSend={vi.fn()} /></LanguageProvider>);
    expect(screen.getByRole("button", { name: t("en", "compass.chipTelework") })).toBeInTheDocument();
  });
});
