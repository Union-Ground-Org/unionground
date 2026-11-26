// REQ-UG-SURVEY-ESCALATION-AND-FOLLOWUP-TASKS-20261001 and
// REQ-UG-SURVEY-AND-FILTERED-EXPORTS-XLSX-20261001: staff see the derived
// survey attention, export CSV/XLSX for a date range (the server refuses a
// range below the privacy floor), and administrators get XLSX filtered
// exports while the switch is on.
import { strFromU8, unzipSync } from "fflate";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StaffEngagement } from "../src/features/engagement/StaffEngagement.jsx";
import { surveyExportCsv, surveyExportTables, surveyExportXlsx, surveyExportFileName } from "../src/features/engagement/surveyExport.js";
import { InstitutionalRecordsPanel } from "../src/features/institutionalRecords/InstitutionalRecordsPanel.jsx";
import { organizationExportTable } from "../src/lib/institutionalRecordsApi.js";
import { buildXlsxWorkbook, columnName, sheetName } from "../src/lib/xlsxWorkbook.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue, t as translate } from "../src/lib/i18n.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const t = (key, vars) => translate("en", key, vars);
const survey = { id: "survey-1", title: "Workplace check-in", cadence: "one_off", status: "open", coverage: { total: 5 }, tasks: [], reviews: [] };
const exportPayload = {
  surveyId: "survey-1", title: "Workplace check-in", available: true, responseCount: 3, privacyMinResponses: 3,
  from: "2026-09-01T00:00:00.000Z", to: null, generatedAt: "2026-10-01T12:00:00Z", format: "csv",
  questions: [{ id: "q1", label: "Biggest issue?", answered: 3, distribution: [{ value: "Pay", count: 2 }, { value: "Safety", count: 1 }] }],
  responses: [
    { responseId: "r1", submittedAt: "2026-09-02T00:00:00Z", answers: { q1: "Pay" } },
    { responseId: "r2", submittedAt: "2026-09-03T00:00:00Z", answers: { q1: "=HYPERLINK(\"x\")" } },
  ],
};

function readWorkbook(bytes) {
  const files = unzipSync(bytes);
  return Object.fromEntries(Object.entries(files).map(([name, data]) => [name, strFromU8(data)]));
}

describe("xlsx workbook writer", () => {
  it("writes a valid package with inline text, typed numbers and escaped markup", () => {
    const files = readWorkbook(buildXlsxWorkbook([{ name: "Data", rows: [["=SUM(A1)", 7, true, "<b>&", null]] }]));
    expect(Object.keys(files).sort()).toEqual([
      "[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml",
    ]);
    const sheet = files["xl/worksheets/sheet1.xml"];
    expect(sheet).toContain('<c r="A1" t="inlineStr"><is><t xml:space="preserve">=SUM(A1)</t></is></c>');
    expect(sheet).not.toContain("<f>");
    expect(sheet).toContain('<c r="B1"><v>7</v></c>');
    expect(sheet).toContain('<c r="C1" t="b"><v>1</v></c>');
    expect(sheet).toContain("&lt;b&gt;&amp;");
    expect(files["xl/workbook.xml"]).toContain('<sheet name="Data" sheetId="1" r:id="rId1"/>');
  });

  it("names columns and sheets the way spreadsheets require", () => {
    expect([columnName(0), columnName(25), columnName(26), columnName(701)]).toEqual(["A", "Z", "AA", "ZZ"]);
    const used = new Set();
    expect(sheetName("a/b:c", used)).toBe("a b c");
    expect(sheetName("A/B:C", used)).toBe("A B C 2");
    expect(sheetName("x".repeat(40), new Set())).toHaveLength(31);
  });
});

