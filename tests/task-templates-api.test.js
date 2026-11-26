// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  convertChapterTaskToTemplate,
  createChapterTaskFromTemplate,
  loadMemberApp,
  taskTemplateDetailsFromRow,
  updateChapterTaskTemplateDetails,
} from "../src/lib/memberApi.js";

const DETAIL_COLUMNS = "task_id,chapter_id,template_key,flow_step,scheduled_on,starts_at,ends_at,venue_mode,review_kind,reviewer_id,contact_method,follow_up_on,record_category,record_source,occurred_on,incident_severity,created_by,updated_by,created_at,updated_at";

function bootClient({
  catalog = [], reviewers = [], details = [], catalogError = null, reviewerError = null,
  detailError = null, roles = ["steward"], standing = { blocked: false, holdsStaffRole: true, enrolled: true, assured: true },
} = {}) {
  const calls = [];
  const profile = {
    id: "user-1", first_name: "D", full_name: "D F", initials: "DF", role_line: "Member",
    member_since: 2023, language: "en", notification_prefs: {}, chapter_id: "wor",
  };
  const chain = (table, result) => {
    const proxy = new Proxy(() => {}, {
      get(_target, prop) {
        if (prop === "then") return (...args) => Promise.resolve(result).then(...args);
        return (...args) => {
          calls.push([table, prop, args]);
          return proxy;
        };
      },
    });
    return proxy;
  };
  return {
    calls,
    from(table) {
      if (table === "member_profiles") return chain(table, { data: profile, error: null });
      if (table === "member_roles") return chain(table, { data: roles.map((role) => ({ role })), error: null });
      if (table === "chapter_task_template_details") return chain(table, { data: details, error: detailError });
      return chain(table, { data: [], error: null });
    },
    rpc(name, args) {
      calls.push(["rpc", name, [args]]);
      if (name === "list_chapter_task_templates") return Promise.resolve({ data: catalog, error: catalogError });
      if (name === "list_chapter_task_template_reviewers") return Promise.resolve({ data: reviewers, error: reviewerError });
      if (name === "get_staff_mfa_standing") return Promise.resolve({ data: standing, error: null });
      if (name === "get_member_rewards_summary" || name === "get_workload_stats") return Promise.resolve({ data: {}, error: null });
      return Promise.resolve({ data: [], error: null });
    },
  };
}

