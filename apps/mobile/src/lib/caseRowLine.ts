// REQ-UG-NEUTRAL-NOTIFICATION-AND-CASE-ROWS-SERVER-COPY-20261104 (#7015):
// a case list row names the case by reference, type and step, never by its
// topic; the topic stays on the case screen. Same line as the server's
// private.case_row_line, which the case list RPCs already send as `title`.
export function caseRowLine(caseType: unknown, step: unknown): string {
  const type = typeof caseType === 'string' ? caseType.trim() : '';
  const stepLabel = typeof step === 'string' ? step.trim() : '';
  return stepLabel ? `${type || 'Issue'} · ${stepLabel}` : type || 'Issue';
}

// REQ-UG-LIST-ROW-DETAIL-TOGGLE-CHAPTER-AND-STEWARD-20261104 (#7043):
// the chapter's leadership or a case's own steward can show the topic in rows.
// Rows the app reads straight from member_cases ask the server for their names
// (list_case_row_titles); the list RPCs already send them as `title`. A
// malformed or failed answer leaves the row on its neutral line.
export function caseRowTitleMap(value: unknown): Map<string, string> {
  const titles = new Map<string, string>();
  if (!Array.isArray(value)) return titles;
  const items: unknown[] = value;
  for (const item of items) {
    const row = item && typeof item === 'object' && !Array.isArray(item) ? item as Record<string, unknown> : {};
    if (typeof row.id === 'string' && typeof row.title === 'string' && row.title.trim()) titles.set(row.id, row.title);
  }
  return titles;
}

export function caseRowIDs(rows: unknown): string[] {
  if (!Array.isArray(rows)) return [];
  const items: unknown[] = rows;
  return items.flatMap((item) => {
    const id = item && typeof item === 'object' ? (item as { id?: unknown }).id : undefined;
    return typeof id === 'string' && id ? [id] : [];
  });
}

export type CaseRowTitlesRequest = (caseIDs: string[]) => PromiseLike<{ data: unknown; error: unknown }>;

// `request` sends list_case_row_titles for the given ids, e.g.
// (ids) => client.rpc('list_case_row_titles', { p_case_ids: ids }).
export async function loadCaseRowTitles(request: CaseRowTitlesRequest, caseIDs: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(caseIDs.filter(Boolean))].slice(0, 200);
  if (!ids.length) return new Map();
  try {
    const { data, error } = await request(ids);
    return error ? new Map() : caseRowTitleMap(data);
  } catch {
    return new Map();
  }
}

// A11Y-UG-NATIVE-STAFF-CASE-QUEUE-ROWS-SPEAK-ONLY-THE-REFERENCE-20261109:
// a row that opens a case is named by what it shows, not "Open <reference>"
// alone. The visible reference comes first, so the spoken name contains the
// visible one, then the row's other visible parts in reading order (status,
// case line, updated time). Blank parts are skipped.
export function caseRowAccessibilityLabel(reference: string, visible: readonly (string | null | undefined)[]): string {
  return [reference, ...visible].map((part) => (part ?? '').trim()).filter(Boolean).join(', ');
}

export const CASE_ROW_ACCESSIBILITY_HINT = 'Opens the issue.';
