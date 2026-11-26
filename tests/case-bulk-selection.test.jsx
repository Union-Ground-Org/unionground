// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expectPendingFocus } from "./helpers/busyWriteFocus.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SELECTION_LIMIT, clearVisible, isSelected, pruneSelection, selectVisible,
  selectedRows, selectionState, sharedStatus, toggleSelection,
} from "../src/lib/caseSelection.js";
import * as caseSelection from "../src/lib/caseSelection.js";
import { CASE_EXPORT_COLUMNS, CASE_EXPORT_LIMIT, CASE_RENDERED_ROW_FIELDS, caseExportFilename, csvEscape, serializeCaseCsv } from "../src/lib/caseExport.js";
import { mentionSegments, matchMentionCandidates, activeMentionQuery, completeMention, filterMentionCandidates } from "../src/lib/caseMentions.js";
import { CaseBulkActions } from "../src/components/CaseBulkActions.jsx";
import { CaseList } from "../src/components/CaseList.jsx";
import { CaseNoteBody, CaseNoteComposer } from "../src/components/CaseMentions.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { ASSIGN_LEAVE_UNCHANGED } from "../src/lib/memberApi.js";
import { fnBody, loadMigrationSql } from "./helpers/migration.js";
import { captureSanitizedDiagnostic } from "../src/lib/observability.js";

// The bar reports a handled write failure through the privacy-filtered sink.
// Stub it so the suite can assert exactly what leaves the browser, and so no
// test depends on whether Sentry happens to be configured.
vi.mock("../src/lib/observability.js", async (importOriginal) => ({
  ...(await importOriginal()),
  captureSanitizedDiagnostic: vi.fn(() => true),
}));

// The bar renders real English copy so a missing key shows up as a failing
// query rather than as a passing test against a stub label.
const t = (key, vars = {}) => {
  const value = catalogue.en[key];
  if (value === undefined) throw new Error(`missing en key: ${key}`);
  return value.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ""));
};

// The ledger row is `<li><b>{label}</b> \u2014 {error}</li>`, so the failure copy
// is a bare text node inside the item. Read whole rows rather than querying
// for a substring: a raw driver sentence that merely CONTAINS the catalogue
// wording would satisfy a containment assertion, and that is the defect.
const ledgerRows = () => [...screen.getByRole("status").querySelectorAll("li")].map((node) => node.textContent);

const ROWS = [
  { id: "c1", reference: "GR-1", memberName: "Ana Ruiz", title: "Schedule", step: "Intake", deadline: "2026-09-20", status: "active" },
  { id: "c2", reference: "GR-2", memberName: "Ben Cho", title: "Overtime", step: "Intake", deadline: "2026-09-21", status: "active" },
  { id: "c3", reference: "GR-3", memberName: "Cy Ode", title: "Discipline", step: "Step 1", deadline: "", status: "resolved" },
];

// Captured before any export test replaces the global. A later test compares
// against this exact constructor, so a leftover stub cannot pass by merely
// being callable.
const nativeURL = globalThis.URL;

// restoreAllMocks puts spies back and does not undo stubGlobal. The export
// cases replace URL with a plain object; without unstubAllGlobals that
// object is still the global when the next test starts, pass or fail.
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("case selection model", () => {
  it("toggles, bounds, and prunes without losing queue order", () => {
    let selection = toggleSelection([], "c2");
    selection = toggleSelection(selection, "c1");
    expect(selection).toEqual(["c2", "c1"]);
    expect(isSelected(selection, "c1")).toBe(true);
    selection = toggleSelection(selection, "c2");
    expect(selection).toEqual(["c1"]);

    // A filter that hides c1 must retire it, not submit it.
    expect(pruneSelection(["c1", "c3"], ["c3"])).toEqual(["c3"]);
    expect(selectedRows(ROWS, ["c3", "c1"]).map((row) => row.id)).toEqual(["c1", "c3"]);
  });

  // Both desks prune inside a React state updater keyed on a derived id list.
  // A desk loader that returns a fresh caseload array per render makes that key
  // change per render, so an updater that always returned a new array
  // scheduled a render on every render. That loop hung the steward desk and
  // every suite that mounts it. Nothing pruned must mean the same array back.
  it("hands back the identical array when nothing was pruned", () => {
    const selection = ["c1", "c2"];
    expect(pruneSelection(selection, ["c1", "c2", "c3"])).toBe(selection);
    expect(pruneSelection(selection, ["c2", "c1"])).toBe(selection);
    expect(pruneSelection(selection, ["c1"])).not.toBe(selection);
    expect(pruneSelection(selection, ["c1"])).toEqual(["c1"]);
    expect(pruneSelection(undefined, ["c1"])).toEqual([]);
  });

  it("refuses the 101st tick instead of silently dropping somebody else's", () => {
    const ids = Array.from({ length: SELECTION_LIMIT }, (_, index) => `case-${index}`);
    const full = selectVisible([], [...ids, "case-overflow"]);
    expect(full).toHaveLength(SELECTION_LIMIT);
    expect(full).not.toContain("case-overflow");
    expect(toggleSelection(full, "case-overflow")).toEqual(full);
    // Untick makes room again; the cap is a cap, not a one-way door.
    const room = toggleSelection(full, "case-0");
    expect(toggleSelection(room, "case-overflow")).toContain("case-overflow");
  });

  it("answers select-all-visible against the visible slice only", () => {
    const visible = ["c1", "c2"];
    expect(selectionState(["c1"], visible)).toMatchObject({ count: 1, allVisible: false, someVisible: true });
    expect(selectionState(visible, visible)).toMatchObject({ allVisible: true, someVisible: false });
    // Clearing the visible slice leaves an off-screen selection alone.
    expect(clearVisible(["c1", "c2", "c3"], visible)).toEqual(["c3"]);
  });

  it("reports a shared status only when the batch truly shares one, and offers no shared step", () => {
    expect(sharedStatus(selectedRows(ROWS, ["c1", "c2"]))).toBe("active");
    // There is no step to share: the batch step helper is gone with the procedure.
    expect(caseSelection).not.toHaveProperty("sharedStep");
  });
});