describe("survey export files", () => {
  it("builds the response table and summary from the server rows", () => {
    const { summary, responses } = surveyExportTables(exportPayload, t);
    expect(responses[0]).toEqual(["Response", "Submitted", "Biggest issue?"]);
    expect(responses).toHaveLength(3);
    expect(summary).toEqual(expect.arrayContaining([["Biggest issue?", 3, "Pay", 2], ["", "", "Safety", 1]]));
    const csv = surveyExportCsv(exportPayload, t);
    expect(csv.split("\n")[2]).toContain("\"'=HYPERLINK(\"\"x\"\")\"");
    const files = readWorkbook(surveyExportXlsx(exportPayload, t));
    expect(files["xl/workbook.xml"]).toContain('name="Summary"');
    expect(files["xl/workbook.xml"]).toContain('name="Responses"');
    expect(surveyExportFileName("Workplace check-in!", "xlsx")).toBe("Workplace_check_in_results.xlsx");
  });

  it("flattens filtered organization exports for XLSX", () => {
    expect(organizationExportTable({ rows: [{ domain: "members", occurredAt: "2026-09-01", values: { name: "A", tags: ["x"] } }] }))
      .toEqual([["domain", "occurredAt", "name", "tags"], ["members", "2026-09-01", "A", "[\"x\"]"]]);
  });
});

function staffClient({ attention, exportResult, exportError, jsonError } = {}) {
  return {
    rpc: vi.fn(async (name) => {
      if (name === "get_staff_engagement_snapshot") return { data: { surveys: [survey], livePolls: [], pulsePrompts: [], channels: [], members: [], presence: { online: 0 }, delivery: {} }, error: null };
      if (name === "get_survey_operations_attention") return { data: attention ?? { exports: true, surveys: [] }, error: null };
      if (name === "get_organization_survey_report" || name === "get_organization_survey_report_window") return { data: { ...exportPayload, responses: undefined }, error: null };
      if (name === "export_organization_survey_window") return exportError ? { data: null, error: exportError } : { data: exportResult ?? exportPayload, error: null };
      if (name === "export_organization_survey_results") return jsonError ? { data: null, error: jsonError } : { data: exportPayload, error: null };
      return { data: {}, error: null };
    }),
  };
}

