// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  authorizeOrganizationRetentionRun,
  executeOrganizationRetentionRun,
  loadAdminDesk,
  previewOrganizationRetentionRun,
  saveOrganizationRetentionPolicy,
} from "../src/lib/memberApi.js";
import { latestFnBody } from "./helpers/migration.js";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";

// Derived from the live private.retention_data_class_config, never
// hand-written. A seven-entry fixture is exactly how
// BUG-UG-RETENTION-ENGINE-STATE-UNKNOWN-FOR-ADMIN-20261009 stayed
// green: 20261003050000 added member_notifications, ai_assistant_conversations
// and ai_usage_counters to the server catalog, the client allowlist kept
// rejecting any payload that was not exactly the old seven, and every admin
// past that migration — SAMPLE and Production included — got a null engine and
// the card's unknown-state notice. Deriving the fixture means the next class
// added to the config fails this file instead of blanking the card.
const classes = [...latestFnBody("private.retention_data_class_config").matchAll(
  /when '([a-z_]+)' then[\s\S]*?'minimumDays',\s*(\d+),\s*'maximumDays',\s*(\d+),\s*'defaultDays',\s*(\d+)/g,
)].map(([, dataClass, minimumDays, maximumDays, defaultDays]) => ({
  dataClass,
  minimumDays: Number(minimumDays),
  maximumDays: Number(maximumDays),
  defaultDays: Number(defaultDays),
  retentionDays: Number(defaultDays),
}));

function retentionEngine(overrides = {}) {
  return {
    organizationId: "10000000-0000-4000-8000-000000000001",
    schedulerConfigured: true,
    policies: classes.map((row) => ({
      ...row,
      executionEnabled: false,
      configured: true,
      updatedAt: "2026-08-28T12:00:00.000Z",
    })),
    runs: [{
      id: "20000000-0000-4000-8000-000000000001",
      dataClass: "organization_page_views",
      retentionDays: 180,
      mode: "manual",
      status: "completed",
      eligibleCount: 17,
      deletedCount: 17,
      remainingCount: 0,
      authorizationExpiresAt: "2026-08-28T12:15:00.000Z",
      createdAt: "2026-08-28T12:00:00.000Z",
      completedAt: "2026-08-28T12:01:00.000Z",
      failureCode: null,
      confirmationPhrase: null,
    }],
    ...overrides,
  };
}

function adminClient(engineResult = { data: retentionEngine(), error: null }) {
  return {
    rpc: vi.fn(async (name) => {
      if (name === "get_staff_roster" || name === "get_admin_events") return { data: [], error: null };
      if (name === "get_organization_retention_engine") return engineResult;
      return { data: null, error: { message: "optional unavailable" } };
    }),
  };
}

