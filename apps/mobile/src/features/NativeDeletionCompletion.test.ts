import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { deletionCompletionCopy } from '../../../../src/lib/accountDeletionCompletion';
import { createAnnouncementCoordinator } from '../lib/announce';

vi.mock('react-native', () => ({ AccessibilityInfo: {}, Platform: { OS: 'ios' } }));

// Execute the component's actual effect, including its returned cleanup.
const source = readFileSync(new URL('./NativeDeletionCompletion.tsx', import.meta.url), 'utf8');
const tree = ts.createSourceFile('NativeDeletionCompletion.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let effectSource = '';
let componentSource = '';
function visit(node: ts.Node) {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'NativeDeletionCompletion') {
    componentSource = node.getText(tree).replace(/^export /, '');
  }
  if (ts.isCallExpression(node) && node.expression.getText(tree) === 'useEffect') {
    effectSource = node.arguments[0]!.getText(tree);
  }
  ts.forEachChild(node, visit);
}
visit(tree);

const layoutSource = readFileSync(new URL('../../app/_layout.tsx', import.meta.url), 'utf8');
const layoutTree = ts.createSourceFile('_layout.tsx', layoutSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const navigationRoot = layoutTree.statements.find(node =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'NavigationRoot') as ts.FunctionDeclaration;
const layoutReturn = navigationRoot!.body!.statements.find(ts.isReturnStatement)!.getText(layoutTree);
type RenderedNode = { type: unknown; props: Record<string, unknown> | null; children: unknown[] };
function renderLayout(deletionOutcome: object | null, locked: boolean, privacyCovered: boolean) {
  const createElement = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): RenderedNode => ({ type, props, children });
  const symbols = Object.fromEntries([
    'SwipeDownKeyboardDismiss', 'StatusBar', 'NavigationBar', 'View', 'QuickActionsDrawer',
    'NativeQuickActionGate', 'HomeWidgetGate', 'SecureShareIntakeGate', 'Modal', 'NativeDeletionCompletion',
    'ActivityIndicator', 'Body', 'Heading', 'Button', 'NativeDeepLinkProofGate', 'NavUsageRecorder', 'HatSwitcher',
    'Pressable', 'Text', 'SessionCheckStatus', 'StoreDemoExit', 'HeldWorkKeptPanel',
  ].map(name => [name, name]));
  return runInNewContext(ts.transpile(`(() => { ${layoutReturn} })()`, {
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React,
  }), {
    ...symbols, React: { createElement }, Stack: { Screen: 'Stack.Screen' }, Ionicons: 'Ionicons',
    appearance: 'light', theme: {}, styles: {}, hatMenuOpen: false, setHatMenuOpen: vi.fn(),
    deletionOutcome, locked, privacyCovered, pathname: '/account', appActive: true,
    privacyCoverContent: () => 'checking', PRIVACY_COVER_CHECKING_LABEL: 'Checking', coverLabel: 'Checking',
    unlock: vi.fn(), signOut: vi.fn(), signOutError: null, retrySessionAuthentication: vi.fn(), sessionRetryBusy: false,
    demoExit: 'none', catalogLabel: (label: string) => label,
  }) as RenderedNode;
}

describe('native deletion completion modal priority', () => {
  it.each([[true, false], [false, true], [true, true]])('keeps completion as the sole visible modal with lock=%s cover=%s', (locked, covered) => {
    const root = renderLayout({ audited: true }, locked, covered);
    const modals = root.children.filter(child =>
      child !== null && typeof child === 'object' && 'type' in child && child.type === 'Modal') as RenderedNode[];
    const visible = modals.filter(modal => modal.props?.visible);
    expect(visible).toHaveLength(1);
    expect(visible[0]?.children[0]).toMatchObject({ type: 'NativeDeletionCompletion' });
  });
  it('still covers a protected session when there is no deletion outcome', () => {
    const root = renderLayout(null, false, true);
    const modals = root.children.filter(child =>
      child !== null && typeof child === 'object' && 'type' in child && child.type === 'Modal') as RenderedNode[];
    expect(modals.filter(modal => modal.props?.visible)).toHaveLength(1);
  });
});