describe("case CSV export", () => {
  it("quotes separators and defuses a leading formula", () => {
    expect(csvEscape("plain")).toBe("plain");
    expect(csvEscape("Ruiz, Ana")).toBe("\"Ruiz, Ana\"");
    expect(csvEscape("say \"hi\"")).toBe("\"say \"\"hi\"\"\"");
    expect(csvEscape("line\nbreak")).toBe("\"line\nbreak\"");
    expect(csvEscape("=cmd|'/c calc'!A1")).toBe("'=cmd|'/c calc'!A1");
    expect(csvEscape(null)).toBe("");
  });

  it("serializes exactly the columns the list shows, in list order", () => {
    const csv = serializeCaseCsv(ROWS, CASE_EXPORT_COLUMNS, t);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("Reference,Worker,Title,Due,Status");
    expect(lines[1]).toBe("GR-1,Ana Ruiz,Schedule,2026-09-20,active");
    // The undated case exports an empty cell, never the localized dash.
    expect(lines[3]).toBe("GR-3,Cy Ode,Discipline,,resolved");
    // The rows still carry a step; Union Ground exports none.
    expect(CASE_EXPORT_COLUMNS.map((column) => column.key)).not.toContain("step");
    expect(csv).not.toMatch(/Intake|Step 1/);
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  // The file can never widen what the desk already showed. Every exported key
  // is a field the case row paints, and each value below is a distinct sentinel
  // read back from that painted row.
  it("exports only fields the desk already rendered for this actor", () => {
    expect(CASE_EXPORT_COLUMNS.map((column) => column.key)).toEqual([...CASE_RENDERED_ROW_FIELDS]);
    const row = {
      id: "case-rendered-fields",
      reference: "REF-RENDERED-FIELD-91",
      memberName: "Member Rendered Field Quinn",
      title: "Title Rendered Field Distinct",
      step: "Step Rendered Field Distinct",
      deadline: "2041-06-15",
      status: "status-rendered-field-distinct",
    };
    window.history.replaceState({}, "", "/m/coordinator");
    const view = render(
      <LanguageProvider lang="en">
        <CaseList plane="coordinator" rows={[row]} onOpenCase={vi.fn()} />
      </LanguageProvider>,
    );
    const painted = view.container.querySelector("tbody tr");
    expect(painted).not.toBeNull();
    const text = painted.textContent;
    for (const key of CASE_RENDERED_ROW_FIELDS) {
      expect(text, key).toContain(row[key]);
    }
    // A legacy row may still carry a step; the list no longer paints it.
    expect(CASE_RENDERED_ROW_FIELDS).not.toContain("step");
    expect(text).not.toContain(row.step);
    view.unmount();
    window.history.replaceState({}, "", "/m/coordinator");
  });

  it("dates the filename in the exporter's own calendar day", () => {
    // 9pm ET on the 17th is already the 18th in UTC; the file must say the
    // day the coordinator is living in.
    const evening = new Date(2026, 8, 17, 21, 30);
    expect(caseExportFilename("coordinator-cases", evening)).toBe("coordinator-cases-2026-09-17.csv");
  });
});

describe("mention parsing and rendering", () => {
  const people = [
    { userId: "u-ana", fullName: "Ana Ruiz" },
    { userId: "u-ana2", fullName: "Ana" },
    { userId: "u-ben", fullName: "Ben Cho" },
  ];

  it("binds the longest matching name and leaves the rest as prose", () => {
    expect(matchMentionCandidates("hello @Ana Ruiz please", people)).toEqual(["u-ana"]);
    expect(matchMentionCandidates("@Ana and @Ben Cho", people)).toEqual(["u-ana2", "u-ben"]);
    expect(matchMentionCandidates("no mentions here", people)).toEqual([]);
    // Deleting the name from the body withdraws the notification.
    expect(matchMentionCandidates("plain text", people)).toEqual([]);
  });

  it("renders an unknown mention as plain text rather than naming a stranger", () => {
    const { container } = render(
      <CaseNoteBody body="@Ana Ruiz and @Zed Nobody saw it" mentions={[{ userId: "u-ana", fullName: "Ana Ruiz" }]} />,
    );
    const chips = container.querySelectorAll(".case-mention");
    expect(chips).toHaveLength(1);
    expect(chips[0].textContent).toBe("@Ana Ruiz");
    expect(container.textContent).toContain("@Zed Nobody saw it");
  });

  it("links a mention only when the host has somewhere to send the reader", () => {
    const { container } = render(
      <CaseNoteBody body="@Ana Ruiz" mentions={[{ userId: "u-ana", fullName: "Ana Ruiz" }]} hrefFor={(id) => `/m/people/${id}`} />,
    );
    expect(container.querySelector("a.case-mention")?.getAttribute("href")).toBe("/m/people/u-ana");
  });

  it("completes a half-typed mention at the caret", () => {
    expect(activeMentionQuery("note for @An", 12)).toMatchObject({ query: "An" });
    expect(activeMentionQuery("no at sign", 5)).toBeNull();
    const done = completeMention("note for @An", 12, "Ana Ruiz");
    expect(done.body).toBe("note for @Ana Ruiz ");
    expect(done.caret).toBe(done.body.length);
  });

  it("carries the resolved ids beside the body when the note is submitted", async () => {
    const onSubmit = vi.fn().mockResolvedValue({});
    render(<CaseNoteComposer caseId="c1" candidates={people} onSubmit={onSubmit} t={t} />);
    const box = screen.getByRole("combobox");
    fireEvent.change(box, { target: { value: "please review @Ben Cho", selectionStart: 21 } });
    expect(screen.getByText(t("caseMentions.willNotify", { count: 1 }))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: catalogue.en["coordinator.addNote"] }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("c1", "please review @Ben Cho", ["u-ben"]));
  });

  it("segments unknown ids out without dropping their text", () => {
    const segments = mentionSegments("@Ana Ruiz hi", [{ userId: "u-ana", fullName: "Ana Ruiz" }]);
    expect(segments.map((segment) => segment.kind)).toEqual(["mention", "text"]);
    expect(segments.map((segment) => segment.text).join("")).toBe("@Ana Ruiz hi");
  });
});

describe("mention composer and parser edges", () => {
  const PEOPLE = [
    { userId: "u-ana", fullName: "Ana Ruiz" },
    { userId: "u-anabel", fullName: "Anabel Ruiz-Vega" },
    { userId: "u-ben", fullName: "Ben Cho" },
  ];

  it("opens the picker only while the caret sits inside a mention", () => {
    expect(activeMentionQuery("no mention here")).toBeNull();
    expect(activeMentionQuery("email me at name@example.com")).toBeNull();
    expect(activeMentionQuery("hand this to @An")).toMatchObject({ query: "An" });
    // Three whitespace-separated parts stay inside the window. A fourth part
    // does not open the picker, so widening the regex is a deliberate change.
    expect(activeMentionQuery("@Maria de Cruz")).toMatchObject({ query: "Maria de Cruz" });
    expect(activeMentionQuery("@Maria de la Cruz")).toBeNull();
    // The caret, not the end of the string, decides.
    expect(activeMentionQuery("@An and then some")).toBeNull();
    expect(activeMentionQuery("@An and then some", 3)).toMatchObject({ query: "An" });
  });

  it("documents only active-mention examples the three-part window accepts", () => {
    const source = readFileSync(resolve(process.cwd(), "src/lib/caseMentions.js"), "utf8");
    const start = source.indexOf("// The token under the caret");
    const end = source.indexOf("const ACTIVE_MENTION");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const examples = [...source.slice(start, end).matchAll(/@[\p{L}\p{M}0-9'’.-]+(?:[ \u00a0][\p{L}\p{M}0-9'’.-]+)*/gu)]
      .map((match) => match[0]);
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      expect(activeMentionQuery(example), example).not.toBeNull();
    }
  });

  it("filters candidates case-insensitively and returns everyone on an empty query", () => {
    expect(filterMentionCandidates(PEOPLE, "")).toHaveLength(3);
    expect(filterMentionCandidates(PEOPLE, "   ")).toHaveLength(3);
    expect(filterMentionCandidates(PEOPLE, "ruiz").map((p) => p.userId)).toEqual(["u-ana", "u-anabel"]);
    expect(filterMentionCandidates(null, "ruiz")).toEqual([]);
    expect(filterMentionCandidates([{ userId: "x" }], "ruiz")).toEqual([]);
  });

  it("leaves the body alone when there is nothing to complete", () => {
    expect(completeMention("plain text", 10, "Ana Ruiz")).toEqual({ body: "plain text", caret: 10 });
    expect(completeMention("hand to @An", 11, "   ")).toEqual({ body: "hand to @An", caret: 11 });
    expect(completeMention(null, null, "Ana Ruiz")).toEqual({ body: "", caret: 0 });
  });

  it("marks nothing when the note or the directory is empty", () => {
    expect(mentionSegments("", PEOPLE)).toEqual([]);
    expect(mentionSegments("just prose", [])).toEqual([{ kind: "text", text: "just prose" }]);
    expect(mentionSegments("just prose", null)).toEqual([{ kind: "text", text: "just prose" }]);
    // An entry with no usable name cannot become a chip.
    expect(mentionSegments("@Ana Ruiz", [{ userId: "u-ana", fullName: "   " }]))
      .toEqual([{ kind: "text", text: "@Ana Ruiz" }]);
    expect(matchMentionCandidates("@Ana Ruiz", null)).toEqual([]);
  });

  it("completes the name at the caret and puts the caret after it", async () => {
    const onSubmit = vi.fn().mockResolvedValue({});
    render(<CaseNoteComposer caseId="c1" candidates={PEOPLE} onSubmit={onSubmit} t={t} />);
    const box = screen.getByRole("combobox");
    fireEvent.change(box, { target: { value: "hand this to @An" } });
    fireEvent.click(await screen.findByRole("option", { name: "@Anabel Ruiz-Vega" }));
    await waitFor(() => expect(box).toHaveValue("hand this to @Anabel Ruiz-Vega "));
    // Longest-first binding: the completed name wins over the shorter prefix.
    expect(screen.getByText(t("caseMentions.willNotify", { count: 1 }))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t("coordinator.addNote") }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("c1", "hand this to @Anabel Ruiz-Vega", ["u-anabel"]));
    await waitFor(() => expect(box).toHaveValue(""));
  });

  it("keeps the note in the box and names the refusal when the server says no", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("note must be 1-4000 characters"));
    render(<CaseNoteComposer caseId="c1" candidates={PEOPLE} onSubmit={onSubmit} t={t} />);
    const box = screen.getByRole("combobox");
    fireEvent.change(box, { target: { value: "first pass" } });
    fireEvent.click(screen.getByRole("button", { name: t("coordinator.addNote") }));
    expect(await screen.findByRole("alert")).toHaveTextContent(t("caseMentions.failed"));
    expect(screen.queryByText("note must be 1-4000 characters")).not.toBeInTheDocument();
    expect(box).toHaveValue("first pass");
  });

  // A busy composer stays focusable and announces itself pending
  // (aria-disabled), so focus is not dropped while the host saves.
  it("submits nothing for whitespace, and stays quiet while the host is busy", async () => {
    const onSubmit = vi.fn();
    const view = render(<CaseNoteComposer caseId="c1" candidates={PEOPLE} onSubmit={onSubmit} t={t} busy />);
    expect((screen.getByRole("combobox")).closest('[aria-disabled="true"]')).not.toBeNull();
    await expectPendingFocus(screen.getByRole("combobox"));
    expect(screen.getByRole("button", { name: t("coordinator.addNote") })).toBeDisabled();
    view.unmount();

    render(<CaseNoteComposer caseId="c1" candidates={PEOPLE} onSubmit={onSubmit} t={t} label="Note" submitLabel="Post" />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "   " } });
    fireEvent.submit(document.querySelector(".case-note-composer"));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Post" })).toBeInTheDocument();
  });

  it("renders the note body inline when the host is already inside a paragraph", () => {
    const { container } = render(
      <CaseNoteBody as="span" className="tl-body" body="ping @Ana Ruiz" mentions={[PEOPLE[0]]} />,
    );
    const root = container.firstChild;
    expect(root.tagName).toBe("SPAN");
    expect(root.className).toBe("tl-body");
    expect(root.querySelector("mark.case-mention").textContent).toBe("@Ana Ruiz");
  });
});

