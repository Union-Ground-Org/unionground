import { stubSessionWriter } from '../../testing/stubSessionWriter';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import palette from '../../theme/palette.json';
import { contrastRatio } from '../../theme/contrast';
import { connectionDraft, nativeConnectionCopy, type ConnectionActor } from '../../lib/connectionSuggestionsShared';
import { normalizeConnectionWorkspace } from '../../services/chapterConnections';

// A small synchronous hook host executes the shipped callbacks. The native and
// authenticated network boundaries are mocked; matching math remains shared.
const host = vi.hoisted(() => {
  type Slot = { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void };
  const slots: Slot[] = []; let cursor = 0; const pending: Array<() => void> = [];
  const listeners = new Set<(state: string) => void>();
  const changed = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined) => !a || !b || a.length !== b.length || a.some((value, i) => value !== b[i]);
  const slot = () => { const index = cursor++; return slots[index] ?? (slots[index] = {}); };
  return {
    start: () => { cursor = 0; },
    dispose: () => { slots.forEach((entry) => entry.cleanup?.()); slots.length = 0; pending.length = 0; listeners.clear(); },
    flush: () => { pending.splice(0).forEach((effect) => effect()); },
    useState: (initial: unknown) => {
      const entry = slot(); if (!('value' in entry)) entry.value = typeof initial === 'function' ? initial() : initial;
      return [entry.value, (next: unknown) => { entry.value = typeof next === 'function' ? next(entry.value) : next; }];
    },
    useRef: (initial: unknown) => { const entry = slot(); if (!('value' in entry)) entry.value = { current: initial }; return entry.value; },
    useMemo: (factory: () => unknown, deps: readonly unknown[]) => { const entry = slot(); if (changed(entry.deps, deps)) { entry.value = factory(); entry.deps = deps; } return entry.value; },
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const entry = slot(); if (changed(entry.deps, deps)) { entry.deps = deps; pending.push(() => { entry.cleanup?.(); entry.cleanup = effect() || undefined; }); }
    },
    addListener: (listener: (state: string) => void) => { listeners.add(listener); return { remove: () => listeners.delete(listener) }; },
    background: () => { listeners.forEach((listener) => listener('background')); },
    rpc: vi.fn<(...args: unknown[]) => Promise<{ data: unknown; error: unknown }>>(),
    announce: vi.fn(), theme: 'union-ground' as keyof typeof palette, platform: 'ios',
    app: {} as Record<string, unknown>,
  };
});
vi.mock('react', async (original) => ({ ...await original<typeof React>(), useState: host.useState, useRef: host.useRef, useMemo: host.useMemo, useCallback: (fn: () => unknown, deps: readonly unknown[]) => host.useMemo(() => fn, deps), useEffect: host.useEffect, useLayoutEffect: host.useEffect }));
vi.mock('react-native', () => ({ Platform: { get OS() { return host.platform; } }, View: 'View', Text: 'Text', TextInput: 'TextInput', Modal: 'Modal',
  StyleSheet: { create: (value: unknown) => value }, AppState: { addEventListener: (_: string, listener: (state: string) => void) => host.addListener(listener) } }));
vi.mock('../../components/PressableScale', () => ({ PressableScale: 'PressableScale' }));
vi.mock('../../components/ui', () => ({ Body: 'Body', Button: 'Button', Card: 'Card', Heading: 'Heading', Screen: 'Screen', StateMessage: 'StateMessage', StatusPill: 'StatusPill' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'sample-request-key' }));
vi.mock('../../services/haptics', () => ({ haptics: { select: vi.fn() } }));
vi.mock('../../theme/ThemeProvider', () => ({ useTheme: () => palette[host.theme] }));
vi.mock('../../services/supabase', () => ({ captureSessionWriter: (session: { user?: { id?: string } } | null) => stubSessionWriter(() => ({ rpc: host.rpc }), session?.user?.id ?? 'member-a'),  getSupabaseClient: () => ({ rpc: host.rpc }) }));
vi.mock('../../state/AppProvider', () => ({ useApp: () => host.app }));
vi.mock('../../lib/announce', () => ({ useAccessibilityAnnouncementQueue: () => host.announce }));

