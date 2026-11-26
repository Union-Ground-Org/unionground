// UB-RGT-04 — rights-lesson content is no longer English-only.
//
// The defect these pins guard: src/data/rightsLabels.js has carried a Spanish
// Weingarten script since the bilingual design pass, and tests asserted it was
// correct — but memberApi only read it when the lesson ROW WAS MISSING. With
// the five seeded rows present, which is every real deployment, a Spanish
// member got English titles, English checklists and an English script. The
// translation existed and nobody received it. So there are two halves here:
// the table now carries Spanish (§1), and the loader actually serves it (§2).
import { describe, expect, it } from "vitest";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";
import { rightsLessonFallback } from "../src/data/rightsLabels.js";
import { loadMemberApp } from "../src/lib/memberApi.js";

const LESSON_IDS = ["loudermill", "weingarten", "harassment", "pip", "safety"];

const sql = stripComments(loadMigrationSql("20260812120000_rights_lessons_locale"));
const seed = stripComments(loadMigrationSql("20260720191847_fresh_member_workflows"));

describe("the rights-lessons table carries a locale dimension", () => {
  it("adds a Spanish column for every content field UB-RGT-04 names", () => {
    // Titles, descriptions, steps and scripts — the four the record enumerates.
    for (const column of ["title_es text", "description_es text", "steps_es jsonb", "script_es text"]) {
      expect(sql, `${column} is not added`).toContain(`add column if not exists ${column}`);
    }
  });

  it("makes the Spanish copy required rather than optional", () => {
    // Nullable columns would rebuild the same defect one row at a time: a
    // lesson added later with no translation reads English again, silently.
    for (const column of ["title_es", "description_es", "steps_es", "script_es"]) {
      expect(sql, `${column} stays nullable`).toContain(`alter column ${column} set not null`);
    }
    // …and names the untranslated rows first, so the failure is actionable.
    expect(sql).toContain("member_rights_lessons has no Spanish copy for: %");
    expect(sql).toContain("errcode = 'not_null_violation'");
  });

  it("pins the two locales to the same number of steps", () => {
    // member_rights_progress.completed_steps holds integer INDICES into the
    // steps array and has no locale of its own. Locales of unequal length
    // would re-point a member's saved progress at a different step, or past
    // the end of the list, the moment they switched language.
    expect(sql).toContain("member_rights_lessons_steps_es_cardinality");
    expect(sql).toContain("check (jsonb_array_length(steps_es) = jsonb_array_length(steps))");
    expect(sql).toContain("check (jsonb_typeof(steps_es) = 'array')");
  });

  it("translates all five seeded lessons, not just the demonstrable one", () => {
    for (const id of LESSON_IDS) {
      expect(sql, `lesson ${id} has no Spanish row`).toContain(`('${id}',`);
    }
    expect(seed, "the seed no longer carries five lessons").toContain("('safety', 'Safety'");
  });

  it("keeps the missing-row fallback off the historical Weingarten script", () => {
    // (October 15, 2026). This historical Union Ground
    // migration seeds a Weingarten row that requests union representation.
    // Before recognition most private-sector workers have no such right, so
    // Union Ground's fallback deliberately says something else: it asks
    // for a coworker. The shared title and description still match the row,
    // so a worker reaching either source sees the same lesson.
    const fallback = rightsLessonFallback("es");
    expect(sql).toContain(fallback.title);
    expect(sql).toContain(fallback.description);
    expect(sql).not.toContain(fallback.script);
    expect(fallback.script).not.toMatch(/representación sindical|delegado/);
    expect(fallback.script).toMatch(/compañero o compañera de trabajo esté presente/);
    for (const step of fallback.steps) expect(step).not.toMatch(/representación|delegado/);
  });

  it("leaves `label` English because the client joins on it", () => {
    // RightsView resolves the selected lesson by label, searchIndex indexes
    // it, and the desktop/phone parity bridge persists it. Localizing the
    // join key is a different change; UB-RGT-04 asks for the four content
    // fields. The pin stops a later session from "finishing the job" here
    // without touching those three call sites.
    expect(sql).not.toContain("label_es");
    expect(sql).not.toMatch(/alter column label/);
  });

  it("needs no new grant, because the table grant was never column-scoped", () => {
    expect(seed).toContain("grant select on public.member_rights_lessons to authenticated;");
    expect(sql).not.toMatch(/grant\s+select[^;]*member_rights_lessons/);
  });
});

// ---------------------------------------------------------------------------
// §2 — the loader half. A bilingual table nothing selects per-locale from is
// still a translation nobody receives.
// ---------------------------------------------------------------------------

function chainable(result) {
  return new Proxy(function () {}, {
    get(_target, prop) {
      if (prop === "then") return (...args) => Promise.resolve(result).then(...args);
      return () => chainable(result);
    },
  });
}

