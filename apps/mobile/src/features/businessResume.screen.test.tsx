// @vitest-environment jsdom
// Part B of record 9254: extracted without changing assertions from businessResume.screen.test.tsx
// at e3e2edf61c6383a861124363beb7cdd770b5d3ad. Only Part B families retained; all selected cases keep their original assertions. Part A cases already shipped independently.
import { act, cloneElement, createElement as h, type ReactElement } from 'react';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exposedNames, getExposed, press, render, setPlatform, type, type Rendered } from '../testing/reactNativeStandIn';
import { stubPlainRequire } from '../testing/plainRequire';
import { stubSessionWriter } from '../testing/stubSessionWriter';
import { syncResumeDraftContext } from '../lib/resumeDraftHolder';
import { nativeUiText } from '../lib/nativeUiCopy';
import palette from '../theme/palette.json';

type Phase = 'ready' | 'booting' | 'refresh' | 'mfa-outage';
type Surface = 'campaign' | 'booking' | 'meeting' | 'hours';
const backend = vi.hoisted(() => ({ phase: 'ready' as Phase, grant: false, calls: [] as string[], pending: null as Promise<void> | null }));
function context() {
  const ready = backend.phase === 'ready';
  const projected = ready || backend.phase === 'refresh';
  return {
    mode: backend.phase === 'booting' ? 'booting' : backend.phase === 'mfa-outage' ? 'mfaRequired' : 'authenticated',
    session: { user: { id: 'person-a' }, access_token: 'fixture-token-a' },
    organizationID: projected ? 'org-a' : null, assuranceUnavailable: backend.phase === 'mfa-outage',
    dashboard: projected ? { member: { id: 'person-a', chapterID: 'chapter-a', language: 'en' } } : null,
    chapterMemberships: projected ? [{ chapterID: 'chapter-a', organizationID: 'org-a', selected: true }] : [],
    authorizedRoles: ready ? backend.grant ? ['admin', 'coordinator'] : ['admin'] : [], chapterRoles: ready ? ['admin'] : [], organizationRoles: [], chosenStaffRole: ready ? 'admin' : null,
    memberLanguage: 'en', resumeDraftReads: { dashboard: ready, memberships: ready, staff: ready },
  };
}
async function rpc(name: string, args: Record<string, unknown> = {}) {
  if (name === 'get_bookable_stewards') return { data: [{ id: 'steward-a', name: 'Rae Fixture' }], error: null };
  if (name === 'get_appointment_slots') return { data: { slots: [{ startsAt: '2026-11-24T14:00:00Z', stewardCount: 1 }] }, error: null };
  backend.calls.push(name);
  if (backend.pending) await backend.pending;
  if (name === 'save_vote_campaign_draft') return { data: { campaignId: 'saved-draft' }, error: null };
  if (name === 'create_member_event_model') return { data: { id: args.p_id }, error: null };
  if (name === 'book_appointment') return { data: { id: 'saved-booking' }, error: null };
  if (name === 'set_appointment_windows') return { data: { windows: 1 }, error: null };
  throw new Error(`Unexpected RPC ${name}`);
}
// The campaign draft and Be heard hold typed work on the shared draft hook, whose attempt keys come from expo-crypto (#9240 pull request C).
vi.mock('expo-crypto', () => ({ randomUUID: () => 'attempt-key', getRandomBytes: (count: number) => Uint8Array.from({ length: count }, (_, i) => i + 1) }));
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('../components/ui', () => import('../testing/uiStandIn'));
vi.mock('../state/AppProvider', () => ({ useApp: () => { const app = context(); syncResumeDraftContext(app); return app; } }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => palette['union-ground'] }));
vi.mock('../services/haptics', () => ({ haptics: { success: vi.fn(async () => {}), select: vi.fn(async () => {}) } }));
vi.mock('../services/supabase', () => ({
  captureSessionWriter: (session: { user?: { id?: string } } | null) => stubSessionWriter(() => ({ rpc }), session?.user?.id ?? 'signed-out'),
  getSupabaseClient: () => ({ rpc }),
}));
vi.mock('../services/livedIn', () => ({ loadMobileStewardAppointmentsDesk: async () => ({
  availability: { timezone: 'America/New_York', accepting: true, minNoticeMinutes: 240, blackouts: [], windows: [] },
}) }));
import { CampaignDraftCard } from './CampaignDraftCard';
import { AppointmentBookingCard } from './AppointmentBookingCard';
import { ScheduleMeetingCard } from './ScheduleMeetingCard';
import { AppointmentHoursCard } from './AppointmentHoursCard';
afterAll(stubPlainRequire({ 'expo-crypto': { getRandomBytes: (count: number) => Uint8Array.from({ length: count }, (_, i) => i + 1) } }));
let view: Rendered | null = null;
const t = nativeUiText('en');
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
beforeEach(() => {
  backend.phase = 'ready'; backend.grant = false; backend.calls = []; backend.pending = null;
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-20T16:00:00Z'));
});
afterEach(async () => {
  await view?.unmount(); view = null;
  syncResumeDraftContext({ ...context(), mode: 'signed-out', session: null });
  vi.useRealTimers(); setPlatform('ios');
});
async function open(surface: Surface, saved: () => void) {
  let element: ReactElement;
  if (surface === 'campaign') element = h(CampaignDraftCard, { canManageChapter: true, canManageUnion: false, onSaved: saved });
  else if (surface === 'booking') element = h(AppointmentBookingCard, { t, locale: 'en-US', onBooked: saved });
  else if (surface === 'meeting') element = h(ScheduleMeetingCard, { onScheduled: saved });
  else element = h(AppointmentHoursCard, { t });
  view = await render(element); await settle();
  if (surface === 'campaign') {
    await press(getExposed(view.container, 'Write a draft'));
    await type(getExposed(view.container, 'Title in English'), 'A retained campaign');
    await type(getExposed(view.container, 'Choice 1'), 'Yes');
    await type(getExposed(view.container, 'Choice 2'), 'No');
  } else if (surface === 'booking') {
    await press(getExposed(view.container, 'Book a time')); await settle();
    await press(getExposed(view.container, 'Office hours')); await settle();
    await press(getExposed(view.container, '9:00 AM ET'));
    await type(getExposed(view.container, 'Location, room, or meeting link'), 'Hall A');
  } else if (surface === 'meeting') {
    await press(getExposed(view.container, 'Schedule a meeting'));
    await type(getExposed(view.container, 'Meeting title'), 'A retained meeting');
    await type(getExposed(view.container, 'Location, room, or meeting link'), 'Hall A');
    await type(getExposed(view.container, 'What the meeting is about'), 'Plan together.');
  } else {
    await press(getExposed(view.container, 'Set booking hours'));
    await press(getExposed(view.container, 'Add hours'));
  }
  return element;
}
const submits: Record<Surface, string> = { campaign: 'Save draft', booking: 'Confirm booking', meeting: 'Schedule meeting', hours: 'Save hours' };
const outcomes: Record<Surface, string> = { campaign: 'Draft saved.', booking: 'Booked.', meeting: 'Meeting scheduled.', hours: 'Booking hours saved.' };
describe.each(['ios', 'android'])('same-person business continuation on %s', (platform) => {
  for (const surface of ['campaign', 'booking', 'meeting', 'hours'] satisfies Surface[]) {
    it.each<[Phase, boolean]>([['booting', false], ['booting', true], ['refresh', false], ['refresh', true], ['mfa-outage', false], ['mfa-outage', true]])(`${surface} keeps one write through %s (ack during checking=%s)`, async (phase, duringCheck) => {
      setPlatform(platform === 'ios' ? 'ios' : 'android');
      const saved = vi.fn(); const element = await open(surface, saved);
      let release!: () => void;
      backend.pending = new Promise<void>((resolve) => { release = resolve; });
      await press(getExposed(view!.container, submits[surface])); await settle();
      expect(backend.calls).toHaveLength(1);
      backend.phase = phase; await view!.rerender(cloneElement(element)); await settle();
      if (duringCheck) { await act(async () => { release(); }); await settle(); }
      backend.phase = 'ready'; await view!.rerender(cloneElement(element)); await settle();
      if (!duringCheck) {
        // The same composing person cannot submit again while the first write awaits its answer.
        expect(exposedNames(view!.container)).toContain(submits[surface]);
        const button = getExposed(view!.container, submits[surface]);
        await press(button); expect(backend.calls).toHaveLength(1);
        await act(async () => { release(); }); await settle();
      }
      expect(view!.container.textContent).toContain(outcomes[surface]);
      expect(backend.calls).toHaveLength(1);
      if (surface !== 'hours') expect(exposedNames(view!.container)).not.toContain(submits[surface]);
      if (surface === 'meeting') expect(view!.container.textContent).toContain('Check-in code:');
      if (surface !== 'hours') expect(saved).toHaveBeenCalledOnce();
      if (surface === 'meeting') {
        await press(getExposed(view!.container, 'Schedule a meeting'));
        expect(getExposed(view!.container, 'Meeting title')).toBeDefined();
      }
    });
  }
});

