// @vitest-environment node
// The reconciliation endpoint's whole job is byte-safety bookkeeping, so these
// tests pin the seams that matter: nothing runs without the cron bearer, the
// RPC's exact allowlisted bucket/name list is the ONLY thing that reaches the Storage API, batching
// never drops a name, and every failure mode answers non-2xx so the pg_net
// tick log shows it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler, { chunk, malformedReport } from "../api/task-files-reconcile.js";
// The handler reaches only an approved backend (api/_lib/providerBoundary.js).
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));

const SUPABASE_URL = "https://project.supabase.co";
const SECRET = "cron-test-secret-xxxxxxxxxxxxxxxxxxxxxxxx";

function makeRequest(method = "POST", token = SECRET) {
  return { method, headers: token === null ? {} : { authorization: `Bearer ${token}` } };
}

function makeResponse() {
  const out = { status: 0, headers: {}, body: null };
  return {
    out,
    status(code) { out.status = code; return this; },
    setHeader(k, v) { out.headers[k] = v; },
    end(payload) { out.body = JSON.parse(payload); },
  };
}

function report(overrides = {}) {
  return {
    staleRowsRemoved: 0,
    pendingRowsClaimed: 0,
    removalRowsRetired: 0,
    removalObjectTotal: 0,
    staleRowsSkippedBlind: 0,
    objectDeletes: [],
    expectedObjectsRemaining: [],
    objectDeleteTotal: 0,
    orphanObjects: [],
    orphanTotal: 0,
    ranAt: "2026-08-05T04:37:00Z",
    ...overrides,
  };
}

function legacyReport(overrides = {}) {
  const answer = report(overrides);
  delete answer.pendingRowsClaimed;
  delete answer.removalRowsRetired;
  delete answer.removalObjectTotal;
  delete answer.objectDeletes;
  delete answer.objectDeleteTotal;
  delete answer.expectedObjectsRemaining;
  return answer;
}

