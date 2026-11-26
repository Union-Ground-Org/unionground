import { stubSessionWriter } from '../testing/stubSessionWriter';
import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LearningPeriodApi } from '../../../../src/features/learningPeriod/api.js';
import { normalizeHistory, type LearningPeriod } from '../../../../src/features/learningPeriod/model.js';
import { learningPeriodCatalogue } from '../../../../src/lib/i18n/learningPeriod.js';
import { learningPeriodCopy, learningPeriodText } from '../lib/learningPeriodCopy';

// REQ-UG-LEARNING-PERIOD-BANNER-HISTORY-UNDO-UI-20261103 (#6947):
// native parity. Real component callbacks run against a hook shim; only the
// native host primitives, navigation and the RPC transport are substituted.
const host = vi.hoisted(() => {
  type Slot = { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void };
  let slots: Slot[] = []; let cursor = 0;
  const effects: Array<() => void> = [];
  const changed = (a?: readonly unknown[], b?: readonly unknown[]) => !a || !b || a.length !== b.length || a.some((x, i) => x !== b[i]);
  const slot = () => slots[cursor++] ?? (slots[cursor - 1] = {});
  return {
    begin() { cursor = 0; },
    flush() { effects.splice(0).forEach((fn) => fn()); },
    reset() { slots.forEach((s) => s.cleanup?.()); slots = []; effects.length = 0; this.blurs.length = 0; },
    useState(initial: unknown) { const s = slot(); if (!('value' in s)) s.value = typeof initial === 'function' ? (initial as () => unknown)() : initial; return [s.value, (next: unknown) => { s.value = typeof next === 'function' ? (next as (old: unknown) => unknown)(s.value) : next; }]; },
    useRef(initial: unknown) { const s = slot(); if (!('value' in s)) s.value = { current: initial }; return s.value; },
    useMemo(fn: () => unknown, deps: readonly unknown[]) { const s = slot(); if (changed(s.deps, deps)) { s.value = fn(); s.deps = deps; } return s.value; },
    useCallback(fn: unknown, deps: readonly unknown[]) { const s = slot(); if (changed(s.deps, deps)) { s.value = fn; s.deps = deps; } return s.value; },
    useEffect(fn: () => void | (() => void), deps?: readonly unknown[]) { const s = slot(); if (changed(s.deps, deps)) { s.deps = deps; effects.push(() => { s.cleanup?.(); s.cleanup = fn() || undefined; }); } },
    // expo-router runs a focus effect's cleanup on blur, and not again on a
    // later unmount or effect change; blur() stands for leaving the screen.
    blurs: [] as Array<() => void>,
    blur() { this.blurs.splice(0).forEach((leave) => leave()); },
    push: vi.fn(),
    announce: vi.fn(),
    rpc: vi.fn<(name: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>>(),
    app: {} as Record<string, unknown>,
  };
});
vi.mock('react', async (original) => ({ ...await original<typeof React>(), useState: host.useState, useRef: host.useRef, useMemo: host.useMemo, useCallback: host.useCallback, useEffect: host.useEffect, useLayoutEffect: host.useEffect }));
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('expo-router', () => ({
  useFocusEffect: (fn: () => void | (() => void)) => host.useEffect(() => {
    const cleanup = fn();
    let left = false;
    const leave = () => { if (!left) { left = true; cleanup?.(); } };
    host.blurs.push(leave);
    return leave;
  }, [fn]),
  useRouter: () => ({ push: host.push }),
}));
vi.mock('../components/ui', () => ({ Body: 'Body', Button: 'Button', Card: 'Card', Heading: 'Heading', Notice: 'Notice' }));
vi.mock('../services/supabase', () => ({ captureSessionWriter: (session: { user?: { id?: string } } | null) => stubSessionWriter(() => ({ rpc: host.rpc }), session?.user?.id ?? 'member-a'), createCapturedSessionRpcClient: vi.fn(() => ({ rpc: host.rpc })) }));
vi.mock('../state/AppProvider', () => ({ useApp: () => host.app }));
vi.mock('../../../../src/features/learningPeriod/undoneSignal.js', () => ({ announceLearningUndone: host.announce }));
import { NativeLearningPeriodBanner, NativeLearningPeriodCard, NativePracticeBadge, NativePracticeHistory, useNativeLearningPeriod as useNativeLearningPeriodHook, useNativeLearningPeriodApi } from './NativeLearningPeriod';

type Node = React.ReactElement<Record<string, unknown>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!React.isValidElement<Record<string, unknown>>(value)) return [];
  // Hook-free helpers render inline; the history list is a child with hooks of its own.
  if (typeof value.type === 'function') return value.type.name === 'NativePracticeHistory' ? [value] : nodes((value.type as (props: unknown) => unknown)(value.props));
  return [value, ...nodes(value.props.children)];
}
function text(value: unknown): string {
  return nodes(value).filter((node) => node.type === 'Body' || node.type === 'Heading' || node.type === 'Notice')
    .map((node) => [node.props.children].flat().filter((part) => typeof part === 'string').join('')).join('\n');
}
function buttons(tree: unknown) { return nodes(tree).filter((node) => node.type === 'Button').map((node) => node.props.label as string); }
function press(tree: unknown, label: string) {
  const button = nodes(tree).find((node) => node.type === 'Button' && node.props.label === label);
  expect(button, label).toBeDefined();
  (button?.props.onPress as () => void)();
}
const settle = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };
async function rendered<T>(render: () => T): Promise<T> {
  host.begin(); render(); host.flush(); await settle();
  host.begin(); const tree = render(); host.flush(); await settle();
  host.begin(); return render() ?? tree;
}

