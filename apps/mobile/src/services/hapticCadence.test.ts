import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const provider = readFileSync(new URL('../state/AppProvider.tsx', import.meta.url), 'utf8');
const conversation = readFileSync(new URL('../../app/conversation/[id].tsx', import.meta.url), 'utf8');

function feedback() {
  return { select: vi.fn(), success: vi.fn(), warning: vi.fn(), impact: vi.fn() };
}
function executable(source: string, environment: Record<string, unknown>): () => Promise<void> {
  return runInNewContext(ts.transpile(source, { target: ts.ScriptTarget.ES2022 }), environment) as () => Promise<void>;
}

describe('feedback belongs to the initiating action', () => {
  it.each(['current', 'changed', 'unavailable', 'retired-during-proof'])('Guide keeps its answer but gates the success cue on %s Auth proof', async (state) => {
    const haptics = feedback();
    const received = vi.fn();
    const reply = { answer: 'Accepted answer', sources: [] };
    const callback = provider.match(/const askCompass = useCallback\((async[\s\S]*?), \[(?:mode, )?session(?:, captureAuthenticatedSessionGuard)?\]\);/)?.[1];
    if (!callback) throw new Error('Guide callback missing');
    let active = true;
    const writer = { isCurrent: async () => {
      if (state === 'retired-during-proof') active = false;
      return state === 'current' || state === 'retired-during-proof';
    } };
    const run = executable(`const ask = ${callback}; const run = async () => received(await ask('Question', [], writer)); run;`, {
      mode: 'authenticated', writer, received, haptics, sendCompassQuestion: async () => reply,
      captureAuthenticatedSessionGuard: () => () => active,
    });
    await run();
    expect(received).toHaveBeenCalledWith(reply);
    expect(haptics.success).toHaveBeenCalledTimes(state === 'current' ? 1 : 0);
  });
  it.each(['preview', 'authenticated', 'failed'])('dashboard refresh stays silent: %s', async (mode) => {
    const haptics = feedback();
    const callback = provider.match(/const refresh = useCallback\((async[\s\S]*?), \[.*?\]\);/)?.[1];
    if (!callback) throw new Error('Refresh callback missing');
    const run = executable(`const run = ${callback}; run;`, {
      mode, session: {}, previewHat: 'member', dashboard: {}, previewDesk: {}, previewThreads: {},
      setRefreshing: vi.fn(), snapshotPreviewHat: vi.fn(), haptics, doorOpen: () => true,
      setTimeout: (done: () => void) => done(),
      fetchDashboard: mode === 'failed' ? vi.fn().mockRejectedValue(new Error('offline')) : vi.fn(),
    });
    await run();
    for (const pulse of Object.values(haptics)) expect(pulse).not.toHaveBeenCalled();
  });

  it.each(['confirmed', 'refresh-failed', 'refused'])('conversation send reports its write outcome, not its reload: %s', async (outcome) => {
    const haptics = feedback();
    const setDraft = vi.fn();
    const setSendError = vi.fn();
    const start = conversation.indexOf('async function send()');
    const end = conversation.indexOf('\n  async function react(', start);
    const run = executable(`${conversation.slice(start, end)}; send;`, {
      draft: 'Message', thread: {}, id: 'thread', sending: false, loading: false, scope: { current: 'same' },
      writer: {}, mode: 'authenticated', userID: 'member', composeAction: null, readVersion: { current: 1 },
      // A member conversation: the staff guide finisher stays out of it.
      staffAccess: false, chosenStaffRole: null, authorizedRoles: [], finishStaffGuide: vi.fn(), liveStaffGuideHat: vi.fn(),
      setSending: vi.fn(), setSendError, setDraft, setThread: vi.fn(), refresh: vi.fn(), haptics,
      sendMemberMessage: outcome === 'refused' ? vi.fn().mockRejectedValue(new Error('refused')) : vi.fn(),
      loadConversationThread: outcome === 'refresh-failed' ? vi.fn().mockRejectedValue(new Error('offline')) : vi.fn().mockResolvedValue({ messages: [] }),
    });
    await run();
    expect(haptics.success).toHaveBeenCalledTimes(outcome === 'refused' ? 0 : 1);
    expect(haptics.warning).toHaveBeenCalledTimes(outcome === 'refused' ? 1 : 0);
    if (outcome === 'refused') expect(setDraft).not.toHaveBeenCalled();
    else expect(setDraft).toHaveBeenCalledWith('');
    if (outcome === 'refresh-failed') expect(setSendError).toHaveBeenLastCalledWith('Message saved. Refresh is unavailable.');
  });
});
