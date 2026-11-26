import type { MobileSessionWriter } from './supabase';
// REQ-UG-LIST-ROW-DETAIL-TOGGLE-CHAPTER-AND-STEWARD-20261104 (#7043):
// case rows name a case by reference, type and step (#7015). The chapter's
// leadership can show case topics in its rows, and a case's assigned steward
// can show that case's topic in their own rows. The server decides both; this
// module only reads and saves the two switches.
import type { SupabaseClient } from '@supabase/supabase-js';

import { getSupabaseClient } from './supabase';

export type ChapterCaseRowTopic = { enabled: boolean; canChange: boolean };
export type CaseRowTopic = { shown: boolean; chapterShown: boolean; canChange: boolean };

function requireClient(): SupabaseClient {
  const client = getSupabaseClient();
  if (!client) throw new Error('The secure mobile backend is not configured.');
  return client;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function parseChapterCaseRowTopic(value: unknown): ChapterCaseRowTopic {
  const row = record(value);
  if (typeof row.enabled !== 'boolean') throw new Error('The campaign setting could not be verified.');
  return { enabled: row.enabled, canChange: row.canChange === true };
}

export function parseCaseRowTopic(value: unknown): CaseRowTopic {
  const row = record(value);
  if (typeof row.shown !== 'boolean') throw new Error('The issue setting could not be verified.');
  return { shown: row.shown, chapterShown: row.chapterShown === true, canChange: row.canChange === true };
}

export async function loadChapterCaseRowTopic(chapterID: string): Promise<ChapterCaseRowTopic> {
  const { data, error } = await requireClient().rpc('get_chapter_case_row_topic', { p_chapter: chapterID });
  if (error) throw error;
  return parseChapterCaseRowTopic(data);
}

export async function saveChapterCaseRowTopic(writer: MobileSessionWriter, chapterID: string, enabled: boolean): Promise<void> {
  const { error } = await (await writer.client()).rpc('set_chapter_case_row_topic', { p_chapter: chapterID, p_enabled: enabled });
  if (error) throw error;
}

export async function loadCaseRowTopic(caseID: string): Promise<CaseRowTopic> {
  const { data, error } = await requireClient().rpc('get_case_row_topic', { p_case: caseID });
  if (error) throw error;
  return parseCaseRowTopic(data);
}

export async function saveCaseRowTopic(writer: MobileSessionWriter, caseID: string, shown: boolean): Promise<void> {
  const { error } = await (await writer.client()).rpc('set_case_row_topic', { p_case: caseID, p_shown: shown });
  if (error) throw error;
}
