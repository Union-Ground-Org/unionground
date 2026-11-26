import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// REQ-UG-NATIVE-SESSION-MANAGEMENT-20261009: Account > Sessions. The
// mobile package tests in plain node with no React renderer, so this harness
// gives the card a synchronous useState/useEffect/useCallback and stubs its
// native modules; the card's own code is what runs. Renders are driven by the
// test, which is what lets each state — loading, loaded, empty, failed,
// confirming, working — be read as a tree.
const runtime = vi.hoisted(() => {
  const state = {
    slots: [] as unknown[],
    index: 0,
    effects: [] as { deps: unknown[] | undefined; cleanup: (() => void) | void }[],
    effectIndex: 0,
    renders: 0,
  };
  return {
    state,
    useState<T>(initial: T) {
      const index = state.index++;
      if (index >= state.slots.length) state.slots[index] = initial;
      const set = (next: T | ((previous: T) => T)) => {
        state.slots[index] = typeof next === 'function'
          ? (next as (previous: T) => T)(state.slots[index] as T)
          : next;
      };
      return [state.slots[index] as T, set] as const;
    },
    useEffect(effect: () => (() => void) | void, deps?: unknown[]) {
      const index = state.effectIndex++;
      const previous = state.effects[index];
      const changed = !previous
        || previous.deps === undefined
        || deps === undefined
        || deps.length !== previous.deps.length
        || deps.some((value, position) => value !== previous.deps?.[position]);
      if (!changed) return;
      if (typeof previous?.cleanup === 'function') previous.cleanup();
      state.effects[index] = { deps, cleanup: effect() };
    },
    useCallback<T>(callback: T) {
      return callback;
    },
    useRef<T>(initial: T) {
      const index = state.index++;
      if (index >= state.slots.length) state.slots[index] = { current: initial };
      return state.slots[index] as { current: T };
    },
  };
});

const app = vi.hoisted(() => ({
  value: {
    mode: 'authenticated' as string,
    session: { user: { id: 'f2c2a9d0-0000-4000-8000-00000000000a' } } as { user: { id: string } } | null,
    signOut: vi.fn(async (_options?: { scope?: string }) => undefined),
    signOutError: null as string | null,
    signOutBusy: false,
    sampleEntryBusy: false,
    // The provider resolves `true` when revalidation ran and `false` when a
    // sign-out in flight refused it; the default mirrors the ordinary case.
    retrySessionAuthentication: vi.fn(async () => true),
  },
}));

// The real service imports the Supabase client, which pulls in native
// polyfills this node harness has no business loading. The card only needs the
// read and the error type, so both are supplied here; the service's own
// behaviour is proved in services/memberSessions.test.ts.
const sessions = vi.hoisted(() => {
  class Unavailable extends Error {
    readonly kind: string;

    constructor(kind: string, message: string) {
      super(message);
      this.name = 'MemberSessionsUnavailableError';
      this.kind = kind;
    }
  }
  return { load: vi.fn(), Unavailable };
});

vi.mock('react', () => ({
  useCallback: runtime.useCallback,
  useEffect: runtime.useEffect,
  useState: runtime.useState,
  useRef: runtime.useRef,
}));
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('../components/ui', () => ({
  Body: 'Body', Button: 'Button', Card: 'Card', Group: 'Group', GroupRow: 'GroupRow', Heading: 'Heading',
}));
vi.mock('../state/AppProvider', () => ({ useApp: () => app.value }));
vi.mock('../services/memberSessions', () => ({
  MemberSessionsUnavailableError: sessions.Unavailable,
  loadMemberSessions: sessions.load,
}));

const { NativeSessionsCard } = await import('./NativeSessionsCard');
const MemberSessionsUnavailableError = sessions.Unavailable;
const { MEMBER_SESSIONS_COPY } = await import('../lib/memberSessionInventory');

type Node = { type: unknown; props: Record<string, unknown> & { children?: unknown } };

function nodes(root: unknown): Node[] {
  if (Array.isArray(root)) return root.flatMap(nodes);
  if (typeof root !== 'object' || root === null) return [];
  const node = root as Node;
  if (!('props' in node)) return [];
  return [node, ...nodes(node.props.children)];
}

function render(): unknown {
  runtime.state.index = 0;
  runtime.state.effectIndex = 0;
  runtime.state.renders += 1;
  return NativeSessionsCard();
}

