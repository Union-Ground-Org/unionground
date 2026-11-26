import { describe, expect, it } from "vitest";

import {
  buildMemberPickerOptions,
  filterOptionPickerOptions,
  OPTION_PICKER_MAX_VISIBLE,
  optionPickerSearchNeedle,
} from "../apps/mobile/src/components/optionPickerFilter";

// Codex review round 1 on PR #2321 (P1): the Neuro Map member pickers must
// never mount one control per relationship node — the snapshot RPC can return
// up to 5,000 nodes and the picker is instantiated twice inside Screen's
// non-virtualized ScrollView. Searching plus a hard render cap bounds the
// mounted controls regardless of roster size.

function roster(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `member-${index}`,
    label: `Member ${index}`,
    detail: index % 2 === 0 ? "Steward" : null,
  }));
}

describe("filterOptionPickerOptions", () => {
  it("bounds a 5,000-member roster to the mounted-row cap", () => {
    const options = roster(5000);
    const { visible, total } = filterOptionPickerOptions(options, "", "");
    expect(visible).toHaveLength(OPTION_PICKER_MAX_VISIBLE);
    expect(total).toBe(5000);
    expect(visible[0].id).toBe("member-0");
    expect(visible.at(-1).id).toBe(`member-${OPTION_PICKER_MAX_VISIBLE - 1}`);
  });

  it("matches the search needle against both label and role/chapter detail", () => {
    const options = [
      { id: "a", label: "Jordan Lee", detail: "Steward · North Shore Chapter" },
      { id: "b", label: "Jordan Lee", detail: "Member organizer · South Valley Chapter" },
      { id: "c", label: "Sam Okafor", detail: "Coordinator" },
    ];
    expect(filterOptionPickerOptions(options, "okafor", "").visible.map((o) => o.id)).toEqual(["c"]);
    // Detail-only hits (chapter context) surface the member too.
    expect(filterOptionPickerOptions(options, "south valley", "").visible.map((o) => o.id)).toEqual(["b"]);
    // Shared-name disambiguation: both Jordan Lees remain distinguishable.
    expect(filterOptionPickerOptions(options, "jordan", "").visible).toHaveLength(2);
  });

  it("keeps the current selection reachable even when it does not match the needle", () => {
    const options = roster(5000);
    const { visible, total } = filterOptionPickerOptions(options, "zzz-no-match", "member-4999");
    expect(visible[0].id).toBe("member-4999");
    expect(total).toBe(1); // pinned selection is the only reachable row
    expect(visible).toHaveLength(1);
  });

  it("returns an empty visible set for an empty roster or non-matching needle", () => {
    expect(filterOptionPickerOptions([], "", "").visible).toEqual([]);
    expect(filterOptionPickerOptions(roster(10), "nobody", "").visible).toEqual([]);
  });

  it("treats a whitespace-only needle as no filter", () => {
    const { visible, total } = filterOptionPickerOptions(roster(120), "   ", "");
    expect(total).toBe(120);
    expect(visible).toHaveLength(OPTION_PICKER_MAX_VISIBLE);
  });

  it("pins a selected match that would otherwise fall past the mounted cap", () => {
    const options = roster(100);
    const { visible, total } = filterOptionPickerOptions(options, "", "member-99");
    expect(total).toBe(100);
    expect(visible).toHaveLength(OPTION_PICKER_MAX_VISIBLE);
    expect(visible[0].id).toBe("member-99");
    expect(visible.map((option) => option.id)).not.toContain("member-50");
  });

  it("keeps the selected row visible after search-then-clear", () => {
    const options = roster(100);
    const searched = filterOptionPickerOptions(options, "Member 99", "");
    expect(searched.visible.map((option) => option.id)).toEqual(["member-99"]);
    const cleared = filterOptionPickerOptions(options, "", "member-99");
    expect(cleared.visible[0].id).toBe("member-99");
    expect(cleared.visible).toHaveLength(OPTION_PICKER_MAX_VISIBLE);
  });
});

describe("optionPickerSearchNeedle", () => {
  it("passes the query only while the roster is large enough to show search", () => {
    expect(optionPickerSearchNeedle("jordan", 51)).toBe("jordan");
    expect(optionPickerSearchNeedle("jordan", 50)).toBe("");
    expect(optionPickerSearchNeedle("jordan", 0)).toBe("");
  });
});

describe("buildMemberPickerOptions", () => {
  it("falls back to the snapshot chapter id when no chart node exists", () => {
    const options = buildMemberPickerOptions(
      [
        { id: "jordan-north", label: "Jordan Lee", roleLabel: "Steward", chapterId: "ch-north" },
        { id: "jordan-south", label: "Jordan Lee", roleLabel: "Steward", chapterId: "ch-south" },
      ],
      new Map(),
    );
    expect(options).toEqual([
      { id: "jordan-north", label: "Jordan Lee", detail: "Steward · ch-north" },
      { id: "jordan-south", label: "Jordan Lee", detail: "Steward · ch-south" },
    ]);
  });

  it("adds a stable ordinal when name, role, and chapter still collide", () => {
    const options = buildMemberPickerOptions(
      [
        { id: "jordan-bbb", label: "Jordan Lee", roleLabel: "Steward", chapterId: "ch-north" },
        { id: "jordan-aaa", label: "Jordan Lee", roleLabel: "Steward", chapterId: "ch-north" },
      ],
      new Map([["ch-north", "North Shore Chapter"]]),
    );
    expect(options).toEqual([
      { id: "jordan-bbb", label: "Jordan Lee", detail: "Steward · North Shore Chapter · 2 of 2" },
      { id: "jordan-aaa", label: "Jordan Lee", detail: "Steward · North Shore Chapter · 1 of 2" },
    ]);
  });
});
