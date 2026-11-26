// The chapter's casework for the steward desk (Casework) and the coordinator
// desk (Case queue) on the native apps
// (BUG-UG-NATIVE-SEVEN-FEATURE-KEYS-OPEN-ONLY-THE-GENERIC-SCREEN-20261113,
// #8630). It keeps the guarantees of the read the generic evidence screen used:
// only the selected chapter's member_cases, refused without a chapter
// (UX-UG-LIVE-MOBILE-CASEWORK-DESK-SAYS-RECORDS-SELECTED-CHAPTER-READS-MEMBER-20260921),
// rows named by type and step unless the server says a topic may show (#7015,
// #7043). The coordinator also reads the open step deadlines on those cases,
// the same rows My cases and the web Case queue rank on.
import { caseRowIDs, caseRowLine, loadCaseRowTitles } from '../lib/caseRowLine';
import { evidenceUpdatedMeta } from '../lib/evidenceTimestamp';
import { OPEN_STEP_DEADLINE_STATUSES } from '../lib/whatMattersShared';
import { getSupabaseClient, readStepDeadlinePages } from './supabase';

export const CHAPTER_CASE_LIMIT = 100;
// The coordinator's Case queue reads every active case of the chapter, page by
// page, whatever its age (ledger 173): the newest 100 cases of every status
// left older active cases, and their open deadlines, out of the queue.
export const CHAPTER_ACTIVE_CASE_PAGE = 500;
const CHAPTER_ACTIVE_CASE_MAX_PAGES = 20;
// Case ids per deadline request, so a long active list stays one short query
// string per request.
export const CHAPTER_DEADLINE_CASE_CHUNK = 100;
// list_case_row_titles names at most this many cases per call (loadCaseRowTitles).
const CASE_TITLE_CHUNK = 200;

export type ChapterCaseRow = {
  id: string;
  reference: string;
  title: string;
  status: string;
  meta: string;
};

// capped: the read stopped at its last page with that page full, so the
// chapter may have more active cases than rows (ledger 472).
export type ChapterActiveCases = { rows: ChapterCaseRow[]; capped: boolean };

export type ChapterCaseDeadline = {
  id: string;
  caseID: string;
  label: string;
  dueAt: string;
  status: string;
  timeZone: string | null;
};

function client() {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('The secure mobile backend is not configured.');
  return supabase;
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

async function caseRows(supabase: ReturnType<typeof client>, rows: Record<string, unknown>[]): Promise<ChapterCaseRow[]> {
  const titles = new Map<string, string>();
  for (const ids of chunks(caseRowIDs(rows), CASE_TITLE_CHUNK)) {
    for (const [id, title] of await loadCaseRowTitles((request) => supabase.rpc('list_case_row_titles', { p_case_ids: request }), ids)) titles.set(id, title);
  }
  return rows.map((row) => ({
    id: String(row.id),
    reference: String(row.reference ?? ''),
    title: titles.get(String(row.id)) ?? caseRowLine(row.case_type, row.step),
    status: String(row.status ?? ''),
    meta: evidenceUpdatedMeta(row.updated_at),
  }));
}

export async function loadChapterActiveCases(chapterID: string | null | undefined): Promise<ChapterActiveCases> {
  if (!chapterID) throw new Error('Select a campaign before loading issue work.');
  const supabase = client();
  const rows: Record<string, unknown>[] = [];
  const listed = new Set<string>();
  // Ledger 473: each page starts after the previous page's last row on the
  // (updated_at desc, id asc) keyset, not at an offset, so a case that changes
  // between pages does not shift the rest; a case already listed stays listed once.
  let after: { updatedAt: string; id: string } | null = null;
  let capped = false;
  for (let page = 0; page < CHAPTER_ACTIVE_CASE_MAX_PAGES; page += 1) {
    let query = supabase.from('member_cases')
      .select('id,reference,case_type,step,status,updated_at')
      .eq('chapter_id', chapterID)
      .eq('status', 'active');
    if (after) {
      const at = JSON.stringify(after.updatedAt);
      query = query.or(`updated_at.lt.${at},and(updated_at.eq.${at},id.gt.${JSON.stringify(after.id)})`);
    }
    const result: { data: unknown; error: unknown } = await query
      .order('updated_at', { ascending: false })
      .order('id', { ascending: true })
      .limit(CHAPTER_ACTIVE_CASE_PAGE);
    if (result.error) throw result.error;
    const pageRows = Array.isArray(result.data) ? result.data as Record<string, unknown>[] : [];
    for (const row of pageRows) {
      const id = String(row.id);
      if (listed.has(id)) continue;
      listed.add(id);
      rows.push(row);
    }
    if (pageRows.length < CHAPTER_ACTIVE_CASE_PAGE) break;
    if (page === CHAPTER_ACTIVE_CASE_MAX_PAGES - 1) capped = true;
    const last = pageRows[pageRows.length - 1];
    if (!last || typeof last.updated_at !== 'string' || !last.id) break;
    after = { updatedAt: last.updated_at, id: String(last.id) };
  }
  return { rows: await caseRows(supabase, rows), capped };
}

export async function loadChapterCases(chapterID: string | null | undefined): Promise<ChapterCaseRow[]> {
  if (!chapterID) throw new Error('Select a campaign before loading issue work.');
  const supabase = client();
  const result: { data: unknown; error: unknown } = await supabase.from('member_cases')
    .select('id,reference,case_type,step,status,updated_at')
    .eq('chapter_id', chapterID)
    .order('updated_at', { ascending: false })
    .limit(CHAPTER_CASE_LIMIT);
  if (result.error) throw result.error;
  const rows = Array.isArray(result.data) ? result.data as Record<string, unknown>[] : [];
  return caseRows(supabase, rows);
}

// Soft, like My cases: a failed read leaves the queue without deadlines rather
// than failing it, and the screen says the deadlines did not load.
export async function loadChapterCaseDeadlines(caseIDs: readonly string[]): Promise<ChapterCaseDeadline[] | null> {
  const ids = [...new Set(caseIDs.filter(Boolean))];
  if (!ids.length) return [];
  const supabase = client();
  let failed = false;
  // readStepDeadlinePages answers any failed page with no rows; the flag keeps
  // "did not load" apart from "none open".
  const rows = (await Promise.all(chunks(ids, CHAPTER_DEADLINE_CASE_CHUNK).map((chunk) => readStepDeadlinePages(async (from, to) => {
    try {
      const page: { data: unknown; error: unknown } = await supabase.from('casework_deadlines')
        .select('case_id,id,label,due_at,status,time_zone')
        .in('case_id', chunk)
        .in('status', [...OPEN_STEP_DEADLINE_STATUSES])
        .order('due_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to);
      if (page.error || !Array.isArray(page.data)) failed = true;
      return page;
    } catch (error) {
      failed = true;
      throw error;
    }
  })))).flat()
    // One order across the chunks: due first, then id.
    .sort((a, b) => compareText(String(a.due_at), String(b.due_at)) || compareText(String(a.id), String(b.id)));
  if (failed) return null;
  return rows.flatMap((row) => (row.id && row.case_id && row.due_at
    ? [{
      id: String(row.id),
      caseID: String(row.case_id),
      label: String(row.label ?? ''),
      dueAt: String(row.due_at),
      status: String(row.status ?? ''),
      timeZone: typeof row.time_zone === 'string' ? row.time_zone : null,
    }]
    : []));
}