describe("specialized task template API", () => {
  it("maps every typed nullable detail column", () => {
    expect(taskTemplateDetailsFromRow({
      task_id: "task-1", chapter_id: "wor", template_key: "meeting_event", flow_step: "confirmed",
      scheduled_on: "2026-08-20", starts_at: "09:00:00", ends_at: null, venue_mode: "hybrid",
      review_kind: null, reviewer_id: null, contact_method: null, follow_up_on: null,
      record_category: null, record_source: null, occurred_on: null, incident_severity: null,
      created_by: "user-1", updated_by: "user-2", created_at: "created", updated_at: "updated",
    })).toEqual({
      taskId: "task-1", chapterId: "wor", templateKey: "meeting_event", flowStep: "confirmed",
      scheduledOn: "2026-08-20", startsAt: "09:00:00", endsAt: null, venueMode: "hybrid",
      reviewKind: null, reviewerId: null, contactMethod: null, followUpOn: null,
      recordCategory: null, recordSource: null, occurredOn: null, incidentSeverity: null,
      createdBy: "user-1", updatedBy: "user-2", createdAt: "created", updatedAt: "updated",
    });
  });

  it("creates through the atomic RPC with literal snake-case fields", async () => {
    const calls = [];
    const client = { rpc: (name, args) => {
      calls.push(["rpc", name, [args]]);
      return Promise.resolve({ data: {
        task: { id: "task-1", title: "Call back", status: "to_do", priority: "medium", task_type: "member_follow_up", workstream: "Organizing" },
        details: { task_id: "task-1", chapter_id: "wor", template_key: "member_follow_up", flow_step: "prepare", contact_method: "phone", follow_up_on: "2026-08-20" },
      }, error: null });
    } };
    const result = await createChapterTaskFromTemplate(client, {
      templateKey: "member_follow_up", title: " Call back ", workstream: "Organizing",
      fields: { contact_method: "phone", follow_up_on: "2026-08-20" },
    });
    expect(calls).toContainEqual(["rpc", "create_chapter_task_from_template", [{
      p_template_key: "member_follow_up", p_title: "Call back", p_workstream: "Organizing",
      p_fields: { contact_method: "phone", follow_up_on: "2026-08-20" },
    }]]);
    expect(result.task).toEqual(expect.objectContaining({ id: "task-1", taskType: "member_follow_up" }));
    expect(result.details).toEqual(expect.objectContaining({ taskId: "task-1", contactMethod: "phone" }));
  });

  // #8211: an existing General task changes type through one server-checked RPC.
  it("converts an existing task through the atomic RPC with literal snake-case fields", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: {
      task: { id: "task-9", title: "Planning", status: "to_do", task_type: "meeting_event" },
      details: { task_id: "task-9", chapter_id: "wor", template_key: "meeting_event", flow_step: "proposed", scheduled_on: "2026-12-01", venue_mode: "video" },
    }, error: null });
    const result = await convertChapterTaskToTemplate({ rpc }, {
      taskId: "task-9", templateKey: "meeting_event", fields: { scheduled_on: "2026-12-01", venue_mode: "video" },
    });
    expect(rpc.mock.calls).toStrictEqual([["convert_chapter_task_to_template", {
      p_task_id: "task-9", p_template_key: "meeting_event", p_fields: { scheduled_on: "2026-12-01", venue_mode: "video" },
    }]]);
    expect(result.task).toEqual(expect.objectContaining({ id: "task-9", title: "Planning", taskType: "meeting_event" }));
    expect(result.details).toEqual(expect.objectContaining({ taskId: "task-9", scheduledOn: "2026-12-01", venueMode: "video" }));
    await expect(convertChapterTaskToTemplate({ rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "template fields invalid", code: "22023" } }) },
      { taskId: "task-9", templateKey: "meeting_event" })).rejects.toThrow();
  });

  it("updates details and explicit status intent through the atomic RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: {
      task: { id: "task-1", title: "Confirmed follow up", status: "in_progress", task_type: "member_follow_up" },
      details: {
        task_id: "task-1", chapter_id: "wor", template_key: "member_follow_up",
        flow_step: "contact", contact_method: "email", follow_up_on: null,
      },
    }, error: null });
    const result = await updateChapterTaskTemplateDetails({ rpc }, {
      taskId: "task-1", fields: { contact_method: "email", follow_up_on: null },
      nextFlowStep: "contact", applyRecommendedStatus: false,
    });
    expect(rpc.mock.calls).toStrictEqual([["update_chapter_task_template_details", {
      p_task_id: "task-1", p_fields: { contact_method: "email", follow_up_on: null },
      p_next_flow_step: "contact", p_apply_recommended_status: false,
    }]]);
    expect(result).toMatchObject({
      task: { id: "task-1", title: "Confirmed follow up", status: "in_progress", taskType: "member_follow_up" },
      details: {
        taskId: "task-1", chapterId: "wor", templateKey: "member_follow_up",
        flowStep: "contact", contactMethod: "email", followUpOn: null,
      },
    });
  });

  it("preserves recommended-status intent with default edit fields and flow", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: {
      task: { id: "task-2" }, details: { task_id: "task-2", template_key: "member_follow_up" },
    }, error: null });
    await expect(updateChapterTaskTemplateDetails({ rpc }, { taskId: "task-2", applyRecommendedStatus: true }))
      .resolves.toMatchObject({ task: { id: "task-2" }, details: { taskId: "task-2" } });
    expect(rpc.mock.calls).toStrictEqual([["update_chapter_task_template_details", {
      p_task_id: "task-2", p_fields: {}, p_next_flow_step: null, p_apply_recommended_status: true,
    }]]);
  });

  it("propagates a refused template update with its operation label and error code", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code: "42501", message: "update refused" } });
    await expect(updateChapterTaskTemplateDetails({ rpc }, { taskId: "task-1", fields: { contact_method: "email" } }))
      .rejects.toMatchObject({ code: "42501", message: "Update task template: update refused" });
  });

  it("loads catalog/details additively with an exact safe detail projection", async () => {
    const detail = { task_id: "task-1", chapter_id: "wor", template_key: "issue_incident", flow_step: "triage", occurred_on: "2026-08-19", incident_severity: "high" };
    const client = bootClient({
      catalog: [{ key: "issue_incident" }],
      reviewers: [{ id: "staff-1", fullName: "Sam Steward" }],
      details: [detail],
    });
    const out = await loadMemberApp(client, { id: "user-1", email: "d@example.org" });
    expect(out.taskTemplates).toEqual([{ key: "issue_incident" }]);
    expect(out.taskTemplateReviewers).toEqual([{ id: "staff-1", fullName: "Sam Steward" }]);
    expect(out.taskTemplateDetails).toEqual([expect.objectContaining({ taskId: "task-1", incidentSeverity: "high" })]);
    expect(client.calls.find(([table, method]) => table === "chapter_task_template_details" && method === "select")?.[2][0]).toBe(DETAIL_COLUMNS);

    const degraded = await loadMemberApp(bootClient({
      catalogError: { message: "function missing" }, reviewerError: { message: "function missing" }, detailError: { message: "table missing" },
    }), { id: "user-1", email: "d@example.org" });
    expect(degraded.taskTemplates).toEqual([]);
    expect(degraded.taskTemplateReviewers).toEqual([]);
    expect(degraded.taskTemplateDetails).toEqual([]);
    expect(degraded.tasks).toEqual([]);
  });

  it("does not call staff-only catalog RPCs for ordinary, MFA-blocked, or unassured members", async () => {
    for (const client of [
      bootClient({ roles: [], standing: { blocked: false, holdsStaffRole: false, enrolled: false, assured: true } }),
      bootClient({ roles: ["steward"], standing: { blocked: true, holdsStaffRole: true, enrolled: false, assured: true } }),
      bootClient({ roles: ["steward"], standing: { blocked: false, holdsStaffRole: true, enrolled: true, assured: false } }),
    ]) {
      const out = await loadMemberApp(client, { id: "user-1", email: "d@example.org" });
      expect(out.taskTemplates).toEqual([]);
      expect(out.taskTemplateReviewers).toEqual([]);
      expect(client.calls.some(([table, name]) =>
        table === "rpc" && ["list_chapter_task_templates", "list_chapter_task_template_reviewers"].includes(name))).toBe(false);
    }
  });
});