import { ConnectionDial, ConnectionField, ConnectionToggle } from './ConnectionControls';
import { ConnectionProfileEditor } from './ConnectionProfileEditor';
import { ConnectionSourceReview } from './ConnectionSourceReview';
import { ConnectionSession, ConnectionSuggestionsPanel } from './ConnectionSuggestionsPanel';
import { ConnectionHandshakeRequest } from './ConnectionHandshakeRequest';
import type { ConnectionMatch } from '../../lib/connectionSuggestionsShared';

type Node = React.ReactElement<Record<string, unknown> & { children?: React.ReactNode; action?: React.ReactNode }>;
function elements(node: React.ReactNode): Node[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement(node)) return [];
  const element = node as Node;
  return [element, ...elements(element.props.children), ...elements(element.props.action)];
}
function find(node: React.ReactNode, predicate: (entry: Node) => boolean): Node {
  const element = elements(node).find(predicate); if (!element) throw new Error('Missing expected element'); return element;
}
function byLabel(tree: React.ReactNode, label: string) { return find(tree, (entry) => entry.props.label === label || entry.props.accessibilityLabel === label); }
function press(node: Node) { (node.props.onPress as () => void)(); }
function change(node: Node, value: unknown) { (node.props.onChange as (next: unknown) => void)(value); }
function render<T>(component: () => T): T { host.start(); const tree = component(); host.flush(); return tree; }
async function settle() { for (let i = 0; i < 12; i += 1) await Promise.resolve(); }
const tr = nativeConnectionCopy('en');
const actor: ConnectionActor = { userId: 'person-a', organizationId: 'org-a', chapterId: 'chapter-a', selectedHat: 'admin', organizationRoles: ['admin'], chapterRoles: [], membershipStatus: 'active', mfaSatisfied: true };
const profile = (id: string) => ({ id, kind: 'chapter', displayName: id, discoverable: true, publishedAt: new Date().toISOString(),
  location: { country: 'US', state: 'MA', metro: 'Boston' }, sectorKeys: ['care'], issuePriorities: [{ key: 'staffing', strength: 1 }], expertiseOffered: ['staffing'] });
const workspace = () => ({ organizationId: actor.organizationId, chapterId: actor.chapterId, chapterName: 'Campaign A', profile: profile('chapter-a'),
  draft: connectionDraft({ location: { country: 'US', state: 'MA', metro: 'Boston' }, declaredIssueKeys: ['staffing'] }), canPublish: true,
  hiddenChapterIds: [], analysis: { nextPeriodKey: '2026-Q2', nextPeriodFrozen: false } });
beforeEach(() => { host.dispose(); host.rpc.mockReset(); host.announce.mockReset(); });
afterEach(() => host.dispose());

