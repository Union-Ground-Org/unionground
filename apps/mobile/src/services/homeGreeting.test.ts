import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({
  items: new Map<string, string>(), fail: false, failWriteAfterPersist: false,
  // Deferred gates so a test can hold the read or the write open while Home's
  // eligibility changes underneath the attempt.
  holdRead: null as null | Promise<void>, holdWrite: null as null | Promise<void>, deleteCalls: 0,
  // A delete that reports success but leaves the value (#5442).
  deleteNoop: false,
  holdDelete: null as null | Promise<void>,
}));
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => {
    if (store.holdRead) await store.holdRead;
    if (store.fail) throw new Error('store unavailable');
    return store.items.get(key) ?? null;
  }),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    if (store.fail) throw new Error('store unavailable');
    store.items.set(key, value);
    if (store.holdWrite) await store.holdWrite;
    if (store.failWriteAfterPersist && value === '1') throw new Error('write reported failure after persisting');
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    store.deleteCalls += 1;
    if (store.holdDelete) await store.holdDelete;
    if (!store.deleteNoop) store.items.delete(key);
  }),
}));

import { forgetHomeGreetings, homeGreetingKey, homeGreetingShown, homeGreetingText, readHomeGreeting, subscribeHomeGreeting, type HomeGreeting, type HomeGreetingVisibility } from './homeGreeting';

