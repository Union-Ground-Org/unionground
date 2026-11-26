import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock('react-native-url-polyfill/auto', () => ({}));
vi.mock('@supabase/supabase-js', () => ({ createClient: () => backend, processLock: vi.fn() }));
vi.mock('../lib/config', () => ({ mobileConfig: { backendConfigured: true, supabaseUrl: 'http://localhost', supabasePublishableKey: 'test' } }));
vi.mock('../lib/secureSessionStorage', () => ({ createBackendScopedSessionStorage: () => ({}) }));

import {
  ENGAGEMENT_EMAIL_KEYS,
  DISPLAYED_NOTIFICATION_TOPIC_KEYS,
  NOTIFICATION_TOPIC_KEYS,
  engagementEmailPatch,
  notificationPreferencesCopy,
  notificationPreferencesFromRow,
  quietClockValid,
  quietHoursPatch,
  topicsPatch,
  visibleNotificationTopics,
} from '../lib/notificationPreferences';
import { loadMemberNotificationPreferences, saveMemberNotificationPreferences } from './supabase';

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

type Query = Record<string, ReturnType<typeof vi.fn>> & { then?: unknown };
let queries: Query[] = [];
let row: Record<string, unknown> = {};

beforeEach(() => {
  queries = [];
  row = {
    notification_prefs: { deadlines: true, cases: true, forms: true, votes: true, events: true, tasks: true, appointments: true, workload: true, dues: true },
    dnd_enabled: false,
    quiet_hours_start: null,
    quiet_hours_end: null,
    quiet_hours_timezone: 'America/New_York',
    urgent_notifications_enabled: true,
  };
  // Saves go through update_my_member_profile (#7032 part 1); the row is read back.
  backend.rpc.mockReset().mockImplementation(async (_name: string, args: { p_fields: Record<string, unknown> }) => {
    row = { ...row, ...args.p_fields };
    return { data: { updated: true }, error: null };
  });
  backend.from.mockReset().mockImplementation(() => {
    const q: Query = {};
    for (const key of ['select', 'update', 'eq', 'maybeSingle']) q[key] = vi.fn(() => q);
    q.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ data: row, error: null }).then(resolve);
    queries.push(q);
    return q;
  });
});

