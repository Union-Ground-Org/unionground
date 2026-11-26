// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, migrationFiles } from "./helpers/migration.js";

// The 2026-08-21 files restored the cancelled-event refusal, then a later
// migration replaced all three functions. A filename pin on that generation
// stays green after the live body moves, so each assertion reads the last
// definition in apply order.
const SUPERSEDED_BY_SIGNATURE = {
  "public.rsvp_to_event(p_event_id text, p_status text)": "20260821023000_cancelled_event_member_action_guards.sql",
  "public.check_in_to_event(p_event_id text, p_code text)": "20260821023000_cancelled_event_member_action_guards.sql",
  "public.request_event_checkin_token(p_event_id text)": "20260821093000_cancelled_event_token_guard.sql",
};

function latestDefinition(signature) {
  let found = null;
  for (const entry of migrationFiles()) {
    try {
      found = { name: entry.name, body: fnBody(entry.sql, signature) };
    } catch (error) {
      if (!/is not declared in this migration$/.test(String(error?.message))) throw error;
    }
  }
  if (!found) throw new Error(`no migration defines ${signature}`);
  return found;
}

function expectLiveCancelledGuard(signature, firstWrite) {
  const { name, body } = latestDefinition(signature);
  const cancelledGuard = body.indexOf("if ev.cancelled_at is not null then");
  const writes = [...body.matchAll(/\b(?:insert\s+into|delete\s+from|update)\s+(?:public|private)\./gi)]
    .map((match) => match.index);

  expect(name > SUPERSEDED_BY_SIGNATURE[signature]).toBe(true);
  expect(body).toContain("e.cancelled_at");
  expect(body).toContain("detail = 'event_cancelled'");
  expect(cancelledGuard).toBeGreaterThanOrEqual(0);
  expect(body).toContain(firstWrite);
  expect(writes.length).toBeGreaterThan(0);
  for (const writeAt of writes) expect(writeAt).toBeGreaterThan(cancelledGuard);
  expect(body).toMatch(
    /private\.member_can_access_event_scope\(\s*e\.chapter_id\s*,\s*e\.is_public\s*,\s*e\.is_public_across_agencies\s*\)/,
  );
  expect(body).not.toContain("private.current_member_chapter()");
  return body;
}

describe("cancelled event member action guards", () => {
  for (const signature of [
    "public.rsvp_to_event(p_event_id text, p_status text)",
    "public.check_in_to_event(p_event_id text, p_code text)",
  ]) {
    it(`${signature} rejects a cancelled event before any member write`, () => {
      expectLiveCancelledGuard(signature, "insert into public.member_");
    });
  }

  it("public.request_event_checkin_token(p_event_id text) rejects a cancelled event before minting a token", () => {
    const body = expectLiveCancelledGuard(
      "public.request_event_checkin_token(p_event_id text)",
      "delete from private.member_event_checkin_tokens",
    );
    expect(body).toContain("for share");
  });
});
