// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  PRODUCT_JOBS,
  buildJobHealthDesk,
  claimJobRun,
  createJobAcknowledgement,
  createJobRetryRequest,
  deriveJobRunId,
  normalizePersistedJobHealthRows,
  redactJobFailure,
  scoreJobHealth,
  staleAfterMsForCadence,
} from "../src/features/operations/index.js";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const ACTOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("CR-107 job registry and health", () => {
  it("registers every current product scheduler job", () => {
    const names = PRODUCT_JOBS.map((job) => job.jobName);
    expect(names).toEqual(expect.arrayContaining([
      "notifications-dispatch-tick",
      "notifications-expiry-sweep",
      "deadline-notices-tick",
      "ballot-notices-tick",
      "event-notices-tick",
      "appointment-reminders-tick",
      "member-messaging-dispatch",
      "workload-reminders-tick",
      "ballot-choices-mix",
      "ballot-choices-mix-recent",
      "task-files-reconcile-tick",
      "task-maintenance-daily",
      "account-deletion-reconcile-tick",
    ]));
    // Union catalog claims, the public event RSVP, ULP deadlines, SSO and
    // dues are left out of Union Ground, so no web job is registered for them.
    for (const leftOut of ["organization-claim-retention", "mi1-public-rsvp-retention", "casework-ulp-deadline-tick", "sso-identity-link-sweep", "dues-reminders-dispatch-tick", "dues-stripe-reconcile-tick"]) {
      expect(names).not.toContain(leftOut);
    }
    expect(new Set(names).size).toBe(names.length);
    expect(PRODUCT_JOBS.every((job) => job.scope === "platform")).toBe(true);
  });

  it("derives stale windows from cadence and claims a run bucket once", () => {
    expect(staleAfterMsForCadence("* * * * *")).toBe(3 * 60 * 1000);
    expect(staleAfterMsForCadence("*/5 * * * *")).toBe(12 * 60 * 1000);
    expect(staleAfterMsForCadence("17 4 * * *")).toBe(36 * 60 * 60 * 1000);
    const bucket = "2026-08-22T15:04:00.000Z";
    const runId = deriveJobRunId("notifications-dispatch-tick", bucket);
    expect(runId).toBe("notifications-dispatch-tick:2026-08-22T15:04");
    const claimed = new Set();
    expect(claimJobRun(claimed, "notifications-dispatch-tick", bucket).claimed).toBe(true);
    expect(claimJobRun(claimed, "notifications-dispatch-tick", bucket).claimed).toBe(false);
    expect(() => deriveJobRunId("donor-pgcron-health", bucket)).toThrow(/unknown product job/);
  });

  it("scores never_run, failing, stale, acknowledged, and healthy states", () => {
    const cadence = "*/5 * * * *";
    expect(scoreJobHealth({ cadence, lastRun: null })).toBe("never_run");
    expect(scoreJobHealth({
      cadence,
      lastRun: { status: "failed", completedAt: "2026-08-22T15:00:00.000Z" },
    })).toBe("failing");
    expect(scoreJobHealth({
      cadence,
      lastRun: { status: "failed", completedAt: "2026-08-22T15:00:00.000Z", runId: "r1" },
      acknowledgement: { runId: "r1", remediation: "acknowledge" },
    })).toBe("acknowledged");
    expect(scoreJobHealth({
      cadence,
      lastRun: { status: "failed", completedAt: "2026-08-22T15:00:00.000Z" },
      acknowledgement: { runId: "r1", remediation: "request_retry" },
    })).toBe("failing");
    expect(scoreJobHealth({
      cadence,
      lastRun: { status: "completed", completedAt: "2026-08-22T14:00:00.000Z" },
    }, Date.parse("2026-08-22T15:00:00.000Z"))).toBe("stale");
    expect(scoreJobHealth({
      cadence,
      lastRun: { status: "completed", completedAt: "2026-08-22T14:55:00.000Z" },
    }, Date.parse("2026-08-22T15:00:00.000Z"))).toBe("healthy");
    expect(scoreJobHealth({
      cadence,
      lastRun: { status: "skipped", completedAt: "2026-08-22T14:55:00.000Z" },
    }, Date.parse("2026-08-22T15:00:00.000Z"))).toBe("skipped");
    expect(scoreJobHealth({
      cadence,
      lastRun: { status: "in_progress", startedAt: "2026-08-22T14:55:00.000Z" },
    }, Date.parse("2026-08-22T15:00:00.000Z"))).toBe("running");
    expect(scoreJobHealth({
      cadence,
      lastRun: { status: "in_progress", startedAt: "2026-08-22T14:00:00.000Z" },
    }, Date.parse("2026-08-22T15:00:00.000Z"))).toBe("stale");
  });

  it("redacts secrets, emails, and URLs from failure text", () => {
    expect(redactJobFailure("Bearer super-secret-token-value").failureSummary).toBeNull();
    expect(redactJobFailure("failed for ada@example.com").failureSummary).toBeNull();
    expect(redactJobFailure("posted https://hooks.example/path").failureSummary).toBeNull();
    expect(redactJobFailure("timeout waiting for lock").failureCode).toBe("timeout");
    expect(redactJobFailure("timeout waiting for lock").failureSummary).toBe("timeout waiting for lock");
  });

  it.each([
    ["skipped", null, "No account deletion requests were awaiting reconciliation.", "skipped", null],
    ["completed", null, "Reconciliation finished.", "healthy", null],
    ["failed", null, "Timeout waiting for a lock.", "failing", "timeout"],
    ["skipped", "provider_unset", "Reconciliation was skipped.", "skipped", "provider_unset"],
  ])("reports %s run summaries without inventing a failure code", (lastStatus, failureCode, redactedSummary, health, expectedCode) => {
    const jobName = "account-deletion-reconcile-tick";
    const { runs } = normalizePersistedJobHealthRows([{
      organizationId: ORG_A, jobName, lastStatus, failureCode, redactedSummary,
      lastRunId: "reconcile-a", lastStartedAt: "2026-11-24T23:55:00Z", lastFinishedAt: "2026-11-24T23:55:01Z",
    }], ORG_A);
    const jobs = buildJobHealthDesk({ selectedOrganizationId: ORG_A, runs, nowMs: Date.parse("2026-11-24T23:56:00Z") });
    expect(jobs.find((job) => job.jobName === jobName)).toMatchObject({ health, lastRun: { failureCode: expectedCode } });
  });

  it("builds an organization desk that hides foreign-tenant runs and enables remediations", () => {
    const desk = buildJobHealthDesk({
      selectedOrganizationId: ORG_A,
      nowMs: Date.parse("2026-08-22T15:00:00.000Z"),
      runs: [
        {
          jobName: "deadline-notices-tick",
          runId: "deadline-a",
          status: "failed",
          startedAt: "2026-08-22T13:05:00.000Z",
          completedAt: "2026-08-22T13:05:02.000Z",
          errorMessage: "Authorization: Bearer abc.def",
          organizationId: ORG_A,
        },
        {
          jobName: "deadline-notices-tick",
          runId: "deadline-b",
          status: "completed",
          startedAt: "2026-08-22T13:05:00.000Z",
          completedAt: "2026-08-22T13:05:01.000Z",
          organizationId: ORG_B,
        },
        {
          jobName: "member-messaging-dispatch",
          runId: "msg-1",
          status: "completed",
          startedAt: "2026-08-22T14:59:00.000Z",
          completedAt: "2026-08-22T14:59:01.000Z",
        },
      ],
    });
    const deadline = desk.find((job) => job.jobName === "deadline-notices-tick");
    expect(deadline.health).toBe("failing");
    expect(deadline.lastRun.runId).toBe("deadline-a");
    expect(deadline.lastRun.failureSummary).toBeNull();
    expect(deadline.remediations).toEqual(["acknowledge", "request_retry"]);
    const messaging = desk.find((job) => job.jobName === "member-messaging-dispatch");
    expect(messaging.health).toBe("healthy");
    const never = desk.find((job) => job.jobName === "task-maintenance-daily");
    expect(never.health).toBe("never_run");
  });

  it("records org-scoped remediations that never execute the job", () => {
    const ack = createJobAcknowledgement({
      organizationId: ORG_A,
      actorUserId: ACTOR,
      jobName: "deadline-notices-tick",
      runId: "deadline-a",
      acknowledgedAt: "2026-08-22T15:10:00.000Z",
    });
    expect(ack.organizationId).toBe(ORG_A);
    const retry = createJobRetryRequest({
      organizationId: ORG_A,
      actorUserId: ACTOR,
      jobName: "deadline-notices-tick",
      runId: "deadline-a",
      requestedAt: "2026-08-22T15:11:00.000Z",
    });
    expect(retry.executesJob).toBe(false);
    expect(retry.remediation).toBe("request_retry");
    expect(() => createJobAcknowledgement({
      organizationId: ORG_A,
      actorUserId: ACTOR,
      jobName: "donor-compute-scores",
      runId: "x",
    })).toThrow(/unknown product job/);
  });
});
