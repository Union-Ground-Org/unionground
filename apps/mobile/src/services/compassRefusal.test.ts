import { stubSessionWriter } from '../testing/stubSessionWriter';
import { getSupabaseClient as protocolTestClient } from './supabase';
const testWriter = stubSessionWriter(protocolTestClient);
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({
  getSession: vi.fn(),
  fetchImpl: vi.fn(),
}));

vi.mock('react-native-url-polyfill/auto', () => ({}));
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { getSession: backend.getSession },
  }),
  processLock: vi.fn(),
}));
vi.mock('../lib/config', () => ({
  mobileConfig: {
    backendConfigured: true,
    supabaseUrl: 'https://unionground-sample.supabase.co',
    supabasePublishableKey: 'sb_publishable_test-key',
    compassNetworkEnabled: true,
    previewEnabled: false,
    portalBaseUrl: 'https://sample.unionground.example',
  },
}));
vi.mock('../lib/secureSessionStorage', () => ({
  createBackendScopedSessionStorage: () => ({}),
}));

import {
  askCompass,
  COMPASS_QUESTION_WITHHELD_MESSAGE,
  CompassPausedError,
  CompassQuestionWithheldError,
  CompassRateLimitError,
  compassRateLimitMessage,
  isCompassPausedError,
  isCompassQuestionWithheldError,
  isCompassRateLimitError,
} from './supabase';

const compassSource = readFileSync(
  fileURLToPath(new URL('../components/CompassPanel.tsx', import.meta.url)),
  'utf8',
);
const supabaseSource = readFileSync(
  fileURLToPath(new URL('./supabase.ts', import.meta.url)),
  'utf8',
);

const UNAVAILABLE = 'The Guide is unavailable right now.';
// CompassPanel shows its own generic failure sentence under the Guide name.
const PANEL_UNAVAILABLE = 'The Guide is unavailable right now.';
const PAUSED = 'The Guide is paused by an administrator.';
const ROLE_LIMIT = compassRateLimitMessage('role');
const SHARED_LIMIT = compassRateLimitMessage('shared');

function jsonRefusal(status: number, code: string) {
  return {
    ok: false,
    status,
    json: async () => ({ code }),
  };
}

