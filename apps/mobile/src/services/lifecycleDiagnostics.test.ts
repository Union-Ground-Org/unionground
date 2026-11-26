import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LIFECYCLE_DETAIL_KEYS,
  LIFECYCLE_LOG_TAG,
  LIFECYCLE_OUTCOMES,
  LIFECYCLE_PROVIDER_CODES,
  LIFECYCLE_PROVIDER_NAMES,
  LIFECYCLE_REASONS,
  LIFECYCLE_SCOPES,
  LIFECYCLE_STEPS,
  UNSUPPORTED_TOKEN,
  diagnosticReason,
  diagnosticStatus,
  readLifecycleDiagnostics,
  recordLifecycleEvent,
  resetLifecycleDiagnostics,
  setLifecycleDiagnosticsSink,
  type LifecycleDetail,
  type LifecycleEventInput,
} from './lifecycleDiagnostics';
import { classifySignOutFailure, signOutFailureMessage } from './signOutFailure';

let lines: string[] = [];

beforeEach(() => {
  lines = [];
  resetLifecycleDiagnostics();
  setLifecycleDiagnosticsSink((line) => { lines.push(line); });
});

afterEach(() => {
  setLifecycleDiagnosticsSink(null);
  resetLifecycleDiagnostics();
});

function sourceOf(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

/**
 * Everything a caller could try to smuggle into a device log. Each string is
 * used as a detail key, as a detail value, as an enumerated field, and inside a
 * caught exception, and none of them may appear anywhere in the emitted line or
 * the retained ring.
 */
const FORBIDDEN = [
  'Maria Delgado',
  ['steward', 'example.org'].join('@'),
  'grievance-2026-0142.pdf',
  'IMG_0042.HEIC',
  '/data/user/0/org.unionground.app/cache/attachments/dues.pdf',
  'content://com.android.providers.media.documents/document/image%3A1234',
  'unionground://auth/callback?code=abcdef123456',
  [
    JSON.stringify({ alg: 'HS256' }),
    JSON.stringify({ session_id: 'x' }),
    'signature',
  ].map((segment) => Buffer.from(segment).toString('base64url')).join('.'),
  ['Bearer', ['sk', 'live', Array.from({ length: 24 }, (_, index) => index.toString(36)).join('')].join('_')].join(' '),
  'password=hunter2',
  '3f1c9a2e-1111-4111-8111-111111111111',
] as const;

/**
 * The grammar of an emitted line, enforced token by token: the tag, then only
 * allowlisted identifiers and finite numbers. Nothing else has a way through.
 */
function assertLineIsClosedVocabulary(line: string): void {
  const [tag, ...tokens] = line.split(' ');
  expect(tag).toBe(LIFECYCLE_LOG_TAG);
  const scopes: readonly string[] = [...LIFECYCLE_SCOPES, UNSUPPORTED_TOKEN];
  const steps: readonly string[] = [...LIFECYCLE_STEPS, UNSUPPORTED_TOKEN];
  const outcomes: readonly string[] = [...LIFECYCLE_OUTCOMES, UNSUPPORTED_TOKEN];
  const reasons: readonly string[] = LIFECYCLE_REASONS;
  const detailKeys: readonly string[] = LIFECYCLE_DETAIL_KEYS;
  const providerCodes: readonly string[] = [...LIFECYCLE_PROVIDER_CODES, UNSUPPORTED_TOKEN];
  const providerNames: readonly string[] = [...LIFECYCLE_PROVIDER_NAMES, UNSUPPORTED_TOKEN];
  for (const token of tokens) {
    const separator = token.indexOf('=');
    expect(separator).toBeGreaterThan(0);
    const key = token.slice(0, separator);
    const value = token.slice(separator + 1);
    if (key === 'scope') expect(scopes).toContain(value);
    else if (key === 'step') expect(steps).toContain(value);
    else if (key === 'outcome') expect(outcomes).toContain(value);
    else if (key === 'reason') expect(reasons).toContain(value);
    else if (key === 'status') expect(value).toMatch(/^\d{3}$/);
    else if (key === 'providerCode') expect(providerCodes).toContain(value);
    else if (key === 'providerName') expect(providerNames).toContain(value);
    else {
      expect(detailKeys).toContain(key);
      expect(value).toMatch(/^(true|false|-?\d+(\.\d+)?)$/);
    }
  }
}

describe('lifecycle diagnostics closed vocabulary', () => {
  it('keeps only enumerated Apple provider identifiers in the dedicated failure meeting', () => {
    recordLifecycleEvent({ scope: 'native-auth', step: 'apple-provider-failed', error: Object.assign(new Error('private data'), {
      code: 'ERR_REQUEST_UNKNOWN', identityToken: 'secret-token',
    }) });
    expect(lines).toEqual([
      `${LIFECYCLE_LOG_TAG} scope=native-auth step=apple-provider-failed providerCode=ERR_REQUEST_UNKNOWN providerName=Error`,
    ]);
    expect(readLifecycleDiagnostics()[0]).toMatchObject({ providerCode: 'ERR_REQUEST_UNKNOWN', providerName: 'Error' });
    assertLineIsClosedVocabulary(lines[0]!);

    resetLifecycleDiagnostics();
    lines = [];
    recordLifecycleEvent({ scope: 'native-auth', step: 'apple-provider-failed', error: {
      code: `ERR_${'X'.repeat(100)}_private`, name: 'PrivateMemberName', message: 'secret-token',
    } });
    expect(lines).toEqual([
      `${LIFECYCLE_LOG_TAG} scope=native-auth step=apple-provider-failed providerCode=unsupported providerName=unsupported`,
    ]);
    expect(JSON.stringify(readLifecycleDiagnostics()) + lines.join(' ')).not.toMatch(/PrivateMemberName|secret-token|private/);
    assertLineIsClosedVocabulary(lines[0]!);

    // A well-formed code that is not one of the module's own is still not
    // carried: the list is a membership test, not a shape test, so a code that
    // happens to spell a name cannot ride through.
    resetLifecycleDiagnostics();
    lines = [];
    recordLifecycleEvent({ scope: 'native-auth', step: 'apple-provider-failed', error: Object.assign(new Error('x'), {
      code: 'ERR_MARIA_DELGADO',
    }) });
    expect(lines).toEqual([
      `${LIFECYCLE_LOG_TAG} scope=native-auth step=apple-provider-failed providerCode=unsupported providerName=Error`,
    ]);
    expect(JSON.stringify(readLifecycleDiagnostics()) + lines.join(' ')).not.toMatch(/MARIA|DELGADO/);
    assertLineIsClosedVocabulary(lines[0]!);
  });

  it('constructs credential-shaped fixtures at runtime without embedding them in source', () => {
    const source = sourceOf('./lifecycleDiagnostics.test.ts');
    for (const fixture of [FORBIDDEN[1], FORBIDDEN[7], FORBIDDEN[8]]) {
      expect(source.includes(fixture)).toBe(false);
    }

    const segments = FORBIDDEN[7].split('.');
    expect(segments).toHaveLength(3);
    for (const segment of segments) expect(segment).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(Buffer.from(segments[0]!, 'base64url').toString())).toEqual({ alg: 'HS256' });
    expect(JSON.parse(Buffer.from(segments[1]!, 'base64url').toString())).toEqual({ session_id: 'x' });
    expect(FORBIDDEN[8].split(' ')).toEqual([
      'Bearer', expect.stringMatching(new RegExp(['^sk', 'live', '[A-Za-z0-9]{16,}$'].join('_'))),
    ]);
    expect(FORBIDDEN[1].split('@')).toEqual(['steward', 'example.org']);
  });

  it('drops a detail key that is not on the allowlist, key and value together', () => {
    recordLifecycleEvent({
      scope: 'attachment-selection',
      step: 'picker-result',
      outcome: 'selected',
      detail: {
        mounted: true,
        'grievance-2026-0142.pdf': 1,
        memberName: 2,
      } as LifecycleDetail,
    });

    expect(lines).toEqual([
      `${LIFECYCLE_LOG_TAG} scope=attachment-selection step=picker-result outcome=selected mounted=true`,
    ]);
    expect(readLifecycleDiagnostics()[0]?.detail).toEqual({ mounted: true });
  });

  it('replaces an unenumerated scope, step or outcome with the fixed unsupported token', () => {
    recordLifecycleEvent({
      scope: '/data/user/0/org.unionground.app/cache' as never,
      step: 'IMG_0042.HEIC' as never,
      outcome: 'unionground://auth/callback?code=abcdef123456' as never,
    });

    expect(lines).toEqual([
      `${LIFECYCLE_LOG_TAG} scope=${UNSUPPORTED_TOKEN} step=${UNSUPPORTED_TOKEN} outcome=${UNSUPPORTED_TOKEN}`,
    ]);
    const [event] = readLifecycleDiagnostics();
    expect(event?.scope).toBe(UNSUPPORTED_TOKEN);
    expect(event?.step).toBe(UNSUPPORTED_TOKEN);
    expect(event?.outcome).toBe(UNSUPPORTED_TOKEN);
  });

  it('lets nothing forbidden reach either the sink or the ring, from any field', () => {
    for (const secret of FORBIDDEN) {
      lines = [];
      resetLifecycleDiagnostics();
      const error = Object.assign(new Error(`failed on ${secret}`), {
        code: secret,
        name: secret,
        details: secret,
        hint: secret,
        status: 500,
      });
      recordLifecycleEvent({
        scope: secret as never,
        step: secret as never,
        outcome: secret as never,
        detail: { [secret]: 1, mounted: true, generation: 3 } as LifecycleDetail,
        error,
      } satisfies LifecycleEventInput);

      const line = lines.join('\n');
      const retained = JSON.stringify(readLifecycleDiagnostics());
      expect(line).not.toContain(secret);
      expect(retained).not.toContain(secret);
      expect(line).not.toContain('failed on');
      assertLineIsClosedVocabulary(line);
    }
  });

  it('never carries an exception message, however ordinary the message looks', () => {
    recordLifecycleEvent({
      scope: 'sign-out',
      step: 'cleanup-failed',
      outcome: 'purge-attachment-cache',
      error: new Error("EACCES: permission denied, unlink 'union dues receipt.pdf'"),
    });

    expect(lines).toEqual([
      `${LIFECYCLE_LOG_TAG} scope=sign-out step=cleanup-failed outcome=purge-attachment-cache reason=unknown`,
    ]);
    expect(JSON.stringify(readLifecycleDiagnostics())).not.toContain('union dues receipt');
  });

  it('keeps every emitted line inside the closed vocabulary for the wired call shapes', () => {
    recordLifecycleEvent({ scope: 'deep-link', step: 'redirect-system-path', outcome: 'home-fallback', detail: { initial: true } });
    recordLifecycleEvent({ scope: 'boot', step: 'index-redirect', outcome: 'signedOut' });
    recordLifecycleEvent({ scope: 'root-layout', step: 'render-gate', outcome: 'authenticated', detail: { locked: false, privacyCovered: false, signedIn: true } });
    recordLifecycleEvent({ scope: 'attachment-selection', step: 'consume', outcome: 'discarded', detail: { generation: 2, currentGeneration: 3, mounted: false } });
    recordLifecycleEvent({
      scope: 'sign-out',
      step: 'server-cleanup-failed',
      outcome: 'service',
      detail: { serverSignOutPrepared: false },
      error: { name: 'PostgrestError', code: 'PGRST202', status: 404, message: 'Could not find the function public.prepare_my_signout' },
    });

    expect(lines).toHaveLength(5);
    for (const line of lines) assertLineIsClosedVocabulary(line);
    expect(lines[4]).toBe(
      `${LIFECYCLE_LOG_TAG} scope=sign-out step=server-cleanup-failed outcome=service`
      + ' serverSignOutPrepared=false reason=service-contract-mismatch status=404',
    );
  });
});

