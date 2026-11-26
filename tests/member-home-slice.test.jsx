// BUG-UG-WEB-HOME-REPAINTS-PREVIOUS-CHAPTER-AFTER-SWITCH-20261111:
// the retained Home slice is no longer a render source. Nothing reads it; App
// only clears what an older build left in this tab. The narrowed writer stays
// until the next legal release drops its disclosure row and source pins, so
// its privacy narrowing is still held here.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_MEMBER_HOME_SLICE_BYTES,
  MEMBER_HOME_SLICE_KEY,
  MEMBER_HOME_SLICE_MEMBER_FIELDS,
  MEMBER_HOME_SLICE_NEVER_KEYS,
  MEMBER_HOME_SLICE_VALUE_KEYS,
  clearMemberHomeSlice,
  memberHomeSliceFromProjection,
  writeMemberHomeSlice,
} from "../src/lib/memberHomeSlice.js";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";

const MEMBER = "member-6360";
// A committed Home projection carrying every row class the slice must refuse.
const projection = {
  ...fallbackData,
  member: { ...fallbackData.member, id: MEMBER, email: "member@example.test", notificationCount: 3, quietHoursStart: "22:00" },
  cases: [{ id: "case-1", title: "Discipline meeting", status: "active" }],
  caseUpdates: [{ id: "update-1", body: "Steward note" }],
  notifications: [{ id: "n-1", title: "Your grievance moved", read_at: null }],
  broadcasts: [{ id: "b-1", title: "Strike vote" }],
  conversations: [{ id: "c-1", preview: "Private message" }],
  taskMessages: [{ id: "t-1", body: "Task chat" }],
  metrics: { openCases: 2, label: "Two open" },
  events: [{ ...(fallbackData.events?.[0] ?? {}), id: "event-6360", title: "Chapter meeting 6360", rsvpStatus: "going" }],
};

beforeEach(() => { sessionStorage.clear(); });
afterEach(() => { sessionStorage.clear(); });

describe("retired Home slice", () => {
  it("keeps only allowlisted values and stores every refused row class empty", () => {
    expect(MEMBER_HOME_SLICE_VALUE_KEYS).toEqual(["roles", "rights", "events", "planItems", "rewardsCatalog"]);
    for (const key of MEMBER_HOME_SLICE_NEVER_KEYS) expect(MEMBER_HOME_SLICE_VALUE_KEYS).not.toContain(key);
    const { userId, projection: slice } = memberHomeSliceFromProjection(projection);
    expect(userId).toBe(MEMBER);
    expect(slice.events).toEqual(projection.events);
    expect(slice.rights).toEqual(projection.rights);
    expect(slice.rewardsCatalog).toEqual(projection.rewardsCatalog);
    for (const key of ["cases", "caseUpdates", "notifications", "broadcasts", "conversations", "taskMessages"]) expect(slice[key], key).toEqual([]);
    expect(slice.metrics).toEqual({ openCases: 0, label: "" });
    expect(Object.keys(slice).toSorted()).toEqual(Object.keys(projection).toSorted());
    // The identity line only: no email, unread count or notification settings.
    for (const field of MEMBER_HOME_SLICE_MEMBER_FIELDS) if (field in projection.member) expect(slice.member[field], field).toEqual(projection.member[field]);
    expect(slice.member.email).toBe("");
    expect(slice.member.notificationCount).toBe(0);
    expect(slice.member.quietHoursStart).toBe("");
    const stored = JSON.stringify(slice);
    for (const secret of ["Discipline meeting", "Steward note", "Your grievance moved", "Strike vote", "Private message", "Task chat", "member@example.test", "Two open"]) {
      expect(stored, secret).not.toContain(secret);
    }
    expect(memberHomeSliceFromProjection(null)).toBeNull();
    expect(memberHomeSliceFromProjection({ member: {} })).toBeNull();
  });

  it("clears a leftover slice, keeping only the incoming member's when asked, and survives unreadable storage", () => {
    expect(writeMemberHomeSlice(projection)).toBe(true);
    clearMemberHomeSlice({ keepUserId: MEMBER });
    expect(sessionStorage.getItem(MEMBER_HOME_SLICE_KEY)).not.toBeNull();
    clearMemberHomeSlice({ keepUserId: "member-other" });
    expect(sessionStorage.getItem(MEMBER_HOME_SLICE_KEY)).toBeNull();
    writeMemberHomeSlice(projection);
    clearMemberHomeSlice();
    expect(sessionStorage.getItem(MEMBER_HOME_SLICE_KEY)).toBeNull();
    sessionStorage.setItem(MEMBER_HOME_SLICE_KEY, "{not json");
    clearMemberHomeSlice({ keepUserId: MEMBER });
    expect(sessionStorage.getItem(MEMBER_HOME_SLICE_KEY)).toBeNull();
    const broken = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    expect(() => clearMemberHomeSlice({ storage: broken, keepUserId: MEMBER })).not.toThrow();
    expect(writeMemberHomeSlice(projection, { storage: broken })).toBe(false);
    expect(writeMemberHomeSlice(projection, { storage: null })).toBe(false);
    clearMemberHomeSlice({ storage: null });
  });

  it("drops a slice that would exceed its bound instead of writing it", () => {
    writeMemberHomeSlice(projection);
    const huge = { ...projection, events: Array.from({ length: 2000 }, (_, index) => ({ id: `event-${index}`, title: "x".repeat(60) })) };
    expect(JSON.stringify(memberHomeSliceFromProjection(huge)).length).toBeGreaterThan(MAX_MEMBER_HOME_SLICE_BYTES);
    expect(writeMemberHomeSlice(huge)).toBe(false);
    expect(sessionStorage.getItem(MEMBER_HOME_SLICE_KEY)).toBeNull();
  });

  it("is never painted: App only clears it, and nothing else reads or writes it", () => {
    const app = readFileSync("src/App.jsx", "utf8");
    expect(app).toMatch(/import \{ clearMemberHomeSlice \} from "\.\/lib\/memberHomeSlice\.js";/u);
    expect(app).not.toMatch(/readMemberHomeSlice|withRetainedHomeSlice|writeMemberHomeSlice|retainedHomeSliceRef|homeSliceRefreshing/u);
    const clear = app.indexOf("clearMemberHomeSlice();");
    expect(clear).toBeGreaterThan(-1);
    expect(app.slice(clear - 200, clear)).toContain("if (authRestorePending) return;");
    const source = readFileSync("src/lib/memberHomeSlice.js", "utf8");
    expect(source).not.toMatch(/export function (readMemberHomeSlice|withRetainedHomeSlice)/u);
    expect(readFileSync("src/lib/memberSessionLoader.js", "utf8")).not.toMatch(/memberHomeSlice|sessionStorage/u);
  });
});
