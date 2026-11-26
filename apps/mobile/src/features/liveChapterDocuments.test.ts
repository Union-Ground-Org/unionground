import * as React from 'react';
import { stubSessionWriter } from '../testing/stubSessionWriter';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import palette from '../theme/palette.json';
// The survey card and unit editors import the shared draft hook, whose attempt keys come from expo-crypto (#9240 pull request D).
vi.mock('expo-crypto', () => ({ randomUUID: () => 'attempt-key' }));

// BUG-UG-NATIVE-CHAPTER-DOCUMENTS-HAVE-NO-OPEN-ACTION-20261111 (#8283):
// My chapter listed a published contract with no way to open it. The shipped
// screen (shared by Android and iPhone) runs on a small synchronous hook host,
// as in eventsListKeepsPosition.test.ts; the chapter reads are mocked and the
// document read is the same port the screen uses, so no permission is widened.
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
      const entry = slot(); if (!('value' in entry)) entry.value = typeof initial === 'function' ? (initial as () => unknown)() : initial;
      return [entry.value, (next: unknown) => { entry.value = typeof next === 'function' ? (next as (value: unknown) => unknown)(entry.value) : next; }];
    },
    useRef: (initial: unknown) => { const entry = slot(); if (!('value' in entry)) entry.value = { current: initial }; return entry.value; },
    useMemo: (factory: () => unknown, deps: readonly unknown[]) => { const entry = slot(); if (changed(entry.deps, deps)) { entry.value = factory(); entry.deps = deps; } return entry.value; },
    useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      const entry = slot(); if (changed(entry.deps, deps)) { entry.deps = deps; pending.push(() => { entry.cleanup?.(); entry.cleanup = effect() || undefined; }); }
    },
    // The handler the screen registers for header Back and Android hardware Back.
    back: { handler: null as null | (() => boolean) },
    // The stack options the screen sets; iOS's edge swipe is gestureEnabled.
    navigation: { setOptions: vi.fn() },
    epoch: 0,
    receipt: vi.fn(),
    history: vi.fn(),
    document: vi.fn(),
    app: { captureAuthenticatedSessionGuard: (): (() => boolean) => { const epoch = host.epoch; return () => host.epoch === epoch; }, authorizedRoles: ['member'], dashboard: { member: { chapterID: 'chapter-a' } }, mode: 'live', sampleHat: null, liveSampleBackend: false },
  };
});
vi.mock('./guideLayers/GuideLayers', () => ({ NativeFeatureGuide: () => null, NativeCoachMark: () => null, NativeOrgStartGuide: () => null }));
vi.mock('react', async (original) => ({ ...await original<typeof React>(), useState: host.useState, useRef: host.useRef, useMemo: host.useMemo, useCallback: (callback: unknown, deps: readonly unknown[]) => host.useMemo(() => callback, deps), useEffect: host.useEffect, useLayoutEffect: host.useEffect }));
vi.mock('react-native', () => ({ View: 'View', Text: 'Text', TextInput: 'TextInput', Pressable: 'Pressable', Platform: { OS: 'android' }, StyleSheet: { create: (value: unknown) => value } }));
vi.mock('expo-router', () => ({ useIsFocused: () => true, useNavigation: () => host.navigation }));
vi.mock('../lib/screenBack', () => ({ useScreenBackInterceptor: (handler: null | (() => boolean)) => { host.back.handler = handler; } }));
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
vi.mock('./CaseRowTopicCards', () => ({ ChapterCaseRowTopicCard: 'ChapterCaseRowTopicCard' }));
vi.mock('../lib/connectedWorkflows', () => ({ connectedWorkflowApi: () => null }));
vi.mock('../lib/announce', () => ({ useAccessibilityAnnouncementQueue: () => vi.fn() }));
vi.mock('../services/haptics', () => ({ haptics: { success: vi.fn(), select: vi.fn() } }));
vi.mock('../services/supabase', () => ({ captureSessionWriter: () => stubSessionWriter(() => null, 'member-a'), loadMobileMemberReportCard: vi.fn() }));
vi.mock('../services/memberSurveys', () => ({ loadMobileMemberSurveys: vi.fn(), saveMobileSurveySession: vi.fn(), submitMobileSurveySession: vi.fn() }));
vi.mock('../services/nativeCalendarExport', () => ({ calendarExportWasSaved: () => false, exportToDeviceCalendar: vi.fn(), isCalendarExportAvailable: () => false }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => palette['union-ground'] }));
vi.mock('../state/AppProvider', () => ({ useApp: () => host.app }));
vi.mock('../services/livedIn', () => ({
  loadMobileChapterHistory: host.history, loadMobileChapterDocument: host.document, markMobileBroadcastRead: host.receipt,
}));

import { LiveLivedInScreen } from './LiveLivedInScreens';

type Node = React.ReactElement<Record<string, unknown> & { children?: React.ReactNode }>;
function elements(node: React.ReactNode): Node[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement(node)) return [];
  const element = node as Node;
  return [element, ...elements(element.props.children)];
}
function textOf(tree: React.ReactNode): string {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (Array.isArray(tree)) return tree.map(textOf).join(' ');
  return React.isValidElement(tree) ? textOf((tree as Node).props.children) : '';
}
function render(sourceID?: string): React.ReactNode {
  host.start();
  const outer = LiveLivedInScreen({ featureKey: 'chapter', sourceID }) as Node;
  const tree = (outer.type as (props: unknown) => React.ReactNode)(outer.props);
  host.flush();
  return tree;
}
async function settle() { for (let i = 0; i < 12; i += 1) await Promise.resolve(); }
async function rendered(sourceID?: string) { render(sourceID); await settle(); return render(sourceID); }
type ButtonProps = { label?: string; accessibilityLabel?: string; onPress?: () => void };
const button = (tree: React.ReactNode, match: (props: ButtonProps) => boolean) =>
  elements(tree).find((node) => node.type === 'Button' && match(node.props as ButtonProps))?.props as ButtonProps | undefined;

