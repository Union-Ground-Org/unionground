import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => {
  const state = { slots: [] as unknown[], index: 0 };
  return {
    state,
    useState<T>(initial: T) {
      const index = state.index++;
      if (index >= state.slots.length) state.slots[index] = initial;
      return [state.slots[index] as T, (value: T) => { state.slots[index] = value; }] as const;
    },
    useRef<T>(initial: T) {
      const index = state.index++;
      if (index >= state.slots.length) state.slots[index] = { current: initial };
      return state.slots[index] as { current: T };
    },
    useEffect(effect: () => (() => void) | undefined, dependencies: readonly unknown[]) {
      const index = state.index++;
      const previous = state.slots[index] as { dependencies: readonly unknown[]; cleanup?: () => void } | undefined;
      if (!previous || dependencies.some((value, at) => value !== previous.dependencies[at])) {
        previous?.cleanup?.();
        state.slots[index] = { dependencies, cleanup: effect() };
      }
    },
  };
});
const app = vi.hoisted(() => ({
  memberLanguage: 'en' as 'en' | 'es',
  mode: 'authenticated', signOut: vi.fn(async () => {}), signOutBusy: false,
  sampleEntryBusy: false, signOutError: null as string | null,
}));
const accessibility = vi.hoisted(() => ({ platform: { OS: 'ios' }, queue: vi.fn(() => vi.fn()) }));
vi.mock('react', () => ({ useState: runtime.useState, useRef: runtime.useRef, useEffect: runtime.useEffect, useId: () => 'sign-out-test' }));
vi.mock('react-native', () => ({ View: 'View', Platform: accessibility.platform }));
vi.mock('../lib/announce', () => ({ queueAccessibilityAnnouncement: accessibility.queue }));
vi.mock('../components/ui', () => ({ Body: 'Body', Button: 'Button', Card: 'Card', Heading: 'Heading' }));
vi.mock('../state/AppProvider', () => ({ useApp: () => app }));
const { NativeSignOut } = await import('./NativeSignOut');

