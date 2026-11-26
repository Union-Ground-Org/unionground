// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  REMIND_MAX_NOTE_LENGTH,
  REMIND_USAGE_EN,
  isRemindCommand,
  parseRemindCommand,
  remindErrorTextEn,
} from "../src/features/messaging/remindCommand.js";

// REQ-UG-REMIND-HERE-20261001: the composer grammar restored from
// de7df4b57c^:app/dashboard/messages/remind-command.ts. Local wall-clock times
// resolve on the device; these cases pin a local clock.
const NOW = new Date(2026, 9, 2, 10, 15, 0, 0);

describe("remind command detection", () => {
  it("claims every draft that starts with the command word, and nothing else", () => {
    expect(isRemindCommand("/remind here in 5m x")).toBe(true);
    expect(isRemindCommand("  /REMIND help")).toBe(true);
    expect(isRemindCommand("/remind")).toBe(true);
    expect(isRemindCommand("/reminder here")).toBe(false);
    expect(isRemindCommand("please /remind here")).toBe(false);
    expect(parseRemindCommand("hello team", NOW)).toBeNull();
    expect(parseRemindCommand("", NOW)).toBeNull();
  });

  it("answers help for the bare command and the help word", () => {
    expect(parseRemindCommand("/remind", NOW)).toEqual({ kind: "help" });
    expect(parseRemindCommand("/remind help", NOW)).toEqual({ kind: "help" });
  });
});

describe("remind here grammar", () => {
  it("resolves a relative delay in minutes, hours and days", () => {
    const minutes = parseRemindCommand("/remind here in 20m stand-down review", NOW);
    expect(minutes).toEqual({ kind: "reminder", target: "here", remindAt: new Date(NOW.getTime() + 20 * 60_000), note: "stand-down review" });
    expect(parseRemindCommand("/remind here in 2 hours file it", NOW).remindAt).toEqual(new Date(NOW.getTime() + 2 * 3_600_000));
    expect(parseRemindCommand("/remind here in 3d vote", NOW).remindAt).toEqual(new Date(NOW.getTime() + 3 * 86_400_000));
  });

  it("defaults tomorrow and on-date forms to 9:00 local time and reads explicit times", () => {
    expect(parseRemindCommand("/remind here tomorrow agenda", NOW).remindAt).toEqual(new Date(2026, 9, 3, 9, 0));
    expect(parseRemindCommand("/remind here tomorrow 2:30pm agenda", NOW).remindAt).toEqual(new Date(2026, 9, 3, 14, 30));
    expect(parseRemindCommand("/remind here tomorrow 12am agenda", NOW).remindAt).toEqual(new Date(2026, 9, 3, 0, 0));
    const onDate = parseRemindCommand("/remind here on 2026-11-01 14:30 contract vote", NOW);
    expect(onDate).toMatchObject({ kind: "reminder", target: "here", note: "contract vote" });
    expect(onDate.remindAt).toEqual(new Date(2026, 10, 1, 14, 30));
  });

  it("treats a bare number as note text, not a time", () => {
    expect(parseRemindCommand("/remind here tomorrow 9 people to call", NOW)).toMatchObject({
      remindAt: new Date(2026, 9, 3, 9, 0), note: "9 people to call",
    });
  });

  it("keeps the personal target distinct so a channel composer can redirect it", () => {
    expect(parseRemindCommand("/remind me in 5m call Ana", NOW)).toMatchObject({ kind: "reminder", target: "me", note: "call Ana" });
  });

  it("refuses every malformed draft with a code instead of sending it", () => {
    expect(parseRemindCommand("/remind everyone in 5m x", NOW)).toMatchObject({ kind: "error", code: "missing_target" });
    expect(parseRemindCommand("/remind here", NOW)).toMatchObject({ code: "missing_time" });
    expect(parseRemindCommand("/remind here soon x", NOW)).toMatchObject({ code: "missing_time" });
    expect(parseRemindCommand("/remind here in 0m x", NOW)).toMatchObject({ code: "missing_time" });
    expect(parseRemindCommand("/remind here in 20m", NOW)).toMatchObject({ code: "missing_note" });
    expect(parseRemindCommand("/remind here tomorrow 25:00 x", NOW)).toMatchObject({ code: "invalid_time", detail: "25:00" });
    expect(parseRemindCommand("/remind here tomorrow 13pm x", NOW)).toMatchObject({ code: "invalid_time" });
    expect(parseRemindCommand("/remind here on 2026-02-30 x", NOW)).toMatchObject({ code: "invalid_date", detail: "2026-02-30" });
    expect(parseRemindCommand("/remind here on 2026-10-01 x", NOW)).toMatchObject({ code: "past" });
    expect(parseRemindCommand("/remind here on 2028-01-01 x", NOW)).toMatchObject({ code: "too_far" });
    expect(parseRemindCommand(`/remind here in 5m ${"x".repeat(REMIND_MAX_NOTE_LENGTH + 1)}`, NOW)).toMatchObject({ code: "note_too_long" });
  });

  it("has English copy for every error code native prints", () => {
    for (const code of ["missing_target", "missing_time", "missing_note", "note_too_long", "past", "too_far", "invalid_time", "invalid_date", "me_not_here"]) {
      expect(remindErrorTextEn(code)).toMatch(/\S/);
    }
    expect(remindErrorTextEn("unknown")).toBe(remindErrorTextEn("missing_time"));
    expect(REMIND_USAGE_EN.split("\n")).toEqual([
      "/remind here in 20m <what>",
      "/remind here tomorrow 9am <what>",
      "/remind here on 2026-07-01 14:30 <what>",
    ]);
  });
});