const contract = { id: 'contract-1', kind: 'contract', title: 'Quillmere contract quick reference', summary: 'Overtime quick reference', version: 1, updatedAt: '2026-11-01T14:00:00Z' };
const BODY = 'Overtime must be paid at the agreed rate.';
const readControl = (tree: React.ReactNode) => button(tree, (props) => props.accessibilityLabel === `Read ${contract.title}`);

beforeEach(() => {
  host.dispose(); host.back.handler = null; host.navigation.setOptions.mockReset();
  host.history.mockReset(); host.document.mockReset();
  host.epoch = 0; host.receipt.mockReset();
  host.history.mockResolvedValue({ documents: [contract], records: [], broadcasts: [] });
  host.document.mockResolvedValue({ body: BODY, updatedAt: contract.updatedAt });
});

describe('My campaign documents (native, Android and iPhone)', () => {
  it.each(['current', 'retired after write', 'retired during reload'])('binds the read receipt and guards its continuation: %s', async (retirement) => {
    const broadcast = { id: 'broadcast-1', sender: 'Campaign', title: 'Campaign news', body: 'A published briefing', publishedAt: contract.updatedAt, readAt: null };
    const history = { documents: [contract], records: [], broadcasts: [broadcast] };
    host.history.mockResolvedValue(history);
    const list = await rendered();
    if (retirement === 'retired after write') host.receipt.mockImplementationOnce(async () => { host.epoch += 1; });
    host.history.mockImplementationOnce(async () => {
      if (retirement === 'retired during reload') host.epoch += 1;
      return { ...history, broadcasts: [{ ...broadcast, title: 'Reloaded briefing', readAt: contract.updatedAt }] };
    });
    button(list, (props) => props.label === 'Mark read')!.onPress!();
    await settle();
    const next = render();
    expect(host.receipt).toHaveBeenCalledWith(expect.objectContaining({ userId: 'member-a', client: expect.any(Function) }), 'broadcast-1');
    expect(host.history).toHaveBeenCalledTimes(retirement === 'retired after write' ? 1 : 2);
    expect(textOf(next).includes('Reloaded briefing')).toBe(retirement === 'current');
  });

  it('opens a listed contract from its named Read control, shows its full body and returns to the same list', async () => {
    const list = await rendered();
    expect(readControl(list)?.label).toBe('Read');
    expect(host.back.handler).toBeNull();

    readControl(list)!.onPress!();
    const reader = await rendered();
    expect(host.document).toHaveBeenCalledWith(contract.id);
    expect(textOf(reader)).toContain(BODY);

    button(reader, (props) => props.label === 'All campaign documents')!.onPress!();
    const back = await rendered();
    expect(readControl(back)).toBeDefined();
    expect(textOf(back)).not.toContain(BODY);
  });

  it('lets header Back and the Android back button close the reader before leaving My campaign', async () => {
    readControl(await rendered())!.onPress!();
    expect(textOf(await rendered())).toContain(BODY);
    expect(host.back.handler).toBeTypeOf('function');

    expect(host.back.handler!()).toBe(true);
    const list = await rendered();
    expect(readControl(list)).toBeDefined();
    expect(textOf(list)).not.toContain(BODY);
    // On the list, Back is the stack's again: no interceptor is registered.
    expect(host.back.handler).toBeNull();
  });

  it('keeps the iPhone edge swipe from leaving My campaign while a listed document is open, and restores it for the list', async () => {
    readControl(await rendered())!.onPress!();
    await rendered();
    // The swipe is a stack gesture the interceptor never sees, so it stands down.
    expect(host.navigation.setOptions.mock.calls).toEqual([[{ gestureEnabled: false }]]);

    host.back.handler!();
    await rendered();
    expect(host.navigation.setOptions.mock.calls).toEqual([[{ gestureEnabled: false }], [{ gestureEnabled: true }]]);

    // Leaving My chapter with a document open restores it as well.
    readControl(await rendered())!.onPress!();
    await rendered();
    host.dispose();
    expect(host.navigation.setOptions.mock.calls.at(-1)).toEqual([{ gestureEnabled: true }]);
  });

  it('leaves the swipe alone for a linked source, so it still leaves My campaign', async () => {
    // The list loads, then the linked document's body.
    await rendered(`doc:${contract.id}`);
    const linked = await rendered(`doc:${contract.id}`);
    expect(textOf(linked)).toContain(BODY);
    expect(host.back.handler).toBeNull();
    expect(host.navigation.setOptions).not.toHaveBeenCalled();
  });

  it('refuses a document the reader cannot load, without showing it, and a retry reads a later success', async () => {
    host.document.mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: '42501' }));
    readControl(await rendered())!.onPress!();
    const refused = await rendered();
    expect(elements(refused).some((node) => node.type === 'StateMessage' && (node.props as { title?: string }).title === 'That approved source is unavailable')).toBe(true);
    expect(textOf(refused)).not.toContain(BODY);

    button(refused, (props) => props.label === 'Try again')!.onPress!();
    const retried = await rendered();
    expect(host.document).toHaveBeenCalledTimes(2);
    expect(textOf(retried)).toContain(BODY);
  });
});
