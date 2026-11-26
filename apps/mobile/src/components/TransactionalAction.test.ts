import { beforeEach, describe, expect, it, vi } from 'vitest';

// Behavioural cover for the shared transactional primitive (triage F3). The
// contract test beside this one pins the primitive's anatomy as source text;
// this one runs it.
//
// The mobile package tests in plain node with no React renderer and no DOM
// (vitest.config.mts), so the smallest honest harness is a synchronous
// implementation of the four hooks the primitive uses, with the native modules
// it imports stubbed. Everything under test — the re-entrancy guard, the
// unmounted guard, the haptics, the status sequence, the one announcement per
// arrival — is the shipped code, not a transcription of it.

const runtime = vi.hoisted(() => {
  type EffectSlot = { deps: readonly unknown[] | undefined; cleanup: (() => void) | void };
  type Host = {
    slots: unknown[];
    effects: EffectSlot[];
    queue: Array<() => void>;
    index: number;
    effectIndex: number;
    mounted: boolean;
    /** Any state write attempted after unmount — the guard's proof. */
    updatesAfterUnmount: number;
    renders: number;
    render: () => void;
    unmount: () => void;
  };

  let current: Host | null = null;

  function host(): Host {
    if (!current) throw new Error('a hook ran outside a harness render');
    return current;
  }

  function sameDeps(left: readonly unknown[] | undefined, right: readonly unknown[] | undefined) {
    if (!left || !right || left.length !== right.length) return false;
    return left.every((value, index) => Object.is(value, right[index]));
  }

  const hooks = {
    useState<T>(initial: T | (() => T)) {
      const self = host();
      const index = self.index++;
      if (index >= self.slots.length) {
        self.slots[index] = typeof initial === 'function' ? (initial as () => T)() : initial;
      }
      const set = (next: T | ((previous: T) => T)) => {
        if (!self.mounted) {
          self.updatesAfterUnmount += 1;
          return;
        }
        const previous = self.slots[index] as T;
        const value = typeof next === 'function' ? (next as (value: T) => T)(previous) : next;
        if (Object.is(value, previous)) return;
        self.slots[index] = value;
        self.render();
      };
      return [self.slots[index] as T, set] as const;
    },
    useRef<T>(initial: T) {
      const self = host();
      const index = self.index++;
      if (index >= self.slots.length) self.slots[index] = { current: initial };
      return self.slots[index] as { current: T };
    },
    useCallback<T>(fn: T, deps: readonly unknown[]) {
      const self = host();
      const index = self.index++;
      const previous = self.slots[index] as { fn: T; deps: readonly unknown[] } | undefined;
      if (previous && sameDeps(previous.deps, deps)) return previous.fn;
      self.slots[index] = { fn, deps };
      return fn;
    },
    useEffect(fn: () => (() => void) | void, deps?: readonly unknown[]) {
      const self = host();
      const index = self.effectIndex++;
      const previous = self.effects[index];
      if (previous && sameDeps(previous.deps, deps)) return;
      self.effects[index] = { deps, cleanup: previous?.cleanup };
      // Effects commit after the render, as React runs them.
      self.queue.push(() => {
        if (previous?.cleanup) previous.cleanup();
        self.effects[index] = { deps, cleanup: fn() };
      });
    },
  };

  function mount<T>(body: () => T) {
    let result: T | undefined;
    const self: Host = {
      slots: [],
      effects: [],
      queue: [],
      index: 0,
      effectIndex: 0,
      mounted: true,
      updatesAfterUnmount: 0,
      renders: 0,
      render() {
        const outer = current;
        current = self;
        self.index = 0;
        self.effectIndex = 0;
        self.renders += 1;
        try {
          result = body();
        } finally {
          current = outer;
        }
        for (const run of self.queue.splice(0)) run();
      },
      unmount() {
        self.mounted = false;
        for (const effect of self.effects) if (effect.cleanup) effect.cleanup();
      },
    };
    self.render();
    return { host: self, value: () => result as T };
  }

  return { hooks, mount, motion: { reduce: false }, platform: { os: 'android' } };
});

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, ...runtime.hooks };
});

