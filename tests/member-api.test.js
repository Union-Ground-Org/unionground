import { createMemberOutboxExecutors } from "../src/lib/memberOutboxExecutors.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { FORM_TEMPLATES } from "../src/lib/formTemplates.js";
import {
  addChapterTaskAttachment,
  addChapterTaskComment,
  checkInToEvent,
  getMemberOrganizationStructure,
  createChapterSpace,
  updateChapterHandshakeStatus,
  createChapterThread,
  createChapterTask,
  createChapterTaskFromSource,
  createMemberCase,
  loadMemberApp,
  loadStewardDesk,
  moveChapterTask,
  publishMemberBroadcast,
  requestSteward,
  removeChapterTaskAttachment,
  restoreChapterTask,
  retireChapterKnowledgeArticle,
  retractMemberBroadcast,
  saveChapterKnowledgeArticle,
  saveGuideExchange,
  saveMyReportPreferences,
  saveRightsProgress,
  sendChapterTaskMessage,
  setChapterTaskAssignees,
  softDeleteChapterTask,
  sendMemberMessage,
  toggleMemberMessageReaction,
  toggleMemberSavedMessage,
  scheduleMemberMessage,
  cancelScheduledMemberMessage,
  createMemberMessageReminder,
  cancelMemberMessageReminder,
  getBroadcastReadCounts,
  sendMemberResource,
  markConversationRead,
  markBroadcastRead,
  sendStewardReply,
  sendStewardResource,
  listScheduledMemberMessages,
  listMemberContactNotes,
  createMemberContactNote,
  reviewStewardEmailIntake,
  createEventFromMemberMessage,
  submitBallot,
  submitEventRsvp,
  submitSurvey,
  submitWorkloadLog,
  getWorkloadReminderPreferences,
  setWorkloadReminderPreferences,
  triageStewardRequest,
  triageMemberIntake,
  convertMemberIntake,
  updateChapterTask,
  MEMBER_FORM_PAGE,
  MEMBER_FORM_MAX_PAGES,
} from "../src/lib/memberApi.js";

it("saves the complete member report layout through its self-scoped RPC", async () => {
  const rpc = vi.fn().mockResolvedValue({ data: {}, error: null });
  const config = { order: ["actions", "cases"], hidden: ["cases"], custom: [] };
  await saveMyReportPreferences({ rpc }, config);
  expect(rpc).toHaveBeenCalledWith("save_my_report_preferences", { p_config: config });
});

// Generic chainable fake: every builder method returns the proxy again and
// awaiting it resolves the canned result, so query shape changes don't break
// these tests — only the table/rpc routing and the mapped output are pinned.
function chainable(result) {
  const proxy = new Proxy(function () {}, {
    get(_target, prop) {
      if (prop === "then") return (...args) => Promise.resolve(result).then(...args);
      return () => proxy;
    },
  });
  return proxy;
}

function fakeClient({ tables = {}, rpcs = {} } = {}) {
  return {
    // A table value may be an array of per-call results consumed FIFO (same
    // convention as deskClient in tests/steward-appointments-paging.test.js)
    // — member_forms is queried once per page of the SOL-20260813-06 walk.
    // The array's last entry repeats once exhausted, so an over-call shows up
    // as extra rows/loops instead of silently running out of canned data.
    from: (table) => {
      const canned = tables[table];
      const result = Array.isArray(canned) ? (canned.length > 1 ? canned.shift() : canned[0]) : canned;
      return chainable(result ?? { data: [], error: null });
    },
    rpc: (name, args) => {
      const handler = rpcs[name];
      const result = typeof handler === "function" ? handler(args) : handler;
      return Promise.resolve(result ?? { data: null, error: { message: `no fake for rpc ${name}` } });
    },
  };
}

const baseProfile = {
  id: "user-1",
  first_name: "Darnell",
  full_name: "Darnell Foster",
  initials: "DF",
  role_line: "Member",
  member_since: 2023,
  language: "en",
  notification_prefs: { deadlines: true, cases: true, votes: true, events: true },
  chapter_id: "wor",
};

function memberAppTables(overrides = {}) {
  return {
    member_profiles: { data: baseProfile, error: null },
    chapters: { data: [{ id: "wor", name: "Harborview Care United" }], error: null },
    ...overrides,
  };
}

const memberAppRpcs = {
  get_member_rewards_summary: { data: {}, error: null },
  get_workload_stats: { data: {}, error: null },
  list_chapter_task_assignees: {
    data: [{ user_id: "user-2", full_name: "Maria Santos", initials: "MS" }],
    error: null,
  },
  list_reward_peer_contact: {
    data: { available: true, canRequest: false, code: "PSG-0123456789ABCDEF0123", incoming: [], outgoing: [], conversations: [] },
    error: null,
  },
};

it("preserves an explicit unavailable state when the peer-contact projection fails", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const inner = fakeClient({
    tables: memberAppTables(),
    rpcs: {
      ...memberAppRpcs,
      list_reward_peer_contact: { data: null, error: { message: "peer projection unavailable" } },
    },
  });
  const rpc = vi.fn(inner.rpc);
  const client = { ...inner, rpc };

  const out = await loadMemberApp(client, { id: "user-1", email: "d@example.org" });
  expect(out.peerContact).toMatchObject({ available: false, unavailable: true, canRequest: false });
  // Labs (experimental content) and reward effects left with the points
  // economy: neither is requested nor projected.
  expect(rpc).not.toHaveBeenCalledWith("list_reward_experimental_content", expect.anything());
  expect(rpc).not.toHaveBeenCalledWith("get_member_reward_effects");
  expect(out).not.toHaveProperty("experimentalContent");
  expect(out).not.toHaveProperty("experimentalContentUnavailable");
  warn.mockRestore();
});

it("projects a soft-failed report-preferences RPC as unavailable instead of an empty layout", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const client = fakeClient({
    tables: memberAppTables(),
    rpcs: {
      ...memberAppRpcs,
      get_my_report_preferences: { data: null, error: { message: "report preferences unavailable" } },
    },
  });

  const out = await loadMemberApp(client, { id: "user-1", email: "d@example.org" });
  expect(out).toMatchObject({ reportPreferences: null, reportPreferencesUnavailable: true });
  warn.mockRestore();
});

it("projects a readable report-preferences row with the unavailable flag false", async () => {
  // Companion to the soft-failure case: fakeClient already soft-fails every
  // unstubbed RPC, so only a successful row proves the flag tracks the read.
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const row = { order: ["actions"], hidden: ["cases"], custom: [] };
  const client = fakeClient({
    tables: memberAppTables(),
    rpcs: { ...memberAppRpcs, get_my_report_preferences: { data: row, error: null } },
  });

  const out = await loadMemberApp(client, { id: "user-1", email: "d@example.org" });
  expect(out.reportPreferencesUnavailable).toBe(false);
  expect(out.reportPreferences).toEqual(row);
  warn.mockRestore();
});

describe("unified messaging adapters", () => {
  it("maps every member and steward action to its narrow server boundary", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { ok: true }, error: null });
    const from = vi.fn(() => chainable({ data: [{ id: "scheduled-1" }], error: null }));
    const client = { rpc, from };

    await toggleMemberMessageReaction(client, "private", "message-1", "support");
    await toggleMemberSavedMessage(client, "channel", "post-1");
    await scheduleMemberMessage(client, "conversation-1", "  Later  ", "2026-08-13T14:00:00.000Z");
    await cancelScheduledMemberMessage(client, "scheduled-1");
    await createMemberMessageReminder(client, "task", "task-message-1", "2026-08-14T14:00:00.000Z", "  Check back  ");
    await cancelMemberMessageReminder(client, "reminder-1");
    await getBroadcastReadCounts(client);
    await sendMemberResource(client, "conversation-1", "document-1", "  Read this  ");
    await sendStewardResource(client, "conversation-1", "document-2");
    expect(await listScheduledMemberMessages(client, "conversation-1")).toEqual([{ id: "scheduled-1" }]);
    await listMemberContactNotes(client, "conversation-1");
    await createMemberContactNote(client, "conversation-1", "  Private note  ", "message-1");
    await reviewStewardEmailIntake(client, "intake-1", "accept");
    await createEventFromMemberMessage(client, "message-1", {
      id: " event-1 ", title: " Follow up ", startsAt: "2026-08-15T14:00:00.000Z",
      location: " Union hall ", summary: " Agenda ", checkInCode: " sg-abc123 ",
    });
    await markConversationRead(client, "member-1", "conversation-1");
    await markBroadcastRead(client, "member-1", "broadcast-1");
    await createChapterThread(client, { spaceId: "space-1", title: "  Shift updates  ", kind: "discussion" });

    expect(rpc).toHaveBeenCalledWith("act_on_member_message", { p_source_kind: "private", p_message_id: "message-1", p_action: "react", p_value: "support" });
    expect(rpc).toHaveBeenCalledWith("schedule_member_message", { p_conversation_id: "conversation-1", p_body: "Later", p_scheduled_for: "2026-08-13T14:00:00.000Z" });
    expect(rpc).toHaveBeenCalledWith("cancel_scheduled_member_message", { p_scheduled_message_id: "scheduled-1" });
    expect(rpc).toHaveBeenCalledWith("create_member_message_reminder", { p_source_kind: "task", p_message_id: "task-message-1", p_remind_at: "2026-08-14T14:00:00.000Z", p_note: "Check back" });
    expect(rpc).toHaveBeenCalledWith("cancel_member_message_reminder", { p_reminder_id: "reminder-1" });
    expect(rpc).toHaveBeenCalledWith("get_broadcast_read_counts");
    expect(rpc).toHaveBeenCalledWith("send_member_resource", { p_conversation_id: "conversation-1", p_document_id: "document-1", p_body: "Read this" });
    expect(rpc).toHaveBeenCalledWith("send_steward_resource", { p_conversation_id: "conversation-1", p_document_id: "document-2", p_body: null });
    expect(rpc).toHaveBeenCalledWith("create_member_contact_note", { p_conversation_id: "conversation-1", p_note: "Private note", p_source_message_id: "message-1" });
    expect(rpc).toHaveBeenCalledWith("review_steward_email_intake", { p_intake_id: "intake-1", p_action: "accept" });
    expect(rpc).toHaveBeenCalledWith("create_event_from_member_message", expect.objectContaining({ p_event_id: "event-1", p_check_in_code: "SG-ABC123" }));
    expect(from).toHaveBeenCalledWith("member_scheduled_messages");
    expect(from).toHaveBeenCalledWith("member_messages");
    expect(from).toHaveBeenCalledWith("member_broadcast_receipts");
    expect(from).toHaveBeenCalledWith("chapter_threads");
  });

  it("refuses unavailable scheduled-message and reminder cancels", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { message: "scheduled message unavailable", code: "22023" } })
      .mockResolvedValueOnce({ data: null, error: { message: "reminder unavailable", code: "22023" } })
      .mockResolvedValueOnce({ data: null, error: { message: "steward role required", code: "42501" } });
    await expect(cancelScheduledMemberMessage({ rpc }, "scheduled-1")).rejects.toMatchObject({ code: "22023" });
    await expect(cancelMemberMessageReminder({ rpc }, "reminder-1")).rejects.toMatchObject({ code: "22023" });
    await expect(getBroadcastReadCounts({ rpc })).rejects.toMatchObject({ code: "42501" });
  });
});

