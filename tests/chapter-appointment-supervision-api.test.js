// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  MemberApiError,
  loadChapterAppointments,
  loadChapterAppointmentCandidates,
  reassignChapterAppointment,
} from "../src/lib/memberApi.js";

const firstId = "00000000-0000-4000-a000-000000000201";

function reportRow(index = 0) {
  return {
    id: index ? `00000000-0000-4000-a000-${String(index).padStart(12, "0")}` : firstId,
    member_name: "Darnell Foster",
    appointment_type: "office_hours",
    duration_minutes: 30,
    starts_at: `2026-08-20T${String(14 + index).padStart(2, "0")}:00:00Z`,
    ends_at: `2026-08-20T${String(14 + index).padStart(2, "0")}:30:00Z`,
    status: "confirmed",
    steward_id: "00000000-0000-4000-a000-000000000301",
    steward_name: "Maria Santos",
    total_count: 72,
    reason_category: "grievance",
    place: "https://private.example/meeting",
    email: "private@example.org",
    phone: "555-0100",
  };
}

describe("chapter appointment supervision API", () => {
  it("clamps a report request, maps only safe fields, and retires a short page", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [reportRow()], error: null });
    const result = await loadChapterAppointments({ rpc }, {
      cursor: { startsAt: "2026-08-20T14:00:00Z", id: firstId },
      limit: 500,
    });

    expect(rpc).toHaveBeenCalledWith("list_chapter_appointments", {
      p_after_starts: "2026-08-20T14:00:00Z",
      p_after_id: firstId,
      p_limit: 50,
    });
    expect(result).toEqual({
      rows: [{
        id: firstId,
        memberName: "Darnell Foster",
        appointmentType: "office_hours",
        durationMinutes: 30,
        startsAt: "2026-08-20T14:00:00Z",
        endsAt: "2026-08-20T14:30:00Z",
        status: "confirmed",
        stewardId: "00000000-0000-4000-a000-000000000301",
        stewardName: "Maria Santos",
      }],
      nextCursor: null,
      total: 72,
    });
    expect(JSON.stringify(result)).not.toMatch(/grievance|private\.example|private@example|555-0100/);
  });

  it("uses the final wire row as a complete full-page cursor", async () => {
    const rows = Array.from({ length: 50 }, (_, index) => reportRow(index + 1));
    const rpc = vi.fn().mockResolvedValue({ data: rows, error: null });
    const result = await loadChapterAppointments({ rpc });

    expect(rpc).toHaveBeenCalledWith("list_chapter_appointments", {
      p_after_starts: null,
      p_after_id: null,
      p_limit: 50,
    });
    expect(result.nextCursor).toEqual({ startsAt: rows[49].starts_at, id: rows[49].id });
    expect(result.total).toBe(72);
  });

  it("maps candidates to id and name only", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ steward_id: "steward-2", steward_name: "Nia Owens", email: "hidden@example.org" }],
      error: null,
    });
    await expect(loadChapterAppointmentCandidates({ rpc }, "appointment-1")).resolves.toEqual([
      { id: "steward-2", name: "Nia Owens" },
    ]);
    expect(rpc).toHaveBeenCalledWith("list_chapter_appointment_reassignment_candidates", {
      p_appointment_id: "appointment-1",
    });
  });

  it("sends only appointment and steward ids and returns a safe mapped row", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        id: "appointment-1",
        memberName: "Darnell Foster",
        appointmentType: "office_hours",
        durationMinutes: 30,
        startsAt: "2026-08-20T14:00:00Z",
        endsAt: "2026-08-20T14:30:00Z",
        status: "confirmed",
        stewardId: "steward-2",
        stewardName: "Nia Owens",
        reasonCategory: "hidden",
      },
      error: null,
    });
    const result = await reassignChapterAppointment({ rpc }, "appointment-1", "steward-2");
    expect(rpc).toHaveBeenCalledWith("reassign_chapter_appointment", {
      p_appointment_id: "appointment-1",
      p_steward_id: "steward-2",
    });
    expect(result).toEqual({
      id: "appointment-1",
      memberName: "Darnell Foster",
      appointmentType: "office_hours",
      durationMinutes: 30,
      startsAt: "2026-08-20T14:00:00Z",
      endsAt: "2026-08-20T14:30:00Z",
      status: "confirmed",
      stewardId: "steward-2",
      stewardName: "Nia Owens",
    });
  });

  it("preserves structured RPC failures", async () => {
    const error = { message: "denied", code: "42501", details: "mfa", hint: "verify" };
    const client = { rpc: vi.fn().mockResolvedValue({ data: null, error }) };
    await expect(loadChapterAppointments(client)).rejects.toMatchObject({
      name: "MemberApiError", label: "Chapter appointments", code: "42501",
    });
    await expect(loadChapterAppointmentCandidates(client, "appointment-1")).rejects.toBeInstanceOf(MemberApiError);
    await expect(reassignChapterAppointment(client, "appointment-1", "steward-2")).rejects.toBeInstanceOf(MemberApiError);
  });
});
