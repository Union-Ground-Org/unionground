import type { DemoChannel } from '../data/demoChannels';
import { buildMessageInbox, nativeInboxUnreadItemCount } from '../lib/messageInbox';
import { calendarDaysUntil, caseDeadlinePhraseEn, type CaseNextDeadline } from '../lib/whatMattersShared';

export type MemberProfile = {
  id: string;
  firstName: string;
  fullName: string;
  initials: string;
  roleLine: string;
  memberSince: number | null;
  chapterID: string | null;
  language: 'en' | 'es';
};

export type MemberNotification = {
  id: string;
  title: string;
  body: string;
  kind: string;
  readAt: string | null;
  createdAt: string;
  href?: string;
};

export type MemberCase = {
  id: string;
  ownerID?: string;
  reference: string;
  title: string;
  deadline: string | null;
  caseType: string;
  step: string;
  status: string;
  updatedAt: string;
  // The zone the issue's dates are counted in; New York's until a
  // group's own zone is delivered.
  timeZone?: string | null;
  // The procedure's name for `step` when `step` is one of its keys; absent for
  // free text.
  stepLabel?: string;
  // The date the issue runs to first; absent when it was not read.
  nextDeadline?: CaseNextDeadline | null;
};

export type MemberCaseUpdate = {
  id: string;
  caseID: string;
  body: string;
  createdAt: string;
};

export type MemberCaseDetail = {
  item: MemberCase;
  updates: MemberCaseUpdate[];
  deadlines?: { id: string; kind?: string; label: string; due_at: string; status: 'active' | 'met' | 'extended' | 'waived' | 'missed' }[];
  transitions?: { id: string; from_step: string; to_step: string; outcome: string | null; created_at: string }[];
  // The case procedure's step key -> label, for the current step and transitions.
  stepLabels?: ReadonlyMap<string, string>;
  // The outcome a coordinator recorded on the member's own case (#7195); null
  // until one is recorded or when the reader is not the case owner.
  outcome?: { outcome: string; summary: string; recorded_at: string; updated_at: string } | null;
};

export type MemberConversation = {
  id: string;
  ownerUserId?: string;
  counterpartRole?: 'steward';
  // Null for the general "Chapter steward" thread; set for a thread opened
  // from a selected steward's roster card.
  stewardUserId?: string | null;
  title: string;
  initials: string;
  createdAt: string;
  updatedAt: string;
  unreadCount: number;
  latestMessage: string | null;
};

export type MemberMessage = {
  reactions?: { kind: string; glyph: string; labelKey: string; count: number; mine: boolean }[];
  id: string;
  conversationID: string;
  senderKind: 'member' | 'steward';
  senderName: string;
  /** Empty string whenever `redactedAt` is set — the text no longer exists. */
  body: string;
  readAt: string | null;
  createdAt: string;
  // SEC-UG-MESSAGE-BODY-LIFECYCLE-20260904: a removed body is destroyed in
  // the database, so the phone receives a tombstone rather than hidden text and
  // renders the reason in the member's language.
  editedAt?: string | null;
  parentMessageID?: string | null;
  redactedAt?: string | null;
  redactionReason?: string | null;
};

/** The oldest message of a full newest-first page; earlier history is read strictly before it. */
export type MessageHistoryCursor = { createdAt: string; id: string };

export type MemberConversationThread = {
  conversation: MemberConversation;
  messages: MemberMessage[];
  readerIsStaff?: boolean;
  /** Set when the newest page was full, so earlier messages may exist. */
  earlierCursor?: MessageHistoryCursor | null;
};

export type MemberAction = {
  actionKey: string;
  actionKind: string;
  occurredAt: string;
};

export type MemberDashboard = {
  member: MemberProfile;
  notifications: MemberNotification[];
  cases: MemberCase[];
  conversations: MemberConversation[];
  weeklyActions: MemberAction[];
};

export type CompassMessage = {
  id: string;
  role: 'user' | 'assistant';
  body: string;
  sources?: CompassSource[];
};

export type CompassSource = {
  id: string;
  kind: string;
  title: string;
  ref: string;
  destination: CompassSourceDestination | null;
};

export type CompassSourceDestination =
  | `/feature/rights?source=${string}`
  | `/feature/chapter?source=${string}`;

export type CompassReply = {
  answer: string;
  sources: CompassSource[];
};

// BUG-UG-MOBILE-HOME-MESSAGES-METRIC-COUNTS-CONVERSATIONS-ONLY-20260915:
// `channels` is what the Messages tab badge already counts. Callers that have
// no channel list in hand keep the direct-thread arithmetic they always had.
export function dashboardMetrics(dashboard: MemberDashboard, channels: readonly DemoChannel[] = []) {
  return {
    unreadNotifications: dashboard.notifications.filter((item) => !item.readAt).length,
    openCases: dashboard.cases.filter((item) => item.status === 'active').length,
    // The total of unread direct messages. The preview Unread stat still adds
    // the channel total to it. It is not the Home Messages metric and must not
    // be published as an unlabelled "unread" count on the Work widget or the
    // reports card.
    unreadMessages: dashboard.conversations.reduce((sum, item) => sum + item.unreadCount, 0),
    // The Messages tab badge counts Unread-filter inbox items — direct threads
    // and chapter channels — through `nativeInboxUnreadItemCount`. Home's
    // Messages metric summed conversation.unreadCount only, so one inbox
    // reported two numbers to the same member. Anything that must agree with
    // the badge reads this field and passes the same channels the badge sees.
    unreadInboxItems: nativeInboxUnreadItemCount(dashboard.conversations, channels),
    completedThisWeek: Math.min(dashboard.weeklyActions.length, 5),
  };
}

