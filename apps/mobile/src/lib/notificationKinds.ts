// REQ-UNION-BASE-MOBILE-MEMBER-PARITY-20260814, findings F1 and F2 (lane
// ANDROID6, 2026-09-26): the Activity screen filtered on the PREVIEW kind
// vocabulary (case / message / vote) while the live producer stores
// member_notifications.kind from the check constraint below, so on SAMPLE the
// Votes filter read "No votes updates right now" with vote rows present and
// "Case deadline approaching" (kind deadlines) never matched Cases; and live
// rows carried no destination, so opening a notification never reached the
// protected screen it was about. One vocabulary lives here: both the preview
// and the live kinds map onto the Activity filter families, the glyph roles
// and a kind-based destination. No protected content is copied into the
// notification; the destination screens keep their own reauthorization.

// member_notifications_kind_check as of
// supabase/migrations/20260831110100_mi1_dues_ledger_mutations.sql.
export type LiveNotificationKind =
  | 'general' | 'deadlines' | 'cases' | 'forms' | 'votes' | 'events' | 'tasks' | 'appointments' | 'workload' | 'dues';
export const LIVE_NOTIFICATION_KINDS: readonly LiveNotificationKind[] = [
  'general', 'deadlines', 'cases', 'forms', 'votes', 'events', 'tasks', 'appointments', 'workload', 'dues',
];

// The seeded preview rows (src/data/preview.ts) speak the singular forms.
export type PreviewNotificationKind =
  | 'vote' | 'case' | 'rights' | 'message' | 'chapter' | 'appointment' | 'form' | 'report' | 'admin';
export const PREVIEW_NOTIFICATION_KINDS: readonly PreviewNotificationKind[] = [
  'vote', 'case', 'rights', 'message', 'chapter', 'appointment', 'form', 'report', 'admin',
];

export type NotificationKindFamily = 'cases' | 'messages' | 'votes' | 'other';

export function notificationKindFamily(kind: string): NotificationKindFamily {
  switch (kind) {
    case 'case':
    case 'cases':
    case 'deadlines':
      return 'cases';
    case 'message':
    case 'messages':
      return 'messages';
    case 'vote':
    case 'votes':
      return 'votes';
    default:
      return 'other';
  }
}

// The glyph role the Activity screen draws for a kind. Live kinds fold onto
// the preview roles so the icon vocabulary (and its contrast-checked tints)
// stays one set.
export type NotificationGlyphRole =
  | 'vote' | 'case' | 'rights' | 'message' | 'chapter' | 'appointment' | 'form' | 'report' | 'admin' | 'general';

export function notificationGlyphRole(kind: string): NotificationGlyphRole {
  switch (kind) {
    case 'vote': case 'votes': return 'vote';
    case 'case': case 'cases': case 'deadlines': case 'tasks': case 'workload': return 'case';
    case 'message': case 'messages': return 'message';
    case 'chapter': case 'events': return 'chapter';
    case 'appointment': case 'appointments': return 'appointment';
    case 'form': case 'forms': return 'form';
    case 'report': case 'dues': return 'report';
    case 'rights': return 'rights';
    case 'admin': return 'admin';
    default: return 'general';
  }
}

// Where a LIVE notification of this kind opens. Live rows carry no target
// column (member_notifications: id, user_id, title, body, kind, read_at,
// created_at), so the destination is the feature the kind belongs to; a
// per-row target reference is a separate record if wanted. A null keeps the
// row text-only, as before. Preview rows carry their own explicit href and do
// not pass through here.
//
// BUG-UG-PRIVATE-TWO-PERSON-MESSAGES-SEND-NO-NOTIFICATION-20261118
// (#9173): a private two-person message notice (copy_key 'peer.message') is
// the one live row with a target: peer_conversation_id, the recipient's own
// conversation. It opens that conversation's screen, which reads the member's
// own list and shows "Conversation unavailable" for one it does not list, so
// the notice opens nothing the Messages list would not. A notice without a
// well-formed id opens Messages, as every other message notice does.
export const PEER_MESSAGE_COPY_KEY = 'peer.message';
const conversationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The conversation a notice announces, or null when it is not a peer message
// notice or its id is not a well-formed conversation id.
export function peerNoticeConversation(copyKey?: string | null, peerConversationID?: string | null): string | null {
  if (copyKey !== PEER_MESSAGE_COPY_KEY) return null;
  return typeof peerConversationID === 'string' && conversationIdPattern.test(peerConversationID) ? peerConversationID.toLowerCase() : null;
}

export function notificationDestination(kind: string, copyKey?: string | null, peerConversationID?: string | null): string | null {
  const peerConversation = peerNoticeConversation(copyKey, peerConversationID);
  if (peerConversation) return `/peer-conversation/${peerConversation}`;
  // A task message has no task id on its row, so it opens the Messages tab,
  // whose Task discussions section lists the person's task threads
  // (BUG-UG-NATIVE-CASE-ROWS-AND-TASK-TITLES-DO-NOT-OPEN-20261111).
  // show=tasks clears the tab's filter and search, so no old filter hides
  // the discussion.
  if (kind === 'tasks' && copyKey === 'task.message') return '/messages?show=tasks';
  switch (notificationKindFamily(kind)) {
    case 'cases': return '/work';
    case 'messages': return '/messages';
    case 'votes': return '/feature/voting';
    default: break;
  }
  switch (kind) {
    case 'appointments': return '/feature/appointments';
    // The inert schema still allows kind 'dues', but Union Ground has no
    // dues screen, so such a row stays text-only instead of opening a route
    // that does not exist.
    case 'forms':
    case 'tasks':
    case 'workload':
      return '/work';
    default:
      return null;
  }
}