// PHASE-2-WEB-PARITY: Union Ground's web memberApi predates these exports;
// the web phase brings them in, and these parity cases then run.
const webMemberApi = read('../../../../src/lib/memberApi.js');
const webExportsTopics = /export const NOTIFICATION_TOPIC_KEYS = \[/.test(webMemberApi)
  && /export const ENGAGEMENT_EMAIL_PREFERENCE_KEYS = \[/.test(webMemberApi);

describe('native notification topics, Do not disturb and quiet hours', () => {
  it.skipIf(!webExportsTopics)('offers exactly the topic list web Settings persists', () => {
    const memberApi = read('../../../../src/lib/memberApi.js');
    const web = memberApi.match(/export const NOTIFICATION_TOPIC_KEYS = (\[[^\]]+\]);/)?.[1];
    expect(web).toBeTruthy();
    expect([...NOTIFICATION_TOPIC_KEYS]).toEqual(JSON.parse(web as string));
    for (const language of ['en', 'es'] as const) {
      expect(Object.keys(notificationPreferencesCopy[language].topics)).toEqual([...NOTIFICATION_TOPIC_KEYS]);
    }
  });

  it('turning off the issues topic saves notification_prefs.issues=false through update_my_member_profile and keeps every other key on', async () => {
    const before = await loadMemberNotificationPreferences('member-1');
    expect(before.topics.cases).toBe(true);
    const after = await saveMemberNotificationPreferences('member-1', topicsPatch({ ...before.topics, cases: false }));

    const expected = Object.fromEntries(NOTIFICATION_TOPIC_KEYS.map((key) => [key, key !== 'cases']));
    expect(backend.rpc).toHaveBeenLastCalledWith('update_my_member_profile', { p_expected_user_id: 'member-1', p_fields: { notification_prefs: expected } });
    expect(backend.from).toHaveBeenLastCalledWith('member_profiles');
    const readBack = queries.at(-1) as Query;
    expect(readBack.update).not.toHaveBeenCalled();
    expect(readBack.eq).toHaveBeenCalledWith('id', 'member-1');
    expect(after.topics.cases).toBe(false);
    expect(after.topics.votes).toBe(true);
  });

  it.skipIf(!webExportsTopics)('shows the email choices web Settings persists and writes only the one the worker flips', async () => {
    const memberApi = read('../../../../src/lib/memberApi.js');
    const web = memberApi.match(/export const ENGAGEMENT_EMAIL_PREFERENCE_KEYS = (\[[^\]]+\]);/)?.[1];
    expect(web).toBeTruthy();
    expect([...ENGAGEMENT_EMAIL_KEYS]).toEqual(JSON.parse(web as string));
    const languages: Array<'en' | 'es'> = ['en', 'es'];
    for (const language of languages) {
      expect(Object.keys(notificationPreferencesCopy[language].engagementEmail)).toEqual([...ENGAGEMENT_EMAIL_KEYS]);
    }
    row = { ...row, notification_prefs: { ...(row.notification_prefs as Record<string, boolean>), surveys: false } };
    const before = await loadMemberNotificationPreferences('member-1');
    expect(before.engagementEmail).toEqual({ announcements: true, surveys: false, welcome: true });
    const after = await saveMemberNotificationPreferences('member-1', engagementEmailPatch(before.topics, 'surveys', true));
    const expected = { ...Object.fromEntries(NOTIFICATION_TOPIC_KEYS.map((key) => [key, true])), surveys: true };
    expect(backend.rpc).toHaveBeenLastCalledWith('update_my_member_profile', { p_expected_user_id: 'member-1', p_fields: { notification_prefs: expected } });
    expect(after.engagementEmail.surveys).toBe(true);
    // A topic write never carries a union email key.
    expect(Object.keys(topicsPatch(before.topics).notification_prefs)).toEqual([...NOTIFICATION_TOPIC_KEYS]);
    // An unset welcome choice follows announcements (REQ-UG-WELCOME-SEQUENCE-SCHEDULER-20261001).
    row = { ...row, notification_prefs: { ...(row.notification_prefs as Record<string, boolean>), announcements: false } };
    expect((await loadMemberNotificationPreferences('member-1')).engagementEmail.welcome).toBe(false);
    row = { ...row, notification_prefs: { ...(row.notification_prefs as Record<string, boolean>), welcome: true } };
    expect((await loadMemberNotificationPreferences('member-1')).engagementEmail.welcome).toBe(true);
    const card = read('../features/NotificationPreferencesCard.tsx');
    expect(card).toContain('ENGAGEMENT_EMAIL_KEYS.map((key)');
    expect(card).toContain('engagementEmailPatch(draft.topics, key, enabled)');
  });

  it('writes the quiet window, zone and urgent exception, and Do not disturb on its own', async () => {
    const before = await loadMemberNotificationPreferences('member-1');
    const after = await saveMemberNotificationPreferences('member-1', quietHoursPatch({
      ...before, quietHoursStart: '22:00', quietHoursEnd: '07:00', quietHoursTimezone: 'America/Chicago', urgentNotificationsEnabled: false,
    }));
    expect(backend.rpc).toHaveBeenLastCalledWith('update_my_member_profile', { p_expected_user_id: 'member-1', p_fields: {
      quiet_hours_start: '22:00', quiet_hours_end: '07:00', quiet_hours_timezone: 'America/Chicago', urgent_notifications_enabled: false,
    } });
    expect(after).toMatchObject({ quietHoursStart: '22:00', quietHoursEnd: '07:00', quietHoursTimezone: 'America/Chicago', urgentNotificationsEnabled: false });

    await saveMemberNotificationPreferences('member-1', { dnd_enabled: true });
    expect(backend.rpc).toHaveBeenLastCalledWith('update_my_member_profile', { p_expected_user_id: 'member-1', p_fields: { dnd_enabled: true } });
    expect(queries.every((query) => !query.update?.mock.calls.length)).toBe(true);
  });

  it('reads an absent topic as on, trims Postgres time to HH:MM, and clears an emptied window', () => {
    const value = notificationPreferencesFromRow({ notification_prefs: { cases: false }, quiet_hours_start: '22:00:00', quiet_hours_end: '07:30:00' });
    expect(value.topics).toMatchObject({ cases: false, tasks: true });
    // A stored dues key from the shared schema never becomes a native topic.
    expect(value.topics).not.toHaveProperty('dues');
    expect(value).toMatchObject({ quietHoursStart: '22:00', quietHoursEnd: '07:30', quietHoursTimezone: 'America/New_York', urgentNotificationsEnabled: true, dndEnabled: false });
    expect(quietHoursPatch({ ...value, quietHoursStart: '', quietHoursEnd: '' })).toMatchObject({ quiet_hours_start: null, quiet_hours_end: null });
    expect(['', '00:00', '07:05', '23:59'].every(quietClockValid)).toBe(true);
    expect(['7:00', '24:00', '22:60', '10pm'].some(quietClockValid)).toBe(false);
  });

  it('puts the controls on native Account for an authenticated member, in both languages, tú in Spanish', () => {
    const account = read('../../app/(tabs)/account.tsx');
    const card = read('../features/NotificationPreferencesCard.tsx');
    expect(account).toContain('<NotificationPreferencesCard />');
    expect(card).toContain("if (mode !== 'authenticated' || !userID) return null;");
    expect(card).toContain('DISPLAYED_NOTIFICATION_TOPIC_KEYS.map((topic)');
    expect(DISPLAYED_NOTIFICATION_TOPIC_KEYS).not.toContain('dues');
    expect(NOTIFICATION_TOPIC_KEYS).not.toContain('dues');
    expect(JSON.stringify(notificationPreferencesCopy)).not.toMatch(/\bDues\b|Cuotas/);
    expect(card).toContain('saveMemberNotificationPreferences(userID, patch)');
    expect(Object.keys(notificationPreferencesCopy.es).sort()).toEqual(Object.keys(notificationPreferencesCopy.en).sort());
    for (const value of Object.values(notificationPreferencesCopy.es).flatMap((item) => (typeof item === 'string' ? [item] : Object.values(item)))) {
      expect(value).not.toMatch(/\b(usted|pause|revise|vuelva|escriba|deje|use)\b/iu);
    }
  });
});
