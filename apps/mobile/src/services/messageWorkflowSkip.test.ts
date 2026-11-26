import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import * as SecureStore from 'expo-secure-store';

import { messageWorkflowDefault, type MessageWorkflow } from '../lib/messageWorkflow';
import {
  completeMessageWorkflowOnboarding,
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

function mountedSkip() {
  let workflow: MessageWorkflow = messageWorkflowDefault;
  let choice: MessageWorkflow = messageWorkflowDefault;
  let onboarded = false;
  const setWorkflow = (value: MessageWorkflow) => { workflow = value; };
  const setChoice = (value: MessageWorkflow) => { choice = value; };
  const setOnboarded = (value: boolean) => { onboarded = value; };
  onTestFinished(subscribeMessageWorkflowPreference(value => {
    setWorkflow(value);
    setChoice(value);
    setOnboarded(true);
  }));

  // Execute the actual screen handler, with its real queued persistence
  // service. Only the React setters are substituted for mounted state.
  const path = new URL('../../app/messages.tsx', import.meta.url);
  const source = ts.createSourceFile(path.pathname, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  // Declarations are transpiled so TypeScript annotations never reach eval.
  const bodies = new Map<string, string>();
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      bodies.set(node.name.text, ts.transpileModule(node.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  const commitSource = bodies.get('commitChooserChoice'), skipSource = bodies.get('skipWorkflowOnboarding');
  if (!commitSource || !skipSource) throw new Error('Messages Skip handler is missing');
  const commitChooserChoice = new Function('session', 'setWorkflow', 'setOnboardingChoice', 'setWorkflowOnboarded',
    'setWorkflowSaveFailed', 'saveMessageWorkflowPreference', 'latestMessageWorkflowRequest', 'chooserRequest', 'chooserPending',
    `${commitSource}\nreturn commitChooserChoice;`)(undefined, setWorkflow, setChoice, setOnboarded,
    () => undefined, saveMessageWorkflowPreference, latestMessageWorkflowRequest, { current: 0 }, { current: 0 }) as (value: MessageWorkflow) => Promise<void>;
  const skip = new Function('workflowSaveFailed', 'setWorkflowDismissed', 'commitChooserChoice', 'messageWorkflowDefault', 'completeMessageWorkflowOnboarding',
    `${skipSource}\nreturn skipWorkflowOnboarding;`)(false, () => undefined, commitChooserChoice, messageWorkflowDefault,
    completeMessageWorkflowOnboarding) as () => Promise<void>;
  return { skip, state: () => ({ workflow, choice, onboarded }) };
}

describe('Messages Skip chooses the default', () => {
  beforeEach(() => {
    values.clear();
    vi.mocked(SecureStore.getItemAsync).mockReset().mockImplementation(async key => values.get(key) ?? null);
    vi.mocked(SecureStore.setItemAsync).mockReset().mockImplementation(async (key, value) => { values.set(key, value); });
  });

  it('keeps the default stored and displayed after an earlier choice finishes', async () => {
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const began = new Promise<void>(resolve => { started = resolve; });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === workflowKey && value === 'attention') { started(); await held; }
      values.set(key, value);
    });
    const screen = mountedSkip();
    const earlier = saveMessageWorkflowPreference('attention');
    await began;
    const skipped = screen.skip();
    release();
    await Promise.all([earlier, skipped]);

    expect(await readMessageWorkflowPreference()).toBe(messageWorkflowDefault);
    expect(await readMessageWorkflowOnboarded()).toBe(true);
    expect(screen.state()).toEqual({ workflow: messageWorkflowDefault, choice: messageWorkflowDefault, onboarded: true });
  });

  it.each([null, 'attention'])('stores the default without an overlapping save (previous %s)', async previous => {
    if (previous) values.set(workflowKey, previous);
    const screen = mountedSkip();
    await screen.skip();
    expect(await readMessageWorkflowPreference()).toBe(messageWorkflowDefault);
    expect(await readMessageWorkflowOnboarded()).toBe(true);
    expect(screen.state()).toEqual({ workflow: messageWorkflowDefault, choice: messageWorkflowDefault, onboarded: true });
  });
});
