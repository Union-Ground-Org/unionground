import { stubSessionWriter } from '../testing/stubSessionWriter';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import palette from '../theme/palette.json';
import type { LivedInEvent, LivedInTask } from '../services/livedIn';
import { eventCheckInCatalogue } from '../../../../src/lib/i18n/eventCheckIn.js';
import { eventRsvpClosedText } from '../lib/eventModelShared';
// The survey card and unit editors import the shared draft hook, whose attempt keys come from expo-crypto (#9240 pull request D).
vi.mock('expo-crypto', () => ({ randomUUID: () => 'attempt-key' }));

// BUG-UG-NATIVE-EVENTS-LIST-RESETS-TO-TOP-AFTER-RSVP-20261009: a
// saved RSVP or check-in used to bump the reload key, which replaced the list
// with "Loading events" and remounted it at its oldest event. A small
// synchronous hook host runs the shipped screen; the network is mocked.
const host = vi.hoisted(() => {
  type Slot = { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void };
  const slots: Slot[] = []; let cursor = 0; const pending: Array<() => void> = [];
  const changed = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined) => !a || !b || a.length !== b.length || a.some((value, i) => value !== b[i]);
  const slot = () => { const index = cursor++; return slots[index] ?? (slots[index] = {}); };
  return {
    start: () => { cursor = 0; },
    dispose: () => { slots.forEach((entry) => entry.cleanup?.()); slots.length = 0; pending.length = 0; },
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
    load: vi.fn<() => Promise<LivedInEvent[]>>(),
    rsvp: vi.fn<(eventID: string, status: string) => Promise<void>>(),
    checkIn: vi.fn<(eventID: string, code: string) => Promise<void>>(),
    app: { captureAuthenticatedSessionGuard: () => () => true, authorizedRoles: ['member'], dashboard: null, mode: 'live', sampleHat: null, liveSampleBackend: false, memberLanguage: 'en' },
  };
});
vi.mock('./guideLayers/GuideLayers', () => ({ NativeFeatureGuide: () => null, NativeCoachMark: () => null, NativeOrgStartGuide: () => null }));
vi.mock('react', async (original) => ({ ...await original<typeof React>(), useState: host.useState, useRef: host.useRef, useMemo: host.useMemo, useCallback: (callback: () => unknown, deps: readonly unknown[]) => host.useMemo(() => callback, deps), useEffect: host.useEffect, useLayoutEffect: host.useEffect }));
vi.mock('react-native', () => ({ View: 'View', Text: 'Text', TextInput: 'TextInput', Pressable: 'Pressable', Platform: { OS: 'android' }, StyleSheet: { create: (value: unknown) => value } }));
vi.mock('expo-router', () => ({ useIsFocused: () => true, useNavigation: () => ({ setOptions: () => {} }) }));
vi.mock('../lib/screenBack', () => ({ useScreenBackInterceptor: () => {} }));
vi.mock('../components/ui', () => ({ Body: 'Body', Button: 'Button', Card: 'Card', Heading: 'Heading', Notice: 'Notice', Screen: 'Screen', StateMessage: 'StateMessage' }));
vi.mock('./RightsResumeReading', () => ({ ContinueReadingCard: 'ContinueReadingCard', RightsReadingSections: 'RightsReadingSections', rightsBookmarks: {}, useRightsBookmark: () => null, useRightsReadingScope: () => null }));
vi.mock('../components/WorkflowActions', () => ({ WorkflowActions: 'WorkflowActions' }));
vi.mock('../components/AskCompassButton', () => ({ AskCompassButton: 'AskCompassButton' }));
vi.mock('../components/AttachmentPanel', () => ({ AttachmentPanel: 'AttachmentPanel' }));
vi.mock('../components/QuarterlySurveyGate', () => ({ QuarterlySurveyGate: 'QuarterlySurveyGate' }));
vi.mock('./ContextualPulseCard', () => ({ ContextualPulseCard: 'ContextualPulseCard', useNativeContextualPulse: () => null }));
vi.mock('./learning/LearningContentManager', () => ({ LearningContentManager: 'LearningContentManager' }));
vi.mock('./learning/LearningLibrarySection', () => ({ LearningLibrarySection: 'LearningLibrarySection' }));
vi.mock('./TaskDocumentHandoffProvider', () => ({ useTaskDocumentHandoff: () => ({ active: false, pending: null }) }));
vi.mock('../lib/connectedWorkflows', () => ({ connectedWorkflowApi: () => null }));
vi.mock('../lib/announce', () => ({ useAccessibilityAnnouncementQueue: () => vi.fn() }));
vi.mock('../services/haptics', () => ({ haptics: { success: vi.fn(), select: vi.fn() } }));
vi.mock('../services/supabase', () => ({ captureSessionWriter: (session: { user?: { id?: string } } | null) => stubSessionWriter(() => null, session?.user?.id ?? 'member-a'),  loadMobileMemberReportCard: vi.fn() }));
vi.mock('../services/memberSurveys', () => ({ loadMobileMemberSurveys: vi.fn(), saveMobileSurveySession: vi.fn(), submitMobileSurveySession: vi.fn() }));
vi.mock('../services/nativeCalendarExport', () => ({ calendarExportWasSaved: () => false, exportToDeviceCalendar: vi.fn(), isCalendarExportAvailable: () => false }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => palette['union-ground'] }));
vi.mock('../state/AppProvider', () => ({ useApp: () => host.app }));
vi.mock('../services/livedIn', () => ({
  loadMobileEventsHistory: host.load, setMobileEventRsvp: host.rsvp, checkInMobileEvent: host.checkIn,
  describeEventActionRefusal: () => 'refused', scanCheckinRefusalCopy: () => 'refused', scanMobileEventCheckin: vi.fn(), prepareAuthorizedEventCalendarExport: vi.fn(),
}));