describe('lifecycle diagnostics reason codes', () => {
  it.each([
    ['ERR_UNABLE_TO_DELETE', 'io-failure'],
    ['ERR_UNABLE_TO_CREATE', 'io-failure'],
    ['ERR_FAILED_TO_PICK_MEDIA', 'io-failure'],
    ['ERR_INVALID_PERMISSION', 'permission-denied'],
    ['ERR_NO_PERMISSION', 'permission-denied'],
    ['ERR_DESTINATION_DOES_NOT_EXIST', 'not-found'],
    ['ERR_FILE_NOT_FOUND', 'not-found'],
    ['ERR_MISSING_ACTIVITY', 'invalid-state'],
    ['ERR_MISSING_APP_CONTEXT', 'invalid-state'],
    ['E_SECURESTORE_READ_ERROR', 'io-failure'],
    ['E_SECURESTORE_WRITE_ERROR', 'io-failure'],
    ['E_SECURESTORE_DELETE_ERROR', 'io-failure'],
  ])('reduces native CodedError %s to %s without carrying its code', (code, reason) => {
    recordLifecycleEvent({
      scope: 'sign-out', step: 'cleanup-failed',
      error: { name: 'CodedError', code, message: 'private native path' },
    });
    expect(readLifecycleDiagnostics()[0]?.reason).toBe(reason);
    expect(lines[0]).not.toContain(code);
    expect(lines[0]).not.toContain('private native path');
    assertLineIsClosedVocabulary(lines[0]!);
  });

  it('names the service faults a drill has to tell apart', () => {
    expect(diagnosticReason({ code: 'PGRST202', status: 404 })).toBe('service-contract-mismatch');
    expect(diagnosticReason({ code: '42883', status: 400 })).toBe('service-contract-mismatch');
    expect(diagnosticReason({ code: 'PGRST301', status: 401 })).toBe('service-unauthorized');
    expect(diagnosticReason({ status: 403 })).toBe('service-unauthorized');
    expect(diagnosticReason({ status: 502 })).toBe('service-rejected');
    expect(diagnosticReason({ status: 504 })).toBe('timeout');
    expect(diagnosticReason({ code: 'PGRST999' })).toBe('service-rejected');
  });

  it('names the local faults that produced the three open G6 findings', () => {
    expect(diagnosticReason(Object.assign(new Error('x'), { code: 'EACCES' }))).toBe('permission-denied');
    expect(diagnosticReason(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe('not-found');
    expect(diagnosticReason(Object.assign(new Error('x'), { code: 'ENOSPC' }))).toBe('storage-full');
    expect(diagnosticReason(Object.assign(new Error('x'), { code: 'EIO' }))).toBe('io-failure');
    expect(diagnosticReason(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe('aborted');
    expect(diagnosticReason(new TypeError('Network request failed'))).toBe('invalid-state');
    expect(diagnosticReason({ code: 'ECONNREFUSED', status: 0 })).toBe('network-unavailable');
  });

  it('says unknown rather than guessing, and never invents a status', () => {
    expect(diagnosticReason(null)).toBe('unknown');
    expect(diagnosticReason('boom')).toBe('unknown');
    expect(diagnosticReason(new Error('The persisted session changed during sign-out.'))).toBe('unknown');
    expect(diagnosticReason({ code: 'E_UNMAPPED_VENDOR_CODE' })).toBe('unknown');
    expect(diagnosticStatus({ status: 0 })).toBeNull();
    expect(diagnosticStatus({ status: 'not a status' })).toBeNull();
    expect(diagnosticStatus({ status: '404' })).toBe(404);
    expect(diagnosticStatus(null)).toBeNull();
  });

  it('reads the sign-out classifier verdict when the value carries one', () => {
    expect(diagnosticReason({ signOutFailureKind: 'service' })).toBe('service-rejected');
    expect(diagnosticReason({ signOutFailureKind: 'transport' })).toBe('network-unavailable');
  });

  it('returns only workers of the declared reason vocabulary', () => {
    const values: unknown[] = [
      null, undefined, 'boom', 42, new Error('x'), { code: 'EACCES' }, { status: 500 },
      { status: 401 }, { code: 'PGRST202' }, { name: 'AbortError' }, { signOutFailureKind: 'service' },
    ];
    for (const value of values) expect(LIFECYCLE_REASONS).toContain(diagnosticReason(value));
  });
});

describe('lifecycle diagnostics meetings', () => {
  it('emits one tagged line per meeting and retains it', () => {
    recordLifecycleEvent({
      scope: 'deep-link',
      step: 'redirect-system-path',
      outcome: 'home-fallback',
      detail: { initial: true },
    });

    expect(lines).toEqual([
      `${LIFECYCLE_LOG_TAG} scope=deep-link step=redirect-system-path outcome=home-fallback initial=true`,
    ]);
    expect(readLifecycleDiagnostics()).toEqual([
      {
        scope: 'deep-link',
        step: 'redirect-system-path',
        outcome: 'home-fallback',
        detail: { initial: true },
        reason: null,
        status: null,
      },
    ]);
  });

  it('drops a non-finite detail value rather than logging NaN', () => {
    recordLifecycleEvent({
      scope: 'attachment-selection',
      step: 'capture',
      detail: { generation: Number.NaN, mounted: true },
    });

    expect(lines[0]).toBe(`${LIFECYCLE_LOG_TAG} scope=attachment-selection step=capture mounted=true`);
  });

  it('bounds the retained ring so a long session cannot grow it without limit', () => {
    for (let index = 0; index < 200; index += 1) {
      recordLifecycleEvent({ scope: 'root-layout', step: 'render-gate', outcome: 'authenticated' });
    }

    expect(readLifecycleDiagnostics()).toHaveLength(64);
  });

  it('hands back a copy, so a reader cannot mutate the retained buffer', () => {
    recordLifecycleEvent({ scope: 'root-layout', step: 'mount' });
    const [event] = readLifecycleDiagnostics();
    (event as { scope: string }).scope = 'tampered';

    expect(readLifecycleDiagnostics()[0]?.scope).toBe('root-layout');
  });
});

describe('lifecycle diagnostics wiring', () => {
  it('records every deep-link resolution branch without echoing the inbound path', () => {
    const source = sourceOf('../../app/+native-intent.tsx');

    expect(source).toContain("recordLifecycleEvent({ scope: 'deep-link', step: 'redirect-system-path', outcome: 'quick-action'");
    expect(source).toContain("recordLifecycleEvent({ scope: 'deep-link', step: 'redirect-system-path', outcome: 'home-fallback'");
    expect(source).toContain("recordLifecycleEvent({ scope: 'deep-link', step: 'redirect-system-path', outcome: 'auth-callback'");
    expect(source).toContain("recordLifecycleEvent({ scope: 'deep-link', step: 'redirect-system-path', outcome: 'refused-auth-callback'");
    expect(source).toContain("outcome: resolved ? 'app-route' : 'home-fallback'");
    // The inbound path is attacker-controlled and can carry an auth callback
    // code; it must never be handed to the diagnostics channel. Every branch
    // therefore carries exactly the same boolean detail and nothing else.
    const calls = [...source.matchAll(/recordLifecycleEvent\(\{[\s\S]*?\}\);/g)].map(([call]) => call);
    expect(calls).toHaveLength(6);
    // Provider-code and emailed invitation/reset callbacks each keep credentials out of diagnostics.
    expect(calls.filter((call) => call.includes("outcome: 'auth-callback'"))).toHaveLength(2);
    for (const call of calls) {
      expect(call).toContain('detail: { initial }');
      expect(call).not.toContain('route.code');
      expect(call).not.toContain('route.token');
      expect(call).not.toMatch(/\bpath\b(?!')/);
    }
  });

  it('records the index redirect decision and the root layout lifecycle', () => {
    const index = sourceOf('../../app/index.tsx');
    const layout = sourceOf('../../app/_layout.tsx');

    expect(index).toContain("recordLifecycleEvent({ scope: 'boot', step: 'index-redirect', outcome: mode });");
    expect(layout).toContain("recordLifecycleEvent({ scope: 'root-layout', step: 'mount' });");
    expect(layout).toContain("return () => { recordLifecycleEvent({ scope: 'root-layout', step: 'unmount' }); };");
    expect(layout).toContain("step: 'render-gate'");
    expect(layout).toContain('detail: { locked, privacyCovered, signedIn: sessionUserID !== null }');
  });

  it('records the attachment selection lifecycle without the filename or the picker payload', () => {
    const panel = sourceOf('../components/AttachmentPanel.tsx');
    const choose = panel.slice(
      panel.indexOf('async function chooseDocument()'),
      panel.indexOf('async function scanDocument()'),
    );

    expect(panel).toContain("recordLifecycleEvent({ scope: 'attachment-selection', step: 'panel-mounted' });");
    expect(panel).toContain("recordLifecycleEvent({ scope: 'attachment-selection', step: 'panel-unmounted' });");
    expect(choose).toContain("step: 'capture'");
    expect(choose).toContain("step: 'busy-set', outcome: 'pick'");
    expect(choose).toContain("step: 'busy-cleared'");
    expect(choose).toContain("outcome: candidate ? 'selected' : 'cancelled'");
    // Staging and uploading are separate steps: the picker path records the
    // staged disposition, and the explicit upload records the uploaded one.
    expect(choose).toContain("outcome: disposition.status === 'discarded' ? 'discarded' : 'selected'");
    const upload = panel.slice(
      panel.indexOf('async function uploadStaged()'),
      panel.indexOf('async function discardStaged()'),
    );
    expect(upload).toContain("outcome: disposition.status === 'discarded' ? 'discarded' : 'uploaded'");
    expect(upload).not.toContain('candidate.filename');
    expect(upload).not.toContain('candidate.uri');
    // The failure event moved into the shared finishSelection handler when the
    // selection lifecycle was extracted (BUG-UG-MOBILE-ATTACHMENT-UPLOAD-SILENT-FAILURE-20260905).
    const finish = panel.slice(
      panel.indexOf('async function finishSelection('),
      panel.indexOf('async function chooseDocument()'),
    );
    expect(finish).toContain("step: 'failed'");
    expect(finish).toContain('error: result.error,');
    expect(choose).not.toContain('candidate.filename');
    expect(choose).not.toContain('candidate.uri');
    expect(finish).not.toContain('candidate.filename');
    // Instrumentation only: the rendered copy still comes from the lifecycle module.
    const lifecycle = sourceOf('../lib/attachmentPickLifecycle.ts');
    expect(lifecycle).toContain("export const ATTACHMENT_UPLOADED_MESSAGE = 'Attachment uploaded securely.';");
  });

  it('names the sign-out cleanup step in flight and reduces its exception', () => {
    const provider = sourceOf('../state/AppProvider.tsx');

    expect(provider).toContain('} catch (attachmentCleanupFailure) {');
    expect(provider).toContain("step: 'cleanup-failed',");
    expect(provider).toContain('error: attachmentCleanupFailure,');
    expect(provider).toContain("recordLifecycleEvent({ scope: 'sign-out', step: 'cleanup-step-start', outcome: cleanupStep });");
    expect(provider).toContain("recordLifecycleEvent({ scope: 'sign-out', step: 'cleanup-step-done', outcome: cleanupStep });");
  });

  it('keeps the console sink to a single choke point in the mobile source', () => {
    const diagnostics = sourceOf('./lifecycleDiagnostics.ts');

    expect(diagnostics).toContain('console.log(line)');
    for (const source of [
      sourceOf('../state/AppProvider.tsx'),
      sourceOf('../components/AttachmentPanel.tsx'),
      sourceOf('../../app/_layout.tsx'),
      sourceOf('../../app/index.tsx'),
      sourceOf('../../app/+native-intent.tsx'),
    ]) {
      expect(source).not.toMatch(/\bconsole\.(log|warn|error|info|debug)\b/);
    }
  });

  it('keeps free text out of the module itself: no message is ever read', () => {
    const diagnostics = sourceOf('./lifecycleDiagnostics.ts');
    const executable = diagnostics
      .split('\n')
      .filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/*'))
      .join('\n');

    // The earlier design read `error.message` and passed it through a regex
    // denylist. A denylist can only remove the shapes it anticipated, so the
    // repair removed the free-text channel outright; this pins that removal.
    expect(executable).not.toContain("'message'");
    expect(executable).not.toContain('.message');
    expect(executable).not.toContain('redact');
    // The runtime allowlists exist and are consulted, not merely declared.
    expect(executable).toContain('if (!DETAIL_KEYS.has(key)) continue;');
    expect(executable).toContain('allowlisted<LifecycleScope>(input.scope, SCOPES)');
    expect(executable).toContain('allowlisted<LifecycleStep>(input.step, STEPS)');
    expect(executable).toContain('allowlisted<LifecycleOutcome>(input.outcome, OUTCOMES)');
  });
});

describe('lifecycle diagnostics never disturb the observed path', () => {
  // Round-2 Codex review, P2-2: recordLifecycleEvent runs before the member
  // error handling in the sign-out and attachment paths. A throw here — from a
  // hostile error value, a malformed detail, or a sink that fails — would
  // suppress the failure UI. These prove it is strictly non-throwing.
  it('does not throw, and emits a closed-vocabulary line, when the caught value resists inspection', () => {
    const hostile = new Error('boom');
    Object.defineProperty(hostile, 'name', { get() { throw new Error('native name accessor failed'); } });
    Object.defineProperty(hostile, 'code', { get() { throw new Error('code accessor failed'); } });
    Object.defineProperty(hostile, 'status', { get() { throw new Error('status accessor failed'); } });

    let event: ReturnType<typeof recordLifecycleEvent> | undefined;
    expect(() => {
      event = recordLifecycleEvent({
        scope: 'sign-out',
        step: 'server-cleanup-failed',
        outcome: 'service',
        error: hostile,
      });
    }).not.toThrow();

    expect(lines).toHaveLength(1);
    assertLineIsClosedVocabulary(lines[0]!);
    expect(lines[0]).not.toContain('boom');
    // A value that yields nothing on inspection carries no reason or status.
    expect(event?.reason).toBe('unknown');
    expect(event?.status).toBeNull();
  });

  it('does not throw when the detail object enumerates hostilely, and drops the detail whole', () => {
    const hostileDetail = new Proxy({}, {
      ownKeys() { throw new Error('ownKeys failed'); },
    });

    expect(() => recordLifecycleEvent({
      scope: 'sign-out',
      step: 'cleanup-failed',
      outcome: 'purge-attachment-cache',
      detail: hostileDetail as LifecycleDetail,
    })).not.toThrow();

    expect(lines).toEqual([
      `${LIFECYCLE_LOG_TAG} scope=sign-out step=cleanup-failed outcome=purge-attachment-cache`,
    ]);
  });

  it('does not throw, and still retains the meeting, when the sink itself throws', () => {
    setLifecycleDiagnosticsSink(() => { throw new Error('sink failure'); });

    let event: ReturnType<typeof recordLifecycleEvent> | undefined;
    expect(() => { event = recordLifecycleEvent({ scope: 'root-layout', step: 'mount' }); }).not.toThrow();

    expect(event?.scope).toBe('root-layout');
    expect(readLifecycleDiagnostics()).toHaveLength(1);
  });

  it('lets the worker message and warning haptic still run when diagnostics extraction and emission throw', () => {
    // A faithful replay of the live-session sign-out catch's ordering: it calls
    // classifySignOutFailure, then recordLifecycleEvent, then finishes the
    // attempt, sets the member message, and fires the warning haptic. With a
    // hostile error (a throwing name accessor — the exact round-2 repro) and a
    // throwing sink, neither classify nor record may abort the sequence, or the
    // member sees no message and feels no haptic.
    setLifecycleDiagnosticsSink(() => { throw new Error('sink failure'); });
    const hostile = new Error('native failure');
    Object.defineProperty(hostile, 'name', { get() { throw new Error('native name accessor failed'); } });

    const steps: string[] = [];
    let memberMessage: string | null = null;

    expect(() => {
      const failureKind = classifySignOutFailure(hostile);
      recordLifecycleEvent({
        scope: 'sign-out',
        step: 'server-cleanup-failed',
        outcome: failureKind,
        detail: { serverSignOutPrepared: false },
        error: hostile,
      });
      steps.push('finishSignOutAttempt');
      memberMessage = signOutFailureMessage(failureKind, { serverSignOutPrepared: false });
      steps.push('setSignOutError');
      steps.push('haptics.warning');
    }).not.toThrow();

    expect(memberMessage).not.toBeNull();
    expect(memberMessage!).toContain('Sign-out is incomplete');
    expect(steps).toEqual(['finishSignOutAttempt', 'setSignOutError', 'haptics.warning']);
  });
});