vi.mock('react-native', () => {
  class Value {
    constructor(public value: number) {}
    setValue(next: number) { this.value = next; }
    interpolate() { return this; }
  }
  return {
    AccessibilityInfo: {
      announceForAccessibility: vi.fn(),
      announceForAccessibilityWithOptions: vi.fn(),
    },
    // Read through a getter so a test can move the primitive between
    // platforms without re-mocking the module.
    Platform: { get OS() { return runtime.platform.os; } },
    Animated: {
      Value,
      spring: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
      View: 'Animated.View',
    },
    StyleSheet: { create: (sheet: unknown) => sheet, hairlineWidth: 1 },
    Text: 'Text',
    View: 'View',
  };
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('./ui', () => ({ Button: () => null }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => ({}) }));
vi.mock('../lib/reduceMotion', () => ({ useReduceMotion: () => runtime.motion.reduce }));
vi.mock('../services/haptics', () => ({
  haptics: {
    select: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    impact: vi.fn(),
  },
}));

const { AccessibilityInfo } = await import('react-native');
const { haptics } = await import('../services/haptics');
const { useAccessibilityAnnouncementQueue } = await import('../lib/announce');
const { useTransactionalAction, useTransactionalEntrance } = await import('./TransactionalAction');

const announce = vi.mocked(AccessibilityInfo.announceForAccessibility);
const announceQueued = vi.mocked(AccessibilityInfo.announceForAccessibilityWithOptions);
const success = vi.mocked(haptics.success);
const warning = vi.mocked(haptics.warning);

/** Lets the primitive's `.then(...).finally(...)` chain settle. */
const settled = () => new Promise((resolve) => { setTimeout(resolve, 0); });

function deferred() {
  let resolve: () => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = () => onResolve();
    reject = onReject;
  });
  // The rejection is always handled by the primitive; this keeps node from
  // reporting the pre-attachment window as unhandled.
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

function mountAction(run: () => void | Promise<void>) {
  const statuses: string[] = [];
  const harness = runtime.mount(() => {
    const action = useTransactionalAction(run);
    statuses.push(action.status);
    return action;
  });
  return { ...harness, statuses };
}

beforeEach(() => {
  vi.clearAllMocks();
  runtime.motion.reduce = false;
  runtime.platform.os = 'android';
});

