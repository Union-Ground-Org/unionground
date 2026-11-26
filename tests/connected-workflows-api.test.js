// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONNECTED_ERROR_CODES,
  CONNECTED_MESSAGE_LIMITS,
  CONNECTED_REMINDER_ACTIONS,
  CONNECTED_REMINDER_FILTERS,
  CONNECTED_SOURCE_KINDS,
  CONNECTED_WORKFLOW_RPC,
  ConnectedWorkflowError,
  connectedAttachmentFromRow,
  connectedTaskFromRow,
  createConnectedWorkflowApi,
  isSafeInAppRoute,
  newConnectedRequestId,
  normalizeConnectedReference,
} from "../src/features/connectedWorkflows/api.js";
import { chapterTaskAttachmentFromRow, chapterTaskFromRow } from "../src/lib/memberApi.js";
import { stripComments } from "./helpers/migration.js";

const migration = stripComments(readFileSync("supabase/migrations/20261001020000_connected_workflow_shortcuts.sql", "utf8"));
const UUID = "3f2b7c1e-8d4a-4e5f-9a6b-1c2d3e4f5a6b";
const OTHER = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const ORG = "9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a";
const FUTURE = () => new Date(Date.now() + 3 * 86400000).toISOString();

function fakeClient(respond) {
  const calls = [];
  return {
    calls,
    async rpc(name, args) {
      calls.push({ name, args });
      return respond(name, args);
    },
  };
}
const ok = (data) => ({ data, error: null });

function sqlParams(rpcName) {
  const match = new RegExp(`create function public\\.${rpcName}\\(([^)]*)\\)`, "i").exec(migration);
  expect(match, `${rpcName} is defined by the migration`).not.toBeNull();
  return [...match[1].matchAll(/\bp_[a-z_]+/g)].map((token) => token[0]);
}

const taskRow = {
  id: UUID, chapter_id: "wor", task_number: 42, title: "Follow up on event", description: "", status: "to_do",
  priority: "medium", task_type: "general", workstream: "General", assignee_id: null, assignee_name: "",
  start_date: null, due_date: null, progress: 0, blocked: false, milestone: false, order_index: 0,
  created_by: OTHER, updated_by: OTHER, done_at: null, created_at: "2026-09-29T00:00:00Z", updated_at: "2026-09-29T00:00:00Z",
};
const attachmentRow = {
  id: OTHER, task_id: UUID, chapter_id: "wor", label: "Authorized event", record_url: "/m/events?event=may-day",
  created_by: OTHER, source_kind: "event", source_id: "may-day", created_at: "2026-09-29T00:00:00Z", updated_at: "2026-09-29T00:00:00Z",
};
const availableContext = {
  available: true, reason: null, kind: "event", id: "may-day", organizationId: ORG, chapterId: "wor", state: "available",
  href: "/m/events?event=may-day", canMessage: true, canRemind: true, canCreateTask: true,
  reasons: { message: null, remind: null, task: null },
  linkedTask: { ...taskRow, taskKey: "wor-42", href: `/m/tasks?task=${UUID}` },
  discussionHref: "/m/events?event=may-day&discussion=1",
  sourceLinks: [
    { reference: { kind: "private_message", id: UUID, organizationId: ORG, chapterId: "wor" }, label: "Linked message" },
    { reference: { kind: "mystery", id: "x" }, label: "Dropped" },
  ],
  timezone: { basis: "instant", startsAt: "2026-10-05T18:00:00+00:00", eventZone: null },
  cancelled: false, organizer: { id: OTHER, label: "Sam Steward" }, contactOptIn: true,
  canManageOrganizer: true, canContactOptIn: true, contactRole: "organizer",
};

afterEach(() => vi.unstubAllGlobals());

