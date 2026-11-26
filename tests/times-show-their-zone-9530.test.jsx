// UX-UG-TIMES-SHOWN-WITHOUT-A-ZONE-AND-IN-SEVERAL-FORMATS-20261122
// (#9530): the demo walk of Nov 24, 2026 still saw the bare browser stamp,
// "21/8/2025, 1:00:00 p. m." / "7/10/2025, 1:00:00 PM", on the Casework hub's
// bargaining tables and "11/19/2026, 3:14:00 PM" in the Admin's failed sign-in
// inbox, and the Member's Org structure printed its source date as the raw
// "2026-07-20". A moment now goes through formatGroupMoment (the group's zone,
// named), a day through formatCalendarDay (never shifted), and eslint refuses
// a new bare stamp under src/ and names the formatter to use.
import { ESLint } from "eslint";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CaseworkHubPanel } from "../src/components/CaseworkHubPanel.jsx";
import { AdminSecurityConfiguration } from "../src/components/AdminSecurityConfiguration.jsx";
import { OrgStructureView } from "../src/views/OrgStructureView.jsx";
import { AdministrativeEvidencePanel } from "../src/components/AdministrativeEvidencePanel.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { formatCalendarDay, formatGroupMoment } from "../src/lib/i18n/zonedDates.js";

const BARE_STAMP = /\d{1,2}\/\d{1,2}\/\d{4}, \d{1,2}:\d{2}:\d{2}/u;

describe("the shared moment and day formatters", () => {
  it("names the zone, drops the seconds and speaks the reader's language", () => {
    expect(formatGroupMoment("2025-08-21T17:00:00Z", "en")).toBe("Aug 21, 2025, 1:00 PM EDT");
    expect(formatGroupMoment("2025-08-21T17:00:00Z", "es")).toBe("21 ago 2025, 1:00 p. m. EDT");
  });

  it("uses the group's own zone when one is delivered, never the device's", () => {
    expect(formatGroupMoment("2025-08-21T17:00:00Z", "en", "America/Los_Angeles")).toBe("Aug 21, 2025, 10:00 AM PDT");
    expect(formatGroupMoment("2025-08-21T17:00:00Z", "en", { timeZone: "Europe/Berlin" })).toMatch(/^Aug 21, 2025, 7:00 PM GMT\+2$/u);
  });

  it("answers nothing for a missing or unreadable moment, never 1970 or Invalid Date", () => {
    for (const value of [null, undefined, "", "not a date"]) {
      for (const lang of ["en", "es"]) expect(formatGroupMoment(value, lang)).toBe("");
    }
  });

  it("reads a stored timestamptz with its offset, not in the device zone", () => {
    // Every moment these screens print is a timestamptz column, which
    // PostgREST and jsonb serialize with an offset.
    expect(formatGroupMoment("2026-11-19T20:14:00+00:00", "en")).toBe("Nov 19, 2026, 3:14 PM EST");
    expect(formatGroupMoment("2026-11-19T15:14:00-05:00", "en")).toBe("Nov 19, 2026, 3:14 PM EST");
  });

  it("shows a calendar day as that day in both languages, without a zone moving it", () => {
    expect(formatCalendarDay("2026-07-20", "en")).toBe("Jul 20, 2026");
    expect(formatCalendarDay("2026-07-20", "es")).toBe("20 jul 2026");
    expect(formatCalendarDay("2026-01-01", "en")).toBe("Jan 1, 2026");
    expect(formatCalendarDay("2026-02-30", "en")).toBe("");
    expect(formatCalendarDay("2026-07-20T10:00:00Z", "en")).toBe("");
  });

  it("reads a year below 100 as written, not as 19xx", () => {
    expect(formatCalendarDay("0099-03-04", "en")).toBe("Mar 4, 99");
    expect(formatCalendarDay("0099-02-29", "en")).toBe("");
    expect(formatCalendarDay("0000-01-01", "en")).toBe("");
  });
});

describe("Casework hub bargaining tables (Steward and Coordinator)", () => {
  const workspace = {
    id: "ws-1", title: "Mandatory overtime side letter", status: "closed", starts_at: "2025-08-21T17:00:00Z",
    proposals: [],
    events: [{ id: "ev-1", event_type: "pulse", pulse: "steady", body: "Team met", created_at: "2025-10-07T17:00:00Z" }],
  };
  for (const [lang, start, update] of [
    ["en", "Aug 21, 2025, 1:00 PM EDT", "Oct 7, 2025, 1:00 PM EDT"],
    ["es", "21 ago 2025, 1:00 p. m. EDT", "7 oct 2025, 1:00 p. m. EDT"],
  ]) {
    it(`shows the session start and live updates with their zone and no seconds (${lang})`, async () => {
      const api = { loadCaseworkHub: vi.fn().mockResolvedValue({ workspaces: [workspace], drafts: [], patterns: [] }) };
      const { container } = render(<LanguageProvider lang={lang}><CaseworkHubPanel chapterId="ch-1" caseOptions={[]} api={api} /></LanguageProvider>);
      expect(await screen.findByText(start)).toBeInTheDocument();
      expect(screen.getByText(update)).toBeInTheDocument();
      expect(container.textContent).not.toMatch(BARE_STAMP);
    });
  }
});

