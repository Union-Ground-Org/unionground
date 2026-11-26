// BUG-UG-CASE-DEADLINE-MEMBER-AND-STAFF-READ-DIFFERENT-DATES-20261110
// (#7979), gate round 1 finding r1s1: the web app reads the member snapshot
// through the session loader, which serves only the resources a route's plan
// registers and substitutes an empty list for any other read. Home and My
// cases must really send the open step deadline read, scoped to the member's
// own active cases, and page it past one capped response (finding r1s2).
import { afterEach, expect, it, vi } from "vitest";
import { createMemberSessionLoader } from "../src/lib/memberSessionLoader.js";
import { STEP_DEADLINE_PAGE, readOpenStepDeadlines } from "../src/lib/memberApi.js";
import { calendarDaysUntil, rankWhatMattersNow } from "../src/features/memberHome/whatMattersNow.js";

vi.mock("../src/lib/deferredObservability.js", async (importOriginal) => ({ ...(await importOriginal()), captureSanitizedDiagnostic: vi.fn(() => true) }));
afterEach(() => { vi.restoreAllMocks(); });

const NOW = new Date("2026-11-09T17:00:00Z");
const MISSED = { case_id: "case-1", id: "d-1", label: "Step 1", due_at: "2026-11-09T04:59:59+00:00", status: "missed" };

// A PostgREST stand-in that honours .order() by due_at/id and .range(), and
// caps each response at STEP_DEADLINE_PAGE rows like max_rows does.
function client(stepRows, caseZone) {
  const queries = [];
  const rows = {
    member_profiles: { id: "member", first_name: "Ibrahim", full_name: "Ibrahim Kamara", language: "en" },
    member_cases: [
      { id: "case-1", user_id: "member", reference: "GR-2026-14296", title: "Schedule change", case_type: "Scheduling", step: "Intake", status: "active", deadline: "2026-11-27", updated_at: "2026-11-01T12:00:00Z", ...(caseZone ? { time_zone: caseZone } : {}) },
      { id: "case-2", user_id: "member", reference: "GR-2026-1", title: "Closed", case_type: "Scheduling", step: "Closed", status: "resolved", deadline: "2026-10-01", updated_at: "2026-10-01T12:00:00Z" },
    ],
    casework_deadlines: stepRows,
  };
  const execute = (table, calls) => {
    let data = structuredClone(rows[table] ?? []);
    if (table === "casework_deadlines") {
      // Without .order() a response comes back in storage order.
      if (calls.some(([method]) => method === "order")) data = [...data].sort((left, right) => left.due_at.localeCompare(right.due_at) || left.id.localeCompare(right.id));
      const range = calls.find(([method]) => method === "range");
      data = range ? data.slice(range[1][0], range[1][1] + 1) : data;
      data = data.slice(0, STEP_DEADLINE_PAGE);
    }
    return Promise.resolve({ data, error: null });
  };
  return {
    queries,
    from(table) {
      const calls = [];
      queries.push({ table, calls });
      let query;
      query = new Proxy({}, { get(_target, key) {
        if (key === "then") return (resolve, reject) => execute(table, calls).then(resolve, reject);
        return (...args) => { if (typeof key === "string") calls.push([key, args]); return query; };
      } });
      return query;
    },
    rpc: async () => ({ data: null, error: null }),
  };
}

it.each(["today", "cases"])("the %s route sends the step deadline read for the member's own active cases", async (route) => {
  const fake = client([MISSED]);
  const loader = createMemberSessionLoader(fake, { id: "member" });
  const projection = await loader.loadRoute(route);
  const reads = fake.queries.filter((query) => query.table === "casework_deadlines");
  expect(reads.length).toBeGreaterThan(0);
  for (const { calls } of reads) expect(calls).toContainEqual(["in", ["case_id", ["case-1"]]]);
  const shown = projection.cases.find((item) => item.id === "case-1");
  expect(shown.nextDeadline).toEqual({ kind: "step", label: "Step 1", dueOn: "2026-11-08", missed: true, timeZone: "America/New_York" });
  expect(rankWhatMattersNow({ cases: projection.cases, now: NOW })).toMatchObject({ kind: "filing_deadline", deadline: "2026-11-08", deadlineKind: "step" });
  loader.dispose();
});

it("reads past one capped response so the earliest step is never cut off", async () => {
  // 1,000 later rows are stored before the missed one, so one unordered,
  // capped response would never contain it. The read orders by due date and
  // pages until a short page, so it returns every row, earliest first.
  const filler = Array.from({ length: STEP_DEADLINE_PAGE }, (_, index) => ({
    case_id: "case-1", id: `f-${String(index).padStart(4, "0")}`, label: "Follow-up", due_at: "2026-11-20T04:59:59+00:00", status: "active",
  }));
  const fake = client([...filler, MISSED]);
  const { data, error } = await readOpenStepDeadlines(fake, ["case-1"]);
  expect(error).toBeNull();
  expect(data).toHaveLength(STEP_DEADLINE_PAGE + 1);
  expect(data[0]).toMatchObject({ id: "d-1" });
  const pages = fake.queries.filter((query) => query.table === "casework_deadlines").map(({ calls }) => calls.find(([method]) => method === "range")[1]);
  expect(pages).toEqual([[0, STEP_DEADLINE_PAGE - 1], [STEP_DEADLINE_PAGE, 2 * STEP_DEADLINE_PAGE - 1]]);
});