describe("loadMemberApp chapter threading", () => {
  it("promotes the selected organization grant before staff route gating", async () => {
    const client = fakeClient({
      tables: memberAppTables({ member_roles: { data: [], error: null } }),
      rpcs: {
        ...memberAppRpcs,
        get_my_chapter_memberships: {
          data: [{
            chapterId: "wor",
            organizationId: "11111111-1111-4111-8111-111111111111",
            selected: true,
            roles: ["admin"],
            organizationRoles: ["admin"],
            chapterRoles: [],
          }],
          error: null,
        },
      },
    });
    const out = await loadMemberApp(client, { id: "user-1", email: "d@example.org" });
    expect(out.roles).toContain("admin");
    expect(out.member).toMatchObject({
      organizationId: "11111111-1111-4111-8111-111111111111",
      organizationRoles: ["admin"],
      chapterRoles: [],
      membershipStatus: "active",
    });
    expect(out.rolesUnknown).toBe(false);
  });

  // BUG-UG-CHAPTER-ROLES-HIDDEN-UNTIL-CHAPTER-SWITCH-20261003: the
  // rail lists every chapter the member belongs to, not only the selected one.
  it("carries every chapter membership the server returns for the chapter rail", async () => {
    const org = "11111111-1111-4111-8111-111111111111";
    const client = fakeClient({
      tables: memberAppTables({ member_roles: { data: [], error: null } }),
      rpcs: {
        ...memberAppRpcs,
        get_my_chapter_memberships: {
          data: [
            { chapterId: "hb-local", name: "Harrow Bay Local", organizationId: org, selected: true, roles: ["member"], organizationRoles: [], chapterRoles: [] },
            { chapterId: "hb-hhs", name: "HHS Chapter", organizationId: org, selected: false, roles: ["vp"], organizationRoles: [], chapterRoles: ["vp"] },
            { chapterId: null, name: null, organizationId: org, selected: false, roles: ["admin"], organizationRoles: ["admin"], chapterRoles: [] },
          ],
          error: null,
        },
      },
    });
    const out = await loadMemberApp(client, { id: "user-1", email: "d@example.org" });
    expect(out.member.chapterMemberships).toEqual([
      { chapterId: "hb-local", name: "Harrow Bay Local", selected: true },
      { chapterId: "hb-hhs", name: "HHS Chapter", selected: false },
    ]);
    // Hats still come only from the selected membership.
    expect(out.roles).not.toContain("vp");
  });

  it("maps durable navigation arrays from the signed-in profile", async () => {
    const client = fakeClient({
      tables: memberAppTables({
        member_profiles: { data: {
          ...baseProfile,
          shortcut_keys: ["cases", "messages"],
          work_widget_order: ["cases", "messages", "appointments", "forms", "workload", "numbers"],
        }, error: null },
      }),
      rpcs: memberAppRpcs,
    });
    const out = await loadMemberApp(client, { id: "user-1", email: "d@example.org" });
    expect(out.member.shortcutKeys).toEqual(["cases", "messages"]);
    expect(out.member.workWidgetOrder).toEqual(["cases", "messages", "appointments", "forms", "workload", "numbers"]);
  });

  it("maps pre-migration profile values to empty arrays for canonical defaults", async () => {
    const client = fakeClient({ tables: memberAppTables(), rpcs: memberAppRpcs });
    const out = await loadMemberApp(client, { id: "user-1", email: "d@example.org" });
    expect(out.member.shortcutKeys).toEqual([]);
    expect(out.member.workWidgetOrder).toEqual([]);
  });

  it("maps the profile chapter to its display name", async () => {
    const client = fakeClient({ tables: memberAppTables(), rpcs: memberAppRpcs });
    const out = await loadMemberApp(client, { id: "user-1", email: "d@example.org" });
    expect(out.member.chapterId).toBe("wor");
    expect(out.member.chapterName).toBe("Harborview Care United");
  });

  it("degrades to the slug when the chapters read fails", async () => {
    const client = fakeClient({
      tables: memberAppTables({ chapters: { data: null, error: { message: "boom" } } }),
      rpcs: memberAppRpcs,
    });
    const out = await loadMemberApp(client, { id: "user-1", email: "d@example.org" });
    expect(out.member.chapterId).toBe("wor");
    expect(out.member.chapterName).toBe("wor");
  });

  it("degrades to empty strings for a pre-chapter profile row", async () => {
    const inner = fakeClient({
      tables: memberAppTables({ member_profiles: { data: { ...baseProfile, chapter_id: null }, error: null } }),
      rpcs: memberAppRpcs,
    });
    const rpc = vi.fn(inner.rpc);
    const client = { ...inner, rpc };
    const out = await loadMemberApp(client, { id: "user-1", email: "d@example.org" });
    expect(out.member.chapterId).toBe("");
    expect(out.member.chapterName).toBe("");
    expect(rpc).not.toHaveBeenCalledWith("list_chapter_task_assignees");
    expect(rpc).not.toHaveBeenCalledWith("list_weekly_questions");
    expect(rpc).not.toHaveBeenCalledWith("get_member_reward_effects");
    expect(out).not.toHaveProperty("rewardEffects");
  });

  it("localizes the generic 'Chapter steward' conversation title but leaves a named sender untouched", async () => {
    const client = fakeClient({
      tables: memberAppTables({
        member_profiles: { data: { ...baseProfile, language: "es" }, error: null },
        member_conversations: {
          data: [
            { id: "conv-steward", title: "Chapter steward", initials: "CS", user_id: "user-1", updated_at: "2026-08-01T00:00:00Z" },
            { id: "conv-named", title: "Maria Santos", initials: "MS", user_id: "user-1", updated_at: "2026-08-02T00:00:00Z" },
          ],
          error: null,
        },
      }),
      rpcs: memberAppRpcs,
    });
    const out = await loadMemberApp(client, { id: "user-1", email: "d@example.org" });
    const steward = out.conversations.find((item) => item.id === "conv-steward");
    const named = out.conversations.find((item) => item.id === "conv-named");
    expect(steward.counterpartRole).toBe("steward");
    expect(named.counterpartRole).toBe("steward");
    // Spanish profile: the generic row is translated, not passed through raw.
    expect(steward.sender).toBe("Miembro del comité de la campaña");
    expect(steward.sender).not.toMatch(/capítulo|Delegado/);
    // A row already carrying a real name is never rewritten by the check.
    expect(named.sender).toBe("Maria Santos");
  });

  it("does not request intake owners for an admin-only caller", async () => {
    const called = [];
    const inner = fakeClient({
      tables: memberAppTables({ member_roles: { data: [{ role: "admin" }], error: null } }),
      rpcs: memberAppRpcs,
    });
    const client = {
      from: inner.from,
      rpc: (name, args) => { called.push(name); return inner.rpc(name, args); },
    };
    const out = await loadMemberApp(client, { id: "user-1", email: "d@example.org" });
    expect(called).not.toContain("list_intake_triage_owners");
    expect(out.intakeOwners).toEqual([]);
  });
});

describe("authoritative Compass knowledge client", () => {
  const row = (overrides = {}) => ({
    id: "kb-1",
    slug: "chapter-kb-1",
    chapter_id: "wor",
    kind: "contract",
    title: "Verified source",
    article_ref: "Agreement · Article 1",
    body: "Approved source text.",
    keywords: ["approved"],
    order_index: 1,
    status: "published",
    is_sample: false,
    version: 2,
    created_by: "staff-1",
    updated_by: "staff-1",
    verified_by: "staff-1",
    verified_at: "2026-08-12T12:00:00Z",
    created_at: "2026-08-12T11:00:00Z",
    updated_at: "2026-08-12T12:00:00Z",
    ...overrides,
  });

  it("feeds search only verified published non-samples while retaining chapter lifecycle rows for staff", async () => {
    const rows = [
      row(),
      row({ id: "kb-draft", slug: "chapter-kb-draft", status: "draft", version: 1, verified_by: null, verified_at: null }),
      row({ id: "kb-retired", slug: "chapter-kb-retired", status: "retired", version: 3 }),
      row({ id: "kb-sample", slug: "legacy-sample", chapter_id: null, status: "retired", is_sample: true, created_by: null, updated_by: null, verified_by: null, verified_at: null }),
    ];
    const client = fakeClient({
      tables: memberAppTables({ member_kb_articles: { data: rows, error: null } }),
      rpcs: memberAppRpcs,
    });

    const out = await loadMemberApp(client, { id: "user-1", email: "d@example.org" });

    expect(out.kbArticles).toEqual([expect.objectContaining({ id: "kb-1", ref: "Agreement · Article 1", status: "published" })]);
    expect(out.product.compassKnowledge.map((article) => article.id)).toEqual(["kb-1", "kb-draft", "kb-retired"]);
    expect(out.product.compassKnowledge.find((article) => article.id === "kb-draft")).toMatchObject({
      isSample: false,
      verifiedAt: null,
      status: "draft",
    });
  });

  it("bounds body-bearing knowledge rows to one request during member boot", async () => {
    const rows = Array.from({ length: 501 }, (_, index) => row({
      id: `kb-${index}`,
      slug: `chapter-kb-${index}`,
      order_index: index,
    }));
    const knowledgeQuery = {
      select: vi.fn(),
      order: vi.fn(),
      limit: vi.fn(),
      range: vi.fn(),
    };
    knowledgeQuery.select.mockReturnValue(knowledgeQuery);
    knowledgeQuery.order.mockReturnValue(knowledgeQuery);
    knowledgeQuery.limit.mockImplementation(async (size) => ({
      data: rows.slice(0, size),
      error: null,
    }));
    knowledgeQuery.range.mockImplementation(async (from, to) => ({
      data: rows.slice(from, to + 1),
      error: null,
    }));
    const inner = fakeClient({ tables: memberAppTables(), rpcs: memberAppRpcs });
    const client = {
      ...inner,
      from: (table) => table === "member_kb_articles" ? knowledgeQuery : inner.from(table),
    };

    const out = await loadMemberApp(client, { id: "user-1", email: "d@example.org" });

    expect(out.kbArticles).toHaveLength(100);
    expect(out.product.compassKnowledge).toHaveLength(100);
    expect(knowledgeQuery.limit).toHaveBeenCalledOnce();
    expect(knowledgeQuery.limit).toHaveBeenCalledWith(100);
    expect(knowledgeQuery.range).not.toHaveBeenCalled();
  });

  it("sends normalized fields to the guarded save and retire RPCs", async () => {
    const rpc = vi.fn((name) => Promise.resolve({
      data: name === "save_chapter_kb_article" ? row() : row({ status: "retired", version: 3 }),
      error: null,
    }));
    const client = { rpc };

    await expect(saveChapterKnowledgeArticle(client, {
      articleId: null,
      kind: "contract",
      title: "  Verified source  ",
      articleRef: " Agreement · Article 1 ",
      body: " Approved source text. ",
      keywords: ["approved", " source "],
      status: "published",
      confirmVerified: true,
      chapterId: "chapter-b",
    })).resolves.toMatchObject({ id: "kb-1", chapterId: "wor", verifiedBy: "staff-1" });
    await expect(retireChapterKnowledgeArticle(client, "kb-1", "chapter-b")).resolves.toMatchObject({ status: "retired", version: 3 });

    expect(rpc.mock.calls).toEqual([
      ["save_chapter_kb_article", {
        p_article_id: null,
        p_kind: "contract",
        p_title: "Verified source",
        p_article_ref: "Agreement · Article 1",
        p_body: "Approved source text.",
        p_keywords: ["approved", "source"],
        p_status: "published",
        p_confirm_verified: true,
        p_chapter_id: "chapter-b",
      }],
      ["retire_chapter_kb_article", { p_article_id: "kb-1", p_chapter_id: "chapter-b" }],
    ]);
  });

  it("preserves the operation label on guarded RPC failures", async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "staff role and required assurance level required", code: "42501" } }) };
    await expect(saveChapterKnowledgeArticle(client, {
      kind: "faq", title: "Title", articleRef: "Reference", body: "Body", keywords: [], status: "draft", confirmVerified: false,
    })).rejects.toMatchObject({ name: "MemberApiError", label: "Save Guide source", code: "42501" });
    await expect(retireChapterKnowledgeArticle(client, "kb-1")).rejects.toThrow("Retire Guide source: staff role and required assurance level required");
  });
});

