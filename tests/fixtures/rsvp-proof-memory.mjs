import assert from "node:assert/strict";

// No URL, SDK or network transport exists in this fixture. Only the shipped
// mobile service's three table reads and one RSVP RPC are implemented.
export function rsvpProofMemory(response = null) {
  const eventId = "isolated-tamarack-rsvp-proof";
  let state = {
    rsvps: [{ event_id: "unrelated-meeting", status: "not_going" }, ...(response === null ? [] : [{ event_id: eventId, status: response }])],
    checkins: [{ event_id: "unrelated-meeting", checked_in_at: "2026-01-01T12:00:00Z" }],
    actionLog: [{ action_key: "unrelated-checkin" }, ...(response === "going" ? [{ action_key: `rsvp-${eventId}` }] : [])],
    points: [{ id: "unrelated-points", points: 17 }, ...(response === "going" ? [{ id: "prior-rsvp-points", points: 40 }] : [])],
  };
  const calls = [];
  const tables = () => ({
    member_events: [{ id: eventId, chapter_id: "isolated-tamarack", title: "Isolated Tamarack RSVP proof", starts_at: new Date(Date.now() + 86400000).toISOString(), event_kind: "meeting", rsvp_open: true, check_in_offered: false }],
    member_event_rsvps: state.rsvps,
    member_event_checkins: state.checkins,
  });
  const client = {
    from(table) {
      if (!Object.hasOwn(tables(), table)) throw new Error(`Unexpected proof table: ${table}`);
      const query = {
        select() { return query; }, order() { return query; },
        async range(from, to) { return { data: structuredClone(tables()[table].slice(from, to + 1)), error: null }; },
      };
      return query;
    },
    async rpc(name, args) {
      assert.equal(name, "rsvp_to_event");
      assert.equal(args.p_event_id, eventId);
      assert.ok(["going", "not_going"].includes(args.p_status));
      calls.push({ name, ...args });
      const row = state.rsvps.find(item => item.event_id === eventId);
      if (row) row.status = args.p_status;
      else state.rsvps.push({ event_id: eventId, status: args.p_status });
      const firstAward = args.p_status === "going" && !state.actionLog.some(item => item.action_key === `rsvp-${eventId}`);
      if (firstAward) {
        state.actionLog.push({ action_key: `rsvp-${eventId}` });
        state.points.push({ id: "proof-rsvp-points", points: 40 });
      }
      return { data: { status: args.p_status, awardedPoints: firstAward ? 40 : 0 }, error: null };
    },
  };
  const snapshot = () => structuredClone(state);
  const counts = () => ({
    response: state.rsvps.find(item => item.event_id === eventId)?.status ?? null,
    rsvps: state.rsvps.length, checkins: state.checkins.length,
    actionLog: state.actionLog.length, pointEvents: state.points.length,
    points: state.points.reduce((sum, item) => sum + item.points, 0),
  });
  return {
    eventId, client, calls, snapshot, counts,
    async prove(run) {
      const before = snapshot(); const beforeCounts = counts();
      let status = "passed"; let reason = null;
      try { await run(); }
      catch (error) { status = "failed"; reason = error.message; }
      finally { state = structuredClone(before); }
      assert.deepEqual(snapshot(), before, "fixture cleanup must restore the exact response and every side effect");
      return { eventId, status, reason, before: beforeCounts, after: counts(), restored: true };
    },
  };
}
