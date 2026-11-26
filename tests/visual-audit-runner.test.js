// @vitest-environment node

import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as visualAudit from "../scripts/visual-audit.mjs";
import {
  collectVisualMeasurements,
  classifyVisualMeasurements,
  renderVisualAuditMarkdown,
  settleVisualAuditSurface,
} from "../scripts/visual-audit.mjs";
import { resolveVisualAuditViewports } from "../scripts/visual-audit-presets.mjs";
import {
  attachInitialStewardDeskBatch,
  createInitialStewardDeskBatchTracker,
  createInitialStewardDeskRuntimeCapture,
  renderVisualAuditFailureLines,
  resolveInitialStewardDeskProofMode,
  summarizeInitialStewardDeskFailure,
} from "../scripts/visual-audit-runner.mjs";

const fixtureUrl = new URL("./fixtures/visual-audit.html", import.meta.url).href;
const STEWARD_DESK_RPCS = [
  "list_steward_requests",
  "list_steward_conversations",
  "list_steward_broadcasts",
  "list_steward_forms",
  "get_steward_desk_kpis",
];

function completeStewardDeskBatch(tracker, { durationMs = 7999, reverse = false } = {}) {
  const calls = reverse ? [...STEWARD_DESK_RPCS].reverse() : STEWARD_DESK_RPCS;
  for (const rpc of calls) {
    const requestKey = `request-${rpc}`;
    tracker.observeRequest({ requestKey, rpc, atMs: 0 });
  }
  for (const rpc of calls) {
    const requestKey = `request-${rpc}`;
    tracker.observeResponse({ requestKey, atMs: durationMs, httpStatus: 200 });
  }
  return tracker.finalize({ atMs: durationMs + 100 });
}

