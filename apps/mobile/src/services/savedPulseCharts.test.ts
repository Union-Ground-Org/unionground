import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NEW_CHART } from '../lib/savedPulseCharts';
const runtime = vi.hoisted(() => ({ create: vi.fn(), rpc: vi.fn(), from: vi.fn(), available: vi.fn(), share: vi.fn(), writes: vi.fn(), deleted: vi.fn(), exists: false }));
vi.mock('./supabase', () => ({ createCapturedSessionRpcClient: runtime.create, getSupabaseClient: () => ({ from: runtime.from }) }));
vi.mock('expo-sharing', () => ({ isAvailableAsync: runtime.available, shareAsync: runtime.share }));
vi.mock('expo-file-system', () => ({ Paths: { cache: 'file://cache' },
  Directory: class { get exists() { return runtime.exists; } delete() { runtime.deleted(); runtime.exists = false; } create() { runtime.exists = true; } },
  File: class { uri = 'file://cache/pulse-chart-export/chart.png'; write = runtime.writes; },
}));
import { chartDestinations, chartOptions, exportChartPNG, listCharts, loadChart, previewChart, pulseChartClient, removeChart, saveChart, shareChart } from './savedPulseCharts';
const ID = '11111111-1111-4111-8111-111111111111';
const spec = { ...NEW_CHART, measure: 'published_actions' as const };
const chart = { id: ID, title: 'Recorded', spec, scope: 'chapter' as const, pinned: false, home: false };
const figures = { rows: [{ label: '2026-11', value: 27 }], privacyFloor: 25, withheld: false, countedFrom: 'Recorded sign-ups.' };
const client = { rpc: runtime.rpc };
beforeEach(() => { vi.resetAllMocks(); runtime.exists = false; runtime.available.mockResolvedValue(true); runtime.rpc.mockResolvedValue({ data: null, error: null }); });
describe('saved chart service boundaries', () => {
  it('binds RPCs to the captured session and verifies responses', async () => {
    runtime.create.mockReturnValue(client);
    expect(pulseChartClient({ access_token: 'captured' } as never)).toBe(client);
    runtime.rpc.mockResolvedValue({ data: { measures: ['my_actions', 'bad'], units: [{ id: ID, name: 'North' }, {}] }, error: null });
    expect(await chartOptions(client, 'member')).toEqual({ measures: ['my_actions'], levels: ['chapter'], units: [{ id: ID, name: 'North', current: true }] });
    runtime.rpc.mockResolvedValue({ data: { measures: ['published_actions'], levels: ['chapter', 'local'], units: [{ id: ID, name: 'Other campaign', current: false }] }, error: null });
    expect(await chartOptions(client, 'admin')).toMatchObject({ levels: ['chapter', 'local'], units: [{ current: false }] });
    runtime.rpc.mockResolvedValue({ data: figures, error: null });
    expect((await previewChart(client, 'member', spec)).rows[0]?.value).toBe(27);
    runtime.rpc.mockResolvedValue({ data: [{ ...chart, figures }], error: null });
    expect((await listCharts(client, 'member'))[0]?.id).toBe(ID);
    runtime.rpc.mockResolvedValue({ data: { ...chart, figures }, error: null });
    expect((await loadChart(client, 'member', ID, true)).id).toBe(ID);
    expect(runtime.rpc).toHaveBeenLastCalledWith('read_pulse_chart', { p_id: ID, p_hat: 'member', p_export: true });
  });
  it('sends exact save, remove, undo and share arguments without cached figures', async () => {
    await saveChart(client, 'admin', chart); await saveChart(client, 'member', { ...chart, id: undefined });
    expect(runtime.rpc).toHaveBeenLastCalledWith('save_pulse_chart', expect.objectContaining({ p_id: null, p_spec: spec, p_hat: 'member' }));
    await removeChart(client, ID); expect(runtime.rpc).toHaveBeenLastCalledWith('remove_pulse_chart', { p_id: ID, p_undo: false });
    await removeChart(client, ID, true); expect(runtime.rpc).toHaveBeenLastCalledWith('remove_pulse_chart', { p_id: ID, p_undo: true });
    await shareChart(client, 'member', ID, 'message', 'target');
    expect(runtime.rpc).toHaveBeenLastCalledWith('share_pulse_chart', { p_id: ID, p_hat: 'member', p_kind: 'message', p_target: 'target' });
  });
  it('refuses malformed or failed reads rather than presenting zero', async () => {
    await expect(listCharts(client, 'member')).rejects.toThrow();
    await expect(chartOptions(client, 'member')).rejects.toThrow();
    runtime.rpc.mockResolvedValue({ data: null, error: { code: '42501' } });
    await expect(previewChart(client, 'member', spec)).rejects.toThrow('verified');
    await expect(removeChart(client, ID)).rejects.toThrow();
  });
  it('loads destinations through the ordinary RLS table reads', async () => {
    const query = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), limit: vi.fn().mockResolvedValue({ data: [{ id: ID, title: 'Recorded conversation' }], error: null }) };
    runtime.from.mockReturnValue(query);
    expect(await chartDestinations()).toHaveLength(2);
    query.limit.mockResolvedValue({ data: null, error: {} }); await expect(chartDestinations()).rejects.toThrow();
  });
  it('bounds PNG bytes and deletes its cache after both successful and failed OS shares', async () => {
    await expect(exportChartPNG('bad!')).rejects.toThrow();
    await expect(exportChartPNG('a'.repeat(4194305))).rejects.toThrow();
    runtime.available.mockResolvedValue(false); await expect(exportChartPNG('YWJj')).rejects.toThrow();
    runtime.available.mockResolvedValue(true); runtime.exists = true;
    await exportChartPNG('YWJj'); expect(runtime.deleted).toHaveBeenCalledTimes(2); expect(runtime.writes).toHaveBeenCalledWith('YWJj', { encoding: 'base64' });
    runtime.share.mockRejectedValue(new Error('OS share failed')); await expect(exportChartPNG('YWJj')).rejects.toThrow(); expect(runtime.exists).toBe(false);
  });
  it('cancels a stale account export before writing bytes or opening the OS share sheet', async () => {
    let current = true, finish!: (available: boolean) => void;
    runtime.available.mockReturnValue(new Promise<boolean>((resolve) => { finish = resolve; }));
    const pending = exportChartPNG('YWJj', () => current);
    await vi.waitFor(() => expect(runtime.available).toHaveBeenCalled());
    current = false; finish(true);
    await expect(pending).rejects.toThrow('account changed');
    expect(runtime.writes).not.toHaveBeenCalled(); expect(runtime.share).not.toHaveBeenCalled();
    await expect(exportChartPNG('YWJj', () => false)).rejects.toThrow('account changed');
  });
});
