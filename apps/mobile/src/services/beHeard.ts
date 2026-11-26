import type { MobileSessionWriter } from './supabase';
// Be heard for the native apps
// (BUG-UG-NATIVE-SEVEN-FEATURE-KEYS-OPEN-ONLY-THE-GENERIC-SCREEN-20261113,
//): a member sends a report to their chapter and sees the ones they
// sent. It writes the same three columns the web "Report or ask" form writes
// (createMemberIntake in src/lib/memberApi.js), the only columns members may
// insert. The database stamps the reporter and the current chapter, checks
// them in member_intake_reports_create, and refuses a restricted PIN session.
import { getSupabaseClient } from './supabase';

export type BeHeardCategory = 'workplace_issue' | 'safety' | 'question' | 'app_feedback' | 'other';
export const BE_HEARD_CATEGORIES: readonly { key: BeHeardCategory; label: string }[] = [
  { key: 'workplace_issue', label: 'Workplace issue' },
  { key: 'safety', label: 'Safety' },
  { key: 'question', label: 'Question' },
  { key: 'app_feedback', label: 'App feedback' },
  { key: 'other', label: 'Other' },
];

// The table's own bounds (member_intake_reports_title_bounded and
// _details_bounded); the screen keeps a message well inside them.
export const BE_HEARD_TITLE_MAX = 160;
export const BE_HEARD_DETAILS_MAX = 2000;
export const BE_HEARD_DETAILS_MIN = 8;
export const BE_HEARD_SENT_LIMIT = 50;

const STATUS_LABELS: Record<string, string> = { new: 'Sent', triaged: 'Read by a committee member', in_progress: 'In progress', closed: 'Closed' };

export type BeHeardReport = {
  id: string;
  category: string;
  title: string;
  status: string;
  createdAt: string;
};

export function beHeardCategoryLabel(category: string): string {
  return BE_HEARD_CATEGORIES.find((item) => item.key === category)?.label ?? 'Other';
}

export function beHeardStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? 'Sent';
}

export type BeHeardDraft = { category: BeHeardCategory | null; title: string; details: string };

// What still stands between a draft and Send, or null when it can be sent.
export function beHeardDraftProblem(draft: BeHeardDraft): string | null {
  if (draft.category === null) return 'Choose a topic.';
  if (!draft.title.trim()) return 'Add a short title.';
  if (draft.details.trim().length < BE_HEARD_DETAILS_MIN) return `Write at least ${BE_HEARD_DETAILS_MIN} characters.`;
  return null;
}

function client() {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  return supabase;
}

// Stewards and coordinators can read their chapter's reports too, so the list
// asks for the member's own by their user id.
export async function loadMyBeHeardReports(userID: string): Promise<BeHeardReport[]> {
  if (!userID) return [];
  const { data, error } = await client().from('member_intake_reports')
    .select('id,category,title,status,created_at')
    .eq('reporter_id', userID)
    .order('created_at', { ascending: false })
    .limit(BE_HEARD_SENT_LIMIT);
  if (error) throw error;
  return (Array.isArray(data) ? data : []).map((row: Record<string, unknown>) => ({
    id: String(row.id),
    category: String(row.category ?? 'other'),
    title: String(row.title ?? ''),
    status: String(row.status ?? 'new'),
    createdAt: String(row.created_at ?? ''),
  }));
}

export async function sendBeHeardReport(writer: MobileSessionWriter, draft: BeHeardDraft): Promise<void> {
  if (beHeardDraftProblem(draft) !== null || draft.category === null) throw new Error('The report is not complete.');
  const { error, status } = await (await writer.client()).from('member_intake_reports').insert({
    category: draft.category,
    title: draft.title.trim().slice(0, BE_HEARD_TITLE_MAX),
    details: draft.details.trim().slice(0, BE_HEARD_DETAILS_MAX),
  });
  if (error) throw new Error(beHeardSendFailureText(error, status));
}

export const BE_HEARD_SEND_FAILED_CONNECTION = 'Your report was not sent. Check your connection and try again.';
export const BE_HEARD_SEND_REFUSED = 'Union Ground did not accept your report, so it was not sent. Try again later, or tell a committee member in person.';

// UX-UG-WORDING-AND-SPANISH-GAPS-FROM-REVIEWS-20261117 (
// 167, from the  review): every refused send used to blame the
// connection. A request that never reached the server answers with no HTTP
// status and no PostgREST code; a refusal by the server (a policy, a check, a
// missing function) carries one, and is not fixed by a better connection.
export function beHeardSendFailureText(error: { code?: unknown } | null | undefined, status?: number | null): string {
  const code = typeof error?.code === 'string' ? error.code : '';
  const answered = typeof status === 'number' && status > 0;
  return answered || code !== '' ? BE_HEARD_SEND_REFUSED : BE_HEARD_SEND_FAILED_CONNECTION;
}
