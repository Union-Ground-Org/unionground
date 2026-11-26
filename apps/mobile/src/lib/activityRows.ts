import type { MemberNotification } from '../models/member';
import { nativeUiText, type NativeLanguage, type NativeUiKey, type NativeUiText } from './nativeUiCopy';

const systemNotices: readonly (readonly [string, NativeUiKey, NativeUiKey])[] = [
  ['appointments', 'One-on-one coming up', 'You have a one-on-one within the next day. Open One-on-ones for the details.'],
  ['appointments', 'One-on-one soon', 'Your one-on-one starts within the hour. Open One-on-ones for the details.'],
  ['messages', 'New message', 'You have a new message in Union Ground.'],
  ['messages', 'New private message', 'Someone wrote to you in a private conversation. Open Messages to read it.'],
  ['votes', 'Votes is open', 'A new vote is open for your vote. Open Voice to cast it.'],
  ['votes', 'Votes closes soon', 'A vote you can vote in closes within a day. Open Voice to cast your vote.'],
  ['votes', 'Vote results are in', 'Results are available for a recent vote. Open Voice to see them.'],
];

const formApproved = ' — reviewed and approved by the committee. Your Union Base official filing copy is ready to download.';
const formNote = " Open Forms to read the committee's note.";
const formReturned = ' — returned by the committee for changes. Open Forms to read the note.';
const formNotices: readonly (readonly [NativeUiKey, typeof formApproved | typeof formReturned, boolean])[] = [
  ['Form approved', formApproved, true],
  ['Form returned', formReturned, false],
];

/** Translate known stored templates after grouping, preserving identifiers and authored copy. */
export function localizeActivityRow(row: ActivityRow, language: NativeLanguage): ActivityRow {
  if (language === 'en') return row;
  const t = nativeUiText(language);
  const known = systemNotices.find(([kind, title, body]) => row.kind === kind && row.title === title && row.body === body);
  if (known) return { ...row, title: t(known[1]), body: t(known[2]) };
  if (row.kind !== 'forms') return row;
  for (const [title, suffix, allowsNote] of formNotices) {
    if (row.title !== title) continue;
    const hasNote = allowsNote && row.body.endsWith(formNote);
    const ending = hasNote ? suffix + formNote : suffix;
    if (row.body.endsWith(ending) && row.body.length > ending.length) {
      const name = row.body.slice(0, -ending.length);
      return { ...row, title: t(title), body: name + t(suffix) + (hasNote ? t(formNote) : '') };
    }
  }
  return row;
}

export type ActivityRow = MemberNotification & {
  notificationIDs: string[];
  oldestCreatedAt: string;
};

// Ballot notices deliberately contain generic copy. Different events can
// therefore look identical even with correct, distinct database IDs. Present
// identical notices once, retaining their count, dates and every read target.
// Read and unread remain separate so grouping never changes unread state.
export function activityRows(notifications: readonly MemberNotification[]): ActivityRow[] {
  const rows = new Map<string, ActivityRow>();
  const seen = new Set<string>();
  for (const item of notifications) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const key = JSON.stringify([item.kind, item.title, item.body, item.href ?? null, Boolean(item.readAt)]);
    const row = rows.get(key);
    if (!row) {
      rows.set(key, { ...item, notificationIDs: [item.id], oldestCreatedAt: item.createdAt });
      continue;
    }
    row.notificationIDs.push(item.id);
    if (Date.parse(item.createdAt) < Date.parse(row.oldestCreatedAt)) row.oldestCreatedAt = item.createdAt;
    if (Date.parse(item.createdAt) > Date.parse(row.createdAt)) row.createdAt = item.createdAt;
  }
  return [...rows.values()].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
}

export function activityRowSummary(row: ActivityRow, t: NativeUiText, formatDate: (value: string, includeYear?: boolean) => string): string {
  if (row.notificationIDs.length === 1) return formatDate(row.createdAt);
  const includeYear = new Date(row.oldestCreatedAt).getFullYear() !== new Date(row.createdAt).getFullYear();
  const newest = formatDate(row.createdAt, includeYear);
  const oldest = formatDate(row.oldestCreatedAt, includeYear);
  const dates = oldest === newest ? newest : `${oldest} – ${newest}`;
  return t('{count} updates · {dates}', { count: row.notificationIDs.length, dates });
}