// A11Y-UG-CASE-NOTE-MENTION-PICKER-NOT-COMBOBOX-20260917. The picker was
// Tab-reachable and nothing else: no combobox role, no expanded state, no
// owned listbox, no arrow keys, no escape and no announcement. These cases
// run in both catalogue languages because the announcement is copy.
describe("mention picker combobox", () => {
  const PEOPLE = [
    { userId: "u-ana", fullName: "Ana Ruiz" },
    { userId: "u-anabel", fullName: "Anabel Ruiz-Vega" },
    { userId: "u-ben", fullName: "Ben Cho" },
  ];
  const translator = (lang) => (key, vars = {}) => {
    const value = catalogue[lang][key];
    if (value === undefined) throw new Error(`missing ${lang} key: ${key}`);
    return value.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ""));
  };

  for (const lang of ["en", "es"]) {
    it(`wires the textarea, the list and the active option together in ${lang}`, async () => {
      const tl = translator(lang);
      render(<CaseNoteComposer caseId="c1" candidates={PEOPLE} onSubmit={vi.fn()} t={tl} />);
      const box = screen.getByRole("combobox");
      expect(box).toHaveAttribute("aria-expanded", "false");
      expect(box).toHaveAttribute("aria-autocomplete", "list");
      expect(box.getAttribute("aria-controls")).toBeNull();

      fireEvent.change(box, { target: { value: "hand this to @An" } });
      const listbox = await screen.findByRole("listbox");
      expect(box).toHaveAttribute("aria-expanded", "true");
      expect(box.getAttribute("aria-controls")).toBe(listbox.id);
      expect(listbox.id).toBeTruthy();

      const options = within(listbox).getAllByRole("option");
      expect(options.map((option) => option.textContent)).toEqual(["@Ana Ruiz", "@Anabel Ruiz-Vega"]);
      expect(options.every((option) => option.id)).toBe(true);
      expect(box.getAttribute("aria-activedescendant")).toBe(options[0].id);
      expect(options.map((option) => option.getAttribute("aria-selected"))).toEqual(["true", "false"]);
      // Focus never leaves the textarea, so no option is in the tab order and
      // Tab still lands on the composer's submit control.
      expect(options.map((option) => option.getAttribute("tabindex"))).toEqual(["-1", "-1"]);
      expect(screen.getByRole("button", { name: tl("coordinator.addNote") })).not.toBeDisabled();
    });

    it(`moves, inserts, dismisses and keeps the typed text from the keyboard in ${lang}`, async () => {
      const tl = translator(lang);
      const onSubmit = vi.fn().mockResolvedValue({});
      render(<CaseNoteComposer caseId="c1" candidates={PEOPLE} onSubmit={onSubmit} t={tl} />);
      const box = screen.getByRole("combobox");
      box.focus();
      fireEvent.change(box, { target: { value: "hand this to @An" } });
      const listbox = await screen.findByRole("listbox");
      const ids = within(listbox).getAllByRole("option").map((option) => option.id);

      fireEvent.keyDown(box, { key: "ArrowDown" });
      await waitFor(() => expect(box.getAttribute("aria-activedescendant")).toBe(ids[1]));
      expect(document.activeElement).toBe(box);
      fireEvent.keyDown(box, { key: "ArrowDown" });
      await waitFor(() => expect(box.getAttribute("aria-activedescendant")).toBe(ids[0]));
      fireEvent.keyDown(box, { key: "ArrowUp" });
      await waitFor(() => expect(box.getAttribute("aria-activedescendant")).toBe(ids[1]));

      // Escape leaves the typed text exactly as it was and closes the list.
      fireEvent.keyDown(box, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
      expect(box).toHaveValue("hand this to @An");
      expect(box).toHaveAttribute("aria-expanded", "false");
      expect(box.getAttribute("aria-activedescendant")).toBeNull();

      // Typing on reopens the list; Enter inserts the active option rather
      // than breaking the line.
      fireEvent.change(box, { target: { value: "hand this to @Ana" } });
      await screen.findByRole("listbox");
      fireEvent.keyDown(box, { key: "ArrowDown" });
      fireEvent.keyDown(box, { key: "Enter" });
      await waitFor(() => expect(box).toHaveValue("hand this to @Anabel Ruiz-Vega "));
      expect(screen.getByText(tl("caseMentions.willNotify", { count: 1 }))).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: tl("coordinator.addNote") }));
      await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("c1", "hand this to @Anabel Ruiz-Vega", ["u-anabel"]));
    });

    it(`announces the match count and the close in ${lang}`, async () => {
      const tl = translator(lang);
      render(<CaseNoteComposer caseId="c1" candidates={PEOPLE} onSubmit={vi.fn()} t={tl} />);
      const box = screen.getByRole("combobox");
      // Queried by the live region itself, not by role: the announcer carries
      // no status role on purpose, so the host desk's own status paragraph
      // stays the only element a bare getByRole("status") can find.
      const live = document.querySelector(".case-note-composer__announcer");
      expect(live).toBeTruthy();
      expect(live).toHaveAttribute("aria-live", "polite");
      expect(live).toHaveAttribute("aria-atomic", "true");
      expect(live.getAttribute("role")).toBeNull();
      expect(live).toHaveTextContent("");

      fireEvent.change(box, { target: { value: "hand this to @An" } });
      await waitFor(() => expect(live).toHaveTextContent(tl("caseMentions.matches", { count: 2 })));
      // Narrowing the query changes the offered set, so it is announced again.
      fireEvent.change(box, { target: { value: "hand this to @Anab" } });
      await waitFor(() => expect(live).toHaveTextContent(tl("caseMentions.matches", { count: 1 })));
      fireEvent.keyDown(box, { key: "Escape" });
      await waitFor(() => expect(live).toHaveTextContent(tl("caseMentions.dismissed")));
    });
  }

  it("leaves Enter and Escape alone when no list is open", async () => {
    const tl = translator("en");
    const onSubmit = vi.fn().mockResolvedValue({});
    render(<CaseNoteComposer caseId="c1" candidates={PEOPLE} onSubmit={onSubmit} t={tl} />);
    const box = screen.getByRole("combobox");
    fireEvent.change(box, { target: { value: "no mention here" } });
    const enter = fireEvent.keyDown(box, { key: "Enter" });
    expect(enter).toBe(true);
    expect(box).toHaveValue("no mention here");
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

// A11Y-UG-CASE-NOTE-COMPOSER-CARET-LOST-AFTER-POSTED-NOTE-20260920. The
// submit button holds focus when a note posts, and the emptied box disables
// it, so the caret has to be handed back to the textarea explicitly.
describe("note composer caret after a post", () => {
  const PEOPLE = [{ userId: "u-ana", fullName: "Ana Ruiz" }];
  const tl = (key, vars = {}) => catalogue.en[key].replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ""));

  it("returns focus to the empty textarea at position 0 after a resolved post", async () => {
    let resolvePost;
    const onSubmit = vi.fn(() => new Promise((resolve) => { resolvePost = resolve; }));
    render(<CaseNoteComposer caseId="c1" candidates={PEOPLE} onSubmit={onSubmit} t={tl} />);
    const box = screen.getByRole("combobox");
    fireEvent.change(box, { target: { value: "first note" } });
    const submit = screen.getByRole("button", { name: tl("coordinator.addNote") });
    submit.focus();
    fireEvent.click(submit);
    await waitFor(() => expect((box).closest('[aria-disabled="true"]')).not.toBeNull());
    resolvePost({});
    await waitFor(() => expect(document.activeElement).toBe(box));
    expect(box).toHaveValue("");
    expect(box.selectionStart).toBe(0);
    expect(box.selectionEnd).toBe(0);
    expect(box).toHaveAttribute("role", "combobox");

    // The second note goes out from the keyboard without hunting for the box.
    fireEvent.change(box, { target: { value: "second note" } });
    fireEvent.submit(document.querySelector(".case-note-composer"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    resolvePost({});
    await waitFor(() => expect(box).toHaveValue(""));
    expect(document.activeElement).toBe(box);
  });

  it("leaves focus where it was when the note is refused", async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error("refused"));
    render(<CaseNoteComposer caseId="c1" candidates={PEOPLE} onSubmit={onSubmit} t={tl} />);
    const box = screen.getByRole("combobox");
    fireEvent.change(box, { target: { value: "first note" } });
    const submit = screen.getByRole("button", { name: tl("coordinator.addNote") });
    submit.focus();
    fireEvent.click(submit);
    expect(await screen.findByRole("alert")).toHaveTextContent(tl("caseMentions.failed"));
    expect(document.activeElement).not.toBe(box);
    expect(document.activeElement).toBe(submit);
    expect(box).toHaveValue("first note");
  });
});