describe("CR-104 retention engine client", () => {
  it("keeps fallback policy classes, bounds and default windows equal to the latest migration", () => {
    expect(classes.length).toBeGreaterThan(0);
    const policies = fallbackData.adminDesk.retentionEngine.policies;
    const byClass = (a, b) => a.dataClass.localeCompare(b.dataClass);
    expect(policies.map(({ dataClass, minimumDays, maximumDays, defaultDays, retentionDays }) => ({
      dataClass, minimumDays, maximumDays, defaultDays, retentionDays,
    })).sort(byClass)).toEqual([...classes].sort(byClass));
  });

  it("decodes the organization engine and keeps unreadable state distinct from empty history", async () => {
    const desk = await loadAdminDesk(adminClient(), "en");
    expect(desk.retentionEngine).toMatchObject({
      organizationId: "10000000-0000-4000-8000-000000000001",
      schedulerConfigured: true,
    });
    expect(desk.retentionEngine.policies.map((row) => row.dataClass).sort())
      .toEqual(classes.map((row) => row.dataClass).sort());
    expect(desk.retentionEngine.runs[0]).toMatchObject({ eligibleCount: 17, deletedCount: 17, remainingCount: 0 });

    const unavailable = await loadAdminDesk(adminClient({ data: null, error: { message: "not deployed" } }));
    expect(unavailable.retentionEngine).toBeNull();
  });

  it("decodes the three classes 20261003050000 added instead of rejecting the whole payload", async () => {
    const late = ["member_notifications", "ai_assistant_conversations", "ai_usage_counters"];
    const desk = await loadAdminDesk(adminClient(), "en");
    for (const dataClass of late) {
      expect(classes.some((row) => row.dataClass === dataClass), `${dataClass} in config`).toBe(true);
      expect(
        desk.retentionEngine.policies.some((row) => row.dataClass === dataClass),
        `${dataClass} decoded`,
      ).toBe(true);
    }
    expect(desk.retentionEngineUnavailable).toBeNull();
  });

  // BUG-UG-RETENTION-ENGINE-STATE-UNKNOWN-FOR-ADMIN-20261009: the card
  // withholds the deletion control for all of these, which is correct; what it
  // could not do was say which one it was in. A missing configuration tells an
  // admin to wait for a database change, a failed read tells them to retry, and
  // a payload this build cannot read tells them the app and the data are out of
  // step — three different next actions behind one former "unknown".
  it.each([
    ["an absent function as a missing configuration", {
      data: null, error: { code: "PGRST202", message: "Could not find the function" },
    }, "missingConfiguration"],
    ["a server that answers with no engine as a missing configuration", {
      data: null, error: null,
    }, "missingConfiguration"],
    ["a refused read as a permission boundary", {
      data: null, error: { code: "42501", message: "organization admin with MFA required" },
    }, "notPermitted"],
    ["an unspecified failure as a failed read", {
      data: null, error: { message: "fetch failed" },
    }, "readFailed"],
  ])("names %s", async (_label, engineResult, reason) => {
    const desk = await loadAdminDesk(adminClient(engineResult));
    expect(desk.retentionEngine).toBeNull();
    expect(desk.retentionEngineUnavailable).toBe(reason);
  });

  it("names a payload it cannot read as a version gap, not as a failed read", async () => {
    const desk = await loadAdminDesk(adminClient({
      data: retentionEngine({ policies: retentionEngine().policies.slice(0, 4) }),
      error: null,
    }));
    expect(desk.retentionEngine).toBeNull();
    expect(desk.retentionEngineUnavailable).toBe("unrecognizedPayload");
  });

  it.each([
    ["duplicate policy classes", retentionEngine({ policies: [
      ...retentionEngine().policies,
      retentionEngine().policies[0],
    ] })],
    ["missing policy classes", retentionEngine({ policies: retentionEngine().policies.slice(0, 4) })],
    ["negative counts", retentionEngine({ runs: [{ ...retentionEngine().runs[0], deletedCount: -1 }] })],
    ["fractional counts", retentionEngine({ runs: [{ ...retentionEngine().runs[0], eligibleCount: 1.5 }] })],
    ["unknown data classes", retentionEngine({ policies: retentionEngine().policies.map((row, index) => (
      index === 0 ? { ...row, dataClass: "organization_audit_ledger" } : row
    )) })],
  ])("fails closed on %s", async (_label, value) => {
    const desk = await loadAdminDesk(adminClient({ data: value, error: null }));
    expect(desk.retentionEngine).toBeNull();
  });

  it("maps every write to the closed RPC surface without direct table mutation", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { ok: true }, error: null });
    const client = { rpc };
    await saveOrganizationRetentionPolicy(client, {
      dataClass: "organization_page_views",
      retentionDays: 180,
      executionEnabled: true,
      confirmation: "ENABLE organization_page_views",
    });
    await previewOrganizationRetentionRun(client, "organization_page_views");
    await authorizeOrganizationRetentionRun(client, "run-1", "AUTHORIZE organization_page_views");
    await executeOrganizationRetentionRun(client, "run-1");
    expect(rpc.mock.calls).toEqual([
      ["upsert_organization_retention_policy", {
        p_data_class: "organization_page_views",
        p_retention_days: 180,
        p_execution_enabled: true,
        p_confirmation: "ENABLE organization_page_views",
      }],
      ["preview_organization_retention_run", { p_data_class: "organization_page_views" }],
      ["authorize_organization_retention_run", {
        p_run_id: "run-1",
        p_confirmation: "AUTHORIZE organization_page_views",
      }],
      ["execute_organization_retention_run", { p_run_id: "run-1" }],
    ]);
  });

  it("uses the shared safe write error instead of leaking backend detail", async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "denied", code: "42501" } }) };
    await expect(executeOrganizationRetentionRun(client, "other-org-run"))
      .rejects.toMatchObject({ message: "Execute retention run: denied", code: "42501" });
  });
});