export type MessagesWorkRow = {
  id: string;
  kind: 'direct' | 'channel';
  primary: string;
  accessibilityTitle?: string;
  secondary?: string;
  href: string;
};

// BUG-UG-MOBILE-WORK-WIDGET-UNREAD-DISAGREES-WITH-HOME-METRIC-20260918:
// Home's Messages metric is an inbox item count. The Work widget badge and
// row list, and the reports "Unread messages" card, read the same quantity
// and include chapter channels rather than restating conversation.unreadCount.
export function messagesWorkWidgetModel(
  dashboard: MemberDashboard,
  channels: readonly DemoChannel[] = [],
): { quantity: number; badge: string | undefined; rows: MessagesWorkRow[] } {
  const quantity = dashboardMetrics(dashboard, channels).unreadInboxItems;
  return {
    quantity,
    badge: quantity > 0 ? `${quantity} unread` : undefined,
    rows: buildMessageInbox(dashboard.conversations, channels).slice(0, 5).map((item) => {
      // The inbox's added # decorates a channel row, but these names may be
      // thread titles. Preserve the actual name (including any authored #).
      const primary = item.accessibilityTitle ?? item.title;
      const normalized = (text: string) => text.trim().replace(/\s+/g, ' ');
      return {
        id: item.key,
        kind: item.kind,
        primary,
        accessibilityTitle: item.accessibilityTitle,
        secondary: normalized(item.preview) === normalized(primary) ? undefined : item.preview,
        href: item.kind === 'channel' ? `/channel/${item.id}` : `/conversation/${item.id}`,
      };
    }),
  };
}

export function reportsUnreadMessagesCard(
  dashboard: MemberDashboard,
  channels: readonly DemoChannel[] = [],
): { label: string; value: string } {
  return {
    label: 'Unread messages',
    value: String(dashboardMetrics(dashboard, channels).unreadInboxItems),
  };
}

export function initialsForName(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase() ?? '')
    .join('');
}

// A case runs to its first open deadline: a step deadline before its own.
function firstDue(item: MemberCase): string | null {
  return item.nextDeadline?.kind === 'step' ? item.nextDeadline.dueOn : item.deadline;
}

function compareCaseDeadlines(left: MemberCase, right: MemberCase): number {
  const leftDue = firstDue(left);
  const rightDue = firstDue(right);
  if (leftDue && !rightDue) return -1;
  if (!leftDue && rightDue) return 1;
  const leftDeadline = leftDue ? Date.parse(`${leftDue}T12:00:00Z`) : Number.POSITIVE_INFINITY;
  const rightDeadline = rightDue ? Date.parse(`${rightDue}T12:00:00Z`) : Number.POSITIVE_INFINITY;
  const deadlineDelta = leftDeadline - rightDeadline;
  if (Number.isFinite(deadlineDelta) && deadlineDelta !== 0) return deadlineDelta;
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
}

export function nextActiveCase(cases: MemberCase[]): MemberCase | null {
  const active = cases.filter((item) => item.status.toLowerCase() === 'active');
  active.sort(compareCaseDeadlines);
  return active[0] ?? null;
}

// REQ-UG-LOVABLE-AUDIT-NATIVE-FIXES-BALLOT-FIRST-20261103 (audit
// MOB-STEWARD-04): My cases listed cases in load order, so a case due Aug 20
// could sit above one due Aug 18. The list follows the same deadline order as
// Home's next case, and the due date carries its year.
export function casesByDeadline(cases: readonly MemberCase[]): MemberCase[] {
  // Active cases lead, as on Home; deadline order applies inside each group,
  // so a closed case with an old date never sits above open work (#7001 gate
  // round 1, r1g2).
  const active = (item: MemberCase) => item.status.toLowerCase() === 'active';
  return [...cases].sort((left, right) => Number(active(right)) - Number(active(left)) || compareCaseDeadlines(left, right));
}

// My cases: an open step deadline before the case's own deadline is the date
// shown, labeled in the words staff What to do next uses (a missed one reads
// as passed); otherwise the case's own due date, as before.
export function caseDueLine(item: Pick<MemberCase, 'deadline' | 'nextDeadline'>, now: Date): string | null {
  const next = item.nextDeadline;
  if (next?.kind === 'step') return caseDeadlinePhraseEn({ kind: 'step', label: next.label, days: calendarDaysUntil(next.dueOn, now, next.timeZone), dueOn: next.dueOn });
  return caseDueLabel(item.deadline);
}

export function caseDueLabel(deadline: string | null): string | null {
  if (!deadline || !/^\d{4}-\d{2}-\d{2}$/.test(deadline)) return deadline ? `Due ${deadline}` : null;
  const date = new Date(`${deadline}T12:00:00Z`);
  if (!Number.isFinite(date.getTime())) return `Due ${deadline}`;
  return `Due ${new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(date)}`;
}