describe("bulk action bar", () => {
  // Union Ground issues have no grievance procedure (owner decision,
  // 2026-10-13). Even with an API that still carries the step and procedure
  // routines, the bar offers no Advance-step action and no panel reads a
  // procedure or writes a step.
  it("offers no Advance-step action and reads no procedure from any panel", async () => {
    const api = {
      advanceCaseStep: vi.fn(),
      getCaseProcedure: vi.fn(),
      listProcedures: vi.fn(),
      bulkUpdateCases: vi.fn(),
      assignCase: vi.fn(),
      loadAssignmentCandidates: vi.fn().mockResolvedValue([]),
      addCaseNote: vi.fn(),
      applyMacro: vi.fn(),
      listMacros: vi.fn().mockResolvedValue([]),
    };
    const { container } = render(<CaseBulkActions rows={ROWS} visibleIds={["c1", "c2"]} selection={["c1", "c2"]}
      onSelectionChange={() => {}} api={api} t={t} onDone={vi.fn().mockResolvedValue()} />);
    const group = screen.getByRole("group", { name: t("caseBulk.actionsLabel") });
    const names = within(group).getAllByRole("button").map((button) => button.textContent);
    expect(names).toEqual([t("caseBulk.setStatus"), t("caseBulk.assign"), t("caseBulk.addNote"), t("caseBulk.macros")]);
    for (const name of names) expect(name).not.toMatch(/advance|step|avanzar|paso/i);
    for (const panel of ["caseBulk.setStatus", "caseBulk.assign", "caseBulk.addNote", "caseBulk.macros"]) {
      fireEvent.click(within(group).getByRole("button", { name: t(panel) }));
      await waitFor(() => expect(within(group).getByRole("button", { name: t(panel) })).toHaveAttribute("aria-pressed", "true"));
      expect(container.querySelector("select[name='step'], textarea[name='outcome']")).toBeNull();
    }
    expect(api.getCaseProcedure).not.toHaveBeenCalled();
    expect(api.listProcedures).not.toHaveBeenCalled();
    expect(api.advanceCaseStep).not.toHaveBeenCalled();
  });

  it("bounds the roster reads instead of firing one RPC per selected case at once", async () => {
    const rows = Array.from({ length: 24 }, (_, index) => ({
      id: `b${index}`, reference: `GR-B${index}`, memberName: "Ana Ruiz", title: "Schedule",
      deadline: "", status: "active",
    }));
    let inFlight = 0;
    let peak = 0;
    const api = {
      assignCase: vi.fn(),
      loadAssignmentCandidates: vi.fn().mockImplementation(async () => {
        inFlight += 1; peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 0));
        inFlight -= 1;
        return [{ userId: "u-ben", fullName: "Ben Cho", roles: ["steward"] }];
      }),
    };
    render(<CaseBulkActions rows={rows} visibleIds={rows.map((row) => row.id)} selection={rows.map((row) => row.id)}
      onSelectionChange={() => {}} api={api} t={t} onDone={vi.fn().mockResolvedValue()} />);
    fireEvent.click(screen.getByRole("button", { name: t("caseBulk.assign") }));
    const stewardSelect = await screen.findByLabelText(t("coordinator.assignmentSteward"));
    await within(stewardSelect).findByRole("option", { name: "Ben Cho" });
    expect(api.loadAssignmentCandidates).toHaveBeenCalledTimes(24);
    expect(peak).toBeLessThanOrEqual(6);
  });

  it("refuses a mixed-status batch before it reaches the server", () => {
    const api = { bulkUpdateCases: vi.fn() };
    render(<CaseBulkActions rows={ROWS} visibleIds={["c1", "c3"]} selection={["c1", "c3"]}
      onSelectionChange={() => {}} api={api} t={t} />);
    fireEvent.click(screen.getByRole("button", { name: t("caseBulk.setStatus") }));
    expect(screen.getByRole("alert").textContent).toBe(t("caseBulk.mixedStatus"));
    expect(screen.queryByLabelText(t("caseBulk.nextStatus"))).toBeNull();
    expect(api.bulkUpdateCases).not.toHaveBeenCalled();
  });

  it("names the cases a per-case loop could not finish instead of reporting success", async () => {
    const api = {
      addCaseNote: vi.fn()
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error("Case is restricted")),
    };
    render(<CaseBulkActions rows={ROWS} visibleIds={["c1", "c2"]} selection={["c1", "c2"]}
      onSelectionChange={() => {}} api={api} t={t} />);
    fireEvent.click(screen.getByRole("button", { name: t("caseBulk.addNote") }));
    fireEvent.change(screen.getByLabelText(catalogue.en["caseNotes.staffNoteLabel"]), { target: { value: "Checked in" } });
    fireEvent.click(screen.getByRole("button", { name: t("caseBulk.applyToCount", { count: 2 }) }));
    await waitFor(() => expect(api.addCaseNote).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText(/GR-2/)).toBeTruthy());
    // The row names the case and the catalogue sentence; the English the
    // server happened to raise is not the coordinator's copy.
    expect(ledgerRows()).toEqual([`GR-2 \u2014 ${t("caseBulk.failed")}`]);
    expect(document.body.textContent).not.toContain("Case is restricted");
  });

  // SEC-UG-CASE-CSV-EXPORT-UNAUDITED-UNBOUNDED-20260917. The CSV is still
  // built in the browser from rows already rendered; what is pinned here is
  // that nothing reaches the disk without a receipt, and that neither the
  // receipt nor the file can be taken above the documented cap.
  const spyOnDownload = () => {
    const doc = document;
    const created = [];
    vi.spyOn(doc, "createElement").mockImplementation((tag) => {
      const node = Document.prototype.createElement.call(doc, tag);
      if (tag === "a") { node.click = () => { created.push("download"); }; return node; }
      return node;
    });
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:x", revokeObjectURL: () => {} });
    return created;
  };

  it("exports the selection when there is one and the visible slice otherwise, recording each before the file", async () => {
    const order = [];
    const doc = document;
    const anchors = [];
    vi.spyOn(doc, "createElement").mockImplementation((tag) => {
      const node = Document.prototype.createElement.call(doc, tag);
      if (tag === "a") { node.click = () => { order.push("download"); }; anchors.push(node); }
      return node;
    });
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:x", revokeObjectURL: () => {} });
    const recordCaseExport = vi.fn(async () => { order.push("record"); return { exportId: "e1" }; });

    const { rerender } = render(<CaseBulkActions rows={ROWS} visibleIds={["c1", "c2", "c3"]} selection={[]}
      onSelectionChange={() => {}} api={{ recordCaseExport }} t={t} exportPrefix="coordinator-cases"
      exportFilterKeys={["status", "deadline"]} />);
    fireEvent.click(screen.getByRole("button", { name: t("caseBulk.exportVisible", { count: 3 }) }));
    await waitFor(() => expect(order).toEqual(["record", "download"]));
    expect(anchors.at(-1).download).toMatch(/^coordinator-cases-\d{4}-\d{2}-\d{2}\.csv$/);
    // Ids, the scope, and the facet NAMES — never a facet value or row text.
    expect(recordCaseExport).toHaveBeenCalledWith(["c1", "c2", "c3"], "visible", ["status", "deadline"]);

    rerender(<CaseBulkActions rows={ROWS} visibleIds={["c1", "c2", "c3"]} selection={["c2"]}
      onSelectionChange={() => {}} api={{ recordCaseExport }} t={t} exportPrefix="coordinator-cases"
      exportFilterKeys={["status"]} />);
    expect(screen.getByRole("button", { name: t("caseBulk.exportSelected", { count: 1 }) })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t("caseBulk.exportSelected", { count: 1 }) }));
    // A selection names its own ids; the visible slice's facets do not travel
    // with it, because the selection is not what the facets produced.
    await waitFor(() => expect(recordCaseExport).toHaveBeenLastCalledWith(["c2"], "selection", []));
  });

  it("does not download when the export cannot be recorded", async () => {
    const created = spyOnDownload();
    const recordCaseExport = vi.fn().mockRejectedValue(new Error("export selection is not authorized"));
    render(<CaseBulkActions rows={ROWS} visibleIds={["c1", "c2", "c3"]} selection={[]}
      onSelectionChange={() => {}} api={{ recordCaseExport }} t={t} exportPrefix="coordinator-cases" />);
    fireEvent.click(screen.getByRole("button", { name: t("caseBulk.exportVisible", { count: 3 }) }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(t("caseBulk.exportAuditFailed")));
    expect(document.body.textContent).not.toContain("export selection is not authorized");
    expect(created).toEqual([]);
  });

  it("refuses an unaudited export outright rather than falling back to the old silent download", async () => {
    const created = spyOnDownload();
    render(<CaseBulkActions rows={ROWS} visibleIds={["c1", "c2", "c3"]} selection={[]}
      onSelectionChange={() => {}} api={{}} t={t} exportPrefix="coordinator-cases" />);
    fireEvent.click(screen.getByRole("button", { name: t("caseBulk.exportVisible", { count: 3 }) }));
    await waitFor(() => expect(screen.getByText(catalogue.en["caseBulk.exportAuditUnavailable"])).toBeTruthy());
    expect(created).toEqual([]);
  });

  it.each([["en", CASE_EXPORT_LIMIT], ["es", CASE_EXPORT_LIMIT]])("names the %s cap and writes no receipt above it", async (lang, limit) => {
    const created = spyOnDownload();
    const translate = (key, vars = {}) => {
      const value = catalogue[lang][key];
      if (value === undefined) throw new Error(`missing ${lang} key: ${key}`);
      return value.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ""));
    };
    const overCap = Array.from({ length: limit + 1 }, (_, index) => ({ id: `case-${index}`, reference: `GR-${index}` }));
    const recordCaseExport = vi.fn();
    render(<CaseBulkActions rows={overCap} visibleIds={overCap.map((row) => row.id)} selection={[]}
      onSelectionChange={() => {}} api={{ recordCaseExport }} t={translate} exportPrefix="coordinator-cases" />);
    fireEvent.click(screen.getByRole("button", { name: translate("caseBulk.exportVisible", { count: limit + 1 }) }));
    const message = translate("caseBulk.exportCapped", { count: limit + 1, limit, selectionLimit: SELECTION_LIMIT });
    // Both numbers are named, and they are not the same number: the cap that
    // was exceeded, and the smaller cap the "tick up to …" advice points at.
    expect(message).toContain(String(limit));
    expect(message).toContain(`${SELECTION_LIMIT} `);
    expect(catalogue[lang]["caseBulk.exportCapped"]).toContain("{selectionLimit}");
    await waitFor(() => expect(screen.getByText(message)).toBeTruthy());
    expect(recordCaseExport).not.toHaveBeenCalled();
    expect(created).toEqual([]);
  });

  // Review finding L4: dropping an id-less row would let the recorded count
  // understate the file, which is the one thing it must never do.
  it("refuses the export when a row carries no id instead of quietly exporting it", async () => {
    const created = spyOnDownload();
    const recordCaseExport = vi.fn();
    const rows = [...ROWS, { reference: "GR-4", memberName: "Di Ng", title: "Leave", step: "Intake", deadline: "", status: "active" }];
    render(<CaseBulkActions rows={rows} visibleIds={["c1", "c2", "c3"]} selection={[]}
      onSelectionChange={() => {}} api={{ recordCaseExport }} t={t} exportPrefix="coordinator-cases" />);
    fireEvent.click(screen.getByRole("button", { name: t("caseBulk.exportVisible", { count: 4 }) }));
    await waitFor(() => expect(screen.getByText(catalogue.en["caseBulk.exportAuditFailed"])).toBeTruthy());
    expect(recordCaseExport).not.toHaveBeenCalled();
    expect(created).toEqual([]);
  });

  it("caps a selection at the selection limit, which is the scope whose ids the receipt records", async () => {
    const created = spyOnDownload();
    const rows = Array.from({ length: SELECTION_LIMIT + 1 }, (_, index) => ({ id: `case-${index}`, reference: `GR-${index}` }));
    const recordCaseExport = vi.fn();
    render(<CaseBulkActions rows={rows} visibleIds={rows.map((row) => row.id)} selection={rows.map((row) => row.id)}
      onSelectionChange={() => {}} api={{ recordCaseExport }} t={t} exportPrefix="coordinator-cases" />);
    fireEvent.click(screen.getByRole("button", { name: t("caseBulk.exportSelected", { count: SELECTION_LIMIT + 1 }) }));
    await waitFor(() => expect(screen.getByText(t("caseBulk.exportCapped", {
      count: SELECTION_LIMIT + 1, limit: SELECTION_LIMIT, selectionLimit: SELECTION_LIMIT,
    }))).toBeTruthy());
    expect(recordCaseExport).not.toHaveBeenCalled();
    expect(created).toEqual([]);
  });

  it("applies a macro through the macro RPC, not through a raw case update", async () => {
    const api = {
      applyMacro: vi.fn().mockResolvedValue({ macroId: "m1", caseCount: 2, actionsApplied: 4, actionsSkipped: 2 }),
      listMacros: vi.fn().mockResolvedValue([
        { id: "m1", name: "Close with a note", active: true, actions: [{ kind: "set_status", status: "resolved" }, { kind: "add_note", body: "Closed." }] },
        { id: "m2", name: "Retired", active: false, actions: [] },
      ]),
    };
    render(<CaseBulkActions rows={ROWS} visibleIds={["c1", "c2"]} selection={["c1", "c2"]}
      onSelectionChange={() => {}} api={api} t={t} />);
    fireEvent.click(screen.getByRole("button", { name: t("caseBulk.macros") }));
    await waitFor(() => expect(api.listMacros).toHaveBeenCalled());
    // An inactive macro is not offered.
    expect(screen.queryByRole("button", { name: /Retired/ })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: /Close with a note/ }));
    await waitFor(() => expect(api.applyMacro).toHaveBeenCalledWith("m1", ["c1", "c2"], expect.any(String)));
    expect(await screen.findByText(t("caseBulk.macroApplied", { name: "Close with a note", count: 4, skipped: 2 }))).toBeTruthy();
  });

  // UX-UG-WEB-CASE-BULK-PANEL-LOADS-ON-CLOSE-20260920: the click that
  // closes a panel must not re-enter its loader. listMacros stays pending so
  // macros is still null when the closing click lands.
  it("does not re-read the macro list on the click that closes the Macros panel", async () => {
    let resolveMacros;
    const api = { applyMacro: vi.fn(), listMacros: vi.fn(() => new Promise((resolve) => { resolveMacros = resolve; })) };
    render(<CaseBulkActions rows={ROWS} visibleIds={["c1", "c2"]} selection={["c1", "c2"]}
      onSelectionChange={() => {}} api={api} t={t} />);
    const macrosButton = screen.getByRole("button", { name: t("caseBulk.macros") });
    fireEvent.click(macrosButton);
    fireEvent.click(macrosButton);
    expect(api.listMacros).toHaveBeenCalledTimes(1);
    resolveMacros([{ id: "m1", name: "Close with a note", active: true, actions: [] }]);
    await waitFor(() => expect(macrosButton.getAttribute("aria-pressed")).toBe("false"));
    // Reopening after the first load settles serves the loaded list.
    fireEvent.click(macrosButton);
    expect(await screen.findByRole("button", { name: /Close with a note/ })).toBeTruthy();
    expect(api.listMacros).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["resolves an empty roster", () => Promise.resolve([])],
    ["rejects", () => Promise.reject(new Error("network"))],
  ])("does not re-read the assignment roster on the click that closes the Assign panel when the read %s", async (_label, read) => {
    const api = { assignCase: vi.fn(), loadAssignmentCandidates: vi.fn(read) };
    render(<CaseBulkActions rows={ROWS} visibleIds={["c1", "c2"]} selection={["c1"]}
      onSelectionChange={() => {}} api={api} t={t} />);
    const assignButton = screen.getByRole("button", { name: t("caseBulk.assign") });
    fireEvent.click(assignButton);
    await waitFor(() => expect(api.loadAssignmentCandidates).toHaveBeenCalledTimes(1));
    fireEvent.click(assignButton);
    await waitFor(() => expect(assignButton.getAttribute("aria-pressed")).toBe("false"));
    expect(api.loadAssignmentCandidates).toHaveBeenCalledTimes(1);
  });

  // casework_apply_macro skips an action whose derived operation id is already
  // on the case, but the guard is keyed on the batch id the CLIENT sends. A
  // fresh uuid per click would make it unreachable, so the retry after a
  // failure has to carry the key the failed attempt used.
  it("retries a failed macro with the same batch key so the server can refuse the replay", async () => {
    const api = {
      applyMacro: vi.fn()
        .mockRejectedValueOnce(new Error("network"))
        .mockResolvedValue({ macroId: "m1", caseCount: 2, actionsApplied: 4, actionsSkipped: 0 }),
      listMacros: vi.fn().mockResolvedValue([{ id: "m1", name: "Close with a note", active: true, actions: [{ kind: "add_note" }] }]),
    };
    render(<CaseBulkActions rows={ROWS} visibleIds={["c1", "c2"]} selection={["c1", "c2"]}
      onSelectionChange={() => {}} api={api} t={t} />);
    fireEvent.click(screen.getByRole("button", { name: t("caseBulk.macros") }));
    const apply = await screen.findByRole("button", { name: /Close with a note/ });
    fireEvent.click(apply);
    await waitFor(() => expect(api.applyMacro).toHaveBeenCalledTimes(1));
    fireEvent.click(apply);
    await waitFor(() => expect(api.applyMacro).toHaveBeenCalledTimes(2));
    const [first, second] = api.applyMacro.mock.calls;
    expect(second[2]).toBe(first[2]);
    expect(first[2]).toMatch(/^[0-9a-f-]{36}$/);
  });

  // UX-UG-WEB-CASE-BULK-MACRO-PANEL-BLANK-WHEN-ALL-RETIRED-AND-LOAD-UNANNOUNCED-20260920.
  // A list of only retired macros is not an empty list, so the "no macros yet"
  // hint never fired and the panel rendered nothing at all — indistinguishable
  // from a load that never finished.
  it("says every macro is retired instead of drawing an empty macro panel", async () => {
    const api = {
      applyMacro: vi.fn(),
      listMacros: vi.fn().mockResolvedValue([
        { id: "m1", name: "Close with a note", active: false, actions: [{ kind: "set_status", status: "resolved" }] },
        { id: "m2", name: "Retired", active: false, actions: [] },
      ]),
    };
    render(<CaseBulkActions rows={ROWS} visibleIds={["c1", "c2"]} selection={["c1", "c2"]}
      onSelectionChange={() => {}} api={api} t={t} />);
    fireEvent.click(screen.getByRole("button", { name: t("caseBulk.macros") }));
    const retired = await screen.findByText(t("caseBulk.macroAllRetired"));
    // Announced, not just drawn: the panel opens and fills asynchronously.
    expect(retired.getAttribute("role")).toBe("status");
    expect(screen.queryByText(t("caseBulk.macroEmpty"))).toBeNull();
    expect(screen.queryByRole("button", { name: /Close with a note/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Retired/ })).toBeNull();
    expect(api.applyMacro).not.toHaveBeenCalled();
  });

  // A macro saved before Union Ground dropped grievance steps may still
  // carry advance_step; the bar does not offer it until it is re-saved.
  it("does not offer an active macro that still carries an advance_step action", async () => {
    const api = {
      applyMacro: vi.fn().mockResolvedValue({ macroId: "m2", caseCount: 2, actionsApplied: 2, actionsSkipped: 0 }),
      listMacros: vi.fn().mockResolvedValue([
        { id: "m1", name: "Legacy step macro", active: true, actions: [{ kind: "add_note" }, { kind: "advance_step" }] },
        { id: "m2", name: "Close with a note", active: true, actions: [{ kind: "set_status", status: "resolved" }] },
      ]),
    };
    render(<CaseBulkActions rows={ROWS} visibleIds={["c1", "c2"]} selection={["c1", "c2"]}
      onSelectionChange={() => {}} api={api} t={t} />);
    fireEvent.click(screen.getByRole("button", { name: t("caseBulk.macros") }));
    expect(await screen.findByRole("button", { name: /Close with a note/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Legacy step macro/ })).toBeNull();
    expect(api.applyMacro).not.toHaveBeenCalled();
  });

  it("announces the macro load while the list is still in flight", async () => {
    let release;
    const api = {
      applyMacro: vi.fn(),
      listMacros: vi.fn().mockReturnValue(new Promise((resolve) => { release = resolve; })),
    };
    render(<CaseBulkActions rows={ROWS} visibleIds={["c1", "c2"]} selection={["c1", "c2"]}
      onSelectionChange={() => {}} api={api} t={t} />);
    fireEvent.click(screen.getByRole("button", { name: t("caseBulk.macros") }));
    const loading = await screen.findByText(t("caseBulk.macroLoading"));
    expect(loading.getAttribute("role")).toBe("status");
    release([{ id: "m1", name: "Escalate to Step 1", active: true, actions: [{ kind: "add_note" }] }]);
    expect(await screen.findByRole("button", { name: /Escalate to Step 1/ })).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(t("caseBulk.macroLoading"))).toBeNull());
  });

  // BUG-UG-CASE-BULK-ASSIGN-ROSTER-FROM-STALE-SELECTION-20260920. The
  // roster was loaded once from chosen[0] behind a candidates.length === 0
  // gate that nothing reset, so a mixed-chapter batch saw the first case's
  // stewards and a selection change kept offering them until assign_member_case
  // refused with a raw 23514. The picker must track the CURRENT selection.
  describe("bulk assign roster tracks the current selection", () => {
    const CH_ROWS = [
      { ...ROWS[0], id: "c1", chapterId: "ch-1" },
      { ...ROWS[1], id: "c2", chapterId: "ch-2" },
    ];
    // Ana is scoped to chapter 1's case; Ben is acceptable to both chapters.
    const ROSTERS = {
      c1: [
        { userId: "u-ana", fullName: "Ana Ruiz", roles: ["steward"] },
        { userId: "u-ben", fullName: "Ben Cho", roles: ["steward", "coordinator"] },
      ],
      c2: [
        { userId: "u-ben", fullName: "Ben Cho", roles: ["steward", "coordinator"] },
      ],
    };
    const assignApi = () => ({
      assignCase: vi.fn().mockResolvedValue({}),
      loadAssignmentCandidates: vi.fn((id) => Promise.resolve(ROSTERS[id] || [])),
    });

    it("closes the Assign panel on a selection change and reopens on the new case's roster only", async () => {
      const api = assignApi();
      const view = render(<CaseBulkActions rows={CH_ROWS} visibleIds={["c1", "c2"]} selection={["c1"]}
        onSelectionChange={() => {}} api={api} t={t} />);
      fireEvent.click(screen.getByRole("button", { name: t("caseBulk.assign") }));
      const c1Roster = await screen.findByLabelText(t("coordinator.assignmentSteward"));
      expect(within(c1Roster).getByRole("option", { name: "Ana Ruiz" })).toBeInTheDocument();

      // The selection moves to c2: nothing loaded for c1 may stay offered or
      // submittable — the panel is closed, not left holding c1's roster.
      view.rerender(<CaseBulkActions rows={CH_ROWS} visibleIds={["c1", "c2"]} selection={["c2"]}
        onSelectionChange={() => {}} api={api} t={t} />);
      expect(screen.queryByLabelText(t("coordinator.assignmentSteward"))).toBeNull();
      expect(screen.queryByRole("option", { name: "Ana Ruiz" })).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: t("caseBulk.assign") }));
      const c2Roster = await screen.findByLabelText(t("coordinator.assignmentSteward"));
      expect(within(c2Roster).getByRole("option", { name: "Ben Cho" })).toBeInTheDocument();
      expect(within(c2Roster).queryByRole("option", { name: "Ana Ruiz" })).toBeNull();
    });

    it("offers only the intersection across a mixed-chapter selection and loads every chosen case", async () => {
      const api = assignApi();
      render(<CaseBulkActions rows={CH_ROWS} visibleIds={["c1", "c2"]} selection={["c1", "c2"]}
        onSelectionChange={() => {}} api={api} t={t} />);
      fireEvent.click(screen.getByRole("button", { name: t("caseBulk.assign") }));
      const stewardSelect = await screen.findByLabelText(t("coordinator.assignmentSteward"));
      // Ana would be refused for c2 with 23514 "steward is outside case scope
      // or lacks role"; a person any selected case refuses is never offered.
      expect(within(stewardSelect).getByRole("option", { name: "Ben Cho" })).toBeInTheDocument();
      expect(within(stewardSelect).queryByRole("option", { name: "Ana Ruiz" })).toBeNull();
      // The roster was built from EVERY chosen case, not only chosen[0].
      expect(api.loadAssignmentCandidates).toHaveBeenCalledWith("c1");
      expect(api.loadAssignmentCandidates).toHaveBeenCalledWith("c2");
    });

    // Codex round 1 on  (P1): sharing a user id across rosters is not
    // enough. When the rosters disagree on the person's roles, only the roles
    // EVERY roster grants may be offered, or the write is refused per case
    // with 23514 after the batch has partly landed.
    it("offers a shared person only in the roles every selected case grants them", async () => {
      const api = {
        assignCase: vi.fn().mockResolvedValue({}),
        loadAssignmentCandidates: vi.fn((id) => Promise.resolve(id === "c1"
          ? [{ userId: "u-ben", fullName: "Ben Cho", roles: ["steward", "coordinator"] }]
          : [{ userId: "u-ben", fullName: "Ben Cho", roles: ["coordinator"] }])),
      };
      render(<CaseBulkActions rows={CH_ROWS} visibleIds={["c1", "c2"]} selection={["c1", "c2"]}
        onSelectionChange={() => {}} api={api} t={t} />);
      fireEvent.click(screen.getByRole("button", { name: t("caseBulk.assign") }));
      // c2 grants Ben only coordinator: steward would be refused for c2.
      const stewardSelect = await screen.findByLabelText(t("coordinator.assignmentSteward"));
      expect(within(stewardSelect).queryByRole("option", { name: "Ben Cho" })).toBeNull();
      const coordinatorSelect = screen.getByLabelText(t("coordinator.assignmentCoordinator"));
      expect(within(coordinatorSelect).getByRole("option", { name: "Ben Cho" })).toBeInTheDocument();
    });

    // Codex round 1 on  (P2): a fully successful run writes its ledger
    // and then clears the selection; the ledger is the product of that run and
    // must survive the clear, not vanish with the picker state.
    it("keeps the success ledger after the run itself clears the selection", async () => {
      const api = { addCaseNote: vi.fn().mockResolvedValue({}) };
      const Stateful = () => {
        const [selection, setSelection] = useState(["c1", "c2"]);
        return <CaseBulkActions rows={ROWS} visibleIds={["c1", "c2"]} selection={selection}
          onSelectionChange={setSelection} api={api} t={t} />;
      };
      render(<Stateful />);
      fireEvent.click(screen.getByRole("button", { name: t("caseBulk.addNote") }));
      fireEvent.change(await screen.findByRole("textbox"), { target: { value: "Filed." } });
      fireEvent.click(screen.getByRole("button", { name: t("caseBulk.applyToCount", { count: 2 }) }));
      const ledger = t("caseBulk.resultSummary", { done: 2, total: 2 });
      expect(await screen.findByText(ledger)).toBeTruthy();
      // The selection was cleared by the run itself, and the ledger it just
      // wrote is still the visible confirmation.
      expect(screen.queryByText(t("caseBulk.selected", { count: 2 }))).toBeNull();
      expect(screen.getByText(ledger)).toBeTruthy();
    });

    // Codex/ (P2): the Assign roster is not on the
    // desk row. Closing and reopening with the same ids must reload and
    // re-intersect, or a person who lost the steward role for one selected
    // case stays offered and a later submit can update the other cases
    // before 23514 refuses the revoked one.
    it("reloads the Assign roster on reopen after a same-id eligibility change", async () => {
      const rosters = {
        c1: [
          { userId: "u-ana", fullName: "Ana Ruiz", roles: ["steward"] },
          { userId: "u-ben", fullName: "Ben Cho", roles: ["steward", "coordinator"] },
        ],
        c2: [
          { userId: "u-ben", fullName: "Ben Cho", roles: ["steward", "coordinator"] },
        ],
      };
      const api = {
        assignCase: vi.fn().mockResolvedValue({}),
        loadAssignmentCandidates: vi.fn((id) => Promise.resolve(rosters[id] || [])),
      };
      render(<CaseBulkActions rows={CH_ROWS} visibleIds={["c1", "c2"]} selection={["c1", "c2"]}
        onSelectionChange={() => {}} api={api} t={t} />);
      fireEvent.click(screen.getByRole("button", { name: t("caseBulk.assign") }));
      const first = await screen.findByLabelText(t("coordinator.assignmentSteward"));
      expect(within(first).getByRole("option", { name: "Ben Cho" })).toBeInTheDocument();
      expect(api.loadAssignmentCandidates).toHaveBeenCalledTimes(2);

      fireEvent.click(screen.getByRole("button", { name: t("caseBulk.assign") }));
      expect(screen.queryByLabelText(t("coordinator.assignmentSteward"))).toBeNull();

      rosters.c2 = [{ userId: "u-ben", fullName: "Ben Cho", roles: ["coordinator"] }];
      fireEvent.click(screen.getByRole("button", { name: t("caseBulk.assign") }));
      await screen.findByRole("option", { name: "Ben Cho" });
      expect(within(screen.getByLabelText(t("coordinator.assignmentSteward"))).queryByRole("option", { name: "Ben Cho" })).toBeNull();
      expect(within(screen.getByLabelText(t("coordinator.assignmentCoordinator"))).getByRole("option", { name: "Ben Cho" })).toBeInTheDocument();
      expect(api.loadAssignmentCandidates).toHaveBeenCalledTimes(4);
      expect(api.loadAssignmentCandidates).toHaveBeenNthCalledWith(3, "c1");
      expect(api.loadAssignmentCandidates).toHaveBeenNthCalledWith(4, "c2");
    });

    // Codex/ (P1): opening Assign clears the roster and
    // starts one bounded read per selected case, but the form used to render
    // immediately with both selects on "Unassigned" and a live submit — a
    // confirm before the reads finished (or after one rejected) sent
    // { stewardId: null, coordinatorId: null } to every case, clearing
    // assignments that were never in view. Submission must wait for a
    // successful load of every roster.
    it("withholds assignment submission until every roster read has finished", async () => {
      const gates = {};
      const api = {
        assignCase: vi.fn().mockResolvedValue({}),
        loadAssignmentCandidates: vi.fn((id) => new Promise((resolve) => { gates[id] = resolve; })),
      };
      render(<CaseBulkActions rows={CH_ROWS} visibleIds={["c1", "c2"]} selection={["c1", "c2"]}
        onSelectionChange={() => {}} api={api} t={t} />);
      fireEvent.click(screen.getByRole("button", { name: t("caseBulk.assign") }));
      expect(await screen.findByText(t("caseBulk.candidatesLoading"))).toBeInTheDocument();
      const submit = screen.getByRole("button", { name: t("caseBulk.applyToCount", { count: 2 }) });
      expect(submit).toBeDisabled();
      expect(screen.getByLabelText(t("coordinator.assignmentSteward"))).toBeDisabled();
      expect(screen.getByLabelText(t("coordinator.assignmentCoordinator"))).toBeDisabled();
      expect(api.assignCase).not.toHaveBeenCalled();

      gates.c1(ROSTERS.c1);
      gates.c2(ROSTERS.c2);
      const stewardSelect = await screen.findByLabelText(t("coordinator.assignmentSteward"));
      expect(within(stewardSelect).getByRole("option", { name: "Ben Cho" })).toBeInTheDocument();
      // Loaded roster ungates the form; naming a role makes it submittable.
      await waitFor(() => expect(stewardSelect).toBeEnabled());
      fireEvent.change(stewardSelect, { target: { value: "u-ben" } });
      expect(screen.getByRole("button", { name: t("caseBulk.applyToCount", { count: 2 }) })).toBeEnabled();
    });

    it("keeps assignment unsubmittable after a roster read fails", async () => {
      const api = {
        assignCase: vi.fn().mockResolvedValue({}),
        loadAssignmentCandidates: vi.fn((id) => (id === "c1"
          ? Promise.resolve(ROSTERS.c1)
          : Promise.reject(new Error("network")))),
      };
      render(<CaseBulkActions rows={CH_ROWS} visibleIds={["c1", "c2"]} selection={["c1", "c2"]}
        onSelectionChange={() => {}} api={api} t={t} />);
      fireEvent.click(screen.getByRole("button", { name: t("caseBulk.assign") }));
      expect(await screen.findByText(t("caseBulk.candidateLoadFailed"))).toBeInTheDocument();
      expect(screen.getByRole("button", { name: t("caseBulk.applyToCount", { count: 2 }) })).toBeDisabled();
      expect(screen.getByLabelText(t("coordinator.assignmentSteward"))).toBeDisabled();
      expect(api.assignCase).not.toHaveBeenCalled();
    });

    // Codex/ (P2): the candidates RPC caps each case's
    // roster at 200 rows. When a case's page comes back AT the cap it may be
    // truncated, and a person past the cut there is indistinguishable from a
    // person the case would refuse — the count check would silently drop
    // someone every case accepts. A capped page in a multi-case selection is
    // refused outright, with the cap named, instead of being intersected.
    it("refuses the intersection when a roster hits the server page cap, naming the cap", async () => {
      const fullPage = Array.from({ length: 200 }, (_, index) => ({
        userId: `u-full-${index}`, fullName: `Page Person ${index}`, roles: ["steward"],
      }));
      // Ben is beyond the cut of c2's capped page even though c2 would accept
      // him; c1's page (also capped) carries him.
      const api = {
        assignCase: vi.fn().mockResolvedValue({}),
        loadAssignmentCandidates: vi.fn((id) => Promise.resolve(id === "c1"
          ? [{ userId: "u-ben", fullName: "Ben Cho", roles: ["steward"] }, ...fullPage].slice(0, 200)
          : fullPage)),
      };
      render(<CaseBulkActions rows={CH_ROWS} visibleIds={["c1", "c2"]} selection={["c1", "c2"]}
        onSelectionChange={() => {}} api={api} t={t} />);
      fireEvent.click(screen.getByRole("button", { name: t("caseBulk.assign") }));
      expect(await screen.findByText(t("caseBulk.candidateRosterCapped", { limit: 200 }))).toBeInTheDocument();
      const stewardSelect = screen.getByLabelText(t("coordinator.assignmentSteward"));
      expect(within(stewardSelect).queryByRole("option", { name: "Ben Cho" })).toBeNull();
      expect(screen.getByRole("button", { name: t("caseBulk.applyToCount", { count: 2 }) })).toBeDisabled();
      expect(api.assignCase).not.toHaveBeenCalled();
    });

    // The cap refusal is specific to combining pages: a single-case selection
    // keeps the dedicated case panel's behaviour (the same capped RPC, server
    // still validating the write), so a full page there stays submittable.
    it("still offers a single-case roster that reaches the page cap", async () => {
      const fullPage = Array.from({ length: 200 }, (_, index) => ({
        userId: `u-full-${index}`, fullName: `Page Person ${index}`, roles: ["steward"],
      }));
      const api = {
        assignCase: vi.fn().mockResolvedValue({}),
        loadAssignmentCandidates: vi.fn(() => Promise.resolve(fullPage)),
      };
      render(<CaseBulkActions rows={CH_ROWS} visibleIds={["c1"]} selection={["c1"]}
        onSelectionChange={() => {}} api={api} t={t} />);
      fireEvent.click(screen.getByRole("button", { name: t("caseBulk.assign") }));
      const stewardSelect = await screen.findByLabelText(t("coordinator.assignmentSteward"));
      expect(within(stewardSelect).getByRole("option", { name: "Page Person 0" })).toBeInTheDocument();
      fireEvent.change(stewardSelect, { target: { value: "u-full-0" } });
      expect(screen.getByRole("button", { name: t("caseBulk.applyToCount", { count: 1 }) })).toBeEnabled();
      expect(screen.queryByText(t("caseBulk.candidateRosterCapped", { limit: 200 }))).toBeNull();
    });
  });

  // The ledger sentence is "{done} of {total} issues updated." — the bar used
  // to hand it the failure count, so the total rendered as an empty string.
  it("names the batch total in the result ledger, not the failure count", async () => {
    const api = { addCaseNote: vi.fn().mockResolvedValue({}) };
    render(<CaseBulkActions rows={ROWS} visibleIds={["c1", "c2"]} selection={["c1", "c2"]}
      onSelectionChange={() => {}} api={api} t={t} />);
    fireEvent.click(screen.getByRole("button", { name: t("caseBulk.addNote") }));
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "Filed." } });
    fireEvent.click(screen.getByRole("button", { name: t("caseBulk.applyToCount", { count: 2 }) }));
    expect(await screen.findByText(t("caseBulk.resultSummary", { done: 2, total: 2 }))).toBeTruthy();
    expect(screen.queryByText(/of {2}cases/)).toBeNull();
  });

  // BUG-UG-CASE-BULK-ASSIGN-CLEARS-UNTOUCHED-ROLE-20260920. Both selects
  // defaulted to a blank "Unassigned" option that mapped to null, and
  // assign_member_case writes both columns from its arguments — so a batch
  // that named only a steward silently cleared the coordinator on every
  // selected case. The panel is a three-state contract now: the default
  // leaves the role untouched, a named person writes it, and only the
  // explicitly labelled clear option sends a null.
  describe("bulk assign never touches the role the coordinator did not name", () => {
    const ROSTER = [
      { userId: "u-ana", fullName: "Ana Ruiz", roles: ["steward"] },
      { userId: "u-ben", fullName: "Ben Cho", roles: ["steward", "coordinator"] },
      { userId: "u-cyd", fullName: "Cyd Vance", roles: ["coordinator"] },
    ];
    // Coordinator-queue rows carry the current assignees; the steward
    // caseload rows (second fixture set) carry no assignee ids at all.
    const DESK_ROWS = [
      { ...ROWS[0], id: "c1", stewardUserId: "u-ana", stewardName: "Ana Ruiz", coordinatorUserId: "u-cyd", coordinatorName: "Cyd Vance" },
      { ...ROWS[1], id: "c2", stewardUserId: "u-ana", stewardName: "Ana Ruiz", coordinatorUserId: "u-cyd", coordinatorName: "Cyd Vance" },
    ];
    const STEWARD_DESK_ROWS = [ROWS[0], ROWS[1]];
    const assignApi = () => ({
      assignCase: vi.fn().mockResolvedValue({}),
      loadAssignmentCandidates: vi.fn().mockResolvedValue(ROSTER),
    });

    const openAssign = async (api, rows, selection = ["c1", "c2"]) => {
      const view = render(<CaseBulkActions rows={rows} visibleIds={rows.map((row) => row.id)} selection={selection}
        onSelectionChange={() => {}} api={api} t={t} />);
      fireEvent.click(screen.getByRole("button", { name: t("caseBulk.assign") }));
      await screen.findByLabelText(t("coordinator.assignmentSteward"));
      return view;
    };

    const submitAssign = async (container, count = 2) => {
      fireEvent.click(container.querySelector(".case-bulk__confirm input[type='checkbox']"));
      fireEvent.click(screen.getByRole("button", { name: t("caseBulk.applyToCount", { count }) }));
    };

    it("opens on leave-unchanged with an explicit clear option, and states what the submission writes", async () => {
      const api = assignApi();
      await openAssign(api, DESK_ROWS);
      const stewardSelect = screen.getByLabelText(t("coordinator.assignmentSteward"));
      await within(stewardSelect).findByRole("option", { name: "Ben Cho" });
      // The default names a non-action, not "Unassigned".
      expect(within(stewardSelect).getByRole("option", { name: t("caseBulk.assignLeaveUnchanged") })).toBeTruthy();
      expect(within(stewardSelect).getByRole("option", { name: t("caseBulk.assignClearRole") })).toBeTruthy();
      expect(within(stewardSelect).queryByRole("option", { name: t("coordinator.assignmentUnassigned") })).toBeNull();
      expect(stewardSelect).toHaveValue("");

      // Naming a steward only: the summary names the person, the role, and the
      // case count, and warns that whoever currently holds the role is replaced.
      fireEvent.change(stewardSelect, { target: { value: "u-ben" } });
      const roles = `Ben Cho (${t("coordinator.assignmentSteward")})`;
      expect(screen.getByText(t("caseBulk.assignSummary", { roles, count: 2 }))).toBeTruthy();
      expect(screen.getByText(t("caseBulk.assignConfirm", { roles, count: 2 }))).toBeTruthy();
    });

    it("never carries a null for the untouched role when rows carry both assignees", async () => {
      const api = assignApi();
      const { container } = await openAssign(api, DESK_ROWS);
      fireEvent.change(screen.getByLabelText(t("coordinator.assignmentSteward")), { target: { value: "u-ben" } });
      await submitAssign(container);
      await waitFor(() => expect(api.assignCase).toHaveBeenCalledTimes(2));
      for (const [caseId, assignment] of api.assignCase.mock.calls) {
        expect(assignment.stewardId).toBe("u-ben");
        // The role the coordinator never named travels as the server's
        // leave-unchanged sentinel — never null, which would clear it.
        expect(assignment.coordinatorId).toBe(ASSIGN_LEAVE_UNCHANGED);
        expect(assignment.coordinatorId).not.toBeNull();
        expect(["c1", "c2"]).toContain(caseId);
      }
    });

    it("never carries a null for the untouched role on steward-caseload rows with no assignee ids", async () => {
      const api = assignApi();
      const { container } = await openAssign(api, STEWARD_DESK_ROWS);
      fireEvent.change(screen.getByLabelText(t("coordinator.assignmentCoordinator")), { target: { value: "u-cyd" } });
      await submitAssign(container);
      await waitFor(() => expect(api.assignCase).toHaveBeenCalledTimes(2));
      for (const [, assignment] of api.assignCase.mock.calls) {
        expect(assignment.coordinatorId).toBe("u-cyd");
        expect(assignment.stewardId).toBe(ASSIGN_LEAVE_UNCHANGED);
        expect(assignment.stewardId).not.toBeNull();
      }
    });

    it("clears a role only through the explicitly labelled clear option", async () => {
      const api = assignApi();
      const { container } = await openAssign(api, DESK_ROWS);
      const coordinatorSelect = screen.getByLabelText(t("coordinator.assignmentCoordinator"));
      await within(coordinatorSelect).findByRole("option", { name: "Cyd Vance" });
      fireEvent.change(coordinatorSelect, { target: { value: "__clear__" } });
      const roles = t("coordinator.assignmentCoordinator");
      expect(screen.getByText(t("caseBulk.assignSummary", { roles, count: 2 }))).toBeTruthy();
      await submitAssign(container);
      await waitFor(() => expect(api.assignCase).toHaveBeenCalledTimes(2));
      for (const [, assignment] of api.assignCase.mock.calls) {
        expect(assignment.coordinatorId).toBeNull();
        expect(assignment.stewardId).toBe(ASSIGN_LEAVE_UNCHANGED);
      }
    });

    it("refuses to submit when no role is named", async () => {
      const api = assignApi();
      await openAssign(api, DESK_ROWS);
      expect(screen.getByText(t("caseBulk.assignNothing"))).toBeTruthy();
      expect(screen.getByRole("button", { name: t("caseBulk.applyToCount", { count: 2 }) })).toBeDisabled();
      expect(api.assignCase).not.toHaveBeenCalled();
    });

    it("ships every new bulk-assign string in English and Spanish", () => {
      for (const key of ["caseBulk.assignLeaveUnchanged", "caseBulk.assignClearRole", "caseBulk.assignNothing", "caseBulk.assignSummary", "caseBulk.assignConfirm"]) {
        expect(catalogue.en[key]).toBeTruthy();
        expect(catalogue.es[key]).toBeTruthy();
        expect(catalogue.es[key]).not.toBe(catalogue.en[key]);
      }
      // The confirmation names how many cases and what is being replaced.
      expect(catalogue.en["caseBulk.assignConfirm"]).toContain("{count}");
      expect(catalogue.en["caseBulk.assignConfirm"]).toContain("{roles}");
      expect(catalogue.en["caseBulk.assignConfirm"]).not.toContain("this case.");
    });

    it("pins the forward migration's leave-unchanged predicate and the DB contract entry", () => {
      const sql = loadMigrationSql("case_bulk_assign_leave_unchanged");
      const body = fnBody(sql, "assign_member_case");
      // The live entry gates (case graph outer, message lifecycle inner) stay
      // ahead of every authorization read and the row lock.
      expect(body).toMatch(/as \$\$\s*begin\s+perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);\s+begin\s+perform private\.lock_message_lifecycle\(\);\s+declare\b/);
      expect(body).toContain("'00000000-0000-0000-0000-000000000000'::uuid");
      expect(body).toContain("new_steward := case when p_steward = unchanged then case_row.steward_user_id else p_steward end;");
      expect(body).toContain("new_coordinator := case when p_coordinator = unchanged then case_row.coordinator_user_id else p_coordinator end;");
      // Scope checks run only for a role that is actually being written.
      expect(body).toContain("if p_steward is not null and p_steward <> unchanged then");
      // An explicit null clears the stored display name with the user id;
      // only the leave-unchanged sentinel keeps the existing label.
      expect(body).toContain("elsif p_steward = unchanged then");
      expect(body).toContain("steward_label := case_row.steward_name;");
      expect(body).toContain("steward_label := null;");
      expect(body).toContain("elsif p_coordinator = unchanged then");
      expect(body).toContain("coordinator_label := null;");
      // The signature is unchanged: existing grants and callers keep working.
      expect(sql).not.toContain("drop function");

      const contract = JSON.parse(readFileSync(resolve(process.cwd(), "scripts/db-contract.json"), "utf8"));
      const entry = contract.functions.find((candidate) => candidate.sig === "public.assign_member_case(p_case_id uuid, p_steward uuid, p_coordinator uuid)");
      expect(entry.bodyContains).toContain("00000000-0000-0000-0000-000000000000");
      expect(entry.bodyContains).toContain("elsif p_steward = unchanged then");
      expect(entry.bodyContains).toContain("steward_label := null");
    });

    it("resets assignment intent when the selected batch is emptied with Assign still open", async () => {
      const api = assignApi();
      const view = await openAssign(api, DESK_ROWS);
      fireEvent.change(screen.getByLabelText(t("coordinator.assignmentSteward")), { target: { value: "u-ben" } });
      expect(screen.getByLabelText(t("coordinator.assignmentSteward"))).toHaveValue("u-ben");

      // Clearing the selection hides the form without changing `panel`. A
      // later batch must not inherit Ben, and submit stays disabled until a
      // role is named again.
      view.rerender(<CaseBulkActions rows={DESK_ROWS} visibleIds={["c1", "c2"]} selection={[]}
        onSelectionChange={() => {}} api={api} t={t} />);
      expect(screen.queryByLabelText(t("coordinator.assignmentSteward"))).toBeNull();

      view.rerender(<CaseBulkActions rows={DESK_ROWS} visibleIds={["c1", "c2"]} selection={["c1"]}
        onSelectionChange={() => {}} api={api} t={t} />);
      // A selection change closes the panel; reopening it starts clean.
      fireEvent.click(screen.getByRole("button", { name: t("caseBulk.assign") }));
      const stewardSelect = await screen.findByLabelText(t("coordinator.assignmentSteward"));
      expect(stewardSelect).toHaveValue("");
      expect(screen.getByRole("button", { name: t("caseBulk.applyToCount", { count: 1 }) })).toBeDisabled();
      expect(api.assignCase).not.toHaveBeenCalled();
    });
  });
});