function text(tree: unknown): string {
  return nodes(tree)
    .flatMap((node) => (typeof node.props.children === 'string' ? [node.props.children] : []))
    .join(' | ');
}

function buttons(tree: unknown): Node[] {
  return nodes(tree).filter((node) => node.type === 'Button');
}

function button(tree: unknown, label: string): Node {
  const found = buttons(tree).find((node) => node.props.label === label);
  expect(found, `button ${label} in ${buttons(tree).map((node) => String(node.props.label)).join(', ')}`).toBeTruthy();
  return found as Node;
}

function labels(tree: unknown): string[] {
  return nodes(tree)
    .flatMap((node) => (typeof node.props.accessibilityLabel === 'string' ? [node.props.accessibilityLabel] : []));
}

const handleA = 'a'.repeat(64);
const handleB = 'b'.repeat(64);
const currentRow = {
  handle: handleA, deviceLabel: 'apple_mobile' as const, browserLabel: 'safari' as const,
  current: true, createdAt: '2026-10-09T12:00:00.000Z', lastActiveAt: '2026-10-10T02:00:00.000Z',
};
const otherRow = {
  handle: handleB, deviceLabel: 'android_mobile' as const, browserLabel: 'chrome' as const,
  current: false, createdAt: '2026-10-08T12:00:00.000Z', lastActiveAt: '2026-10-09T18:00:00.000Z',
};

beforeEach(() => {
  runtime.state.slots = [];
  runtime.state.effects = [];
  app.value.mode = 'authenticated';
  app.value.session = { user: { id: 'f2c2a9d0-0000-4000-8000-00000000000a' } };
  app.value.signOutError = null;
  app.value.signOutBusy = false;
  app.value.sampleEntryBusy = false;
  app.value.signOut = vi.fn(async (_options?: { scope?: string }) => undefined);
  app.value.retrySessionAuthentication = vi.fn(async () => true);
  sessions.load.mockReset();
});

