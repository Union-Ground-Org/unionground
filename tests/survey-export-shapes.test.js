// @vitest-environment jsdom
// REQ-UG-SURVEY-AND-FILTERED-EXPORTS-XLSX-20261001: the browser-side survey
// export shapes for sparse payloads, every answer type, formula-leading cells
// and the download path.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  downloadSurveyExport,
  surveyExportCsv,
  surveyExportFileName,
  surveyExportTables,
} from "../src/features/engagement/surveyExport.js";

const t = (key) => key;

afterEach(() => vi.restoreAllMocks());

describe("survey export shapes", () => {
  it("fills safe defaults for an empty or sparse payload", () => {
    for (const payload of [null, {}, { questions: "x", responses: "y" }]) {
      const { summary, responses } = surveyExportTables(payload, t);
      expect(summary.slice(0, 6).map((row) => row[1])).toEqual(["", "", "", 0, 0, ""]);
      expect(responses).toEqual([["engagement.export.response", "engagement.export.submitted"]]);
    }
    const counted = surveyExportTables({ responses: [{ responseId: "r1", submittedAt: "2026-10-01" }] }, t);
    expect(counted.summary[3][1]).toBe(1);
  });

  // REQ-UG-SURVEY-RESPONSE-FLOOR-25-SERVER-SIDE-20261104: a question
  // the server withheld gets one summary row naming the floor and an empty
  // response column; a sparse payload falls back to a floor of 0 and a bucket
  // list with no answer count to 0.
  it("writes a withheld question as one row and leaves its column empty, also on a sparse payload", () => {
    const named = (key, vars) => (vars ? `${key}:${JSON.stringify(vars)}` : key);
    const withheld = { id: "q1", label: "Optional note", withheld: true, answered: null, distribution: [{ value: "x", count: 1 }] };
    const counted = { id: "q2", label: "Pick", distribution: [{ value: "a", count: 25 }] };
    const responses = [{ responseId: "r1", submittedAt: "2026-11-04", answers: { q2: "a" } }];
    const full = surveyExportTables({ privacyMinResponses: 25, questions: [withheld, counted], responses }, named);
    expect(full.summary.slice(8)).toEqual([
      ["Optional note", 'engagement.questionWithheld:{"minimum":25}', "", ""],
      ["Pick", 0, "a", 25],
    ]);
    expect(full.responses[1]).toEqual(["r1", "2026-11-04", "", "a"]);
    const sparse = surveyExportTables({ questions: [withheld] }, named);
    expect(sparse.summary.slice(8)).toEqual([["Optional note", 'engagement.questionWithheld:{"minimum":0}', "", ""]]);
  });

  it("writes a question without a distribution as one row and later buckets without repeating the label", () => {
    const { summary } = surveyExportTables({
      questions: [
        { id: "q1", label: "Open text" },
        { id: "q2", label: "Pick", answered: 3, distribution: [{ value: "a", count: 2 }, { value: ["b", "c"] }] },
      ],
    }, t);
    expect(summary.slice(8)).toEqual([
      ["Open text", 0, "", ""],
      ["Pick", 3, "a", 2],
      ["", "", "b; c", 0],
    ]);
  });

  it("renders every answer type and neutralises formula-leading CSV cells", () => {
    const payload = {
      questions: ["q1", "q2", "q3", "q4", "q5", "q6"].map((id) => ({ id, label: id })),
      responses: [{
        responseId: "r1",
        submittedAt: "2026-10-01",
        answers: { q1: null, q2: ["x", null, "y"], q3: { score: 4 }, q4: 7, q5: "=SUM(A1)", q6: 'say "hi"\r\nbye' },
      }, { responseId: "r2", submittedAt: "2026-10-02" }],
    };
    const [, first, second] = surveyExportCsv(payload, t).split(/\n(?=")/);
    expect(first).toBe('"r1","2026-10-01","","x; y","{""score"":4}","7","\'=SUM(A1)","say ""hi""\nbye"');
    expect(second).toBe('"r2","2026-10-02","","","","","",""');
    for (const lead of ["+1", "-1", "@x", "\tx"]) {
      const csv = surveyExportCsv({ questions: [{ id: "q", label: "q" }], responses: [{ responseId: "r", submittedAt: "s", answers: { q: lead } }] }, t);
      expect(csv.split("\n").at(-1)).toContain(`"'${lead}"`);
    }
  });

  it("names files safely and falls back to survey", () => {
    expect(surveyExportFileName("", "csv")).toBe("survey_results.csv");
    expect(surveyExportFileName("!!!", "pdf")).toBe("survey_results.csv");
    expect(surveyExportFileName(null, "xlsx")).toBe("survey_results.xlsx");
  });

  it("downloads CSV and XLSX through a revoked object URL", () => {
    const created = [];
    globalThis.URL.createObjectURL = vi.fn((blob) => { created.push(blob); return `blob:${created.length}`; });
    globalThis.URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    downloadSurveyExport({ title: "Check in", questions: [], responses: [] }, "csv", t);
    downloadSurveyExport({ title: "Check in", questions: [], responses: [] }, "xlsx", t);
    expect(created.map((blob) => blob.type)).toEqual([
      "text/csv;charset=utf-8",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ]);
    expect(click).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:1");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:2");
  });
});