describe("loadMemberApp accepted co-signer reads", () => {
  it("partitions cross-member grievances out of editable forms and binds only an accepted matching invite", async () => {
    const client = fakeClient({
      tables: memberAppTables({
        member_forms: { data: [
          { id: "own-form", user_id: "user-1", template_key: "grievance", template_version: 1, status: "draft", answers: { summary: "Mine" }, step: 1 },
          { id: "accepted-form", user_id: "user-2", template_key: "alliance_grievance", template_version: 1, status: "submitted", answers: { summary: "Shared", narrative: "Readable after acceptance" }, step: 3 },
          { id: "reaffirm-form", user_id: "user-3", template_key: "alliance_grievance", template_version: 1, status: "submitted", answers: { narrative: "Must stay hidden" }, step: 3 },
        ], error: null },
        member_form_cosigners: { data: [
          { id: "c-accepted", form_id: "accepted-form", invited_email: "d@example.org", cosigner_user_id: "user-1", status: "accepted", invited_at: "2026-08-01" },
          { id: "c-reaffirm", form_id: "reaffirm-form", invited_email: "d@example.org", cosigner_user_id: "user-1", status: "reaffirm_needed", invited_at: "2026-08-02" },
        ], error: null },
      }),
      rpcs: {
        ...memberAppRpcs,
        cosign_invite_preview: ({ p_form_id }) => ({ data: { summary: p_form_id, filerName: "Another member" }, error: null }),
      },
    });
    const out = await loadMemberApp(client, { id: "user-1", email: "d@example.org" });
    expect(out.forms.map((form) => form.id)).toEqual(["own-form"]);
    expect(out.cosignRequests.find((request) => request.formId === "accepted-form")?.grievance?.answers.narrative).toBe("Readable after acceptance");
    expect(out.cosignRequests.find((request) => request.formId === "reaffirm-form")?.grievance).toBeNull();
    // A single short page is well under the bound — no false truncation claim.
    expect(out.formsTruncated).toBe(false);
  });
});

// SOL-20260813-06: fetchAllAccessibleMemberForms used to page 200 rows at a
// time with no total bound (a large archive meant dozens of sequential
// calls during boot) and a mid-walk error discarded every row already
// confirmed. Both are bounded and disclosed now.
describe("loadMemberApp member forms pagination bound (SOL-20260813-06)", () => {
  function formsPage(pageIndex, count = MEMBER_FORM_PAGE) {
    return Array.from({ length: count }, (_, i) => ({
      id: `form-${pageIndex}-${i}`,
      user_id: "user-1",
      template_key: "grievance",
      template_version: 1,
      status: "submitted",
      answers: {},
      step: 3,
      updated_at: `2026-0${(pageIndex % 9) + 1}-01T00:00:00Z`,
    }));
  }

  it("reports truncation for 2,001 rows while retaining only the bounded 2,000", async () => {
    // The last bounded request carries row 2,001 as a sentinel. If the loop
    // over-runs, the call count will exceed MEMBER_FORM_MAX_PAGES; if the
    // sentinel leaks, out.forms will exceed the visible ceiling.
    const pages = Array.from({ length: MEMBER_FORM_MAX_PAGES }, (_, i) => ({
      data: formsPage(i, i === MEMBER_FORM_MAX_PAGES - 1 ? MEMBER_FORM_PAGE + 1 : MEMBER_FORM_PAGE),
      error: null,
    }));
    let memberFormsCalls = 0;
    const inner = fakeClient({ tables: memberAppTables({ member_forms: pages }), rpcs: memberAppRpcs });
    const client = {
      from: (table) => { if (table === "member_forms") memberFormsCalls += 1; return inner.from(table); },
      rpc: inner.rpc,
    };

    const out = await loadMemberApp(client, { id: "user-1", email: "d@example.org" });

    expect(memberFormsCalls).toBe(MEMBER_FORM_MAX_PAGES);
    expect(out.forms).toHaveLength(MEMBER_FORM_MAX_PAGES * MEMBER_FORM_PAGE);
    expect(out.formsTruncated).toBe(true);
  });

  it("does not report truncation when the archive contains exactly 2,000 rows", async () => {
    const pages = Array.from({ length: MEMBER_FORM_MAX_PAGES }, (_, i) => (
      { data: formsPage(i), error: null }
    ));
    let memberFormsCalls = 0;
    const inner = fakeClient({ tables: memberAppTables({ member_forms: pages }), rpcs: memberAppRpcs });
    const client = {
      from: (table) => { if (table === "member_forms") memberFormsCalls += 1; return inner.from(table); },
      rpc: inner.rpc,
    };

    const out = await loadMemberApp(client, { id: "user-1", email: "d@example.org" });

    expect(memberFormsCalls).toBe(MEMBER_FORM_MAX_PAGES);
    expect(out.forms).toHaveLength(MEMBER_FORM_MAX_PAGES * MEMBER_FORM_PAGE);
    expect(out.formsTruncated).toBe(false);
  });

  it("keeps confirmed pages when a later page errors instead of discarding the whole archive", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = fakeClient({
      tables: memberAppTables({
        member_forms: [
          { data: formsPage(0), error: null },
          { data: null, error: { message: "boom" } },
        ],
      }),
      rpcs: memberAppRpcs,
    });

    const out = await loadMemberApp(client, { id: "user-1", email: "d@example.org" });

    // Page one's 200 rows survive the page-two failure.
    expect(out.forms).toHaveLength(MEMBER_FORM_PAGE);
    expect(out.forms.map((form) => form.id)).toContain("form-0-0");
    expect(out.formsTruncated).toBe(true);
    warn.mockRestore();
  });

  it("still degrades to an empty, honestly-unmarked list when the very first page fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = fakeClient({
      tables: memberAppTables({
        member_forms: { data: null, error: { message: "connection reset" } },
      }),
      rpcs: memberAppRpcs,
    });

    const out = await loadMemberApp(client, { id: "user-1", email: "d@example.org" });

    expect(out.forms).toEqual([]);
    // No rows were ever confirmed, so this is a plain read failure, not a
    // truncated archive — the additive [] fallback must not carry a false
    // "more exists" claim.
    expect(out.formsTruncated).toBe(false);
    warn.mockRestore();
  });
});

describe("ballot secrecy: the boot loader never touches the dead linkage table", () => {
  // Since 20260808230000 choices are stored unlinkably in
  // member_ballot_choices (no voter column, unreadable by any client role)
  // and member_ballot_votes sits empty awaiting its drop. A revived self-read
  // would 1) return nothing and mark every ballot un-voted, and 2) re-state
  // the claim that a voter->choice row exists for the client to read.
  it("queries receipts, not member_ballot_votes", async () => {
    const queried = [];
    const inner = fakeClient({ tables: memberAppTables(), rpcs: memberAppRpcs });
    const client = {
      from: (table) => { queried.push(table); return inner.from(table); },
      rpc: inner.rpc,
    };
    await loadMemberApp(client, { id: "user-1", email: "d@example.org" });
    expect(queried).not.toContain("member_ballot_votes");
    expect(queried).toContain("member_ballot_receipts");
  });

  it("derives a ballot's voted state from the member's receipt alone", async () => {
    const futureClose = new Date(Date.now() + 30 * 86400000).toISOString();
    const client = fakeClient({
      tables: memberAppTables({
        member_ballots: { data: [
          { id: "b-cast", title: "Cast ballot", active: true, closes_at: futureClose, order_index: 1, member_ballot_options: [{ id: "b-cast-opt", label: "Yes", order_index: 1 }] },
          { id: "b-open", title: "Open ballot", active: true, closes_at: futureClose, order_index: 2, member_ballot_options: [{ id: "b-open-opt", label: "Yes", order_index: 1 }] },
        ], error: null },
        member_ballot_receipts: { data: [{ ballot_id: "b-cast", receipt_code: "SG-AAAA-BBBB", issued_at: futureClose }], error: null },
      }),
      rpcs: { ...memberAppRpcs, get_ballot_tally: { data: null, error: null } },
    });
    const out = await loadMemberApp(client, { id: "user-1", email: "d@example.org" });
    const cast = out.planItems.find((item) => item.id === "b-cast");
    const open = out.planItems.find((item) => item.id === "b-open");
    expect(cast.action).toBe("Voted");
    expect(cast.receiptCode).toBe("SG-AAAA-BBBB");
    // The choice is unlinkable server-side, so the plan item cannot carry it.
    expect(cast).not.toHaveProperty("selectedOption");
    expect(open.action).toBe("Vote");
    expect(open.receiptCode).toBe("");
  });
});