import { LiveLivedInScreen, TaskCard } from './LiveLivedInScreens';

type Node = React.ReactElement<Record<string, unknown> & { children?: React.ReactNode }>;
function elements(node: React.ReactNode): Node[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement(node)) return [];
  const element = node as Node;
  return [element, ...elements(element.props.children)];
}
function find(tree: React.ReactNode, predicate: (entry: Node) => boolean) { return elements(tree).filter(predicate); }
type FeatureKey = Parameters<typeof LiveLivedInScreen>[0]['featureKey'];
function render(featureKey: FeatureKey = 'events'): React.ReactNode {
  host.start();
  const outer = LiveLivedInScreen({ featureKey }) as Node;
  const tree = (outer.type as (props: unknown) => React.ReactNode)(outer.props);
  host.flush();
  return tree;
}
// A second pass shows whatever state the first pass's effects set (a reload
// clears the list to null before refetching).
function draw() { render(); return render(); }
async function settle() { for (let i = 0; i < 12; i += 1) await Promise.resolve(); }
const hour = 60 * 60 * 1_000;
function event(index: number, startsAt: number): LivedInEvent {
  return { id: `event-${index}`, chapterID: 'chapter-a', title: `Meeting ${index}`, summary: '', startsAt: new Date(startsAt).toISOString(), location: 'Hall',
    cancelled: false, cancellationReason: null, rsvp: null, checkedInAt: null, checkInOffered: true, eventKind: 'meeting' };
}
// A long history back to the oldest event, with the acted-on card far down.
const history = () => [
  ...Array.from({ length: 120 }, (_, index) => event(index, Date.now() - (400 - index) * 24 * hour)),
  event(120, Date.now() + 7 * 24 * hour),
  event(121, Date.now() + hour),
];
const status = (tree: React.ReactNode, eventID: string) => {
  const card = find(tree, (entry) => entry.type === 'Card' && entry.key === eventID)[0];
  if (!card) throw new Error(`Missing card ${eventID}`);
  const meta = elements(card.props.children).find((entry) => typeof entry.type === 'function' && 'status' in entry.props);
  return meta?.props.status;
};
const loading = (tree: React.ReactNode) => find(tree, (entry) => entry.type === 'StateMessage' && entry.props.title === 'Loading meetings').length > 0;
const cards = (tree: React.ReactNode) => find(tree, (entry) => entry.type === 'Card' && typeof entry.key === 'string' && entry.key.startsWith('event-')).length;

beforeEach(() => { host.dispose(); host.load.mockReset(); host.rsvp.mockReset(); host.checkIn.mockReset(); host.app.memberLanguage = 'en'; });
afterEach(() => host.dispose());

