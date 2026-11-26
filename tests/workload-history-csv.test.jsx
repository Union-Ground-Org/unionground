import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { clearDeviceParityState } from "../src/lib/deviceParity.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { WorkloadView } from "../src/views/WorkloadView.jsx";
import { WORKLOAD_CATEGORY_KEYS } from "../src/lib/workloadCategories.js";

const HISTORY_TAB = "History";
const DOWNLOAD_BUTTON = "Download CSV";
const HEADER =
  "date,receipt,priority,pending,unread_docs,todos,referrals,ce_activities,assistance_requests,aged_cases,meta,note,worked_on,hours_worked";

// One entry per escaping case the History export has to survive. Everything the
// member typed reaches the file through csvCell, so a note with a comma, a
// quoted supervisor line or a pasted multi-line incident report must not shift
// or split the columns of the row it belongs to.
const ENTRIES = [
  { id: "csv-plain", receipt: "aaaa1111", note: "Front desk short-staffed" },
  { id: "csv-comma", receipt: "bbbb2222", note: "Intake, triage, coverage" },
  { id: "csv-quote", receipt: "cccc3333", note: 'Supervisor said "no overtime"' },
  { id: "csv-crlf", receipt: "dddd4444", note: "Line one\r\nLine two" },
  { id: "csv-lf", receipt: "eeee5555", note: "Only one\nnewline" },
  { id: "csv-empty", receipt: "ffff6666", note: null },
].map((entry) => ({ ...entry, counts: { ...Object.fromEntries(WORKLOAD_CATEGORY_KEYS.map(key => [key, 0])), priority: 1 }, meta: "full-time", dateLabel: "Jul 6" }));

function renderHistory(entries = ENTRIES) {
  const data = structuredClone(fallbackData);
  data.workload = { ...data.workload, entries };
  render(
    <LanguageProvider lang="en">
      <WorkloadView data={data} onLogWork={async () => ({})} onSaveReminder={async () => ({})} />
    </LanguageProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: HISTORY_TAB }));
}

// The download path is a Blob handed to an anchor click; capture the Blob and
// keep jsdom out of an unimplemented navigation.
async function downloadCsvText() {
  const createObjectURL = vi.fn(() => "blob:workload-log");
  const revokeObjectURL = vi.fn();
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL });
  try {
    fireEvent.click(screen.getByRole("button", { name: DOWNLOAD_BUTTON }));
    expect(click).toHaveBeenCalledOnce();
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:workload-log");
    const [blob] = createObjectURL.mock.calls[0];
    expect(blob.type).toBe("text/csv;charset=utf-8;");
    return await blob.text();
  } finally {
    click.mockRestore();
    vi.unstubAllGlobals();
  }
}

afterEach(() => {
  clearDeviceParityState();
});

describe("workload History CSV export escaping", () => {
  it("exports unknown original counts as blank cells while preserving measured zero", async () => {
    renderHistory([{ id: 'unknown', dateLabel: 'Nov 5', receipt: 'receipt', counts: { priority: 0, pending: null } }]);
    expect(document.querySelector('.mwl-histline')).toHaveTextContent('Priority 0 · Pending —');
    const csv = await downloadCsvText();
    expect(csv.split('\r\n')[1].split(',').slice(2, 10)).toEqual(['0', '', '', '', '', '', '', '']);
  });
  it("quotes and escapes every cell the way RFC 4180 readers expect", async () => {
    renderHistory();

    const csv = await downloadCsvText();
    const rows = csv.split("\r\n");

    // Rows join with CRLF, so a naive split sees header + 6 entries + the one
    // split the quoted CRLF note contributes; nothing else breaks a row.
    expect(rows[0]).toBe(HEADER);
    expect(rows).toHaveLength(8);

    // Ordinary value: no quoting at all, for it and for the numeric counts.
    expect(csv).toContain("Jul 6,aaaa1111,1,0,0,0,0,0,0,0,full-time,Front desk short-staffed,,\r\n");
    // Comma: quoted whole, commas untouched inside.
    expect(csv).toContain('Jul 6,bbbb2222,1,0,0,0,0,0,0,0,full-time,"Intake, triage, coverage",,\r\n');
    // Embedded double quote: quoted whole, each inner quote doubled.
    expect(csv).toContain('Jul 6,cccc3333,1,0,0,0,0,0,0,0,full-time,"Supervisor said ""no overtime""",,\r\n');
    // CRLF newline: quoted whole, the break preserved verbatim.
    expect(csv).toContain('Jul 6,dddd4444,1,0,0,0,0,0,0,0,full-time,"Line one\r\nLine two",,\r\n');
    // Bare LF newline: also quoted, and not rewritten to CRLF.
    expect(csv).toContain('Jul 6,eeee5555,1,0,0,0,0,0,0,0,full-time,"Only one\nnewline",,');
    // A null note is an empty unquoted cell, not the string "null".
    // The two worked-day columns are empty when the member gave none.
    expect(csv.endsWith("Jul 6,ffff6666,1,0,0,0,0,0,0,0,full-time,,,")).toBe(true);
  });

  it("exports nothing when the member has no submissions", () => {
    renderHistory([]);

    // The empty History tab has no export button to press at all.
    expect(screen.queryByRole("button", { name: DOWNLOAD_BUTTON })).toBeNull();
  });
});
