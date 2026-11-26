import { stubSessionWriter } from '../testing/stubSessionWriter';
const businessWriter = stubSessionWriter(() => ({
  rpc: (...args: unknown[]) => {
    const request: { setHeader(name: string, value: string): Promise<{ data: unknown; error: unknown }> } = mocks.rpc(...args);
    return request.setHeader('Authorization', `Bearer ${mocks.session.access_token}`);
  },
}));
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ session: { user: { id: 'actor' }, access_token: 'initial-token' }, rpc: vi.fn(), header: vi.fn() }));
vi.mock('./supabase', () => ({ getSupabaseClient: () => ({ auth: { getSession: async () => ({ data: { session: mocks.session } }) }, rpc: mocks.rpc }) }));
import { loadNativeOrganizationWorkload, loadNativeUnitSettings, saveNativeOrganizationWorkload, saveNativeUnitWorkload, type UnitContext } from './unitSettings';
const response = { actorId: 'actor', chapterId: 'chapter', organizationId: 'org', units: [{ id: 'a', name: 'North' }, { id: 'b', name: 'South' }], unitId: null, needsChoice: true, effective: null, canManage: false };
beforeEach(() => {
  mocks.session = { user: { id: 'actor' }, access_token: 'initial-token' }; vi.resetAllMocks();
  mocks.header.mockResolvedValue({ data: response, error: null }); mocks.rpc.mockReturnValue({ setHeader: mocks.header });
});
describe('native unit settings boundary', () => {
  it('sends the actual unit with the initiating token and leaves several memberships unselected', async () => {
    expect(await loadNativeUnitSettings()).toMatchObject({ needsChoice: true, unitId: null, effective: null });
    expect(mocks.rpc).toHaveBeenCalledWith('get_my_unit_settings', { p_unit: null });
    expect(mocks.header).toHaveBeenCalledWith('Authorization', 'Bearer initial-token');
  });
  it('accepts only the named missing-schema compatibility refusal', async () => {
    mocks.header.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'get_my_unit_settings absent' } });
    expect(await loadNativeUnitSettings()).toMatchObject({ legacy: true });
    for (const code of ['42501', 'XX000']) {
      mocks.header.mockResolvedValue({ data: null, error: { code, message: 'membership changed' } });
      await expect(loadNativeUnitSettings('b')).rejects.toMatchObject({ code });
    }
    mocks.header.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'another_rpc absent' } });
    await expect(loadNativeUnitSettings()).rejects.toMatchObject({ code: 'PGRST202' });
  });
  it('treats a held feature exactly like the missing schema', async () => {
    mocks.header.mockResolvedValue({ data: { released: false }, error: null });
    expect(await loadNativeUnitSettings()).toMatchObject({ legacy: true, units: [], effective: null, canManage: false });
  });
  it('rejects malformed settings and responses completed after account replacement', async () => {
    mocks.header.mockResolvedValue({ data: { ...response, units: [{ id: 'a', name: 42 }] }, error: null });
    await expect(loadNativeUnitSettings()).rejects.toThrow('Unit settings unavailable');
    mocks.header.mockImplementation(async () => { mocks.session = { user: { id: 'other' }, access_token: 'other-token' }; return { data: response, error: null }; });
    await expect(loadNativeUnitSettings()).rejects.toThrow('Unit settings unavailable');
  });
  it('refuses an unresolved workflow before issuing a write', async () => {
    await expect(saveNativeUnitWorkload(businessWriter, response, {}, 'logged')).rejects.toThrow();
    expect(mocks.rpc).not.toHaveBeenCalled();
    const config = { actorId: 'actor', chapterId: 'chapter', organizationId: 'org', unitId: 'b', unitName: 'South', version: 2, settingsRevision: 'south-version', definition: { title: 'Report', period: 'week' as const, statuses: ['logged'], fields: [] } };
    const ready: UnitContext = { ...response, unitId: 'b', needsChoice: false, effective: { workload: [], forms: [], templates: [], capabilities: {}, configuration: config } };
    await saveNativeUnitWorkload(businessWriter, ready, { cases: 4 }, 'logged');
    expect(mocks.rpc).toHaveBeenLastCalledWith('save_unit_workload_log', { p_entry_id: null, p_version: 2, p_values: { cases: 4 }, p_status: 'logged', p_organization_id: 'org', p_unit: 'b', p_settings_revision: 'south-version', p_actor: 'actor', p_chapter: 'chapter' });
  });
  it('logs on the organization form while units are held, with the website write and the initiating token', async () => {
    const definition = { title: 'Workplace log', period: 'month', statuses: ['logged'], fields: [
      { key: 'pending', label: 'workload.cat.pending', kind: 'category', type: 'number', visible: true, required: false, retired: false, summary: 'sum', unit: 'count', options: [] },
    ] };
    mocks.header.mockResolvedValue({ data: { organizationId: 'org', version: 0, definition, canEdit: false, history: [] }, error: null });
    const form = await loadNativeOrganizationWorkload();
    expect(mocks.rpc).toHaveBeenCalledWith('get_organization_workload_configuration', {});
    expect(form).toEqual({ organizationId: 'org', version: 0, definition });
    mocks.header.mockResolvedValue({ data: { id: 'entry', awardedPoints: 5 }, error: null });
    await saveNativeOrganizationWorkload(businessWriter, form, { pending: 4 }, 'logged');
    // The same arguments the website's submitWorkloadLog sends for a new configured entry (src/lib/memberApi.js).
    expect(mocks.rpc).toHaveBeenLastCalledWith('save_configured_workload_log', { p_entry_id: null, p_version: 0, p_values: { pending: 4 }, p_status: 'logged', p_organization_id: 'org' });
    expect(mocks.header).toHaveBeenLastCalledWith('Authorization', 'Bearer initial-token');
  });
  it('refuses a malformed organization form and passes on a refused write', async () => {
    mocks.header.mockResolvedValue({ data: { organizationId: 'org', version: 0, definition: { title: 'Workplace log', period: 'year', statuses: [], fields: [] } }, error: null });
    await expect(loadNativeOrganizationWorkload()).rejects.toThrow('Unit settings unavailable');
    mocks.header.mockResolvedValue({ data: null, error: { code: 'P0001', message: 'workload_daily_limit' } });
    await expect(saveNativeOrganizationWorkload(businessWriter, { organizationId: 'org', version: 0, definition: { title: 'Workplace log', period: 'month', statuses: ['logged'], fields: [] } }, {}, 'logged'))
      .rejects.toMatchObject({ code: 'P0001' });
  });
});