describe('native meetings list after a saved action', () => {
  it('keeps the list mounted and shows the new RSVP on the card in place', async () => {
    host.load.mockResolvedValue(history()); host.rsvp.mockResolvedValue(undefined);
    let tree = render(); await settle(); tree = render();
    expect(cards(tree)).toBe(122); expect(status(tree, 'event-120')).toBe('No RSVP');
    // Upcoming events sort by start, so the acted-on card is found by its id,
    // not by its place in the list.
    const card120 = find(tree, (entry) => entry.type === 'Card' && entry.key === 'event-120')[0]!;
    const going = find(card120, (entry) => entry.props.label === 'Going')[0]!;
    (going.props.onPress as () => void)();
    // Every render between the tap and the settled save keeps the full list.
    tree = draw(); expect(loading(tree)).toBe(false); expect(cards(tree)).toBe(122);
    await settle(); tree = draw(); expect(loading(tree)).toBe(false);
    await settle(); tree = draw();
    expect(host.rsvp).toHaveBeenCalledWith(expect.objectContaining({ client: expect.any(Function) }), 'event-120', 'going');
    expect(loading(tree)).toBe(false); expect(cards(tree)).toBe(122);
    expect(status(tree, 'event-120')).toBe('going');
    expect(status(tree, 'event-121')).toBe('No RSVP');
    expect(host.load).toHaveBeenCalledTimes(1);
  });

  it('keeps the list mounted and shows Checked in on the card after a check-in', async () => {
    host.load.mockResolvedValue(history()); host.checkIn.mockResolvedValue(undefined);
    let tree = render(); await settle(); tree = render();
    const field = find(tree, (entry) => entry.props.accessibilityLabel === 'Check-in code for Meeting 121')[0]!;
    (field.props.onChangeText as (value: string) => void)('ABC123'); tree = render();
    (find(tree, (entry) => entry.props.label === 'Check in')[0]!.props.onPress as () => void)();
    tree = draw(); expect(loading(tree)).toBe(false);
    await settle(); tree = draw(); expect(loading(tree)).toBe(false);
    await settle(); tree = draw();
    expect(host.checkIn).toHaveBeenCalledWith(expect.objectContaining({ client: expect.any(Function) }), 'event-121', 'ABC123');
    expect(loading(tree)).toBe(false); expect(cards(tree)).toBe(122);
    expect(status(tree, 'event-121')).toBe('Checked in');
    expect(host.load).toHaveBeenCalledTimes(1);
  });
});

// BUG-UG-NATIVE-EVENTS-IGNORE-RSVP-SWITCH-20261106: staff can close an
// event to RSVPs. The native card offered Going anyway; it now says the event is
// not collecting RSVPs and, as on web, still lets a member who said yes withdraw.
describe('native meetings RSVP switch', () => {
  const upcoming = (rsvpOpen: boolean | undefined, rsvp: LivedInEvent['rsvp'] = null): LivedInEvent => ({ ...event(1, Date.now() + 7 * 24 * hour), rsvpOpen, rsvp });
  const card = (tree: React.ReactNode) => find(tree, (entry) => entry.type === 'Card' && entry.key === 'event-1')[0]!;
  const buttons = (tree: React.ReactNode) => find(card(tree), (entry) => entry.type === 'Button').map((entry) => entry.props.label);
  const notes = (tree: React.ReactNode) => find(card(tree), (entry) => entry.type === 'Body').map((entry) => entry.props.children);
  async function shown(item: LivedInEvent, featureKey: FeatureKey = 'events'): Promise<React.ReactNode> {
    host.load.mockResolvedValue([item]);
    render(featureKey); await settle(); return render(featureKey);
  }

  it('reads the meeting title before the actions control and supplies its target name', async () => {
    const tree = await shown(upcoming(true));
    const children = elements(card(tree).props.children);
    const titleIndex = children.findIndex((entry) => entry.type === 'Heading' && entry.props.children === 'Meeting 1');
    const actionsIndex = children.findIndex((entry) => entry.type === 'WorkflowActions');
    expect(titleIndex).toBeGreaterThanOrEqual(0);
    expect(actionsIndex).toBeGreaterThan(titleIndex);
    expect(children[actionsIndex]?.props.recordTitle).toBe('Meeting 1');
  });

  const responses: Array<NonNullable<LivedInEvent['rsvp']>> = ['going', 'not_going'];
  it.each(responses)('exposes the %s RSVP as selected with a visible text cue', async (rsvp) => {
    const tree = await shown(upcoming(true, rsvp));
    const options = find(card(tree), (entry) => entry.type === 'Button');
    const chosen = options.find((entry) => entry.props.selected === true);
    expect(chosen?.props.label).toBe(rsvp === 'going' ? 'Going · Selected' : "Can't go · Selected");
    expect(chosen?.props.accessibilityLabel).toBe(rsvp === 'going' ? 'Going' : "Can't go");
    expect(options.filter((entry) => entry.props.selected === true)).toHaveLength(1);
    expect(find(card(tree), (entry) => entry.props.accessibilityRole === 'radiogroup')[0]?.props.accessibilityLabel).toBe('RSVP for Meeting 1');
  });

  it.each([true, undefined])('offers Going and Can\'t go while RSVPs are open (rsvpOpen %s)', async (rsvpOpen) => {
    const tree = await shown(upcoming(rsvpOpen));
    expect(buttons(tree)).toEqual(['Going', "Can't go"]);
    expect(notes(tree)).not.toContain('Not collecting RSVPs');
  });

  it('says the meeting is not collecting RSVPs and offers no Going when closed', async () => {
    const tree = await shown(upcoming(false));
    expect(notes(tree)).toContain('Not collecting RSVPs');
    expect(buttons(tree)).toEqual([]);
  });

  it('lets a worker already going withdraw from a closed meeting', async () => {
    host.rsvp.mockResolvedValue(undefined);
    let tree: React.ReactNode = await shown(upcoming(false, 'going'));
    expect(notes(tree)).toContain('Not collecting RSVPs');
    expect(buttons(tree)).toEqual(["Can't go"]);
    (find(card(tree), (entry) => entry.props.label === "Can't go")[0]!.props.onPress as () => void)();
    await settle(); tree = draw();
    expect(host.rsvp).toHaveBeenCalledWith(expect.objectContaining({ client: expect.any(Function) }), 'event-1', 'not_going');
    expect(status(tree, 'event-1')).toBe('not going');
    expect(notes(tree)).toContain('Not collecting RSVPs');
    expect(buttons(tree)).toEqual([]);
  });

  it('shows the closed note in Spanish on a Spanish phone', async () => {
    const original = Intl.DateTimeFormat.prototype.resolvedOptions;
    const spy = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) { return { ...original.call(this), locale: 'es-US' }; });
    try {
      const tree = await shown(upcoming(false));
      expect(notes(tree)).toContain('No se reciben confirmaciones');
      expect(buttons(tree)).toEqual([]);
    } finally { spy.mockRestore(); }
  });

  it.each([['en', 'No RSVP'], ['es', 'Sin confirmación de asistencia']])('shows the no-response pill in %s without changing its casing', async (language, label) => {
    host.app.memberLanguage = language;
    const tree = await shown(upcoming(true));
    const meta = find(card(tree), (entry) => entry.props.status === 'No RSVP')[0]!;
    const rendered = (meta.type as (props: unknown) => React.ReactNode)(meta.props);
    const pill = find(rendered, (entry) => entry.props.children === label)[0];
    expect(pill?.props.style).toContainEqual({ textTransform: 'none' });
  });

  it('keeps the native closed-RSVP copy equal to the web catalogue', () => {
    expect(eventRsvpClosedText('en')).toBe(eventCheckInCatalogue.en['mevents.rsvpClosed']);
    expect(eventRsvpClosedText('es')).toBe(eventCheckInCatalogue.es['mevents.rsvpClosed']);
  });

  it('leaves the staff desk read-only', async () => {
    const tree = await shown(upcoming(false), 'events-desk');
    expect(buttons(tree)).toEqual([]);
    expect(notes(tree)).not.toContain('Not collecting RSVPs');
  });
});

