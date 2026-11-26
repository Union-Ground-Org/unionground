import { describe, expect, it, vi } from "vitest";

import {
  chapterAbbreviation,
  normalizeDemoChapters,
  normalizeLiveChapters,
  normalizeSampleChapters,
  createLiveChapterSelector,
  selectLiveChapter,
  withDistinctAbbreviations,
} from "../src/lib/chapterRail.js";

describe("chapter rail adapters", () => {
  it("derives compact abbreviations from chapter names", () => {
    expect(chapterAbbreviation("Dept. of Mental Health")).toBe("DMH");
    expect(chapterAbbreviation("North County Transit Workers")).toBe("NCT");
    expect(chapterAbbreviation("Harborview Care United")).toBe("HCU");
    expect(chapterAbbreviation("  ")).toBe("");
  });

  it("gives every chapter in one rail its own glyph", () => {
    const names = ["Cedar Ridge Care Services", "DCF Springfield", "DMH Southeast", "DTA Springfield", "DCF Worcester", "DTA Worcester", "Springfield Office", "Southern Office", "DCF Chapter"];
    const chapters = normalizeDemoChapters(names.map((name, index) => ({ id: `c${index}`, name })));
    expect(chapters.map((chapter) => chapter.abbreviation)).toEqual(["CRC", "DCFS", "DMHS", "DTAS", "DCFW", "DTAW", "SO", "SO2", "DCF"]);
    expect(new Set(chapters.map((chapter) => chapter.abbreviation)).size).toBe(names.length);
    // A glyph nobody else shows keeps its short form.
    expect(withDistinctAbbreviations([{ id: "a", name: "DCF Springfield", abbreviation: "DS" }])[0].abbreviation).toBe("DS");
    // An acronym with no second word cannot grow, so the repeat is numbered;
    // a blank glyph stays blank rather than becoming "2".
    expect(withDistinctAbbreviations([
      { id: "a", name: "DCF", abbreviation: "DCF" },
      { id: "b", name: "DCF Chapter", abbreviation: "DCF" },
      { id: "c", name: "--", abbreviation: "" },
      { id: "d", name: "..", abbreviation: "" },
    ]).map((chapter) => chapter.abbreviation)).toEqual(["DCF", "DCF2", "", ""]);
    expect(normalizeDemoChapters(null)).toEqual([]);
    expect(normalizeLiveChapters({ chapterId: "DMH" })[0]).toMatchObject({ name: "DMH", abbreviation: "DMH" });
  });

  it("normalizes the one live membership and rejects a blank chapter id", () => {
    expect(normalizeLiveChapters({ chapterId: " ", chapterName: "No id" })).toEqual([]);
    expect(normalizeLiveChapters({ chapterId: " wor ", chapterName: " Harborview Care United " })).toEqual([
      {
        id: "wor",
        name: "Harborview Care United",
        abbreviation: "HCU",
        category: null,
        memberCount: null,
        staffCount: null,
        landing: null,
      },
    ]);
  });

  // BUG-UG-CHAPTER-ROLES-HIDDEN-UNTIL-CHAPTER-SWITCH-20261003
  it("lists every chapter the member belongs to, the selected one first, without duplicates", () => {
    const member = {
      chapterId: "hb-local",
      chapterName: "Harrow Bay Local",
      chapterMemberships: [
        { chapterId: "hb-hhs", name: "HHS Chapter", selected: false },
        { chapterId: "hb-local", name: "Harrow Bay Local", selected: true },
        { chapterId: " ", name: "Blank" },
        { chapterId: "hb-transit", name: "", selected: false },
      ],
    };
    expect(normalizeLiveChapters(member).map((chapter) => [chapter.id, chapter.name])).toEqual([
      ["hb-local", "Harrow Bay Local"],
      ["hb-hhs", "HHS Chapter"],
      ["hb-transit", "hb-transit"],
    ]);
    expect(normalizeLiveChapters(member).every((chapter) => chapter.memberCount === null && chapter.landing === null)).toBe(true);
  });

  it("switches to another of the member's chapters before opening it, and changes nothing when refused", async () => {
    const open = vi.fn();
    const switchChapter = vi.fn().mockResolvedValue({ chapterId: "hb-hhs" });
    expect(await selectLiveChapter({ id: "hb-hhs" }, { currentChapterId: "hb-local", switchChapter, open })).toBe(true);
    expect(switchChapter).toHaveBeenCalledWith("hb-hhs");
    expect(open).toHaveBeenCalledTimes(1);

    const current = vi.fn();
    expect(await selectLiveChapter({ id: "hb-local" }, { currentChapterId: "hb-local", switchChapter: vi.fn(), open: current })).toBe(true);
    expect(current).toHaveBeenCalledTimes(1);

    const refusedOpen = vi.fn();
    const onRefused = vi.fn();
    const refusal = new Error("chapter membership required");
    expect(await selectLiveChapter({ id: "hb-hhs" }, { currentChapterId: "hb-local", switchChapter: vi.fn().mockRejectedValue(refusal), open: refusedOpen, onRefused })).toBe(false);
    expect(onRefused).toHaveBeenCalledWith(refusal, { id: "hb-hhs" });
    expect(refusedOpen).not.toHaveBeenCalled();
  });

  it("runs the unsaved-work guard before changing chapter, and a veto changes nothing", async () => {
    const switchChapter = vi.fn();
    const open = vi.fn();
    expect(await selectLiveChapter({ id: "hb-hhs" }, { currentChapterId: "hb-local", guard: () => false, switchChapter, open })).toBe(false);
    expect(switchChapter).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("reports a failed refresh after a committed switch instead of saying nothing changed", async () => {
    const open = vi.fn();
    const onRefused = vi.fn();
    const onReloadFailed = vi.fn();
    const failure = new Error("network");
    expect(await selectLiveChapter({ id: "hb-hhs", name: "HHS" }, {
      currentChapterId: "hb-local", switchChapter: vi.fn().mockResolvedValue({}), reload: vi.fn().mockRejectedValue(failure), open, onRefused, onReloadFailed,
    })).toBe(true);
    expect(onRefused).not.toHaveBeenCalled();
    expect(onReloadFailed).toHaveBeenCalledWith(failure, { id: "hb-hhs", name: "HHS" });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("serializes chapter choices so a second choice during a switch is ignored", async () => {
    let finish;
    const switchChapter = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const onBusy = vi.fn();
    const open = vi.fn();
    const select = createLiveChapterSelector(() => ({ currentChapterId: "hb-local", switchChapter, open, onBusy }));
    const first = select({ id: "hb-hhs" });
    expect(await select({ id: "hb-transit" })).toBe(false);
    expect(await select({ id: "hb-local" })).toBe(false);
    finish({});
    expect(await first).toBe(true);
    expect(switchChapter).toHaveBeenCalledTimes(1);
    expect(switchChapter).toHaveBeenCalledWith("hb-hhs");
    expect(open).toHaveBeenCalledTimes(1);
    expect(onBusy.mock.calls).toEqual([[true], [false]]);
    // Once settled, the next choice is honoured.
    const next = select({ id: "hb-transit" });
    finish({});
    expect(await next).toBe(true);
    expect(switchChapter).toHaveBeenLastCalledWith("hb-transit");
  });

  it("never promotes catalog, count, or organization fields from a live member", () => {
    const member = {
      chapterId: "wor",
      chapterName: "Harborview Care United",
      memberCount: 999,
      staffCount: 22,
      chapters: [{ id: "catalog", name: "Catalog chapter" }],
      organization: { chapters: [{ id: "admin", name: "Admin chapter" }] },
    };

    expect(normalizeLiveChapters(member)).toEqual([
      expect.objectContaining({
        id: "wor",
        name: "Harborview Care United",
        memberCount: null,
        staffCount: null,
        landing: null,
      }),
    ]);
  });

  it("deduplicates seeded demo organizations and preserves only honest counts", () => {
    const rows = normalizeDemoChapters([
      { id: " ma-dcf ", name: " North County Transit Workers ", region: " Massachusetts ", memberCount: 812, staffCount: 6 },
      { id: "MA-DCF", name: "Duplicate", region: "Elsewhere", memberCount: 1, staffCount: 1 },
      { id: "ma-dmh", name: "Lakeside Library Workers", region: "Massachusetts", memberCount: -4, staffCount: 4.8 },
      { id: " ", name: "No id", memberCount: 10, staffCount: 2 },
    ]);

    expect(rows).toEqual([
      {
        id: "ma-dcf",
        name: "North County Transit Workers",
        abbreviation: "NCT",
        category: "Massachusetts",
        memberCount: 812,
        staffCount: 6,
        landing: null,
      },
      {
        id: "ma-dmh",
        name: "Lakeside Library Workers",
        abbreviation: "LLW",
        category: "Massachusetts",
        memberCount: null,
        staffCount: 4,
        landing: null,
      },
    ]);
  });

  it("falls back to the persona's home chapter when the SAMPLE catalog degrades", () => {
    expect(normalizeSampleChapters([], {
      chapterId: "wor",
      chapterName: "Harborview Care United",
    })).toEqual([
      expect.objectContaining({
        id: "wor",
        name: "Harborview Care United",
        memberCount: null,
        staffCount: null,
      }),
    ]);

    expect(normalizeSampleChapters([
      { id: "dcf", name: "North County Transit Workers", memberCount: 812, staffCount: 6 },
    ], {
      chapterId: "wor",
      chapterName: "Harborview Care United",
    })).toEqual([
      expect.objectContaining({ id: "dcf", name: "North County Transit Workers" }),
    ]);
  });
});