describe("visual audit browser runner", () => {
  it("permits a credential-free proof exception only on an explicit HTTP loopback target", () => {
    expect(resolveInitialStewardDeskProofMode({
      requestedMode: "credential-free-preview",
      targetUrl: "http://127.0.0.1:4173",
    })).toEqual({
      mode: "credential-free-preview",
      initialBatch: { status: "not-applicable", reason: "credential-free-preview" },
    });
    expect(resolveInitialStewardDeskProofMode({ targetUrl: "https://app.example.org" }))
      .toEqual({ mode: "required", initialBatch: null });
    for (const targetUrl of ["https://app.example.org", "https://127.0.0.1", "http://app.example.org"]) {
      expect(() => resolveInitialStewardDeskProofMode({
        requestedMode: "credential-free-preview",
        targetUrl,
      })).toThrow(/HTTP loopback target/);
    }
    expect(() => resolveInitialStewardDeskProofMode({
      requestedMode: "disabled",
      targetUrl: "http://127.0.0.1:4173",
    })).toThrow(/must be required or credential-free-preview/);
  });

  it("freezes out-of-order initial Steward desk completions into five canonical sanitized calls", () => {
    const tracker = createInitialStewardDeskBatchTracker({ now: () => 0 });
    const batch = completeStewardDeskBatch(tracker, { reverse: true });

    expect(batch).toMatchObject({ status: "passed", thresholdMs: 8000 });
    expect(batch.calls.map((call) => call.rpc)).toEqual(STEWARD_DESK_RPCS);
    expect(batch.calls.every((call) => call.attempts === 1 && call.httpStatus === 200 && call.postgresCode === null && call.outcome === "passed")).toBe(true);
    expect(JSON.stringify(batch)).not.toMatch(/request-|secret|body|identity|url/i);
  });

  it("fails a direct tracker with no allowlisted requests and makes threshold equality fail", () => {
    const noBatch = createInitialStewardDeskBatchTracker({ now: () => 0 });
    noBatch.observeRequest({ requestKey: "unknown", rpc: "unrelated_rpc", atMs: 0 });
    const emptyBatch = noBatch.finalize({ atMs: 1 });
    expect(emptyBatch).toMatchObject({ status: "failed", thresholdMs: 8000 });
    expect(emptyBatch.calls).toEqual(STEWARD_DESK_RPCS.map((rpc) => expect.objectContaining({
      rpc,
      attempts: 0,
      outcome: "missing",
    })));
    expect(noBatch.finalize({ atMs: 2 })).toBe(emptyBatch);

    const passing = createInitialStewardDeskBatchTracker({ now: () => 0 });
    expect(completeStewardDeskBatch(passing, { durationMs: 7999 }).status).toBe("passed");

    const timedOut = createInitialStewardDeskBatchTracker({ now: () => 0 });
    expect(completeStewardDeskBatch(timedOut, { durationMs: 8000 }).status).toBe("failed");

    const fractionalPass = createInitialStewardDeskBatchTracker({ now: () => 0 });
    expect(completeStewardDeskBatch(fractionalPass, { durationMs: 7998.01 }).calls[0]).toMatchObject({ durationMs: 7999, outcome: "passed" });
    const fractionalFail = createInitialStewardDeskBatchTracker({ now: () => 0 });
    expect(completeStewardDeskBatch(fractionalFail, { durationMs: 7999.01 }).calls[0]).toMatchObject({ durationMs: 8000, outcome: "timeout" });
  });

  it("fails an armed empty runtime capture but preserves null for an unarmed fixture", async () => {
    const unarmed = createInitialStewardDeskRuntimeCapture({
      belongsToCurrentTarget: () => true,
      now: () => 0,
    });
    expect(await unarmed.finalize()).toBeNull();

    const armed = createInitialStewardDeskRuntimeCapture({
      belongsToCurrentTarget: () => true,
      now: () => 0,
    });
    armed.arm();
    const batch = await armed.finalize();
    expect(batch).toMatchObject({ status: "failed", thresholdMs: 8000 });
    expect(batch.calls).toEqual(STEWARD_DESK_RPCS.map((rpc) => expect.objectContaining({
      rpc,
      attempts: 0,
      outcome: "missing",
    })));
    expect(await armed.finalize()).toBe(batch);

    const attached = attachInitialStewardDeskBatch({ failures: [] }, batch, { route: "/m", viewport: { width: 1280, height: 900 } });
    expect(attached.findings).toHaveLength(1);
    expect(attached.findings[0]).toMatchObject({ rule: "steward-desk-performance", severity: "failure" });
  });

  it("fails missing, pending, duplicate, HTTP, SQLSTATE, and network outcomes without serializing request inputs", () => {
    const cases = [
      (tracker) => {
        tracker.observeRequest({ requestKey: "pending-one", rpc: STEWARD_DESK_RPCS[0], atMs: 0 });
      },
      (tracker) => {
        tracker.observeRequest({ requestKey: "duplicate-a", rpc: STEWARD_DESK_RPCS[0], atMs: 0 });
        tracker.observeRequest({ requestKey: "duplicate-b", rpc: STEWARD_DESK_RPCS[0], atMs: 1 });
      },
      (tracker) => {
        tracker.observeRequest({ requestKey: "http-one", rpc: STEWARD_DESK_RPCS[0], atMs: 0 });
        tracker.observeResponse({ requestKey: "http-one", atMs: 4, httpStatus: 503, postgresCode: "57014", url: "https://secret.test/?token=secret" });
      },
      (tracker) => {
        tracker.observeRequest({ requestKey: "network-one", rpc: STEWARD_DESK_RPCS[0], atMs: 0, body: "secret" });
        tracker.observeRequestFailed({ requestKey: "network-one", atMs: 4, error: "secret" });
      },
    ];
    for (const setup of cases) {
      const tracker = createInitialStewardDeskBatchTracker({ now: () => 0 });
      for (const [index, rpc] of STEWARD_DESK_RPCS.slice(1).entries()) {
        const requestKey = `passing-${rpc}`;
        tracker.observeRequest({ requestKey, rpc, atMs: index * 10 });
        tracker.observeResponse({ requestKey, atMs: index * 10 + 10, httpStatus: 200 });
      }
      setup(tracker);
      const batch = tracker.finalize({ atMs: 100 });
      expect(batch.status).toBe("failed");
      expect(JSON.stringify(batch)).not.toContain("secret");
      expect(batch.calls).toHaveLength(5);
    }
  });

  it("fails an unobserved mandatory RPC and malformed transport evidence", () => {
    const missing = createInitialStewardDeskBatchTracker({ now: () => 0 });
    for (const rpc of STEWARD_DESK_RPCS.slice(1)) {
      missing.observeRequest({ requestKey: `missing-${rpc}`, rpc, atMs: 0 });
      missing.observeResponse({ requestKey: `missing-${rpc}`, atMs: 10, httpStatus: 200 });
    }
    const missingBatch = missing.finalize({ atMs: 20 });
    expect(missingBatch).toMatchObject({ status: "failed" });
    expect(missingBatch.calls[0]).toMatchObject({ attempts: 0, outcome: "missing" });

    for (const malformedResponse of [
      { requestKey: "bad-status", atMs: 10, httpStatus: "200" },
      { requestKey: "bad-clock", atMs: -1, httpStatus: 200 },
    ]) {
      const malformed = createInitialStewardDeskBatchTracker({ now: () => 0 });
      for (const rpc of STEWARD_DESK_RPCS) malformed.observeRequest({ requestKey: `${malformedResponse.requestKey}-${rpc}`, rpc, atMs: 0 });
      malformed.observeResponse({ ...malformedResponse, requestKey: `${malformedResponse.requestKey}-${STEWARD_DESK_RPCS[0]}` });
      for (const rpc of STEWARD_DESK_RPCS.slice(1)) {
        malformed.observeResponse({ requestKey: `${malformedResponse.requestKey}-${rpc}`, atMs: 10, httpStatus: 200 });
      }
      const batch = malformed.finalize({ atMs: 20 });
      expect(batch).toMatchObject({ status: "failed" });
      expect(batch.calls[0]).toMatchObject({ outcome: "malformed" });
    }
  });

  it("fails a fully completed duplicate but discards malformed non-SQLSTATE response content", () => {
    const duplicate = createInitialStewardDeskBatchTracker({ now: () => 0 });
    for (const rpc of STEWARD_DESK_RPCS) duplicate.observeRequest({ requestKey: `duplicate-${rpc}`, rpc, atMs: 0 });
    for (const rpc of STEWARD_DESK_RPCS) duplicate.observeResponse({ requestKey: `duplicate-${rpc}`, atMs: 10, httpStatus: 200 });
    duplicate.observeRequest({ requestKey: "duplicate-complete", rpc: STEWARD_DESK_RPCS[0], atMs: 0 });
    duplicate.observeResponse({ requestKey: "duplicate-complete", atMs: 10, httpStatus: 200 });
    const duplicateBatch = duplicate.finalize({ atMs: 20 });
    expect(duplicateBatch.status).toBe("failed");
    expect(duplicateBatch.calls[0]).toMatchObject({ attempts: 2, outcome: "duplicate" });

    const malformedCode = createInitialStewardDeskBatchTracker({ now: () => 0 });
    for (const rpc of STEWARD_DESK_RPCS) malformedCode.observeRequest({ requestKey: `malformed-${rpc}`, rpc, atMs: 0 });
    for (const rpc of STEWARD_DESK_RPCS) {
      malformedCode.observeResponse({
        requestKey: `malformed-${rpc}`,
        atMs: 10,
        httpStatus: 200,
        postgresCode: rpc === STEWARD_DESK_RPCS[0] ? "not-a-code-secret" : undefined,
      });
    }
    const malformedCodeBatch = malformedCode.finalize({ atMs: 20 });
    expect(malformedCodeBatch).toMatchObject({ status: "passed" });
    expect(malformedCodeBatch.calls[0]).toMatchObject({ postgresCode: null, outcome: "passed" });
    expect(JSON.stringify(malformedCodeBatch)).not.toContain("secret");
  });

  it("fails a valid PostgreSQL SQLSTATE even when the HTTP response is successful", () => {
    const tracker = createInitialStewardDeskBatchTracker({ now: () => 0 });
    for (const rpc of STEWARD_DESK_RPCS) tracker.observeRequest({ requestKey: `sqlstate-${rpc}`, rpc, atMs: 0 });
    for (const rpc of STEWARD_DESK_RPCS) {
      tracker.observeResponse({
        requestKey: `sqlstate-${rpc}`,
        atMs: 10,
        httpStatus: 200,
        postgresCode: rpc === STEWARD_DESK_RPCS[0] ? "57014" : undefined,
      });
    }
    const batch = tracker.finalize({ atMs: 20 });
    expect(batch).toMatchObject({ status: "failed" });
    expect(batch.calls[0]).toMatchObject({ postgresCode: "57014", outcome: "postgres-failed" });
  });

  it("ignores old request keys, freezes idempotently, and isolates two cold entries", () => {
    const first = createInitialStewardDeskBatchTracker({ now: () => 0 });
    const firstBatch = completeStewardDeskBatch(first);
    first.observeResponse({ requestKey: "old-request", atMs: 1, httpStatus: 500 });
    expect(first.finalize({ atMs: 100 })).toBe(firstBatch);

    const second = createInitialStewardDeskBatchTracker({ now: () => 0 });
    second.observeResponse({ requestKey: "request-list_steward_requests", atMs: 1, httpStatus: 500 });
    const secondBatch = completeStewardDeskBatch(second);
    expect(secondBatch).not.toBe(firstBatch);
    expect(secondBatch.status).toBe("passed");
  });

  it("rechecks runtime generation after asynchronous response parsing before mutating a batch", async () => {
    let current = true;
    let releasePostgresCode;
    const pendingPostgresCode = new Promise((resolve) => { releasePostgresCode = resolve; });
    const capture = createInitialStewardDeskRuntimeCapture({
      belongsToCurrentTarget: () => current,
      readPostgresCode: async () => pendingPostgresCode,
      now: () => 0,
    });
    capture.arm();
    capture.observeRequest({ requestKey: "old-generation", rpc: STEWARD_DESK_RPCS[0], atMs: 0 });
    const response = capture.observeResponse({ requestKey: "old-generation", atMs: 4, httpStatus: 500 });
    current = false;
    releasePostgresCode("57014");
    await response;
    const batch = await capture.finalize({ atMs: 5 });
    expect(batch.calls[0]).toMatchObject({ outcome: "pending", postgresCode: null });
  });

  it("drains response completion before conservatively timing and skips successful response bodies", async () => {
    let releaseCompletion;
    const completion = new Promise((resolve) => { releaseCompletion = resolve; });
    let completed = false;
    let bodyReads = 0;
    const capture = createInitialStewardDeskRuntimeCapture({
      belongsToCurrentTarget: () => true,
      waitForResponseCompletion: async () => completion,
      responseCompletedAt: () => completed ? 7999.01 : 1,
      readPostgresCode: async () => {
        bodyReads += 1;
        return "57014";
      },
      now: () => 0,
    });
    capture.arm();
    capture.observeRequest({ requestKey: "slow-response", rpc: STEWARD_DESK_RPCS[0], atMs: 0 });
    capture.observeResponse({ requestKey: "slow-response", httpStatus: 200, response: {} });
    let finalized = false;
    const batchPromise = capture.finalize().then((batch) => {
      finalized = true;
      return batch;
    });
    await Promise.resolve();
    expect(finalized).toBe(false);
    completed = true;
    releaseCompletion();
    const batch = await batchPromise;
    expect(bodyReads).toBe(0);
    expect(batch.calls[0]).toMatchObject({ durationMs: 8000, outcome: "timeout", postgresCode: null });
  });

  it("bounds stalled response completion and freezes a sanitized failed batch", async () => {
    const capture = createInitialStewardDeskRuntimeCapture({
      belongsToCurrentTarget: () => true,
      waitForResponseCompletion: async () => new Promise(() => {}),
      raceWithTimeout: async (_completion, timeoutMs) => ({ status: "timed-out", timeoutMs }),
      now: () => 0,
    });
    capture.arm();
    capture.observeRequest({ requestKey: "stalled", rpc: STEWARD_DESK_RPCS[0], atMs: 0 });
    capture.observeResponse({ requestKey: "stalled", httpStatus: 200, response: {} });
    const outcome = await Promise.race([
      capture.finalize().then((batch) => ({ kind: "resolved", batch })),
      new Promise((resolve) => setTimeout(() => resolve({ kind: "stalled" }), 50)),
    ]);
    expect(outcome.kind).toBe("resolved");
    expect(outcome.batch.calls[0]).toMatchObject({ outcome: "network-failed", postgresCode: null });
    expect(JSON.stringify(outcome.batch)).not.toContain("stalled");
  });

  it("attaches one separate performance finding to success and failure surface artifacts", () => {
    const passed = completeStewardDeskBatch(createInitialStewardDeskBatchTracker({ now: () => 0 }));
    const failedTracker = createInitialStewardDeskBatchTracker({ now: () => 0 });
    failedTracker.observeRequest({ requestKey: "only-one", rpc: STEWARD_DESK_RPCS[0], atMs: 0 });
    const failed = failedTracker.finalize({ atMs: 1 });
    const context = { route: "/m", viewport: { width: 1280, height: 900 } };

    const successArtifact = attachInitialStewardDeskBatch({ failures: [], route: "/m" }, passed, context);
    const failureArtifact = attachInitialStewardDeskBatch({ failures: [], route: "/m" }, failed, context);

    expect(successArtifact.surface.initialStewardDeskBatch).toBe(passed);
    expect(successArtifact.findings).toEqual([]);
    expect(failureArtifact.surface.initialStewardDeskBatch).toBe(failed);
    expect(failureArtifact.findings).toHaveLength(1);
    expect(failureArtifact.findings[0]).toMatchObject({ rule: "steward-desk-performance", severity: "failure", route: "/m" });
    expect(failureArtifact.findings.filter((finding) => finding.rule === "steward-desk-performance")).toHaveLength(1);
    expect(failureArtifact.findings[0]).toMatchObject({
      diagnostic_type: "prerequisite",
      root_cause: { rpc: "list_steward_requests", outcome: "pending" },
      consequences: expect.arrayContaining(["Steward target selection, stable-surface waiting, and visual measurement were not executed"]),
    });
  });

  it("prints one initial prerequisite root and labelled consequences instead of a failure cascade", () => {
    const root = { rpc: "list_steward_broadcasts", outcome: "network-failed", httpStatus: null, postgresCode: null, durationMs: 12 };
    const report = {
      surfaces: [{
        route: "/m",
        viewport: { width: 390, height: 844 },
        initialStewardDeskBatch: {
          status: "failed",
          calls: [
            { rpc: "list_steward_requests", outcome: "passed" },
            { rpc: "list_steward_conversations", outcome: "passed" },
            root,
            { rpc: "list_steward_forms", outcome: "passed" },
            { rpc: "get_steward_desk_kpis", outcome: "missing" },
          ],
        },
        failures: [],
      }],
      failures: [
        { rule: "network-error", route: "/m", viewport: { width: 390, height: 844 }, explanation: "duplicate transport" },
        { rule: "http-error", route: "/m", viewport: { width: 390, height: 844 }, explanation: "HTTP 503 app: /rest/v1/rpc/list_steward_broadcasts" },
        { rule: "route-error", route: "/m", viewport: { width: 390, height: 844 }, explanation: "target selection consequence" },
      ],
    };
    const lines = renderVisualAuditFailureLines(report);
    expect(lines.filter((line) => line.startsWith("FAIL "))).toEqual([
      "FAIL steward-desk-rpc /m 390x844 rpc=list_steward_broadcasts http=none sqlstate=none durationMs=12 outcome=network-failed",
      "FAIL network-error /m 390x844: duplicate transport",
    ]);
    expect(lines).toContain("CONSEQUENCE steward-desk-rpc /m 390x844 rpc=get_steward_desk_kpis http=none sqlstate=none durationMs=none outcome=missing");
    expect(lines).toContain("CONSEQUENCE http-error /m 390x844: HTTP 503 app: /rest/v1/rpc/list_steward_broadcasts");
    expect(lines).toContain("CONSEQUENCE steward-desk-prerequisite /m 390x844: Steward target selection, stable-surface waiting, and visual measurement were not executed");
    expect(summarizeInitialStewardDeskFailure(report.surfaces[0].initialStewardDeskBatch).rootCause).toBe(root);
  });

  it.each(["missing", "pending"])("retains a route failure when RPC capture is only %s", (outcome) => {
    const failure = { rule: "route-error", route: "/m", viewport: { width: 390, height: 844 }, explanation: "route failed before capture" };
    const report = {
      surfaces: [{
        route: failure.route,
        viewport: failure.viewport,
        failures: [failure],
        initialStewardDeskBatch: {
          status: "failed",
          calls: STEWARD_DESK_RPCS.map((rpc) => ({ rpc, outcome })),
        },
      }],
      failures: [failure],
    };
    const original = JSON.stringify(report);
    expect(renderVisualAuditFailureLines(report)).toContain("FAIL route-error /m 390x844: route failed before capture");
    expect(JSON.stringify(report)).toBe(original);
  });

  it("ranks transport failures above timeout and prints every failed RPC with full detail", () => {
    const report = {
      surfaces: [{
        route: "/m",
        inspected: 4,
        viewport: { width: 1280, height: 900 },
        initialStewardDeskBatch: {
          status: "failed",
          calls: [
            { rpc: "list_steward_requests", outcome: "missing", attempts: 0, httpStatus: null, postgresCode: null, durationMs: null },
            { rpc: "list_steward_conversations", outcome: "http-failed", attempts: 1, httpStatus: 500, postgresCode: "57014", durationMs: 23 },
            { rpc: "list_steward_broadcasts", outcome: "timeout", attempts: 1, httpStatus: 200, postgresCode: null, durationMs: 8000 },
            { rpc: "list_steward_forms", outcome: "passed" },
            { rpc: "get_steward_desk_kpis", outcome: "passed" },
          ],
        },
        failures: [],
      }],
      failures: [],
    };
    const lines = renderVisualAuditFailureLines(report);
    expect(lines).toContain("FAIL steward-desk-rpc /m 1280x900 rpc=list_steward_conversations http=500 sqlstate=57014 durationMs=23 outcome=http-failed");
    expect(lines).toContain("CONSEQUENCE steward-desk-rpc /m 1280x900 rpc=list_steward_requests http=none sqlstate=none durationMs=none outcome=missing");
    expect(lines).toContain("CONSEQUENCE steward-desk-rpc /m 1280x900 rpc=list_steward_broadcasts http=200 sqlstate=none durationMs=8000 outcome=timeout");
    expect(lines.some((line) => line.includes("visual measurement were not executed"))).toBe(false);
    expect(summarizeInitialStewardDeskFailure(report.surfaces[0].initialStewardDeskBatch, { inspected: 4 }).rootCause.rpc)
      .toBe("list_steward_conversations");
  });

  it("keeps unrelated runtime findings as FAIL on a measured latency-failed surface", () => {
    const batch = {
      status: "failed",
      calls: [
        ...STEWARD_DESK_RPCS.slice(0, 1).map((rpc) => ({ rpc, outcome: "timeout", httpStatus: 200, durationMs: 8000 })),
        ...STEWARD_DESK_RPCS.slice(1).map((rpc) => ({ rpc, outcome: "passed", httpStatus: 200, durationMs: 10 })),
      ],
    };
    const surface = {
      route: "/m",
      inspected: 7,
      viewport: { width: 1280, height: 900 },
      initialStewardDeskBatch: batch,
      failures: [],
    };
    const attached = attachInitialStewardDeskBatch(surface, batch, { route: "/m", viewport: surface.viewport });
    surface.failures = [
      ...attached.findings,
      { rule: "console-error", route: "/m", viewport: surface.viewport, explanation: "Console error: TypeError: product bug" },
      { rule: "page-error", route: "/m", viewport: surface.viewport, explanation: "Page error: ReferenceError: product bug" },
      { rule: "http-error", route: "/m", viewport: surface.viewport, explanation: "HTTP 500 app: /api/unrelated" },
      { rule: "network-error", route: "/m", viewport: surface.viewport, explanation: "Network reset app: /api/unrelated" },
    ];
    const lines = renderVisualAuditFailureLines({ surfaces: [surface], failures: surface.failures });
    expect(lines.some((line) => line.includes("visual measurement were not executed"))).toBe(false);
    expect(lines).toContain("FAIL console-error /m 1280x900: Console error: TypeError: product bug");
    expect(lines).toContain("FAIL page-error /m 1280x900: Page error: ReferenceError: product bug");
    expect(lines).toContain("FAIL http-error /m 1280x900: HTTP 500 app: /api/unrelated");
    expect(lines).toContain("FAIL network-error /m 1280x900: Network reset app: /api/unrelated");
  });

  it("arms and freezes each fresh Steward entry before selection and attaches both artifact paths", async () => {
    const runner = await readFile(new URL("../scripts/visual-audit-runner.mjs", import.meta.url), "utf8");
    const freshEntry = /armInitialStewardDeskCapture\(\);\n\s+const documentProof = await navigateAndAttest\(page, auditUrl\("\/m"\)\);/g;
    expect(runner.match(freshEntry)).toHaveLength(2);

    const memberPath = runner.slice(
      runner.indexOf('if (contract?.hat === "member")'),
      runner.indexOf('if (route !== "/m/tasks")'),
    );
    const coordinatorPath = runner.slice(
      runner.indexOf('// Chapter Work is staff-only.'),
      runner.indexOf('async function verifyExpectedSha'),
    );
    for (const [path, selection] of [
      [memberPath, 'await selectMemberHat(page, restartTargetRuntimeCapture);'],
      [coordinatorPath, 'await selectCoordinatorHat(page, restartTargetRuntimeCapture);'],
    ]) {
      expect(path.indexOf('await waitForInitialStewardDesk(page);')).toBeGreaterThanOrEqual(0);
      expect(path.indexOf('await finalizeInitialStewardDeskCapture();')).toBeGreaterThan(path.indexOf('await waitForInitialStewardDesk(page);'));
      expect(path.indexOf(selection)).toBeGreaterThan(path.indexOf('await finalizeInitialStewardDeskCapture();'));
    }

    expect((runner.match(/const attached = attachInitialStewardDeskBatch\(baseSurface, initialStewardDeskBatch/g) ?? [])).toHaveLength(2);
    expect((runner.match(/failures: \[\.\.\.baseSurface\.failures, \.\.\.attached\.findings\]/g) ?? [])).toHaveLength(2);
  });

  it("retires phone polish from canonical and Work matrices while keeping tablet and desktop", () => {
    expect(resolveVisualAuditViewports(undefined)).toEqual([
      { name: "tablet", width: 768, height: 1024 },
      { name: "desktop", width: 1280, height: 900 },
      { name: "wide", width: 1440, height: 900 },
    ]);
    expect(resolveVisualAuditViewports("unionground-work")).toEqual([
      { name: "tablet-768", width: 768, height: 1024 },
      { name: "tablet-edge-1023", width: 1023, height: 900 },
      { name: "desktop-1024", width: 1024, height: 900 },
      { name: "desktop-1280", width: 1280, height: 900 },
      { name: "desktop-edge-1359", width: 1359, height: 900 },
      { name: "paired-1360", width: 1360, height: 900 },
      { name: "paired-1440", width: 1440, height: 900 },
      { name: "wide-1920", width: 1920, height: 1080 },
    ]);
    expect(() => resolveVisualAuditViewports("unknown-preset")).toThrow(/VISUAL_AUDIT_MATRIX/);
  });

  it("dismisses the demo welcome layer before measuring the member surface", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.setContent(`
        <style>
          @keyframes drift { to { transform: translateX(100px); } }
          .moving { animation: drift 10s linear infinite; transition: transform 2s; }
        </style>
        <div class="home-orb" style="width:44px;height:44px"></div>
        <div class="moving">Moving</div>
        <div class="demo-welcome-layer">
          <button class="dialog-primary" onclick="this.parentElement.remove()">Explore</button>
        </div>
      `);

      await settleVisualAuditSurface(page, 1000);

      expect(await page.locator(".demo-welcome-layer").count()).toBe(0);
      expect(await page.locator(".moving").evaluate((node) => ({
        animationName: getComputedStyle(node).animationName,
        transitionDuration: getComputedStyle(node).transitionDuration,
      }))).toEqual({ animationName: "none", transitionDuration: "0s" });
    } finally {
      await browser.close();
    }
  });

  it("waits for delayed route hydration and an unchanged layout before measuring", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.setContent(`
        <div class="home-orb" style="width:44px;height:44px"></div>
        <main>
          <div class="view-loading" role="status">Loading</div>
          <nav aria-label="Delayed navigation"><a href="#one">One</a></nav>
        </main>
      `);
      await page.evaluate(() => {
        window.setTimeout(() => {
          document.querySelector(".view-loading").remove();
          window.setTimeout(() => {
            const link = document.createElement("a");
            link.href = "#two";
            link.textContent = "Two";
            document.querySelector("nav").append(link);
          }, 100);
        }, 50);
      });

      await settleVisualAuditSurface(page, 1200);

      expect(await page.locator("nav a").allTextContents()).toEqual(["One", "Two"]);
      expect(await page.locator(".view-loading").count()).toBe(0);
    } finally {
      await browser.close();
    }
  });

  it("settles once every concurrently mounted loading surface hides", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      // The shell chunk and the route chunk can hold their Suspense fallbacks
      // open at the same time. One strict locator across both classes resolves
      // to two elements and throws a strict mode violation before either can
      // hide, so the wait has to cover every match, not just the first one.
      await page.setContent(`
        <div class="home-orb" style="width:44px;height:44px"></div>
        <div class="loading-screen" role="status">Shell chunk</div>
        <main>
          <div class="view-loading" role="status">Route chunk</div>
          <nav aria-label="Hydrated navigation"><a href="#one">One</a></nav>
        </main>
      `);
      await page.evaluate(() => {
        window.setTimeout(() => {
          for (const surface of document.querySelectorAll(".loading-screen, .view-loading")) {
            surface.remove();
          }
        }, 100);
      });

      await settleVisualAuditSurface(page, 1500);

      expect(await page.locator(".loading-screen, .view-loading").count()).toBe(0);
      expect(await page.locator("nav a").allTextContents()).toEqual(["One"]);
    } finally {
      await browser.close();
    }
  });

  it("keeps a still-visible loading surface pending until the route timeout", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.setContent(`
        <div class="home-orb" style="width:44px;height:44px"></div>
        <main><div class="view-loading" role="status">Never hydrates</div></main>
      `);

      const startedAt = Date.now();
      const failure = await settleVisualAuditSurface(page, 400).catch((error) => error);

      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toMatch(/Timeout|did not settle/);
      expect(failure.message).not.toMatch(/strict mode violation/);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);
      expect(await page.locator(".view-loading").isVisible()).toBe(true);

      // The runner still attributes that rejection to the audited route, so a
      // surface that never hydrates keeps reporting as a route-error finding.
      const runner = await readFile(new URL("../scripts/visual-audit-runner.mjs", import.meta.url), "utf8");
      const settleCall = runner.indexOf("await waitForStableSurface(page, { expectWelcome: false });");
      const routeAttempt = runner.slice(
        runner.indexOf("documentProof = await navigateToAuditSurface(page, url, currentRoute"),
        runner.indexOf("report.screenshots.push(failureScreenshot);"),
      );
      expect(routeAttempt).toContain("await waitForStableSurface(page, { expectWelcome: false });");
      expect(routeAttempt).toContain("} catch (error) {");
      expect(runner.indexOf('runtimeFailure(currentRoute, viewport, "route-error", diagnostic.error)'))
        .toBeGreaterThan(settleCall);
    } finally {
      await browser.close();
    }
  });

  it("dismisses a demo welcome layer that hydrates after the route fallback", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.route("https://example.test/**", (route) => route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>Delayed welcome</title>",
      }));
      await page.goto("https://example.test/m?demo=1");
      await page.setContent(`
        <div class="home-orb" style="width:44px;height:44px"></div>
        <div class="view-loading" role="status">Loading</div>
      `);
      await page.evaluate(() => {
        window.setTimeout(() => {
          document.querySelector(".view-loading").remove();
          window.setTimeout(() => {
            const welcome = document.createElement("div");
            welcome.className = "demo-welcome-layer";
            welcome.innerHTML = '<button class="dialog-primary" onclick="this.parentElement.remove()">Explore</button>';
            document.body.append(welcome);
          }, 75);
        }, 50);
      });

      await settleVisualAuditSurface(page, 1200);

      expect(await page.locator(".demo-welcome-layer").count()).toBe(0);
    } finally {
      await browser.close();
    }
  });

  it("dismisses SAMPLE welcome on a host-gated /m that has no ?demo=1", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.route("https://sample.test/**", (route) => route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>SAMPLE host</title>",
      }));
      await page.goto("https://sample.test/m");
      await page.setContent(`
        <nav class="desktop-rail" style="width:72px;height:100px"></nav>
        <div class="desktop-rail__hat-switcher">Switch hat</div>
        <div class="view-loading" role="status">Loading</div>
      `);
      await page.evaluate(() => {
        window.setTimeout(() => {
          document.querySelector(".view-loading").remove();
          window.setTimeout(() => {
            const welcome = document.createElement("div");
            welcome.className = "demo-welcome-layer";
            welcome.innerHTML = '<button class="dialog-primary" onclick="this.parentElement.remove()">Explore</button>';
            document.body.append(welcome);
          }, 75);
        }, 50);
      });

      await settleVisualAuditSurface(page, 1200, { expectWelcome: true });

      expect(await page.locator(".demo-welcome-layer").count()).toBe(0);
    } finally {
      await browser.close();
    }
  });

  it("does not wait for welcome again when expectWelcome is false", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.route("https://example.test/**", (route) => route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>Already dismissed</title>",
      }));
      await page.goto("https://example.test/m?demo=1");
      await page.setContent(`
        <div class="home-orb" style="width:44px;height:44px"></div>
        <div class="desktop-rail__hat-switcher">Switch hat</div>
      `);

      await settleVisualAuditSurface(page, 800, { expectWelcome: false });

      expect(await page.locator(".demo-welcome-layer").count()).toBe(0);
    } finally {
      await browser.close();
    }
  });

  it("bounds the stable-layout wait with the route timeout", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.setContent(`
        <div class="home-orb" style="width:44px;height:44px"></div>
        <button type="button" style="width:44px;height:44px">Moving</button>
      `);
      await page.evaluate(() => {
        window.__visualAuditMotion = window.setInterval(() => {
          const button = document.querySelector("button");
          // Grow monotonically so the audit's 50ms sampler cannot alias with
          // a two-state animation and mistake recurring geometry for rest.
          button.style.width = `${Number.parseFloat(button.style.width) + 1}px`;
        }, 20);
      });

      await expect(settleVisualAuditSurface(page, 250)).rejects.toThrow(/layout did not remain stable/);
      await page.evaluate(() => window.clearInterval(window.__visualAuditMotion));
    } finally {
      await browser.close();
    }
  });

  it("waits for a re-rendered toast to clear before a visual measurement", async () => {
    expect(visualAudit.waitForVisualToastsToClear).toBeTypeOf("function");

    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.setContent('<div class="home-orb" style="width:44px;height:44px"></div>');
      await page.evaluate(() => {
        const showToast = () => {
          const toast = document.createElement("div");
          toast.className = "toast";
          toast.setAttribute("role", "status");
          toast.textContent = "Saved";
          document.body.append(toast);
          return toast;
        };
        const first = showToast();
        window.setTimeout(() => first.remove(), 60);
        window.setTimeout(() => {
          const second = showToast();
          window.setTimeout(() => second.remove(), 80);
        }, 100);
      });

      const startedAt = Date.now();
      await visualAudit.waitForVisualToastsToClear(page, 1000, 100);

      expect(await page.locator(".toast").count()).toBe(0);
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(180);
    } finally {
      await browser.close();
    }
  });

  it("excludes fully CSS-clipped text from painted obstructions without hiding real targets", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.setContent(`
        <style>
          body { margin: 0; }
          .target { position: absolute; left: 10px; top: 20px; width: 100px; height: 40px; margin: 0; }
          .legacy-hidden { clip: rect(0, 0, 0, 0); }
          .inset-hidden { clip-path: inset(50%); }
          #toolbar { position: fixed; inset: 0 auto auto 0; width: 390px; height: 200px; background: gray; }
          #tiny-visible { width: 1px; height: 1px; }
          #partial { clip-path: inset(0 50% 0 0); }
          #almost-empty { clip-path: inset(49.9%); }
          #inset-axis { clip-path: inset(0px 50% round 2px); transform: scale(2); }
          #legacy-axis { clip: rect(auto, 0px, auto, 0px); }
          #static-clip { position: relative; }
          #clipped-button { width: 32px; height: 32px; }
          #overflow-clip { top: 230px; width: 20px; overflow: hidden; }
          #overflow-button { width: 80px; height: 44px; }
        </style>
        <p id="status" class="target legacy-hidden" role="status" aria-live="polite">Saved</p>
        <header class="target legacy-hidden"><h1 id="heading">Tasks</h1></header>
        <p id="inset-text" class="target inset-hidden">Screen reader description</p>
        <div class="target inset-hidden"><span id="inset-child">Nested description</span></div>
        <p id="inset-axis" class="target">Empty horizontal clip through a transform</p>
        <p id="legacy-axis" class="target">Empty horizontal legacy clip with automatic vertical edges</p>
        <p id="tiny-visible" class="target">Visible pixel</p>
        <p id="partial" class="target">Partly visible</p>
        <p id="almost-empty" class="target">A nonempty sliver must not be suppressed</p>
        <p id="static-clip" class="target legacy-hidden">Legacy clip does not apply to relative positioning</p>
        <button id="clipped-button" class="target legacy-hidden">Still an interactive target</button>
        <div id="overflow-clip" class="target"><button id="overflow-button">Clipped control</button></div>
        <div id="toolbar">Toolbar</div>
      `);
      await page.locator("#clipped-button").focus();
      const measurements = await page.evaluate(collectVisualMeasurements);
      const report = classifyVisualMeasurements(measurements);
      const obstructions = report.failures.filter((item) => item.rule === "fixed-obstruction");
      for (const id of ["status", "heading", "inset-text", "inset-child", "inset-axis", "legacy-axis"]) {
        expect(measurements.elements.find((item) => item.selector === `#${id}`)?.paintedRect, id).toBeNull();
        expect(obstructions.some((item) => item.selector === `#${id}`), id).toBe(false);
      }
      for (const id of ["tiny-visible", "partial", "almost-empty", "static-clip", "clipped-button"]) {
        expect(obstructions.some((item) => item.selector === `#${id}`), id).toBe(true);
      }
      expect(report.failures).toEqual(expect.arrayContaining([
        expect.objectContaining({ rule: "small-target", selector: "#clipped-button" }),
        expect.objectContaining({ rule: "clipped-interactive", selector: "#overflow-button" }),
      ]));
      expect(measurements.focus.selector).toBe("#clipped-button");
      // The accessibility-only content remains in the DOM and accessibility tree.
      expect(await page.locator("#heading").getAttribute("aria-hidden")).toBeNull();
      expect(await page.locator("#status").getAttribute("aria-live")).toBe("polite");
    } finally {
      await browser.close();
    }
  });

  it("classifies the controlled fixture's bad surface with stable evidence", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.goto(fixtureUrl);
      const measurements = await page.evaluate(collectVisualMeasurements);
      const report = classifyVisualMeasurements(measurements);

      expect(new Set(report.failures.map((item) => item.rule))).toEqual(new Set([
        "small-target", "element-collision", "clipped-interactive", "dialog-viewport", "fixed-obstruction",
      ]));
      const findings = [...report.failures, ...report.warnings];
      const referencedSelectors = findings.flatMap((item) => [item.selector, ...(item.selectors || [])]);
      expect(referencedSelectors).not.toContain("#good-target");
      for (const item of report.failures) {
        expect(item).toMatchObject({
          severity: "failure",
          route: "/visual-audit-fixture",
          viewport: { width: 390, height: 844 },
        });
        expect(item.selector).toEqual(expect.any(String));
        expect(item.selectors).toEqual(expect.arrayContaining([item.selector]));
        expect(item.rectangles.length).toBeGreaterThan(0);
      }
      const collision = report.failures.find((item) => item.rule === "element-collision");
      const clipped = report.failures.find((item) => item.rule === "clipped-interactive");
      const obstruction = report.failures.find((item) => item.rule === "fixed-obstruction");
      expect(collision.intersectionRect).toEqual(expect.objectContaining({ width: expect.any(Number), height: expect.any(Number) }));
      expect(clipped.intersectionRect).toEqual(expect.objectContaining({ width: expect.any(Number), height: expect.any(Number) }));
      expect(obstruction).toMatchObject({
        obstruction: "#fixed-preview-chip",
        selectors: ["#obstructed-heading", "#fixed-preview-chip"],
        intersectionRect: { left: 10, top: 24, right: 186, bottom: 50, width: 176, height: 26 },
      });
      expect(JSON.parse(JSON.stringify(report))).toEqual(report);
      const markdown = renderVisualAuditMarkdown(report);
      expect(markdown).toContain("## Definite failures");
      expect(markdown).toContain("#colliding-title");
      expect(markdown).toContain("rectangles:");
      expect(markdown).toContain("intersection rectangle:");
    } finally {
      await browser.close();
    }
  });
});
