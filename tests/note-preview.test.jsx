import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { notePreview } from "../src/lib/notePreview.js";
import { CasesView } from "../src/views/CasesView.jsx";
import { recordItems } from "../src/alt/recordIndex.js";
import { projectQaListItem } from "../src/features/qa/store.js";

// BUG-UG-CASE-NOTE-PREVIEWS-RUN-LIST-LINES-TOGETHER-20261110: the
// seeded arbitration note, a line followed by a list.
const ARBITRATION_NOTE = "Next steps:\n- Demand for arbitration sent Aug 14\n- Request the full investigation file and camera retention log\n- Witness list from the shift lead";
const ARBITRATION_PREVIEW = "Next steps: Demand for arbitration sent Aug 14\u00a0· Request the full investigation file and camera retention log\u00a0· Witness list from the shift lead";
// toHaveTextContent collapses whitespace, the non-breaking space included.
const SHOWN_PREVIEW = ARBITRATION_PREVIEW.replace(/\u00a0/gu, " ");

describe("notePreview", () => {
  it("drops dashed list markers and introduces the list after its colon", () => {
    expect(notePreview(ARBITRATION_NOTE)).toBe(ARBITRATION_PREVIEW);
  });

  it("drops numbered, starred and bulleted markers", () => {
    expect(notePreview("1. Call the member\n2) File step 2\n* Copy the steward\n• Log the call")).toBe("Call the member\u00a0· File step 2\u00a0· Copy the steward\u00a0· Log the call");
  });

  it("leaves a single line alone apart from its spacing", () => {
    expect(notePreview("  Intake   complete  ")).toBe("Intake complete");
    expect(notePreview("Overtime -5 hours short")).toBe("Overtime -5 hours short");
    expect(notePreview("2026 grievance filed")).toBe("2026 grievance filed");
  });

  it("skips blank lines and Windows line endings", () => {
    expect(notePreview("Met with HR\r\n\r\n   \r\nThey will reply Friday\n\n")).toBe("Met with HR\u00a0· They will reply Friday");
    expect(notePreview("Summary:\n\n- One")).toBe("Summary: One");
  });

  it("keeps the separator on the line before a wrap", () => {
    expect(notePreview("Next steps:\n- One\n- Two")).toBe("Next steps: One\u00a0· Two");
    expect(notePreview("- One\n- Two")).not.toMatch(/ ·/u);
  });

  it("reads Spanish notes the same way", () => {
    expect(notePreview("Próximos pasos:\n- Enviar la demanda de arbitraje\n- Pedir el expediente completo")).toBe("Próximos pasos: Enviar la demanda de arbitraje\u00a0· Pedir el expediente completo");
  });

  it("returns an empty preview for a missing body", () => {
    expect(notePreview(undefined)).toBe("");
    expect(notePreview(null)).toBe("");
    expect(notePreview("\n - \n")).toBe("");
  });
});

describe("note previews on the web", () => {
  const item = {
    id: "case-arb",
    reference: "GR-2026-0412",
    title: "Discipline arbitration",
    type: "Discipline",
    status: "active",
    step: "Arbitration",
    deadline: "Dec 1, 2026",
    deadlineValue: "2026-12-01",
    overdue: false,
    updates: [{ id: "u-arb", body: ARBITRATION_NOTE, created_at: "2026-08-14T15:00:00Z" }],
    files: [],
  };
  const props = { onCreateCase: vi.fn(), onUpdateCase: vi.fn(), onAddCaseUpdate: vi.fn(), onAddCaseFile: vi.fn(), onRemoveCaseFile: vi.fn(), onOpenCaseFile: vi.fn() };

  it("shows a list note on the phone My cases timeline without a dash run-on", () => {
    const { container } = render(<CasesView data={{ cases: [item] }} {...props} />);
    const label = container.querySelector(".mcases-tl__label");
    expect(label).toHaveTextContent(SHOWN_PREVIEW);
    expect(label.textContent).not.toContain(" - ");
  });

  // #9569: the desktop strip shows stages only; the note is in the Latest bar.
  it("shows a list note in the desktop My cases Latest bar without a dash run-on, and not as a step", () => {
    const { container } = render(<CasesView desktop data={{ cases: [item] }} {...props} />);
    const strip = container.querySelector(".mcases-desk__strip");
    const latest = container.querySelector(".mcases-desk__latesttext");
    expect(strip).not.toHaveTextContent(SHOWN_PREVIEW);
    expect(latest).toHaveTextContent(SHOWN_PREVIEW);
    expect(latest.textContent).not.toContain(" - ");
  });

  it("keeps the record index case mark and the Q&A list preview on one readable line", () => {
    const [mark] = recordItems({ cases: [{ ...item, chapterId: null }] }).filter((entry) => entry.type === "case");
    expect(mark.sub).toBe(ARBITRATION_PREVIEW);
    expect(projectQaListItem({ id: "q1", title: "Steps?", body: ARBITRATION_NOTE, status: "open", upvoteCount: 0, replyCount: 0 }).preview).toBe(ARBITRATION_PREVIEW.slice(0, 180));
  });
});