describe("chapter task client", () => {
  const taskRow = {
    id: "task-1",
    chapter_id: "wor",
    title: "Prepare meeting",
    description: "Agenda and room",
    status: "in_progress",
    priority: "high",
    task_type: "general",
    workstream: "Chapter",
    assignee_id: "user-2",
    assignee_name: "Maria Santos",
    start_date: "2026-07-26",
    due_date: "2026-07-30",
    progress: 45,
    blocked: false,
    milestone: true,
    order_index: 10,
    created_by: "user-1",
    done_at: null,
    created_at: "2026-07-26T12:00:00Z",
    updated_at: "2026-07-26T13:00:00Z",
  };

  it("creates or returns one typed source task through the atomic RPC", async () => {
    const rpc = vi.fn(() => ({
      data: {
        task: taskRow,
        attachment: {
          id: "attachment-1",
          task_id: "task-1",
          chapter_id: "wor",
          label: "Authorized member message",
          record_url: "/m/steward?message=message-1",
          created_by: "user-1",
          source_kind: "message",
          source_id: "message-1",
          created_at: "2026-07-26T12:00:00Z",
          updated_at: "2026-07-26T12:00:00Z",
        },
        created: true,
      },
      error: null,
    }));
    const result = await createChapterTaskFromSource({ rpc }, " message ", " message-1 ");
    expect(rpc).toHaveBeenCalledWith("create_chapter_task_from_source", {
      p_source_kind: "message",
      p_source_id: "message-1",
    });
    expect(result).toEqual({
      task: expect.objectContaining({ id: "task-1", chapterId: "wor" }),
      attachment: expect.objectContaining({
        id: "attachment-1",
        sourceKind: "message",
        sourceId: "message-1",
        recordUrl: "/m/steward?message=message-1",
      }),
      created: true,
    });
  });

  it("rejects invalid source task inputs before an RPC call", async () => {
    const rpc = vi.fn();
    await expect(createChapterTaskFromSource({ rpc }, "document", "doc-1"))
      .rejects.toThrow("Unsupported task source");
    await expect(createChapterTaskFromSource({ rpc }, "message", "   "))
      .rejects.toThrow("Task source is required");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("preserves database error codes from source task conversion", async () => {
    const error = await createChapterTaskFromSource({
      rpc: () => Promise.resolve({
        data: null,
        error: { message: "source unavailable", code: "22023" },
      }),
    }, "case", "c4f70815-4a13-4f8a-a582-48285cf271e0").catch((caught) => caught);
    expect(error.message).toBe("Create task from source: source unavailable");
    expect(error.code).toBe("22023");
  });

  it("threads chapter tasks into the shared member snapshot", async () => {
    const client = fakeClient({
      tables: memberAppTables({ chapter_tasks: { data: [taskRow], error: null } }),
      rpcs: memberAppRpcs,
    });
    const out = await loadMemberApp(client, { id: "user-1", email: "d@example.org" });
    expect(out.tasks).toEqual([expect.objectContaining({
      id: "task-1",
      chapterId: "wor",
      assigneeId: "user-2",
      assigneeName: "Maria Santos",
      startDate: "2026-07-26",
      dueDate: "2026-07-30",
      milestone: true,
      taskType: "general",
    })]);
    expect(out.taskAssignees).toEqual([{ id: "user-2", fullName: "Maria Santos", initials: "MS" }]);
  });

  it("maps ordered multi-assignees onto the task while preserving the primary", async () => {
    const client = fakeClient({
      tables: memberAppTables({
        chapter_tasks: { data: [taskRow], error: null },
        chapter_task_assignments: { data: [
          { id: "a1", task_id: "task-1", chapter_id: "wor", assignee_id: "user-2", position: 0, assigned_at: "now" },
          { id: "a2", task_id: "task-1", chapter_id: "wor", assignee_id: "user-3", position: 1, assigned_at: "now" },
        ], error: null },
      }),
      rpcs: {
        ...memberAppRpcs,
        list_chapter_task_assignees: { data: [
          { user_id: "user-2", full_name: "Maria Santos", initials: "MS" },
          { user_id: "user-3", full_name: "Jordan Lee", initials: "JL" },
        ], error: null },
      },
    });
    const out = await loadMemberApp(client, { id: "user-1", email: "d@example.org" });
    expect(out.tasks[0]).toEqual(expect.objectContaining({
      assigneeId: "user-2",
      assigneeIds: ["user-2", "user-3"],
      assigneeNames: ["Maria Santos", "Jordan Lee"],
    }));
    expect(out.taskAssignments).toHaveLength(2);
  });

  it("sets a de-duplicated assignee array through the atomic RPC", async () => {
    let args;
    const out = await setChapterTaskAssignees({
      rpc: (_name, next) => {
        args = next;
        return Promise.resolve({ data: { taskId: "task-1", assigneeIds: next.p_assignee_ids }, error: null });
      },
    }, "task-1", ["user-2", "user-3", "user-2"]);
    expect(args).toEqual({ p_task_id: "task-1", p_assignee_ids: ["user-2", "user-3"] });
    expect(out.assigneeIds).toEqual(["user-2", "user-3"]);
  });

  it("maps participant-only task messages into the member snapshot", async () => {
    const client = fakeClient({
      tables: memberAppTables({
        chapter_task_messages: {
          data: [{
            id: "message-1",
            task_id: "task-1",
            chapter_id: "wor",
            sender_id: "user-1",
            recipient_id: "user-2",
            body: "Agenda is ready.",
            created_at: "2026-07-26T18:00:00Z",
          }],
          error: null,
        },
      }),
      rpcs: memberAppRpcs,
    });
    const out = await loadMemberApp(client, { id: "user-1", email: "d@example.org" });
    expect(out.taskMessages).toEqual([{
      id: "message-1",
      taskId: "task-1",
      chapterId: "wor",
      senderId: "user-1",
      recipientId: "user-2",
      body: "Agenda is ready.",
      createdAt: "2026-07-26T18:00:00Z",
      reactions: [],
      saved: false,
      reminder: null,
    }]);
  });


  it("maps subtasks and private watches at the top-level board boundary", async () => {
    const client = fakeClient({
      tables: memberAppTables({
        chapter_task_subtasks: { data: [{
          id: "edge-1", chapter_id: "wor", parent_task_id: "task-1", subtask_id: "task-2", created_at: "now",
        }], error: null },
        chapter_task_watchers: { data: [{ task_id: "task-1" }], error: null },
      }),
      rpcs: memberAppRpcs,
    });
    const out = await loadMemberApp(client, { id: "user-1", email: "d@example.org" });
    expect(out.taskSubtasks).toEqual([{
      id: "edge-1", chapterId: "wor", parentTaskId: "task-1", subtaskId: "task-2", createdAt: "now",
    }]);
    expect(out.taskWatches).toEqual([{ taskId: "task-1" }]);
    expect(out.product).not.toHaveProperty("taskSubtasks");
    expect(out.product).not.toHaveProperty("taskWatches");
  });

  it("maps board comments, authorized links, and immutable activity into separate top-level collections", async () => {
    const client = fakeClient({
      tables: memberAppTables({
        chapter_task_comments: { data: [{ id: "c1", task_id: "task-1", chapter_id: "wor", author_id: "user-1", body: "Ready", mentioned_user_ids: ["user-2"], created_at: "now" }], error: null },
        chapter_task_attachments: { data: [{ id: "a1", task_id: "task-1", chapter_id: "wor", label: "Meeting", record_url: "/m/events", created_by: "user-1", created_at: "now", updated_at: "now" }], error: null },
        chapter_task_activity: { data: [{ id: 1, task_id: "task-1", chapter_id: "wor", actor_id: "user-1", action: "created", from_value: null, to_value: "to_do", created_at: "now" }], error: null },
      }),
      rpcs: memberAppRpcs,
    });
    const out = await loadMemberApp(client, { id: "user-1", email: "d@example.org" });
    expect(out.taskComments).toEqual([expect.objectContaining({ taskId: "task-1", mentionedUserIds: ["user-2"] })]);
    expect(out.taskAttachments).toEqual([expect.objectContaining({ recordUrl: "/m/events" })]);
    expect(out.taskActivity).toEqual([expect.objectContaining({ action: "created", toValue: "to_do" })]);
  });
  it("maps create and update responses while the server owns scope fields", async () => {
    // Both go through the journalled RPCs.
    const client = fakeClient({ rpcs: {
      create_chapter_task: () => ({ data: [taskRow], error: null }),
      update_chapter_task_fields: () => ({ data: [taskRow], error: null }),
    } });
    const created = await createChapterTask(client, { title: "Prepare meeting", status: "in_progress" });
    const updated = await updateChapterTask(client, "task-1", { progress: 45 });
    expect(created.chapterId).toBe("wor");
    expect(updated.progress).toBe(45);
  });

  it("routes title and description through the compare-and-swap RPC", async () => {
    let args;
    const client = fakeClient({
      rpcs: {
        update_chapter_task_content: (value) => {
          args = value;
          return { data: [{ ...taskRow, description: "Retry-safe" }], error: null };
        },
      },
    });
    const updated = await updateChapterTask(client, "task-1", { description: "Retry-safe" }, taskRow.updated_at);
    expect(args).toEqual({
      p_task_id: "task-1",
      p_expected_updated_at: taskRow.updated_at,
      p_title: null,
      p_description: "Retry-safe",
    });
    expect(updated.description).toBe("Retry-safe");
  });

  it("maps every row returned by the atomic move RPC", async () => {
    let args;
    const client = fakeClient({
      rpcs: {
        move_chapter_task: (value) => {
          args = value;
          return { data: [taskRow, { ...taskRow, id: "task-2", order_index: 20 }], error: null };
        },
      },
    });
    const rows = await moveChapterTask(client, "task-1", {
      workstream: "Chapter", status: "to_do", beforeId: "task-2",
    }, taskRow.updated_at);
    expect(args).toEqual({
      p_task_id: "task-1",
      p_workstream: "Chapter",
      p_status: "to_do",
      p_before_id: "task-2",
      p_expected_updated_at: taskRow.updated_at,
    });
    expect(rows.map((row) => row.id)).toEqual(["task-1", "task-2"]);
  });

  it("normalizes an empty task assignee to SQL null", async () => {
    let inserted;
    const client = { rpc(_name, args) { inserted = args.p_fields; return Promise.resolve({ data: [taskRow], error: null }); } };
    await createChapterTask(client, { title: "Prepare meeting", assigneeId: "" });
    expect(inserted.assignee_id).toBeNull();
  });

  it("does not send server-owned chapter or creator identity for a new space", async () => {
    let inserted;
    const builder = {
      insert(row) { inserted = row; return this; },
      select() { return this; },
      single() { return Promise.resolve({ data: { id: "space-1", ...rowForSpace }, error: null }); },
    };
    const rowForSpace = { name: "Issues", description: "Ongoing", visibility: "chapter" };
    await createChapterSpace({ from: () => builder }, rowForSpace);
    expect(inserted).toEqual(rowForSpace);
    expect(inserted).not.toHaveProperty("chapter_id");
    expect(inserted).not.toHaveProperty("created_by");
  });

  it("does not send server-owned chapter or creator identity for a new space", async () => {
    let inserted;
    const builder = {
      insert(row) { inserted = row; return this; },
      select() { return this; },
      single() { return Promise.resolve({ data: { id: "space-1", ...rowForSpace }, error: null }); },
    };
    const rowForSpace = { name: "Issues", description: "Ongoing", visibility: "chapter" };
    await createChapterSpace({ from: () => builder }, rowForSpace);
    expect(inserted).toEqual(rowForSpace);
    expect(inserted).not.toHaveProperty("chapter_id");
    expect(inserted).not.toHaveProperty("created_by");
  });

  it("routes handshake responses, countersignature, and closure through the audited RPCs", async () => {
    const calls = [];
    const client = {
      rpc(name, args) {
        calls.push([name, args]);
        return Promise.resolve({ data: { id: args.p_handshake_id }, error: null });
      },
      from: vi.fn(),
    };
    await updateChapterHandshakeStatus(client, "h-accept", "accepted", { idempotencyKey: "10000000-0000-4000-8000-000000000001" });
    await updateChapterHandshakeStatus(client, "h-decline", "declined", { idempotencyKey: "10000000-0000-4000-8000-000000000002" });
    await updateChapterHandshakeStatus(client, "h-active", "active", { idempotencyKey: "10000000-0000-4000-8000-000000000003" });
    await updateChapterHandshakeStatus(client, "h-closed", "closed", { idempotencyKey: "10000000-0000-4000-8000-000000000004" });
    expect(calls).toEqual([
      ["respond_chapter_handshake", { p_handshake_id: "h-accept", p_decision: "accept", p_idempotency_key: "10000000-0000-4000-8000-000000000001" }],
      ["respond_chapter_handshake", { p_handshake_id: "h-decline", p_decision: "decline", p_idempotency_key: "10000000-0000-4000-8000-000000000002" }],
      ["countersign_chapter_handshake", { p_handshake_id: "h-active", p_idempotency_key: "10000000-0000-4000-8000-000000000003" }],
      ["close_chapter_handshake", { p_handshake_id: "h-closed", p_idempotency_key: "10000000-0000-4000-8000-000000000004" }],
    ]);
    expect(client.from).not.toHaveBeenCalled();
  });

  it("refuses draft submission and unknown statuses before touching the backend", async () => {
    const client = { rpc: vi.fn(), from: vi.fn() };
    await expect(updateChapterHandshakeStatus(client, "h-draft", "requested")).rejects.toThrow("Draft handshake requests must use createChapterHandshake");
    await expect(updateChapterHandshakeStatus(client, "h3", "bogus")).rejects.toThrow("Unknown handshake status");
    expect(client.rpc).not.toHaveBeenCalled();
    expect(client.from).not.toHaveBeenCalled();
  });

  // Delete stopped being a direct .delete() — the client grant is revoked and
  // the definer RPC is the only path, with restore as its Undo.
  it("routes delete and restore through the soft-delete RPC pair", async () => {
    const calls = [];
    const client = {
      rpc: (name, args) => {
        calls.push([name, args]);
        return Promise.resolve({ data: { id: args.p_task_id }, error: null });
      },
    };
    await softDeleteChapterTask(client, "task-1");
    await restoreChapterTask(client, "task-1");
    expect(calls).toEqual([
      ["soft_delete_chapter_task", { p_task_id: "task-1" }],
      ["restore_chapter_task", { p_task_id: "task-1" }],
    ]);
  });

  it("surfaces delete failures with the task operation label", async () => {
    const client = fakeClient({ rpcs: { soft_delete_chapter_task: { data: null, error: { message: "not allowed" } } } });
    await expect(softDeleteChapterTask(client, "task-1")).rejects.toThrow("Delete task: not allowed");
  });

  it("sends task messages through the guarded RPC", async () => {
    const rpc = vi.fn(() => ({
      data: { id: "message-1", taskId: "task-1", senderId: "user-1", recipientId: "user-2", body: "Ready" },
      error: null,
    }));
    const client = fakeClient({ rpcs: { send_chapter_task_message: rpc } });
    await expect(sendChapterTaskMessage(client, "task-1", "Ready")).resolves.toEqual(
      expect.objectContaining({ id: "message-1", recipientId: "user-2" }),
    );
    expect(rpc).toHaveBeenCalledWith({ p_task_id: "task-1", p_body: "Ready" });
  });

  it("routes shared comments and authorized-record links through guarded RPCs", async () => {
    const rpc = vi.fn((name) => Promise.resolve({
      data: name === "add_chapter_task_comment"
        ? { id: "c1", taskId: "task-1", chapterId: "wor", authorId: "user-1", body: "Ready", mentionedUserIds: ["user-2"], createdAt: "now" }
        : name === "add_chapter_task_attachment"
          ? { id: "a1", taskId: "task-1", chapterId: "wor", label: "Meeting", recordUrl: "/m/events", createdBy: "user-1", createdAt: "now", updatedAt: "now" }
          : { id: "a1", deleted: true },
      error: null,
    }));
    const client = { rpc };
    await expect(addChapterTaskComment(client, "task-1", "  Ready  ", ["user-2"])).resolves.toEqual(expect.objectContaining({ id: "c1", body: "Ready" }));
    await expect(addChapterTaskAttachment(client, "task-1", " Meeting ", " /m/events ")).resolves.toEqual(expect.objectContaining({ id: "a1", recordUrl: "/m/events" }));
    await expect(removeChapterTaskAttachment(client, "a1")).resolves.toEqual({ id: "a1", deleted: true });
    expect(rpc.mock.calls).toEqual([
      ["add_chapter_task_comment", { p_task_id: "task-1", p_body: "Ready", p_mention_ids: ["user-2"] }],
      ["add_chapter_task_attachment", { p_task_id: "task-1", p_label: "Meeting", p_record_url: "/m/events" }],
      ["remove_chapter_task_attachment", { p_attachment_id: "a1" }],
    ]);
  });
});

describe("loadMemberApp form template versions", () => {
  const templateRow = (version, active, labelEn) => ({
    key: "grievance", version, active, label_en: labelEn, label_es: `${labelEn} (es)`,
    blurb_en: "b", blurb_es: "b", icon: "⚖", points: 25, sort: 1,
    field_schema: { steps: [{ title: { en: "S", es: "S" }, fields: [{ key: "summary", type: "text", label: { en: "L", es: "L" }, required: true }] }] },
  });

  it("start tiles use only active rows while every version resolves for pinned rendering", async () => {
    const client = fakeClient({
      tables: memberAppTables({
        form_template_registry: { data: [templateRow(1, false, "Grievance report"), templateRow(2, true, "Grievance & incident report")], error: null },
      }),
      rpcs: memberAppRpcs,
    });
    const out = await loadMemberApp(client, { id: "user-1", email: "d@example.org" });
    expect(out.formTemplates).toHaveLength(1);
    expect(out.formTemplates[0].version).toBe(2);
    expect(out.formTemplateVersions.map((tpl) => tpl.version).sort()).toEqual([1, 2]);
    // The retired v1 keeps its own label — a resumed draft pinned to v1 must
    // not silently render under the renamed v2 schema.
    expect(out.formTemplateVersions.find((tpl) => tpl.version === 1).titleKey).toBe("Grievance report");
  });

  it("keeps a successful empty registry empty", async () => {
    const client = fakeClient({
      tables: memberAppTables({ form_template_registry: { data: [], error: null } }),
      rpcs: memberAppRpcs,
    });
    const out = await loadMemberApp(client, { id: "user-1", email: "d@example.org" });
    expect(out.formTemplates).toEqual([]);
  });

  it("keeps the static fallback when the registry read degrades", async () => {
    const client = fakeClient({
      tables: memberAppTables({ form_template_registry: { data: null, error: { message: "boom" } } }),
      rpcs: memberAppRpcs,
    });
    const out = await loadMemberApp(client, { id: "user-1", email: "d@example.org" });
    expect(out.formTemplates).toBe(FORM_TEMPLATES);
    expect(out.formTemplateVersions).toEqual([]);
  });
});

describe("loadMemberApp without a points economy", () => {
  // Points data is served to prove Union Ground never
  // reads it: contributions come from safe recognition, without points.
  const pointsTables = {
    member_point_rules: { data: [{ action_kind: "organize", label: "Organize", points: 25, weekly_cap: 2 }], error: null },
    member_reward_tiers: { data: [{ tier: 2, name: "Builder", min_points: 100 }], error: null },
    member_reward_items: { data: [{ key: "sg-hoodie", label_en: "Hoodie", label_es: "Sudadera", icon: "🧥", bucket: "wear", min_tier: 5, fulfillment: "ship" }], error: null },
    member_reward_grants: { data: [{ id: "g-1", item_key: "sg-hoodie", status: "claimed", source: "claim", created_at: "2026-07-01T00:00:00Z" }], error: null },
    member_point_events: { data: [{ id: "pe-1", action_kind: "organize", action_key: "k", points: 25, occurred_at: "2026-07-01T00:00:00Z" }], error: null },
  };
  const pointsRpcs = {
    get_member_reward_effects: { data: [{ key: "im-anyone", kind: "permission", status: "granted" }], error: null },
    get_reward_cross_chapter_cards: { data: [{ id: "card-1", title: "Card", body: "Body", region: "east" }], error: null },
    list_reward_experimental_content: { data: [{ id: "lab-1" }], error: null },
  };

  async function load(rewardsSummary = { data: {}, error: null }) {
    const tableReads = [];
    const inner = fakeClient({
      tables: memberAppTables(pointsTables),
      rpcs: { ...memberAppRpcs, ...pointsRpcs, get_member_rewards_summary: rewardsSummary },
    });
    const rpc = vi.fn(inner.rpc);
    const client = { ...inner, rpc, from: (table) => { tableReads.push(table); return inner.from(table); } };
    const out = await loadMemberApp(client, { id: "user-1", email: "d@example.org" });
    return { out, rpc, tableReads };
  }

  it("requests no point rules, tiers, reward items, grants, ledger, effects, chapter cards or Labs", async () => {
    const { out, rpc, tableReads } = await load();
    for (const table of Object.keys(pointsTables)) expect(tableReads).not.toContain(table);
    for (const name of Object.keys(pointsRpcs)) expect(rpc.mock.calls.map(([called]) => called)).not.toContain(name);
    for (const retired of ["rewardsCatalog", "rewardItems", "rewardGrants", "rewardEffects", "rewardChapterCards", "pointsLedger", "experimentalContent", "experimentalContentUnavailable"]) {
      expect(out).not.toHaveProperty(retired);
    }
    // Contributions still render, from the safe-recognition reads.
    expect(rpc).toHaveBeenCalledWith("get_member_recognition_summary");
    expect(tableReads).toContain("member_recognition_rules");
    expect(tableReads).toContain("member_recognition_events");
    expect(out.recognition).toEqual({ totalVerified: 0, recentVerified: 0, currentRung: "learn", retiredPointsHidden: true });
    expect(out.recognitionCatalog).toEqual({ rules: [], events: [] });
  });

  it("keeps only the actions-this-year count from a points-shaped summary", async () => {
    const { out } = await load({ data: { totalPoints: 120, tierNumber: 2, tierName: "Builder", pointsToGo: 30, weekStreak: 4, actionsYtd: 7 }, error: null });
    expect(out.rewards).toEqual({ actionsYtd: 7 });
  });

  it("projects a missing action count as null, never as zero actions", async () => {
    const neutralized = await load({ data: { totalPoints: 0, tierNumber: 1, tierName: "Contributions", retired: true }, error: null });
    expect(neutralized.out.rewards).toEqual({ actionsYtd: null });
    const failed = await load({ data: null, error: { message: "summary unavailable" } });
    expect(failed.out.rewards).toEqual({ actionsYtd: null });
  });
});

describe("loadStewardDesk members-covered KPI", () => {
  const deskTables = {
    member_profiles: { data: null, error: null, count: 987 },
  };
  // UB-DESK-01: the desk queues arrive as steward list_* RPC pages and the
  // tiles from get_steward_desk_kpis, so the fake serves all of them empty.
  const deskRpcs = {
    list_steward_requests: { data: [], error: null },
    list_steward_conversations: { data: [], error: null },
    list_steward_broadcasts: { data: [], error: null },
    list_steward_forms: { data: [], error: null },
    get_steward_desk_kpis: { data: [{ open_requests: 0, awaiting_reply: 0, broadcasts_30d: 0 }], error: null },
    get_broadcast_read_counts_for: { data: [], error: null },
  };

  it("prefers the exact chapter-scoped RPC count", async () => {
    const client = fakeClient({
      tables: deskTables,
      rpcs: { ...deskRpcs, get_steward_chapter_member_count: { data: 4200, error: null } },
    });
    const desk = await loadStewardDesk(client);
    expect(desk.kpis.membersCovered).toBe(4200);
  });

  it("falls back to the estimated head count when the RPC errors", async () => {
    const client = fakeClient({
      tables: deskTables,
      rpcs: { ...deskRpcs, get_steward_chapter_member_count: { data: null, error: { message: "steward role required" } } },
    });
    const desk = await loadStewardDesk(client);
    expect(desk.kpis.membersCovered).toBe(987);
  });
});

// BUG-UG-PAGES-FAIL-HARD-ON-MISSING-OR-SLOW-FUNCTION-20261003.
describe("loadStewardDesk when the KPI read times out", () => {
  it("loads the queues and marks the counts unavailable instead of failing the desk", async () => {
    const client = fakeClient({
      tables: { member_profiles: { data: null, error: null, count: 38 } },
      rpcs: {
        list_steward_requests: { data: [], error: null },
        list_steward_conversations: { data: [], error: null },
        list_steward_broadcasts: { data: [], error: null },
        list_steward_forms: { data: [], error: null },
        get_steward_desk_kpis: { data: null, error: { message: "canceling statement due to statement timeout", code: "57014" } },
        get_steward_chapter_member_count: { data: 38, error: null },
        get_broadcast_read_counts_for: { data: [], error: null },
      },
    });
    const desk = await loadStewardDesk(client);
    expect(desk.kpis).toEqual({ openRequests: null, membersCovered: 38, awaitingReply: null, broadcasts30d: null, unavailable: true });
    expect(desk.queue).toEqual([]);
  });

  it("does not wait for a KPI read slower than four seconds", async () => {
    vi.useFakeTimers();
    try {
      const client = fakeClient({
        tables: { member_profiles: { data: null, error: null, count: 38 } },
        rpcs: {
          list_steward_requests: { data: [], error: null },
          list_steward_conversations: { data: [], error: null },
          list_steward_broadcasts: { data: [], error: null },
          list_steward_forms: { data: [], error: null },
          get_steward_desk_kpis: () => new Promise(() => {}),
          get_steward_chapter_member_count: { data: 38, error: null },
          get_broadcast_read_counts_for: { data: [], error: null },
        },
      });
      const loading = loadStewardDesk(client);
      await vi.advanceTimersByTimeAsync(4_001);
      const desk = await loading;
      expect(desk.kpis.unavailable).toBe(true);
      expect(desk.kpis.membersCovered).toBe(38);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("loadStewardDesk workload intelligence", () => {
  const deskTables = { member_profiles: { data: null, error: null, count: 38 } };
  const deskRpcs = {
    list_steward_requests: { data: [], error: null },
    list_steward_conversations: { data: [], error: null },
    list_steward_broadcasts: { data: [], error: null },
    list_steward_forms: { data: [], error: null },
    get_steward_desk_kpis: { data: [{}], error: null },
    get_broadcast_read_counts_for: { data: [], error: null },
  };
  it("maps the chapter aggregate independently of load-bearing desk queues", async () => {
    const intelligence = {
      available: true,
      eligibleWeeks: 6,
      categories: [{ key: "pending", slope: 1.5, latest: 20, forecast4Weeks: 26, points: 6 }],
      rebalancing: { stewards: [], suggestions: [] },
    };
    const client = fakeClient({
      tables: deskTables,
      rpcs: {
        ...deskRpcs,
        get_steward_chapter_member_count: { data: 38, error: null },
        get_steward_workload_intelligence: { data: intelligence, error: null },
      },
    });
    const result = await loadStewardDesk(client);
    expect(result.workloadIntelligence).toEqual(intelligence);
  });

  it("reports an intelligence read failure without blanking the steward desk", async () => {
    const client = fakeClient({
      tables: deskTables,
      rpcs: {
        ...deskRpcs,
        get_steward_chapter_member_count: { data: 38, error: null },
        get_steward_workload_intelligence: { data: null, error: { message: "rollout gap" } },
      },
    });
    const result = await loadStewardDesk(client);
    expect(result.kpis.membersCovered).toBe(38);
    expect(result.workloadIntelligence).toEqual({ available: false, reason: "read_error" });
  });
});

describe("workload log client", () => {
  it("maps fields to the RPC params and returns the receipt payload", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { id: "w1", receiptCode: "a3f81c92", remainingToday: 2, awardedPoints: 10 }, error: null });
    const out = await submitWorkloadLog({ rpc }, {
      priority: 4, pending: 11, unread_docs: 7, todos: 5, referrals: 1, ce_activities: 0,
      assistance_requests: 0, aged_cases: 4, weeklyAssigned: 15, employment: "part_time",
      ptHours: 24, onPlan: false, otWorked: true, otHours: 3, leaveType: "fmla",
      leaveTiming: "planned", noIntake: false, halfDay: false, note: "x", subDetails: { a: 1 },
    });
    expect(out.awardedPoints).toBe(10);
    expect(rpc).toHaveBeenCalledWith("submit_workload_log", {
      p_priority: 4, p_pending: 11, p_unread_docs: 7, p_todos: 5, p_referrals: 1, p_ce_activities: 0,
      p_assistance_requests: 0, p_aged_cases: 4, p_weekly_assigned: 15, p_employment: "part_time",
      p_pt_hours: 24, p_on_plan: false, p_ot_worked: true, p_ot_hours: 3, p_leave_type: "fmla",
      p_leave_timing: "planned", p_no_intake: false, p_half_day: false, p_note: "x", p_sub_details: { a: 1 },
    });
  });

  it("coerces empty optionals to null", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: {}, error: null });
    await submitWorkloadLog({ rpc }, { employment: "full_time", ptHours: null, leaveType: "", leaveTiming: "", note: "" });
    const args = rpc.mock.calls[0][1];
    expect(args.p_pt_hours).toBeNull();
    expect(args.p_leave_type).toBeNull();
    expect(args.p_leave_timing).toBeNull();
    expect(args.p_note).toBeNull();
    expect(args.p_sub_details).toEqual({});
  });

  it("throws a labeled error on RPC failure", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "daily workload log limit reached (3 per day)" } });
    await expect(submitWorkloadLog({ rpc }, {})).rejects.toThrow(/Workload: daily workload log limit reached/);
  });
});

