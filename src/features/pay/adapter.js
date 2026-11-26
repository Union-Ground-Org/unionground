import { authorizePay } from "./authorization.js";
import { gradeKey, normalizePayScaleGrade, normalizePayScaleStep, stepKey } from "./catalog.js";
import { payFailure } from "./errors.js";

// In-memory organization catalog used by the pure calculation engine and
// explicit fixture tests. Live clients hydrate it only from session-scoped
// RPC projections; this adapter never seeds a tenant or CBA.

export function createMemoryPayCatalog(initial = []) {
  const grades = new Map();
  const steps = new Map();

  function load(records) {
    for (const record of records) {
      if (record.kind === "grade") {
        const grade = normalizePayScaleGrade(record);
        if (grade) grades.set(gradeKey(grade), grade);
      } else {
        const step = normalizePayScaleStep(record);
        if (step) steps.set(stepKey(step), step);
      }
    }
  }

  load(initial);

  return {
    listGrades(organizationId) {
      return [...grades.values()].filter((row) => row.organizationId === organizationId);
    },
    listSteps(organizationId) {
      return [...steps.values()].filter((row) => row.organizationId === organizationId);
    },
    upsertGrade(actor, record) {
      const grade = normalizePayScaleGrade(record);
      if (!grade) return payFailure("invalid_input", { field: "grade" });
      const auth = authorizePay({
        actor,
        organizationId: grade.organizationId,
        capability: "write_catalog",
      });
      if (!auth.ok) return auth;
      grades.set(gradeKey(grade), grade);
      return { ok: true, grade, audit: { action: "upsert_grade", organizationId: grade.organizationId, grade: grade.grade } };
    },
    upsertStep(actor, record) {
      const step = normalizePayScaleStep(record);
      if (!step) return payFailure("invalid_input", { field: "step" });
      const auth = authorizePay({
        actor,
        organizationId: step.organizationId,
        capability: "write_catalog",
      });
      if (!auth.ok) return auth;
      if (!grades.has(gradeKey({ organizationId: step.organizationId, grade: step.grade }))) {
        return payFailure("scale_not_found", { field: "grade" });
      }
      steps.set(stepKey(step), step);
      return {
        ok: true,
        step,
        audit: {
          action: "upsert_step",
          organizationId: step.organizationId,
          grade: step.grade,
          stepNumber: step.stepNumber,
          effectiveOn: step.effectiveOn,
        },
      };
    },
    clear() {
      grades.clear();
      steps.clear();
    },
  };
}

function catalogUnavailable() {
  return payFailure("catalog_unavailable");
}

export function createPayCatalogFromRpcPayload(gradesPayload, stepsPayload) {
  if (!Array.isArray(gradesPayload) || !Array.isArray(stepsPayload)) {
    return catalogUnavailable();
  }
  const grades = gradesPayload.map((row) => normalizePayScaleGrade({ ...row, kind: "grade" }));
  const steps = stepsPayload.map((row) => normalizePayScaleStep({ ...row, kind: "step" }));
  if (grades.some((row) => !row) || steps.some((row) => !row)) {
    return catalogUnavailable();
  }
  const records = [
    ...grades.map((row) => ({ ...row, kind: "grade" })),
    ...steps.map((row) => ({ ...row, kind: "step" })),
  ];
  return { ok: true, catalog: createMemoryPayCatalog(records), grades, steps };
}

export function createPayRpcAdapter(client) {
  async function call(name, args) {
    if (!client?.rpc) return catalogUnavailable();
    try {
      const { data, error } = await client.rpc(name, args);
      return error ? catalogUnavailable() : { ok: true, value: data };
    } catch {
      return catalogUnavailable();
    }
  }

  return Object.freeze({
    async loadCatalog() {
      const [grades, steps] = await Promise.all([
        call("list_pay_scale_grades"),
        call("list_pay_scale_steps", {
          p_grade: null,
          p_effective_on: null,
          p_step_number: null,
          p_effective_year: null,
        }),
      ]);
      if (!grades.ok || !steps.ok) return catalogUnavailable();
      return createPayCatalogFromRpcPayload(grades.value, steps.value);
    },
    async upsertGrade(actor, record) {
      const grade = normalizePayScaleGrade(record);
      if (!grade) return payFailure("invalid_input", { field: "grade" });
      const auth = authorizePay({ actor, organizationId: grade.organizationId, capability: "write_catalog" });
      if (!auth.ok) return auth;
      return call("upsert_pay_scale_grade", {
        p_expected_organization_id: grade.organizationId,
        p_grade: grade.grade,
        p_title: grade.title,
        p_job_family: grade.jobFamily,
        p_step_count: grade.stepCount,
        p_description: grade.description,
      });
    },
    async upsertStep(actor, record) {
      const step = normalizePayScaleStep(record);
      if (!step) return payFailure("invalid_input", { field: "step" });
      const auth = authorizePay({ actor, organizationId: step.organizationId, capability: "write_catalog" });
      if (!auth.ok) return auth;
      return call("upsert_pay_scale_step", {
        p_expected_organization_id: step.organizationId,
        p_grade: step.grade,
        p_effective_on: step.effectiveOn,
        p_step_number: step.stepNumber,
        p_hourly_rate_cents: step.hourlyRateCents,
      });
    },
  });
}

export const PAY_PERSISTENCE_CONTRACT = Object.freeze({
  migration: "20260822020000_mi1_w1_feature_persistence.sql",
  writeScopeGuardMigration: "20260826002000_pay_scale_expected_organization_guard.sql",
  rpcs: ["list_pay_scale_grades", "list_pay_scale_steps", "upsert_pay_scale_grade", "upsert_pay_scale_step"],
  requestedTables: ["pay_scale_grades", "pay_scale_steps"],
  sessionOrganizationOnly: true,
  expectedOrganizationRequiredForWrites: true,
  seedPolicy: "empty_on_reset",
  anonAccess: false,
  serviceRoleInClient: false,
});