// deleteConfirm: "all" answers each batch with every requested object marked
// deleted (the healthy case); "none" answers 200 with an empty list — the
// permission-drift signature the handler must refuse to count as a sweep;
// "malformed" answers 200 with a non-array body; "mixed" confirms the first
// batch and silently confirms none of the second.
function installFetch({
  rpcReport = report(),
  rpcReports = null,
  rpcStatus = 200,
  deleteStatus = 200,
  deleteConfirm = "all",
  deleteError = null,
} = {}) {
  const calls = { rpc: [], deletes: [] };
  const fetchMock = vi.fn(async (url, init) => {
    const target = String(url);
    if (target.includes("/rest/v1/rpc/reconcile_chapter_task_files")) {
      calls.rpc.push({ body: JSON.parse(init.body), headers: init.headers });
      if (rpcStatus !== 200) return { ok: false, status: rpcStatus, text: async () => "" };
      const rpcIndex = calls.rpc.length - 1;
      const selectedReport = rpcReports?.[rpcIndex]
        ?? (rpcIndex === 0 ? rpcReport : report());
      if (selectedReport instanceof Error) throw selectedReport;
      return { ok: true, status: 200, text: async () => JSON.stringify(selectedReport) };
    }
    if ((target === `${SUPABASE_URL}/storage/v1/object/chapter-task-files`
      || target === `${SUPABASE_URL}/storage/v1/object/case-files`) && init.method === "DELETE") {
      const prefixes = JSON.parse(init.body).prefixes;
      calls.deletes.push({ bucket: target.split('/').at(-1), prefixes, headers: init.headers });
      if (deleteError) throw deleteError;
      if (deleteStatus !== 200) return { ok: false, status: deleteStatus, text: async () => "" };
      const bodyText = deleteConfirm === "malformed"
        ? JSON.stringify({ message: "ok" })
        : deleteConfirm === "invalid-json"
          ? "{"
          : JSON.stringify(deleteConfirm === "none"
            || (deleteConfirm === "mixed" && calls.deletes.length > 1)
            ? []
            : deleteConfirm === "wrong"
              ? prefixes.map((name) => ({ name: `${name}.wrong` }))
              : prefixes.map((name) => ({ name })));
      return { ok: true, status: 200, text: async () => bodyText };
    }
    throw new Error(`unexpected fetch ${target}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

async function run(request = makeRequest()) {
  const response = makeResponse();
  await handler(request, response);
  return response.out;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.stubEnv("VITE_SUPABASE_URL", SUPABASE_URL);
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "project");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-value");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("authorization gates", () => {
  it("rejects methods other than GET and POST", async () => {
    installFetch();
    expect((await run(makeRequest("DELETE"))).status).toBe(405);
  });

  it("rejects a wrong bearer without touching the database", async () => {
    const calls = installFetch();
    expect((await run(makeRequest("POST", "wrong"))).status).toBe(401);
    expect(calls.rpc).toHaveLength(0);
    expect(calls.deletes).toHaveLength(0);
  });

  it("rejects a missing authorization header", async () => {
    installFetch();
    expect((await run(makeRequest("GET", null))).status).toBe(401);
  });

  it("fails closed when no CRON_SECRET is configured, even for an empty bearer", async () => {
    installFetch();
    vi.stubEnv("CRON_SECRET", undefined);
    expect((await run(makeRequest("POST", ""))).status).toBe(403);
  });

  it("answers 503 when the Supabase configuration is missing", async () => {
    installFetch();
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", undefined);
    expect((await run()).status).toBe(503);
  });
});

describe("reconciliation pass", () => {
  it("asks the RPC for the capped orphan page", async () => {
    const calls = installFetch();
    await run();
    expect(calls.rpc).toHaveLength(1);
    expect(calls.rpc[0].body).toEqual({ p_max_orphan_objects: 500 });
  });

  it("reports a clean pass with no orphans and no delete calls", async () => {
    const calls = installFetch({
      rpcReport: report({
        staleRowsRemoved: 3,
        pendingRowsClaimed: 2,
        removalRowsRetired: 1,
        removalObjectTotal: 0,
      }),
    });
    const out = await run();
    expect(out.status).toBe(200);
    expect(out.body.staleRowsRemoved).toBe(3);
    expect(out.body.pendingRowsClaimed).toBe(2);
    expect(out.body.removalRowsRetired).toBe(1);
    expect(out.body.removalObjectTotal).toBe(0);
    expect(out.body.deletedObjects).toBe(0);
    expect(out.body.remainingOrphans).toBe(0);
    expect(calls.deletes).toHaveLength(0);
  });

  it("deletes every reported orphan through the Storage API in 100-name batches", async () => {
    const names = Array.from({ length: 250 }, (_, i) => `c1/t1/f${i}/doc.pdf`);
    const calls = installFetch({ rpcReport: legacyReport({ orphanObjects: names, orphanTotal: 300 }) });
    const out = await run();
    expect(out.status).toBe(200);
    expect(calls.deletes.map((d) => d.prefixes.length)).toEqual([100, 100, 50]);
    expect(calls.deletes.flatMap((d) => d.prefixes)).toEqual(names);
    // The delete rides the service key, not an anon key.
    expect(calls.deletes[0].headers.apikey).toBe("service-role-value");
    expect(calls.rpc[1].body).toEqual({ p_max_orphan_objects: 0 });
    expect(out.body.deletedObjects).toBe(250);
    // The RPC capped its page below the true total: the difference is next
    // tick's work and must be visible, never silently rolled forward.
    expect(out.body.remainingOrphans).toBe(50);
  });

  it("deletes only allowlisted exact paths from both private attachment buckets", async () => {
    const calls = installFetch({
      rpcReport: report({
        objectDeletes: [
          { bucketId: "case-files", objectName: "user/case/file/a.pdf" },
          { bucketId: "chapter-task-files", objectName: "chapter/task/file/b.pdf" },
        ],
        objectDeleteTotal: 2,
      }),
    });
    const out = await run();
    expect(out.status).toBe(200);
    expect(calls.deletes).toEqual(expect.arrayContaining([
      expect.objectContaining({ bucket: "case-files", prefixes: ["user/case/file/a.pdf"] }),
      expect.objectContaining({ bucket: "chapter-task-files", prefixes: ["chapter/task/file/b.pdf"] }),
    ]));
  });

  it("runs a second database pass after Storage deletion so stale pending rows become removable", async () => {
    const calls = installFetch({
      rpcReport: report({
        objectDeletes: [{ bucketId: "case-files", objectName: "user/case/file/a.pdf" }],
        objectDeleteTotal: 1,
      }),
    });
    const out = await run();
    expect(out.status).toBe(200);
    expect(calls.rpc).toHaveLength(2);
    expect(calls.rpc[1].body).toEqual({
      p_max_orphan_objects: 0,
      p_expected_deleted_objects: [
        { bucketId: "case-files", objectName: "user/case/file/a.pdf" },
      ],
    });
  });

  it("deduplicates repeated exact deletion targets before Storage mutation", async () => {
    const target = { bucketId: "case-files", objectName: "user/case/file/a.pdf" };
    const calls = installFetch({
      rpcReport: report({ objectDeletes: [target, target], objectDeleteTotal: 2 }),
    });

    const out = await run();

    expect(out.status).toBe(200);
    expect(calls.deletes).toHaveLength(1);
    expect(calls.deletes[0].prefixes).toEqual([target.objectName]);
  });

  it("accepts an empty Storage receipt only after exact post-delete absence proof", async () => {
    const target = { bucketId: "case-files", objectName: "user/case/file/concurrent.pdf" };
    const calls = installFetch({
      rpcReports: [
        report({ objectDeletes: [target], objectDeleteTotal: 1 }),
        report({ expectedObjectsRemaining: [] }),
      ],
      deleteConfirm: "none",
    });

    const out = await run();

    expect(out.status).toBe(200);
    expect(out.body.deletedObjects).toBe(0);
    expect(out.body.alreadyAbsentObjects).toBe(1);
    expect(out.body.remainingOrphans).toBe(0);
    expect(calls.rpc[1].body.p_expected_deleted_objects).toEqual([target]);
  });

  it("ignores non-string entries in the orphan list", async () => {
    const calls = installFetch({ rpcReport: legacyReport({ orphanObjects: ["a/b/c/x.pdf", null, 7, ""], orphanTotal: 1 }) });
    const out = await run();
    expect(out.status).toBe(200);
    expect(calls.deletes).toHaveLength(1);
    expect(calls.deletes[0].prefixes).toEqual(["a/b/c/x.pdf"]);
  });
});

describe("failure surfaces", () => {
  it("answers 500 and deletes nothing when the RPC fails", async () => {
    const calls = installFetch({ rpcStatus: 500 });
    const out = await run();
    expect(out.status).toBe(500);
    expect(calls.deletes).toHaveLength(0);
  });

  it("answers 500 and deletes nothing when the RPC report lost its shape", async () => {
    const calls = installFetch({ rpcReport: { staleRowsRemoved: 1 } });
    const out = await run();
    expect(out.status).toBe(500);
    expect(out.body.error).toMatch(/malformed/);
    expect(calls.deletes).toHaveLength(0);
  });

  it("refuses to count a 200-with-empty-list as a sweep", async () => {
    const names = ["c1/t1/f1/doc.pdf", "c1/t1/f2/doc.pdf"];
    installFetch({
      rpcReports: [
        legacyReport({ orphanObjects: names, orphanTotal: 2 }),
        report({
          expectedObjectsRemaining: names.map((objectName) => ({
            bucketId: "chapter-task-files",
            objectName,
          })),
        }),
      ],
      deleteConfirm: "none",
    });
    const out = await run();
    expect(out.status).toBe(502);
    expect(out.body.deletedObjects).toBe(0);
    expect(out.body.requestedObjects).toBe(2);
    expect(out.body.remainingOrphans).toBe(2);
    expect(out.body.error).toMatch(/exact|batch|deletion/);
  });

  it("keeps an empty Storage receipt unresolved when both RPC passes use the deployed legacy shape", async () => {
    const names = ["c1/t1/f1/legacy-a.pdf", "c1/t1/f2/legacy-b.pdf"];
    const calls = installFetch({
      rpcReports: [
        legacyReport({ orphanObjects: names, orphanTotal: names.length }),
        legacyReport(),
      ],
      deleteConfirm: "none",
    });

    const out = await run();

    expect(out.status).toBe(502);
    expect(out.body.deletedObjects).toBe(0);
    expect(out.body.alreadyAbsentObjects).toBe(0);
    expect(out.body.remainingOrphans).toBe(names.length);
    expect(calls.rpc[1].body).toEqual({ p_max_orphan_objects: 0 });
  });

  it("refuses a mixed exact and empty Storage batch instead of returning partial success", async () => {
    const names = Array.from({ length: 101 }, (_, index) => `c1/t1/f${index}/doc.pdf`);
    installFetch({
      rpcReports: [
        legacyReport({ orphanObjects: names, orphanTotal: names.length }),
        report({
          expectedObjectsRemaining: [{
            bucketId: "chapter-task-files",
            objectName: names.at(-1),
          }],
        }),
      ],
      deleteConfirm: "mixed",
    });
    const out = await run();
    expect(out.status).toBe(502);
    expect(out.body.requestedObjects).toBe(101);
    expect(out.body.deletedObjects).toBe(100);
    expect(out.body.remainingOrphans).toBe(1);
    expect(out.body.error).toMatch(/exact|batch|partial/);
  });

  it("refuses a 2xx Storage response that names a different object", async () => {
    const names = ["c1/t1/f1/doc.pdf"];
    installFetch({ rpcReport: legacyReport({ orphanObjects: names, orphanTotal: 1 }), deleteConfirm: "wrong" });
    const out = await run();
    expect(out.status).toBe(502);
    expect(out.body.deletedObjects).toBe(0);
    expect(out.body.error).toMatch(/exact|confirm|batch/);
  });

  it("treats a non-array storage response as a failed batch", async () => {
    installFetch({ rpcReport: legacyReport({ orphanObjects: ["c1/t1/f1/doc.pdf"], orphanTotal: 1 }), deleteConfirm: "malformed" });
    const out = await run();
    expect(out.status).toBe(502);
    expect(out.body.deletedObjects).toBe(0);
  });

  it("treats unparseable Storage JSON as a hard failed batch", async () => {
    installFetch({
      rpcReport: legacyReport({ orphanObjects: ["c1/t1/f1/doc.pdf"], orphanTotal: 1 }),
      deleteConfirm: "invalid-json",
    });

    const out = await run();

    expect(out.status).toBe(502);
    expect(out.body.deletedObjects).toBe(0);
  });

  it.each([
    ["TimeoutError", "timeout"],
    ["TypeError", "network"],
  ])("keeps a Storage %s unresolved when the deployed RPC cannot prove exact absence", async (name, expectedReason) => {
    const error = new Error("delete unavailable");
    error.name = name;
    installFetch({
      rpcReport: legacyReport({ orphanObjects: ["c1/t1/f1/doc.pdf"], orphanTotal: 1 }),
      deleteError: error,
    });

    const out = await run();

    expect(out.status).toBe(502);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(expectedReason));
  });

  it.each([
    ["TimeoutError", "timeout"],
    ["TypeError", "network"],
  ])("accepts a Storage %s only after the new RPC proves the exact object absent", async (name, expectedReason) => {
    const target = { bucketId: "case-files", objectName: "user/case/file/concurrent.pdf" };
    const error = new Error("delete result unavailable");
    error.name = name;
    installFetch({
      rpcReports: [
        report({ objectDeletes: [target], objectDeleteTotal: 1 }),
        report({ expectedObjectsRemaining: [] }),
      ],
      deleteError: error,
    });

    const out = await run();

    expect(out.status).toBe(200);
    expect(out.body.deletedObjects).toBe(0);
    expect(out.body.alreadyAbsentObjects).toBe(1);
    expect(out.body.remainingOrphans).toBe(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(expectedReason));
  });

  it("rejects an uncertain Storage delete when exact post-delete proof still finds the object", async () => {
    const target = { bucketId: "case-files", objectName: "user/case/file/still-there.pdf" };
    const error = new Error("delete result unavailable");
    error.name = "TimeoutError";
    installFetch({
      rpcReports: [
        report({ objectDeletes: [target], objectDeleteTotal: 1 }),
        report({ expectedObjectsRemaining: [target] }),
      ],
      deleteError: error,
    });

    const out = await run();

    expect(out.status).toBe(502);
    expect(out.body.alreadyAbsentObjects).toBe(0);
    expect(out.body.remainingOrphans).toBe(1);
  });

  it("fails when the authoritative post-delete RPC is unavailable", async () => {
    const target = { bucketId: "case-files", objectName: "user/case/file/a.pdf" };
    installFetch({
      rpcReports: [
        report({ objectDeletes: [target], objectDeleteTotal: 1 }),
        new Error("post-delete unavailable"),
      ],
    });

    const out = await run();

    expect(out).toMatchObject({ status: 500, body: { error: "post-delete unavailable" } });
  });

  it("rejects a post-delete report without required exact-absence evidence", async () => {
    const target = { bucketId: "case-files", objectName: "user/case/file/a.pdf" };
    const cleanup = report();
    delete cleanup.expectedObjectsRemaining;
    installFetch({
      rpcReports: [report({ objectDeletes: [target], objectDeleteTotal: 1 }), cleanup],
    });

    const out = await run();

    expect(out).toMatchObject({ status: 500, body: { error: "malformed post-delete reconcile report" } });
  });

  it("rejects exact-absence evidence naming an unrequested object", async () => {
    const target = { bucketId: "case-files", objectName: "user/case/file/a.pdf" };
    const other = { bucketId: "case-files", objectName: "user/case/file/other.pdf" };
    installFetch({
      rpcReports: [
        report({ objectDeletes: [target], objectDeleteTotal: 1 }),
        report({ expectedObjectsRemaining: [other] }),
      ],
    });

    const out = await run();

    expect(out).toMatchObject({ status: 500, body: { error: "malformed post-delete reconcile report" } });
  });

  it("answers 502 when an object-delete batch fails", async () => {
    const names = Array.from({ length: 3 }, (_, i) => `c1/t1/f${i}/doc.pdf`);
    installFetch({ rpcReport: legacyReport({ orphanObjects: names, orphanTotal: 3 }), deleteStatus: 500 });
    const out = await run();
    expect(out.status).toBe(502);
    expect(out.body.deletedObjects).toBe(0);
    expect(out.body.remainingOrphans).toBe(3);
    expect(out.body.error).toMatch(/batch/);
  });

  it("answers 500 when the RPC refused stale-row deletion as blind, after still sweeping orphans", async () => {
    const calls = installFetch({
      rpcReport: legacyReport({ staleRowsSkippedBlind: 4, orphanObjects: ["a/b/c/x.pdf"], orphanTotal: 1 }),
    });
    const out = await run();
    expect(out.status).toBe(500);
    expect(out.body.staleRowsSkippedBlind).toBe(4);
    expect(out.body.error).toMatch(/blind|see the bucket/);
    // The blind guard protects ROW deletion; orphan objects are still
    // independently safe to sweep and the pass must not waste the trip.
    expect(calls.deletes).toHaveLength(1);
  });
});

describe("chunk", () => {
  it("splits without losing or duplicating items", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 100)).toEqual([]);
    expect(chunk([1], 1)).toEqual([[1]]);
  });
});

describe("malformedReport", () => {
  it("accepts the RPC's real shape and rejects everything else", () => {
    expect(malformedReport(report())).toBe(false);
    expect(malformedReport(null)).toBe(true);
    expect(malformedReport([])).toBe(true);
    expect(malformedReport({})).toBe(true);
    expect(malformedReport(report({ orphanObjects: "nope" }))).toBe(true);
    expect(malformedReport(report({ orphanTotal: "many" }))).toBe(true);
    expect(malformedReport(report({ objectDeletes: {} }))).toBe(true);
    expect(malformedReport(report({ expectedObjectsRemaining: "nope" }))).toBe(true);
    expect(malformedReport(report({
      expectedObjectsRemaining: [{ bucketId: "public-files", objectName: "not-allowed" }],
    }))).toBe(true);
    const missingExpectedObjects = report();
    delete missingExpectedObjects.expectedObjectsRemaining;
    expect(malformedReport(missingExpectedObjects, { requireExpectedObjects: true })).toBe(true);
    expect(malformedReport(report({
      objectDeletes: [{ bucketId: "public-files", objectName: "not-allowed" }],
      objectDeleteTotal: 1,
    }))).toBe(true);
    const missing = report();
    delete missing.staleRowsSkippedBlind;
    expect(malformedReport(missing)).toBe(true);
    const missingClaimCounter = report();
    delete missingClaimCounter.pendingRowsClaimed;
    expect(malformedReport(missingClaimCounter)).toBe(true);
    const missingRemovalCounter = report();
    delete missingRemovalCounter.removalRowsRetired;
    expect(malformedReport(missingRemovalCounter)).toBe(true);
  });

  it("requires real nonnegative safe-integer counters", () => {
    for (const key of [
      "staleRowsRemoved",
      "pendingRowsClaimed",
      "removalRowsRetired",
      "removalObjectTotal",
      "staleRowsSkippedBlind",
      "objectDeleteTotal",
      "orphanTotal",
    ]) {
      for (const value of [-1, 0.5, "1", Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY]) {
        expect(malformedReport(report({ [key]: value })), `${key}=${String(value)}`).toBe(true);
      }
    }
  });

  it("refuses totals smaller than the unique deletion page", () => {
    expect(malformedReport(report({
      objectDeletes: [
        { bucketId: "case-files", objectName: "user/case/file/a.pdf" },
        { bucketId: "case-files", objectName: "user/case/file/a.pdf" },
        { bucketId: "chapter-task-files", objectName: "chapter/task/file/b.pdf" },
      ],
      objectDeleteTotal: 1,
    }))).toBe(true);

    expect(malformedReport(legacyReport({
      orphanObjects: ["chapter/task/file/a.pdf", "chapter/task/file/a.pdf", "chapter/task/file/b.pdf"],
      orphanTotal: 1,
    }))).toBe(true);

    expect(malformedReport(report({
      removalObjectTotal: 2,
      objectDeleteTotal: 1,
    }))).toBe(true);
  });

  it("requires a parseable reconciliation timestamp", () => {
    expect(malformedReport(report({ ranAt: "not-a-timestamp" }))).toBe(true);
    expect(malformedReport(report({ ranAt: 1_788_455_820_000 }))).toBe(true);
  });
});
