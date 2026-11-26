import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

import { ChapterCatalogWorkspace, ChapterRail } from "../src/components/ChapterRail.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { applyDeviceParityState, clearDeviceParityState, deviceParityValue } from "../src/lib/deviceParity.js";
import { registerEscapeLayer } from "../src/lib/escapeLayers.js";
import { normalizeLiveChapters } from "../src/lib/chapterRail.js";
import { writeChapterRailExpandedByDefault } from "../src/lib/chapterRailPreference.js";
import { labelInNameMismatches } from "./helpers/labelInName.js";

const liveChapter = {
  id: "wor",
  name: "Harborview Care United",
  abbreviation: "WD",
  category: null,
  memberCount: null,
  staffCount: null,
};

const sampleChapters = [
  { id: "ma-dcf", name: "North County Transit Workers", abbreviation: "DCF", category: "Massachusetts", memberCount: 812, staffCount: 6 },
  { id: "ma-dmh", name: "Lakeside Library Workers", abbreviation: "DMH", category: "Massachusetts", memberCount: 436, staffCount: 4 },
  { id: "ma-dta", name: "Eastgate Warehouse Workers", abbreviation: "DTA", category: "Massachusetts", memberCount: 291, staffCount: 3 },
];

function renderRail(props = {}, lang = "en") {
  return render(
    <LanguageProvider lang={lang}>
      <ChapterRail chapters={[liveChapter]} selectedId="wor" onSelect={() => {}} memberId="member-1" {...props} />
    </LanguageProvider>,
  );
}

const LIVE_EXPANDED_KEY = "sg:member:member-1:chapter-rail:expanded-by-default";
const DEMO_EXPANDED_KEY = "sg:demo:chapter-rail:expanded-by-default";

// The rail opens collapsed by default (#6989). Most cases below exercise the
// expanded rail, so they start from a member who keeps it expanded; the
// default-state cases clear these first.
beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.localStorage.setItem(LIVE_EXPANDED_KEY, "true");
  window.sessionStorage.setItem(DEMO_EXPANDED_KEY, "true");
});