const DAY = 24 * 60 * 60 * 1000;
function row(id: string, actionKind: string, extra: Record<string, unknown> = {}) {
  return { id, actionKind, domain: 'tasks', disposition: 'reverse', targetTable: 'public.chapter_tasks', targetId: 'task-a', parentEntryId: null,
    state: 'active', version: 1, createdAt: '2026-11-04T14:00:00Z', undoneAt: null, keptAt: null, sent: false, undoable: true, ...extra };
}
function period(extra: Partial<LearningPeriod> = {}): LearningPeriod {
  const endAt = new Date(Date.now() + 9 * DAY).toISOString();
  return { organizationId: 'org', used: true, running: true, periodId: 'p', lengthDays: 14, startsAt: new Date(Date.now() - DAY).toISOString(),
    endsAt: endAt, endedEarlyAt: null, closedAt: null, endAt, isAdmin: false, ...extra };
}
function api(overrides: Partial<LearningPeriodApi> = {}, rows: unknown[] = [], running = true): LearningPeriodApi {
  return {
    period: vi.fn<LearningPeriodApi['period']>().mockResolvedValue(period()),
    start: vi.fn<LearningPeriodApi['start']>().mockResolvedValue(period({ isAdmin: true })),
    endEarly: vi.fn<LearningPeriodApi['endEarly']>().mockResolvedValue(period({ running: false })),
    history: vi.fn<LearningPeriodApi['history']>().mockResolvedValue({ running, entries: normalizeHistory({ entries: rows })?.entries ?? [] }),
    undo: vi.fn<LearningPeriodApi['undo']>().mockResolvedValue({ status: 'undone', undoneCount: 1 }),
    ...overrides,
  };
}
const authenticated = (overrides: Record<string, unknown> = {}) => ({ mode: 'authenticated', session: { user: { id: 'member-a' }, access_token: 'fictional-session' }, organizationID: 'org', ...overrides });

function liveClient(current: LearningPeriod | null, refusal: { code: string; hint?: string; message: string } | null = null) {
  host.app = authenticated({ mode: 'authenticated', session: { user: { id: 'member-a' }, access_token: 'fictional-session' }, sampleHat: null });
  const rpc = vi.fn(async (name: string, _args?: Record<string, unknown>): Promise<{ data: unknown; error: typeof refusal }> => {
    if (name === 'get_organization_learning_period') return { data: current, error: null };
    if (name === 'list_my_learning_history') return { data: { running: current?.running ?? false, entries: [row('e1', 'task_edit')] }, error: null };
    if (name === 'undo_my_learning_action') return { data: { status: 'undone', undoneCount: 1 }, error: null };
    return { data: current, error: refusal };
  });
  host.rpc.mockImplementation(rpc);
  return rpc;
}

afterEach(() => { host.reset(); host.push.mockReset(); host.announce.mockReset(); host.rpc.mockReset(); });

