import { t } from "./i18n.js";

const clone = (value) => structuredClone(value);
const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();

// This adapter is used only by the explicitly selected local fixture preview.
// Hosted SAMPLE and live accounts use the authenticated casework RPCs.
// Union Ground issues have no grievance procedure, step advancement or
// step checklists (owner decision, 2026-10-13), so the fixture mirrors none.
export function createDemoCaseworkApi(loadDesk, { lang = "en" } = {}) {
  const workspaces = new Map();
  const fail = (key = "demoInvalid") => { throw new Error(t(typeof lang === "function" ? lang() : lang, `casework.${key}`)); };
  const cases = async () => (await loadDesk()).cases || [];
  const findCase = async (caseId) => (await cases()).find((row) => row.id === caseId) || fail("demoConflict");
  const workspace = async (caseId) => {
    const row = await findCase(caseId);
    if (!workspaces.has(caseId)) {
      workspaces.set(caseId, {
        scope: { id: row.id, organization_id: row.organization_id || "fixture-organization", chapter_id: row.chapter_id || row.chapterId || null, case_type: row.case_type || row.caseType, status: row.status, is_restricted: false },
        strength: [], deadlines: (row.deadlineValue || (row.deadline && !Number.isNaN(Date.parse(row.deadline))) && row.deadline) ? [{ id: id(), kind: "follow_up", label: row.title, due_at: row.deadlineValue || row.deadline, status: "active", extensions: [] }] : [],
        alerts: [], management: [], retaliation: [], links: [], reminders: [], accessGrants: [],
      });
    }
    const value = workspaces.get(caseId);
    Object.assign(value.scope, { status: row.status });
    return value;
  };
  const locate = async (collection, recordId) => {
    for (const row of await cases()) {
      const state = await workspace(row.id);
      const found = state[collection].find((item) => item.id === recordId);
      if (found) return found;
    }
    return fail("demoConflict");
  };
  const api = {
    loadCaseworkCase: async (caseId) => clone(await workspace(caseId)),
    createCaseDeadline: async (scope, fields) => {
      const row = { id: id(), kind: fields.kind, label: fields.label, due_at: fields.dueAt, reminder_at: fields.reminderAt || null, status: "active", extensions: [] };
      (await workspace(scope.id)).deadlines.push(row);
      return clone(row);
    },
    requestDeadlineExtension: async (deadlineId, dueAt, reason) => {
      const deadline = await locate("deadlines", deadlineId);
      const row = { id: id(), deadline_id: deadlineId, previous_due_at: deadline.due_at, requested_due_at: dueAt, reason, status: "pending" };
      deadline.extensions.push(row);
      return clone(row);
    },
    decideDeadlineExtension: async (extensionId, decision, note) => {
      for (const row of await cases()) for (const deadline of (await workspace(row.id)).deadlines) {
        const extension = deadline.extensions.find((item) => item.id === extensionId);
        if (!extension) continue;
        if (extension.status !== "pending" || !["approved", "denied"].includes(decision)) fail("demoConflict");
        Object.assign(extension, { status: decision, decision_note: note, decided_at: now() });
        if (decision === "approved") deadline.due_at = extension.requested_due_at;
        return clone(extension);
      }
      return fail("demoConflict");
    },
    createCaseAlert: async (scope, fields) => {
      const row = { id: id(), ...fields, status: "open", escalation_due_at: fields.escalationDueAt || null };
      (await workspace(scope.id)).alerts.push(row); return clone(row);
    },
    acknowledgeCaseAlert: async (alertId, note) => {
      const row = await locate("alerts", alertId); Object.assign(row, { status: "acknowledged", note }); return clone(row);
    },
    bulkUpdateCases: async (caseIds, expectedStatus, fields) => {
      const rows = await Promise.all(caseIds.map(findCase));
      if (fields.step || rows.some((row) => row.status !== expectedStatus)) fail("demoConflict");
      rows.forEach((row) => { if (fields.status) row.status = fields.status; });
      return { updated: rows.length };
    },
    scoreCase: async (caseId, inputs) => {
      const score = Math.round(Object.values(inputs).reduce((total, value) => total + Number(value), 0) * 4);
      const row = { id: id(), score, band: score >= 75 ? "strong" : score >= 45 ? "developing" : "needs_evidence", inputs, created_at: now() };
      (await workspace(caseId)).strength.unshift(row); return clone(row);
    },
    setCaseRestriction: async (caseId, restricted, reason) => {
      const state = await workspace(caseId); Object.assign(state.scope, { is_restricted: restricted, restriction_reason: restricted ? reason : null }); return clone(state.scope);
    },
    createCaseReminder: async (scope, fields) => {
      const row = { id: id(), title: fields.title, remind_at: fields.remindAt, recurrence: fields.recurrence, status: "pending" };
      (await workspace(scope.id)).reminders.push(row); return clone(row);
    },
    setReminderStatus: async (reminderId, action, remindAt) => {
      const row = await locate("reminders", reminderId); row.status = action === "completed" ? "completed" : action === "dismissed" ? "dismissed" : "pending";
      if (remindAt) row.remind_at = remindAt; return clone(row);
    },
    logManagementBehavior: async (caseId, fields) => {
      const row = { id: id(), category: fields.category, summary: fields.summary, occurred_at: fields.occurredAt, casework_management_people: { display_name: fields.displayName, title: fields.title, workplace: fields.workplace }, casework_management_addenda: [] };
      (await workspace(caseId)).management.unshift(row); return clone(row);
    },
    addManagementAddendum: async (entryId, body) => {
      const entry = await locate("management", entryId); const row = { id: id(), body, created_at: now() }; entry.casework_management_addenda.push(row); return clone(row);
    },
    linkCases: async (sourceCaseId, targetCaseId, relationship, note) => {
      await findCase(targetCaseId); const row = { id: id(), target_case_id: targetCaseId, relationship, note };
      (await workspace(sourceCaseId)).links.push(row); return clone(row);
    },
  };
  api.acknowledgeAlert = api.acknowledgeCaseAlert;
  return api;
}
