// Connected workflow facade over the server RPCs of
// supabase/migrations/20261001020000_connected_workflow_shortcuts.sql.
//
// Pure ESM with no React, DOM, Node or app imports, so the web app and the Expo
// app (through a thin bridge) use one implementation. The server is the only
// authority: every read and write re-derives access from the exact record, and
// the chapter/organization on a reference is only a stale-scope assertion. This
// module never changes a hat or chapter, never sends anything except from
// `send`, and never places source text in a title, preview or route.

/** @typedef {'private_message'|'channel_post'|'task_message'|'task'|'event'} ConnectedSourceKind */
/** @typedef {{kind: ConnectedSourceKind, id: string, organizationId?: string|null, chapterId?: string|null}} ConnectedReference */

export const CONNECTED_SOURCE_KINDS = Object.freeze([
  'private_message', 'channel_post', 'task_message', 'task', 'event',
]);
export const CONNECTED_REMINDER_ACTIONS = Object.freeze(['open', 'snooze', 'complete', 'cancel']);
export const CONNECTED_REMINDER_FILTERS = Object.freeze([
  'open', 'scheduled', 'delivered', 'completed', 'cancelled', 'failed', 'all',
]);
export const CONNECTED_MESSAGE_LIMITS = Object.freeze({ maxRecipients: 12, maxBody: 4000, maxNote: 500 });

// Every code the server can attach to a refusal (DETAIL "cw:<code>[:<reason>]")
// plus the two the facade raises itself. A test pins the SQL vocabulary to this.
export const CONNECTED_ERROR_CODES = Object.freeze([
  'not_authorized', 'source_unavailable', 'scope_changed', 'capability_unavailable', 'invalid_input',
  'event_cancelled', 'opt_in_required', 'organizer_required', 'organizer_changed', 'recipient_unavailable', 'rate_limited',
  'idempotency_conflict', 'network', 'invalid_response', 'unavailable',
]);

export const CONNECTED_WORKFLOW_RPC = Object.freeze({
  context: 'get_connected_workflow_context',
  recipients: 'list_connected_workflow_recipients',
  createTask: 'create_connected_workflow_task',
  saveReminder: 'save_connected_workflow_reminder',
  listReminders: 'list_connected_workflow_reminders',
  actOnReminder: 'act_on_connected_workflow_reminder',
  send: 'send_connected_workflow_message',
  setEventOrganizer: 'set_member_event_organizer',
  eventOrganizerCandidates: 'list_member_event_organizer_candidates',
  setEventContactOptIn: 'set_member_event_contact_opt_in',
  eventMessages: 'list_member_event_contact_messages',
});

