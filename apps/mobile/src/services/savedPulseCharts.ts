import type { Session } from '@supabase/supabase-js';
import { PULSE_CHART_EXPORT_CACHE_KEY } from '../lib/savedPulseCharts';
import { CHART_MEASURES, chartFigures, savedChart, type ChartMeasure, type ChartSpec, type SavedChart } from '../lib/savedPulseCharts';
import { pulseObject, pulseRows, pulseText } from '../lib/pulseCatalog';
import { createCapturedSessionRpcClient, getSupabaseClient } from './supabase';

export type ChartRpc = { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> };
export function pulseChartClient(session: Session): ChartRpc { return createCapturedSessionRpcClient(session); }
async function read(client: ChartRpc, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await client.rpc(name, args);
  if (result.error) throw new Error('Chart could not be verified. Refresh and try again.');
  return result.data;
}
export async function listCharts(client: ChartRpc, hat: string): Promise<SavedChart[]> {
  const data = await read(client, 'list_pulse_charts', { p_hat: hat });
  if (!Array.isArray(data)) throw new Error('Saved charts could not be verified.');
  return data.map(savedChart);
}
export async function chartOptions(client: ChartRpc, hat: string) {
  const row = pulseObject(await read(client, 'pulse_chart_options', { p_hat: hat }));
  const measures = Array.isArray(row.measures) ? row.measures.filter((value): value is ChartMeasure => CHART_MEASURES.includes(value as ChartMeasure)) : [];
  if (!measures.length) throw new Error('No chart measures could be verified.');
  const levels: NonNullable<ChartSpec['level']>[] = ['chapter'];
  if (Array.isArray(row.levels) && row.levels.includes('local')) levels.push('local');
  return { measures, levels, units: pulseRows(row.units).map((unit) => ({ id: pulseText(unit.id), name: pulseText(unit.name), current: unit.current !== false })).filter((unit) => unit.id && unit.name) };
}
export async function previewChart(client: ChartRpc, hat: string, spec: ChartSpec) {
  return chartFigures(await read(client, 'preview_pulse_chart', { p_spec: spec, p_hat: hat }), spec);
}
export async function saveChart(client: ChartRpc, hat: string, chart: Pick<SavedChart, 'title' | 'spec' | 'scope' | 'pinned' | 'home'> & { id?: string }) {
  return read(client, 'save_pulse_chart', { p_id: chart.id ?? null, p_title: chart.title, p_spec: chart.spec, p_scope: chart.scope, p_pinned: chart.pinned, p_home: chart.home, p_hat: hat });
}
export async function removeChart(client: ChartRpc, id: string, undo = false) { await read(client, 'remove_pulse_chart', { p_id: id, p_undo: undo }); }
export async function loadChart(client: ChartRpc, hat: string, id: string, picture = false) {
  return savedChart(await read(client, 'read_pulse_chart', { p_id: id, p_hat: hat, p_export: picture }));
}
export async function shareChart(client: ChartRpc, hat: string, id: string, kind: 'chapter' | 'message', target: string) {
  await read(client, 'share_pulse_chart', { p_id: id, p_hat: hat, p_kind: kind, p_target: target });
}
export async function chartDestinations() {
  const client = getSupabaseClient();
  if (!client) throw new Error('Messages are unavailable.');
  // These are ordinary RLS reads, including each space's audience and existing
  // conversation consent. The share RPC rechecks the exact selected target.
  const [threads, conversations] = await Promise.all([
    client.from('chapter_threads').select('id,title').eq('status', 'open').order('updated_at', { ascending: false }).limit(30),
    client.from('member_conversations').select('id,title').order('updated_at', { ascending: false }).limit(30),
  ]);
  if (threads.error || conversations.error) throw new Error('Share destinations could not be verified.');
  return [
    ...pulseRows(threads.data).map((row) => ({ id: pulseText(row.id), title: pulseText(row.title), kind: 'chapter' as const })),
    ...pulseRows(conversations.data).map((row) => ({ id: pulseText(row.id), title: pulseText(row.title), kind: 'message' as const })),
  ];
}

// Bounded ephemeral PNG; never persisted to a gallery or cloud by the app.
// The OS share sheet is an explicit disclosure chosen by the user.
export async function exportChartPNG(base64: string, isCurrent: () => boolean = () => true) {
  const assertCurrent = () => { if (!isCurrent()) throw new Error('Chart export cancelled because your account changed.'); };
  assertCurrent();
  if (!/^[a-z0-9+/=]+$/i.test(base64) || base64.length > 4 * 1024 * 1024) throw new Error('Chart picture is too large.');
  const [{ File, Directory, Paths }, Sharing] = await Promise.all([import('expo-file-system'), import('expo-sharing')]);
  assertCurrent();
  const available = await Sharing.isAvailableAsync();
  assertCurrent();
  if (!available) throw new Error('Picture sharing is unavailable on this device.');
  const directory = new Directory(Paths.cache, PULSE_CHART_EXPORT_CACHE_KEY);
  if (directory.exists) directory.delete();
  directory.create({ intermediates: true, idempotent: true });
  const file = new File(directory, 'chart.png');
  try {
    file.write(base64, { encoding: 'base64' });
    assertCurrent();
    await Sharing.shareAsync(file.uri, { mimeType: 'image/png', dialogTitle: 'Share chart picture' });
  } finally { if (directory.exists) directory.delete(); }
}
