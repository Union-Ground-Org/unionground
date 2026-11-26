import type { Session } from '@supabase/supabase-js';
import { CASEWORK_CHARTS, caseworkCard, type CaseworkKey, type CaseworkLanguage } from '../lib/pulseCasework';
import type { PulseCard } from '../lib/pulseCatalog';
import { withReadDeadline } from '../lib/readDeadline';
import { createCapturedSessionRpcClient } from './supabase';

export type CaseworkRpc = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> };
export function pulseCaseworkClient(session: Session): CaseworkRpc { return createCapturedSessionRpcClient(session); }

// #8927 slice 3: reads only the Casework charts that are on the person's
// Pulse, one call each, every one under the read deadline. Each read names
// the chapter this screen shows (p_chapter_id), and the server refuses it
// unless that is still the caller's selected chapter when it runs
// (20261123141000), so figures counted for another chapter never arrive under
// this chapter's name. A refused, failed or late read is that one card's
// "didn't load" state, never a zero, and nothing here throws.
export async function loadPulseCasework(client: CaseworkRpc, keys: readonly string[], chapterID: string, signal: AbortSignal, language: CaseworkLanguage = 'en'): Promise<PulseCard[]> {
  const charts = CASEWORK_CHARTS.filter((chart) => keys.includes(chart.key));
  if (!charts.length) return [];
  const call = async (name: string): Promise<{ data: unknown; error: unknown }> => {
    try { return await withReadDeadline(Promise.resolve(client.rpc(name, { p_chapter_id: chapterID }))); }
    catch (error) { return { data: null, error }; }
  };
  const answers = await Promise.all(charts.map((chart) => call(chart.read)));
  if (signal.aborted) return charts.map((chart) => caseworkCard(chart.key as CaseworkKey, null, language));
  return charts.map((chart, index) => caseworkCard(chart.key as CaseworkKey, answers[index]!.error ? null : answers[index]!.data, language));
}