describe('native connection controls and privacy', () => {
  it('offers adjustable screen-reader actions and touch controls with bounded values', () => {
    const onChange = vi.fn(); const tree = ConnectionDial({ label: 'Location', help: 'Public place', value: 0, onChange, tr });
    const adjustable = find(tree, (node) => node.props.accessibilityRole === 'adjustable');
    expect(adjustable.props.accessibilityValue).toEqual({ min: 0, max: 100, now: 0 });
    const action = adjustable.props.onAccessibilityAction as (event: { nativeEvent: { actionName: string } }) => void;
    action({ nativeEvent: { actionName: 'decrement' } }); expect(onChange).not.toHaveBeenCalled();
    action({ nativeEvent: { actionName: 'increment' } }); expect(onChange).toHaveBeenLastCalledWith(1);
    expect(host.announce).not.toHaveBeenCalled();
    press(byLabel(tree, 'Increase Location: 5, 0/100')); expect(onChange).toHaveBeenLastCalledWith(5);
    expect(host.announce).toHaveBeenLastCalledWith('Location: 5');
    expect(byLabel(tree, 'Decrease Location: 5, 0/100').props.accessibilityState).toEqual({ disabled: true });
    const full = ConnectionDial({ label: 'Location', help: '', value: 99, onChange, tr });
    press(byLabel(full, 'Increase Location: 5, 99/100')); expect(onChange).toHaveBeenLastCalledWith(100);
    expect(host.announce).toHaveBeenLastCalledWith('Location: 100');
  });

  it('requires fresh publication consent after any field changes', () => {
    const onPublish = vi.fn();
    const draw = () => render(() => ConnectionProfileEditor({ workspace: normalizeConnectionWorkspace(workspace()), busy: false, onPublish, onWithdraw: vi.fn(), tr }));
    let tree = draw(); expect(byLabel(tree, tr('save')).props.disabled).toBe(true);
    change(byLabel(tree, tr('consent')), true); tree = draw(); expect(byLabel(tree, tr('save')).props.disabled).toBe(false);
    change(byLabel(tree, tr('metroLabel')), 'Cambridge'); tree = draw(); expect(byLabel(tree, tr('save')).props.disabled).toBe(true);
    change(byLabel(tree, tr('consent')), true); tree = draw(); press(byLabel(tree, tr('save')));
    expect(onPublish).toHaveBeenCalledWith(expect.objectContaining({ location: { country: 'US', state: 'MA', metro: 'Cambridge' }, declaredIssueKeys: ['staffing'] }));
  });

  it('provides field format hints, trims pasted codes and keeps metro publication disabled without a region', () => {
    const draw = () => render(() => ConnectionProfileEditor({ workspace: normalizeConnectionWorkspace(workspace()), busy: false, onPublish: vi.fn(), onWithdraw: vi.fn(), tr }));
    let tree = draw();
    expect(byLabel(tree, tr('countryLabel')).props.hint).toBe(tr('locationFormat'));
    const field = ConnectionField({ label: tr('countryLabel'), value: '', onChange: vi.fn(), maxLength: 8, hint: tr('locationFormat') });
    expect(byLabel(field, tr('countryLabel')).props.accessibilityHint).toBe(tr('locationFormat'));
    change(byLabel(tree, tr('countryLabel')), ' us '); tree = draw(); expect(byLabel(tree, tr('countryLabel')).props.value).toBe('US');
    change(byLabel(tree, tr('stateLabel')), ''); tree = draw();
    change(byLabel(tree, tr('consent')), true); tree = draw(); expect(byLabel(tree, tr('save')).props.disabled).toBe(true);
    change(byLabel(tree, tr('stateLabel')), ' ma '); tree = draw(); expect(byLabel(tree, tr('stateLabel')).props.value).toBe('MA');
    change(byLabel(tree, tr('consent')), true); tree = draw(); expect(byLabel(tree, tr('save')).props.disabled).toBe(false);
  });

  it('proposes tags locally, requires human confirmation, and sends only source identifiers and topics', () => {
    const onReview = vi.fn();
    const draw = () => render(() => ConnectionSourceReview({ workspace: normalizeConnectionWorkspace(workspace()), busy: false, onReview, onFreeze: vi.fn(), tr }));
    let tree = draw();
    change(byLabel(tree, tr('sourceId')), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'); tree = draw();
    change(byLabel(tree, tr('sourceText')), 'Private person details: unsafe staffing and overtime scheduling.'); tree = draw();
    press(byLabel(tree, tr('propose'))); tree = draw();
    expect(byLabel(tree, tr('saveReview')).props.disabled).toBe(true); expect(host.rpc).not.toHaveBeenCalled();
    change(byLabel(tree, tr('reviewConsent')), true); tree = draw(); press(byLabel(tree, tr('saveReview')));
    expect(onReview).toHaveBeenCalledOnce();
    const payload = onReview.mock.calls[0]![0]; expect(Object.keys(payload).sort()).toEqual(['sourceId', 'sourceKind', 'topicKeys']);
    expect(payload.topicKeys).toContain('staffing'); expect(JSON.stringify(payload)).not.toContain('Private person');
    onReview.mock.calls[0]![1](); tree = draw(); expect(byLabel(tree, tr('sourceText')).props.value).toBe('');
  });

  it('clears raw text and consent on backgrounding and refuses freezing without confirmation', () => {
    const onFreeze = vi.fn();
    const draw = () => render(() => ConnectionSourceReview({ workspace: normalizeConnectionWorkspace(workspace()), busy: false, onReview: vi.fn(), onFreeze, tr }));
    let tree = draw(); change(byLabel(tree, tr('sourceText')), 'Private source'); tree = draw();
    change(byLabel(tree, tr('freezeConsent')), true); tree = draw(); expect(byLabel(tree, tr('freeze')).props.disabled).toBe(false);
    host.background(); tree = draw(); expect(byLabel(tree, tr('sourceText')).props.value).toBe(''); expect(byLabel(tree, tr('freeze')).props.disabled).toBe(true);
    press(byLabel(tree, tr('freeze'))); expect(onFreeze).not.toHaveBeenCalled();
  });

  it('uses readable active and disabled semantic pairs in every light and dark palette', () => {
    for (const theme of Object.values(palette)) {
      for (const [fg, bg] of [[theme.primaryForeground, theme.primary], [theme.secondaryForeground, theme.secondary],
        [theme.mutedForeground, theme.muted], [theme.cardForeground, theme.card], [theme.foreground, theme.input]]) {
        expect(contrastRatio(fg!, bg!)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

describe('native connection session rendering', () => {
  it.each(['declined', 'closed'] as const)('reports a %s replay to both the panel and its parent lifecycle', async (status) => {
    const onHandshakeRequested = vi.fn();
    host.rpc.mockImplementation(async (name) => ({ data: name === 'get_chapter_connection_workspace' ? { ...workspace(), canRequestHandshake: true }
      : name === 'request_chapter_connection_handshake' ? { id: 'request-id', status, chapter_id: 'chapter-a', receiving_chapter_id: 'other' }
        : { rows: [{ ...profile('other'), handshake: { eligible: true, partnerOrgId: 'verified-org' } }], complete: true, nextCursor: null, snapshotToken: 'snapshot' }, error: null }));
    const draw = () => render(() => ConnectionSession({ actor, mode: 'authenticated', tr, onHandshakeRequested }));
    draw(); await settle(); let tree = draw();
    (find(tree, (node) => typeof node.props.onRequest === 'function').props.onRequest as () => void)(); tree = draw();
    const submit = find(tree, (node) => node.type === ConnectionHandshakeRequest).props.onSubmit as (value: unknown) => Promise<void>;
    await submit({ title: 'Training', purpose: 'Approved lessons', dataScope: 'docs_only', idempotencyKey: 'original-key' });
    tree = draw();
    const noticeKey = status === 'declined' ? 'handshakeDeclined' : 'handshakeClosed';
    expect(elements(tree).some((node) => node.props.label === tr(noticeKey))).toBe(true);
    expect(elements(tree).some((node) => node.props.label === tr('handshakeSent'))).toBe(false);
    expect(onHandshakeRequested).toHaveBeenCalledWith(expect.objectContaining({ noticeKey }));
  });

  it('opens an explicit handshake request only for an eligible published target, then submits the exact selected campaign and hat', async () => {
    const onHandshakeRequested = vi.fn();
    const target = { ...profile('other'), handshake: { eligible: true, partnerOrgId: 'verified-org' } };
    host.rpc.mockImplementation(async (name) => ({ data: name === 'get_chapter_connection_workspace' ? { ...workspace(), canRequestHandshake: true }
      : name === 'request_chapter_connection_handshake' ? { id: 'request-id', status: 'requested', chapter_id: 'chapter-a', receiving_chapter_id: 'other' }
        : { rows: [target, profile('unverified')], complete: true, nextCursor: null, snapshotToken: 'snapshot' }, error: null }));
    const draw = () => render(() => ConnectionSession({ actor, mode: 'authenticated', tr, onHandshakeRequested }));
    draw(); await settle(); let tree = draw();
    const matches = elements(tree).filter((node) => node.props.match);
    const eligible = matches.find((node) => (node.props.match as ConnectionMatch).id === 'other')!;
    const ineligible = matches.find((node) => (node.props.match as ConnectionMatch).id === 'unverified')!;
    expect(ineligible.props.onRequest).toBeUndefined();
    (eligible.props.onRequest as () => void)(); tree = draw();
    const sheet = find(tree, (node) => node.type === ConnectionHandshakeRequest);
    expect(sheet.props.target).toMatchObject({ id: 'other' });
    // The organization's default weights are one member-safe configuration read (inventory B13).
    expect(host.rpc.mock.calls.filter(([name]) => name !== 'get_member_organization_configuration')).toHaveLength(2);
    const fields = { title: ' Training ', purpose: ' Share approved lessons ', dataScope: 'docs_only', idempotencyKey: 'one-request' };
    await (sheet.props.onSubmit as (value: unknown) => Promise<void>)(fields);
    expect(host.rpc).toHaveBeenLastCalledWith('request_chapter_connection_handshake', {
      p_selected_hat: 'admin', p_chapter_id: 'chapter-a', p_target_chapter_id: 'other', p_title: 'Training',
      p_purpose: 'Share approved lessons', p_data_scope: 'docs_only', p_idempotency_key: 'one-request',
    });
    expect(onHandshakeRequested).toHaveBeenCalledWith(expect.objectContaining({ target: expect.objectContaining({ id: 'other' }), fields }));
  });

  it('keeps readable suggestions without a request action when current campaign authority is absent', async () => {
    host.rpc.mockImplementation(async (name) => ({ data: name === 'get_chapter_connection_workspace' ? workspace()
      : { rows: [{ ...profile('other'), handshake: { eligible: true, partnerOrgId: 'verified-org' } }], complete: true, nextCursor: null, snapshotToken: 'snapshot' }, error: null }));
    const draw = () => render(() => ConnectionSession({ actor, mode: 'authenticated', tr }));
    draw(); await settle(); const matches = elements(draw()).filter((node) => node.props.match);
    expect(matches).toHaveLength(1); expect(matches[0]!.props.onRequest).toBeUndefined();
  });

  it('returns a fictional request to the preview lifecycle without calling the live backend', async () => {
    const onHandshakeRequested = vi.fn();
    const draw = () => render(() => ConnectionSession({ actor, mode: 'preview', tr, onHandshakeRequested }));
    draw(); let tree = draw();
    const match = find(tree, (node) => typeof node.props.onRequest === 'function');
    (match.props.onRequest as () => void)(); tree = draw();
    const sheet = find(tree, (node) => node.type === ConnectionHandshakeRequest);
    await (sheet.props.onSubmit as (value: unknown) => Promise<void>)({ title: 'Sample training', purpose: 'Fictional exchange', dataScope: 'docs_only', idempotencyKey: 'sample-only' });
    expect(onHandshakeRequested).toHaveBeenCalledWith(expect.objectContaining({ fields: expect.objectContaining({ title: 'Sample training' }) }));
    expect(host.rpc).not.toHaveBeenCalled();
  });

  it('discards a late handshake completion after the session scope unmounts', async () => {
    let finish!: () => void;
    const pending = new Promise<{ data: unknown; error: null }>((resolve) => { finish = () => resolve({ data: { id: 'request-id', status: 'requested', chapter_id: 'chapter-a', receiving_chapter_id: 'other' }, error: null }); });
    const onHandshakeRequested = vi.fn();
    host.rpc.mockImplementation(async (name) => name === 'request_chapter_connection_handshake' ? pending : { data: name === 'get_chapter_connection_workspace' ? { ...workspace(), canRequestHandshake: true }
      : { rows: [{ ...profile('other'), handshake: { eligible: true, partnerOrgId: 'verified-org' } }], complete: true, nextCursor: null, snapshotToken: 'snapshot' }, error: null });
    const draw = () => render(() => ConnectionSession({ actor, mode: 'authenticated', tr, onHandshakeRequested }));
    draw(); await settle(); let tree = draw();
    (find(tree, (node) => typeof node.props.onRequest === 'function').props.onRequest as () => void)(); tree = draw();
    const submit = find(tree, (node) => node.type === ConnectionHandshakeRequest).props.onSubmit as (value: unknown) => Promise<void>;
    const result = submit({ title: 'Training', purpose: 'Approved lessons', dataScope: 'docs_only', idempotencyKey: 'stable-key' });
    host.dispose(); finish(); await result;
    expect(onHandshakeRequested).not.toHaveBeenCalled();
  });

  it('requires nonempty request fields and prevents duplicate taps while preserving the retry key', async () => {
    let reject!: () => void;
    const onSubmit = vi.fn(() => new Promise<void>((_, fail) => { reject = () => fail(new Error('lost reply')); }));
    const onClose = vi.fn();
    const target = { ...profile('other') } as ConnectionMatch;
    const draw = () => render(() => ConnectionHandshakeRequest({ target, preview: false, tr, onSubmit, onClose }));
    let tree = draw(); expect(byLabel(tree, tr('handshakeSend')).props.disabled).toBe(true);
    press(byLabel(tree, tr('handshakeSend'))); expect(onSubmit).not.toHaveBeenCalled();
    change(byLabel(tree, tr('handshakeTitle')), 'Training'); tree = draw();
    change(byLabel(tree, tr('handshakePurpose')), 'Share approved lessons'); tree = draw();
    press(byLabel(tree, tr('handshakeSend'))); press(byLabel(tree, tr('handshakeSend')));
    expect(onSubmit).toHaveBeenCalledTimes(1); expect(onClose).not.toHaveBeenCalled();
    reject(); await settle(); tree = draw();
    expect(elements(tree).some((node) => node.props.accessibilityRole === 'alert')).toBe(true);
    press(byLabel(tree, tr('handshakeSend')));
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit.mock.calls[0]).toEqual(onSubmit.mock.calls[1]);
    reject(); await settle();
  });

  it('keeps a backgrounded in-flight attempt alive and reuses its key after a lost reply', async () => {
    let reject!: () => void;
    const onSubmit = vi.fn().mockImplementationOnce(() => new Promise<void>((_, fail) => { reject = () => fail(new Error('lost reply')); })).mockResolvedValue(undefined);
    const onClose = vi.fn();
    const target = { ...profile('other') } as ConnectionMatch;
    const draw = () => render(() => ConnectionHandshakeRequest({ target, preview: false, tr, onSubmit, onClose }));
    let tree = draw();
    change(byLabel(tree, tr('handshakeTitle')), 'Training'); tree = draw();
    change(byLabel(tree, tr('handshakePurpose')), 'Share approved lessons'); tree = draw();
    press(byLabel(tree, tr('handshakeSend')));
    host.background(); tree = draw();
    expect(onClose).not.toHaveBeenCalled();
    expect(byLabel(tree, tr('handshakeSend')).props.disabled).toBe(true);
    expect(byLabel(tree, tr('handshakeTitle')).props.value).toBe('Training');
    reject(); await settle(); tree = draw();
    press(byLabel(tree, tr('handshakeSend'))); await settle();
    expect(onSubmit).toHaveBeenCalledTimes(2);
    expect(onSubmit.mock.calls[1]).toEqual(onSubmit.mock.calls[0]);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('clears an unsent handshake draft on backgrounding', () => {
    const onClose = vi.fn();
    const target = { ...profile('other') } as ConnectionMatch;
    const draw = () => render(() => ConnectionHandshakeRequest({ target, preview: false, tr, onSubmit: vi.fn(), onClose }));
    let tree = draw(); change(byLabel(tree, tr('handshakeTitle')), 'Unsent draft');
    host.background(); tree = draw();
    expect(onClose).toHaveBeenCalledOnce();
    expect(byLabel(tree, tr('handshakeTitle')).props.value).toBe('');
  });

  it.each(['steward', 'coordinator', 'advisor', 'admin', 'vp'])('selects the sole granted %s role when constructing the native actor', (role) => {
    host.app = { mode: 'authenticated', dashboard: { member: { id: 'person-a', chapterID: 'chapter-a', language: 'en' } },
      organizationID: 'org-a', chapterMemberships: [], organizationRoles: [], chapterRoles: [role], locked: false, assuranceUnavailable: false };
    const tree = ConnectionSuggestionsPanel() as React.ReactElement<{ actor: ConnectionActor }>;
    expect(tree.props.actor.selectedHat).toBe(role);
  });

  it.each<'ios' | 'android'>(['ios', 'android'])('round 1 post-write reload stops pagination after unmount on %s', async os => {
    host.platform = os;
    let activeUser = 'account-A', workspaces = 0;
    const profileReaders: string[] = [];
    let entered!: () => void, release!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const response = new Promise<void>(resolve => { release = resolve; });
    host.rpc.mockImplementation(async name => {
      if (name === 'get_chapter_connection_workspace') {
        if (++workspaces === 2) { entered(); await response; }
        return { data: workspace(), error: null };
      }
      if (name === 'list_chapter_connection_profiles') profileReaders.push(activeUser);
      return { data: name === 'save_chapter_connection_profile' ? {} : { rows: [profile('other')], complete: true, nextCursor: null, snapshotToken: 'snapshot' }, error: null };
    });
    const draw = () => render(() => ConnectionSession({ actor, mode: 'authenticated', tr }));
    draw(); await settle(); let tree = draw(); press(byLabel(tree, tr('edit'))); tree = draw();
    (find(tree, node => node.type === ConnectionProfileEditor).props.onPublish as (draft: unknown) => void)(workspace().draft);
    await waiting;
    host.dispose(); activeUser = 'account-B'; release(); await settle(); await settle();
    expect(profileReaders).toEqual(['account-A']);
    expect(host.rpc.mock.calls.filter(([name]) => name === 'save_chapter_connection_profile')).toHaveLength(1);
  });

  it('distinguishes a completed publication from its failed refresh, and retry only reloads', async () => {
    let workspaces = 0;
    host.rpc.mockImplementation(async (name) => {
      if (name === 'get_chapter_connection_workspace') {
        workspaces += 1;
        return workspaces === 2 ? { data: null, error: new Error('offline') } : { data: workspace(), error: null };
      }
      return { data: name === 'save_chapter_connection_profile' ? {} : { rows: [profile('other')], complete: true, nextCursor: null, snapshotToken: 'snapshot' }, error: null };
    });
    const draw = () => render(() => ConnectionSession({ actor, mode: 'authenticated', tr }));
    draw(); await settle(); let tree = draw(); press(byLabel(tree, tr('edit'))); tree = draw();
    const editor = find(tree, (node) => node.type === ConnectionProfileEditor);
    (editor.props.onPublish as (draft: unknown) => void)(workspace().draft); await settle(); tree = draw();
    expect(elements(tree).some((node) => node.props.label === tr('refreshAfterWriteError'))).toBe(true);
    expect(host.announce).toHaveBeenLastCalledWith(tr('refreshAfterWriteError'));
    expect(elements(tree).some((node) => node.props.label === tr('saved') || node.props.label === tr('saveError'))).toBe(false);
    expect(elements(tree).filter((node) => node.props.match)).toHaveLength(0);
    press(byLabel(tree, tr('retry'))); draw(); await settle(); tree = draw();
    expect(elements(tree).filter((node) => node.props.match)).toHaveLength(1);
    expect(elements(tree).some((node) => node.props.label === tr('refreshAfterWriteError'))).toBe(false);
    expect(host.rpc.mock.calls.filter(([name]) => name === 'save_chapter_connection_profile')).toHaveLength(1);
  });

  it('shows a load error instead of rendering when hidden identifiers are malformed', async () => {
    host.rpc.mockResolvedValue({ data: { ...workspace(), hiddenChapterIds: ['malformed block'] }, error: null });
    const draw = () => render(() => ConnectionSession({ actor, mode: 'authenticated', tr }));
    draw(); await settle(); const tree = draw();
    expect(elements(tree).some((node) => node.props.title === tr('error'))).toBe(true);
    expect(elements(tree).filter((node) => node.props.match)).toHaveLength(0);
    // The organization's default weights are one member-safe configuration read (inventory B13).
    expect(host.rpc.mock.calls.filter(([name]) => name !== 'get_member_organization_configuration')).toHaveLength(1);
  });
  it('uses actual authenticated RPC data, shows more suggestions, and exposes six controls', async () => {
    const rows = Array.from({ length: 30 }, (_, index) => profile(`row-${String(index).padStart(2, '0')}`));
    host.rpc.mockImplementation(async (name) => ({ data: name === 'get_chapter_connection_workspace' ? workspace()
      : { rows, complete: true, nextCursor: null, snapshotToken: 'snapshot' }, error: null }));
    const draw = () => render(() => ConnectionSession({ actor, mode: 'authenticated', tr }));
    draw(); await settle(); let tree = draw();
    // The organization's default weights are one member-safe configuration read (inventory B13).
    expect(host.rpc.mock.calls.filter(([name]) => name !== 'get_member_organization_configuration')).toHaveLength(2);
    expect(elements(tree).filter((node) => node.props.match)).toHaveLength(12);
    press(byLabel(tree, tr('showMore'))); tree = draw(); expect(elements(tree).filter((node) => node.props.match)).toHaveLength(24);
    press(byLabel(tree, tr('tuneOpen'))); tree = draw();
    const dials = elements(tree).filter((node) => node.type === ConnectionDial);
    expect(dials.map((node) => node.props.label)).toEqual(['Location', 'Sectors', 'Shared issues', 'Committee expertise', 'Same local', 'Same union', 'Result variety']);
    change(dials[0]!, 80); tree = draw(); expect(elements(tree).filter((node) => node.props.match)).toHaveLength(12);
  });

  it('never replaces failed authenticated requests with fictional campaigns', async () => {
    host.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } });
    const draw = () => render(() => ConnectionSession({ actor, mode: 'authenticated', tr }));
    draw(); await settle(); const tree = draw();
    expect(elements(tree).filter((node) => node.props.match)).toHaveLength(0);
    expect(elements(tree).some((node) => node.props.title === tr('unavailable'))).toBe(true);
    expect(elements(tree).some((node) => node.props.label === tr('preview'))).toBe(false);
  });

  it('only explicit preview creates fictional matches without calling Supabase', () => {
    const draw = () => render(() => ConnectionSession({ actor, mode: 'preview', tr }));
    draw(); const tree = draw();
    expect(elements(tree).some((node) => node.props.label === tr('preview'))).toBe(true);
    expect(elements(tree).filter((node) => node.props.match).length).toBeGreaterThan(0);
    expect(host.rpc).not.toHaveBeenCalled();
  });

  it('blocks duplicate publication taps while the first authenticated write is pending', async () => {
    let complete!: () => void;
    const pending = new Promise<{ data: unknown; error: null }>((resolve) => { complete = () => resolve({ data: {}, error: null }); });
    host.rpc.mockImplementation(async (name) => {
      if (name === 'save_chapter_connection_profile') return pending;
      return { data: name === 'get_chapter_connection_workspace' ? workspace() : { rows: [], complete: true, nextCursor: null, snapshotToken: 'snapshot' }, error: null };
    });
    const draw = () => render(() => ConnectionSession({ actor, mode: 'authenticated', tr }));
    draw(); await settle(); let tree = draw(); press(byLabel(tree, tr('edit'))); tree = draw();
    const editor = find(tree, (node) => node.type === ConnectionProfileEditor);
    const publish = editor.props.onPublish as (draft: unknown) => void;
    const draft = normalizeConnectionWorkspace(workspace()).draft!; publish(draft); publish(draft); await settle();
    expect(host.rpc.mock.calls.filter(([name]) => name === 'save_chapter_connection_profile')).toHaveLength(1);
    host.dispose(); complete(); await settle();
    expect(host.rpc.mock.calls.filter(([name]) => name === 'get_chapter_connection_workspace')).toHaveLength(1);
  });
});