describe('askCompass question-path refusals', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    backend.getSession.mockReset();
    backend.fetchImpl.mockReset();
    backend.getSession.mockResolvedValue({
      data: { session: { access_token: 'test-access-token' } },
      error: null,
    });
    globalThis.fetch = backend.fetchImpl as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('raises CompassRateLimitError with scope role for 429 role_rate_limit', async () => {
    backend.fetchImpl.mockResolvedValue(jsonRefusal(429, 'role_rate_limit'));
    await expect(askCompass(testWriter, 'What are my Weingarten rights?', [])).rejects.toSatisfy((error: unknown) => (
      error instanceof CompassRateLimitError
      && isCompassRateLimitError(error)
      && error.scope === 'role'
      && error.message === ROLE_LIMIT
    ));
  });

  it('raises CompassRateLimitError with scope shared for 429 shared_rate_limit', async () => {
    backend.fetchImpl.mockResolvedValue(jsonRefusal(429, 'shared_rate_limit'));
    await expect(askCompass(testWriter, 'What are my Weingarten rights?', [])).rejects.toSatisfy((error: unknown) => (
      error instanceof CompassRateLimitError
      && isCompassRateLimitError(error)
      && error.scope === 'shared'
      && error.message === SHARED_LIMIT
    ));
  });

  it('raises CompassPausedError for 503 compass_paused', async () => {
    backend.fetchImpl.mockResolvedValue(jsonRefusal(503, 'compass_paused'));
    await expect(askCompass(testWriter, 'What are my Weingarten rights?', [])).rejects.toSatisfy((error: unknown) => (
      error instanceof CompassPausedError
      && isCompassPausedError(error)
      && error.message === PAUSED
    ));
  });

  it('raises CompassQuestionWithheldError for 422 question_withheld instead of the outage error', async () => {
    backend.fetchImpl.mockResolvedValue(jsonRefusal(422, 'question_withheld'));
    await expect(askCompass(testWriter, 'When are my committee member office hours?', [])).rejects.toSatisfy((error: unknown) => (
      error instanceof CompassQuestionWithheldError
      && isCompassQuestionWithheldError(error)
      && !(error instanceof CompassPausedError)
      && !(error instanceof CompassRateLimitError)
      && error.message === COMPASS_QUESTION_WITHHELD_MESSAGE
    ));
  });

  it('raises the generic availability Error for 503 governance_unavailable', async () => {
    backend.fetchImpl.mockResolvedValue(jsonRefusal(503, 'governance_unavailable'));
    await expect(askCompass(testWriter, 'What are my Weingarten rights?', [])).rejects.toSatisfy((error: unknown) => (
      error instanceof Error
      && !(error instanceof CompassPausedError)
      && !(error instanceof CompassRateLimitError)
      && error.message === UNAVAILABLE
    ));
  });

  it('raises the generic availability Error for an unrecognised code', async () => {
    backend.fetchImpl.mockResolvedValue(jsonRefusal(502, 'no_such_refusal'));
    await expect(askCompass(testWriter, 'What are my Weingarten rights?', [])).rejects.toMatchObject({
      name: 'Error',
      message: UNAVAILABLE,
    });
  });

  it('raises the generic availability Error for a non-JSON body', async () => {
    backend.fetchImpl.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    });
    await expect(askCompass(testWriter, 'What are my Weingarten rights?', [])).rejects.toSatisfy((error: unknown) => (
      error instanceof Error
      && !(error instanceof CompassPausedError)
      && !(error instanceof CompassRateLimitError)
      && error.message === UNAVAILABLE
    ));
  });

  it('treats gateway_timeout and gateway_unavailable as the same generic failure', async () => {
    backend.fetchImpl.mockResolvedValueOnce(jsonRefusal(504, 'gateway_timeout'));
    const timeout = await askCompass(testWriter, 'What are my Weingarten rights?', []).catch((error: unknown) => error);
    backend.fetchImpl.mockResolvedValueOnce(jsonRefusal(502, 'gateway_unavailable'));
    const unavailable = await askCompass(testWriter, 'What are my Weingarten rights?', []).catch((error: unknown) => error);
    expect(timeout).toBeInstanceOf(Error);
    expect(unavailable).toBeInstanceOf(Error);
    expect(timeout).not.toBeInstanceOf(CompassPausedError);
    expect(timeout).not.toBeInstanceOf(CompassRateLimitError);
    expect(unavailable).not.toBeInstanceOf(CompassPausedError);
    expect(unavailable).not.toBeInstanceOf(CompassRateLimitError);
    expect((timeout as Error).message).toBe(UNAVAILABLE);
    expect((unavailable as Error).message).toBe((timeout as Error).message);
  });

  it('keeps the compass_paused source-text decoder the member-data boundary pins', () => {
    expect(supabaseSource).toContain("payload?.code === 'compass_paused'");
    expect(supabaseSource).toContain('throw new CompassPausedError()');
    expect(supabaseSource).not.toContain('payload?.error');
  });
});

describe('CompassPanel withheld-question presentation', () => {
  it('asks the worker to reword or use a suggested question, not that Guide is unavailable', () => {
    expect(COMPASS_QUESTION_WITHHELD_MESSAGE).not.toBe(UNAVAILABLE);
    expect(COMPASS_QUESTION_WITHHELD_MESSAGE).toMatch(/suggested questions/);
    expect(COMPASS_QUESTION_WITHHELD_MESSAGE).toMatch(/committee/);
    expect(compassSource).toContain('} else if (isCompassQuestionWithheldError(nextError)) {');
    expect(compassSource).toContain('setError(COMPASS_QUESTION_WITHHELD_MESSAGE);');
    const catchStart = compassSource.indexOf('} catch (nextError) {');
    const catchBody = compassSource.slice(catchStart, compassSource.indexOf('} finally {', catchStart));
    expect(catchBody.indexOf('isCompassQuestionWithheldError')).toBeLessThan(catchBody.lastIndexOf(PANEL_UNAVAILABLE));
  });
});