type Node = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (typeof value !== 'object' || value === null || !('props' in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
function render() {
  runtime.state.index = 0;
  return NativeSignOut();
}
function button(tree: unknown, label: string): Node {
  const found = nodes(tree).find((node) => node.type === 'Button' && node.props.label === label);
  expect(found, label).toBeTruthy();
  return found!;
}
function press(tree: unknown, label: string) {
  const control = button(tree, label);
  expect(control.props.disabled).toBe(false);
  (control.props.onPress as () => void)();
}
function text(tree: unknown) {
  return nodes(tree).map((node) => node.props.children).filter((value) => typeof value === 'string').join(' ');
}
function queuedCancel() {
  const result = accessibility.queue.mock.results[0];
  if (result?.type !== 'return') throw new Error('Expected a queued announcement');
  return result.value;
}

beforeEach(() => {
  runtime.state.slots = [];
  accessibility.platform.OS = 'ios';
  accessibility.queue.mockClear();
  app.mode = 'authenticated';
  app.memberLanguage = 'en';
  app.signOut = vi.fn(async () => {});
  app.signOutBusy = false;
  app.sampleEntryBusy = false;
  app.signOutError = null;
});

describe('Account sign-out confirmation', () => {
  it.each<[string, 'en' | 'es']>([['authenticated', 'en'], ['authenticated', 'es'], ['preview', 'en'], ['preview', 'es']])(
    'keeps stable entry and confirmation identifiers in %s / %s', async (mode, language) => {
      app.mode = mode; app.memberLanguage = language;
      const entry = nodes(render()).find((node) => node.type === 'Button' && node.props.testID === 'native-account-sign-out');
      expect(entry).toBeTruthy();
      (entry!.props.onPress as () => void)();
      const confirm = nodes(render()).find((node) => node.type === 'Button' && node.props.testID === 'native-account-confirm-sign-out');
      expect(confirm).toBeTruthy();
      expect(app.signOut).not.toHaveBeenCalled();
      (confirm!.props.onPress as () => void)();
      await Promise.resolve();
      expect(app.signOut).toHaveBeenCalledOnce();
    },
  );

  it('keeps the entry before settings and resets it when the account changes', () => {
    const account = readFileSync(new URL('../../app/(tabs)/account.tsx', import.meta.url), 'utf8');
    expect(account.indexOf('<NativeSignOut')).toBeLessThan(account.indexOf('<ThemeSection />'));
    expect(account).toContain('<NativeSignOut key={`sign-out:${session?.user.id ?? mode}`} />');
    expect(account).not.toContain('void signOut()');
    expect(account).toContain('<NativeSessionsCard />');
  });

  it('asks before signing out and Cancel keeps the session', () => {
    press(render(), 'Sign out');
    const confirmation = render();
    expect(text(confirmation)).toContain('Sign out of this phone?');
    expect(text(confirmation)).toContain('Your other devices stay signed in.');
    expect(app.signOut).not.toHaveBeenCalled();
    press(confirmation, 'Cancel');
    button(render(), 'Sign out');
    expect(app.signOut).not.toHaveBeenCalled();
  });

  it('uses the existing local teardown once, even for two immediate confirm taps', async () => {
    let finish: () => void = () => {};
    app.signOut.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    press(render(), 'Sign out');
    const confirmation = render();
    press(confirmation, 'Confirm sign out');
    press(confirmation, 'Confirm sign out');
    expect(app.signOut.mock.calls).toEqual([[]]);
    const working = render();
    expect(button(working, 'Signing out…').props).toMatchObject({ busy: true, disabled: true });
    expect(button(working, 'Cancel').props.disabled).toBe(true);
    finish();
    await Promise.resolve();
    button(render(), 'Sign out');
  });

  it.each(['signOutBusy', 'sampleEntryBusy'] as const)('blocks changes while %s owns the session', (key) => {
    app[key] = true;
    expect(button(render(), 'Sign out').props.disabled).toBe(true);
    app[key] = false;
    press(render(), 'Sign out');
    app[key] = true;
    const busy = render();
    expect(button(busy, 'Confirm sign out').props).toMatchObject({ busy: true, disabled: true });
    (button(busy, 'Confirm sign out').props.onPress as () => void)();
    expect(app.signOut).not.toHaveBeenCalled();
  });

  it('shows provider refusals beside the entry and permits another attempt', async () => {
    app.signOut.mockImplementation(async () => { app.signOutError = 'Sign-out was not confirmed. Try again.'; });
    press(render(), 'Sign out');
    press(render(), 'Confirm sign out');
    await Promise.resolve();
    const failed = render();
    button(failed, 'Sign out');
    expect(nodes(failed).find((node) => node.props.accessibilityRole === 'alert')?.props.children).toBe(app.signOutError);
  });

  it('confirms leaving preview without promising an account sign-out', () => {
    app.mode = 'preview';
    press(render(), 'Exit preview');
    const confirmation = render();
    expect(text(confirmation)).toContain('Exit preview?');
    expect(text(confirmation)).not.toContain('Your other devices');
    expect(app.signOut).not.toHaveBeenCalled();
    press(confirmation, 'Confirm exit preview');
    expect(app.signOut).toHaveBeenCalledOnce();
  });

  it.each([['authenticated', 'Sign out', 'Sign out of this phone?'], ['preview', 'Exit preview', 'Exit preview?']])(
    'announces the %s confirmation once on arrival and cancels it on dismissal', (mode, entry, heading) => {
      app.mode = mode;
      press(render(), entry);
      const confirmation = render();
      expect(accessibility.queue.mock.calls).toEqual([[heading, 'sign-out-test:1']]);
      render();
      expect(accessibility.queue).toHaveBeenCalledOnce();
      const cancel = queuedCancel();
      press(confirmation, 'Cancel'); render();
      expect(cancel).toHaveBeenCalledOnce();
      press(render(), entry); render();
      expect(accessibility.queue).toHaveBeenCalledTimes(2);
      expect(accessibility.queue).toHaveBeenLastCalledWith(heading, 'sign-out-test:2');
    },
  );

  it('announces a provider error when it appears, without repeating it on rerender', () => {
    render();
    expect(accessibility.queue).not.toHaveBeenCalled();
    app.signOutError = 'Sign-out is incomplete. Try again.';
    render(); render();
    expect(accessibility.queue.mock.calls).toEqual([[app.signOutError, 'sign-out-test:1']]);
    const cancel = queuedCancel();
    app.signOutError = null; render();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('keeps Android live regions without duplicating their announcement', () => {
    accessibility.platform.OS = 'android';
    press(render(), 'Sign out');
    app.signOutError = 'Sign-out is incomplete. Try again.';
    const confirmation = render();
    expect(nodes(confirmation).some((node) => node.props.accessibilityLiveRegion === 'polite')).toBe(true);
    expect(accessibility.queue).not.toHaveBeenCalled();
  });

  it('resets the card, announces the error and permits retry when signOut rejects', async () => {
    app.signOut.mockRejectedValueOnce(new Error('unexpected teardown rejection'));
    press(render(), 'Sign out'); press(render(), 'Confirm sign out');
    await Promise.resolve();
    const failed = render();
    expect(button(failed, 'Sign out').props.disabled).toBe(false);
    expect(text(failed)).toContain('Sign-out was not confirmed. Try again.');
    expect(accessibility.queue).toHaveBeenLastCalledWith('Sign-out was not confirmed. Try again.', 'sign-out-test:2');
    press(failed, 'Sign out'); press(render(), 'Confirm sign out');
    await Promise.resolve();
    expect(text(render())).not.toContain('Sign-out was not confirmed. Try again.');
    expect(app.signOut).toHaveBeenCalledTimes(2);
  });

  it('names only this card’s in-progress preview exit', async () => {
    app.mode = 'preview';
    let finish: () => void = () => {};
    app.signOut.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    press(render(), 'Exit preview'); press(render(), 'Confirm exit preview');
    expect(button(render(), 'Exiting preview…').props).toMatchObject({ busy: true, disabled: true });
    finish(); await Promise.resolve();
    button(render(), 'Exit preview');
  });
});