describe("a missing or unreadable stamp keeps Main's fallback and never prints 1970", () => {
  const NO_EPOCH = /1969|1970|Invalid Date/u;
  it("Casework hub prints a dash (dash fallback)", async () => {
    const workspace = { id: "ws-x", title: "Table with odd dates", status: "live", starts_at: "not a date", proposals: [], events: [{ id: "ev-x", event_type: "pulse", pulse: "steady", body: "Odd update", created_at: null }] };
    const api = { loadCaseworkHub: vi.fn().mockResolvedValue({ workspaces: [workspace], drafts: [], patterns: [] }) };
    const { container } = render(<LanguageProvider lang="en"><CaseworkHubPanel chapterId="ch-1" caseOptions={[]} api={api} /></LanguageProvider>);
    expect(await screen.findByText("Odd update")).toBeInTheDocument();
    expect(container.textContent).toContain("—");
    expect(container.textContent).not.toMatch(NO_EPOCH);
  });

  it("the failed sign-in inbox prints no time rather than 1970 or a crash (stored value passed straight)", async () => {
    const inbox = { openLast24Hours: 0, attentionThreshold: 5, items: [
      { id: "30000000-0000-4000-8000-00000000000a", memberName: "No time member", memberReference: "A1", method: "password", source: "web-saas", userAgent: "UA", status: "open", dispositionNote: null, occurredAt: null, reviewedAt: null },
      { id: "30000000-0000-4000-8000-00000000000b", memberName: "Odd time member", memberReference: "A2", method: "password", source: "web-saas", userAgent: "UA", status: "open", dispositionNote: null, occurredAt: "not a date", reviewedAt: null },
    ] };
    const api = { updateOrganizationSetting: vi.fn(), updateOrganizationLabel: vi.fn(), loadFailedLoginInbox: vi.fn().mockResolvedValue(inbox), dispositionFailedLoginAttempt: vi.fn() };
    const { container } = render(<LanguageProvider lang="en"><AdminSecurityConfiguration configuration={{ settings: [], labelKeys: [], labelOverrides: {} }} failedLoginInbox={inbox} api={api} reload={vi.fn()} onNotice={vi.fn()} /></LanguageProvider>);
    expect(await screen.findByText("No time member")).toBeInTheDocument();
    expect(screen.getByText("Odd time member")).toBeInTheDocument();
    expect(container.textContent).not.toMatch(NO_EPOCH);
  });

  it("administrative evidence keeps the stored text for an unreadable stamp and prints nothing for a missing one (stored-text fallback)", async () => {
    const desk = { fieldNoteBlocks: [], packets: [], actions: [], actionTargets: [], hasNext: { notes: false, actions: false }, history: [
      { id: "run-n", actionKey: "include", targetKind: "field_note_block", targetId: "b1", targetLabel: "Null stamp row", note: "", previousState: {}, resultingState: {}, actorLabel: "Sam Admin", createdAt: null },
      { id: "run-o", actionKey: "include", targetKind: "field_note_block", targetId: "b2", targetLabel: "Odd stamp row", note: "", previousState: {}, resultingState: {}, actorLabel: "Sam Admin", createdAt: "yesterday" },
    ] };
    const api = { loadAdministrativeEvidence: vi.fn().mockResolvedValue(desk), addFieldNoteEvidence: vi.fn(), draftFieldNotePacket: vi.fn(), executeAdministrativeObjectAction: vi.fn() };
    const { container } = render(<LanguageProvider lang="en"><AdministrativeEvidencePanel api={api} /></LanguageProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Action Lab" }));
    expect(await screen.findByText(/Null stamp row/u)).toBeInTheDocument();
    expect(container.textContent).toContain("Recorded: yesterday");
    expect(container.textContent).not.toMatch(NO_EPOCH);
  });
});

describe("Admin failed sign-in inbox", () => {
  const inbox = {
    openLast24Hours: 1, attentionThreshold: 5,
    items: [{ id: "30000000-0000-4000-8000-000000000009", memberName: "Former member", memberReference: "A1B2C3", method: "password", source: "web-saas", userAgent: "Test Browser/1.0", status: "open", dispositionNote: null, occurredAt: "2026-11-19T20:14:00.000Z", reviewedAt: null }],
  };
  for (const [lang, when] of [["en", "Nov 19, 2026, 3:14 PM EST"], ["es", "19 nov 2026, 3:14 p. m. EST"]]) {
    it(`shows when the attempt happened with its zone (${lang})`, async () => {
      const api = { updateOrganizationSetting: vi.fn(), updateOrganizationLabel: vi.fn(), loadFailedLoginInbox: vi.fn().mockResolvedValue(inbox), dispositionFailedLoginAttempt: vi.fn() };
      const { container } = render(<LanguageProvider lang={lang}><AdminSecurityConfiguration configuration={{ settings: [], labelKeys: [], labelOverrides: {} }} failedLoginInbox={inbox} api={api} reload={vi.fn()} onNotice={vi.fn()} /></LanguageProvider>);
      expect((await screen.findAllByText(new RegExp(when.replace(/[.+]/gu, "\\$&"), "u"))).length).toBeGreaterThan(0);
      expect(container.textContent).not.toMatch(BARE_STAMP);
    });
  }
});

describe("Member Org structure source date", () => {
  const structure = {
    organizationId: "org-1", chapterId: "wor",
    charts: [{ chartKind: "union", edges: [], nodes: [{ id: "u1", parentId: null, chapterId: "wor", nodeKind: "person", label: "Sam Okafor", subtitle: "Steward", positionX: 0, positionY: 0, sortOrder: 1, vacant: false, sourceLabel: "Imported chart", sourceAsOf: "2026-07-20" }] }],
  };
  for (const [lang, line, list] of [
    ["en", "Imported chart · Jul 20, 2026", "Union hierarchy"],
    ["es", "Imported chart · 20 jul 2026", null],
  ]) {
    it(`reads the source date as a date, not "2026-07-20" (${lang})`, () => {
      const { container } = render(<LanguageProvider lang={lang}><OrgStructureView structure={structure} /></LanguageProvider>);
      expect(container.textContent).toContain(line);
      expect(container.textContent).not.toContain("2026-07-20");
      if (list) {
        fireEvent.click(within(screen.getByRole("list", { name: list })).getByRole("button", { name: /Sam Okafor/ }));
        expect(within(screen.getByRole("complementary", { name: "Selected position" })).getByText(line)).toBeInTheDocument();
      }
    });
  }
});

describe("Member Org structure source without a calendar day", () => {
  const withSource = (sourceAsOf) => ({
    organizationId: "org-1", chapterId: "wor",
    charts: [{ chartKind: "union", edges: [], nodes: [{ id: "u1", parentId: null, chapterId: "wor", nodeKind: "person", label: "Sam Okafor", subtitle: "Steward", positionX: 0, positionY: 0, sortOrder: 1, vacant: false, sourceLabel: "Imported chart", sourceAsOf }] }],
  });
  it("shows a source date that is not a calendar day as the import stored it", () => {
    render(<LanguageProvider lang="en"><OrgStructureView structure={withSource("Fall 2026")} /></LanguageProvider>);
    fireEvent.click(within(screen.getByRole("list", { name: "Union hierarchy" })).getByRole("button", { name: /Sam Okafor/ }));
    expect(within(screen.getByRole("complementary", { name: "Selected position" })).getByText("Imported chart · Fall 2026")).toBeInTheDocument();
  });
  it("shows the source alone when the import carried no date", () => {
    render(<LanguageProvider lang="en"><OrgStructureView structure={withSource(null)} /></LanguageProvider>);
    fireEvent.click(within(screen.getByRole("list", { name: "Union hierarchy" })).getByRole("button", { name: /Sam Okafor/ }));
    expect(within(screen.getByRole("complementary", { name: "Selected position" })).getByText("Imported chart")).toBeInTheDocument();
  });
});

describe("eslint refuses a new bare stamp under src/", () => {
  const eslint = new ESLint({ cwd: process.cwd() });
  async function messages(code) {
    const [result] = await eslint.lintText(code, { filePath: "src/features/probe/Probe.jsx" });
    return result.messages.filter((message) => message.ruleId === "no-restricted-syntax").map((message) => message.message);
  }
  it.each([
    ["dateTimeFormat(lang) with no options", 'import { dateTimeFormat } from "../../lib/i18n.js";\nexport const x = (lang, v) => dateTimeFormat(lang).format(new Date(v));\n'],
    ["a Date's toLocaleString() with no arguments", "export const x = (v) => new Date(v).toLocaleString();\n"],
  ])("flags %s and names the shared formatter", async (_label, code) => {
    const found = await messages(code);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/formatGroupMoment .* src\/lib\/i18n\/zonedDates\.js/u);
  });

  it("allows the shared formatters and a formatter given its own options", async () => {
    expect(await messages('import { formatGroupMoment, formatCalendarDay } from "../../lib/i18n/zonedDates.js";\nexport const x = (lang, v) => [formatGroupMoment(v, lang), formatCalendarDay(v, lang)];\n')).toEqual([]);
    expect(await messages('import { dateTimeFormat } from "../../lib/i18n.js";\nexport const x = (lang, v) => dateTimeFormat(lang, { month: "short", day: "numeric" }).format(new Date(v));\n')).toEqual([]);
    expect(await messages("export const n = (v) => Number(v).toLocaleString();\n")).toEqual([]);
    expect(await messages('import { formatDateTimeWithZone } from "../../lib/i18n/zonedDates.js";\nexport const x = (lang, v) => formatDateTimeWithZone(v, lang);\n')).toEqual([]);
  });

  it("does not catch a Date held in a variable, as the rule's comment says", async () => {
    expect(await messages("export const x = (v) => { const at = new Date(v); return at.toLocaleString(); };\n")).toEqual([]);
  });
});