afterEach(() => {
  vi.useRealTimers();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe("ChapterRail", () => {
  it.each(["en", "es"])("names each %s chapter choice with its visible name and counts (WCAG 2.5.3)", (lang) => {
    renderRail({ chapters: sampleChapters, selectedId: "ma-dmh", demo: true, memberId: null }, lang);
    const choices = document.querySelectorAll(".chapter-rail__choice");
    expect(choices).toHaveLength(3);
    expect(labelInNameMismatches(choices)).toEqual([]);
    expect(choices[0].querySelector(".chapter-rail__abbr")).toHaveAttribute("data-glyph");
  });

  it("shows the latest twenty catalog activities and keeps the archive available", () => {
    const activity = Array.from({ length: 22 }, (_, i) => ({ id: `a-${i}`, title: `Activity ${i}`,
      occurredAt: `2026-08-${String(i + 1).padStart(2, "0")}T12:00:00Z`, dateLabel: `Aug ${i + 1}`, body: "Campaign update" }));
    const before = [...activity];
    const { container } = render(<LanguageProvider lang="en"><ChapterCatalogWorkspace
      chapter={{ ...sampleChapters[0], landing: { activity } }} onClose={vi.fn()} />
    </LanguageProvider>);
    expect(screen.getAllByRole("article")).toHaveLength(20);
    expect(container.querySelector("article")).toHaveTextContent("Activity 21");
    expect(screen.queryByText("Activity 0")).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: "Show all (22)" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    toggle.focus();
    fireEvent.click(toggle);
    expect(screen.getAllByRole("article")).toHaveLength(22);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(toggle);
    expect(screen.getAllByRole("article")).toHaveLength(20);
    expect(toggle).toHaveFocus();
    expect(activity).toEqual(before);
  });

  it("does not render decorative corner arcs on the chapter rail", () => {
    const { container } = renderRail();
    expect(screen.getByRole("navigation", { name: "Campaigns" })).toBeInTheDocument();
    expect(container.querySelector(".chapter-rail__seam")).toBeNull();
    const css = readFileSync("src/styles.css", "utf8");
    expect(css).not.toMatch(/\.chapter-rail__seam\b|--chapter-rail-corner\b/);
  });
  it("renders a fully seeded chapter landing with private-safe activity and shared resources", () => {
    const chapter = {
      ...sampleChapters[0],
      landing: {
        summary: "North County Transit Workers has four years of aggregate activity ready to explore.",
        activitySummary: { openCases: 18, upcomingEvents: 4, turnoutPercent: 76 },
        activity: [
          { id: "a-1", title: "Chapter meeting recap shared", body: "Decisions and aggregate follow-ups.", dateLabel: "Aug 13" },
          { id: "a-2", title: "Bargaining briefing published", body: "Priorities and next-session questions.", dateLabel: "Aug 6" },
        ],
        sharedResources: [
          { id: "r-1", title: "Statewide bargaining calendar", description: "Dates for every participating chapter.", updatedLabel: "Aug 20" },
        ],
      },
    };
    const onClose = vi.fn();
    render(
      <LanguageProvider lang="en">
        <ChapterCatalogWorkspace chapter={chapter} onClose={onClose} />
      </LanguageProvider>,
    );
    expect(screen.getByRole("heading", { level: 1, name: "North County Transit Workers" })).toBeInTheDocument();
    expect(screen.getAllByRole("article")).toHaveLength(3);
    expect(screen.getByText("Shared across campaigns")).toBeInTheDocument();
    expect(screen.queryByText(/sample/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Return to current workspace" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("renders an honest live chapter and an honest empty state without SAMPLE leakage", () => {
    const { rerender } = renderRail();
    const rail = screen.getByRole("navigation", { name: "Campaigns" });
    const selectedChoice = within(rail).getByRole("button", { name: /^Open Harborview Care United\b/ });
    expect(selectedChoice).toHaveAttribute("aria-pressed", "true");
    expect(selectedChoice).not.toHaveAttribute("aria-current");
    expect(rail).not.toHaveTextContent("SAMPLE");
    expect(rail).not.toHaveTextContent("workers");

    rerender(
      <LanguageProvider lang="en">
        <ChapterRail chapters={[]} selectedId={null} onSelect={() => {}} memberId="member-1" />
      </LanguageProvider>,
    );
    expect(screen.getByText("No campaign is attached to your participation.")).toBeInTheDocument();
  });

  it("renders backed counts without labeling fictional chapter names", () => {
    renderRail({ chapters: sampleChapters, selectedId: "ma-dcf", demo: true, memberId: null });
    const rail = screen.getByRole("navigation", { name: "Campaigns" });
    expect(within(rail).queryByText("PREVIEW")).not.toBeInTheDocument();
    expect(within(rail).getByText("812 workers · 6 staff")).toBeInTheDocument();
    expect(within(rail).getByText("436 workers · 4 staff")).toBeInTheDocument();
  });

  // BUG-UG-CHAPTER-ROLES-HIDDEN-UNTIL-CHAPTER-SWITCH-20261003: a
  // member of two chapters sees and can find both, not "No chapters match".
  it("lists a live member's other chapter under Your campaigns, finds it by filter and selects it", () => {
    const chapters = normalizeLiveChapters({
      chapterId: "hb-local",
      chapterName: "Harrow Bay Local",
      chapterMemberships: [
        { chapterId: "hb-local", name: "Harrow Bay Local", selected: true },
        { chapterId: "hb-hhs", name: "Health and Human Services", selected: false },
      ],
    });
    const onSelect = vi.fn();
    renderRail({ chapters, selectedId: "hb-local", onSelect });
    expect(screen.getByRole("heading", { name: "Your campaigns" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Current campaign" })).toBeNull();
    expect(screen.getByRole("button", { name: /^Open Harrow Bay Local\b/ })).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter campaigns" }), { target: { value: "Health" } });
    expect(screen.queryByText(/No campaigns match/)).toBeNull();
    const hhs = screen.getByRole("button", { name: /^Open Health and Human Services\b/ });
    expect(hhs).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(hhs);
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "hb-hhs" }), hhs);
  });

  it("keeps the Your campaigns heading when a filter or a pin leaves one membership, and ignores choices while switching", () => {
    const chapters = normalizeLiveChapters({
      chapterId: "hb-local",
      chapterName: "Harrow Bay Local",
      chapterMemberships: [{ chapterId: "hb-hhs", name: "Health and Human Services", selected: false }],
    });
    const onSelect = vi.fn();
    renderRail({ chapters, selectedId: "hb-local", onSelect, busy: true });
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter campaigns" }), { target: { value: "Health" } });
    expect(screen.getByRole("heading", { name: "Your campaigns" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Current campaign" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Open Health and Human Services\b/ }));
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter campaigns" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Pin Harrow Bay Local" }));
    expect(screen.getByRole("heading", { name: "Your campaigns" })).toBeInTheDocument();
  });

  it("filters by name or abbreviation and Escape clears the filter before collapsing", async () => {
    renderRail({ chapters: sampleChapters, selectedId: "ma-dcf", demo: true, memberId: null });
    const filter = screen.getByRole("searchbox", { name: "Filter campaigns" });
    fireEvent.change(filter, { target: { value: "DMH" } });
    expect(screen.getByRole("button", { name: /^Open Lakeside Library Workers\b/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Open North County Transit Workers\b/ })).toBeNull();

    fireEvent.keyDown(filter, { key: "Escape" });
    expect(filter).toHaveValue("");
    expect(screen.getByRole("button", { name: /^Open North County Transit Workers\b/ })).toBeInTheDocument();

    fireEvent.keyDown(filter, { key: "Escape" });
    expect(screen.getByRole("navigation", { name: "Campaigns" })).toHaveAttribute("data-collapsed", "true");
    await waitFor(() => expect(screen.getByRole("button", { name: "Expand campaigns" })).toHaveFocus());
  });

  it("uses roving Arrow, Home, and End focus across visible chapter choices", () => {
    renderRail({ chapters: sampleChapters, selectedId: "ma-dcf", demo: true, memberId: null });
    const dcf = screen.getByRole("button", { name: /^Open North County Transit Workers\b/ });
    const dmh = screen.getByRole("button", { name: /^Open Lakeside Library Workers\b/ });
    const dta = screen.getByRole("button", { name: /^Open Eastgate Warehouse Workers\b/ });
    expect([dcf.tabIndex, dmh.tabIndex, dta.tabIndex]).toEqual([0, -1, -1]);

    dcf.focus();
    fireEvent.keyDown(dcf, { key: "ArrowDown" });
    expect(dmh).toHaveFocus();
    fireEvent.keyDown(dmh, { key: "End" });
    expect(dta).toHaveFocus();
    fireEvent.keyDown(dta, { key: "Home" });
    expect(dcf).toHaveFocus();
    fireEvent.keyDown(dcf, { key: "ArrowUp" });
    expect(dta).toHaveFocus();
  });

  it("selects chapters and preserves focus while pinning each chapter at most once", async () => {
    const onSelect = vi.fn();
    renderRail({ chapters: sampleChapters, selectedId: "ma-dcf", demo: true, memberId: null, onSelect });
    const dmhChoice = screen.getByRole("button", { name: /^Open Lakeside Library Workers\b/ });
    fireEvent.click(dmhChoice);
    expect(onSelect).toHaveBeenCalledWith(sampleChapters[1], dmhChoice);

    const pin = screen.getByRole("button", { name: "Pin Lakeside Library Workers" });
    pin.focus();
    fireEvent.click(pin);
    expect(screen.getAllByRole("button", { name: /^Open Lakeside Library Workers\b/ })).toHaveLength(1);
    const unpin = screen.getByRole("button", { name: "Unpin Lakeside Library Workers" });
    expect(unpin).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(unpin).toHaveFocus());
    fireEvent.click(unpin);
    expect(screen.getAllByRole("button", { name: /^Open Lakeside Library Workers\b/ })).toHaveLength(1);
    await waitFor(() => expect(screen.getByRole("button", { name: "Pin Lakeside Library Workers" })).toHaveFocus());
  });

  it("exposes a focus tooltip in collapsed mode and keeps the in-rail collapse to this visit", () => {
    const { unmount } = renderRail();
    fireEvent.click(screen.getByRole("button", { name: "Collapse campaigns" }));
    const choice = screen.getByRole("button", { name: /^Open Harborview Care United\b/ });
    const tooltip = screen.getByRole("tooltip", { hidden: true });
    expect(choice).toHaveAttribute("aria-describedby", tooltip.id);
    expect(tooltip).toHaveTextContent("Harborview Care United");
    expect(window.localStorage.getItem(LIVE_EXPANDED_KEY)).toBe("true");
    unmount();

    renderRail();
    expect(screen.getByRole("navigation", { name: "Campaigns" })).toHaveAttribute("data-collapsed", "false");
  });

  it("opens collapsed for a member with no preference, live and demo", () => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    const { unmount } = renderRail();
    expect(screen.getByRole("navigation", { name: "Campaigns" })).toHaveAttribute("data-collapsed", "true");
    expect(screen.getByRole("button", { name: "Expand campaigns" })).toBeInTheDocument();
    unmount();

    renderRail({ chapters: sampleChapters, selectedId: "ma-dcf", demo: true, memberId: null });
    expect(screen.getByRole("navigation", { name: "Campaigns" })).toHaveAttribute("data-collapsed", "true");
  });

  it("ignores the retired last-state key and opens expanded only with the member's preference", () => {
    window.localStorage.clear();
    window.localStorage.setItem("sg:member:member-1:chapter-rail:collapsed", "false");
    window.localStorage.setItem("sg:member:other:chapter-rail:expanded-by-default", "true");
    const { unmount } = renderRail();
    expect(screen.getByRole("navigation", { name: "Campaigns" })).toHaveAttribute("data-collapsed", "true");
    unmount();

    window.localStorage.setItem(LIVE_EXPANDED_KEY, "true");
    renderRail();
    expect(screen.getByRole("navigation", { name: "Campaigns" })).toHaveAttribute("data-collapsed", "false");
  });

  it("expands for this visit without changing the default for later loads", () => {
    window.localStorage.clear();
    const { unmount } = renderRail();
    fireEvent.click(screen.getByRole("button", { name: "Expand campaigns" }));
    expect(screen.getByRole("navigation", { name: "Campaigns" })).toHaveAttribute("data-collapsed", "false");
    expect(window.localStorage.length).toBe(0);
    unmount();

    renderRail();
    expect(screen.getByRole("navigation", { name: "Campaigns" })).toHaveAttribute("data-collapsed", "true");
  });

  it("applies a changed preference to the mounted rail at once, for its own member only", () => {
    window.localStorage.clear();
    renderRail();
    const rail = screen.getByRole("navigation", { name: "Campaigns" });
    act(() => writeChapterRailExpandedByDefault({ memberId: "other", demo: false }, true));
    expect(rail).toHaveAttribute("data-collapsed", "true");
    act(() => writeChapterRailExpandedByDefault({ memberId: "member-1", demo: false }, true));
    expect(rail).toHaveAttribute("data-collapsed", "false");
    expect(window.localStorage.getItem(LIVE_EXPANDED_KEY)).toBe("true");
    fireEvent.change(screen.getByRole("searchbox", { name: "Filter campaigns" }), { target: { value: "Wor" } });
    act(() => writeChapterRailExpandedByDefault({ memberId: "member-1", demo: false }, false));
    expect(rail).toHaveAttribute("data-collapsed", "true");
    expect(window.localStorage.getItem(LIVE_EXPANDED_KEY)).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Expand campaigns" }));
    expect(screen.getByRole("searchbox", { name: "Filter campaigns" })).toHaveValue("");
  });

  it("keeps a collapsed tooltip open across the pointer transfer from its chapter onto the popup [en/es]", () => {
    for (const [lang, collapse, open, chapterName] of [
      ["en", "Collapse campaigns", /^Open Lakeside Library Workers\b/, "Lakeside Library Workers"],
      ["es", "Contraer campañas", /^Abrir Lakeside Library Workers\b/, "Lakeside Library Workers"],
    ]) {
      vi.useFakeTimers();
      const view = renderRail({ chapters: sampleChapters, selectedId: "ma-dmh", demo: true, memberId: null }, lang);
      fireEvent.click(screen.getByRole("button", { name: collapse }));
      const choice = screen.getByRole("button", { name: open });
      const tooltip = document.getElementById(choice.getAttribute("aria-describedby"));
      expect(tooltip).toHaveTextContent(chapterName);
      expect(tooltip).not.toHaveAttribute("data-visible");

      fireEvent.mouseEnter(choice);
      expect(tooltip).toHaveAttribute("data-visible", "true");
      fireEvent.mouseLeave(choice, { relatedTarget: tooltip });
      fireEvent.mouseEnter(tooltip, { relatedTarget: choice });
      act(() => { vi.advanceTimersByTime(1000); });
      expect(tooltip).toHaveAttribute("data-visible", "true");

      fireEvent.mouseLeave(tooltip, { relatedTarget: choice });
      fireEvent.mouseEnter(choice, { relatedTarget: tooltip });
      act(() => { vi.advanceTimersByTime(1000); });
      expect(tooltip).toHaveAttribute("data-visible", "true");

      fireEvent.mouseLeave(choice, { relatedTarget: document.body });
      expect(tooltip).toHaveAttribute("data-visible", "true");
      act(() => { vi.advanceTimersByTime(1000); });
      expect(tooltip).not.toHaveAttribute("data-visible");
      view.unmount();
      vi.useRealTimers();
      window.sessionStorage.clear();
      window.sessionStorage.setItem(DEMO_EXPANDED_KEY, "true");
    }
  });

  it("dismisses a focused collapsed tooltip on Escape without moving focus, selecting, or reaching window listeners", () => {
    vi.useFakeTimers();
    const onSelect = vi.fn();
    const windowEscape = vi.fn();
    window.addEventListener("keydown", windowEscape);
    try {
      renderRail({ chapters: sampleChapters, selectedId: "ma-dmh", demo: true, memberId: null, onSelect });
      fireEvent.click(screen.getByRole("button", { name: "Collapse campaigns" }));
      const choice = screen.getByRole("button", { name: /^Open Lakeside Library Workers\b/ });
      const tooltip = document.getElementById(choice.getAttribute("aria-describedby"));
      // jsdom has no keyboard modality; a real browser proves :focus-visible
      // in e2e/p10-rail-tooltip-interactions.spec.js.
      const matches = choice.matches.bind(choice);
      vi.spyOn(choice, "matches").mockImplementation((selector) => selector === ":focus-visible" || matches(selector));
      act(() => { choice.focus(); });
      expect(tooltip).toHaveAttribute("data-visible", "true");

      fireEvent.keyDown(choice, { key: "Escape" });
      expect(tooltip).not.toHaveAttribute("data-visible");
      expect(choice).toHaveFocus();
      expect(onSelect).not.toHaveBeenCalled();
      expect(windowEscape).not.toHaveBeenCalled();

      fireEvent.mouseEnter(choice);
      expect(tooltip).toHaveAttribute("data-visible", "true");
      fireEvent.keyDown(choice, { key: "Escape" });
      fireEvent.mouseLeave(choice, { relatedTarget: document.body });
      act(() => { vi.advanceTimersByTime(1000); });
      expect(tooltip).not.toHaveAttribute("data-visible");
      expect(choice).toHaveFocus();

      fireEvent.mouseEnter(choice);
      expect(tooltip).toHaveAttribute("data-visible", "true");

      // Escape with no tooltip showing is not consumed.
      fireEvent.keyDown(choice, { key: "Escape" });
      fireEvent.keyDown(choice, { key: "Escape" });
      expect(windowEscape).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", windowEscape);
    }
  });

  it("dismisses a hovered collapsed tooltip on Escape from elsewhere and ignores other chapters' blur", () => {
    vi.useFakeTimers();
    renderRail({ chapters: sampleChapters, selectedId: "ma-dmh", demo: true, memberId: null });
    fireEvent.click(screen.getByRole("button", { name: "Collapse campaigns" }));
    const dmh = screen.getByRole("button", { name: /^Open Lakeside Library Workers\b/ });
    const dcf = screen.getByRole("button", { name: /^Open North County Transit Workers\b/ });
    const tooltip = document.getElementById(dmh.getAttribute("aria-describedby"));
    act(() => { dcf.focus(); });

    fireEvent.mouseEnter(dmh);
    expect(tooltip).toHaveAttribute("data-visible", "true");
    expect(fireEvent.keyDown(document.body, { key: "Escape" })).toBe(false);
    expect(tooltip).not.toHaveAttribute("data-visible");
    expect(dcf).toHaveFocus();
    // Nothing visible: the next Escape is not consumed.
    expect(fireEvent.keyDown(document.body, { key: "Escape" })).toBe(true);

    // DCF's blur inside DMH's close delay must not cancel DMH's close.
    fireEvent.mouseLeave(dmh, { relatedTarget: document.body });
    fireEvent.mouseEnter(dmh);
    fireEvent.mouseLeave(dmh, { relatedTarget: document.body });
    act(() => { dcf.blur(); });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(tooltip).not.toHaveAttribute("data-visible");
  });

  it("keeps an Escape-dismissed focused chapter hidden after the pointer visits another chapter", () => {
    vi.useFakeTimers();
    renderRail({ chapters: sampleChapters, selectedId: "ma-dmh", demo: true, memberId: null });
    fireEvent.click(screen.getByRole("button", { name: "Collapse campaigns" }));
    const dcf = screen.getByRole("button", { name: /^Open North County Transit Workers\b/ });
    const dmh = screen.getByRole("button", { name: /^Open Lakeside Library Workers\b/ });
    const dcfTooltip = document.getElementById(dcf.getAttribute("aria-describedby"));
    const matches = dcf.matches.bind(dcf);
    vi.spyOn(dcf, "matches").mockImplementation((selector) => selector === ":focus-visible" || matches(selector));
    act(() => { dcf.focus(); });
    fireEvent.keyDown(dcf, { key: "Escape" });
    expect(dcfTooltip).not.toHaveAttribute("data-visible");

    fireEvent.mouseEnter(dmh);
    fireEvent.mouseLeave(dmh, { relatedTarget: document.body });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(dcfTooltip).not.toHaveAttribute("data-visible");
  });

  it("returns the tooltip to the keyboard-focused chapter after the pointer leaves another chapter", () => {
    vi.useFakeTimers();
    renderRail({ chapters: sampleChapters, selectedId: "ma-dmh", demo: true, memberId: null });
    fireEvent.click(screen.getByRole("button", { name: "Collapse campaigns" }));
    const dcf = screen.getByRole("button", { name: /^Open North County Transit Workers\b/ });
    const dmh = screen.getByRole("button", { name: /^Open Lakeside Library Workers\b/ });
    const dcfTooltip = document.getElementById(dcf.getAttribute("aria-describedby"));
    const dmhTooltip = document.getElementById(dmh.getAttribute("aria-describedby"));
    const matches = dcf.matches.bind(dcf);
    vi.spyOn(dcf, "matches").mockImplementation((selector) => selector === ":focus-visible" || matches(selector));
    act(() => { dcf.focus(); });
    expect(dcfTooltip).toHaveAttribute("data-visible", "true");

    fireEvent.mouseEnter(dmh);
    expect(dmhTooltip).toHaveAttribute("data-visible", "true");
    expect(dcfTooltip).not.toHaveAttribute("data-visible");
    fireEvent.mouseLeave(dmh, { relatedTarget: document.body });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(dmhTooltip).not.toHaveAttribute("data-visible");
    expect(dcfTooltip).toHaveAttribute("data-visible", "true");
  });

  it("after Escape dismisses a hovered chapter, gives the tooltip back to a different focused chapter but never to a dismissed one", () => {
    vi.useFakeTimers();
    renderRail({ chapters: sampleChapters, selectedId: "ma-dmh", demo: true, memberId: null });
    fireEvent.click(screen.getByRole("button", { name: "Collapse campaigns" }));
    const dcf = screen.getByRole("button", { name: /^Open North County Transit Workers\b/ });
    const dmh = screen.getByRole("button", { name: /^Open Lakeside Library Workers\b/ });
    const dcfTooltip = document.getElementById(dcf.getAttribute("aria-describedby"));
    const dmhTooltip = document.getElementById(dmh.getAttribute("aria-describedby"));
    for (const choice of [dcf, dmh]) {
      const matches = choice.matches.bind(choice);
      vi.spyOn(choice, "matches").mockImplementation((selector) => (
        selector === ":focus-visible" ? document.activeElement === choice : matches(selector)
      ));
    }

    // A different chapter (DCF) holds keyboard focus: it gets its tooltip back.
    act(() => { dcf.focus(); });
    fireEvent.mouseEnter(dmh);
    expect(dmhTooltip).toHaveAttribute("data-visible", "true");
    fireEvent.keyDown(dcf, { key: "Escape" });
    expect(dmhTooltip).not.toHaveAttribute("data-visible");
    expect(dcfTooltip).not.toHaveAttribute("data-visible");
    fireEvent.mouseLeave(dmh, { relatedTarget: document.body });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(dmhTooltip).not.toHaveAttribute("data-visible");
    expect(dcfTooltip).toHaveAttribute("data-visible", "true");
    expect(dcf).toHaveFocus();

    // Escape inside the close delay after the pointer already left DMH
    // still gives the focused chapter its tooltip back.
    fireEvent.mouseEnter(dmh);
    expect(dmhTooltip).toHaveAttribute("data-visible", "true");
    fireEvent.mouseLeave(dmh, { relatedTarget: document.body });
    fireEvent.keyDown(dcf, { key: "Escape" });
    expect(dmhTooltip).not.toHaveAttribute("data-visible");
    act(() => { vi.advanceTimersByTime(1000); });
    expect(dcfTooltip).toHaveAttribute("data-visible", "true");

    // A capture listener that already answered Escape keeps it: the focused
    // chapter's tooltip stays.
    const claimEscape = (event) => { if (event.key === "Escape") event.preventDefault(); };
    window.addEventListener("keydown", claimEscape, true);
    fireEvent.keyDown(dcf, { key: "Escape" });
    window.removeEventListener("keydown", claimEscape, true);
    expect(dcfTooltip).toHaveAttribute("data-visible", "true");

    // The focused chapter is the dismissed one (DMH): it stays dismissed.
    act(() => { dmh.focus(); });
    fireEvent.mouseEnter(dmh);
    expect(dmhTooltip).toHaveAttribute("data-visible", "true");
    fireEvent.keyDown(dmh, { key: "Escape" });
    fireEvent.mouseLeave(dmh, { relatedTarget: document.body });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(dmhTooltip).not.toHaveAttribute("data-visible");
    expect(dcfTooltip).not.toHaveAttribute("data-visible");
    expect(dmh).toHaveFocus();

    // Every dismissal is kept: dismissing DMH after DCF never revives DCF.
    act(() => { dcf.focus(); });
    expect(dcfTooltip).toHaveAttribute("data-visible", "true");
    fireEvent.keyDown(dcf, { key: "Escape" });
    fireEvent.mouseEnter(dmh);
    fireEvent.keyDown(dcf, { key: "Escape" });
    fireEvent.mouseLeave(dmh, { relatedTarget: document.body });
    act(() => { vi.advanceTimersByTime(1000); });
    const dta = screen.getByRole("button", { name: /^Open Eastgate Warehouse Workers\b/ });
    fireEvent.mouseEnter(dta);
    fireEvent.mouseLeave(dta, { relatedTarget: document.body });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(dcfTooltip).not.toHaveAttribute("data-visible");
    expect(dmhTooltip).not.toHaveAttribute("data-visible");
    expect(dcf).toHaveFocus();
  });

  it("leaves a hovered collapsed tooltip up while the Tasks keymap's Escape exits focus mode, in either listener order", () => {
    // Shaped like the TasksView window keymap: it skips typing surfaces and
    // exits focus mode on an Escape nobody prevented, without preventing it.
    const tasksKeymap = (event) => {
      if (event.defaultPrevented || event.key !== "Escape") return;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(event.target?.tagName)) return;
      if (deviceParityValue("tasks.focusWorkstream")) applyDeviceParityState("tasks.focusWorkstream", null);
    };
    for (const keymapFirst of [true, false]) {
      // Whichever window listener is installed first runs first.
      const unregisterEarlier = keymapFirst ? () => {} : registerEscapeLayer(() => {});
      window.addEventListener("keydown", tasksKeymap);
      const field = document.createElement("input");
      document.body.append(field);
      const view = renderRail({ chapters: sampleChapters, selectedId: "ma-dmh", demo: true, memberId: null });
      try {
        applyDeviceParityState("tasks.focusWorkstream", "Organizing");
        fireEvent.click(screen.getByRole("button", { name: "Collapse campaigns" }));
        const dmh = screen.getByRole("button", { name: /^Open Lakeside Library Workers\b/ });
        const tooltip = document.getElementById(dmh.getAttribute("aria-describedby"));
        fireEvent.mouseEnter(dmh);
        expect(tooltip).toHaveAttribute("data-visible", "true");

        expect(fireEvent.keyDown(document.body, { key: "Escape" })).toBe(true);
        expect(deviceParityValue("tasks.focusWorkstream")).toBeNull();
        expect(tooltip).toHaveAttribute("data-visible", "true");

        expect(fireEvent.keyDown(document.body, { key: "Escape" })).toBe(false);
        expect(tooltip).not.toHaveAttribute("data-visible");

        // In a typing field the Tasks keymap skips the press, so the tooltip takes it.
        applyDeviceParityState("tasks.focusWorkstream", "Organizing");
        fireEvent.mouseLeave(dmh, { relatedTarget: document.body });
        fireEvent.mouseEnter(dmh);
        expect(tooltip).toHaveAttribute("data-visible", "true");
        expect(fireEvent.keyDown(field, { key: "Escape" })).toBe(false);
        expect(tooltip).not.toHaveAttribute("data-visible");
        expect(deviceParityValue("tasks.focusWorkstream")).toBe("Organizing");
      } finally {
        view.unmount();
        window.removeEventListener("keydown", tasksKeymap);
        field.remove();
        unregisterEarlier();
        clearDeviceParityState();
        window.sessionStorage.clear();
        window.sessionStorage.setItem(DEMO_EXPANDED_KEY, "true");
      }
    }
  });

  it("leaves a hovered collapsed tooltip up while a mounted Tasks board popover takes the Escape", () => {
    // An earlier non-modal layer (Compass) installs the shared listener first,
    // so the tooltip layer would run before the popover's own window listener,
    // which closes on Escape and ignores defaultPrevented (TasksView Popover).
    const unregisterCompass = registerEscapeLayer(() => {});
    const popover = document.createElement("div");
    popover.className = "kan-popover";
    const closePopover = vi.fn(() => popover.remove());
    const popoverEscape = (event) => { if (event.key === "Escape") closePopover(); };
    try {
      renderRail({ chapters: sampleChapters, selectedId: "ma-dmh", demo: true, memberId: null });
      fireEvent.click(screen.getByRole("button", { name: "Collapse campaigns" }));
      const dmh = screen.getByRole("button", { name: /^Open Lakeside Library Workers\b/ });
      const tooltip = document.getElementById(dmh.getAttribute("aria-describedby"));
      document.body.append(popover);
      window.addEventListener("keydown", popoverEscape);
      fireEvent.mouseEnter(dmh);
      expect(tooltip).toHaveAttribute("data-visible", "true");

      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(closePopover).toHaveBeenCalledTimes(1);
      expect(tooltip).toHaveAttribute("data-visible", "true");

      // With the popover gone, the next press is the tooltip's.
      expect(fireEvent.keyDown(document.body, { key: "Escape" })).toBe(false);
      expect(tooltip).not.toHaveAttribute("data-visible");
    } finally {
      window.removeEventListener("keydown", popoverEscape);
      popover.remove();
      unregisterCompass();
    }
  });

  it("keeps the tooltip of a chapter the pointer still rests on after keyboard focus leaves the rail", () => {
    vi.useFakeTimers();
    renderRail({ chapters: sampleChapters, selectedId: "ma-dmh", demo: true, memberId: null });
    fireEvent.click(screen.getByRole("button", { name: "Collapse campaigns" }));
    const dcf = screen.getByRole("button", { name: /^Open North County Transit Workers\b/ });
    const dmh = screen.getByRole("button", { name: /^Open Lakeside Library Workers\b/ });
    const dta = screen.getByRole("button", { name: /^Open Eastgate Warehouse Workers\b/ });
    for (const choice of [dcf, dmh, dta]) {
      const matches = choice.matches.bind(choice);
      vi.spyOn(choice, "matches").mockImplementation((selector) => (
        selector === ":focus-visible" ? document.activeElement === choice : matches(selector)
      ));
    }
    const dmhTooltip = document.getElementById(dmh.getAttribute("aria-describedby"));
    const dtaTooltip = document.getElementById(dta.getAttribute("aria-describedby"));
    act(() => { dcf.focus(); });
    fireEvent.mouseEnter(dmh);
    expect(dmhTooltip).toHaveAttribute("data-visible", "true");

    fireEvent.keyDown(dcf, { key: "ArrowDown" });
    expect(dta).toHaveFocus();
    expect(dtaTooltip).toHaveAttribute("data-visible", "true");
    act(() => { dta.blur(); });
    act(() => { vi.advanceTimersByTime(1000); });
    expect(dtaTooltip).not.toHaveAttribute("data-visible");
    expect(dmhTooltip).toHaveAttribute("data-visible", "true");
  });

  it("hides a collapsed tooltip whose chapter scrolls out of the list and follows it back", () => {
    renderRail({ chapters: sampleChapters, selectedId: "ma-dmh", demo: true, memberId: null });
    fireEvent.click(screen.getByRole("button", { name: "Collapse campaigns" }));
    const dmh = screen.getByRole("button", { name: /^Open Lakeside Library Workers\b/ });
    const tooltip = document.getElementById(dmh.getAttribute("aria-describedby"));
    const list = dmh.closest(".chapter-rail__list");
    const box = (top) => ({ top, bottom: top + 44, left: 0, right: 44, width: 44, height: 44, x: 0, y: top, toJSON: () => ({}) });
    vi.spyOn(list, "getBoundingClientRect").mockReturnValue({ ...box(60), bottom: 400, height: 340 });
    const choiceRect = vi.spyOn(dmh, "getBoundingClientRect").mockReturnValue(box(100));

    fireEvent.mouseEnter(dmh);
    expect(tooltip).toHaveAttribute("data-visible", "true");
    expect(tooltip).toHaveStyle({ left: "46px", top: "122px" });

    choiceRect.mockReturnValue(box(10));
    fireEvent.scroll(list);
    expect(tooltip).not.toHaveAttribute("data-visible");
    // A popup hidden out of view does not consume Escape.
    expect(fireEvent.keyDown(document.body, { key: "Escape" })).toBe(true);

    choiceRect.mockReturnValue(box(200));
    fireEvent.scroll(list);
    expect(tooltip).toHaveAttribute("data-visible", "true");
    expect(tooltip).toHaveStyle({ left: "46px", top: "222px" });
  });

  it("clears a pending tooltip close on expansion and unmount so it cannot change a later rail", () => {
    vi.useFakeTimers();
    const setTimer = vi.spyOn(globalThis, "setTimeout");
    const clearTimer = vi.spyOn(globalThis, "clearTimeout");
    const view = renderRail({ chapters: sampleChapters, selectedId: "ma-dmh", demo: true, memberId: null });
    fireEvent.click(screen.getByRole("button", { name: "Collapse campaigns" }));
    const choice = screen.getByRole("button", { name: /^Open Lakeside Library Workers\b/ });
    fireEvent.mouseEnter(choice);
    fireEvent.mouseLeave(choice, { relatedTarget: document.body });
    const expansionTimer = setTimer.mock.results.at(-1).value;

    fireEvent.click(screen.getByRole("button", { name: "Expand campaigns" }));
    expect(clearTimer).toHaveBeenCalledWith(expansionTimer);
    expect(screen.queryByRole("tooltip", { hidden: true })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Collapse campaigns" }));
    const recollapsed = screen.getByRole("button", { name: /^Open Lakeside Library Workers\b/ });
    const tooltip = document.getElementById(recollapsed.getAttribute("aria-describedby"));
    expect(tooltip).not.toHaveAttribute("data-visible");
    fireEvent.mouseEnter(recollapsed);
    fireEvent.mouseLeave(recollapsed, { relatedTarget: document.body });
    const unmountTimer = setTimer.mock.results.at(-1).value;
    view.unmount();
    expect(clearTimer).toHaveBeenCalledWith(unmountTimer);
  });

  it("puts the active chapter first in the collapsed stack", () => {
    renderRail({ chapters: sampleChapters, selectedId: "ma-dmh", demo: true, memberId: null });
    fireEvent.click(screen.getByRole("button", { name: "Collapse campaigns" }));
    const choices = screen.getAllByRole("button", { name: /^Open/ });
    expect(choices.map((choice) => choice.getAttribute("aria-label"))).toEqual([
      "Open Lakeside Library Workers, 436 workers · 4 staff",
      "Open North County Transit Workers, 812 workers · 6 staff",
      "Open Eastgate Warehouse Workers, 291 workers · 3 staff",
    ]);
  });

  it("clears a hidden filter before collapsing and derives the active-first stack from every chapter", () => {
    renderRail({ chapters: sampleChapters, selectedId: "ma-dcf", demo: true, memberId: null });
    const filter = screen.getByRole("searchbox", { name: "Filter campaigns" });
    fireEvent.change(filter, { target: { value: "DMH" } });
    fireEvent.click(screen.getByRole("button", { name: "Collapse campaigns" }));

    const choices = screen.getAllByRole("button", { name: /^Open/ });
    expect(choices.map((choice) => choice.getAttribute("aria-label"))).toEqual([
      "Open North County Transit Workers, 812 workers · 6 staff",
      "Open Lakeside Library Workers, 436 workers · 4 staff",
      "Open Eastgate Warehouse Workers, 291 workers · 3 staff",
    ]);
    expect(choices[0]).toHaveAttribute("aria-pressed", "true");
    expect(choices.slice(1).map((choice) => choice.getAttribute("aria-pressed"))).toEqual(["false", "false"]);
    expect(choices.filter((choice) => choice.hasAttribute("aria-current"))).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Expand campaigns" }));
    expect(screen.getByRole("searchbox", { name: "Filter campaigns" })).toHaveValue("");
  });

  it("keeps the demo preference and pins in session storage, never local storage", () => {
    window.localStorage.clear();
    window.localStorage.setItem("unrelated-preference", "keep-me");
    window.sessionStorage.clear();
    const demoRail = { chapters: sampleChapters, selectedId: "ma-dcf", demo: true, memberId: null };
    const { unmount } = renderRail(demoRail);
    expect(screen.getByRole("navigation", { name: "Campaigns" })).toHaveAttribute("data-collapsed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Expand campaigns" }));
    fireEvent.click(screen.getByRole("button", { name: "Pin Lakeside Library Workers" }));
    act(() => writeChapterRailExpandedByDefault({ memberId: null, demo: true }, true));
    expect(window.localStorage.getItem(LIVE_EXPANDED_KEY)).toBeNull();
    expect(window.localStorage.getItem(DEMO_EXPANDED_KEY)).toBeNull();
    expect(window.localStorage.getItem("sg:demo:chapter-rail:pins")).toBeNull();
    expect(window.localStorage.getItem("unrelated-preference")).toBe("keep-me");
    expect(window.sessionStorage.getItem(DEMO_EXPANDED_KEY)).toBe("true");
    expect(JSON.parse(window.sessionStorage.getItem("sg:demo:chapter-rail:pins"))).toEqual(["ma-dmh"]);
    unmount();

    renderRail(demoRail);
    expect(screen.getByRole("navigation", { name: "Campaigns" })).toHaveAttribute("data-collapsed", "false");
    expect(screen.getByRole("button", { name: "Unpin Lakeside Library Workers" })).toBeInTheDocument();
  });

  it("deduplicates and restricts untrusted persisted demo pin IDs to current chapters", async () => {
    window.sessionStorage.setItem(
      "sg:demo:chapter-rail:pins",
      JSON.stringify(["ma-dcf", "ma-dcf", "unknown", 4, "ma-dmh", "unknown"]),
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    renderRail({ chapters: sampleChapters, selectedId: "ma-dcf", demo: true, memberId: null });

    expect(screen.getAllByRole("button", { name: /^Open North County Transit Workers\b/ })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /^Open Lakeside Library Workers\b/ })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Unpin North County Transit Workers" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unpin Lakeside Library Workers" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pin Eastgate Warehouse Workers" })).toBeInTheDocument();
    await waitFor(() => {
      expect(JSON.parse(window.sessionStorage.getItem("sg:demo:chapter-rail:pins"))).toEqual(["ma-dcf", "ma-dmh"]);
    });
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("provides complete Spanish controls and empty-state copy", () => {
    renderRail({ chapters: [], selectedId: null }, "es");
    expect(screen.getByRole("navigation", { name: "Campañas" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Contraer campañas" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Filtrar campañas" })).toBeInTheDocument();
    expect(screen.getByText("Ninguna campaña está asociada con tu participación.")).toBeInTheDocument();
  });

  it("keeps fictional chapter names unlabeled in Spanish demo rows", () => {
    renderRail({ chapters: sampleChapters, selectedId: "ma-dcf", demo: true, memberId: null }, "es");
    expect(screen.getByRole("navigation", { name: "Campañas" })).toBeInTheDocument();
    expect(screen.queryByText("VISTA PREVIA")).not.toBeInTheDocument();
  });
});