const LESSON_ROWS = [
  {
    id: "weingarten",
    label: "Weingarten",
    order_index: 2,
    title: "Surprise disciplinary meeting",
    description: "Use this if management pulls you into a meeting that could lead to discipline.",
    steps: ["Ask whether the meeting could lead to discipline."],
    script: "If this meeting could in any way lead to my being disciplined or terminated, I respectfully request union representation before answering questions.",
    title_es: "Reunión disciplinaria sorpresa",
    description_es: "Úsalo si la gerencia te lleva a una reunión que podría terminar en una acción disciplinaria.",
    steps_es: ["Pregunta si la reunión podría llevar a una acción disciplinaria."],
    script_es: "Si esta reunión pudiera de alguna manera llevar a que se me discipline o se me despida, solicito respetuosamente representación sindical antes de responder preguntas.",
  },
  {
    id: "safety",
    label: "Safety",
    order_index: 5,
    title: "Raise an immediate safety concern",
    description: "Document the hazard and request a safe work plan without waiving protected rights.",
    steps: ["Report the hazard in writing."],
    script: "I am reporting a workplace safety concern and requesting written instructions and union assistance before proceeding.",
    title_es: "Reporta un riesgo de seguridad inmediato",
    description_es: "Documenta el peligro y solicita un plan de trabajo seguro sin renunciar a tus derechos protegidos.",
    steps_es: ["Reporta el riesgo por escrito."],
    script_es: "Estoy reportando un problema de seguridad en el trabajo y solicito instrucciones por escrito y asistencia sindical antes de continuar.",
  },
];

function clientForLanguage(language, lessons = LESSON_ROWS) {
  const tables = {
    member_profiles: { data: { id: "user-1", full_name: "Ana Ruiz", initials: "AR", language, chapter_id: "wor" }, error: null },
    chapters: { data: [{ id: "wor", name: "Harborview Care United" }], error: null },
    member_rights_lessons: { data: lessons, error: null },
  };
  return {
    from: (table) => chainable(tables[table] ?? { data: [], error: null }),
    rpc: (name) => Promise.resolve(
      ({ get_member_rewards_summary: { data: {}, error: null }, get_workload_stats: { data: {}, error: null } })[name]
      ?? { data: [], error: null },
    ),
  };
}

const loadRights = async (language, lessons) => (
  (await loadMemberApp(clientForLanguage(language, lessons), { id: "user-1", email: "a@example.org" })).rights
);

describe("the member loader serves lesson copy in the member's language", () => {
  it("returns Spanish content from the row for a Spanish member", async () => {
    const rights = await loadRights("es");
    expect(rights.title).toBe("Reunión disciplinaria sorpresa");
    expect(rights.script).toMatch(/representación sindical/);
    expect(rights.steps).toEqual(["Pregunta si la reunión podría llevar a una acción disciplinaria."]);
    // Every lesson, not just the one the fallback happened to cover.
    const safety = rights.lessonRecords.find((item) => item.id === "safety");
    expect(safety.title).toBe("Reporta un riesgo de seguridad inmediato");
    expect(safety.description).toMatch(/plan de trabajo seguro/);
    expect(safety.script).toMatch(/asistencia sindical/);
  });

  it("returns English content for an English member", async () => {
    const rights = await loadRights("en");
    expect(rights.title).toBe("Surprise disciplinary meeting");
    expect(rights.lessonRecords.find((item) => item.id === "safety").title)
      .toBe("Raise an immediate safety concern");
  });

  it("no longer routes Spanish through the missing-row fallback", async () => {
    // The regression this record exists for. Before UB-RGT-04 the loader read
    // item.title unconditionally, so this assertion held the English string
    // even though the Spanish one was sitting in the same result set.
    const rights = await loadRights("es");
    expect(rights.title).not.toBe("Surprise disciplinary meeting");
    // Both rows use the locale columns, including valid Spanish copy whose
    // title has no accent mark. Orthography is not a locale detector.
    expect(rights.lessonRecords.map(({ id, title, script }) => ({ id, title, script }))).toEqual([
      {
        id: "weingarten",
        title: "Reunión disciplinaria sorpresa",
        script: "Si esta reunión pudiera de alguna manera llevar a que se me discipline o se me despida, solicito respetuosamente representación sindical antes de responder preguntas.",
      },
      {
        id: "safety",
        title: "Reporta un riesgo de seguridad inmediato",
        script: "Estoy reportando un problema de seguridad en el trabajo y solicito instrucciones por escrito y asistencia sindical antes de continuar.",
      },
    ]);
  });

  it("keeps the label English so the client's lesson join still resolves", async () => {
    const rights = await loadRights("es");
    expect(rights.lessons).toEqual(["Weingarten", "Safety"]);
    for (const label of rights.lessons) {
      expect(rights.lessonRecords.find((item) => item.label === label).label).toBe(label);
    }
  });

  it("degrades to English copy when the database predates the locale columns", async () => {
    // Client-ahead-of-database rollout window. English copy a member can still
    // act on beats a blank walkthrough, and that includes the spoken script.
    const legacy = LESSON_ROWS.map(({ title_es, description_es, steps_es, script_es, ...row }) => row);
    const rights = await loadRights("es", legacy);
    expect(rights.lessonRecords.find((item) => item.id === "safety").title)
      .toBe("Raise an immediate safety concern");
    // Union Ground's loader degrades field by field to the row's own
    // English copy (src/lib/memberApi.js localizedLesson); it never swaps in
    // a different lesson's script, and never leaves the script blank.
    const weingarten = LESSON_ROWS.find((row) => row.id === "weingarten");
    expect(rights.script).toBe(weingarten.script);
    expect(rights.script).not.toBe("");
  });
});