describe("staff survey attention and exports", () => {
  it("shows the derived escalation, low-response follow-up and reminder state", async () => {
    render(<StaffEngagement client={staffClient({ attention: { exports: true, surveys: [{
      surveyId: "survey-1",
      escalation: { level: "elevated", reason: "coverage_unassigned", thresholdDays: 2, recommendedAction: "claim_coverage" },
      lowResponse: { state: "no_responses", threshold: 3, due: true },
      reminder: { due: true, dueAt: "2026-09-02T00:00:00Z", cadenceDays: 1, scheduledSending: false },
    }] } })} />);
    expect(await screen.findByText(/No staff member owns this survey after 2 days/)).toBeInTheDocument();
    expect(screen.getByText(catalogue.en["engagement.level.elevated"])).toBeInTheDocument();
    expect(screen.getByText(catalogue.en["engagement.followUpNoResponses"])).toBeInTheDocument();
    expect(screen.getByText(/A reminder is due\. Press Remind to send it\./)).toBeInTheDocument();
  });

  it("exports CSV and XLSX for the chosen date range", async () => {
    const createObjectURL = vi.fn(() => "blob:survey");
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      const client = staffClient();
      render(<StaffEngagement client={client} />);
      fireEvent.click(await screen.findByRole("button", { name: "Report" }));
      fireEvent.change(await screen.findByLabelText("Submitted from"), { target: { value: "2026-09-01" } });
      fireEvent.click(screen.getByRole("button", { name: "Update report" }));
      await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("get_organization_survey_report_window", {
        p_survey_id: "survey-1", p_from: new Date("2026-09-01T00:00:00").toISOString(), p_to: null,
      }));
      fireEvent.click(await screen.findByRole("button", { name: "Export XLSX" }));
      await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("export_organization_survey_window", {
        p_survey_id: "survey-1", p_from: new Date("2026-09-01T00:00:00").toISOString(), p_to: null, p_format: "xlsx",
      }));
      await waitFor(() => expect(click).toHaveBeenCalledOnce());
      fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
      await waitFor(() => expect(client.rpc).toHaveBeenCalledWith("export_organization_survey_window", expect.objectContaining({ p_format: "csv" })));
    } finally {
      click.mockRestore();
    }
  });

  it("explains a range that falls below the privacy floor", async () => {
    render(<StaffEngagement client={staffClient({ exportError: { code: "22023", message: "privacy floor not met" } })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Report" }));
    fireEvent.click(await screen.findByRole("button", { name: "Export CSV" }));
    expect(await screen.findByText(catalogue.en["engagement.exportBelowFloor"])).toBeInTheDocument();
  });

  // #9895 (W8-14 of #9463): Export JSON used to await the export with no
  // catch, so a refused export showed nothing at all.
  it("says when the JSON export fails, and says when it downloaded", async () => {
    render(<StaffEngagement client={staffClient({ jsonError: { code: "42501", message: "not allowed" } })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Report" }));
    fireEvent.click(await screen.findByRole("button", { name: "Export JSON" }));
    expect(await screen.findByText(catalogue.en["engagement.exportFailed"])).toBeInTheDocument();
    cleanup();
    const createObjectURL = vi.fn(() => "blob:survey");
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      const client = staffClient();
      render(<StaffEngagement client={client} />);
      fireEvent.click(await screen.findByRole("button", { name: "Report" }));
      const json = await screen.findByRole("button", { name: "Export JSON" });
      fireEvent.click(json);
      fireEvent.click(json);
      expect(await screen.findByText(catalogue.en["engagement.exportDownloaded"])).toBeInTheDocument();
      expect(client.rpc.mock.calls.filter(([name]) => name === "export_organization_survey_results")).toEqual([["export_organization_survey_results", { p_survey_id: "survey-1" }]]);
      expect(click).toHaveBeenCalledOnce();
    } finally {
      click.mockRestore();
    }
  });

  // #9895: the JSON export sends no range and its server function never
  // refuses below the floor, so it never tells the person to change a range.
  it("never gives the JSON export the date-range floor sentence", async () => {
    render(<StaffEngagement client={staffClient({ jsonError: { code: "22023", message: "privacy floor not met" } })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Report" }));
    fireEvent.click(await screen.findByRole("button", { name: "Export JSON" }));
    expect(await screen.findByText(catalogue.en["engagement.exportFailed"])).toBeInTheDocument();
    expect(screen.queryByText(catalogue.en["engagement.exportBelowFloor"])).toBeNull();
  });

  it("offers only the JSON export while survey exports are switched off", async () => {
    render(<StaffEngagement client={staffClient({ attention: { exports: false, surveys: [] } })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Report" }));
    expect(await screen.findByRole("button", { name: "Export JSON" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Export XLSX" })).toBeNull();
    expect(screen.queryByLabelText("Submitted from")).toBeNull();
  });
});

describe("filtered organization export format", () => {
  function panel(switches) {
    const client = { rpc: vi.fn(async (name) => {
      if (name === "get_institutional_records_workspace") return { data: { canManage: true, canExport: true, records: [], contacts: [], roster: [], exportRuns: [] }, error: null };
      if (name === "get_member_organization_configuration") return { data: { switches }, error: null };
      return { data: {}, error: null };
    }) };
    render(<LanguageProvider lang="en"><InstitutionalRecordsPanel client={client} onNotice={vi.fn()} /></LanguageProvider>);
  }

  it("offers XLSX while the switch is on and hides it when off", async () => {
    panel({ "features.analytics.filtered_export_xlsx": true });
    fireEvent.click(await screen.findByRole("button", { name: "Exports" }));
    expect(await screen.findByRole("option", { name: "XLSX" })).toBeInTheDocument();
    cleanup();
    panel({ "features.analytics.filtered_export_xlsx": false });
    fireEvent.click(await screen.findByRole("button", { name: "Exports" }));
    await waitFor(() => expect(screen.queryByRole("option", { name: "XLSX" })).toBeNull());
  });
});