function fixture(platform = 'ios') {
  const announce = vi.fn();
  const scheduled: Array<() => void> = [];
  const coordinator = createAnnouncementCoordinator({ announce, schedule: flush => scheduled.push(flush) });
  const queue = vi.fn(coordinator.enqueue);
  const env = {
    deletionOutcome: { uncertain: false, audited: true, language: 'en' } as {
      uncertain: boolean; audited: boolean; language: 'en' | 'es';
    } | null,
    deletionCompletionCopy,
    Keyboard: { dismiss: vi.fn() },
    Platform: { OS: platform },
    announcementAttempt: { current: 0 },
    queueAccessibilityAnnouncement: queue,
  };
  const effect = runInNewContext(ts.transpile(`(${effectSource})`, { target: ts.ScriptTarget.ES2022 }), env) as () => (() => void) | undefined;
  return { env, queue, announce, effect, flush: () => scheduled.shift()?.() };
}

describe('native deletion completion announcements', () => {
  it('mounts an announcing Notice for each cleanup failure and removes it during retry', () => {
    const createElement = (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props, children });
    const state = {
      deletionOutcome: { uncertain: false, audited: true, language: 'en' },
      deletionCleanup: 'pending', retryDeletionCleanup: vi.fn(), acknowledgeDeletion: vi.fn(),
    };
    const render = runInNewContext(ts.transpile(`(${componentSource})`, {
      target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React,
    }), {
      React: { createElement }, useApp: () => state, useRef: () => ({ current: 0 }), useEffect: () => {},
      deletionCompletionCopy, Screen: 'Screen', Heading: 'Heading', Body: 'Body', View: 'View', Button: 'Button', Notice: 'Notice',
    }) as () => ReturnType<typeof createElement>;
    const notice = { type: 'Notice', props: null, children: [deletionCompletionCopy.en.cleanupFailed] };
    expect(render().children).not.toContainEqual(notice);
    state.deletionCleanup = 'failed';
    expect(render().children).toContainEqual(notice);
    state.deletionCleanup = 'pending';
    expect(render().children).not.toContainEqual(notice);
    state.deletionCleanup = 'failed';
    expect(render().children).toContainEqual(notice);
    state.deletionCleanup = 'done';
    const button = render().children.find((child) => child && typeof child === 'object' && 'type' in child && child.type === 'Button') as {
      props: { label: string; disabled: boolean; onPress: () => void };
    };
    expect(button.props.label).toBe(deletionCompletionCopy.en.continue);
    expect(button.props.disabled).toBe(false);
    button.props.onPress();
    expect(state.acknowledgeDeletion).toHaveBeenCalledOnce();
  });

  it.each([true, false])('queues the completion title for audited=%s and cancels on unmount', audited => {
    const f = fixture();
    f.env.deletionOutcome!.audited = audited;
    const cleanup = f.effect();
    expect(f.env.Keyboard.dismiss).toHaveBeenCalledOnce();
    expect(f.queue).toHaveBeenCalledWith(deletionCompletionCopy.en.title, 'deletion-completion:1');
    expect(f.announce).not.toHaveBeenCalled();
    expect(cleanup).toBeTypeOf('function');
    cleanup!();
    f.flush();
    expect(f.announce).not.toHaveBeenCalled();
  });

  it('keeps uncertain outcomes distinct and gives a later effect a fresh attempt', () => {
    const f = fixture();
    const cleanup = f.effect();
    cleanup!();
    f.env.deletionOutcome = { uncertain: true, audited: false, language: 'es' };
    f.effect();
    expect(f.queue).toHaveBeenLastCalledWith(deletionCompletionCopy.es.uncertainTitle, 'deletion-completion:2');
    f.flush();
    expect(f.announce).toHaveBeenCalledExactlyOnceWith(deletionCompletionCopy.es.uncertainTitle);
  });

  it('leaves Android speech to the live region while dismissing the keyboard', () => {
    const f = fixture('android');
    f.effect();
    f.flush();
    expect(f.env.Keyboard.dismiss).toHaveBeenCalledOnce();
    expect(f.queue).not.toHaveBeenCalled();
    expect(f.announce).not.toHaveBeenCalled();
  });

  it('does nothing without a deletion outcome', () => {
    const f = fixture();
    f.env.deletionOutcome = null;
    expect(f.effect()).toBeUndefined();
    expect(f.env.Keyboard.dismiss).not.toHaveBeenCalled();
    expect(f.queue).not.toHaveBeenCalled();
  });
});
