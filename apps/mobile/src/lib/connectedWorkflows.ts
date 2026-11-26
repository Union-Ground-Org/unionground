import type { Session } from '@supabase/supabase-js';
// Native adapter over the shared connected-workflow facade
// (src/features/connectedWorkflows/api.js and actions.js). One typed seam so
// components never reach into the shared JavaScript directly and never invent
// a call the facade does not expose: mutations throw, reads return the
// normalized shapes below, and `ref = {kind, id, organizationId?, chapterId?}`
// carries scope assertions only — never authority and never a hat change.

import { explicitLiveStaffHat } from './hatFunctions';
import { captureSessionWriter, getSupabaseClient } from '../services/supabase';
import {
  connectedRecordActions,
  connectedReminderActions,
  retainAuthorizedRecipients,
} from '../../../../src/features/connectedWorkflows/actions.js';
import {
  CONNECTED_MESSAGE_LIMITS,
  ConnectedWorkflowError,
  createConnectedWorkflowApi,
  isSafeInAppRoute,
  newConnectedRequestId,
} from '../../../../src/features/connectedWorkflows/api.js';

export type ConnectedSourceKind =
  | 'private_message'
  | 'channel_post'
  | 'task_message'
  | 'task'
  | 'event';

export type ConnectedSourceRef = {
  kind: ConnectedSourceKind;
  id: string;
  organizationId?: string | null;
  chapterId?: string | null;
};

export type ConnectedPerson = { id: string; label: string };

// Only the fields native surfaces read; the facade returns the full task row.
export type ConnectedLinkedTask = {
  id: string;
  title: string;
  status: string;
  dueDate?: string | null;
  href?: string | null;
  taskKey?: string | null;
};

export type ConnectedWorkflowContext = {
  available: boolean;
  reason: string | null;
  reference: ConnectedSourceRef;
  state: string;
  href: string | null;
  canMessage: boolean;
  canRemind: boolean;
  canCreateTask: boolean;
  reasons: { message: string | null; remind: string | null; task: string | null };
  linkedTask: ConnectedLinkedTask | null;
  discussionHref: string | null;
  sourceLinks: { reference: ConnectedSourceRef; label: string }[];
  timezone: { basis: string; startsAt: string | null; eventZone: string | null } | null;
  cancelled: boolean;
  organizer: ConnectedPerson | null;
  contactOptIn: boolean;
  canManageOrganizer: boolean;
  // The event's version for an organizer change (staff only, else null).
  eventVersion: number | null;
  canContactOptIn: boolean;
  contactRole: 'organizer' | 'participant' | null;
};

export type ConnectedReminderStatus =
  | 'scheduled' | 'delivered' | 'completed' | 'cancelled' | 'failed' | 'pending';

export type ConnectedReminder = {
  id: string;
  kind: string;
  sourceId: string | null;
  remindAt: string;
  note: string;
  status: ConnectedReminderStatus;
  snoozeCount: number;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  available: boolean;
  sourceState: string;
  href: string | null;
  title: string | null;
};

export type ConnectedRecipientPage = {
  status: 'available' | 'unavailable';
  reason: string | null;
  items: ConnectedPerson[];
  nextCursor: string | null;
};

export type ConnectedEventMessage = {
  id: string;
  mine: boolean;
  senderRole: 'organizer' | 'participant';
  body: string;
  redacted: boolean;
  createdAt: string;
};

export type ConnectedEventMessagePage = {
  available: boolean;
  items: ConnectedEventMessage[];
  nextCursor: string | null;
};

export type ConnectedPage<T> = { items: T[]; nextCursor: string | null };

export type ConnectedTaskResult = {
  task: ConnectedLinkedTask & Record<string, unknown>;
  attachment: { id: string; taskId: string; sourceKind: string | null; sourceId: string | null } | null;
  created: boolean;
  taskKey: string | null;
  href: string | null;
};

export type ConnectedSendResult = {
  sent: number;
  replayed: boolean;
  results: { recipientId: string; via: string; messageId: string | null; replayed: boolean }[];
};

export type ConnectedReminderAction = 'open' | 'snooze' | 'complete' | 'cancel';

export type ConnectedReminderActionResult = {
  reminder: ConnectedReminder;
  available: boolean;
  href: string | null;
  replayed: boolean;
};

export type ConnectedActionChoice = { id: string; label: string };

export type ConnectedWorkflowErrorCode = string;