describe("exported vocabulary", () => {
  it("pins the limits and verbs both clients rely on", () => {
    expect(CONNECTED_MESSAGE_LIMITS).toEqual({ maxRecipients: 12, maxBody: 4000, maxNote: 500 });
    expect(CONNECTED_REMINDER_ACTIONS).toEqual(["open", "snooze", "complete", "cancel"]);
    expect(CONNECTED_REMINDER_FILTERS).toEqual(["open", "scheduled", "delivered", "completed", "cancelled", "failed", "all"]);
    for (const list of [CONNECTED_MESSAGE_LIMITS, CONNECTED_REMINDER_ACTIONS, CONNECTED_REMINDER_FILTERS, CONNECTED_ERROR_CODES]) expect(Object.isFrozen(list)).toBe(true);
    // Every server filter the facade accepts is one the SQL reader understands.
    const reader = readFileSync("supabase/migrations/20261001020000_connected_workflow_shortcuts.sql", "utf8");
    for (const filter of CONNECTED_REMINDER_FILTERS) expect(reader).toContain(`when '${filter}' then`);
  });
});

describe("reference and route validation", () => {
  it("accepts exact ids for every kind and refuses anything else before a request is made", () => {
    expect(CONNECTED_SOURCE_KINDS).toEqual(["private_message", "channel_post", "task_message", "task", "event"]);
    expect(normalizeConnectedReference({ kind: "task", id: ` ${UUID.toUpperCase()} `, chapterId: "wor", organizationId: ORG }))
      .toEqual({ kind: "task", id: UUID, organizationId: ORG, chapterId: "wor" });
    expect(normalizeConnectedReference({ kind: "event", id: "may-day" })).toEqual({ kind: "event", id: "may-day", organizationId: null, chapterId: null });
    for (const bad of [
      { kind: "case", id: UUID }, { kind: "task", id: "wor-42" }, { kind: "event", id: "May Day" }, { kind: "event", id: "ab" },
      { kind: "private_message", id: "" }, { kind: "event", id: "may-day", organizationId: "org" }, null, {},
    ]) {
      expect(() => normalizeConnectedReference(bad), JSON.stringify(bad)).toThrow(ConnectedWorkflowError);
    }
  });

  it("only trusts in-app routes made of ids", () => {
    for (const good of [`/m/tasks?task=${UUID}`, "/m/events?event=may-day&discussion=1", `/m/messages?conversation=${UUID}&message=${OTHER}`, "/m/steward?thread=abc", "/m"]) {
      expect(isSafeInAppRoute(good), good).toBe(true);
    }
    for (const bad of ["https://evil.example/m/x", "//evil.example", "/m/../admin", "/m/a b", "/x/m", "/m?next=https://evil", "javascript:alert(1)", "/m/%0d", "", null, 5, `/m/${"a".repeat(600)}`, "/m/\\evil"]) {
      expect(isSafeInAppRoute(bad), String(bad)).toBe(false);
    }
  });

  it("issues a v4 request id with or without the platform generator", () => {
    expect(newConnectedRequestId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    vi.stubGlobal("crypto", undefined);
    const fallback = newConnectedRequestId();
    expect(fallback).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newConnectedRequestId()).not.toBe(fallback);
  });
});