describe('CompassPanel rate-limit presentation', () => {
  it('shows distinct hourly-limit copy for role and shared refusals', () => {
    expect(ROLE_LIMIT).not.toBe(SHARED_LIMIT);
    expect(ROLE_LIMIT).not.toBe(UNAVAILABLE);
    expect(ROLE_LIMIT).not.toBe(PAUSED);
    expect(SHARED_LIMIT).not.toBe(UNAVAILABLE);
    expect(SHARED_LIMIT).not.toBe(PAUSED);
    expect(ROLE_LIMIT).toMatch(/hourly Guide question limit/i);
    expect(ROLE_LIMIT).toMatch(/hour rolls over/);
    expect(SHARED_LIMIT).toMatch(/shared hourly limit/i);
    expect(SHARED_LIMIT).toMatch(/hour rolls over/);
  });

  it('maps each rate-limit error onto that copy without pausing or locking the composer', () => {
    expect(compassSource).toContain('} else if (isCompassRateLimitError(nextError)) {');
    expect(compassSource).toContain('setPaused(false);');
    expect(compassSource).toContain('const rateLimitMessage = compassRateLimitMessage(nextError.scope);');
    expect(compassSource).toContain('setError(rateLimitMessage);');
    expect(compassSource).toContain("const pauseMessage = 'The Guide is paused by an administrator.';");
    expect(compassSource).toContain("setError('The Guide is unavailable right now.');");
    expect(compassSource).not.toContain('nextError.message');
    // Composer availability still follows paused / history / pending-save only.
    expect(compassSource).toContain('editable={historyReady && !paused && pendingSave === null}');
    expect(compassSource).toContain('disabled={!historyReady || paused || pendingSave !== null}');
    expect(compassSource).toContain('if (!trimmed || busy || !historyReady || paused || pendingSave) return;');
  });

  it('does not treat a rate-limit refusal as the paused or generic-unavailable state', () => {
    const catchStart = compassSource.indexOf('} catch (nextError) {');
    const catchEnd = compassSource.indexOf('} finally {', catchStart);
    const catchBody = compassSource.slice(catchStart, catchEnd);
    expect(catchBody).toContain('isCompassPausedError(nextError)');
    expect(catchBody).toContain('isCompassRateLimitError(nextError)');
    expect(catchBody).toContain('setPaused(true);');
    expect(catchBody).toContain('setPaused(false);');
    expect(catchBody.indexOf('isCompassPausedError')).toBeLessThan(catchBody.indexOf('isCompassRateLimitError'));
    expect(catchBody.indexOf('isCompassRateLimitError')).toBeLessThan(catchBody.lastIndexOf(PANEL_UNAVAILABLE));
  });
});

// App Store capture, Nov 7, 2026: on the SAMPLE backend every question is
// refused before an answer is drafted (503 governance_unavailable, website and
// app alike), and the demo showed the red generic error. The SAMPLE build shows
// a calm card that says so and keeps the question; other hosts and every
// specific refusal keep their own words.
describe('CompassPanel SAMPLE demo presentation', () => {
  const panel = () => readFileSync(fileURLToPath(new URL('../components/CompassPanel.tsx', import.meta.url)), 'utf8');

  it('says honestly that Guide cannot answer in the demo, without an error tone', () => {
    const source = panel();
    expect(source).toContain(`export const COMPASS_DEMO_UNAVAILABLE_TITLE = "Guide can't answer in the demo right now";`);
    expect(source).toContain('Your question is still in the box below.');
    expect(source).toMatch(/\{demoUnavailable && !error \? \([\s\S]{0,400}styles\.demoNotice, \{ backgroundColor: theme\.card, borderColor: theme\.border \}/);
    expect(source).not.toMatch(/demoNotice[^\n]*theme\.destructive/);
  });

  it('uses the card only for the generic refusal on the SAMPLE build', () => {
    const source = panel();
    const refusal = source.slice(source.indexOf('isCompassQuestionWithheldError(nextError)'), source.indexOf('} finally {', source.indexOf('isCompassQuestionWithheldError(nextError)')));
    expect(refusal).toMatch(/\} else if \(liveSampleBackend\) \{\s*setDemoUnavailable\(true\);[\s\S]*\} else \{\s*setError\('The Guide is unavailable right now\.'\);/);
    // A new question, a thread switch or a new scope clears it.
    expect(source.match(/setDemoUnavailable\(false\)/g)?.length).toBeGreaterThanOrEqual(4);
  });
});

// , Nov 7, 2026: after the demo's refusal the Compass header still said
// READY above the card saying Compass can't answer. It goes neutral with it.
describe('CompassPanel SAMPLE demo header', () => {
  const panel = () => readFileSync(fileURLToPath(new URL('../components/CompassPanel.tsx', import.meta.url)), 'utf8');

  it('drops READY and the ready colours while the demo card shows', () => {
    const source = panel();
    expect(source).toContain('const compassReady = historyReady && !paused && pendingSave === null && !busy && !demoUnavailable;');
    expect(source).toContain("export const COMPASS_DEMO_HEADER_BODY = 'Not answering in the demo right now';");
    expect(source).toMatch(/: demoUnavailable\s*\? \{ label: 'DEMO', body: COMPASS_DEMO_HEADER_BODY, accessibilityLabel: 'Guide is not answering in the demo right now' \}\s*: \{ label: 'READY'/);
  });
});
