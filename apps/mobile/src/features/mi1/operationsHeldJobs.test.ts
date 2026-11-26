// (follow-up to the Sunday release sweep, signed-in
// finding 1): Operations health on the native app leaves out a background job
// that serves a held switch, with the same map and rule as the web Job health
// list (JOB_ACTS_BESIDE in src/lib/heldSettingCompanions.js).
import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpc = vi.hoisted(() => vi.fn());

vi.mock('react-native-url-polyfill/auto', () => ({}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({ auth: {}, rpc }), processLock: vi.fn() }));
vi.mock('../../lib/config', () => ({
  mobileConfig: { backendConfigured: true, supabaseUrl: 'https://example.supabase.co', supabasePublishableKey: 'publishable-test-key' },
}));
vi.mock('../../lib/secureSessionStorage', () => ({ createBackendScopedSessionStorage: () => ({}) }));

import { JOB_ACTS_BESIDE, PRODUCT_JOBS, UNREAD_HELD_JOB_SCOPE, withoutHeldJobs } from '../../lib/mi1Shared';
import { loadMobileAdminListedSettingKeys, loadMobileCompassPlatformOperator } from '../../services/heldJobScope';

type Job = { jobName: string };
const jobs: Job[] = [
  { jobName: 'notifications-dispatch-tick' },
  { jobName: 'learning-period-end-tick' },
  { jobName: 'issue-intelligence-weekly-digest' },
];
const names = (list: Job[]): string[] => list.map((job) => job.jobName);

beforeEach(() => {
  rpc.mockReset();
});

describe('the native held-job rule', () => {
  it('reads the web map, which has a row for every shared product job', () => {
    expect(Object.keys(JOB_ACTS_BESIDE).sort()).toEqual(PRODUCT_JOBS.map((job: Job) => job.jobName).sort());
  });

  it('lists none of the held-feature jobs while the settings list is unread', () => {
    expect(names(withoutHeldJobs(jobs, UNREAD_HELD_JOB_SCOPE))).toEqual(['notifications-dispatch-tick']);
  });

  it('leaves out a job whose switch the settings list left out, and brings it back once listed', () => {
    expect(names(withoutHeldJobs(jobs, { listedSettingKeys: ['features.tasks.enabled'], platformOperator: false }))).toEqual(['notifications-dispatch-tick']);
    expect(names(withoutHeldJobs(jobs, { listedSettingKeys: ['features.guidance_onboarding.learning_period'], platformOperator: false }))).toEqual(['notifications-dispatch-tick', 'learning-period-end-tick']);
  });

  it('shows a Guide platform operator every job', () => {
    expect(names(withoutHeldJobs(jobs, { listedSettingKeys: null, platformOperator: true }))).toEqual(names(jobs));
  });
});

describe('the reads behind it', () => {
  it('returns the keys of the admin settings list', async () => {
    rpc.mockResolvedValueOnce({ data: { settings: [{ key: 'features.security.sso' }, { key: 7 }, null, { key: 'limits.x.y' }] }, error: null });
    await expect(loadMobileAdminListedSettingKeys()).resolves.toEqual(['features.security.sso', 'limits.x.y']);
    expect(rpc).toHaveBeenCalledWith('get_admin_organization_configuration');
  });

  it('answers unread (null) for a refused, malformed or failed settings read', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: '42501' } });
    await expect(loadMobileAdminListedSettingKeys()).resolves.toBeNull();
    rpc.mockResolvedValueOnce({ data: { settings: 'none' }, error: null });
    await expect(loadMobileAdminListedSettingKeys()).resolves.toBeNull();
    rpc.mockRejectedValueOnce(new Error('offline'));
    await expect(loadMobileAdminListedSettingKeys()).resolves.toBeNull();
  });

  it('reads the operator signal from get_compass_platform_ai and answers false on any failure', async () => {
    rpc.mockResolvedValueOnce({ data: { canManage: true }, error: null });
    await expect(loadMobileCompassPlatformOperator()).resolves.toBe(true);
    expect(rpc).toHaveBeenCalledWith('get_compass_platform_ai');
    rpc.mockResolvedValueOnce({ data: { canManage: false }, error: null });
    await expect(loadMobileCompassPlatformOperator()).resolves.toBe(false);
    rpc.mockResolvedValueOnce({ data: null, error: { code: '42501' } });
    await expect(loadMobileCompassPlatformOperator()).resolves.toBe(false);
    rpc.mockRejectedValueOnce(new Error('offline'));
    await expect(loadMobileCompassPlatformOperator()).resolves.toBe(false);
  });
});