describe('the sessions list', () => {
  it('says it is loading before the server answers, and shows no list', () => {
    sessions.load.mockReturnValue(new Promise(() => {}));
    const tree = render();
    expect(text(tree)).toContain(MEMBER_SESSIONS_COPY.loading);
    expect(nodes(tree).some((node) => node.type === 'GroupRow')).toBe(false);
    expect(buttons(tree).map((node) => node.props.label)).not.toContain(MEMBER_SESSIONS_COPY.refresh);
  });

  it('marks the current session and speaks every row as one item', async () => {
    sessions.load.mockResolvedValue([currentRow, otherRow]);
    render();
    await Promise.resolve();
    const tree = render();
    expect(nodes(tree).filter((node) => node.type === 'GroupRow')).toHaveLength(2);
    expect(text(tree)).toContain('iPhone or iPad — this device');
    expect(text(tree)).toContain('Android phone or tablet, Chrome');
    expect(labels(tree)[0]).toContain('This device.');
    expect(labels(tree)).toHaveLength(2);
    // The opaque handle is a React key, never a rendered or spoken value.
    expect([text(tree), ...labels(tree)].join(' ')).not.toContain(handleA);
  });

  it('bounds 50 unsorted sessions, expands and collapses without burying sign-out', async () => {
    const rows = Array.from({ length: 50 }, (_, index) => ({
      ...otherRow, handle: index.toString(16).padStart(64, '0'), current: index === 49,
    }));
    sessions.load.mockResolvedValue(rows);
    render();
    await Promise.resolve();
    let tree = render();
    expect(nodes(tree).filter((node) => node.type === 'GroupRow')).toHaveLength(3);
    expect(labels(tree)[0]).toContain('This device.');
    (button(tree, MEMBER_SESSIONS_COPY.showMore).props.onPress as () => void)();
    tree = render();
    expect(nodes(tree).filter((node) => node.type === 'GroupRow')).toHaveLength(50);
    expect(rows[0]?.current).toBe(false); // Presentation never mutates the service answer.
    const ordered = nodes(tree);
    expect(ordered.indexOf(button(tree, MEMBER_SESSIONS_COPY.signOutEverywhere)))
      .toBeLessThan(ordered.findIndex((node) => node.type === 'GroupRow'));
    (button(tree, MEMBER_SESSIONS_COPY.signOutEverywhere).props.onPress as () => void)();
    tree = render();
    expect(app.value.signOut).not.toHaveBeenCalled();
    expect(nodes(tree).indexOf(button(tree, MEMBER_SESSIONS_COPY.confirmAction)))
      .toBeLessThan(nodes(tree).findIndex((node) => node.type === 'GroupRow'));
    (button(tree, MEMBER_SESSIONS_COPY.confirmCancel).props.onPress as () => void)();
    (button(render(), MEMBER_SESSIONS_COPY.collapse).props.onPress as () => void)();
    tree = render();
    expect(nodes(tree).filter((node) => node.type === 'GroupRow')).toHaveLength(3);
    button(tree, MEMBER_SESSIONS_COPY.showMore);
  });

  it('collapses a refreshed list and another account, ignoring the old in-flight answer', async () => {
    const rows = Array.from({ length: 50 }, (_, index) => ({
      ...otherRow, handle: index.toString(16).padStart(64, '0'), current: index === 49,
    }));
    sessions.load.mockResolvedValue(rows);
    render();
    await Promise.resolve();
    (button(render(), MEMBER_SESSIONS_COPY.showMore).props.onPress as () => void)();
    expect(nodes(render()).filter((node) => node.type === 'GroupRow')).toHaveLength(50);
    (button(render(), MEMBER_SESSIONS_COPY.refresh).props.onPress as () => void)();
    render();
    await Promise.resolve();
    expect(nodes(render()).filter((node) => node.type === 'GroupRow')).toHaveLength(3);
    (button(render(), MEMBER_SESSIONS_COPY.showMore).props.onPress as () => void)();
    app.value.session = { user: { id: 'fictional-worker-b' } };
    render();
    await Promise.resolve();
    expect(nodes(render()).filter((node) => node.type === 'GroupRow')).toHaveLength(3);
    (button(render(), MEMBER_SESSIONS_COPY.showMore).props.onPress as () => void)();
    let finishOldRead!: (value: typeof rows) => void;
    sessions.load.mockImplementationOnce(() => new Promise((resolve) => { finishOldRead = resolve; }));
    (button(render(), MEMBER_SESSIONS_COPY.refresh).props.onPress as () => void)();
    render();
    app.value.session = { user: { id: 'fictional-worker-c' } };
    sessions.load.mockResolvedValue([currentRow]);
    render();
    await Promise.resolve();
    let tree = render();
    expect(nodes(tree).filter((node) => node.type === 'GroupRow')).toHaveLength(1);
    finishOldRead(rows);
    await Promise.resolve();
    tree = render();
    expect(nodes(tree).filter((node) => node.type === 'GroupRow')).toHaveLength(1);
    expect(buttons(tree).map((node) => node.props.label)).not.toContain(MEMBER_SESSIONS_COPY.collapse);
  });

  it('keeps expansion controls disabled during sign-out', async () => {
    sessions.load.mockResolvedValue(Array.from({ length: 4 }, (_, index) => ({ ...otherRow, handle: String(index) })));
    app.value.signOutBusy = true;
    render();
    await Promise.resolve();
    expect(button(render(), MEMBER_SESSIONS_COPY.showMore).props.disabled).toBe(true);
  });

  it('says the server reported no sessions only for an empty list', async () => {
    sessions.load.mockResolvedValue([]);
    render();
    await Promise.resolve();
    const tree = render();
    expect(text(tree)).toContain(MEMBER_SESSIONS_COPY.emptyBody);
    expect(nodes(tree).some((node) => node.type === 'GroupRow')).toBe(false);
  });

  it('reports a failure as a failure, with a retry and no empty state', async () => {
    sessions.load.mockRejectedValue(new MemberSessionsUnavailableError('service', 'refused'));
    render();
    await Promise.resolve();
    await Promise.resolve();
    const tree = render();
    expect(text(tree)).toContain(MEMBER_SESSIONS_COPY.failureTitle);
    expect(text(tree)).toContain('the service refused the request');
    expect(text(tree)).not.toContain(MEMBER_SESSIONS_COPY.emptyBody);
    expect(nodes(tree).some((node) => node.props.accessibilityRole === 'alert')).toBe(true);
    button(tree, MEMBER_SESSIONS_COPY.retry);
  });

  it('hands a session the server no longer accepts to re-authentication', async () => {
    // Another device signed out everywhere: this device's next server read is
    // refused, and that refusal has to reach the provider's re-authentication
    // path rather than stay a line on the card.
    app.value.retrySessionAuthentication.mockClear();
    sessions.load.mockRejectedValue(new MemberSessionsUnavailableError('denied', 'gone'));
    render();
    await Promise.resolve();
    await Promise.resolve();
    expect(app.value.retrySessionAuthentication).toHaveBeenCalledTimes(1);
    const tree = render();
    expect(text(tree)).toContain('no longer accepted');
    // 42501 also means an unsatisfied second factor, where revalidation keeps
    // the session: a retry that is refused again must not re-authenticate again.
    (button(tree, MEMBER_SESSIONS_COPY.retry).props.onPress as () => void)();
    render();
    await Promise.resolve();
    await Promise.resolve();
    render();
    expect(sessions.load).toHaveBeenCalledTimes(2);
    expect(app.value.retrySessionAuthentication).toHaveBeenCalledTimes(1);
  });

  it('keeps the once-per-account re-authentication when a sign-out refused it', async () => {
    // A 42501 list answer can land while a sign-out holds the session. The
    // provider refuses to revalidate then (it would supersede the sign-out),
    // so the card's one-per-account latch must not be spent on a call that
    // never ran: the next refused read still has to re-authenticate, or the
    // authenticated shell stays on screen for a session the server rejects.
    const refused = vi.fn(async () => false);
    app.value.retrySessionAuthentication = refused;
    sessions.load.mockRejectedValue(new MemberSessionsUnavailableError('denied', 'gone'));
    render();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(refused).toHaveBeenCalledTimes(1);
    const tree = render();
    // The sign-out has settled; the member reads the list again.
    const allowed = vi.fn(async () => true);
    app.value.retrySessionAuthentication = allowed;
    (button(tree, MEMBER_SESSIONS_COPY.retry).props.onPress as () => void)();
    render();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(allowed).toHaveBeenCalledTimes(1);
  });

  it('still spends the latch once a revalidation has actually run', async () => {
    // The negative control for the release above: a revalidation that ran keeps
    // the latch, because 42501 also means an unsatisfied second factor, where
    // revalidation keeps the session and a second attempt would loop.
    const ran = vi.fn(async () => true);
    app.value.retrySessionAuthentication = ran;
    sessions.load.mockRejectedValue(new MemberSessionsUnavailableError('denied', 'gone'));
    render();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const tree = render();
    (button(tree, MEMBER_SESSIONS_COPY.retry).props.onPress as () => void)();
    render();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it('does not re-authenticate for a service or connection failure', async () => {
    app.value.retrySessionAuthentication.mockClear();
    sessions.load.mockRejectedValue(new MemberSessionsUnavailableError('service', 'refused'));
    render();
    await Promise.resolve();
    await Promise.resolve();
    expect(app.value.retrySessionAuthentication).not.toHaveBeenCalled();
  });

  it('treats an unexpected rejection as a connection failure rather than a service fault', async () => {
    sessions.load.mockRejectedValue(new Error('boom'));
    render();
    await Promise.resolve();
    await Promise.resolve();
    expect(text(render())).toContain('did not reach Union Ground');
  });

  it('asks the server again when the retry is pressed', async () => {
    sessions.load.mockRejectedValue(new MemberSessionsUnavailableError('transport', 'offline'));
    render();
    await Promise.resolve();
    await Promise.resolve();
    const failed = render();
    sessions.load.mockResolvedValue([currentRow]);
    (button(failed, MEMBER_SESSIONS_COPY.retry).props.onPress as () => void)();
    render();
    await Promise.resolve();
    expect(sessions.load).toHaveBeenCalledTimes(2);
    expect(text(render())).toContain('iPhone or iPad — this device');
  });
});

describe('sign out everywhere', () => {
  it('needs an explicit confirmation and does nothing on the first press', async () => {
    sessions.load.mockResolvedValue([currentRow, otherRow]);
    render();
    await Promise.resolve();
    const listed = render();
    expect(buttons(listed).map((node) => node.props.label)).not.toContain(MEMBER_SESSIONS_COPY.confirmAction);
    (button(listed, MEMBER_SESSIONS_COPY.signOutEverywhere).props.onPress as () => void)();
    const confirming = render();
    expect(app.value.signOut).not.toHaveBeenCalled();
    expect(text(confirming)).toContain(MEMBER_SESSIONS_COPY.confirmBody);
    button(confirming, MEMBER_SESSIONS_COPY.confirmCancel);
  });

  it('starts one revoke for a double tap and disables every control while any sign-out runs', async () => {
    sessions.load.mockResolvedValue([currentRow]);
    app.value.signOut.mockImplementationOnce(() => new Promise<undefined>(() => undefined));
    render();
    await Promise.resolve();
    (button(render(), MEMBER_SESSIONS_COPY.signOutEverywhere).props.onPress as () => void)();
    const confirm = button(render(), MEMBER_SESSIONS_COPY.confirmAction).props.onPress as () => void;
    confirm();
    confirm();
    expect(app.value.signOut).toHaveBeenCalledTimes(1);
    expect(button(render(), MEMBER_SESSIONS_COPY.working).props.disabled).toBe(true);
    runtime.state.slots = [];
    runtime.state.effects = [];
    app.value.signOutBusy = true;
    render();
    await Promise.resolve();
    const tree = render();
    expect(button(tree, MEMBER_SESSIONS_COPY.signOutEverywhere).props.disabled).toBe(true);
    expect(button(tree, MEMBER_SESSIONS_COPY.refresh).props.disabled).toBe(true);
  });

  it('cancelling leaves the worker signed in and the list in place', async () => {
    sessions.load.mockResolvedValue([currentRow]);
    render();
    await Promise.resolve();
    (button(render(), MEMBER_SESSIONS_COPY.signOutEverywhere).props.onPress as () => void)();
    (button(render(), MEMBER_SESSIONS_COPY.confirmCancel).props.onPress as () => void)();
    const tree = render();
    expect(app.value.signOut).not.toHaveBeenCalled();
    expect(text(tree)).not.toContain(MEMBER_SESSIONS_COPY.confirmBody);
    expect(nodes(tree).filter((node) => node.type === 'GroupRow')).toHaveLength(1);
  });

  it('confirming revokes every session through the global scope', async () => {
    sessions.load.mockResolvedValue([currentRow, otherRow]);
    render();
    await Promise.resolve();
    (button(render(), MEMBER_SESSIONS_COPY.signOutEverywhere).props.onPress as () => void)();
    (button(render(), MEMBER_SESSIONS_COPY.confirmAction).props.onPress as () => void)();
    expect(app.value.signOut).toHaveBeenCalledWith({ scope: 'global' });
    // While the revoke is in flight the action names what it is doing and
    // refuses a second press, so one confirmation cannot become two revokes.
    const working = render();
    expect(button(working, MEMBER_SESSIONS_COPY.working).props.disabled).toBe(true);
    expect(button(working, MEMBER_SESSIONS_COPY.working).props.busy).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(app.value.signOut).toHaveBeenCalledTimes(1);
  });

  it('shows the sign-out path’s refusal and never a success line', async () => {
    sessions.load.mockResolvedValue([currentRow]);
    app.value.signOutError = 'Sign out everywhere is incomplete and your other devices may still be signed in. Notifications are paused; reconnect and finish signing out.';
    render();
    await Promise.resolve();
    const tree = render();
    expect(text(tree)).toContain('your other devices may still be signed in');
    expect(text(tree)).not.toMatch(/signed out everywhere|all devices signed out/i);
    expect(nodes(tree).some((node) => node.props.accessibilityRole === 'alert')).toBe(true);
  });

  it('refuses every control while another account action is busy', async () => {
    sessions.load.mockResolvedValue([currentRow]);
    app.value.sampleEntryBusy = true;
    render();
    await Promise.resolve();
    const tree = render();
    expect(button(tree, MEMBER_SESSIONS_COPY.signOutEverywhere).props.disabled).toBe(true);
    expect(button(tree, MEMBER_SESSIONS_COPY.refresh).props.disabled).toBe(true);
  });
});

describe('who sees the card', () => {
  it('renders nothing for a preview, signed-out, or two-step-pending app, and reads nothing', () => {
    for (const mode of ['preview', 'signedOut', 'mfaRequired']) {
      runtime.state.slots = [];
      runtime.state.effects = [];
      app.value.mode = mode;
      expect(render(), mode).toBeNull();
    }
    expect(sessions.load).not.toHaveBeenCalled();
  });

  it('is placed on the Account screen', () => {
    const account = readFileSync(new URL('../../app/(tabs)/account.tsx', import.meta.url), 'utf8');
    expect(account).toContain("import { NativeSessionsCard } from '../../src/features/NativeSessionsCard';");
    expect(account).toContain('<NativeSessionsCard />');
  });
});