describe("workload reminder client", () => {
  it("loads the self-only preference RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { enabled: false, cadence: "weekly" }, error: null });
    await expect(getWorkloadReminderPreferences({ rpc })).resolves.toEqual({ enabled: false, cadence: "weekly" });
    expect(rpc).toHaveBeenCalledWith("get_workload_reminder_preferences");
  });

  it("sends only the closed reminder schedule fields", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { enabled: true }, error: null });
    await setWorkloadReminderPreferences({ rpc }, {
      enabled: true, cadence: "monthly", weekday: 2, localHour: 14,
      timezone: "America/Chicago", email: "must-not-cross@example.org",
    });
    expect(rpc).toHaveBeenCalledWith("set_workload_reminder_preferences", {
      p_enabled: true, p_cadence: "monthly", p_weekday: 2,
      p_local_hour: 14, p_timezone: "America/Chicago",
    });
  });
});

describe("member guide persistence client", () => {
  it("forwards one atomic exchange RPC and returns its thread id", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "thread-id", error: null });
    const threadId = await saveGuideExchange({ rpc }, "member-id", null, "Question", "Answer");

    expect(threadId).toBe("thread-id");
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("save_member_guide_exchange", {
      p_thread_id: null,
      p_question: "Question",
      p_answer: "Answer",
      p_sources: null,
    });
  });

  it("forwards retrieved sources when present", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "thread-id", error: null });
    const sources = [{ id: "kb:contract-article-12-discipline", kind: "contract", title: "Article 12 — Discipline", ref: "Contract · Article 12" }];
    await saveGuideExchange({ rpc }, "member-id", "thread-9", "Question", "Answer", sources);

    expect(rpc).toHaveBeenCalledWith("save_member_guide_exchange", {
      p_thread_id: "thread-9",
      p_question: "Question",
      p_answer: "Answer",
      p_sources: sources,
    });
  });
});

