import * as SecureStore from 'expo-secure-store';

import { messageWorkflowDefault, normalizeMessageWorkflow, type MessageWorkflow } from '../lib/messageWorkflow';

const workflowKey = 'org.unionground.app.messaging-workflow-v1';
const onboardingKey = 'org.unionground.app.messaging-workflow-onboarded-v1';
type PreferenceChannel = { listeners: Set<(workflow: MessageWorkflow, request: number) => void>; writeTail: Promise<unknown>; requested: number };
const channels = new Map<string, PreferenceChannel>();

function accountChannel(userID?: string): PreferenceChannel {
  const key = userID ?? '';
  let channel = channels.get(key);
  if (!channel) {
    channel = { listeners: new Set(), writeTail: Promise.resolve(), requested: 0 };
    channels.set(key, channel);
  }
  return channel;
}

// Encode every character, rather than stripping it, so distinct ids cannot collide.
function accountKey(base: string, userID?: string): string {
  return userID === undefined ? base : `${base}.${Array.from(userID, (char) => char.codePointAt(0)!.toString(16)).join('-')}`;
}
// Each update is numbered when it is requested, the order the member made
// it. Writes run in that order; subscribers receive the number so a screen
// can tell an older write from its own newer choice.

export function latestMessageWorkflowRequest(userID?: string): number {
  return accountChannel(userID).requested;
}

function enqueuePreferenceUpdate(channel: PreferenceChannel, update: () => Promise<MessageWorkflow>): Promise<MessageWorkflow> {
  const run = channel.writeTail.then(update);
  channel.writeTail = run.catch(() => undefined);
  return run;
}

async function writePreference(value: MessageWorkflow, request: number, userID?: string): Promise<MessageWorkflow> {
  // Finish each native write before another update can start, even if the
  // onboarding marker fails. No older write may outlive its queue position.
  await SecureStore.setItemAsync(accountKey(workflowKey, userID), value);
  try {
    await SecureStore.setItemAsync(accountKey(onboardingKey, userID), 'complete');
  } finally {
    // The choice is already durable. Keep mounted subscribers aligned with it
    // even if the marker fails; the caller still receives that write failure.
    accountChannel(userID).listeners.forEach((listener) => listener(value, request));
  }
  return value;
}

export function subscribeMessageWorkflowPreference(listener: (workflow: MessageWorkflow, request: number) => void, userID?: string): () => void {
  const { listeners } = accountChannel(userID);
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function readMessageWorkflowPreference(userID?: string): Promise<MessageWorkflow> {
  return normalizeMessageWorkflow(await SecureStore.getItemAsync(accountKey(workflowKey, userID)));
}

export function saveMessageWorkflowPreference(workflow: MessageWorkflow, userID?: string): Promise<MessageWorkflow> {
  const value = normalizeMessageWorkflow(workflow);
  const channel = accountChannel(userID);
  const request = ++channel.requested;
  return enqueuePreferenceUpdate(channel, () => writePreference(value, request, userID));
}

export async function readMessageWorkflowOnboarded(userID?: string): Promise<boolean> {
  return (await SecureStore.getItemAsync(accountKey(onboardingKey, userID))) === 'complete';
}

export function completeMessageWorkflowOnboarding(userID?: string): Promise<MessageWorkflow> {
  const channel = accountChannel(userID);
  const request = ++channel.requested;
  return enqueuePreferenceUpdate(channel, async () => {
    const stored = await SecureStore.getItemAsync(accountKey(workflowKey, userID));
    const value = stored ? normalizeMessageWorkflow(stored) : messageWorkflowDefault;
    return writePreference(value, request, userID);
  });
}