const UUID_KINDS = new Set(['private_message', 'channel_post', 'task_message', 'task']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;
// Server routes carry only uuids and slugs, so no percent-encoding is ever admitted.
const ROUTE_RE = /^\/m(?:\/[A-Za-z0-9_.~-]+)*(?:\?[A-Za-z0-9_.~&=-]*)?$/;
const MAX_CURSOR = 400;
const YEAR_MS = 366 * 24 * 60 * 60 * 1000;

/**
 * Normalized failure. `code` is stable: not_authorized, source_unavailable,
 * scope_changed, capability_unavailable, invalid_input, event_cancelled,
 * opt_in_required, organizer_required, organizer_changed, recipient_unavailable,
 * rate_limited, idempotency_conflict, network, invalid_response, unavailable.
 */
export class ConnectedWorkflowError extends Error {
  constructor(code, { reason = null, retryable = false, sqlState = null, cause = undefined } = {}) {
    super(reason ? `${code}:${reason}` : code);
    this.name = 'ConnectedWorkflowError';
    this.code = code;
    this.reason = reason;
    this.retryable = retryable;
    this.sqlState = sqlState;
    if (cause !== undefined) this.cause = cause;
  }
}

function invalid(reason) {
  return new ConnectedWorkflowError('invalid_input', { reason });
}

// Server refusals carry DETAIL "cw:<code>[:<reason>]"; anything else falls back
// to the SQLSTATE so a raw PostgREST error still lands on a stable code.
function toError(error) {
  if (error instanceof ConnectedWorkflowError) return error;
  const details = String(error?.details ?? '');
  const match = /cw:([a-z_]+)(?::([a-z_]+))?/.exec(details) || /cw:([a-z_]+)(?::([a-z_]+))?/.exec(String(error?.message ?? ''));
  const sqlState = typeof error?.code === 'string' ? error.code : null;
  if (match) {
    return new ConnectedWorkflowError(match[1], {
      reason: match[2] ?? null, sqlState, retryable: match[1] === 'rate_limited', cause: error,
    });
  }
  if (sqlState === '42501') return new ConnectedWorkflowError('not_authorized', { sqlState, cause: error });
  if (sqlState === '54000') return new ConnectedWorkflowError('rate_limited', { sqlState, retryable: true, cause: error });
  if (sqlState === '23505') return new ConnectedWorkflowError('idempotency_conflict', { sqlState, cause: error });
  if (sqlState === '22023') return new ConnectedWorkflowError('invalid_input', { sqlState, cause: error });
  if (!sqlState) return new ConnectedWorkflowError('network', { retryable: true, cause: error });
  return new ConnectedWorkflowError('unavailable', { sqlState, cause: error });
}

// `request` is a thunk that performs exactly one `client.rpc("<literal name>", args)`
// so every RPC name stays a literal at its call site (the repository's read-RPC
// drift guard resolves them statically).
async function perform(client, request, name) {
  if (!client || typeof client.rpc !== 'function') throw new ConnectedWorkflowError('unavailable', { reason: 'client' });
  let response;
  try {
    response = await request();
  } catch (cause) {
    throw toError(cause);
  }
  const { data, error } = response || {};
  if (error) throw toError(error);
  if (data === null || data === undefined || typeof data !== 'object') {
    throw new ConnectedWorkflowError('invalid_response', { reason: name });
  }
  return data;
}

/** True only for an in-app path that carries ids, never content. */
export function isSafeInAppRoute(route) {
  if (typeof route !== 'string' || route.length > 500 || !ROUTE_RE.test(route)) return false;
  return !route.split('?')[0].split('/').some((segment) => segment === '..' || segment === '.');
}

function safeRoute(route) {
  return isSafeInAppRoute(route) ? route : null;
}

export function newConnectedRequestId() {
  const webCrypto = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (webCrypto && typeof webCrypto.randomUUID === 'function') return webCrypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (webCrypto && typeof webCrypto.getRandomValues === 'function') webCrypto.getRandomValues(bytes);
  else for (let index = 0; index < 16; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function uuidOrNull(value, reason) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!UUID_RE.test(text)) throw invalid(reason);
  return text.toLowerCase();
}

function textOrNull(value, reason) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!text || text.length > 200) throw invalid(reason);
  return text;
}

/** Validates the shape only; the server decides whether the record is usable. */
export function normalizeConnectedReference(reference) {
  const kind = String(reference?.kind ?? '');
  if (!CONNECTED_SOURCE_KINDS.includes(kind)) throw invalid('kind');
  const rawId = String(reference?.id ?? '').trim();
  const uuidKind = UUID_KINDS.has(kind);
  if (uuidKind ? !UUID_RE.test(rawId) : !EVENT_ID_RE.test(rawId)) throw invalid('id');
  return {
    kind,
    id: uuidKind ? rawId.toLowerCase() : rawId,
    organizationId: uuidOrNull(reference?.organizationId, 'organizationId'),
    chapterId: textOrNull(reference?.chapterId, 'chapterId'),
  };
}

function scopeArgs(reference) {
  return { p_chapter_id: reference.chapterId, p_organization_id: reference.organizationId };
}

function eventIdOf(eventId) {
  const id = String(eventId ?? '').trim();
  if (!EVENT_ID_RE.test(id)) throw invalid('eventId');
  return id;
}