describe("steward write clients", () => {
  it("forwards triage through the definer RPC with exact args", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { status: "acknowledged" }, error: null });
    await triageStewardRequest({ rpc }, "req-1", "acknowledge");
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("triage_steward_request", { p_request_id: "req-1", p_action: "acknowledge" });
  });

  it("forwards steward replies trimmed through the definer RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { conversationId: "c-1" }, error: null });
    await sendStewardReply({ rpc }, "c-1", "  On it — filing today.  ");
    expect(rpc).toHaveBeenCalledOnce();
    expect(rpc).toHaveBeenCalledWith("send_steward_reply", { p_conversation_id: "c-1", p_body: "On it — filing today." });
  });

  it("forwards broadcast publish and retract through their definer RPCs", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { broadcastId: "bc-1" }, error: null });
    await publishMemberBroadcast({ rpc }, " Update ", " Body ");
    // The language defaults to en and always travels: a broadcast row's
    // locale is what earns (or suppresses) the cross-language chip. The
    // audience travels for a harder reason (SEC-UG-BROADCASTS-CHAPTER-
    // BOUNDARY-20260817): it is part of who may read the row, so the caller
    // states it rather than inheriting whatever the RPC defaults to today.
    expect(rpc).toHaveBeenCalledWith("publish_member_broadcast", { p_title: "Update", p_body: "Body", p_locale: "en", p_audience_scope: "chapter", p_idempotency_key: expect.any(String) });
    await publishMemberBroadcast({ rpc }, "Aviso", "Cuerpo", "es");
    expect(rpc).toHaveBeenCalledWith("publish_member_broadcast", { p_title: "Aviso", p_body: "Cuerpo", p_locale: "es", p_audience_scope: "chapter", p_idempotency_key: expect.any(String) });
    await publishMemberBroadcast({ rpc }, "Org", "Body", "en", "organization");
    expect(rpc).toHaveBeenCalledWith("publish_member_broadcast", { p_title: "Org", p_body: "Body", p_locale: "en", p_audience_scope: "organization", p_idempotency_key: expect.any(String) });
    await retractMemberBroadcast({ rpc }, "bc-1");
    expect(rpc).toHaveBeenCalledWith("retract_member_broadcast", { p_broadcast_id: "bc-1" });
  });

  it("refuses an unrecognised broadcast audience without calling the RPC", async () => {
    // A typo that reached the database would come back as a generic 22023
    // with no audience named in it, and "global" is exactly the value someone
    // will reach for. Neither ever leaves the client.
    const rpc = vi.fn().mockResolvedValue({ data: { broadcastId: "bc-1" }, error: null });
    for (const bad of ["global", "everyone", "all", "", null, 1]) {
      await expect(publishMemberBroadcast({ rpc }, "T", "B", "en", bad)).rejects.toThrow(/chapter or organization/);
      // Same error shape as every other failure this module raises, so the
      // steward desk's catch does not need a special case for this one.
      await expect(publishMemberBroadcast({ rpc }, "T", "B", "en", bad)).rejects.toMatchObject({
        name: "MemberApiError",
        label: "Publish broadcast",
        code: null,
      });
    }
    expect(rpc).not.toHaveBeenCalled();
    // Omitting the argument is not a typo: it is the narrow default.
    await publishMemberBroadcast({ rpc }, "T", "B");
    expect(rpc).toHaveBeenCalledWith("publish_member_broadcast", { p_title: "T", p_body: "B", p_locale: "en", p_audience_scope: "chapter", p_idempotency_key: expect.any(String) });
  });

  it("exports no reward claim, grant, revoke, shipping or fulfillment writes", async () => {
    // Union Ground has no perk claims: the points economy's write clients
    // are gone rather than left callable against an inert schema.
    const api = await import("../src/lib/memberApi.js");
    for (const name of ["claimReward", "grantReward", "revokeReward", "advanceRewardFulfillment", "setRewardShippingAddress"]) {
      expect(api, name).not.toHaveProperty(name);
    }
  });

  it("surfaces RPC errors as thrown labels", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "steward role required" } });
    await expect(sendStewardReply({ rpc }, "c-1", "hello")).rejects.toThrow("Send steward reply: steward role required");
  });
});

