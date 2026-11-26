// REQ-UG-SURVEY-RESPONSE-FLOOR-25-SERVER-SIDE-20261104: a survey's
// own privacy floor still accepts 3 to 50, but the server never releases a
// report, export or response review below 25. The survey editor and the
// published survey settings say so, in English and Spanish.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StaffEngagement } from "../src/features/engagement/StaffEngagement.jsx";
import { SURVEY_AUTHORING_LIMITS, SURVEY_REPORT_MINIMUM } from "../src/features/engagement/surveyAuthoring.js";
import { surveyExportCsv, surveyExportTables } from "../src/features/engagement/surveyExport.js";
import { engagementApi } from "../src/features/engagement/api.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t as translate } from "../src/lib/i18n.js";
import { expectRefusedEveryWay } from "./helpers/blockedPress.js";

const EN = "Reports, exports and response review never go below 25 responses, even when this floor is lower.";
const ES = "Los informes, las exportaciones y la revisión de respuestas nunca bajan de 25 respuestas, aunque este mínimo sea menor.";

const survey = {
  id: "survey-1", title: "Quarterly pulse", status: "open", cadence: "quarterly", periodKey: "2026-Q4",
  privacyMinResponses: 3, operationsState: "distributing", ownerUserId: null, opensAt: null, closesAt: null, reviewDueAt: null,
  coverage: {}, tasks: [], reviews: [],
};

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

beforeEach(() => {
  vi.spyOn(engagementApi, "loadStaff").mockResolvedValue({ surveys: [survey], livePolls: [], channels: [], pulsePrompts: [], members: [] });
});

async function renderStaff(lang) {
  render(<LanguageProvider lang={lang}><StaffEngagement client={{}} /></LanguageProvider>);
  await screen.findByTestId("staff-engagement");
}

describe("survey report minimum copy", () => {
  it("names the server minimum, which sits above every floor a survey may choose", () => {
    expect(SURVEY_REPORT_MINIMUM).toBe(25);
    expect(SURVEY_AUTHORING_LIMITS.privacyMin).toBe(3);
    expect(SURVEY_AUTHORING_LIMITS.privacyMax).toBe(50);
    expect(translate("en", "engagement.privacyFloorReportMinimum", { minimum: SURVEY_REPORT_MINIMUM })).toBe(EN);
    expect(translate("es", "engagement.privacyFloorReportMinimum", { minimum: SURVEY_REPORT_MINIMUM })).toBe(ES);
  });

  it.each([["en", "New survey", "Privacy floor", EN], ["es", "Nueva encuesta", "Mínimo de respuestas para privacidad", ES]])(
    "states the minimum beside the floor in the %s survey editor", async (lang, newSurvey, floorLabel, copy) => {
      await renderStaff(lang);
      fireEvent.click(screen.getByRole("button", { name: newSurvey }));
      const editor = screen.getByRole("heading", { name: newSurvey }).closest("form");
      const floor = editor.querySelector('input[type="number"][min="3"][max="50"]');
      expect(floor).not.toBeNull();
      expect(floor.closest("label")).toHaveTextContent(floorLabel);
      expect(floor).toHaveAccessibleDescription(copy);
    });

  it.each([["en", "Owner, due dates and privacy floor", "Privacy floor", EN], ["es", "Responsable, fechas límite y mínimo de privacidad", "Mínimo de respuestas para privacidad", ES]])(
    "states the minimum beside the floor in the %s published survey settings", async (lang, summary, floorLabel, copy) => {
      await renderStaff(lang);
      fireEvent.click(await screen.findByText(summary));
      const floor = screen.getByLabelText(floorLabel);
      expect(floor).toHaveValue(3);
      expect(floor).toHaveAccessibleDescription(`${lang === "es" ? "Ingresa un número entero del 3 al 50." : "Enter a whole number from 3 to 50."} ${copy}`);
    });

  it.each([
    ["en", "Owner, due dates and privacy floor", "Privacy floor", "Save privacy floor", "Enter a whole number from 3 to 50.", "Change the privacy floor before saving."],
    ["es", "Responsable, fechas límite y mínimo de privacidad", "Mínimo de respuestas para privacidad", "Guardar mínimo de privacidad", "Ingresa un número entero del 3 al 50.", "Cambia el mínimo de privacidad antes de guardar."],
  ])("explains blocked privacy floor saves in %s", async (lang, summary, floorLabel, buttonLabel, range, unchanged) => {
    const save = vi.spyOn(engagementApi, "setSurveyPrivacyFloor").mockResolvedValue({});
    await renderStaff(lang);
    fireEvent.click(await screen.findByText(summary));
    const floor = screen.getByLabelText(floorLabel);
    const button = screen.getByRole("button", { name: buttonLabel });
    expect(button).toHaveAccessibleDescription(unchanged);
    expectRefusedEveryWay(button, unchanged, () => save.mock.calls.length > 0);
    fireEvent.change(floor, { target: { value: "51" } });
    expect(screen.getAllByText(range)).toHaveLength(1);
    expect(floor).toHaveAccessibleDescription(`${range} ${lang === "es" ? ES : EN}`);
    expect(button).toHaveAccessibleDescription(range);
    expect(button.nextElementSibling).toBeVisible();
    expectRefusedEveryWay(button, range, () => save.mock.calls.length > 0);
    expect(screen.getAllByRole("alert")).toEqual([button.nextElementSibling]);
    fireEvent.change(floor, { target: { value: "4" } });
    expect(floor).toHaveAccessibleDescription(`${range} ${lang === "es" ? ES : EN}`);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(save).toHaveBeenCalledExactlyOnceWith(expect.any(Object), survey.id, 4);
    await screen.findByRole("button", { name: buttonLabel });
  });
});

// Gate round 2 (r2g2): the server withholds a question answered by fewer than
// the floor, and leaves its answers out of every exported response row.
describe("a withheld survey question", () => {
  const report = {
    surveyId: "survey-1", title: "Quarterly pulse", available: true, responseCount: 25, privacyMinResponses: 25,
    questions: [
      { id: "q1", label: "Enough staff?", type: "yes_no", withheld: false, answered: 25, distribution: [{ value: "yes", count: 25 }] },
      { id: "q2", label: "Optional note", type: "paragraph", withheld: true, answered: null, distribution: [] },
    ],
    responses: [{ responseId: "r1", submittedAt: "2026-11-04T10:00:00Z", answers: { q1: "yes" } }],
  };

  it.each([["en", "Report", "Withheld: fewer than 25 people answered this question."], ["es", "Informe", "Oculta: menos de 25 personas respondieron esta pregunta."]])(
    "says so in the %s report instead of an answer count", async (lang, button, copy) => {
      vi.spyOn(engagementApi, "loadSurveyReport").mockResolvedValue(report);
      await renderStaff(lang);
      fireEvent.click(screen.getByRole("button", { name: button }));
      expect(await screen.findByText(copy)).toBeInTheDocument();
      expect(screen.getByText("Optional note")).toBeInTheDocument();
    });

  it("says so in the export summary and leaves its response column empty", () => {
    const t = (key, vars) => translate("en", key, vars);
    const { summary, responses } = surveyExportTables(report, t);
    expect(summary).toEqual(expect.arrayContaining([["Enough staff?", 25, "yes", 25], ["Optional note", "Withheld: fewer than 25 people answered this question.", "", ""]]));
    expect(responses[1]).toEqual(["r1", "2026-11-04T10:00:00Z", "yes", ""]);
    expect(surveyExportCsv(report, t).split("\n")[1]).toBe('"r1","2026-11-04T10:00:00Z","yes",""');
  });
});
