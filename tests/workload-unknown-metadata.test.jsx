import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadMemberApp } from '../src/lib/memberApi.js';
import { defaultWorkloadDefinition } from '../src/lib/workloadConfiguration.js';
import { LanguageProvider } from '../src/lib/LanguageContext.jsx';
import { clearDeviceParityState } from '../src/lib/deviceParity.js';
import { WorkWidgets } from '../src/components/WorkWidgets.jsx';
import { WorkloadView } from '../src/views/WorkloadView.jsx';

async function loadEntry(columns = {}, version = 1) {
  const tables = {
    member_profiles: { id: 'fictional-member', first_name: 'Fern', language: 'en' },
    member_workload_logs: [{ id: 'unknown-log', created_at: '2026-11-05T12:00:00Z', weekly_assigned: null, employment: null, pt_hours: null, ot_worked: null, ot_hours: null,
      workload_configuration: { organizationId: 'fictional-org', version, definition: defaultWorkloadDefinition() }, workload_values: {}, workload_status: 'logged', ...columns }],
  };
  const client = {
    from(table) {
      let query;
      query = new Proxy({}, { get(_o, key) {
        if (key === 'then') return (resolve, reject) => Promise.resolve({ data: tables[table] ?? [], error: null }).then(resolve, reject);
        return () => query;
      } });
      return query;
    },
    rpc: async () => ({ data: null, error: null }),
  };
  return loadMemberApp(client, { id: 'fictional-member' });
}
const mount = node => render(<LanguageProvider lang="en">{node}</LanguageProvider>);
beforeEach(() => { clearDeviceParityState(); window.history.replaceState(null, '', '/m/workload'); });

describe('unknown workload metadata', () => {
  it.each([0, 1])('keeps missing original measurements absent from loader and Work widgets (version %s)', async version => {
    const data = await loadEntry({}, version);
    expect(data.workload.entries[0].meta).toBe('');
    const view = mount(<WorkWidgets data={data} />);
    const widget = view.container.querySelector('[data-widget="workload"]');
    expect(widget).not.toHaveTextContent('full-time');
    expect(widget).not.toHaveTextContent('new this week');
  });
  it.each([
    [{ weekly_assigned: 0, employment: 'full_time' }, '0 new this week · full-time'],
    [{ employment: 'part_time', pt_hours: 20 }, 'part-time 20h'],
    [{ employment: 'part_time', pt_hours: null }, 'Part-time'],
  ])('retains real zero and known employment without manufacturing hours: %j', async (columns, expected) => {
    const data = await loadEntry(columns);
    expect(data.workload.entries[0].meta).toBe(expected);
  });
});
