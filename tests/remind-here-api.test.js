// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  createChannelHereReminder,
  listChannelHereReminders,
  remindHereRefusal,
  remindHereRefusalTextEn,
} from "../src/features/messaging/remindHere.js";
import { loadCaseStewardEmails } from "../src/lib/caseworkApi.js";

// REQ-UG-REMIND-HERE-20261001 / REQ-UG-STEWARD-EMAIL-AUTO-ROUTING-20261001:
// the shared client the web and native screens call.
describe("remind here client", () => {
  it("sends exactly the channel, instant and note to the authority", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { id: "r-1", remindAt: "2026-10-03T13:00:00Z", status: "scheduled", coalesced: true }, error: null });
    const result = await createChannelHereReminder({ rpc }, { spaceId: "space-1", remindAt: "2026-10-03T13:00:00.000Z", note: "agenda" });
    expect(rpc).toHaveBeenCalledWith("create_channel_here_reminder", { p_space_id: "space-1", p_remind_at: "2026-10-03T13:00:00.000Z", p_note: "agenda" });
    expect(result).toEqual({ id: "r-1", remindAt: "2026-10-03T13:00:00Z", coalesced: true });
  });

  it("refuses without a channel and surfaces a server refusal unchanged", async () => {
    await expect(createChannelHereReminder({ rpc: vi.fn() }, { spaceId: "", remindAt: "x", note: "y" })).rejects.toMatchObject({ code: "42501" });
    const refusal = { code: "42501", details: "staff-required", message: "only chapter staff can remind the channel staff" };
    await expect(createChannelHereReminder({ rpc: vi.fn().mockResolvedValue({ data: null, error: refusal }) }, { spaceId: "s", remindAt: "x", note: "y" }))
      .rejects.toBe(refusal);
    await expect(createChannelHereReminder({ rpc: vi.fn().mockResolvedValue({ data: {}, error: null }) }, { spaceId: "s", remindAt: "x", note: "y" }))
      .rejects.toThrow("not confirmed");
  });

  it("normalizes the reminders that reached the reader and drops malformed rows", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [
      { id: "r-1", note: "agenda", remindAt: "a", deliveredAt: "b", spaceId: "s", spaceName: "general", authorName: "Ana", mine: true, extra: "ignored" },
      { id: 7, note: "bad" },
      null,
    ], error: null });
    expect(await listChannelHereReminders({ rpc })).toEqual([
      { id: "r-1", note: "agenda", remindAt: "a", deliveredAt: "b", spaceId: "s", spaceName: "general", authorName: "Ana", mine: true },
    ]);
    expect(rpc).toHaveBeenCalledWith("list_channel_here_reminders", { p_limit: 50 });
    expect(await listChannelHereReminders(null)).toEqual([]);
  });

  it("maps every refusal to one reason with English copy for native", () => {
    expect(remindHereRefusal({ code: "42501", details: "feature-disabled" })).toBe("off");
    expect(remindHereRefusal({ code: "42501", detail: "staff-required" })).toBe("staff");
    expect(remindHereRefusal({ code: "42501" })).toBe("unavailable");
    expect(remindHereRefusal({ code: "54000" })).toBe("limit");
    expect(remindHereRefusal({ code: "22023" })).toBe("invalid");
    expect(remindHereRefusal(null)).toBe("failed");
    for (const reason of ["off", "staff", "unavailable", "limit", "invalid", "failed"]) expect(remindHereRefusalTextEn(reason)).toMatch(/\S/);
  });
});

describe("case steward email client", () => {
  it("reads the attached email for one case", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ id: "e-1" }], error: null });
    expect(await loadCaseStewardEmails({ rpc }, "c-1")).toEqual([{ id: "e-1" }]);
    expect(rpc).toHaveBeenCalledWith("list_case_steward_emails", { p_case_id: "c-1" });
    await expect(loadCaseStewardEmails({ rpc }, null)).rejects.toThrow("Case id required");
  });
});