// UX-UG-NATIVE-FIRST-HOME-WELCOME-BACK-20261018: a first Home says
// Welcome; later ones say Welcome back.
describe('home greeting', () => {
  beforeEach(() => { store.items.clear(); store.fail = false; store.failWriteAfterPersist = false; store.holdRead = null; store.holdWrite = null; store.deleteCalls = 0; store.deleteNoop = false; store.holdDelete = null; forgetHomeGreetings(); });

  it('says Welcome the first time an account sees Home on this phone and records that it was seen', async () => {
    await expect(readHomeGreeting('member-1')).resolves.toBe('welcome');
    expect(store.items.get(homeGreetingKey('member-1')!)).toBe('1');
    expect(homeGreetingText('welcome')).toBe('Welcome');
  });

  it('says Welcome back once the marker exists, per account', async () => {
    store.items.set(homeGreetingKey('member-1')!, '1');
    await expect(readHomeGreeting('member-1')).resolves.toBe('welcome-back');
    await expect(readHomeGreeting('member-2')).resolves.toBe('welcome');
    expect(homeGreetingText('welcome-back')).toBe('Welcome back');
  });

  it('holds the first decision for the app run so a re-render never flips the words', async () => {
    await expect(readHomeGreeting('member-1')).resolves.toBe('welcome');
    await expect(readHomeGreeting('member-1')).resolves.toBe('welcome');
    forgetHomeGreetings();
    await expect(readHomeGreeting('member-1')).resolves.toBe('welcome-back');
  });

  it('keeps the familiar words when the store is unreadable or the account id is not a key', async () => {
    store.fail = true;
    await expect(readHomeGreeting('member-1')).resolves.toBe('welcome-back');
    store.fail = false;
    forgetHomeGreetings();
    // Nothing was recorded by the failed attempt, so the next run decides again.
    await expect(readHomeGreeting('member-1')).resolves.toBe('welcome');
    expect(homeGreetingKey('not a key!')).toBeNull();
    await expect(readHomeGreeting('not a key!')).resolves.toBe('welcome-back');
  });

  it('removes a marker that persisted through a failed write and decides again on the next attempt (gate, Grok r2g2)', async () => {
    store.failWriteAfterPersist = true;
    await expect(readHomeGreeting('member-1')).resolves.toBe('welcome-back');
    expect(store.items.has(homeGreetingKey('member-1')!)).toBe(false);
    store.failWriteAfterPersist = false;
    // Not cached for the run: the next attempt reads the store again.
    await expect(readHomeGreeting('member-1')).resolves.toBe('welcome');
  });

  it('shares one read per account, so a Home that remounts mid-read sees the same first answer', async () => {
    const first = readHomeGreeting('member-1');
    const second = readHomeGreeting('member-1');
    expect(second).toBe(first);
    await expect(Promise.all([first, second])).resolves.toEqual(['welcome', 'welcome']);
    expect(store.items.size).toBe(1);
  });

  // Home's effect in one line: read (and so record) only while the gate holds.
  async function homeEffect(state: HomeGreetingVisibility) {
    return homeGreetingShown(state) && state.userID ? readHomeGreeting(state.userID) : null;
  }
  const visibleHome: HomeGreetingVisibility = { userID: 'member-1', dashboardLoaded: true, decided: true, takeover: false, locked: false, privacyCovered: false, focused: true };

  it('writes no first-view marker on a cold start under the biometric lock modal, and greets once the worker unlocks', async () => {
    // Cold start with the lock on: the session resumes, the dashboard loads
    // and the long-absence decision resolves to seen while the Unlock / Sign
    // out modal still covers Home (gate round 4 on #5056, Grok r4g1).
    await expect(homeEffect({ ...visibleHome, locked: true })).resolves.toBeNull();
    expect(store.items.size).toBe(0);
    // Killed there, the next launch still owes the one Welcome.
    forgetHomeGreetings();
    await expect(homeEffect({ ...visibleHome, locked: true })).resolves.toBeNull();
    expect(store.items.size).toBe(0);
    // The member unlocks: Home is in view, so the greeting is read and spent now.
    await expect(homeEffect(visibleHome)).resolves.toBe('welcome');
    expect(store.items.get(homeGreetingKey('member-1')!)).toBe('1');
  });

  it('writes nothing while another screen has focus (the Messages tab or Account over a retained Home; gate round 5 on #5056, Grok r5g1)', async () => {
    // Home stays mounted behind the other native tabs and behind Account, so
    // the long-absence RPC can resolve while Home is not on screen.
    await expect(homeEffect({ ...visibleHome, focused: false })).resolves.toBeNull();
    expect(store.items.size).toBe(0);
    await expect(homeEffect(visibleHome)).resolves.toBe('welcome');
  });

  it('writes nothing under the privacy cover, before the dashboard, before the long-absence decision, during the takeover or without an account', async () => {
    for (const hidden of [
      { ...visibleHome, privacyCovered: true },
      { ...visibleHome, focused: false },
      { ...visibleHome, dashboardLoaded: false },
      { ...visibleHome, decided: false },
      { ...visibleHome, takeover: true },
      { ...visibleHome, userID: null },
    ]) {
      expect(homeGreetingShown(hidden)).toBe(false);
      await expect(homeEffect(hidden)).resolves.toBeNull();
    }
    expect(store.items.size).toBe(0);
    expect(homeGreetingShown(visibleHome)).toBe(true);
  });

  // Home subscribes for as long as the gate holds; the cleanup withdraws.
  function deferred() {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
  }
  async function settle() { for (let i = 0; i < 6; i += 1) await Promise.resolve(); }

  it('withdraws an attempt whose caller leaves before the marker is read, so a later focused visit still gets its first Welcome', async () => {
    // The gate was true, Home subscribed, then the member moved to Account or
    // the privacy cover came down while SecureStore was still reading.
    const hold = deferred();
    store.holdRead = hold.promise;
    const seen: Array<HomeGreeting> = [];
    const unsubscribe = subscribeHomeGreeting('member-1', (greeting) => seen.push(greeting));
    unsubscribe();
    hold.release();
    await settle();
    expect(seen).toEqual([]);
    expect(store.items.size).toBe(0);
    expect(store.deleteCalls).toBe(0);
    // Back on a focused Home: the attempt starts over and spends the Welcome now.
    store.holdRead = null;
    await expect(readHomeGreeting('member-1')).resolves.toBe('welcome');
    expect(store.items.get(homeGreetingKey('member-1')!)).toBe('1');
  });

  it('removes only the marker an abandoned attempt itself wrote when eligibility flips during the write (Grok r5g3)', async () => {
    const hold = deferred();
    store.holdWrite = hold.promise;
    const seen: Array<HomeGreeting> = [];
    const unsubscribe = subscribeHomeGreeting('member-1', (greeting) => seen.push(greeting));
    await settle();
    expect(store.items.get(homeGreetingKey('member-1')!)).toBe('1');
    unsubscribe();
    hold.release();
    await settle();
    expect(seen).toEqual([]);
    expect(store.items.has(homeGreetingKey('member-1')!)).toBe(false);
    expect(store.deleteCalls).toBe(1);
    store.holdWrite = null;
    await expect(readHomeGreeting('member-1')).resolves.toBe('welcome');
  });

  it('never deletes a pre-existing marker when an attempt is abandoned', async () => {
    store.items.set(homeGreetingKey('member-1')!, '1');
    const hold = deferred();
    store.holdRead = hold.promise;
    const unsubscribe = subscribeHomeGreeting('member-1', () => undefined);
    unsubscribe();
    hold.release();
    await settle();
    expect(store.items.get(homeGreetingKey('member-1')!)).toBe('1');
    expect(store.deleteCalls).toBe(0);
    store.holdRead = null;
    await expect(readHomeGreeting('member-1')).resolves.toBe('welcome-back');
  });

  it('keeps the marker and the answer when a remounted Home takes over the attempt before it settles', async () => {
    const hold = deferred();
    store.holdWrite = hold.promise;
    const first: Array<HomeGreeting> = [];
    const second: Array<HomeGreeting> = [];
    const leaveFirst = subscribeHomeGreeting('member-1', (greeting) => first.push(greeting));
    await settle();
    const leaveSecond = subscribeHomeGreeting('member-1', (greeting) => second.push(greeting));
    leaveFirst();
    hold.release();
    await settle();
    expect(first).toEqual([]);
    expect(second).toEqual(['welcome']);
    expect(store.items.get(homeGreetingKey('member-1')!)).toBe('1');
    expect(store.deleteCalls).toBe(0);
    leaveSecond();
    // Held for the run: the next subscriber gets the same answer at once.
    const later: Array<HomeGreeting> = [];
    subscribeHomeGreeting('member-1', (greeting) => later.push(greeting))();
    expect(later).toEqual(['welcome']);
  });

  // UX-UG-NATIVE-HOME-GREETING-MARKER-DELETE-UNVERIFIED-20261020: a
  // compensating delete that silently keeps the value must not leave the
  // account greeted for good.
  it('reads the marker back after a failed write; a delete that kept it is overwritten so a later run still says Welcome', async () => {
    store.failWriteAfterPersist = true;
    store.deleteNoop = true;
    await expect(readHomeGreeting('member-1')).resolves.toBe('welcome-back');
    expect(store.items.get(homeGreetingKey('member-1')!)).toBe('0');
    store.failWriteAfterPersist = false;
    store.deleteNoop = false;
    forgetHomeGreetings();
    await expect(readHomeGreeting('member-1')).resolves.toBe('welcome');
    expect(store.items.get(homeGreetingKey('member-1')!)).toBe('1');
  });

  it('treats a cleared marker as never greeted', async () => {
    store.items.set(homeGreetingKey('member-1')!, '0');
    await expect(readHomeGreeting('member-1')).resolves.toBe('welcome');
  });

  it('overwrites an abandoned attempt\'s own marker when the delete keeps it', async () => {
    let release: () => void = () => undefined;
    store.holdWrite = new Promise<void>((resolve) => { release = resolve; });
    store.deleteNoop = true;
    const unsubscribe = subscribeHomeGreeting('member-1', () => undefined);
    await vi.waitFor(() => expect(store.items.get(homeGreetingKey('member-1')!)).toBe('1'));
    unsubscribe();
    release();
    await vi.waitFor(() => expect(store.items.get(homeGreetingKey('member-1')!)).toBe('0'));
    store.deleteNoop = false;
    store.holdWrite = null;
    forgetHomeGreetings();
    await expect(readHomeGreeting('member-1')).resolves.toBe('welcome');
  });

  // A Home that regains
  // focus while an abandoned attempt is still clearing its marker waits for
  // that clear, so it neither reads the leftover marker nor has its own fresh
  // marker overwritten by the clear's read-back.
  it('waits for an abandoned attempt to finish clearing before a new attempt reads the marker', async () => {
    let releaseWrite: () => void = () => undefined;
    let releaseDelete: () => void = () => undefined;
    store.holdWrite = new Promise<void>((resolve) => { releaseWrite = resolve; });
    store.holdDelete = new Promise<void>((resolve) => { releaseDelete = resolve; });
    const unsubscribe = subscribeHomeGreeting('member-1', () => undefined);
    await vi.waitFor(() => expect(store.items.get(homeGreetingKey('member-1')!)).toBe('1'));
    unsubscribe();
    store.holdWrite = null;
    releaseWrite();
    await vi.waitFor(() => expect(store.deleteCalls).toBe(1));
    const heard: HomeGreeting[] = [];
    subscribeHomeGreeting('member-1', (greeting) => heard.push(greeting));
    store.holdDelete = null;
    releaseDelete();
    await vi.waitFor(() => expect(heard).toEqual(['welcome']));
    expect(store.items.get(homeGreetingKey('member-1')!)).toBe('1');
  });

  it('is what Home renders in place of the fixed Welcome back line', () => {
    const home = readFileSync(fileURLToPath(new URL('../../app/(tabs)/home.tsx', import.meta.url)), 'utf8');
    expect(home).not.toContain('<Body muted>Welcome back</Body>');
    expect(home).toContain('subscribeHomeGreeting(');
    expect(home).toContain('homeGreetingText(greeting)');
    // The marker is spent only when the intro line is about to be shown
    // (gate round 1 on #5056): a loaded dashboard and no welcome-back takeover.
    // ...and only once this run's long-absence decision is known (gate, Grok r2g1),
    // and never under the biometric lock or privacy cover (gate, Grok r4g1).
    expect(home).toContain("const { chapterMemberships, dashboard, error, refreshing, refresh, session, locked, privacyCovered } = useApp();");
    // ...and only while Home has navigation focus (gate round 5, Grok r5g1):
    // the native tabs keep every tab mounted, and Account is pushed over Home.
    expect(home).toContain("import { useIsFocused, useRouter } from 'expo-router';");
    expect(home).toContain('const focused = useIsFocused();');
    expect(home).toContain('const greetingShown = homeGreetingShown({ userID: greetingUserID, dashboardLoaded: dashboard !== null, decided: welcome.decided, takeover: welcome.show, locked, privacyCovered, focused });');
    // The subscription withdraws when the gate flips, so an attempt that is
    // still reading or writing takes back its own marker (Grok r5g3).
    expect(home).toContain('return subscribeHomeGreeting(greetingUserID, setGreeting);');
    expect(home).toContain("if (!greetingShown || !greetingUserID) { setGreeting(null); return undefined; }");
  });
});