describe('native task card action context', () => {
  it.each([['en', 'Nov 2, 2026 → Nov 10, 2026'], ['es', '2 nov 2026 → 10 nov 2026']])(
    'formats the Campaign work schedule in %s',
    (language, schedule) => {
      host.app.memberLanguage = language;
      const task: LivedInTask = {
        id: 'task-1', identifier: 'TASK-1', title: 'Prepare the campaign agenda', description: '',
        status: 'open', priority: 'normal', workstream: 'Campaign work', assignee: 'Unassigned',
        startDate: '2026-11-02', dueDate: '2026-11-10', progress: 0, blocked: false, milestone: false,
      };
      host.start();
      const lines = find(TaskCard({ task }), (entry) => {
        const children = entry.props.children;
        return entry.type === 'Body' && Array.isArray(children) && children.includes(schedule);
      });
      expect(lines).toHaveLength(1);
    },
  );

  it('reads the task title before actions and supplies the same target name', () => {
    const task: LivedInTask = {
      id: 'task-1', identifier: 'TASK-1', title: 'Prepare the campaign agenda', description: '',
      status: 'open', priority: 'normal', workstream: 'Campaign work', assignee: 'Unassigned',
      startDate: null, dueDate: null, progress: 0, blocked: false, milestone: false,
    };
    host.start();
    const tree = TaskCard({ task });
    const children = elements(tree);
    const titleIndex = children.findIndex((entry) => entry.type === 'Heading' && entry.props.children === task.title);
    const actionsIndex = children.findIndex((entry) => entry.type === 'WorkflowActions');
    expect(titleIndex).toBeGreaterThanOrEqual(0);
    expect(actionsIndex).toBeGreaterThan(titleIndex);
    expect(children[actionsIndex]?.props.recordTitle).toBe(task.title);
  });
});