describe("context", () => {
  it("normalizes an authorized context and never trusts a route it cannot verify", async () => {
    const client = fakeClient(() => ok({ ...availableContext, href: "https://evil.example/", discussionHref: "/m/../x" }));
    const api = createConnectedWorkflowApi(client);
    const context = await api.context({ kind: "event", id: "may-day", chapterId: "wor", organizationId: ORG });
    expect(client.calls).toEqual([{ name: "get_connected_workflow_context", args: { p_kind: "event", p_id: "may-day", p_chapter_id: "wor", p_organization_id: ORG } }]);
    expect(context).toMatchObject({
      available: true, state: "available", href: null, discussionHref: null, canMessage: true, canRemind: true, canCreateTask: true,
      cancelled: false, organizer: { id: OTHER, label: "Sam Steward" }, contactOptIn: true, canManageOrganizer: true,
      canContactOptIn: true, contactRole: "organizer",
      timezone: { basis: "instant", startsAt: "2026-10-05T18:00:00+00:00", eventZone: null },
    });
    expect(context.linkedTask).toEqual({ ...chapterTaskFromRow(taskRow), taskKey: "wor-42", href: `/m/tasks?task=${UUID}` });
    expect(context.sourceLinks).toEqual([{ reference: { kind: "private_message", id: UUID, organizationId: ORG, chapterId: "wor" }, label: "Linked message" }]);
    expect(context.reference).toEqual({ kind: "event", id: "may-day", organizationId: ORG, chapterId: "wor" });
  });

  it("fails closed: an unavailable source exposes no capability even if the payload claims one", async () => {
    const api = createConnectedWorkflowApi(fakeClient(() => ok({ ...availableContext, available: false, reason: "scope_changed" })));
    const context = await api.context({ kind: "event", id: "may-day", chapterId: "old" });
    expect(context).toMatchObject({
      available: false, reason: "scope_changed", state: "unavailable", href: null, canMessage: false, canRemind: false,
      canCreateTask: false, linkedTask: null, discussionHref: null, sourceLinks: [], timezone: null, cancelled: false,
      organizer: null, contactOptIn: false, canManageOrganizer: false, canContactOptIn: false, contactRole: null,
    });
    expect(context.reference).toEqual({ kind: "event", id: "may-day", organizationId: null, chapterId: "old" });
  });
});

