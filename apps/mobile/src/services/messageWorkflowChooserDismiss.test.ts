import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import * as SecureStore from 'expo-secure-store';

import { messageWorkflowDefault, type MessageWorkflow } from '../lib/messageWorkflow';
import {
  latestMessageWorkflowRequest,
  readMessageWorkflowOnboarded,
  readMessageWorkflowPreference,
  saveMessageWorkflowPreference,
  subscribeMessageWorkflowPreference,
} from './messageWorkflowPreference';

const values = vi.hoisted(() => new Map<string, string>());
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => values.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
}));

const workflowKey = 'org.unionground.app.messaging-workflow-v1';
const onboardingKey = 'org.unionground.app.messaging-workflow-onboarded-v1';
type Handler = 'chooseWorkflow' | 'skipWorkflowOnboarding';
type Extracted = Handler | 'commitChooserChoice' | 'applySavedWorkflow';

// The extracted declaration is transpiled, so TypeScript annotations in the
// production source never reach the evaluated JavaScript.
function handlerSource(name: Extracted): string {
  const path = new URL('../../app/messages.tsx', import.meta.url);
  const source = ts.createSourceFile(path.pathname, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found: string | undefined;
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name && node.body) found = node.getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!found) throw new Error(`Messages ${name} handler is missing`);
  return ts.transpileModule(found, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

// Runs the actual screen handlers, their shared commit helper and the
// screen's saved-workflow subscriber with the real queued persistence service
// and shared refs; only React setters and the ref objects are substituted.
function mountedChooser() {
  let workflow: MessageWorkflow = messageWorkflowDefault;
  let choice: MessageWorkflow = messageWorkflowDefault;
  let onboarded = false;
  const setWorkflow = (value: MessageWorkflow) => { workflow = value; };
  const setChoice = (value: MessageWorkflow) => { choice = value; };
  const setOnboarded = (value: boolean) => { onboarded = value; };
  // The failure line and the local dismissal, kept as the screen keeps them.
  let saveFailed = false;
  let dismissed = false;
  const setSaveFailed = (value: boolean) => { saveFailed = value; };
  const setDismissed = (value: boolean) => { dismissed = value; };
  const chooserRequest = { current: 0 };
  const chooserPending = { current: 0 };
  const markerReads: Promise<unknown>[] = [];
  // Every marker read the subscriber starts is collected so a test can wait
  // for it, or hold it, without changing what the screen does with it.
  const readMarker = () => {
    const read = markerRead();
    markerReads.push(read.catch(() => undefined));
    return read;
  };
  let markerRead = () => readMessageWorkflowOnboarded();
  // Literal parameter lists, as in messageWorkflowSkip.test.ts: the evaluated
  // source is this repository's own screen file, transpiled above.
  const applySavedWorkflow = new Function('session', 'setWorkflow', 'setOnboardingChoice', 'setWorkflowOnboarded',
    'readMessageWorkflowOnboarded', 'latestMessageWorkflowRequest', 'chooserRequest', 'chooserPending',
    `${handlerSource('applySavedWorkflow')}\nreturn applySavedWorkflow;`)(undefined, setWorkflow, setChoice, setOnboarded,
    readMarker, latestMessageWorkflowRequest, chooserRequest, chooserPending) as (value: MessageWorkflow, request: number, isActive: () => boolean) => void;
  onTestFinished(subscribeMessageWorkflowPreference((value, request) => applySavedWorkflow(value, request, () => true)));
  const commitChooserChoice = new Function('session', 'setWorkflow', 'setOnboardingChoice', 'setWorkflowOnboarded',
    'setWorkflowSaveFailed', 'saveMessageWorkflowPreference', 'latestMessageWorkflowRequest', 'chooserRequest', 'chooserPending',
    `${handlerSource('commitChooserChoice')}\nreturn commitChooserChoice;`)(undefined, setWorkflow, setChoice, setOnboarded,
    setSaveFailed, saveMessageWorkflowPreference, latestMessageWorkflowRequest, chooserRequest, chooserPending) as (value: MessageWorkflow) => Promise<void>;
  const sources = Object.fromEntries((['chooseWorkflow', 'skipWorkflowOnboarding'] as const).map(name => [name, handlerSource(name)])) as Record<Handler, string>;
  // A press runs the handler of the latest render, so it reads the failure
  // flag as it stands when the person presses.
  const press = (name: Handler, value?: MessageWorkflow) => (new Function('workflowSaveFailed', 'setWorkflow', 'setOnboardingChoice', 'setWorkflowDismissed', 'commitChooserChoice', 'messageWorkflowDefault',
    `${sources[name]}\nreturn ${name};`)(saveFailed, setWorkflow, setChoice, setDismissed, commitChooserChoice, messageWorkflowDefault) as (value?: MessageWorkflow) => Promise<void>)(value);
  const settle = async () => { for (let seen = 0; seen < markerReads.length; seen = markerReads.length) await Promise.all(markerReads); };
  const run = async (name: Handler, value?: MessageWorkflow) => { await press(name, value); await settle(); };
  const holdMarkerReads = (hold: (read: () => Promise<boolean>) => Promise<boolean>) => {
    const original = markerRead;
    markerRead = () => hold(original);
  };
  return { press, settle, run, holdMarkerReads, state: () => ({ workflow, choice, onboarded }), flags: () => ({ saveFailed, dismissed }) };
}

describe('Messages first-run chooser dismissal', () => {
  beforeEach(() => {
    values.clear();
    vi.mocked(SecureStore.getItemAsync).mockReset().mockImplementation(async key => values.get(key) ?? null);
    vi.mocked(SecureStore.setItemAsync).mockReset().mockImplementation(async (key, value) => { values.set(key, value); });
  });

  it.each([
    ['chooseWorkflow', 'attention'],
    ['skipWorkflowOnboarding', messageWorkflowDefault],
  ] as const)('%s keeps the chooser visible when the onboarding marker write is refused', async (name, expected) => {
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === onboardingKey) throw new Error('keychain refused');
      values.set(key, value);
    });
    const screen = mountedChooser();
    await expect(screen.run(name, 'attention')).resolves.toBeUndefined();

    expect(await readMessageWorkflowOnboarded()).toBe(false);
    expect(await readMessageWorkflowPreference()).toBe(expected);
    expect(screen.state()).toEqual({ workflow: expected, choice: expected, onboarded: false });
  });

  it.each([
    ['chooseWorkflow', 'attention'],
    ['skipWorkflowOnboarding', messageWorkflowDefault],
  ] as const)('%s dismisses the chooser once the marker is confirmed', async (name, expected) => {
    const screen = mountedChooser();
    await screen.run(name, 'attention');

    expect(await readMessageWorkflowOnboarded()).toBe(true);
    expect(screen.state()).toEqual({ workflow: expected, choice: expected, onboarded: true });
  });

  it('dismisses on a retry after an earlier refused marker write', async () => {
    let refuse = true;
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === onboardingKey && refuse) throw new Error('keychain refused');
      values.set(key, value);
    });
    const screen = mountedChooser();
    await screen.run('chooseWorkflow', 'attention');
    expect(screen.state().onboarded).toBe(false);
    refuse = false;
    await screen.run('chooseWorkflow', 'attention');
    expect(screen.state()).toEqual({ workflow: 'attention', choice: 'attention', onboarded: true });
  });

  it('writes a Skip pressed during a Use save last and closes the chooser on it', async () => {
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const began = new Promise<void>(resolve => { started = resolve; });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === workflowKey && value === 'attention') { started(); await held; }
      values.set(key, value);
    });
    const screen = mountedChooser();
    const use = screen.press('chooseWorkflow', 'attention');
    await began;
    const skip = screen.press('skipWorkflowOnboarding');
    expect(screen.state().onboarded).toBe(false);
    release();
    await Promise.all([use, skip]);
    await screen.settle();

    expect(vi.mocked(SecureStore.setItemAsync).mock.calls.filter(([key]) => key === workflowKey).map(([, value]) => value))
      .toEqual(['attention', messageWorkflowDefault]);
    expect(await readMessageWorkflowPreference()).toBe(messageWorkflowDefault);
    expect(await readMessageWorkflowOnboarded()).toBe(true);
    expect(screen.state()).toEqual({ workflow: messageWorkflowDefault, choice: messageWorkflowDefault, onboarded: true });
  });

  it('keeps the chooser open when the later choice cannot be written', async () => {
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const began = new Promise<void>(resolve => { started = resolve; });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === workflowKey && value === 'attention') { started(); await held; }
      if (key === workflowKey && value === messageWorkflowDefault) throw new Error('keychain refused');
      values.set(key, value);
    });
    const screen = mountedChooser();
    const use = screen.press('chooseWorkflow', 'attention');
    await began;
    const skip = screen.press('skipWorkflowOnboarding');
    release();
    await Promise.all([use, skip]);
    await screen.settle();

    expect(screen.state().onboarded).toBe(false);
  });

  // BUG-UG-MESSAGES-WORKFLOW-SAVE-ORDERING-20261021 (r3s2): a press is
  // queued when it is made, so an Account save made after it is written last.
  it('writes an Account save made during a pending chooser save after every chooser press', async () => {
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const began = new Promise<void>(resolve => { started = resolve; });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === workflowKey && value === 'attention') { started(); await held; }
      values.set(key, value);
    });
    const screen = mountedChooser();
    const use = screen.press('chooseWorkflow', 'attention');
    await began;
    const skip = screen.press('skipWorkflowOnboarding');
    const account = saveMessageWorkflowPreference('workstreams');
    release();
    await Promise.all([use, skip, account]);
    await screen.settle();

    expect(vi.mocked(SecureStore.setItemAsync).mock.calls.filter(([key]) => key === workflowKey).map(([, value]) => value))
      .toEqual(['attention', messageWorkflowDefault, 'workstreams']);
    expect(await readMessageWorkflowPreference()).toBe('workstreams');
    expect(screen.state()).toEqual({ workflow: 'workstreams', choice: 'workstreams', onboarded: true });
  });

  // r3g1: an older write finishing while the latest press is still saving
  // does not replace that press on screen.
  it('keeps the latest press selected while an older chooser write finishes', async () => {
    const gates = new Map<string, () => void>();
    const began = new Map<string, Promise<void>>();
    const opened = new Map<string, () => void>();
    for (const value of ['attention', messageWorkflowDefault]) began.set(value, new Promise<void>(resolve => { opened.set(value, resolve); }));
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === workflowKey && opened.has(value)) {
        opened.get(value)!();
        await new Promise<void>(resolve => { gates.set(value, resolve); });
      }
      values.set(key, value);
    });
    const screen = mountedChooser();
    const use = screen.press('chooseWorkflow', 'attention');
    await began.get('attention');
    const skip = screen.press('skipWorkflowOnboarding');
    gates.get('attention')!();
    await began.get(messageWorkflowDefault);
    await screen.settle();
    expect(screen.state()).toEqual({ workflow: messageWorkflowDefault, choice: messageWorkflowDefault, onboarded: false });
    gates.get(messageWorkflowDefault)!();
    await Promise.all([use, skip]);
    await screen.settle();
    expect(screen.state()).toEqual({ workflow: messageWorkflowDefault, choice: messageWorkflowDefault, onboarded: true });
  });

  // r3s1: a marker read started for an earlier save cannot dismiss the
  // chooser once a later press has been made, even if that press fails.
  it('ignores a delayed marker read from an earlier save after a later press fails', async () => {
    values.set(onboardingKey, 'complete');
    let releaseRead!: () => void;
    const readHeld = new Promise<void>(resolve => { releaseRead = resolve; });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === workflowKey && value === messageWorkflowDefault) throw new Error('keychain refused');
      values.set(key, value);
    });
    const screen = mountedChooser();
    screen.holdMarkerReads(async read => { await readHeld; return read(); });
    await saveMessageWorkflowPreference('workstreams');
    await screen.press('skipWorkflowOnboarding');
    releaseRead();
    await screen.settle();

    expect(await readMessageWorkflowOnboarded()).toBe(true);
    expect(await readMessageWorkflowPreference()).toBe('workstreams');
    expect(screen.state().onboarded).toBe(false);
  });
  // A failed save, then a
  // slow retry, then a dismissal. The failure belongs to the earlier attempt,
  // so a retry clears it when it starts, and a Skip, Android Back or
  // accessibility escape during the retry is queued as the default and written
  // last instead of closing the sheet over a choice that lands later.
  it('clears the failure when a retry starts, so a dismissal during the retry is written after it', async () => {
    let refuseMarker = true;
    let holdRetry = false;
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const began = new Promise<void>(resolve => { started = resolve; });
    // The persistence queue is shared by the file: never leave it held.
    onTestFinished(() => release());
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === onboardingKey && refuseMarker) throw new Error('keychain refused');
      if (key === workflowKey && value === 'attention' && holdRetry) { started(); await held; }
      values.set(key, value);
    });
    const screen = mountedChooser();
    // The failure.
    await screen.run('chooseWorkflow', 'attention');
    expect(screen.flags()).toEqual({ saveFailed: true, dismissed: false });
    expect(screen.state().onboarded).toBe(false);
    // The pending retry.
    refuseMarker = false;
    holdRetry = true;
    const retry = screen.press('chooseWorkflow', 'attention');
    await began;
    expect(screen.flags()).toEqual({ saveFailed: false, dismissed: false });
    // The dismissal.
    const skip = screen.press('skipWorkflowOnboarding');
    expect(screen.flags().dismissed).toBe(false);
    expect(screen.state()).toEqual({ workflow: messageWorkflowDefault, choice: messageWorkflowDefault, onboarded: false });
    // The late completion.
    release();
    await Promise.all([retry, skip]);
    await screen.settle();

    expect(vi.mocked(SecureStore.setItemAsync).mock.calls.filter(([key]) => key === workflowKey).map(([, value]) => value))
      .toEqual(['attention', 'attention', messageWorkflowDefault]);
    expect(await readMessageWorkflowPreference()).toBe(messageWorkflowDefault);
    expect(await readMessageWorkflowOnboarded()).toBe(true);
    expect(screen.state()).toEqual({ workflow: messageWorkflowDefault, choice: messageWorkflowDefault, onboarded: true });
    expect(screen.flags()).toEqual({ saveFailed: false, dismissed: false });
  });

  it('shows the failure again when the retry fails too, and a dismissal then closes the sheet unsaved', async () => {
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === onboardingKey) throw new Error('keychain refused');
      values.set(key, value);
    });
    const screen = mountedChooser();
    await screen.run('chooseWorkflow', 'attention');
    await screen.run('chooseWorkflow', 'attention');
    expect(screen.flags()).toEqual({ saveFailed: true, dismissed: false });
    const writes = vi.mocked(SecureStore.setItemAsync).mock.calls.length;
    await screen.run('skipWorkflowOnboarding');

    expect(vi.mocked(SecureStore.setItemAsync).mock.calls.length).toBe(writes);
    expect(screen.flags()).toEqual({ saveFailed: true, dismissed: true });
    expect(screen.state()).toEqual({ workflow: messageWorkflowDefault, choice: messageWorkflowDefault, onboarded: false });
    expect(await readMessageWorkflowOnboarded()).toBe(false);
  });
});