it("fails the whole read when a later page fails, so no case is ranked on a partial set", async () => {
  let call = 0;
  const failing = {
    from() {
      const page = call++;
      let query;
      query = new Proxy({}, { get(_target, key) {
        if (key === "then") return (resolve) => resolve(page === 0
          ? { data: Array.from({ length: STEP_DEADLINE_PAGE }, (_, index) => ({ case_id: "case-1", id: `r${index}`, label: "Step", due_at: "2026-11-20T04:59:59+00:00", status: "active" })), error: null }
          : { data: null, error: { message: "offline" } });
        return () => query;
      } });
      return query;
    },
  };
  expect(await readOpenStepDeadlines(failing, ["case-1"])).toEqual({ data: null, error: { message: "offline" } });
  expect(await readOpenStepDeadlines(failing, [])).toEqual({ data: [], error: null });
});

// REQ-UG-TIME-ZONES-PER-GROUP-20261122 (#9446), final of #9617
// (stage 568B): this build may be live before the time_zone migration
// applies. A database without the column answers 42703 or PGRST204 naming it,
// and the case and step reads run again without it instead of failing.
it.each([["42703", 'column casework_deadlines.time_zone does not exist'], ["PGRST204", "Could not find the 'time_zone' column of 'member_cases' in the schema cache"]])(
  "reads cases and step deadlines without time_zone when the database answers %s", async (code, message) => {
    const fake = client([MISSED]);
    const from = fake.from.bind(fake);
    fake.from = (table) => {
      const query = from(table);
      const record = fake.queries.at(-1);
      const outer = new Proxy(query, { get(target, key) {
        if (key === "then") {
          const select = record.calls.find(([method]) => method === "select")?.[1][0] ?? "";
          if (/\btime_zone\b/.test(select)) return (resolve) => resolve({ data: null, error: { code, message } });
          return target.then;
        }
        return (...args) => { target[key](...args); return outer; };
      } });
      return outer;
    };
    const loader = createMemberSessionLoader(fake, { id: "member" });
    const projection = await loader.loadRoute("cases");
    const shown = projection.cases.find((item) => item.id === "case-1");
    expect(shown.nextDeadline).toEqual({ kind: "step", label: "Step 1", dueOn: "2026-11-08", missed: true, timeZone: "America/New_York" });
    const steps = fake.queries.filter((query) => query.table === "casework_deadlines").map(({ calls }) => calls.find(([method]) => method === "select")[1][0]);
    expect(steps.at(-1)).toBe("case_id,id,label,due_at,status");
    const cases = fake.queries.filter((query) => query.table === "member_cases").map(({ calls }) => calls.find(([method]) => method === "select")[1][0]);
    expect(cases.at(-1)).not.toMatch(/time_zone/);
    // The recovered reads are not a reload failure: each failed probe is withdrawn (#9617 stage 580, r5s2/r6s2).
    expect(loader.stateForRoute("cases").refreshError).toBe("");
    expect(loader.failuresForResources(["table:casework_deadlines", "table:member_cases"])).toEqual([]);
    loader.dispose();
  });

// #9617 stage 580 (r5s1/r6s1): a case's own deadline is overdue once its day
// has passed in the zone it was set in, as Home and the database count it, and
// New York's for a row without one; never the browser's zone.
it.each([["Pacific/Kiritimati", true], ["America/New_York", false], [undefined, false]])(
  "marks a case deadline overdue on the day of its stored zone (%s)", async (zone, overdue) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // Noon UTC on November 27: already November 28 in Kiritimati, still the 27th in New York.
    vi.setSystemTime(new Date("2026-11-27T12:00:00Z"));
    try {
      const loader = createMemberSessionLoader(client([], zone), { id: "member" });
      const shown = (await loader.loadRoute("cases")).cases.find((item) => item.id === "case-1");
      expect(shown.overdue).toBe(overdue);
      // Home counts the same deadline's days on the same zone.
      expect(shown.nextDeadline).toMatchObject({ kind: "case", dueOn: "2026-11-27", timeZone: zone ?? "America/New_York" });
      expect(calendarDaysUntil(shown.nextDeadline.dueOn, new Date(), shown.nextDeadline.timeZone) < 0).toBe(overdue);
      loader.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

// #9678 round 1 (r1s1/r2s1), the same class on the step read: a refresh that
// kept earlier rows hands back those rows with the failure in refreshFailure.
// That missing column is recovered too, and its probe withdrawn.
it("recovers a refresh failure kept beside earlier rows, withdrawing its probe", async () => {
  const withdraw = vi.fn();
  const selects = [];
  const kept = {
    from() {
      const calls = [];
      let query;
      query = new Proxy({}, { get(_target, key) {
        if (key === "then") {
          const select = calls.find(([method]) => method === "select")[1][0];
          selects.push(select);
          const answer = /\btime_zone\b/.test(select)
            ? Object.defineProperty({ data: [MISSED], error: null, refreshFailure: { code: "42703", message: "column casework_deadlines.time_zone does not exist" } }, "withdraw", { value: withdraw })
            : { data: [{ ...MISSED, id: "d-fresh" }], error: null };
          return (resolve) => resolve(answer);
        }
        return (...args) => { if (typeof key === "string") calls.push([key, args]); return query; };
      } });
      return query;
    },
  };
  const { data, error } = await readOpenStepDeadlines(kept, ["case-1"]);
  expect(error).toBeNull();
  expect(data.map((row) => row.id)).toEqual(["d-fresh"]);
  expect(withdraw).toHaveBeenCalledTimes(1);
  expect(selects).toEqual(["case_id,id,label,due_at,status,time_zone", "case_id,id,label,due_at,status"]);
});