describe("event write clients", () => {
  it("forwards RSVP through the definer RPC with exact args", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { status: "going", awardedPoints: 40 }, error: null });
    const result = await submitEventRsvp({ rpc }, "evt-2026-chapter-meeting", "going");
    expect(result.awardedPoints).toBe(40);
    expect(rpc).toHaveBeenCalledWith("rsvp_to_event", { p_event_id: "evt-2026-chapter-meeting", p_status: "going" });
  });

  it("forwards check-in with a trimmed code through the definer RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { checkedIn: true, alreadyCheckedIn: false, awardedPoints: 50 }, error: null });
    await checkInToEvent({ rpc }, "evt-2026-chapter-meeting", "  SG-CHAPTER  ");
    expect(rpc).toHaveBeenCalledWith("check_in_to_event", { p_event_id: "evt-2026-chapter-meeting", p_code: "SG-CHAPTER" });
  });

  it("surfaces a rejected check-in code as a thrown label", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "invalid check-in code" } });
    await expect(checkInToEvent({ rpc }, "evt-x", "WRONG")).rejects.toThrow("Check in: invalid check-in code");
  });

  // SEC-UG-EVENT-CHECKIN-CODE-UNBOUNDED-GUESSES-20260920: a wrong code and
  // a lockout both come back as one refusal payload (so the server can count
  // them); the surface reports either as the same failure, never a check-in.
  it("surfaces the refusal payload as the same thrown failure and never as a check-in", async () => {
    const refusal = { checkedIn: false, refused: true, code: "22023", message: "invalid check-in code" };
    const rpc = vi.fn().mockResolvedValue({ data: refusal, error: null });
    await expect(checkInToEvent({ rpc }, "evt-x", "WRONG")).rejects.toMatchObject({
      name: "MemberApiError", message: "Check in: invalid check-in code", code: "22023",
    });
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  // BUG-UG-WEB-EVENT-CHECKIN-REFUSALS-ENGLISH-ONLY-20261003: the
  // payload's token reaches the error's details so the refusal is translated;
  // a wrong code and a lockout carry the same token.
  it("carries the refusal payload's token into the error details, including from a payload without one", async () => {
    const { rpcErrorText } = await import("../src/lib/rpcErrorText.js");
    const { t } = await import("../src/lib/i18n.js");
    for (const refusal of [
      { checkedIn: false, refused: true, code: "22023", message: "invalid check-in code", token: "checkin_code_invalid" },
      { checkedIn: false, refused: true, code: "22023", message: "invalid check-in code" },
    ]) {
      const rpc = vi.fn().mockResolvedValue({ data: refusal, error: null });
      const error = await checkInToEvent({ rpc }, "evt-x", "WRONG").catch((caught) => caught);
      expect(error).toMatchObject({ name: "MemberApiError", code: "22023", details: "checkin_code_invalid" });
      expect(rpcErrorText((key) => t("es", key), error, "fallback")).toBe(t("es", "rpcError.checkin_code_invalid"));
    }
  });
});

// The four converted member writes (20260725000000). Each used to be two or
// three PostgREST calls; each is now exactly one definer RPC. `from` is spied
// alongside `rpc` because a half-converted function — RPC plus a leftover
// direct table write — would still pass a naive "the rpc was called" assertion
// while re-opening the stranding window the migration exists to close, and the
// sole-writer revokes would make that leftover write fail outright in
// production.
function spyClient(data = null, error = null) {
  const from = vi.fn(() => chainable({ data: [], error: null }));
  const rpc = vi.fn().mockResolvedValue({ data, error });
  return { from, rpc };
}

describe("atomic member writes: one RPC, no table writes", () => {
  it("triages intake through the guarded RPC alone", async () => {
    const client = spyClient({ id: "report-1", status: "triaged", assigned_to: "staff-2" });
    await triageMemberIntake(client, "report-1", { status: "triaged", assignedTo: "staff-2" });
    expect(client.rpc).toHaveBeenCalledWith("triage_member_intake_report", {
      p_report_id: "report-1",
      p_status: "triaged",
      p_assigned_to: "staff-2",
    });
    expect(client.from).not.toHaveBeenCalled();
  });

  it("converts intake through one idempotent RPC call", async () => {
    const client = spyClient({ target: "thread", targetId: "thread-1" });
    await convertMemberIntake(client, "report-1", "thread", "space-1");
    expect(client.rpc).toHaveBeenCalledWith("convert_member_intake_report", {
      p_report_id: "report-1",
      p_target: "thread",
      p_space_id: "space-1",
    });
    expect(client.from).not.toHaveBeenCalled();
  });

  it("sends a message through send_member_message alone", async () => {
    const client = spyClient({ messageId: "m-1", awardedPoints: 2 });
    await sendMemberMessage(client, "conv-1", "  Following up on my grievance  ");
    expect(client.rpc).toHaveBeenCalledOnce();
    expect(client.from).not.toHaveBeenCalled();
    expect(client.rpc.mock.calls[0][0]).toBe("send_member_message");
    expect(client.rpc.mock.calls[0][1]).toEqual({
      p_conversation_id: "conv-1",
      p_body: "  Following up on my grievance  ",
    });
  });

  it("never sends a sender name — the server derives it from the profile", async () => {
    const client = spyClient({ messageId: "m-1", awardedPoints: 2 });
    await sendMemberMessage(client, "conv-1", "hello");
    // sender_name is rendered raw in the steward desk, where "Chapter steward"
    // is the other party's label. A client-supplied name is an impersonation
    // primitive, so no key here may carry one.
    for (const key of Object.keys(client.rpc.mock.calls[0][1])) {
      expect(key).not.toMatch(/sender/i);
    }
  });

  // The member's intake now
  // files through open_member_case, which carries the case details and
  // delegates to create_member_case on the server.
  it("files a case through open_member_case alone and returns its payload", async () => {
    const client = spyClient({ caseId: "case-1", reference: "GR-2026-04817", awardedPoints: 25 });
    const out = await createMemberCase(client, {
      title: "Denied Weingarten rep",
      deadline: "2026-08-01",
      caseType: "Discipline",
      articles: "Article 12",
    });
    expect(out.reference).toBe("GR-2026-04817");
    expect(out.awardedPoints).toBe(25);
    expect(client.rpc).toHaveBeenCalledOnce();
    expect(client.from).not.toHaveBeenCalled();
    expect(client.rpc.mock.calls[0][0]).toBe("open_member_case");
    expect(client.rpc.mock.calls[0][1]).toEqual({
      p_member_id: null,
      p_title: "Denied Weingarten rep",
      p_deadline: "2026-08-01",
      p_case_type: "Discipline",
      p_articles: "Article 12",
      p_description: null,
      p_incident_date: null,
      p_remedy_sought: null,
      p_filing_status: null,
      p_assign_self: true,
    });
  });

  it("coerces an empty deadline to null and missing articles to an empty string", async () => {
    const client = spyClient({ caseId: "case-2", reference: "GR-2026-00001", awardedPoints: 0 });
    await createMemberCase(client, { title: "Schedule change with no notice", deadline: "", caseType: "Scheduling" });
    const args = client.rpc.mock.calls[0][1];
    expect(args.p_deadline).toBeNull();
    expect(args.p_articles).toBe("");
  });

  it("never sends a case reference — the server allocates it", async () => {
    const client = spyClient({ caseId: "case-3", reference: "GR-2026-77213", awardedPoints: 25 });
    await createMemberCase(client, { title: "Unsafe caseload", deadline: null, caseType: "Safety", articles: "" });
    const args = client.rpc.mock.calls[0][1];
    // A client-chosen reference is what made a retried filing mint a second
    // grievance for one incident, and it would let a member pre-insert a
    // reference to block their own future filing.
    for (const [key, value] of Object.entries(args)) {
      expect(key).not.toMatch(/reference/i);
      if (typeof value === "string") expect(value).not.toMatch(/^GR-\d{4}-/);
    }
  });

  it("casts a ballot through submit_ballot_vote alone", async () => {
    const client = spyClient({ receiptCode: "SG-ABCD-EFGH", awardedPoints: 20 });
    const receipt = await submitBallot(client, "ballot-2026", "opt-yes");
    expect(receipt).toBe("SG-ABCD-EFGH");
    expect(client.rpc).toHaveBeenCalledOnce();
    expect(client.from).not.toHaveBeenCalled();
    expect(client.rpc.mock.calls[0][0]).toBe("submit_ballot_vote");
    expect(client.rpc.mock.calls[0][1]).toEqual({ p_ballot_id: "ballot-2026", p_option_id: "opt-yes" });
  });

  it("answers a pulse through submit_survey_response alone", async () => {
    const client = spyClient({ awardedPoints: 10 });
    const out = await submitSurvey(client, "pulse-2026", "opt-fair");
    expect(out.awardedPoints).toBe(10);
    expect(client.rpc).toHaveBeenCalledOnce();
    expect(client.from).not.toHaveBeenCalled();
    expect(client.rpc.mock.calls[0][0]).toBe("submit_survey_response");
    expect(client.rpc.mock.calls[0][1]).toEqual({ p_survey_id: "pulse-2026", p_option_id: "opt-fair" });
  });

  it("passes no user id to any of the four — the RPC derives it from auth.uid()", async () => {
    const calls = [];
    const client = {
      from: vi.fn(() => chainable({ data: [], error: null })),
      rpc: vi.fn((name, args) => { calls.push(args); return Promise.resolve({ data: {}, error: null }); }),
    };
    await sendMemberMessage(client, "c", "b");
    await createMemberCase(client, { title: "t", caseType: "Other" });
    await submitBallot(client, "b", "o");
    await submitSurvey(client, "s", "o");
    for (const args of calls) {
      for (const key of Object.keys(args)) expect(key).not.toMatch(/user/i);
    }
  });
});

describe("atomic member writes: ballot receipt contract", () => {
  // App.jsx gates the receipt toast on truthiness and interpolates the value
  // into member-facing copy, so this must always be a string.
  it.each([
    [{ receiptCode: "SG-ABCD-EFGH", awardedPoints: 20 }, "SG-ABCD-EFGH"],
    [{ receiptCode: "", awardedPoints: 20 }, ""],
    [{ awardedPoints: 20 }, ""],
    [null, ""],
  ])("returns a string for %j", async (data, expected) => {
    const client = spyClient(data);
    const receipt = await submitBallot(client, "ballot-2026", "opt-yes");
    expect(receipt).toBe(expected);
    expect(typeof receipt).toBe("string");
  });
});

describe("atomic member writes: labeled error surfaces survive the conversion", () => {
  it.each([
    ["Send message", () => sendMemberMessage(spyClient(null, { message: "boom" }), "c", "b")],
    ["Create case", () => createMemberCase(spyClient(null, { message: "boom" }), { title: "t", caseType: "Other" })],
    ["Submit ballot", () => submitBallot(spyClient(null, { message: "boom" }), "b", "o")],
    ["Submit survey", () => submitSurvey(spyClient(null, { message: "boom" }), "s", "o")],
  ])("prefixes a failure with %s", async (label, call) => {
    await expect(call()).rejects.toThrow(`${label}: boom`);
  });

  it("surfaces the server's closed-ballot refusal verbatim behind the label", async () => {
    const client = spyClient(null, { message: "this ballot is closed" });
    await expect(submitBallot(client, "ballot-2026", "opt-yes")).rejects.toThrow("Submit ballot: this ballot is closed");
  });

  // Votes are FINAL (20260808230000): the second submission is refused with
  // this exact message, and App.jsx's translated toast keys off the raw text
  // surviving behind the label — same contract as the closed refusal above.
  it("surfaces the server's final-vote refusal verbatim behind the label", async () => {
    const client = spyClient(null, { message: "your vote is already recorded" });
    await expect(submitBallot(client, "ballot-2026", "opt-yes")).rejects.toThrow("Submit ballot: your vote is already recorded");
  });
});

