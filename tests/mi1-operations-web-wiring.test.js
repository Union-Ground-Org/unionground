import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildMi1FeatureActor,
  isMissingRpcError,
  loadOrganizationSessionScope,
} from "../src/lib/mi1FeatureWiring.js";
import {
  MI1_OPERATIONS_DATABASE_DEPENDENCIES,
  MI1_OPERATIONS_WEB_DONOR,
  createOperationsApi,
  isMissingOperationsRpcError,
  isOperationsAuthorizationError,
} from "../src/lib/mi1OperationsWiring.js";
import { shapeAuditListRequest } from "../src/features/operations/index.js";
import { STAFF_ROLE_NAVIGATION } from "../src/lib/staffNavigation.js";

const ORG = "11111111-1111-4111-8111-111111111111";

describe("CR-106/CR-107 operations web wiring", () => {
  it("records operations-only provenance and rejects other MI1 domains", () => {
    expect(MI1_OPERATIONS_WEB_DONOR.baseline).toBe("donor-baseline-20260721");
    expect(MI1_OPERATIONS_WEB_DONOR.wiring).toBe("ad2aef01af257be3d6fbbbe985b24f984cf8f222");
    expect(MI1_OPERATIONS_WEB_DONOR.rejected).toEqual(expect.arrayContaining([
      "browser execution of acknowledge/retry remediations",
      "QA, pay, analytics, integrations, and public-directory wiring",
    ]));
  });

  it("adds admin audit and job-health sections alongside the integrated staff tools", () => {
    expect(STAFF_ROLE_NAVIGATION.admin.map((item) => item.key)).toEqual(expect.arrayContaining([
      "admin-organization-audit",
      "admin-job-health",
      "analytics",
      "integrations",
      "qa-queue",
    ]));
  });

  it("maps missing RPCs and empty session scope without inventing an organization", async () => {
    expect(isMissingRpcError({ code: "PGRST202" })).toBe(true);
    expect(isMissingOperationsRpcError({ code: "PGRST202" })).toBe(true);
    expect(isMissingOperationsRpcError({ code: "42501" })).toBe(false);
    expect(isOperationsAuthorizationError({ code: "42501" })).toBe(true);
    expect(await loadOrganizationSessionScope(null)).toEqual({
      organizationId: null,
      chapterId: null,
      organizationRoles: [],
      chapterRoles: [],
      unavailable: true,
    });
    const client = {
      rpc: async () => ({ error: { code: "PGRST202", message: "Could not find the function" } }),
    };
    expect(await loadOrganizationSessionScope(client)).toMatchObject({
      organizationId: null,
      unavailable: true,
    });
    expect(buildMi1FeatureActor({ userId: "user-a" }).selectedOrganizationId).toBeNull();
  });

  it("maps database authorization failures to unavailable instead of retryable errors", async () => {
    const session = buildMi1FeatureActor({
      userId: "admin-a",
      organizationId: ORG,
      organizationRoles: ["admin"],
      mfaSatisfied: true,
      selectedHat: "admin",
    });
    const api = createOperationsApi({ rpc: async () => ({ error: { code: "42501", message: "denied" } }) });
    await expect(api.listAudit(session)).resolves.toMatchObject({ state: "unauthorized" });
    await expect(api.listJobHealth(session)).resolves.toMatchObject({ state: "unauthorized" });
    const mfaApi = createOperationsApi({ rpc: async () => ({ error: { code: "42501", message: "mfa required" } }) });
    await expect(mfaApi.listAudit(session)).resolves.toMatchObject({ state: "unauthorized", reason: "mfa_required" });
    await expect(mfaApi.acknowledgeJob(session, {
      jobName: "notifications-dispatch-tick",
      runId: "run-1",
    })).resolves.toMatchObject({ ok: false, reason: "mfa_required" });
  });

  it("keeps operations honest when the ledger RPCs are missing", async () => {
    const rpcNames = [];
    const api = createOperationsApi({
      rpc: async (name) => {
        rpcNames.push(name);
        return { error: { code: "PGRST202", message: "Could not find the function" } };
      },
    });
    const session = buildMi1FeatureActor({
      userId: "admin-a",
      organizationId: ORG,
      roles: ["admin"],
      mfaSatisfied: true,
      selectedHat: "admin",
    });
    expect(await api.listAudit(session)).toEqual({ state: "unset", events: [], hasOlder: false });
    const jobs = await api.listJobHealth(session);
    expect(jobs).toEqual({ state: "unset", jobs: [] });
    expect(await api.acknowledgeJob(session, {
      jobName: "notifications-dispatch-tick",
      runId: "run-1",
    })).toEqual({ ok: false, reason: "persistence_unset", executesJob: false });
    expect(await api.requestJobRetry(session, {
      jobName: "notifications-dispatch-tick",
      runId: "run-1",
    })).toEqual({ ok: false, reason: "persistence_unset", executesJob: false });
    expect(rpcNames).toEqual(expect.arrayContaining([
      "list_organization_audit_ledger",
      "list_organization_job_health",
      "acknowledge_organization_job_run",
      "request_organization_job_retry",
    ]));
    expect(rpcNames).not.toContain("record_organization_audit_event");
  });

  it("keeps every operations outcome explicit across local, unavailable, and successful RPC paths", async () => {
    const session = buildMi1FeatureActor({
      userId: "admin-a",
      organizationId: ORG,
      roles: ["admin"],
      mfaSatisfied: true,
      selectedHat: "admin",
    });
    const command = {
      jobName: "notifications-dispatch-tick",
      runId: "run-1",
    };

    const unsetApi = createOperationsApi(null);
    await expect(unsetApi.listAudit(session)).resolves.toEqual({ state: "unset", events: [], hasOlder: false });
    await expect(unsetApi.listJobHealth(session)).resolves.toEqual({ state: "unset", jobs: [] });
    await expect(unsetApi.acknowledgeJob(session, command)).resolves.toEqual({
      ok: false,
      reason: "persistence_unset",
      executesJob: false,
    });
    await expect(unsetApi.requestJobRetry(session, command)).resolves.toEqual({
      ok: false,
      reason: "persistence_unset",
      executesJob: false,
    });

    const unavailableApi = createOperationsApi({
      rpc: async () => ({ error: { code: "500", message: "temporarily unavailable" } }),
    });
    await expect(unavailableApi.listAudit(session)).resolves.toEqual({ state: "error", events: [], hasOlder: false });
    await expect(unavailableApi.listJobHealth(session)).resolves.toEqual({ state: "error", jobs: [] });
    await expect(unavailableApi.acknowledgeJob(session, command)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
      executesJob: false,
    });
    await expect(unavailableApi.requestJobRetry(session, command)).resolves.toEqual({
      ok: false,
      reason: "unavailable",
      executesJob: false,
    });

    const successfulApi = createOperationsApi({ rpc: async () => ({ data: null }) });
    await expect(successfulApi.acknowledgeJob(session, command)).resolves.toEqual({ ok: true, executesJob: false });
    await expect(successfulApi.requestJobRetry(session, command)).resolves.toEqual({ ok: true, executesJob: false });
  });

  it("calls the current audit cursor signature and projects persisted job health", async () => {
    const calls = [];
    const client = {
      rpc: async (name, args) => {
        calls.push([name, args]);
        if (name === "list_organization_audit_ledger") return { data: [] };
        if (name === "list_organization_job_health") {
          return { data: [{
            jobName: "notifications-dispatch-tick",
            organizationId: ORG,
            lastRunId: "run-42",
            lastStatus: "failed",
            lastStartedAt: "2026-08-24T00:00:00.000Z",
            lastFinishedAt: "2026-08-24T00:01:00.000Z",
            failureCode: "timeout",
            acknowledged: false,
            remediation: null,
          }] };
        }
        return { data: [] };
      },
    };
    const session = buildMi1FeatureActor({
      userId: "admin-a",
      organizationId: ORG,
      roles: ["admin"],
      mfaSatisfied: true,
      selectedHat: "admin",
    });
    await createOperationsApi(client).listAudit(session, {
      before: { occurredAt: "2026-08-24T00:00:00.000Z", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
    });
    expect(calls[0]).toEqual(["list_organization_audit_ledger", {
      p_limit: 50,
      p_before: "2026-08-24T00:00:00.000Z",
      p_before_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      p_domain: null,
      p_action: null,
    }]);
    const result = await createOperationsApi(client).listJobHealth(session);
    expect(result.jobs.find((job) => job.jobName === "notifications-dispatch-tick")).toMatchObject({
      health: "failing",
      lastRun: { runId: "run-42", failureCode: "timeout" },
    });
  });

  it("drops job-health rows outside the selected organization", async () => {
    const session = buildMi1FeatureActor({
      userId: "admin-a",
      organizationId: ORG,
      roles: ["admin"],
      mfaSatisfied: true,
      selectedHat: "admin",
    });
    const api = createOperationsApi({
      rpc: async () => ({ data: [{
        jobName: "notifications-dispatch-tick",
        organizationId: "22222222-2222-4222-8222-222222222222",
        lastRunId: "foreign-run",
        lastStatus: "failed",
        lastStartedAt: "2026-08-24T00:00:00.000Z",
      }] }),
    });
    const result = await api.listJobHealth(session);
    expect(result.jobs.every((job) => job.health === "never_run")).toBe(true);
  });

  it("shapes the legacy split cursor without accepting tenant input", () => {
    expect(shapeAuditListRequest({ selectedOrganizationId: ORG }, {
      before: "2026-08-24T00:00:00.000Z",
      beforeId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      limit: 999,
    })).toEqual({
      p_limit: 200,
      p_before: "2026-08-24T00:00:00.000Z",
      p_before_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      p_domain: null,
      p_action: null,
      organizationId: ORG,
    });
  });

  it("lists exact X-DB dependencies for operations only", () => {
    expect(Object.keys(MI1_OPERATIONS_DATABASE_DEPENDENCIES)).toEqual(["operations", "sessionScope"]);
    expect(MI1_OPERATIONS_DATABASE_DEPENDENCIES.operations.rpcs).toContain("list_organization_audit_ledger");
    expect(MI1_OPERATIONS_DATABASE_DEPENDENCIES.operations.rpcs).toContain("request_organization_job_retry");
    expect(MI1_OPERATIONS_DATABASE_DEPENDENCIES.sessionScope.rpcs).toEqual(["get_my_chapter_memberships"]);
  });

  it("does not import other MI1 domains or supabase migrations from the operations wiring", () => {
    const wiring = readFileSync("src/lib/mi1OperationsWiring.js", "utf8");
    const app = readFileSync("src/App.jsx", "utf8");
    const view = readFileSync("src/views/OperationsHealthView.jsx", "utf8");
    expect(wiring).not.toMatch(/supabase\/migrations/);
    expect(wiring).not.toMatch(/features\/(qa|analytics|pay|integrations|publicDirectory)/);
    expect(app).toContain("OperationsHealthView");
    expect(app).toContain("operationsHealth={<OperationsHealthView");
    expect(view).toContain("createOperationsApi");
  });
});