function cursorOf(cursor) {
  if (cursor === null || cursor === undefined || cursor === '') return null;
  const text = String(cursor);
  if (text.length > MAX_CURSOR) throw invalid('cursor');
  return text;
}

function isoTimeOf(value, reason = 'time') {
  const date = value instanceof Date ? value : new Date(String(value ?? ''));
  const stamp = date.getTime();
  if (!Number.isFinite(stamp)) throw invalid(reason);
  const now = Date.now();
  if (stamp <= now || stamp > now + YEAR_MS) throw invalid(reason);
  return date.toISOString();
}

// Same shape as chapterTaskFromRow in src/lib/memberApi.js (pinned by a test).
export function connectedTaskFromRow(row) {
  return {
    id: row.id,
    chapterId: row.chapter_id ?? row.chapterId,
    taskNumber: row.task_number ?? row.taskNumber ?? null,
    title: row.title,
    description: row.description || '',
    status: row.status,
    priority: row.priority,
    taskType: row.task_type || row.taskType || 'general',
    workstream: row.workstream,
    assigneeId: row.assignee_id ?? row.assigneeId ?? null,
    assigneeName: row.assignee_name ?? row.assigneeName ?? '',
    startDate: row.start_date ?? row.startDate ?? null,
    dueDate: row.due_date ?? row.dueDate ?? null,
    progress: row.progress,
    blocked: row.blocked,
    milestone: row.milestone,
    orderIndex: row.order_index ?? row.orderIndex,
    createdBy: row.created_by ?? row.createdBy,
    updatedBy: row.updated_by ?? row.updatedBy ?? null,
    doneAt: row.done_at ?? row.doneAt ?? null,
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt,
    unitId: row.settings_scope?.unitId ?? row.unitId ?? null,
    unitName: row.settings_scope?.unitName ?? row.unitName ?? null,
  };
}

// Same shape as chapterTaskAttachmentFromRow in src/lib/memberApi.js.
export function connectedAttachmentFromRow(row) {
  return {
    id: row.id,
    taskId: row.task_id ?? row.taskId,
    chapterId: row.chapter_id ?? row.chapterId,
    label: row.label,
    recordUrl: row.record_url ?? row.recordUrl,
    createdBy: row.created_by ?? row.createdBy,
    sourceKind: row.source_kind ?? row.sourceKind ?? null,
    sourceId: row.source_id ?? row.sourceId ?? null,
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt ?? row.created_at ?? row.createdAt,
  };
}

function normalizePerson(person) {
  if (!person || typeof person.id !== 'string' || typeof person.label !== 'string') return null;
  return { id: person.id, label: person.label };
}

function normalizeReferenceOut(reference) {
  if (!reference || !CONNECTED_SOURCE_KINDS.includes(reference.kind) || typeof reference.id !== 'string') return null;
  return {
    kind: reference.kind,
    id: reference.id,
    organizationId: typeof reference.organizationId === 'string' ? reference.organizationId : null,
    chapterId: typeof reference.chapterId === 'string' ? reference.chapterId : null,
  };
}