describe.each(['ios', 'android'])('confirmed grant refresh keeps the composing control on %s', platform => {
  for (const surface of ['campaign', 'booking', 'meeting', 'hours'] satisfies Surface[]) {
    it(surface + ' refuses overlap until its original write settles and retains acceptance on return', async () => {
      setPlatform(platform === 'ios' ? 'ios' : 'android');
      const saved = vi.fn(); const element = await open(surface, saved);
      let finish = () => {};
      backend.pending = new Promise<void>(resolve => { finish = resolve; });
      try {
        await press(getExposed(view!.container, submits[surface])); await settle();
        expect(backend.calls).toHaveLength(1);
        backend.grant = true; await view!.rerender(cloneElement(element)); await settle();
        if (exposedNames(view!.container).includes(submits[surface])) {
          const button = getExposed(view!.container, submits[surface]);
          expect(button.getAttribute('aria-disabled')).toBe('true');
          await press(button);
        }
        expect(backend.calls).toHaveLength(1);
        await act(async () => { finish(); }); await settle();
        backend.grant = false; await view!.rerender(cloneElement(element)); await settle();
        expect(backend.calls).toHaveLength(1);
        expect(view!.container.textContent).toContain(outcomes[surface]);
        if (surface !== 'hours') expect(exposedNames(view!.container)).not.toContain(submits[surface]);
      } finally { await act(async () => { finish(); }); }
    });
  }
});
