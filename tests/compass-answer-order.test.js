// @vitest-environment node
import { describe, expect, it } from "vitest";
import { orderGuideMessages } from "../src/lib/memberApi.js";

// BUG-UG-COMPASS-ANSWER-ABOVE-QUESTION-20261107: the live demo showed
// Compass answers above the visitor's question. One exchange saves both rows
// in one insert, so they share created_at and the newest-first read left their
// order to the database.
const row = (id, role, created_at) => ({ id, thread_id: "t1", role, body: id, created_at });

describe("Compass message order", () => {
  it("puts the question before its answer when both were saved at the same moment", () => {
    const at = "2026-11-07T23:24:00.000Z";
    // Newest first as read, with the tie resolved the wrong way round.
    expect(orderGuideMessages([row("a1", "assistant", at), row("q1", "user", at)]).map((m) => m.id)).toEqual(["q1", "a1"]);
  });

  it("keeps several exchanges oldest first, each question before its answer", () => {
    const first = "2026-11-07T23:24:00.000Z";
    const second = "2026-11-07T23:25:00.000Z";
    const read = [row("a2", "assistant", second), row("q2", "user", second), row("a1", "assistant", first), row("q1", "user", first)];
    expect(orderGuideMessages(read).map((m) => m.id)).toEqual(["q1", "a1", "q2", "a2"]);
  });

  it("matches the old reverse order when times and roles differ", () => {
    const read = [row("a", "assistant", "2026-11-07T23:26:00Z"), row("q", "user", "2026-11-07T23:25:00Z")];
    expect(orderGuideMessages(read)).toEqual([...read].reverse());
  });

  it("keeps the read's reverse order for identical rows and tolerates a missing list", () => {
    const at = "2026-11-07T23:24:00.000Z";
    expect(orderGuideMessages([row("a2", "assistant", at), row("a1", "assistant", at)]).map((m) => m.id)).toEqual(["a1", "a2"]);
    expect(orderGuideMessages(null)).toEqual([]);
  });

  it("does not change the rows it is given", () => {
    const read = [row("a", "assistant", "2026-11-07T23:24:00Z"), row("q", "user", "2026-11-07T23:24:00Z")];
    const copy = JSON.parse(JSON.stringify(read));
    orderGuideMessages(read);
    expect(read).toEqual(copy);
  });
});