// The export cases replace global URL with a plain object so createObjectURL
// can be observed. vi.restoreAllMocks does not undo vi.stubGlobal, and this
// project's Vitest config leaves unstubGlobals off, so that object used to
// survive the test — including a failing one — and the next `new URL` threw
// "is not a constructor".
describe("URL global stub cleanup", () => {
  const expectNativeCaseUrl = () => {
    expect(URL).toBe(nativeURL);
    const parsed = new URL("https://unionground.example/cases/GR-1?ref=1");
    expect(parsed).toBeInstanceOf(nativeURL);
    expect(parsed.pathname).toBe("/cases/GR-1");
    expect(parsed.searchParams.get("ref")).toBe("1");
    const objectUrl = URL.createObjectURL(new Blob(["case"]));
    expect(objectUrl).not.toBe("blob:x");
    expect(objectUrl.startsWith("blob:")).toBe(true);
    URL.revokeObjectURL(objectUrl);
  };

  it("receives the native constructible URL after the export stubs", () => {
    expectNativeCaseUrl();
  });

  // it.fails inverts the result: the body must throw, and afterEach still
  // runs. Returning normally would mean the leak fixture never installed.
  it.fails("installs the non-constructible export URL stub and then fails", () => {
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:x", revokeObjectURL: () => {} });
    if (typeof URL === "function") return;
    throw new Error("planned failure while the URL stub is installed");
  });

  it("restores the native constructible URL after a stubbing test fails", () => {
    expectNativeCaseUrl();
  });
});