function normalizeContext(data, requested) {
  const available = data.available === true;
  const flag = (value) => available && value === true;
  const reasons = data.reasons && typeof data.reasons === 'object' ? data.reasons : {};
  const linked = available && data.linkedTask && typeof data.linkedTask === 'object' ? data.linkedTask : null;
  return {
    available,
    reason: available ? null : String(data.reason ?? 'source_unavailable'),
    reference: available
      ? { kind: data.kind ?? requested.kind, id: data.id ?? requested.id,
          organizationId: data.organizationId ?? null, chapterId: data.chapterId ?? null }
      : { ...requested },
    state: available ? String(data.state ?? 'available') : 'unavailable',
    href: available ? safeRoute(data.href) : null,
    canMessage: flag(data.canMessage),
    canRemind: flag(data.canRemind),
    canCreateTask: flag(data.canCreateTask),
    reasons: {
      message: reasons.message ?? null,
      remind: reasons.remind ?? null,
      task: reasons.task ?? null,
    },
    linkedTask: linked ? { ...connectedTaskFromRow(linked), taskKey: linked.taskKey ?? null, href: safeRoute(linked.href) } : null,
    discussionHref: available ? safeRoute(data.discussionHref) : null,
    sourceLinks: available && Array.isArray(data.sourceLinks)
      ? data.sourceLinks.map((link) => ({ reference: normalizeReferenceOut(link?.reference), label: String(link?.label ?? '') }))
        .filter((link) => link.reference)
      : [],
    timezone: available && data.timezone && typeof data.timezone === 'object'
      ? { basis: data.timezone.basis ?? 'instant', startsAt: data.timezone.startsAt ?? null, eventZone: data.timezone.eventZone ?? null }
      : null,
    cancelled: flag(data.cancelled),
    organizer: available ? normalizePerson(data.organizer) : null,
    contactOptIn: flag(data.contactOptIn),
    canManageOrganizer: flag(data.canManageOrganizer),
    // The event's version for an organizer change (staff only, else null).
    eventVersion: Number.isInteger(data.eventVersion) ? data.eventVersion : null,
    canContactOptIn: flag(data.canContactOptIn),
    contactRole: available && (data.contactRole === 'organizer' || data.contactRole === 'participant') ? data.contactRole : null,
  };
}

function normalizePage(data, mapItem) {
  const items = Array.isArray(data.items) ? data.items.map(mapItem).filter(Boolean) : [];
  return { items, nextCursor: typeof data.nextCursor === 'string' && data.nextCursor ? data.nextCursor : null };
}

function normalizeReminder(row) {
  if (!row || typeof row.id !== 'string') return null;
  return {
    id: row.id,
    kind: row.kind,
    sourceId: typeof row.sourceId === 'string' ? row.sourceId : null,
    remindAt: row.remindAt,
    note: typeof row.note === 'string' ? row.note : '',
    status: row.status,
    snoozeCount: Number(row.snoozeCount ?? 0),
    completedAt: row.completedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    available: row.available === true,
    sourceState: String(row.sourceState ?? 'unavailable'),
    href: row.available === true ? safeRoute(row.href) : null,
    title: row.available === true && typeof row.title === 'string' ? row.title : null,
  };
}

function normalizeThreadMessage(row) {
  if (!row || typeof row.id !== 'string') return null;
  return {
    id: row.id,
    mine: row.mine === true,
    senderRole: row.senderRole === 'organizer' ? 'organizer' : 'participant',
    body: row.redacted === true ? '' : String(row.body ?? ''),
    redacted: row.redacted === true,
    createdAt: row.createdAt,
  };
}