describe("deliberately unconverted member writes stay on the table path", () => {
  it("exports no client action-log write: participation is server-verified", async () => {
    // 20260724053134 retired client action-log writes and point minting, so
    // the browser has no logAction to call and no member_action_log path.
    const api = await import("../src/lib/memberApi.js");
    expect(api).not.toHaveProperty("logAction");
    expect(readFileSync(resolve(process.cwd(), "src/lib/memberApi.js"), "utf8")).not.toContain('from("member_action_log")');
  });

  it("saveRightsProgress writes tables, not an RPC", async () => {
    // Idempotent by construction, self-healing on the next save, and the one
    // member write in the offline outbox — routing it through a definer RPC
    // would add failure surface to offline replay for no atomicity gain.
    const client = spyClient();
    await saveRightsProgress(client, "user-1", "lesson-1", ["a"]);
    expect(client.from).toHaveBeenCalledWith("member_rights_progress");
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("requestSteward writes tables, not an RPC", async () => {
    const client = spyClient();
    await requestSteward(client, "user-1", "lesson-1");
    expect(client.from).toHaveBeenCalledWith("member_steward_requests");
    expect(client.rpc).not.toHaveBeenCalled();
  });
});

describe("offline outbox purity", () => {
  it("queues exactly the strictly idempotent writes and none of the converted four", () => {
    const app = readFileSync(resolve(process.cwd(), "src/App.jsx"), "utf8");
    const start = app.indexOf("const outboxExecutors = useMemo(() => ({");
    expect(start, "outboxExecutors must exist").toBeGreaterThan(-1);
    const end = app.indexOf("}), []);", start);
    const block = app.slice(start, end);
    // The member executors now live in src/lib/memberOutboxExecutors.js.
    expect(block).toContain("...createMemberOutboxExecutors(supabase, () => sessionRef.current)");
    const keys = [
      ...Object.keys(createMemberOutboxExecutors({}, () => null)),
      ...[...block.matchAll(/^\s{4}([A-Za-z]\w*):/gm)].map((m) => m[1]),
    ];
    // Replaying create_member_case offline would mint a duplicate case on every
    // retry — the exact defect the server-generated reference removes — and
    // replaying a vote or a message re-runs a non-idempotent transaction.
    expect(new Set(keys)).toEqual(new Set([
      "rsvp", "rightsProgress", "broadcastRead", "conversationRead",
      "notificationsRead", "settings", "profile", "formDraft",
    ]));
  });
});

describe("closed ballots stay visible read-only", () => {
  it("never filters the catalogs on closes_at — visibility is not votability", () => {
    // The member's SG- receipt code and the quorum readout render ONLY from
    // planItems; a closes_at read filter would delete both at the exact moment
    // they matter most (right after close). The server RPCs refuse closed
    // writes; the client's job is to disable the action, not hide the row.
    // Quote- and API-shape-robust: .gt / .gte, either quote style, and the
    // .filter("closes_at", "gt", ...) spelling all count as reinstating it.
    const source = readFileSync(resolve(process.cwd(), "src/lib/memberApi.js"), "utf8");
    expect(source).not.toMatch(/\.(gt|gte)\(\s*["']closes_at/);
    expect(source).not.toMatch(/["']closes_at["']\s*,\s*["']gte?["']/);
    // Ballots also stopped filtering on active (20260809010000, UB-VOTE-02):
    // a flag-closed ballot is exactly the one whose published results must
    // render, and the old .eq("active", true) hid the two seeded historical
    // ballots from their own receipt holders ( finding 3).
    // Retention (receipt-held or within the 14-day close grace) bounds what
    // renders. Pulses also retain explicit closes now that staff can close
    // them before their scheduled time; lifecycle RLS keeps drafts invisible.
    expect(source).not.toMatch(/member_ballots[^\n]*\.eq\("active", true\)/);
    expect(source).not.toMatch(/member_surveys[^\n]*\.eq\("active", true\)/);
  });

  it("localizes authored ballot and pulse copy with legacy English fallback", async () => {
    const futureClose = new Date(Date.now() + 30 * 86400000).toISOString();
    const client = fakeClient({
      tables: memberAppTables({
        member_profiles: { data: { ...baseProfile, language: "es" }, error: null },
        member_ballots: { data: [{
          id: "b-es", title: "Contract vote", title_es: "Votación del contrato",
          body: "Read the contract summary.", body_es: "Lea el resumen del contrato.",
          active: true, closes_at: futureClose, order_index: 1,
          member_ballot_options: [{ id: "b-es-yes", label: "Yes", label_es: "Sí", order_index: 1 }],
        }], error: null },
        member_surveys: { data: [{
          id: "p-es", title: "Staffing pulse", title_es: null,
          body: "Tell us about staffing.", body_es: "",
          active: true, campaign_state: "open", closes_at: futureClose, order_index: 1,
          member_survey_options: [{ id: "p-es-safe", label: "Safe staffing", label_es: "Dotación segura", order_index: 1 }],
        }], error: null },
      }),
      rpcs: { ...memberAppRpcs, get_ballot_tally: { data: { ballotId: "b-es", totalVotes: 0, quorumTarget: 10, options: null }, error: null } },
    });
    const out = await loadMemberApp(client, { id: "user-1", email: "d@example.org" });
    const ballot = out.planItems.find((item) => item.id === "b-es");
    const pulse = out.planItems.find((item) => item.id === "p-es");
    expect(ballot.title).toBe("Votación del contrato");
    expect(ballot.body).toBe("Lea el resumen del contrato.");
    expect(ballot.options[0].label).toBe("Sí");
    expect(pulse.title).toBe("Staffing pulse");
    expect(pulse.body).toBe("Tell us about staffing.");
    expect(pulse.options[0].label).toBe("Dotación segura");
  });

  it("keeps the UI-side guards wired", () => {
    const today = readFileSync(resolve(process.cwd(), "src/views/TodayView.jsx"), "utf8");
    expect(today).toMatch(/disabled=\{Boolean\(item\.closed\)\}/);
    const app = readFileSync(resolve(process.cwd(), "src/App.jsx"), "utf8");
    expect(app).toMatch(/if \(item\.closed\) return;/);
    // BOTH dialog entry points route through the guard: a direct
    // setActivePlan from search bypassed it once already.
    expect(app).toMatch(/if \(planItem\) handlePlanAction\(planItem\);/);
    expect(app).not.toMatch(/if \(planItem\) setActivePlan\(planItem\);/);
  });

  it("keeps participated closed rows read-only, drops stale ones, and bounds the tally fan-out", async () => {
    // Behavioral, not a source pin: seed real catalogs through the fake and
    // assert what planItems actually contains.
    const dayMs = 86400000;
    const oldClose = new Date(Date.now() - 30 * dayMs).toISOString(); // beyond the 14-day grace
    const futureClose = new Date(Date.now() + 30 * dayMs).toISOString();
    const opt = (id) => [{ id: `${id}-opt`, label: "Yes", order_index: 1 }];
    const tally = vi.fn((args) => ({ data: { ballotId: args.p_ballot_id, totalVotes: 3, quorumTarget: 10 }, error: null }));
    const client = fakeClient({
      tables: memberAppTables({
        member_ballots: { data: [
          { id: "b-open", title: "Open ballot", active: true, closes_at: futureClose, order_index: 1, member_ballot_options: opt("b-open") },
          { id: "b-voted-closed", title: "Voted closed", active: true, closes_at: oldClose, order_index: 2, member_ballot_options: opt("b-voted") },
          { id: "b-stale-closed", title: "Stale closed", active: true, closes_at: oldClose, order_index: 3, member_ballot_options: opt("b-stale") },
        ], error: null },
        // No member_ballot_votes seed: the table is dead (20260808230000) and
        // the receipt below is what keeps this closed ballot in the plan.
        member_ballot_receipts: { data: [{ ballot_id: "b-voted-closed", receipt_code: "SG-AAAA-BBBB", issued_at: oldClose }], error: null },
        member_surveys: { data: [
          { id: "p-answered-closed", title: "Answered pulse", active: true, closes_at: oldClose, order_index: 1, member_survey_options: opt("p-a") },
          { id: "p-stale-closed", title: "Stale pulse", active: true, closes_at: oldClose, order_index: 2, member_survey_options: opt("p-s") },
        ], error: null },
        member_survey_responses: { data: [{ survey_id: "p-answered-closed", option_id: "p-a-opt" }], error: null },
      }),
      rpcs: { ...memberAppRpcs, get_ballot_tally: tally },
    });
    const out = await loadMemberApp(client, { id: "user-1", email: "d@example.org" });
    const ids = out.planItems.map((item) => item.id);

    // Participated closed rows survive with their artifacts; stale ones drop.
    expect(ids).toContain("b-voted-closed");
    expect(ids).toContain("p-answered-closed");
    expect(ids).not.toContain("b-stale-closed");
    expect(ids).not.toContain("p-stale-closed");

    const votedClosed = out.planItems.find((item) => item.id === "b-voted-closed");
    expect(votedClosed.closed).toBe(true);
    expect(votedClosed.receiptCode).toBe("SG-AAAA-BBBB");
    expect(votedClosed.quorum).toEqual({ totalVotes: 3, quorumTarget: 10 });
    expect(votedClosed.action).toBe("Voted");
    const answeredClosed = out.planItems.find((item) => item.id === "p-answered-closed");
    expect(answeredClosed.closed).toBe(true);

    // Open rows render above closed ones; open rows carry closed:false.
    expect(ids.indexOf("b-open")).toBeLessThan(ids.indexOf("b-voted-closed"));
    expect(out.planItems.find((item) => item.id === "b-open").closed).toBe(false);

    // The get_ballot_tally fan-out is bounded to kept rows — never fired for
    // the dropped stale ballot.
    const talliedIds = tally.mock.calls.map(([args]) => args.p_ballot_id).sort();
    expect(talliedIds).toEqual(["b-open", "b-voted-closed"]);
  });
});

// BUG-UG-WEB-ORG-STRUCTURE-ALWAYS-EMPTY-20261003: the loader awaited
// nothing, so the normalizer received a Promise and every member saw the empty
// message, and an RPC error escaped as an unhandled rejection.
describe("getMemberOrganizationStructure", () => {
  it("passes the charts the RPC returns through to the page", async () => {
    const chart = {
      chartKind: "union",
      nodes: [
        { id: "n-president", parentId: null, nodeKind: "role", label: "President", positionX: 0, positionY: 0, sortOrder: 1 },
        { id: "n-steward", parentId: "n-president", nodeKind: "role", label: "Chief steward", positionX: 1, positionY: 1, sortOrder: 2 },
      ],
      edges: [{ id: "e-1", sourceId: "n-steward", targetId: "n-president", kind: "reports_to" }],
    };
    const client = { rpc: vi.fn().mockResolvedValue({ data: { organizationId: "org-1", chapterId: "ch-1", generatedAt: "2026-10-03T20:00:00Z", charts: [chart] }, error: null }) };
    const structure = await getMemberOrganizationStructure(client);
    expect(client.rpc).toHaveBeenCalledWith("get_member_organization_structure");
    expect(structure).toMatchObject({ organizationId: "org-1", chapterId: "ch-1", generatedAt: "2026-10-03T20:00:00Z" });
    expect(structure.charts).toHaveLength(1);
    expect(structure.charts[0]).toMatchObject({ chartKind: "union", edges: [{ id: "e-1", sourceId: "n-steward", targetId: "n-president", kind: "reports_to" }] });
    expect(structure.charts[0].nodes.map((node) => node.label)).toEqual(["President", "Chief steward"]);
  });

  it("rejects when the RPC errors, so the page can show its error state", async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "permission denied", code: "42501" } }) };
    await expect(getMemberOrganizationStructure(client)).rejects.toMatchObject({ name: "MemberApiError", label: "Organization structure", code: "42501" });
  });
});
