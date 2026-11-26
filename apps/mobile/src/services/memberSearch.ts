// Live member search for the native apps
// (BUG-UG-NATIVE-SEVEN-FEATURE-KEYS-OPEN-ONLY-THE-GENERIC-SCREEN-20261113,
// #8630). Each source is one bounded read under the person's own row-level
// security, so a result is always something they could already open. Cases
// come from the signed-in dashboard, which already holds them.
import { groupTimeZone, zoneDay } from '../../../../src/lib/zoneTime.js';
import { parseDatabaseTimestamp } from '../lib/evidenceTimestamp';
import { getSupabaseClient } from './supabase';

export type LiveSearchScope = 'cases' | 'forms' | 'events' | 'rights' | 'ballots';
export type LiveSearchSource = Exclude<LiveSearchScope, 'cases'>;

export type LiveSearchRow = {
  id: string;
  scope: LiveSearchScope;
  title: string;
  body: string;
  href?: string;
  eventDay?: string | null;
  ballot?: { closesAtMs: number | null; closed: boolean };
};

export type LiveSearchIndex = {
  rows: LiveSearchRow[];
  // Sources whose read failed; the screen names them instead of reading their
  // silence as "no matches".
  unavailable: LiveSearchSource[];
};

// The most rows one source contributes; the screen says when a source is full.
export const LIVE_SEARCH_SOURCE_LIMIT = 100;
const SNIPPET_LENGTH = 160;

type Row = Record<string, unknown>;

function words(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function snippet(value: unknown): string {
  const text = words(value);
  return text.length > SNIPPET_LENGTH ? `${text.slice(0, SNIPPET_LENGTH - 1).trimEnd()}…` : text;
}

function eventSearchDay(row: Row): string | null {
  try {
    return words(row.event_date) || zoneDay(parseDatabaseTimestamp(row.starts_at), groupTimeZone(null));
  } catch { // swallow-ok: keep the search result usable without a date on an engine that cannot resolve the zone
    return null;
  }
}

const FORM_STATUS: Record<string, string> = { draft: 'Draft', submitted: 'Submitted', in_review: 'In review', approved: 'Approved', returned: 'Returned' };

export function liveSearchRowsFrom(source: LiveSearchSource, data: Row[], now = Date.now()): LiveSearchRow[] {
  return data.flatMap((row): LiveSearchRow[] => {
    const id = words(row.id);
    if (!id) return [];
    switch (source) {
      case 'forms': {
        const title = words(row.template_key).replaceAll('_', ' ');
        const status = words(row.status);
        return title ? [{ id: `forms:${id}`, scope: 'forms', title: title.charAt(0).toUpperCase() + title.slice(1), body: FORM_STATUS[status] ?? status }] : [];
      }
      case 'events': {
        const title = words(row.title);
        return title ? [{ id: `events:${id}`, scope: 'events', title, body: words(row.location), eventDay: eventSearchDay(row) }] : [];
      }
      case 'rights': {
        const title = words(row.title);
        return title ? [{ id: `rights:${id}`, scope: 'rights', title: row.article_ref ? `${words(row.article_ref)} · ${title}` : title, body: snippet(row.body) }] : [];
      }
      case 'ballots': {
        const title = words(row.title);
        const closesAtMs = parseDatabaseTimestamp(row.closes_at)?.getTime() ?? null;
        const closed = row.active === false || (closesAtMs !== null && closesAtMs <= now);
        return title ? [{ id: `ballots:${id}`, scope: 'ballots', title, body: '', href: '/feature/voting', ballot: { closesAtMs, closed } }] : [];
      }
    }
  });
}

async function read(source: LiveSearchSource): Promise<Row[]> {
  const client = getSupabaseClient();
  if (!client) throw new Error('The secure mobile backend is not configured.');
  const query = source === 'forms'
    ? client.from('member_forms').select('id,template_key,status,updated_at').order('updated_at', { ascending: false })
    : source === 'events'
      ? client.from('member_events').select('id,title,starts_at,event_date,location')
        .order('sort_at', { ascending: false }).order('id', { ascending: false })
      : source === 'rights'
        ? client.from('member_kb_articles').select('id,title,article_ref,body,updated_at').eq('status', 'published').eq('is_sample', false).order('updated_at', { ascending: false })
        : client.from('member_ballots').select('id,title,closes_at,active').order('closes_at', { ascending: false });
  const { data, error } = await query.limit(LIVE_SEARCH_SOURCE_LIMIT);
  if (error) throw error;
  return Array.isArray(data) ? data as Row[] : [];
}

export const LIVE_SEARCH_SOURCES: readonly LiveSearchSource[] = ['forms', 'events', 'rights', 'ballots'];

export async function loadLiveSearchIndex(): Promise<LiveSearchIndex> {
  const settled = await Promise.allSettled(LIVE_SEARCH_SOURCES.map(read));
  const index: LiveSearchIndex = { rows: [], unavailable: [] };
  settled.forEach((result, at) => {
    const source = LIVE_SEARCH_SOURCES[at];
    if (!source) return;
    if (result.status === 'fulfilled') index.rows.push(...liveSearchRowsFrom(source, result.value));
    else index.unavailable.push(source);
  });
  return index;
}
