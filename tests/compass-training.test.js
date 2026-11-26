// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { compassTrainingPair, scheduleCompassTraining } from "../api/_lib/compassTraining.js";
import { unchangedCompassTrainingText } from "../api/_lib/compassPrompts.js";

const safe = { kind: "question", question: "Where is the contract?", answer: "The contract is in the library." };
const request = {
  ...safe, supabaseUrl: "https://project.example", serviceRoleKey: "server-only",
  userId: "11111111-1111-4111-8111-111111111111", requestId: "22222222-2222-4222-8222-222222222222",
};

describe("unchanged Compass training text", () => {
  it.each([undefined, null, false, 42, {}, []])("rejects non-text input without coercion (%j)", value => {
    expect(unchangedCompassTrainingText(value, 1200)).toBeNull();
  });

  it("rejects empty text and text beyond the supplied limit", () => {
    expect(unchangedCompassTrainingText("", 1200)).toBeNull();
    expect(unchangedCompassTrainingText(safe.question, safe.question.length - 1)).toBeNull();
  });

  it("accepts unchanged text exactly at its limit", () => {
    expect(unchangedCompassTrainingText(safe.question, safe.question.length)).toBe(safe.question);
  });

  it("refuses text beyond the minimizer hard cap even with a larger supplied limit", () => {
    const oversized = "a".repeat(20001);
    expect(unchangedCompassTrainingText(oversized, oversized.length)).toBeNull();
  });
});

describe("Compass training privacy boundary", () => {
  it("accepts an unchanged generic pair", () => {
    expect(compassTrainingPair(safe)).toEqual({ prompt: safe.question, response: safe.answer });
  });
  it.each(["case_help", "staff_data", "message_briefing", "field_notes_packet", "poll_draft"])("excludes %s", kind => {
    expect(compassTrainingPair({ ...safe, kind })).toBeNull();
  });
  it.each([
    { question: "Jane Smith was fired yesterday." },
    { question: "Where can I find the contract? Jane Smith was fired." },
    { question: "Where can I find\u200b the contract?" },
    { question: "Where can I find the contract? " },
    { answer: "Email me at person@example.org." },
    { answer: "[details withheld]" },
    { answer: "My grievance number is 123456." },
    { answer: "a".repeat(8001) },
  ])("rejects changed, withheld, personal or oversized text (%j)", change => {
    expect(compassTrainingPair({ ...safe, ...change })).toBeNull();
  });
  it("sends only the accepted pair and request identity, with no caller-supplied organization", async () => {
    const rpc = vi.fn().mockResolvedValue(true);
    const waitUntilImpl = vi.fn();
    expect(await scheduleCompassTraining(request, { rpc, waitUntilImpl })).toBe(true);
    expect(rpc).toHaveBeenCalledWith(request.supabaseUrl, "server-only", "server-only", "retain_compass_training_pair", {
      p_request_id: request.requestId, p_user_id: request.userId, p_kind: "question",
      p_prompt: safe.question, p_response: safe.answer, p_notice_version: "compass-training-v1",
    }, { timeoutMs: 2500 });
    expect(waitUntilImpl).toHaveBeenCalledTimes(1);
  });
  it("does not schedule rejected text or invalid request identities", async () => {
    const rpc = vi.fn();
    const waitUntilImpl = vi.fn();
    expect(await scheduleCompassTraining({ ...request, answer: "Jane Smith was fired." }, { rpc, waitUntilImpl })).toBe(false);
    expect(await scheduleCompassTraining({ ...request, requestId: "" }, { rpc, waitUntilImpl })).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
    expect(waitUntilImpl).not.toHaveBeenCalled();
  });
  it("does not fail the answer when retention is unavailable or consent is absent", async () => {
    expect(await scheduleCompassTraining(request, { rpc: vi.fn().mockRejectedValue(new Error("offline")), waitUntilImpl: () => {} })).toBe(false);
    expect(await scheduleCompassTraining(request, { rpc: vi.fn().mockResolvedValue(false), waitUntilImpl: () => {} })).toBe(false);
  });
});