export function createConnectedWorkflowApi(client) {
  const api = {
    /** Authorized, privacy-safe capabilities and routes for one exact record. */
    async context(reference) {
      const ref = normalizeConnectedReference(reference);
      const data = await perform(client, () => client.rpc("get_connected_workflow_context", {
        p_kind: ref.kind, p_id: ref.id, ...scopeArgs(ref),
      }), "get_connected_workflow_context");
      return normalizeContext(data, ref);
    },

    /** Explicit, server-authorized recipients: {status, reason, items:[{id,label}], nextCursor}. */
    async recipients(reference, cursor = null) {
      const ref = normalizeConnectedReference(reference);
      const data = await perform(client, () => client.rpc("list_connected_workflow_recipients", {
        p_kind: ref.kind, p_id: ref.id, p_cursor: cursorOf(cursor), p_limit: 25, ...scopeArgs(ref),
      }), "list_connected_workflow_recipients");
      return {
        status: data.status === 'available' ? 'available' : 'unavailable',
        reason: data.status === 'available' ? null : String(data.reason ?? 'no_authorized_audience'),
        ...normalizePage(data, normalizePerson),
      };
    },

    /** Create-or-open the one staff-only task linked to this source. */
    async createTask(reference) {
      const ref = normalizeConnectedReference(reference);
      const data = await perform(client, () => client.rpc("create_connected_workflow_task", {
        p_kind: ref.kind, p_id: ref.id, ...scopeArgs(ref),
      }), "create_connected_workflow_task");
      if (!data.task || typeof data.task !== 'object') throw new ConnectedWorkflowError('invalid_response', { reason: 'task' });
      return {
        task: connectedTaskFromRow(data.task),
        attachment: data.attachment ? connectedAttachmentFromRow(data.attachment) : null,
        created: data.created === true,
        taskKey: typeof data.taskKey === 'string' ? data.taskKey : null,
        href: safeRoute(data.href),
      };
    },

    /** Set a reminder at an ISO time (future, within a year). Sends nothing. */
    async remind(reference, isoTime, note = '') {
      const ref = normalizeConnectedReference(reference);
      const text = String(note ?? '').trim();
      if (text.length > CONNECTED_MESSAGE_LIMITS.maxNote) throw invalid('note');
      const data = await perform(client, () => client.rpc("save_connected_workflow_reminder", {
        p_kind: ref.kind, p_id: ref.id, p_remind_at: isoTimeOf(isoTime, 'remind_at'), p_note: text, ...scopeArgs(ref),
      }), "save_connected_workflow_reminder");
      const reminder = normalizeReminder(data.reminder);
      if (!reminder) throw new ConnectedWorkflowError('invalid_response', { reason: 'reminder' });
      return { reminder, created: data.created === true, coalesced: data.coalesced === true };
    },

    /**
     * Send to explicitly selected recipients. All-or-nothing; every recipient is
     * re-authorized by the server; a repeated requestId with the same source,
     * recipients and text replays the first result and sends nothing new.
     */
    async send(reference, recipientIds, body, requestId) {
      const ref = normalizeConnectedReference(reference);
      const ids = Array.isArray(recipientIds) ? recipientIds.map((id) => uuidOrNull(id, 'recipients')) : [];
      if (ids.length < 1 || ids.length > CONNECTED_MESSAGE_LIMITS.maxRecipients || ids.some((id) => !id)
          || new Set(ids).size !== ids.length) throw invalid('recipients');
      const text = String(body ?? '').trim();
      if (!text || text.length > CONNECTED_MESSAGE_LIMITS.maxBody) throw invalid('body');
      const request = uuidOrNull(requestId, 'request_id');
      if (!request) throw invalid('request_id');
      const data = await perform(client, () => client.rpc("send_connected_workflow_message", {
        p_kind: ref.kind, p_id: ref.id, p_recipient_ids: ids, p_body: text, p_request_id: request, ...scopeArgs(ref),
      }), "send_connected_workflow_message");
      return {
        sent: Number(data.sent ?? 0),
        replayed: data.replayed === true,
        results: Array.isArray(data.results)
          ? data.results.map((result) => ({
            recipientId: result.recipientId, via: String(result.via ?? ''),
            messageId: result.messageId ?? null, replayed: result.replayed === true,
          }))
          : [],
      };
    },

    /** The caller's reminders, keyset paged by (remind_at, id). */
    async listReminders(cursor = null, { status = 'open', limit = 25 } = {}) {
      if (!CONNECTED_REMINDER_FILTERS.includes(status)) throw invalid('status');
      const data = await perform(client, () => client.rpc("list_connected_workflow_reminders", {
        p_cursor: cursorOf(cursor), p_limit: Math.min(Math.max(Number(limit) || 25, 1), 100), p_status: status,
      }), "list_connected_workflow_reminders");
      return normalizePage(data, normalizeReminder);
    },

    /** open (re-authorizes the source), snooze, complete or cancel a reminder. */
    async updateReminder(id, action, isoTime = null) {
      const reminderId = uuidOrNull(id, 'reminder');
      if (!reminderId) throw invalid('reminder');
      if (!CONNECTED_REMINDER_ACTIONS.includes(action)) throw invalid('action');
      const data = await perform(client, () => client.rpc("act_on_connected_workflow_reminder", {
        p_reminder_id: reminderId,
        p_action: action,
        p_remind_at: action === 'snooze' ? isoTimeOf(isoTime, 'remind_at') : null,
      }), "act_on_connected_workflow_reminder");
      const reminder = normalizeReminder(data.reminder);
      if (!reminder) throw new ConnectedWorkflowError('invalid_response', { reason: 'reminder' });
      return {
        reminder,
        available: data.available === true,
        href: data.available === true ? safeRoute(data.href) : null,
        replayed: data.replayed === true,
      };
    },

    /** Event staff only: assign (or clear with null) the explicit event organizer.
     * expectedVersion is the event version the editor opened; a stale one is
     * refused (REQ-UG-LEARNING-PERIOD-EVENTS-20261103). */
    async setEventOrganizer(eventId, organizerId, expectedVersion = null) {
      const common = { p_event_id: eventIdOf(eventId), p_organizer_id: uuidOrNull(organizerId, 'organizerId') };
      const versioned = Number.isInteger(expectedVersion) ? { ...common, p_expected_version: expectedVersion } : common;
      // Sent once, with the version (#8960); it takes one since 20261104110000.
      const data = await perform(client, () => client.rpc("set_member_event_organizer", versioned), "set_member_event_organizer");
      return { eventId: String(data.eventId ?? eventId), organizer: normalizePerson(data.organizer), changed: data.changed === true,
        version: Number.isInteger(data.version) ? data.version : null };
    },

    /** Event staff only: staff who could act as organizer, keyset paged. */
    async eventOrganizerCandidates(eventId, cursor = null) {
      const data = await perform(client, () => client.rpc("list_member_event_organizer_candidates", {
        p_event_id: eventIdOf(eventId), p_cursor: cursorOf(cursor), p_limit: 25,
      }), "list_member_event_organizer_candidates");
      return normalizePage(data, normalizePerson);
    },

    /**
     * The attendee's own consent to be contacted by ONE named organizer about this
     * event. Enabling requires the organizer id the attendee was shown
     * (`context.organizer.id` captured when the control rendered); the server
     * refuses with `organizer_changed` if staff changed the organizer since, so a
     * stale form can never grant a different person. Withdrawing needs no organizer.
     */
    async setEventContactOptIn(eventId, optIn, expectedOrganizerId = null) {
      if (typeof optIn !== 'boolean') throw invalid('opt_in');
      const expected = optIn ? uuidOrNull(expectedOrganizerId, 'expected_organizer') : null;
      if (optIn && !expected) throw invalid('expected_organizer');
      const data = await perform(client, () => client.rpc("set_member_event_contact_opt_in", {
        p_event_id: eventIdOf(eventId), p_opt_in: optIn, p_expected_organizer_id: expected,
      }), "set_member_event_contact_opt_in");
      return {
        eventId: String(data.eventId ?? eventId),
        contactOptIn: data.contactOptIn === true,
        changed: data.changed === true,
        organizerId: typeof data.organizerId === 'string' ? data.organizerId : null,
      };
    },

    /**
     * Event contact thread, newest first, read from the canonical private
     * message rows. `available:false` means source access, membership or consent
     * is gone: the caller must clear any history it holds.
     */
    async eventMessages(eventId, participantId = null, cursor = null) {
      const data = await perform(client, () => client.rpc("list_member_event_contact_messages", {
        p_event_id: eventIdOf(eventId), p_participant_id: uuidOrNull(participantId, 'participantId'),
        p_cursor: cursorOf(cursor), p_limit: 50,
      }), "list_member_event_contact_messages");
      if (data.available !== true) return { available: false, items: [], nextCursor: null };
      return { available: true, ...normalizePage(data, normalizeThreadMessage) };
    },
  };
  return Object.freeze(api);
}
