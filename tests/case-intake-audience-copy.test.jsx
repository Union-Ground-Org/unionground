import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StewardCaseIntake } from "../src/features/caseIntake/StewardCaseIntake.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import { CasesView } from "../src/views/CasesView.jsx";

afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

const wrap = (ui, lang) => render(<LanguageProvider lang={lang}>{ui}</LanguageProvider>);

// Pin literal copy through both real forms so a catalogue
// edit cannot silently turn the member's own hint back into staff wording.
// #9467 W8-11: both hints end with the box's length limit.
describe("issue remedy hints speak to the right audience", () => {
  it.each([
    { lang: "en", label: "Remedy sought",
      own: 'What you are asking for, like "rescind the warning and make whole".',
      staff: 'What the worker asks for, like "rescind the warning and make whole".',
      limit: " Up to 2,000 characters." },
    { lang: "es", label: "Remedio que se pide",
      own: 'Lo que pides, como "anular la advertencia y compensar".',
      staff: 'Lo que pide el trabajador, como "anular la advertencia y compensar".',
      limit: " Hasta 2.000 caracteres." },
  ])("pins the worker and staff wording in $lang", async ({ lang, label, own, staff, limit }) => {
    const data = { member: { id: "member-1", organizationId: "org-1", chapterId: "chapter-1" }, cases: [] };
    const member = wrap(<CasesView data={data} onCreateCase={vi.fn()} onMessages={() => {}} />, lang);
    fireEvent.click(screen.getAllByRole("button", { name: t(lang, "mcases.startCase") })[0]);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText(label)).toHaveAccessibleDescription(own + limit);
    expect(within(dialog).queryByText(staff)).not.toBeInTheDocument();
    member.unmount();

    const api = {
      searchCaseMembers: vi.fn().mockResolvedValue([]),
      openCaseForMember: vi.fn(),
      listUnassignedCases: vi.fn().mockResolvedValue({ state: "ready", rows: [] }),
      claimCase: vi.fn(),
    };
    wrap(<StewardCaseIntake api={api} />, lang);
    expect(screen.getByLabelText(label)).toHaveAccessibleDescription(staff + limit);
    expect(screen.queryByText(own)).not.toBeInTheDocument();
    await screen.findByText(t(lang, "caseIntake.unassignedEmpty"));
  });
});