export type ConnectedWorkflowApi = {
  context: (reference: ConnectedSourceRef) => Promise<ConnectedWorkflowContext>;
  recipients: (reference: ConnectedSourceRef, cursor?: string | null) => Promise<ConnectedRecipientPage>;
  createTask: (reference: ConnectedSourceRef) => Promise<ConnectedTaskResult>;
  remind: (reference: ConnectedSourceRef, isoTime: string, note?: string) =>
    Promise<{ reminder: ConnectedReminder; created: boolean; coalesced: boolean }>;
  send: (reference: ConnectedSourceRef, recipientIds: string[], body: string, requestId: string) =>
    Promise<ConnectedSendResult>;
  listReminders: (cursor?: string | null, options?: { status?: string; limit?: number }) =>
    Promise<ConnectedPage<ConnectedReminder>>;
  updateReminder: (id: string, action: ConnectedReminderAction, isoTime?: string | null) =>
    Promise<ConnectedReminderActionResult>;
  // expectedVersion is the event version the editor opened; a stale one is refused.
  setEventOrganizer: (eventId: string, organizerId: string | null, expectedVersion?: number | null) =>
    Promise<{ eventId: string; organizer: ConnectedPerson | null; changed: boolean; version: number | null }>;
  eventOrganizerCandidates: (eventId: string, cursor?: string | null) => Promise<ConnectedPage<ConnectedPerson>>;
  // expectedOrganizerId is the organizer the checkbox form was opened under;
  // the server rejects the write when a different organizer was chosen since.
  // Null means "no organizer was shown".
  setEventContactOptIn: (eventId: string, optIn: boolean, expectedOrganizerId: string | null) =>
    Promise<{ eventId: string; contactOptIn: boolean; changed: boolean }>;
  eventMessages: (eventId: string, participantId: string | null, cursor?: string | null) =>
    Promise<ConnectedEventMessagePage>;
};

// The facade is plain JavaScript, so its inferred types are wider than the
// normalized contract the server guarantees. The single cast below is the only
// place native code trusts that normalization; every component then sees the
// precise shapes above.
// One facade per composing Session object; the read-only facade is stable
// per shared client. Omitted identity never enables a mutable-client writer.
const readFacadeByClient = new WeakMap<object, ConnectedWorkflowApi>();
const facadeBySession = new WeakMap<Session, ConnectedWorkflowApi>();
const readMethods = new Set(['context', 'recipients', 'listReminders', 'eventOrganizerCandidates', 'eventMessages']);

export function connectedWorkflowApi(session?: Session | null): ConnectedWorkflowApi | null {
  const client = getSupabaseClient();
  if (!client) return null;
  if (session && facadeBySession.has(session)) return facadeBySession.get(session)!;
  if (!session && readFacadeByClient.has(client)) return readFacadeByClient.get(client)!;
  const writer = session ? captureSessionWriter(session) : null;
  const readers = createConnectedWorkflowApi(client) as ConnectedWorkflowApi;
  const writers = createConnectedWorkflowApi({
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (!writer) throw new Error('A composing session is required.');
      return (await writer.client()).rpc(name, args);
    },
  }) as ConnectedWorkflowApi;
  // Omitted session allows reads only. Never a shared-client write fallback.
  const facade = Object.fromEntries(Object.keys(readers).map((name) => [name,
    readMethods.has(name) ? readers[name as keyof ConnectedWorkflowApi] : writers[name as keyof ConnectedWorkflowApi],
  ])) as ConnectedWorkflowApi;
  if (session) facadeBySession.set(session, facade);
  else readFacadeByClient.set(client, facade);
  return facade;
}

export function recordActions(
  context: ConnectedWorkflowContext | null | undefined,
  options: { staffAccess?: boolean } = {},
): ConnectedActionChoice[] {
  return connectedRecordActions(context, options) as ConnectedActionChoice[];
}

export function reminderActions(
  reminder: Pick<ConnectedReminder, 'id' | 'status'> | null | undefined,
): ConnectedActionChoice[] {
  return connectedReminderActions(reminder) as ConnectedActionChoice[];
}

export function retainRecipients(
  selectedIds: readonly string[] | null | undefined,
  recipients: readonly ConnectedPerson[] | null | undefined,
): string[] {
  return retainAuthorizedRecipients(selectedIds, recipients);
}

// Staff shortcuts exist only under an explicitly authorized staff identity:
// the single explicitly held live staff role for an authenticated session, or
// the explicit preview hat. Nothing here selects or changes a hat, and the
// server rechecks the grant on every call.
export function connectedStaffAccess(input: {
  mode: string | null | undefined;
  authorizedRoles?: readonly string[] | null;
  previewHat?: string | null;
}): boolean {
  if (input.mode === 'authenticated') return explicitLiveStaffHat(input.authorizedRoles ?? []) !== null;
  if (input.mode === 'preview') return input.previewHat !== null && input.previewHat !== undefined && input.previewHat !== 'member';
  return false;
}

export {
  CONNECTED_MESSAGE_LIMITS,
  ConnectedWorkflowError,
  isSafeInAppRoute,
  newConnectedRequestId,
};