describe('useTransactionalAction', () => {
  it('settles a synchronous write straight to done, with no busy frame', () => {
    // A synchronous write has no latency to report, so a spinner would flash
    // for one frame and the confirmation would mount a tick late.
    const run = vi.fn();
    const { value, statuses } = mountAction(run);

    expect(value().status).toBe('idle');
    value().perform();

    expect(run).toHaveBeenCalledTimes(1);
    expect(value().status).toBe('done');
    expect(value().done).toBe(true);
    expect(statuses).toEqual(['idle', 'done']);
    expect(statuses).not.toContain('busy');
    expect(success).toHaveBeenCalledTimes(1);
    expect(warning).not.toHaveBeenCalled();
  });

  it('holds the control busy across an async write, then settles it once', async () => {
    const flight = deferred();
    const { value, statuses } = mountAction(() => flight.promise);

    value().perform();
    expect(value().status).toBe('busy');
    expect(value().busy).toBe(true);
    // The haptic belongs to the arrival, not to the press.
    expect(success).not.toHaveBeenCalled();

    flight.resolve();
    await settled();

    expect(value().status).toBe('done');
    expect(statuses).toEqual(['idle', 'busy', 'done']);
    expect(success).toHaveBeenCalledTimes(1);
  });

  it('returns a failed write to idle with the warning haptic', async () => {
    const flight = deferred();
    const { value, statuses } = mountAction(() => flight.promise);

    value().perform();
    flight.reject(new Error('the vote was not confirmed'));
    await settled();

    // Never a confirmation the member did not earn.
    expect(value().status).toBe('idle');
    expect(value().done).toBe(false);
    expect(statuses).toEqual(['idle', 'busy', 'idle']);
    expect(success).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it('returns to idle when the write throws synchronously', () => {
    const { value } = mountAction(() => { throw new Error('refused'); });

    expect(() => value().perform()).not.toThrow();
    expect(value().status).toBe('idle');
    expect(success).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it('refuses a second press while the first write is in flight', async () => {
    const flight = deferred();
    const run = vi.fn(() => flight.promise);
    const { value } = mountAction(run);

    value().perform();
    value().perform();
    value().perform();

    // One press, one write: a double-tapped ballot is cast once.
    expect(run).toHaveBeenCalledTimes(1);

    flight.resolve();
    await settled();

    expect(value().status).toBe('done');
    expect(success).toHaveBeenCalledTimes(1);
  });

  it('does not write state after the surface unmounts mid-flight', async () => {
    const flight = deferred();
    const { host, value } = mountAction(() => flight.promise);

    value().perform();
    expect(value().status).toBe('busy');
    host.unmount();
    flight.resolve();
    await settled();

    // The write itself did settle — the haptic fired — and the guard is what
    // stopped the result being written into a component that is gone.
    expect(success).toHaveBeenCalledTimes(1);
    expect(host.updatesAfterUnmount).toBe(0);
    expect(value().status).toBe('busy');
  });
});

describe('useAccessibilityAnnouncementQueue', () => {
  it('cancels pending feedback on unmount', async () => {
    const harness = runtime.mount(() => useAccessibilityAnnouncementQueue('member-a'));

    harness.value()('The retry failed.');
    harness.host.unmount();
    await settled();

    expect(announce).not.toHaveBeenCalled();
  });

  it('refuses an obsolete async owner and preserves identical retry attempts', async () => {
    const props = { owner: 'member-a' };
    const harness = runtime.mount(() => useAccessibilityAnnouncementQueue(props.owner));
    const obsoleteQueue = harness.value();

    obsoleteQueue('The retry failed.');
    props.owner = 'member-b';
    harness.host.render();
    obsoleteQueue('The retry failed.');
    harness.value()('The retry failed.');
    await settled();

    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenLastCalledWith('The retry failed.');

    harness.value()('The retry failed.');
    await settled();
    expect(announce).toHaveBeenCalledTimes(2);
  });
});

describe('useTransactionalEntrance', () => {
  it('announces an arrival exactly once, however often it re-renders', async () => {
    const harness = runtime.mount(() => useTransactionalEntrance(true, 'Recorded. Receipt PSG-1.'));
    await settled();

    expect(announce).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledWith('Recorded. Receipt PSG-1.');

    harness.host.render();
    harness.host.render();
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it('still announces under Reduce Motion, where there is no entrance to see', async () => {
    runtime.motion.reduce = true;
    runtime.mount(() => useTransactionalEntrance(true, 'In review with the committee.'));
    await settled();

    expect(announce).toHaveBeenCalledTimes(1);
  });

  it('says nothing for a receipt that was already on the record', () => {
    // `enabled` false is "this was not an arrival": a history row that was on
    // screen at mount must not speak.
    runtime.mount(() => useTransactionalEntrance(false, 'Recorded. Receipt PSG-1.'));

    expect(announce).not.toHaveBeenCalled();
  });

  it('speaks once when a row becomes an arrival, and once again for the next one', async () => {
    const props = { enabled: false, message: 'Today. 8 hrs · shift logged.' };
    const harness = runtime.mount(() => useTransactionalEntrance(props.enabled, props.message));

    expect(announce).not.toHaveBeenCalled();

    props.enabled = true;
    harness.host.render();
    harness.host.render();
    await settled();
    expect(announce).toHaveBeenCalledTimes(1);

    // The row stops being the newest one, then a later write makes it one
    // again: the latch clears, so the next arrival is heard.
    props.enabled = false;
    harness.host.render();
    props.enabled = true;
    harness.host.render();
    await settled();
    expect(announce).toHaveBeenCalledTimes(2);
  });

  it('leaves a silent reveal silent', () => {
    runtime.mount(() => useTransactionalEntrance(true));

    expect(announce).not.toHaveBeenCalled();
  });

  it('queues the announcement on iOS instead of interrupting VoiceOver', async () => {
    runtime.platform.os = 'ios';
    runtime.mount(() => useTransactionalEntrance(true, 'Recorded. Receipt PSG-1.'));
    await settled();

    // One announcement, through the queueing call, and never both paths.
    expect(announceQueued).toHaveBeenCalledTimes(1);
    expect(announceQueued).toHaveBeenCalledWith('Recorded. Receipt PSG-1.', { queue: true });
    expect(announce).not.toHaveBeenCalled();
  });

  it('keeps the plain call everywhere else', async () => {
    runtime.mount(() => useTransactionalEntrance(true, 'In review with the committee.'));
    await settled();

    // TalkBack has no queue argument; the option must not leak off iOS.
    expect(announce).toHaveBeenCalledTimes(1);
    expect(announceQueued).not.toHaveBeenCalled();
  });

  it('does not speak twice when Reduce Motion changes under a live arrival', async () => {
    // The latch's real hazard: `reduceMotion` is an effect dependency, so
    // toggling the system setting re-runs the effect on a surface that is
    // still the same arrival. The receipt must not be read out a second time
    // because the member turned animations off while it was on screen.
    const harness = runtime.mount(() => useTransactionalEntrance(true, 'Recorded. Receipt PSG-1.'));
    await settled();

    expect(announce).toHaveBeenCalledTimes(1);

    runtime.motion.reduce = true;
    harness.host.render();
    runtime.motion.reduce = false;
    harness.host.render();

    expect(announce).toHaveBeenCalledTimes(1);
  });
});