describe('native learning period copy', () => {
  const familyKinds = ['member_directory_export_request', 'survey_export_request', 'ballot_nominations_export_request', 'case_export_request',
    'organization_export_request', 'analytics_export_request', 'coordination_export_request', 'digital_action_export_request',
    'automation_activate', 'automation_definition_save', 'automation_switch',
    'case_assign', 'case_claim', 'case_access_grant', 'case_access_revoke', 'case_restriction',
    'retaliation_report_submit', 'retaliation_report_withdraw', 'retaliation_pattern_note'];
  const familyKeys = ['learningPeriod.domain.exports', 'learningPeriod.domain.automations', 'learningPeriod.domain.case_access',
    ...familyKinds.map((kind) => `learningPeriod.kind.${kind}`)] as Array<keyof typeof learningPeriodCatalogue.en>;
  for (const key of familyKeys) {
    it(`names ${key} in English and Spanish`, () => {
      expect(learningPeriodText(key)).toBe(learningPeriodCatalogue.en[key]);
      expect(learningPeriodText(key, undefined, 'es')).toBe(learningPeriodCatalogue.es[key]);
    });
  }
  it('says exactly what the web says in English, kept inside apps/mobile', () => {
    expect(learningPeriodCopy).toEqual(learningPeriodCatalogue.en);
    expect(learningPeriodText('learningPeriod.banner.ends', { when: 'Friday' })).toBe('Learning period ends Friday');
    expect(learningPeriodText('learningPeriod.banner.ends', { when: null })).toBe('Learning period ends ');
    expect(learningPeriodText('learningPeriod.kind.event_later')).toBe('learningPeriod.kind.event_later');
  });
});

