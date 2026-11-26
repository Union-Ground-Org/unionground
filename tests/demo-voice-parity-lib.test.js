import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clampPrivacyThreshold,
  exportVoiceReport,
  prioritizeWeeklyQuestions,
  resultReadiness,
  selectWeightedWeeklyQuestion,
  viewerAuthor,
  voiceAuthoredByViewer,
  voiceAuthorName,
  voiceEditedCopy,
  voiceJoinedOptions,
  voiceLabel,
  voiceOptionLabel,
  voiceText,
} from "../src/lib/demoVoiceParity.js";

import { createDemoVoiceState, readDemoVoiceState, writeDemoVoiceState, reportSnapshot, visibleSurveyQuestions, surveySectionComplete } from "./fixtures/retired-pre-bot/src/lib/demoVoiceParity.js";
vi.unmock("../src/lib/demoVoiceParity.js");

describe("Voice demo parity state helpers", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("persists state, publishes changes, and falls back safely for invalid storage", () => {
    const listener = vi.fn();
    window.addEventListener("union-ground:demo-voice-change", listener);
    const state = createDemoVoiceState();
    expect(writeDemoVoiceState(state)).toBe(state);
    expect(readDemoVoiceState()).toEqual(state);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ detail: state }),
    );
    window.sessionStorage.setItem(
      "union-ground:sample:voice-parity:v1",
      "not-json",
    );
    expect(readDemoVoiceState().quarterly.id).toBe("quarterly-2026-q3");
    window.removeEventListener("union-ground:demo-voice-change", listener);
  });

  it("resolves bilingual copy and stable option labels", () => {
    expect(voiceText({ en: "English", es: "Español" }, "es")).toBe(
      "Español",
    );
    expect(voiceText("Already text", "es")).toBe("Already text");
    expect(voiceText(null)).toBe("");
    expect(voiceLabel("priority", "es")).toBe("Prioridad");
    expect(voiceLabel("custom-token", "es")).toBe("custom-token");
    expect(
      voiceOptionLabel({ label: { en: "Yes", es: "Sí" } }, "es"),
    ).toBe("Sí");
  });

  it("keeps SAMPLE Voice seed copy bilingual and authorship as a viewer flag", () => {
    const state = createDemoVoiceState();
    expect(voiceText(state.quarterly.title, "en")).toBe(
      "Quarterly member check-in",
    );
    expect(voiceText(state.quarterly.title, "es")).toBe(
      "Chequeo trimestral de miembros",
    );
    expect(
      state.weeklyQuestions.map((question) => voiceText(question.body, "en")),
    ).toEqual([
      "Which shift needs a steward walk-through next?",
      "Should the chapter publish a monthly staffing snapshot?",
      "What training would help new stewards most?",
    ]);
    expect(
      state.weeklyQuestions.map((question) => voiceText(question.body, "es")),
    ).toEqual([
      "¿Qué turno necesita un recorrido del delegado a continuación?",
      "¿Debería el capítulo publicar un resumen mensual de dotación?",
      "¿Qué capacitación ayudaría más a los nuevos delegados?",
    ]);
    expect(voiceJoinedOptions(state.weeklyQuestions[0].options, "en")).toBe(
      "Day · Evening · Overnight",
    );
    expect(voiceJoinedOptions(state.weeklyQuestions[0].options, "es")).toBe(
      "Día · Tarde · Noche",
    );
    expect(voiceJoinedOptions(state.weeklyQuestions[1].options, "es")).toBe(
      "Sí · No · Discutir primero",
    );
    expect(voiceJoinedOptions(state.weeklyQuestions[2].options, "es")).toBe(
      "Recepción de casos · Investigaciones · Plazos",
    );
    expect(voiceAuthoredByViewer(state.qa[0].author)).toBe(true);
    expect(voiceAuthoredByViewer(state.qa[1].author)).toBe(false);
    expect(voiceAuthoredByViewer(state.qa[1].replies[0].author)).toBe(true);
    expect(voiceAuthorName(state.qa[0].author, "es", "Tú")).toBe("Tú");
    expect(voiceAuthorName(state.qa[1].author, "es", "Tú")).toBe("Morgan Chen");
    expect(voiceAuthorName("You", "es", "Tú")).toBe("Tú");
    expect(voiceAuthoredByViewer(viewerAuthor())).toBe(true);
    expect(voiceAuthoredByViewer(viewerAuthor())).toBe(
      voiceAuthoredByViewer(viewerAuthor()),
    );
    const edited = voiceEditedCopy(state.qa[0].body, "Texto visible", "es");
    expect(edited.es).toBe("Texto visible");
    expect(edited.en).toBe(
      "I want to keep a useful record without including private health information.",
    );
    expect(voiceText(state.qa[0].title, "es")).toBe(
      "¿Cómo documento un descanso denegado?",
    );
    expect(voiceText(state.qa[1].title, "es")).toBe(
      "¿Dónde encuentro la rotación de horas extra?",
    );
    expect(voiceText(state.qa[0].replies[0].body, "es")).toContain(
      "Anota la fecha, el descanso programado",
    );
    expect(voiceText(state.qa[0].replies[1].body, "es")).toBe(
      "También guardo el horario publicado cuando cambia.",
    );
    expect(voiceText(state.qa[1].replies[0].body, "es")).toBe(
      "La copia más reciente está en el Hub del capítulo, bajo Registros laborales.",
    );
  });

  it("applies conditional visibility and required-answer completion", () => {
    expect(visibleSurveyQuestions("workload", {})).toHaveLength(2);
    expect(visibleSurveyQuestions("workload", { staffing: "no" })).toHaveLength(
      3,
    );
    expect(surveySectionComplete("workload", {})).toBe(false);
    expect(
      surveySectionComplete("workload", {
        workload: 3,
        staffing: "yes",
      }),
    ).toBe(true);
    expect(
      surveySectionComplete("priorities", { priorities: ["staffing"] }),
    ).toBe(true);
  });

  it("clamps privacy thresholds and distinguishes the smallest-group rule", () => {
    // No released group under 25 (Lovable audit APP-STEWARD-07): blank, zero
    // and anything lower clamp up to the floor.
    expect(clampPrivacyThreshold("")).toBe(25);
    expect(clampPrivacyThreshold(0)).toBe(25);
    expect(clampPrivacyThreshold(10)).toBe(25);
    expect(clampPrivacyThreshold(80)).toBe(50);
    expect(clampPrivacyThreshold(30)).toBe(30);
    const survey = createDemoVoiceState().surveys[0];
    expect(resultReadiness(survey, "quarter").ready).toBe(true);
    expect(resultReadiness({ ...survey, threshold: 10 }, "quarter").threshold).toBe(25);
    expect(resultReadiness({ ...survey, threshold: 30 }, "quarter").ready).toBe(
      false,
    );
    expect(
      resultReadiness(createDemoVoiceState().surveys[1], "all").ready,
    ).toBe(false);
  });

  it("derives range-specific snapshots including empty audiences", () => {
    const survey = createDemoVoiceState().surveys[0];
    expect(reportSnapshot(survey, "year")).toEqual(
      expect.objectContaining({ responses: 276, completionRate: 88 }),
    );
    expect(
      reportSnapshot({ ...survey, audience: 0, rangeResponses: null }, "all"),
    ).toEqual(
      expect.objectContaining({ responses: 238, completionRate: 0 }),
    );
  });

  it("maintains one priority question and performs a weighted eligible draw", () => {
    const questions = createDemoVoiceState().weeklyQuestions;
    const prioritized = prioritizeWeeklyQuestions(questions, "weekly-2");
    expect(prioritized.filter((item) => item.state === "priority")).toEqual([
      expect.objectContaining({ id: "weekly-2" }),
    ]);
    expect(selectWeightedWeeklyQuestion(questions, () => 0)?.id).toBe(
      "weekly-2",
    );
    expect(selectWeightedWeeklyQuestion(questions, () => 0.999)?.id).toBe(
      "weekly-3",
    );
    expect(
      selectWeightedWeeklyQuestion(
        questions.map((item) => ({ ...item, state: "published" })),
      ),
    ).toBeNull();
  });

  it("exports the selected survey and selected report range", () => {
    const state = createDemoVoiceState();
    const csv = exportVoiceReport(
      "csv",
      state,
      "survey-quarterly",
      "year",
    );
    expect(csv).toContain('"Q3 member health and workplace conditions"');
    expect(csv).toContain('"Rolling year"');
    expect(csv).toContain('"276"');
    const scheduling = exportVoiceReport(
      "xlsx",
      state,
      "survey-scheduling",
      "all",
    );
    // An export is a release: a survey still under the floor of 25 has none,
    // and a threshold set lower is exported as the 25 it is enforced at.
    expect(scheduling).toBe("");
    expect(csv).toContain('"Privacy threshold","25"');
    expect(exportVoiceReport("csv", { surveys: [{ ...state.surveys[0], threshold: 10 }] }, "survey-quarterly", "year")).toContain('"Privacy threshold","25"');
    expect(exportVoiceReport("csv", { surveys: [] })).toBe("");
  });

  it("downloads a retained report through a temporary browser Blob URL", () => {
    const create = URL.createObjectURL;
    const revoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:owned-report");
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      const state = createDemoVoiceState();
      exportVoiceReport("xlsx", state);
      expect(click.mock.instances[0].download).toBe("member-voice-report.xls");
      expect(URL.createObjectURL.mock.calls[0][0].type).toBe("application/vnd.ms-excel");
      exportVoiceReport("csv", state);
      expect(click.mock.instances[1].download).toBe("member-voice-report.csv");
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:owned-report");
    } finally {
      if (create) URL.createObjectURL = create; else delete URL.createObjectURL;
      if (revoke) URL.revokeObjectURL = revoke; else delete URL.revokeObjectURL;
      click.mockRestore();
    }
  });

  it("formats named authors and edits ordinary text without inventing translations", () => {
    expect(voiceAuthorName({ name: { en: "Peer", es: "Compañero" } }, "es")).toBe("Compañero");
    expect(voiceEditedCopy("Original", "Revised", "es")).toBe("Revised");
  });

  it.each(["__proto__", "constructor", "toString", "fr", "", null])("rejects an unsupported bilingual edit key: %s", (lang) => {
    const original = { en: "Original", es: "Traducción" };
    expect(() => voiceEditedCopy(original, { injected: true }, lang)).toThrow(RangeError);
    expect(original).toEqual({ en: "Original", es: "Traducción" });
    expect(Object.getPrototypeOf(original)).toBe(Object.prototype);
  });

  it("edits both supported languages while preserving the other translation", () => {
    const original = { en: "Original", es: "Traducción" };
    expect(voiceEditedCopy(original, "Revised")).toEqual({ en: "Revised", es: "Traducción" });
    expect(voiceEditedCopy(original, "Revisada", "es")).toEqual({ en: "Original", es: "Revisada" });
  });

  it("returns report text when browser object URLs are unavailable", () => {
    const create = URL.createObjectURL;
    URL.createObjectURL = undefined;
    try {
      expect(exportVoiceReport("csv", createDemoVoiceState())).toContain('"Responses"');
    } finally {
      if (create) URL.createObjectURL = create; else delete URL.createObjectURL;
    }
  });
});