describe("recipients, tasks, reminders and sends", () => {
  it("pages recipients and reports why an audience is unavailable", async () => {
    const client = fakeClient((name, args) => ok(args.p_cursor
      ? { status: "available", reason: null, items: [{ id: OTHER, label: "B" }], nextCursor: null }
      : { status: "available", reason: null, items: [{ id: UUID, label: "A" }, { id: 5 }], nextCursor: "cursor-1" }));
    const api = createConnectedWorkflowApi(client);
    const first = await api.recipients({ kind: "task", id: UUID });
    expect(first).toEqual({ status: "available", reason: null, items: [{ id: UUID, label: "A" }], nextCursor: "cursor-1" });
    const second = await api.recipients({ kind: "task", id: UUID }, first.nextCursor);
    expect(second.items).toEqual([{ id: OTHER, label: "B" }]);
    expect(client.calls[1].args).toMatchObject({ p_cursor: "cursor-1", p_limit: 25 });
    const none = await createConnectedWorkflowApi(fakeClient(() => ok({ status: "unavailable", reason: "event_cancelled", items: [], nextCursor: null })))
      .recipients({ kind: "event", id: "may-day" });
    expect(none).toEqual({ status: "unavailable", reason: "event_cancelled", items: [], nextCursor: null });
    await expect(api.recipients({ kind: "task", id: UUID }, "x".repeat(401))).rejects.toMatchObject({ code: "invalid_input", reason: "cursor" });
  });

  it("maps a created task exactly like the app's own row mappers", async () => {
    const api = createConnectedWorkflowApi(fakeClient(() => ok({
      created: true, task: taskRow, attachment: attachmentRow, taskKey: "wor-42", href: `/m/tasks?task=${UUID}`,
    })));
    const made = await api.createTask({ kind: "event", id: "may-day" });
    expect(made.task).toEqual(chapterTaskFromRow(taskRow));
    expect(made.attachment).toEqual(chapterTaskAttachmentFromRow(attachmentRow));
    expect(connectedTaskFromRow(taskRow)).toEqual(chapterTaskFromRow(taskRow));
    expect(connectedAttachmentFromRow(attachmentRow)).toEqual(chapterTaskAttachmentFromRow(attachmentRow));
    expect(made).toMatchObject({ created: true, taskKey: "wor-42", href: `/m/tasks?task=${UUID}` });
    await expect(createConnectedWorkflowApi(fakeClient(() => ok({ created: true }))).createTask({ kind: "event", id: "may-day" }))
      .rejects.toMatchObject({ code: "invalid_response" });
    // A task message opens the task it already belongs to: nothing is created and there is no new link row.
    const opened = await createConnectedWorkflowApi(fakeClient(() => ok({ created: false, task: taskRow, attachment: null, taskKey: "wor-42", href: `/m/tasks?task=${UUID}` })))
      .createTask({ kind: "task_message", id: OTHER });
    expect(opened).toEqual({ task: chapterTaskFromRow(taskRow), attachment: null, created: false, taskKey: "wor-42", href: `/m/tasks?task=${UUID}` });
  });

  it("validates reminder time and note before asking the server, and normalizes the row", async () => {
    const row = {
      id: UUID, kind: "event", sourceId: "may-day", remindAt: FUTURE(), note: "bring badge", status: "scheduled",
      snoozeCount: 0, completedAt: null, createdAt: "2026-09-29T00:00:00Z", updatedAt: "2026-09-29T00:00:00Z",
      available: true, sourceState: "available", href: "/m/events?event=may-day", title: "Contract rally",
    };
    const client = fakeClient(() => ok({ created: true, coalesced: false, reminder: row }));
    const api = createConnectedWorkflowApi(client);
    const at = FUTURE();
    const saved = await api.remind({ kind: "event", id: "may-day" }, at, " bring badge ");
    expect(client.calls[0]).toEqual({ name: "save_connected_workflow_reminder", args: {
      p_kind: "event", p_id: "may-day", p_remind_at: new Date(at).toISOString(), p_note: "bring badge", p_chapter_id: null, p_organization_id: null } });
    expect(saved).toEqual({ created: true, coalesced: false, reminder: { ...row, href: "/m/events?event=may-day" } });
    for (const bad of [new Date(Date.now() - 1000).toISOString(), new Date(Date.now() + 400 * 86400000).toISOString(), "tomorrow", null]) {
      await expect(api.remind({ kind: "event", id: "may-day" }, bad), String(bad)).rejects.toMatchObject({ code: "invalid_input" });
    }
    await expect(api.remind({ kind: "event", id: "may-day" }, at, "x".repeat(501))).rejects.toMatchObject({ reason: "note" });
    expect(client.calls).toHaveLength(1);
    // A reminder whose source became unavailable is opaque to the client too.
    const opaque = await createConnectedWorkflowApi(fakeClient(() => ok({ items: [{ ...row, available: false, sourceId: null, href: "/m/events?event=leak", title: "leak" }], nextCursor: null })))
      .listReminders();
    expect(opaque.items[0]).toMatchObject({ available: false, href: null, title: null, sourceId: null });
  });

  it("acts on reminders with the server's vocabulary only", async () => {
    const reminder = { id: UUID, kind: "task", remindAt: FUTURE(), note: "", status: "completed", snoozeCount: 1, available: true, sourceState: "available", href: `/m/tasks?task=${OTHER}` };
    const client = fakeClient(() => ok({ reminder, available: true, href: `/m/tasks?task=${OTHER}`, replayed: true }));
    const api = createConnectedWorkflowApi(client);
    expect(await api.updateReminder(UUID, "complete")).toMatchObject({ available: true, replayed: true, href: `/m/tasks?task=${OTHER}`, reminder: { status: "completed" } });
    expect(client.calls[0].args).toEqual({ p_reminder_id: UUID, p_action: "complete", p_remind_at: null });
    const at = FUTURE();
    await api.updateReminder(UUID, "snooze", at);
    expect(client.calls[1].args.p_remind_at).toBe(new Date(at).toISOString());
    await expect(api.updateReminder(UUID, "snooze")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(api.updateReminder(UUID, "delete")).rejects.toMatchObject({ reason: "action" });
    await expect(api.updateReminder("nope", "cancel")).rejects.toMatchObject({ reason: "reminder" });
    await expect(api.listReminders(null, { status: "everything" })).rejects.toMatchObject({ reason: "status" });
    const listed = createConnectedWorkflowApi(fakeClient((name, args) => ok({ items: [reminder], nextCursor: args.p_cursor ? null : "c2" })));
    const page = await listed.listReminders(null, { status: "all", limit: 500 });
    expect(page.nextCursor).toBe("c2");
  });

  it("sends only to explicit, distinct, bounded recipients with a request id", async () => {
    const client = fakeClient(() => ok({ sent: 2, replayed: false, results: [
      { recipientId: UUID, via: "event_organizer", messageId: OTHER, replayed: false },
      { recipientId: OTHER, via: "event_organizer", messageId: UUID, replayed: false }] }));
    const api = createConnectedWorkflowApi(client);
    const request = newConnectedRequestId();
    const sent = await api.send({ kind: "event", id: "may-day" }, [UUID, OTHER], "  Doors open at six  ", request);
    expect(client.calls[0]).toEqual({ name: "send_connected_workflow_message", args: {
      p_kind: "event", p_id: "may-day", p_recipient_ids: [UUID, OTHER], p_body: "Doors open at six", p_request_id: request,
      p_chapter_id: null, p_organization_id: null } });
    expect(sent).toEqual({ sent: 2, replayed: false, results: [
      { recipientId: UUID, via: "event_organizer", messageId: OTHER, replayed: false },
      { recipientId: OTHER, via: "event_organizer", messageId: UUID, replayed: false }] });
    const many = Array.from({ length: 13 }, (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
    for (const [ids, body, id] of [
      [[], "hi", request], [[UUID, UUID], "hi", request], [many, "hi", request], [["nope"], "hi", request],
      [[UUID], "   ", request], [[UUID], "x".repeat(4001), request], [[UUID], "hi", "not-a-uuid"], [[UUID], "hi", undefined],
    ]) {
      await expect(api.send({ kind: "event", id: "may-day" }, ids, body, id), JSON.stringify([ids, body.length, id])).rejects.toBeInstanceOf(ConnectedWorkflowError);
    }
    expect(client.calls).toHaveLength(1);
  });
});

describe("event organizer, consent and thread", () => {
  // REQ-UG-LEARNING-PERIOD-EVENTS-20261103.
  it("sends the event version an organizer change opened with, and never resends it without the version (#8960)", async () => {
    let missing = true;
    const client = { calls: [], async rpc(name, args) {
      this.calls.push({ name, args });
      if (missing && "p_expected_version" in args && args.p_expected_version === 4) { missing = false; return { data: null, error: { code: "PGRST202", message: "missing" }, status: 404 }; }
      return { data: { eventId: "may-day", organizer: null, changed: true, version: 5 }, error: null };
    } };
    const api = createConnectedWorkflowApi(client);
    expect(await api.setEventOrganizer("may-day", null, 3)).toMatchObject({ changed: true, version: 5 });
    await expect(api.setEventOrganizer("may-day", null, 4)).rejects.toThrow();
    expect(client.calls.map((call) => call.args)).toEqual([
      { p_event_id: "may-day", p_organizer_id: null, p_expected_version: 3 },
      { p_event_id: "may-day", p_organizer_id: null, p_expected_version: 4 },
    ]);
  });

  it("assigns, lists candidates, records consent and reads the thread", async () => {
    const client = fakeClient((name) => ({
      set_member_event_organizer: ok({ eventId: "may-day", organizer: { id: UUID, label: "Sam" }, changed: true }),
      list_member_event_organizer_candidates: ok({ items: [{ id: UUID, label: "Sam" }, { label: "no id" }], nextCursor: "n" }),
      set_member_event_contact_opt_in: ok({ eventId: "may-day", contactOptIn: true, changed: true }),
      list_member_event_contact_messages: ok({ available: true, nextCursor: null, items: [
        { id: UUID, mine: false, senderRole: "organizer", body: "hello", redacted: false, createdAt: "2026-09-29T01:00:00Z" },
        { id: OTHER, mine: true, senderRole: "participant", body: "SHOULD NOT SHOW", redacted: true, createdAt: "2026-09-29T00:00:00Z" }] }),
    })[name]);
    const api = createConnectedWorkflowApi(client);
    expect(await api.setEventOrganizer("may-day", UUID)).toEqual({ eventId: "may-day", organizer: { id: UUID, label: "Sam" }, changed: true, version: null });
    await api.setEventOrganizer("may-day", null);
    expect(client.calls[1].args).toEqual({ p_event_id: "may-day", p_organizer_id: null });
    expect(await api.eventOrganizerCandidates("may-day", "cur")).toEqual({ items: [{ id: UUID, label: "Sam" }], nextCursor: "n" });
    expect(client.calls[2].args).toEqual({ p_event_id: "may-day", p_cursor: "cur", p_limit: 25 });
    expect(await api.setEventContactOptIn("may-day", true, UUID)).toEqual({ eventId: "may-day", contactOptIn: true, changed: true, organizerId: null });
    expect(client.calls[3].args).toEqual({ p_event_id: "may-day", p_opt_in: true, p_expected_organizer_id: UUID });
    // Enabling must name the organizer that was shown; withdrawing needs none and never sends one.
    await expect(api.setEventContactOptIn("may-day", true)).rejects.toMatchObject({ code: "invalid_input", reason: "expected_organizer" });
    await expect(api.setEventContactOptIn("may-day", true, "nope")).rejects.toMatchObject({ code: "invalid_input", reason: "expected_organizer" });
    await api.setEventContactOptIn("may-day", false, UUID);
    expect(client.calls.at(-1).args).toEqual({ p_event_id: "may-day", p_opt_in: false, p_expected_organizer_id: null });
    await expect(api.setEventContactOptIn("may-day", "yes")).rejects.toMatchObject({ reason: "opt_in" });
    const thread = await api.eventMessages("may-day", UUID);
    expect(thread).toEqual({ available: true, nextCursor: null, items: [
      { id: UUID, mine: false, senderRole: "organizer", body: "hello", redacted: false, createdAt: "2026-09-29T01:00:00Z" },
      { id: OTHER, mine: true, senderRole: "participant", body: "", redacted: true, createdAt: "2026-09-29T00:00:00Z" }] });
    await expect(api.setEventOrganizer("May Day", UUID)).rejects.toMatchObject({ reason: "eventId" });
    await expect(api.setEventOrganizer("may-day", "nope")).rejects.toMatchObject({ reason: "organizerId" });
  });

  it("tells the caller to clear held history when the thread is unavailable", async () => {
    const api = createConnectedWorkflowApi(fakeClient(() => ok({ available: false, items: [{ id: UUID, body: "stale" }], nextCursor: "x" })));
    expect(await api.eventMessages("may-day")).toEqual({ available: false, items: [], nextCursor: null });
  });
});

describe("failure mapping", () => {
  const failing = (error) => createConnectedWorkflowApi(fakeClient(() => ({ data: null, error })));
  it("reads the machine token the server puts in DETAIL", async () => {
    await expect(failing({ code: "42501", message: "staff role required", details: "cw:not_authorized:staff_grant_required" }).createTask({ kind: "event", id: "may-day" }))
      .rejects.toMatchObject({ name: "ConnectedWorkflowError", code: "not_authorized", reason: "staff_grant_required", sqlState: "42501", retryable: false });
    await expect(failing({ code: "22023", message: "x", details: "cw:scope_changed:chapter_mismatch" }).createTask({ kind: "event", id: "may-day" }))
      .rejects.toMatchObject({ code: "scope_changed", reason: "chapter_mismatch" });
    await expect(failing({ code: "22023", message: "m", details: "cw:capability_unavailable:organizer_cannot_opt_in" }).setEventContactOptIn("may-day", true, UUID))
      .rejects.toMatchObject({ code: "capability_unavailable", reason: "organizer_cannot_opt_in" });
    await expect(failing({ code: "22023", message: "m", details: "cw:organizer_changed:organizer_changed" }).setEventContactOptIn("may-day", true, UUID))
      .rejects.toMatchObject({ code: "organizer_changed", reason: "organizer_changed" });
    await expect(failing({ code: "23505", message: "m", details: "cw:idempotency_conflict:request_reused" }).send({ kind: "event", id: "may-day" }, [UUID], "hi", newConnectedRequestId()))
      .rejects.toMatchObject({ code: "idempotency_conflict", reason: "request_reused" });
  });

  it("falls back to the SQLSTATE and marks only transient failures retryable", async () => {
    const attempt = (error) => failing(error).createTask({ kind: "event", id: "may-day" }).catch((caught) => caught);
    expect(await attempt({ code: "42501", message: "denied" })).toMatchObject({ code: "not_authorized", retryable: false });
    expect(await attempt({ code: "54000", message: "limit" })).toMatchObject({ code: "rate_limited", retryable: true });
    expect(await attempt({ code: "23505", message: "dup" })).toMatchObject({ code: "idempotency_conflict" });
    expect(await attempt({ code: "22023", message: "bad" })).toMatchObject({ code: "invalid_input" });
    expect(await attempt({ code: "XX000", message: "boom" })).toMatchObject({ code: "unavailable" });
    expect(await attempt({ message: "Failed to fetch" })).toMatchObject({ code: "network", retryable: true });
    const thrown = createConnectedWorkflowApi({ rpc: async () => { throw new TypeError("offline"); } });
    await expect(thrown.context({ kind: "event", id: "may-day" })).rejects.toMatchObject({ code: "network", retryable: true });
    await expect(createConnectedWorkflowApi(null).context({ kind: "event", id: "may-day" })).rejects.toMatchObject({ code: "unavailable", reason: "client" });
    await expect(createConnectedWorkflowApi(fakeClient(() => ok(null))).context({ kind: "event", id: "may-day" })).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("the facade matches the migration", () => {
  it("only raises codes the facade declares", () => {
    const raised = new Set([...migration.matchAll(/cw_fail\('([a-z_]+)'/g)].map((match) => match[1]));
    expect([...raised].filter((code) => !CONNECTED_ERROR_CODES.includes(code))).toEqual([]);
    expect(raised.size).toBeGreaterThanOrEqual(9);
  });

  it("calls every RPC with exactly the parameter names the SQL declares", async () => {
    const client = fakeClient((name) => ok({ items: [], nextCursor: null, available: true, status: "available", reminder: { id: UUID }, task: taskRow, created: true, organizer: null }));
    const api = createConnectedWorkflowApi(client);
    const ref = { kind: "event", id: "may-day" };
    const at = FUTURE();
    await api.context(ref); await api.recipients(ref); await api.createTask(ref); await api.remind(ref, at);
    await api.listReminders(); await api.updateReminder(UUID, "snooze", at);
    await api.send(ref, [UUID], "hi", newConnectedRequestId()); await api.setEventOrganizer("may-day", UUID);
    await api.eventOrganizerCandidates("may-day"); await api.setEventContactOptIn("may-day", true, UUID); await api.eventMessages("may-day");
    expect(client.calls.map((call) => call.name).sort()).toEqual(Object.values(CONNECTED_WORKFLOW_RPC).sort());
    for (const call of client.calls) {
      expect(sqlParams(call.name).sort(), call.name).toEqual(Object.keys(call.args).sort());
    }
  });
});