describe('native learning period', () => {
  it.each(['member', 'steward', 'coordinator', 'advisor', 'admin', 'vp'])('hides the unused-period offer for the shared %s persona', async (sampleHat) => {
    liveClient(period({ used: false, running: false, isAdmin: true }));
    host.app.sampleHat = sampleHat;
    expect(await rendered(() => NativeLearningPeriodCard())).toBeNull();
  });

  it('hides End early for the shared Admin while keeping period reads, history and Undo', async () => {
    const rpc = liveClient(period({ isAdmin: true }));
    host.app.sampleHat = 'admin';
    const tree = await rendered(() => NativeLearningPeriodCard());
    expect(text(tree)).toMatch(/Learning period ends /);
    expect(buttons(tree)).not.toContain('End early');
    expect(nodes(tree).some((node) => node.type === NativePracticeHistory)).toBe(true);
    host.reset();
    const client = await rendered(() => useNativeLearningPeriodApi());
    expect(await client?.period()).toMatchObject({ isAdmin: false, running: true });
    await expect(client?.start(7)).rejects.toMatchObject({ code: 'shared-demo-account' });
    await expect(client?.endEarly()).rejects.toMatchObject({ code: 'shared-demo-account' });
    expect(rpc).not.toHaveBeenCalledWith('start_organization_learning_period', expect.anything());
    expect(rpc).not.toHaveBeenCalledWith('end_organization_learning_period_early', expect.anything());
    host.reset();
    const history = () => NativePracticeHistory({ api: client!, running: true, onChanged: vi.fn() });
    let entries = await rendered(history);
    expect(text(entries)).toContain('Your practice history');
    press(entries, 'Undo: Edited a task');
    host.begin(); entries = history();
    press(entries, 'Undo');
    await settle();
    expect(rpc).toHaveBeenCalledWith('undo_my_learning_action', { p_entry_id: 'e1', p_expected_version: 1 });
  });

  it('rebuilds the client when sampleHat changes and keeps real organization controls', async () => {
    const rpc = liveClient(period({ isAdmin: true }));
    host.app.sampleHat = 'admin';
    const persona = await rendered(() => useNativeLearningPeriodApi());
    host.app.sampleHat = null;
    const real = await rendered(() => useNativeLearningPeriodApi());
    expect(await real?.period()).toMatchObject({ isAdmin: true });
    expect(real).not.toBe(persona);
    await real?.start(7);
    await real?.endEarly();
    expect(rpc).toHaveBeenCalledWith('start_organization_learning_period', { p_length_days: 7 });
    expect(rpc).toHaveBeenCalledWith('end_organization_learning_period_early', {});
  });

  it.each(['start', 'end'])('explains a server shared-demo refusal for %s without retry or two-step advice', async (action) => {
    liveClient(period({ isAdmin: true, used: action === 'end', running: action === 'end' }),
      { code: '42501', hint: 'shared-demo-account', message: 'shared persona refused' });
    const view = () => NativeLearningPeriodCard();
    let tree = await rendered(view);
    if (action === 'end') {
      press(tree, 'End early');
      host.begin(); tree = view();
      press(tree, 'End the learning period');
    } else press(tree, 'Start the learning period');
    await settle();
    tree = await rendered(view);
    expect(text(tree)).toContain('The shared demo cannot change the learning period.');
    expect(text(tree)).not.toMatch(/try again|check your connection|complete.*two-step|check.*two-step/i);
  });

  it('keeps the ordinary start failure message for a real administrator refusal without the demo hint', async () => {
    liveClient(period({ isAdmin: true, used: false, running: false }), { code: '42501', message: 'administrator required' });
    const view = () => NativeLearningPeriodCard();
    const tree = await rendered(view);
    press(tree, 'Start the learning period');
    await settle();
    expect(text(await rendered(view))).toContain(learningPeriodText('learningPeriod.offer.failed'));
  });

  it('renders each export kind with its own label and the permanent sent state', async () => {
    const kinds: Array<'member_directory_export_request' | 'survey_export_request' | 'ballot_nominations_export_request' | 'case_export_request'> =
      ['member_directory_export_request', 'survey_export_request', 'ballot_nominations_export_request', 'case_export_request'];
    const rows = kinds.map((kind, index) => row(`export-${index}`, kind, { domain: 'exports', disposition: 'permanent', state: 'kept', undoable: false }));
    const client = api({}, rows);
    const tree = await rendered(() => NativePracticeHistory({ api: client, running: true, onChanged: vi.fn() }));
    for (const kind of kinds) expect(text(tree)).toContain(`${learningPeriodCatalogue.en[`learningPeriod.kind.${kind}`]} · Sent`);
    expect(text(tree)).not.toContain('A practice action in');
    expect(buttons(tree)).not.toContain('Undo');
  });
  it('lists available, sent, final and undone lines and undoes with the chain confirmed', async () => {
    const rows = [
      row('e3', 'task_move', { createdAt: '2026-11-04T14:03:00Z' }),
      row('s1', 'task_message', { disposition: 'permanent', state: 'kept', undoable: false, createdAt: '2026-11-04T14:02:30Z' }),
      row('e2', 'task_edit', { createdAt: '2026-11-04T14:02:00Z' }),
      row('e1', 'task_create', { createdAt: '2026-11-04T14:01:00Z' }),
      row('f1', 'task_file_remove', { disposition: 'permanent', state: 'kept', undoable: false, targetTable: 'public.chapter_task_files' }),
      row('u1', 'task_create', { targetId: 'other', state: 'undone', undoable: false }),
    ];
    const client = api({}, rows);
    const onChanged = vi.fn();
    const view = () => NativePracticeHistory({ api: client, running: true, onChanged });
    let tree = await rendered(view);
    const copy = text(tree);
    expect(copy).toContain('Sent a task message · Sent');
    expect(copy).toContain('This went out and stays sent. Undo cannot recall it.');
    expect(copy).toContain('Removed a task file · Final');
    expect(copy).toContain('You undid this. It is hidden, not erased.');
    expect(buttons(tree)).toEqual(['Refresh', 'Undo: Moved a task', 'Undo: Edited a task', 'Undo: Created a task']);
    press(tree, 'Undo: Created a task');
    host.begin(); tree = view();
    expect(text(tree)).toContain('This also undoes 2 later steps you took.');
    expect(text(tree)).toContain('Sent a task message: stays sent');
    expect(client.undo).not.toHaveBeenCalled();
    press(tree, 'Undo');
    await settle();
    expect(client.undo).toHaveBeenCalledWith('e1', 1);
    expect(onChanged).toHaveBeenCalled();
  });

  // #7027: the screens showing what an undo took back re-read it.
  it('announces the kinds an undo took back, and nothing when it is refused', async () => {
    const rows = [row('p1', 'own_channel_notifications', { domain: 'settings', targetTable: 'public.chapter_space_notification_settings', targetId: 'space:me' })];
    const client = api({}, rows);
    const view = () => NativePracticeHistory({ api: client, running: true, onChanged: vi.fn() });
    let tree = await rendered(view);
    press(tree, 'Undo: Changed your notifications for a campaign space');
    host.begin(); tree = view();
    press(tree, 'Undo');
    await settle();
    expect(host.announce).toHaveBeenCalledTimes(1);
    expect(host.announce).toHaveBeenCalledWith(expect.arrayContaining(['own_channel_notifications']));
    host.reset(); host.announce.mockReset();
    const refused = api({ undo: vi.fn<LearningPeriodApi['undo']>().mockRejectedValue(Object.assign(new Error('this has changed since your practice action'), { code: '40001' })) }, rows);
    const again = () => NativePracticeHistory({ api: refused, running: true, onChanged: vi.fn() });
    tree = await rendered(again);
    press(tree, 'Undo: Changed your notifications for a campaign space');
    host.begin(); tree = again();
    press(tree, 'Undo');
    await settle();
    expect(refused.undo).toHaveBeenCalled();
    expect(host.announce).not.toHaveBeenCalled();
  });

  it('shows the refusal on the line and offers no Undo for it', async () => {
    const client = api({ undo: vi.fn<LearningPeriodApi['undo']>().mockRejectedValue(Object.assign(new Error('someone else has changed this since'), { code: '40001' })) }, [row('e1', 'task_edit')]);
    const view = () => NativePracticeHistory({ api: client, running: true, onChanged: vi.fn() });
    let tree = await rendered(view);
    press(tree, 'Undo: Edited a task');
    host.begin(); tree = view();
    press(tree, 'Undo');
    await settle(); host.flush(); await settle();
    host.begin(); tree = view();
    expect(text(tree)).toContain('Someone else has changed this since.');
    expect(buttons(tree)).not.toContain('Undo: Edited a task');
  });

  it('reads Kept and Undone without Undo after the end', async () => {
    const client = api({}, [row('k1', 'task_edit', { state: 'kept', undoable: false }), row('u1', 'task_create', { state: 'undone', undoable: false })], false);
    const tree = await rendered(() => NativePracticeHistory({ api: client, running: false, onChanged: vi.fn() }));
    expect(text(tree)).toContain('These lines show what was kept and what you undid.');
    expect(text(tree)).toContain('Edited a task · Kept');
    expect(text(tree)).toContain('Created a task · Undone');
    expect(buttons(tree).some((label) => label.startsWith('Undo'))).toBe(false);
  });

  it('keeps the Practice badge on created items after the end and drops edit markers', () => {
    expect(text(NativePracticeBadge({ flag: 'practice', running: false }))).toBe('Practice');
    expect(text(NativePracticeBadge({ flag: 'practice_edit', running: true }))).toBe('Practice change');
    expect(NativePracticeBadge({ flag: 'practice_edit', running: false })).toBeNull();
  });

  it('shows the banner on Home and opens the history on Account', async () => {
    liveClient(period());
    const tree = await rendered(() => NativeLearningPeriodBanner());
    expect(text(tree)).toMatch(/^Learning period ends /);
    expect(text(tree)).toContain('Undo never unsends anything that already went out.');
    press(tree, 'Your practice history');
    expect(host.push).toHaveBeenCalledWith('/account');
  });

  it('shows nothing for a signed-out or restricted session', async () => {
    host.app = { mode: 'authenticated', session: null, organizationID: 'org' };
    expect(await rendered(() => NativeLearningPeriodBanner())).toBeNull();
    host.reset();
    host.app = { mode: 'authenticated', session: { user: { id: 'member-a' }, access_token: 'x' }, organizationID: 'org', sessionRestricted: true };
    expect(await rendered(() => NativeLearningPeriodCard())).toBeNull();
  });

  // REQ-UG-HOLD-LEARNING-PERIOD-OFFER-UNTIL-RELEASE-20261112 (#8581):
  // while the period is held the server's read answers null, and builds
  // already installed on iPhone and Android draw no banner, offer or Start.
  it('draws no banner, offer or Start when the server answers the period read with null', async () => {
    liveClient(null);
    expect(await rendered(() => NativeLearningPeriodBanner())).toBeNull();
    host.reset();
    const rpc = liveClient(null);
    expect(await rendered(() => NativeLearningPeriodCard())).toBeNull();
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(['get_organization_learning_period']);
  });

  // #8790 (the phone twin of #8782): a screen left open past the period's
  // end reads the period again then, and shows what the server answers.
  describe('a screen left open past the end of a running period', () => {
    const ending = () => { const endAt = new Date(Date.now() + 60 * 1000).toISOString(); return period({ endsAt: endAt, endAt }); };
    afterEach(() => { vi.useRealTimers(); });

    const offers: Array<[string, 'ended' | null]> = [['held', null], ['released', 'ended']];
    it.each(offers)('reads the period again at the end with the offer %s', async (_offer, phase) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const running = ending();
      const after = phase ? { ...running, running: false, closedAt: running.endAt } : null;
      const read = vi.fn<LearningPeriodApi['period']>().mockResolvedValueOnce(running).mockResolvedValue(after);
      const client = api({ period: read });
      const hook = () => useNativeLearningPeriodHook(client);
      const first = await rendered(hook);
      expect(first.phase).toBe('running');
      expect(read).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(61 * 1000);
      await settle();
      expect(read).toHaveBeenCalledTimes(2);
      const later = await rendered(hook);
      if (phase) {
        expect(later.phase).toBe(phase);
        expect(later.period?.running).toBe(false);
      } else {
        expect(later.period).toBeNull();
      }
      // One read at the end, not a loop.
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(read).toHaveBeenCalledTimes(2);
    });

    // A device clock ahead of the
    // server reads at the end while the server still says the period runs;
    // one more read a minute later settles it, and only one.
    it('reads once more a minute later when the read at the end still says it runs', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const running = ending();
      const read = vi.fn<LearningPeriodApi['period']>().mockResolvedValueOnce(running).mockResolvedValueOnce({ ...running }).mockResolvedValue(null);
      const client = api({ period: read });
      const hook = () => useNativeLearningPeriodHook(client);
      expect((await rendered(hook)).phase).toBe('running');
      await vi.advanceTimersByTimeAsync(61 * 1000);
      await settle();
      expect(read).toHaveBeenCalledTimes(2);
      await rendered(hook);
      await vi.advanceTimersByTimeAsync(61 * 1000);
      await settle();
      expect(read).toHaveBeenCalledTimes(3);
      expect((await rendered(hook)).period).toBeNull();
      await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
      expect(read).toHaveBeenCalledTimes(3);
    });
  });

  // A late read scheduled while the screen is blurred is
  // cleared when the screen unmounts or the client changes.
  describe('a late read scheduled on a blurred screen', () => {
    afterEach(() => { vi.useRealTimers(); });
    const blurredLateRead = async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const endAt = new Date(Date.now() + 60 * 1000).toISOString();
      const running = period({ endsAt: endAt, endAt });
      // The first read, then the end-timer read on the blurred screen, which
      // still says running (the device clock is ahead) and schedules a late read.
      const read = vi.fn<LearningPeriodApi['period']>().mockImplementation(async () => ({ ...running }));
      const client = api({ period: read });
      const hook = (current: LearningPeriodApi) => () => useNativeLearningPeriodHook(current);
      await rendered(hook(client));
      host.blur();
      await vi.advanceTimersByTimeAsync(61 * 1000);
      await settle();
      expect(read).toHaveBeenCalledTimes(2);
      return { read, hook };
    };

    it('is cleared when the screen unmounts', async () => {
      const { read } = await blurredLateRead();
      host.reset();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(read).toHaveBeenCalledTimes(2);
    });

    it('is cleared when the client changes', async () => {
      const { read, hook } = await blurredLateRead();
      const next = api({ period: vi.fn<LearningPeriodApi['period']>().mockResolvedValue(null) });
      await rendered(hook(next));
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(read).toHaveBeenCalledTimes(2);
    });
  });

  it('lets an administrator end early only after the one-way confirmation', async () => {
    const rpc = liveClient(period({ isAdmin: true }));
    host.rpc.mockImplementation(async (name: string, args?: Record<string, unknown>) => (name === 'end_organization_learning_period_early'
      ? { data: period({ isAdmin: true, running: false, endedEarlyAt: new Date().toISOString() }), error: null }
      : rpc(name, args)));
    const view = () => NativeLearningPeriodCard();
    let tree = await rendered(view);
    expect(text(tree)).toContain("Your organization's learning period is running.");
    expect(text(tree)).toContain('People who join later do not get a separate period.');
    press(tree, 'End early');
    host.begin(); tree = view();
    expect(text(tree)).toContain('Ending cannot be reversed, and the period cannot be started again.');
    press(tree, 'End the learning period');
    await settle(); host.flush(); await settle();
    host.begin(); tree = view(); host.flush(); await settle();
    host.begin(); tree = view();
    expect(text(tree)).toContain('The learning period has ended. Everything done during it is kept.');
  });
});
