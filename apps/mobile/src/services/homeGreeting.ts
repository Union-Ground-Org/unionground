// UX-UG-NATIVE-FIRST-HOME-WELCOME-BACK-20261018: the first Home a
// member ever sees on this phone says "Welcome"; every later one says
// "Welcome back". The only state is a per-account marker in this phone's
// secure storage, written the first time Home is shown for that account. The
// decision is held for the app run so a re-render never flips the words, and
// an unreadable store falls back to the familiar "Welcome back".
import * as SecureStore from 'expo-secure-store';

export type HomeGreeting = 'welcome' | 'welcome-back';

const ACCOUNT = /^[A-Za-z0-9-]{1,64}$/;
const decided = new Map<string, HomeGreeting>();

export function homeGreetingKey(userID: string): string | null {
  return ACCOUNT.test(userID) ? `org.unionground.app.home-seen-v1.${userID}` : null;
}

export function homeGreetingText(greeting: HomeGreeting): string {
  return greeting === 'welcome' ? 'Welcome' : 'Welcome back';
}

// The one gate for reading (and so spending) the greeting. Home shows the
// intro line only when every clause holds: a signed-in account, a loaded
// dashboard, this run's long-absence decision known and not taking Home over
// (gate rounds 1-2 on #5056), and no root modal in front of the tab tree: the
// biometric lock and the privacy cover both hide Home while mounted, and a
// marker written under them is spent unseen if the app is killed there (gate
// round 4 on #5056, Grok r4g1).
// ...and Home itself has navigation focus: the native tabs keep every tab
// mounted and Account is pushed over Home, so the long-absence decision can
// resolve while another screen is on top (gate round 5 on #5056, Grok r5g1).
export type HomeGreetingVisibility = {
  userID: string | null;
  dashboardLoaded: boolean;
  decided: boolean;
  takeover: boolean;
  locked: boolean;
  privacyCovered: boolean;
  focused: boolean;
};

export function homeGreetingShown(state: HomeGreetingVisibility): boolean {
  return state.userID !== null && state.dashboardLoaded && state.decided && !state.takeover && !state.locked && !state.privacyCovered && state.focused;
}

// One attempt per account per run. Callers subscribe for as long as the
// greeting line is eligible to show and withdraw when it is not (Home's
// effect cleanup). A Home that remounts while the attempt is in flight joins
// the same attempt instead of reading the marker the first call just wrote
// (gate round 1 on #5056, Grok r1g1). When the last subscriber withdraws
// before the attempt settles, the attempt takes back only a marker it wrote
// itself this run, never a pre-existing one, and holds no answer, so a later
// eligible visit decides again and can still say Welcome (gate round 5,
// ).
type Attempt = {
  subscribers: Set<(greeting: HomeGreeting) => void>;
  settled: Promise<HomeGreeting | null>;
};
const attempts = new Map<string, Attempt>();

// The marker means "already greeted"; NOT_GREETED is what a clear leaves when
// the store will not delete. UX-UNIONGROUND-NATIVE-HOME-GREETING-MARKER-DELETE-
// UNVERIFIED-20261020: a compensating delete can return without removing the
// value, which would then say Welcome back on every later launch. Read the key
// back after the delete (the secureShareIntake pattern); if the value is still
// there, overwrite it with NOT_GREETED and read that back too. Reads treat
// NOT_GREETED as never greeted, so a later run can still say Welcome.
const GREETED = '1';
const NOT_GREETED = '0';

// One clear at a time per account, and no attempt reads the marker while a
// clear for that account is still running: otherwise the read-back could take
// a newer attempt's fresh marker for one the delete missed and overwrite it
// .
const clearing = new Map<string, Promise<boolean>>();

function clearMarkerFor(userID: string, key: string): Promise<boolean> {
  const cleared = clearMarker(key).finally(() => {
    if (clearing.get(userID) === cleared) clearing.delete(userID);
  });
  clearing.set(userID, cleared);
  return cleared;
}

async function clearMarker(key: string): Promise<boolean> {
  try {
    await SecureStore.deleteItemAsync(key);
    const left = await SecureStore.getItemAsync(key);
    if (left === null || left === NOT_GREETED) return true;
    await SecureStore.setItemAsync(key, NOT_GREETED);
    return await SecureStore.getItemAsync(key) === NOT_GREETED;
  } catch {
    return false;
  }
}

async function decideHomeGreeting(userID: string, key: string, attempt: Attempt): Promise<HomeGreeting | null> {
  let greeting: HomeGreeting = 'welcome-back';
  let settled = false;
  let wroteMarker = false;
  try {
    await clearing.get(userID);
    const stored = await SecureStore.getItemAsync(key);
    const seen = stored === NOT_GREETED ? null : stored;
    if (seen === null && attempt.subscribers.size === 0) {
      // Every caller left during the read: write nothing, hold no answer.
      attempts.delete(userID);
      return null;
    }
    if (seen === null) {
      try {
        await SecureStore.setItemAsync(key, GREETED);
      } catch {
        // A write can persist and still throw: clear whatever landed, checked
        // by reading it back, so no later run treats this account as greeted.
        await clearMarkerFor(userID, key);
        throw new Error('marker not written');
      }
      wroteMarker = true;
      greeting = 'welcome';
    }
    settled = true;
  } catch {
    // The marker could not be read or written: keep the familiar words,
    // record nothing and hold no answer, so a later attempt decides again.
    greeting = 'welcome-back';
  }
  attempts.delete(userID);
  if (attempt.subscribers.size === 0 && wroteMarker) {
    // Every caller left while this attempt was spending the Welcome: nobody
    // saw it, so take back this attempt's own marker and hold no answer.
    await clearMarkerFor(userID, key);
    return null;
  }
  if (settled) decided.set(userID, greeting);
  for (const subscriber of attempt.subscribers) subscriber(greeting);
  return greeting;
}

// Call this only while the greeting line is eligible to show (homeGreetingShown):
// the first read writes the marker, so a read behind a loading or error
// screen would spend the member's one "Welcome" unseen (gate round 1 on
// #5056, Grok r1g2, Sol r1s1). Returns the unsubscribe for the effect cleanup.
export function subscribeHomeGreeting(userID: string, onDecision: (greeting: HomeGreeting) => void): () => void {
  const held = decided.get(userID);
  if (held) { onDecision(held); return () => undefined; }
  const key = homeGreetingKey(userID);
  if (!key) { onDecision('welcome-back'); return () => undefined; }
  let attempt = attempts.get(userID);
  if (!attempt) {
    const started: Attempt = { subscribers: new Set(), settled: Promise.resolve(null) };
    attempts.set(userID, started);
    started.settled = decideHomeGreeting(userID, key, started);
    attempt = started;
  }
  attempt.subscribers.add(onDecision);
  return () => { attempt.subscribers.delete(onDecision); };
}

// The one-shot form: a caller that stays eligible until the answer arrives.
export function readHomeGreeting(userID: string): Promise<HomeGreeting | null> {
  const held = decided.get(userID);
  if (held) return Promise.resolve(held);
  const key = homeGreetingKey(userID);
  if (!key) return Promise.resolve('welcome-back');
  subscribeHomeGreeting(userID, () => undefined);
  return attempts.get(userID)!.settled;
}

export function forgetHomeGreetings(): void {
  decided.clear();
  attempts.clear();
  clearing.clear();
}