// BUG-UG-WEB-CASE-BULK-LEDGER-SHOWS-RAW-POSTGRES-MESSAGES-20260920. Every
// routine behind this bar raises a MemberApiError, whose message is composed
// as "<English label>: <driver text>", so a catch that preferred
// `cause.message` painted an internal routine name and a Postgres sentence
// into the ledger for every coordinator, in every language. What is pinned
// here is that no failure path can do that again, in either locale.
describe("a refused bulk action explains itself in the coordinator's language", () => {
  const CHECK = "23514";
  const DENIED = "42501";
  const CONFLICT = "40001";
  const DRIVER = {
    [CHECK]: 'new row for relation "casework_cases" violates check constraint "cases_step_valid"',
    [DENIED]: "permission denied for table casework_cases",
    [CONFLICT]: "could not serialize access due to concurrent update",
  };
  const KEY = {
    [CHECK]: "rpcError.checkViolation",
    [DENIED]: "rpcError.notPermitted",
    [CONFLICT]: "rpcError.conflict",
  };
  const LABELS = /Update cases|Assign case|Add case note|Advance case step|Apply macro|Record case export/;

  // MemberApiError's own shape (src/lib/memberApi.js): the English label and
  // the driver sentence fused into `message`, with the machine-readable
  // fields carried alongside rather than instead of it.
  const refusal = (label, code) => Object.assign(new Error(`${label}: ${DRIVER[code]}`), {
    name: "MemberApiError", label, code, details: null, hint: null,
  });

  const translatorFor = (lang) => (key, vars = {}) => {
    const value = catalogue[lang][key];
    if (value === undefined) throw new Error(`missing ${lang} key: ${key}`);
    return value.replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ""));
  };

  // The console is not an escape hatch: a CHECK refusal can quote the row
  // that failed it, and a coordinator's console is not a place for case data.
  const quietConsole = () => {
    const seen = [];
    for (const channel of ["error", "warn", "log", "info", "debug"]) {
      vi.spyOn(console, channel).mockImplementation((...args) => { seen.push(args.map(String).join(" ")); });
    }
    return seen;
  };

  const assertSealed = (logged, code) => {
    const shown = document.body.textContent;
    expect(shown).not.toContain(DRIVER[code]);
    expect(shown).not.toContain(code);
    expect(shown).not.toMatch(LABELS);
    expect(logged.join("\n")).not.toContain(DRIVER[code]);
    expect(logged.join("\n")).not.toMatch(LABELS);
  };

  const expectReported = (resource, code) => expect(captureSanitizedDiagnostic).toHaveBeenCalledWith({
    kind: "case_bulk_action_failure", resource, code, name: "MemberApiError",
  });

  beforeEach(() => { captureSanitizedDiagnostic.mockClear(); });

  it.each(["en", "es"])("%s: a refused batch status change reads the catalogue, not the driver", async (lang) => {
    const translate = translatorFor(lang);
    const logged = quietConsole();
    const api = { bulkUpdateCases: vi.fn().mockRejectedValue(refusal("Update cases", DENIED)) };
    render(<CaseBulkActions rows={ROWS} visibleIds={["c1", "c2"]} selection={["c1", "c2"]}
      onSelectionChange={() => {}} api={api} t={translate} />);
    fireEvent.click(screen.getByRole("button", { name: translate("caseBulk.setStatus") }));
    fireEvent.click(screen.getByRole("button", { name: translate("caseBulk.applyToCount", { count: 2 }) }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(translate(KEY[DENIED])));
    assertSealed(logged, DENIED);
    expectReported("batch_status", DENIED);
  });

  it.each(["en", "es"])("%s: a refused assign names every case in catalogue copy", async (lang) => {
    const translate = translatorFor(lang);
    const logged = quietConsole();
    const api = {
      assignCase: vi.fn().mockRejectedValue(refusal("Assign case", CHECK)),
      loadAssignmentCandidates: vi.fn().mockResolvedValue([
        { userId: "u-ben", fullName: "Ben Cho", roles: ["steward"] },
      ]),
    };
    const { container } = render(<CaseBulkActions rows={ROWS} visibleIds={["c1", "c2"]} selection={["c1", "c2"]}
      onSelectionChange={() => {}} api={api} t={translate} />);
    fireEvent.click(screen.getByRole("button", { name: translate("caseBulk.assign") }));
    const stewardSelect = await screen.findByLabelText(translate("coordinator.assignmentSteward"));
    await within(stewardSelect).findByRole("option", { name: "Ben Cho" });
    fireEvent.change(stewardSelect, { target: { value: "u-ben" } });
    fireEvent.click(container.querySelector(".case-bulk__confirm input[type='checkbox']"));
    fireEvent.click(screen.getByRole("button", { name: translate("caseBulk.applyToCount", { count: 2 }) }));
    await waitFor(() => expect(api.assignCase).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(ledgerRows()).toEqual([
      `GR-1 — ${translate(KEY[CHECK])}`,
      `GR-2 — ${translate(KEY[CHECK])}`,
    ]));
    assertSealed(logged, CHECK);
    expectReported("assign", CHECK);
  });

  it.each(["en", "es"])("%s: a refused note reads the catalogue conflict sentence", async (lang) => {
    const translate = translatorFor(lang);
    const logged = quietConsole();
    const api = { addCaseNote: vi.fn().mockRejectedValue(refusal("Add issue note", CONFLICT)) };
    render(<CaseBulkActions rows={ROWS} visibleIds={["c1"]} selection={["c1"]}
      onSelectionChange={() => {}} api={api} t={translate} />);
    fireEvent.click(screen.getByRole("button", { name: translate("caseBulk.addNote") }));
    fireEvent.change(screen.getByLabelText(translate("caseNotes.staffNoteLabel")), { target: { value: "Checked in" } });
    fireEvent.click(screen.getByRole("button", { name: translate("caseBulk.applyToCount", { count: 1 }) }));
    await waitFor(() => expect(ledgerRows()).toEqual([`GR-1 — ${translate(KEY[CONFLICT])}`]));
    assertSealed(logged, CONFLICT);
    expectReported("note", CONFLICT);
  });

  it.each(["en", "es"])("%s: a refused macro reads the catalogue, not the refused table", async (lang) => {
    const translate = translatorFor(lang);
    const logged = quietConsole();
    const api = {
      applyMacro: vi.fn().mockRejectedValue(refusal("Apply macro", DENIED)),
      listMacros: vi.fn().mockResolvedValue([{ id: "m1", name: "Escalate", active: true, actions: [{ kind: "add_note" }] }]),
    };
    render(<CaseBulkActions rows={ROWS} visibleIds={["c1", "c2"]} selection={["c1", "c2"]}
      onSelectionChange={() => {}} api={api} t={translate} />);
    fireEvent.click(screen.getByRole("button", { name: translate("caseBulk.macros") }));
    fireEvent.click(await screen.findByRole("button", { name: /Escalate/ }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(translate(KEY[DENIED])));
    assertSealed(logged, DENIED);
    expectReported("macro", DENIED);
  });

  it.each(["en", "es"])("%s: a refused export receipt reads the catalogue and downloads nothing", async (lang) => {
    const translate = translatorFor(lang);
    const logged = quietConsole();
    const downloads = [];
    vi.spyOn(document, "createElement").mockImplementation((tag) => {
      const node = Document.prototype.createElement.call(document, tag);
      if (tag === "a") node.click = () => { downloads.push("download"); };
      return node;
    });
    vi.stubGlobal("URL", { ...URL, createObjectURL: () => "blob:x", revokeObjectURL: () => {} });
    const api = { recordCaseExport: vi.fn().mockRejectedValue(refusal("Record case export", DENIED)) };
    render(<CaseBulkActions rows={ROWS} visibleIds={["c1", "c2", "c3"]} selection={[]}
      onSelectionChange={() => {}} api={api} t={translate} exportPrefix="coordinator-cases" />);
    fireEvent.click(screen.getByRole("button", { name: translate("caseBulk.exportVisible", { count: 3 }) }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(translate(KEY[DENIED])));
    expect(downloads).toEqual([]);
    assertSealed(logged, DENIED);
    expectReported("export_receipt", DENIED);
  });

  it("gives the three refusal families distinct copy in both locales", () => {
    for (const key of Object.values(KEY)) {
      expect(typeof catalogue.en[key], `${key} en missing`).toBe("string");
      expect(typeof catalogue.es[key], `${key} es missing`).toBe("string");
      expect(catalogue.es[key]).not.toBe(catalogue.en[key]);
    }
    expect(new Set(Object.values(KEY).map((key) => catalogue.en[key])).size).toBe(3);
  });
});
