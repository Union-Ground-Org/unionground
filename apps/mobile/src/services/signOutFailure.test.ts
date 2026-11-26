import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  SignOutRpcRejectionError,
  SignOutServiceRejectionError,
  classifySignOutFailure,
  runLocalSignOutStep,
  signOutCleanupRejection,
  signOutFailureMessage,
  tagSignOutProvenance,
  type SignOutFailureKind,
  type SignOutRpcResponse,
} from './signOutFailure';

// The exact shape `@supabase/postgrest-js` returns when the platform fetch
// fails before any server answers: an empty code and status 0, because those
// fields are reserved for what the upstream service said.
function transportRejection(message = 'TypeError: Network request failed') {
  return {
    data: null,
    error: { message, details: 'TypeError: Network request failed', hint: '', code: '' },
    status: 0,
    statusText: '',
  };
}

// The exact shape `@supabase/postgrest-js` returns when the service answers a
// 4xx/5xx whose body is not JSON — a gateway or proxy error page, a load
// balancer's plain-text refusal. `processResponse` falls back to
// `error = { message: body }`: no `code`, no `status` on the error object, and
// the real HTTP status kept only on the response beside it. This is the shape
// the round-1 review named: reading `{ data, error }` classifies it as a
// dropped connection and tells a well-connected member to reconnect.
function nonJsonServiceRejection(status = 502, statusText = 'Bad Gateway') {
  return {
    data: null,
    error: { message: '<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>' },
    status,
    statusText,
  };
}

// The exact shape the hosted SAMPLE backend returns today: it exposes
// prepare_my_signout(text) while this client calls the G5
// prepare_my_signout(text, uuid), so PostgREST cannot find the overload.
// PostgREST can answer HTTP 200 with a body that is not the JSON the client
// expects — a proxy or CDN success page, a truncated payload. `processResponse`
// still yields `error: { message }` with no code, and the response status is a
// real 200: the service answered, so this is a service problem and never the
// member's connection. Round-2 Codex review, P2-1 named this exact shape.
function malformedSuccessRejection() {
  return {
    data: null,
    error: { message: 'OK but not the expected JSON body' },
    status: 200,
    statusText: 'OK',
  };
}

function functionShapeRejection() {
  return {
    data: null,
    error: {
      message: 'Could not find the function public.prepare_my_signout(p_expected_user_id, p_scope) in the schema cache',
      details: null,
      hint: 'Perhaps you meant to call the function public.prepare_my_signout(p_scope)',
      code: 'PGRST202',
    },
    status: 404,
  };
}

/**
 * Drive the sign-out preparation exactly as the account sign-out handler does:
 * call `prepare_my_signout`, apply the fail-closed rejection decision, then
 * classify whatever it produced and render the member-facing copy.
 */
async function signOutThrough(
  rpc: () => Promise<SignOutRpcResponse>,
  serverSignOutPrepared = false,
) {
  // The handler keeps the whole response, exactly as AppProvider does, because
  // the HTTP status lives beside `error` and not inside it.
  const cleanupResponse = await rpc();
  const rejection = signOutCleanupRejection(cleanupResponse);
  if (!rejection) return { completed: true as const, message: null, kind: null, rejection: null };
  const kind = classifySignOutFailure(rejection);
  return {
    completed: false as const,
    kind,
    rejection,
    message: signOutFailureMessage(kind, { serverSignOutPrepared }),
  };
}

describe('account sign-out failure diagnosis', () => {
  it.each(['20', 'ERR_NETWORK_REQUEST_FAILED'])('keeps status-zero fetch failure %s as transport', async (code) => {
    const response = transportRejection();
    response.error.code = code;
    const result = await signOutThrough(async () => response);
    expect(result.kind).toBe('transport');
    expect(result.message).toBe('Sign-out is incomplete. Notifications may be paused; reconnect and finish signing out.');
  });

  it('keeps the reconnect copy for a genuine transport failure', async () => {
    const result = await signOutThrough(async () => transportRejection());

    expect(result.completed).toBe(false);
    expect(result.kind).toBe('transport');
    expect(result.message).toBe(
      'Sign-out is incomplete. Notifications may be paused; reconnect and finish signing out.',
    );
    expect(result.message).toContain('reconnect');
  });

  it('names a service problem, not a connection problem, when the server rejects the call shape', async () => {
    const result = await signOutThrough(async () => functionShapeRejection());

    expect(result.completed).toBe(false);
    expect(result.kind).toBe('service');
    expect(result.message).toBe(
      'Sign-out is incomplete because the service refused the request, not because of your connection. '
      + 'Notifications may be paused; try again shortly, and tell your campaign administrator if it keeps happening.',
    );
    // The defect this record fixes: a well-connected member was told to
    // reconnect, so the reconnect instruction must be absent here.
    expect(result.message).not.toContain('reconnect');
    // An actionable next step, and an explicit denial of the wrong diagnosis.
    expect(result.message).toContain('try again shortly');
    expect(result.message).toContain('not because of your connection');
  });

  it('names a service problem for a code-less non-JSON 5xx, whose status lives only on the response', async () => {
    const result = await signOutThrough(async () => nonJsonServiceRejection());

    // Round-1 Codex review, P2: the handler destructured `{ data, error }`, so
    // the response-level 502 never reached classification and a service answer
    // was diagnosed as a dropped connection.
    expect(result.completed).toBe(false);
    expect(result.kind).toBe('service');
    expect(result.message).not.toContain('reconnect');
    expect(result.message).toBe(
      'Sign-out is incomplete because the service refused the request, not because of your connection. '
      + 'Notifications may be paused; try again shortly, and tell your campaign administrator if it keeps happening.',
    );
    // The provenance survives on the rejection, not only in the verdict.
    expect(result.rejection).toBeInstanceOf(SignOutRpcRejectionError);
    const rejection = result.rejection as SignOutRpcRejectionError;
    expect(rejection.status).toBe(502);
    expect(rejection.statusText).toBe('Bad Gateway');
    expect(rejection.code).toBeNull();
  });

  it('names a service problem for a malformed HTTP 200 the service actually answered', async () => {
    // Round-2 Codex review, P2-1: a non-JSON 200 is still a PostgREST answer.
    // Classifying by the operation's provenance — the RPC answered — rather than
    // by the status floor keeps it a service problem, not a dropped connection.
    const result = await signOutThrough(async () => malformedSuccessRejection());

    expect(result.completed).toBe(false);
    expect(result.kind).toBe('service');
    expect(result.message).not.toContain('reconnect');
    expect(result.message).toContain('not because of your connection');
    const rejection = result.rejection as SignOutRpcRejectionError;
    expect(rejection.status).toBe(200);
    expect(rejection.code).toBeNull();
  });

  it('names a service problem for every code-less status a service can answer with', async () => {
    for (const status of [400, 401, 403, 404, 409, 429, 500, 503, 504]) {
      const result = await signOutThrough(async () => nonJsonServiceRejection(status, ''));

      expect(result.kind, `status ${status}`).toBe('service');
      expect(result.message).not.toContain('reconnect');
    }
  });

  it('still keeps the reconnect copy when the response proves no service answered', async () => {
    // Status 0 with an empty statusText is what postgrest-js reports for a
    // client-side fetch failure; retaining the response must not turn every
    // failure into a service problem.
    const result = await signOutThrough(async () => transportRejection());

    expect(result.kind).toBe('transport');
    expect((result.rejection as SignOutRpcRejectionError).status).toBe(0);
    expect(result.message).toContain('reconnect');
  });

  it('gives the two failures distinct copy and reports neither as a completed sign-out', async () => {
    const transport = await signOutThrough(async () => transportRejection());
    const service = await signOutThrough(async () => functionShapeRejection());

    expect(service.message).not.toBe(transport.message);
    for (const result of [transport, service]) {
      expect(result.completed).toBe(false);
      expect(result.message).toContain('Sign-out is incomplete');
      expect(result.message).not.toMatch(/signed out|sign-out is complete|you are signed out/i);
    }
  });

  it('keeps the paused-notification distinction inside both diagnoses', async () => {
    const transport = await signOutThrough(async () => transportRejection(), true);
    const service = await signOutThrough(async () => functionShapeRejection(), true);

    expect(transport.message).toContain('Notifications are paused');
    expect(service.message).toContain('Notifications are paused');
    expect(transport.message).not.toContain('may be paused');
    expect(service.message).not.toContain('may be paused');
  });

  it('treats a success status that never confirms the cleanup as a service rejection', async () => {
    const result = await signOutThrough(async () => ({ data: { serverCleanupComplete: false }, error: null }));
    const missingPayload = await signOutThrough(async () => ({ data: null, error: null }));

    expect(result.kind).toBe('service');
    expect(missingPayload.kind).toBe('service');
    expect(signOutCleanupRejection({ data: null, error: null })).toBeInstanceOf(SignOutServiceRejectionError);
  });

  it('reports a confirmed cleanup as no rejection at all', async () => {
    const result = await signOutThrough(async () => ({ data: { serverCleanupComplete: true }, error: null }));

    expect(result.completed).toBe(true);
    expect(signOutCleanupRejection({ data: { serverCleanupComplete: true }, error: null })).toBeNull();
  });
});

describe('sign-out failure classification', () => {
  it('classifies every server answer as a service problem', () => {
    expect(classifySignOutFailure({ code: 'PGRST202', status: 404 })).toBe('service');
    expect(classifySignOutFailure({ code: '42883', status: 400 })).toBe('service');
    expect(classifySignOutFailure({ code: '', status: 503 })).toBe('service');
    expect(classifySignOutFailure({ code: 'PGRST301' })).toBe('service');
    expect(classifySignOutFailure({ status: '404' })).toBe('service');
  });

  it('classifies platform fetch failures as transport, including the ones that carry a code', () => {
    expect(classifySignOutFailure({ code: '', status: 0 })).toBe('transport');
    expect(classifySignOutFailure(new TypeError('Network request failed'))).toBe('transport');
    expect(classifySignOutFailure({ name: 'AbortError', code: 'ABORT_ERR', status: 0 })).toBe('transport');
    expect(classifySignOutFailure({ code: 'ECONNREFUSED' })).toBe('transport');
    expect(classifySignOutFailure({ code: 'und_err_socket' })).toBe('transport');
  });

  it('leaves an unrecognised local failure on the existing connectivity diagnosis', () => {
    // Only a positively identified server answer may acquire copy that blames
    // the service; anything else keeps the behaviour this record did not change.
    expect(classifySignOutFailure(new Error('The persisted session changed during sign-out.'))).toBe('transport');
    expect(classifySignOutFailure(null)).toBe('transport');
    expect(classifySignOutFailure('boom')).toBe('transport');
  });
});

describe('sign-out failure provenance', () => {
  it('classifies a tagged local native failure as local, and an untagged one never as service', () => {
    const nativeFailure = Object.assign(new Error('SecureStore write failed'), { code: 'E_SECURESTORE' });

    // Round-2 Codex review, P2-1: a device error code must never be read as a
    // server answer. Untagged, the conservative connectivity diagnosis stands.
    expect(classifySignOutFailure(nativeFailure)).toBe('transport');
    // Tagged at the local operation boundary, its provenance is honoured.
    expect(classifySignOutFailure(tagSignOutProvenance(nativeFailure, 'local'))).toBe('local');
  });

  it('never treats an arbitrary or vendor error code as service evidence', () => {
    for (const code of ['E_SECURESTORE', 'E_UNMAPPED_VENDOR_CODE', 'KEYCHAIN_ERROR', 'E_NATIVE_MODULE']) {
      expect(classifySignOutFailure({ code }), code).toBe('transport');
    }
    // Only the closed service allowlist and the PostgREST prefix are proof the
    // service answered.
    expect(classifySignOutFailure({ code: 'PGRST202' })).toBe('service');
    expect(classifySignOutFailure({ code: '42883' })).toBe('service');
    expect(classifySignOutFailure({ code: '42501' })).toBe('service');
  });

  it('gives a local device failure its own copy: neither reconnect nor a service accusation', () => {
    const message = signOutFailureMessage('local', { serverSignOutPrepared: false });

    expect(message).toContain('Sign-out is incomplete');
    expect(message).toContain('this device could not finish');
    expect(message).not.toContain('reconnect');
    expect(message).not.toContain('the service refused');
    expect(message).not.toMatch(/signed out|sign-out is complete|you are signed out/i);
    // The paused-notification distinction still threads through the local copy.
    expect(signOutFailureMessage('local', { serverSignOutPrepared: true })).toContain('Notifications are paused');
  });

  it('names the outcome a failed sign out everywhere did not reach', () => {
    // REQ-UG-NATIVE-SESSION-MANAGEMENT-20261009: a member who asked
    // to sign out everywhere must never be left believing their other devices
    // were signed out. Every kind opens by saying so.
    const kinds: SignOutFailureKind[] = ['transport', 'service', 'local'];
    for (const kind of kinds) {
      const message = signOutFailureMessage(kind, { serverSignOutPrepared: false, scope: 'global' });
      expect(message).toContain('Sign out everywhere is incomplete');
      expect(message).toContain('your other devices may still be signed in');
      expect(message).not.toMatch(/signed out everywhere|all devices signed out|you are signed out/i);
      // A device whose own session is already gone is refused every time, so
      // the global copy names the route that still works on this device.
      expect(message).toContain('use Sign out near the top of Account, then Confirm sign out');
    }
    expect(signOutFailureMessage('transport', { serverSignOutPrepared: false })).not.toContain('use Sign out');
    expect(signOutFailureMessage('service', { serverSignOutPrepared: false, scope: 'global' }))
      .toContain('not because of your connection');
    expect(signOutFailureMessage('transport', { serverSignOutPrepared: true, scope: 'global' }))
      .toContain('Notifications are paused');
  });

  it('leaves the single-device copy unchanged for the local scope and for no scope', () => {
    const omitted = signOutFailureMessage('transport', { serverSignOutPrepared: false });
    expect(omitted).toBe(signOutFailureMessage('transport', { serverSignOutPrepared: false, scope: 'local' }));
    expect(omitted).toContain('Sign-out is incomplete');
    expect(omitted).not.toContain('other devices');
  });

  it('runLocalSignOutStep tags a thrown native failure so its provenance survives to classification', async () => {
    const captured = await runLocalSignOutStep(async () => {
      throw Object.assign(new Error('keychain unavailable'), { code: 'E_SECURESTORE' });
    }).catch((error: unknown) => error);

    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toBe('keychain unavailable');
    expect(classifySignOutFailure(captured)).toBe('local');
    expect(signOutFailureMessage(classifySignOutFailure(captured), { serverSignOutPrepared: false }))
      .toContain('this device could not finish');
  });

  it('runLocalSignOutStep passes a successful result straight through', async () => {
    await expect(runLocalSignOutStep(async () => 'cleared')).resolves.toBe('cleared');
    await expect(runLocalSignOutStep(() => true)).resolves.toBe(true);
  });

  it('never throws while classifying, even for a value that resists inspection', () => {
    const hostile = new Proxy({}, { get() { throw new Error('native name accessor failed'); } });
    expect(() => classifySignOutFailure(hostile)).not.toThrow();
    expect(classifySignOutFailure(hostile)).toBe('transport');

    const throwingStatus = new Error('x');
    Object.defineProperty(throwingStatus, 'status', { get() { throw new Error('status accessor failed'); } });
    Object.defineProperty(throwingStatus, 'code', { get() { throw new Error('code accessor failed'); } });
    expect(() => classifySignOutFailure(throwingStatus)).not.toThrow();
    expect(classifySignOutFailure(throwingStatus)).toBe('transport');
  });
});

const SERVER_SIGN_OUT_CATCH = '} catch (serverSignOutFailure) {';

/**
 * The body of the live-session catch, brace-matched out of the source rather
 * than found by a substring, so an assertion about "the end of the catch" is
 * about the end of the catch. String literals and line comments are skipped so
 * a brace inside either cannot close the block early.
 */
function serverSignOutCatchBody(source: string): string {
  const header = source.indexOf(SERVER_SIGN_OUT_CATCH);
  if (header < 0) throw new Error('the live-session sign-out catch is no longer present');
  const open = header + SERVER_SIGN_OUT_CATCH.length - 1;
  let depth = 0;
  let quote: string | null = null;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== null) {
      if (character === '\\') index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') { quote = character; continue; }
    if (character === '/' && source[index + 1] === '/') {
      const lineEnd = source.indexOf('\n', index);
      index = lineEnd < 0 ? source.length : lineEnd;
      continue;
    }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error('the live-session sign-out catch is unbalanced');
}

/** Delete the last bare `return;` statement from a block. */
function deleteTrailingReturn(body: string): string {
  const lines = body.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]?.trim() === 'return;') {
      lines.splice(index, 1);
      return lines.join('\n');
    }
  }
  throw new Error('no bare return to delete');
}

/**
 * The fail-closed properties of the live-session catch, stated as executable
 * checks so a mutation of the handler source is visible to this suite.
 */
function failClosedViolations(source: string): string[] {
  const body = serverSignOutCatchBody(source);
  const violations: string[] = [];
  if (!body.includes('if (!signOutStillCurrent()) return;')) {
    violations.push('the server sign-out catch no longer re-checks that the attempt is current');
  }
  const statements = body.split('\n').map((line) => line.trim()).filter((line) => line.length > 0 && !line.startsWith('//'));
  if (statements[statements.length - 1] !== 'return;') {
    violations.push('the server sign-out catch does not end in an unconditional return');
  }
  return violations;
}

describe('account sign-out handler wiring', () => {
  const provider = readFileSync(
    fileURLToPath(new URL('../state/AppProvider.tsx', import.meta.url)),
    'utf8',
  );
  const signOut = provider.slice(
    provider.indexOf('const signOut = useCallback'),
    provider.indexOf('const refresh = useCallback', provider.indexOf('const signOut = useCallback')),
  );

  it('routes the live-session failure through the shared classifier and copy', () => {
    expect(signOut).toContain('} catch (serverSignOutFailure) {');
    expect(signOut).toContain('const failureKind = classifySignOutFailure(serverSignOutFailure);');
    expect(signOut).toContain('setSignOutError(signOutFailureMessage(failureKind, { serverSignOutPrepared, scope }));');
    expect(signOut).toContain('const cleanupRejection = signOutCleanupRejection(cleanupResponse);');
    expect(signOut).toContain('if (cleanupRejection) throw cleanupRejection;');
  });

  it('hands the whole PostgREST response to the classifier, not just data and error', () => {
    // Round-1 Codex review, P2: `const { data: cleanup, error: cleanupError }`
    // discarded the response-level HTTP status, which is the only evidence a
    // code-less non-JSON 4xx/5xx leaves that the service answered.
    expect(signOut).toContain('const cleanupResponse = await prepareMySignOut(serverCleanupClient, scope, expectedUserID);');
    expect(signOut).not.toMatch(/const \{[^}]*\berror\b[^}]*\} = await serverCleanupClient\.rpc\(/);
    expect(signOut).not.toContain('signOutCleanupRejection(cleanupError');
  });

  it('no longer hardcodes a connectivity diagnosis for every sign-out failure', () => {
    expect(signOut).not.toContain('reconnect and finish signing out.');
  });

  it('preserves the fail-closed refusal around the classified failure', () => {
    const failurePosition = signOut.indexOf('const failureKind = classifySignOutFailure(serverSignOutFailure);');
    expect(failurePosition).toBeGreaterThan(-1);
    // The guard, the attempt release and the warning haptic all still run, and
    // no success path is reachable from the catch.
    expect(signOut.indexOf('if (!signOutStillCurrent()) return;', failurePosition)).toBeGreaterThan(failurePosition);
    expect(signOut.indexOf('finishSignOutAttempt();', failurePosition)).toBeGreaterThan(failurePosition);
    expect(signOut.indexOf('await haptics.warning();', failurePosition)).toBeGreaterThan(failurePosition);
    expect(failClosedViolations(signOut)).toEqual([]);
  });

  it('pins the unconditional return that ends the catch, and catches its deletion', () => {
    // Round-1 Codex review, P3: the earlier assertion found the *first* return
    // after the classifier, which is the guarded `if (!signOutStillCurrent())
    // return;`. Deleting the unconditional return at the end of the catch —
    // which is what actually stops the success path from running after a
    // failure — left the assertion green. `failClosedViolations` reads the
    // catch block's own last statement, so the mutation below is visible.
    const body = serverSignOutCatchBody(signOut);
    const mutant = signOut.replace(body, deleteTrailingReturn(body));

    expect(mutant).not.toBe(signOut);
    expect(failClosedViolations(signOut)).toEqual([]);
    expect(failClosedViolations(mutant)).toEqual(['the server sign-out catch does not end in an unconditional return']);
    // Deleting the guarded return instead must not be mistaken for it.
    const guardedMutant = signOut.replace('        if (!signOutStillCurrent()) return;\n        finishSignOutAttempt();', '        finishSignOutAttempt();');
    expect(guardedMutant).not.toBe(signOut);
    expect(failClosedViolations(guardedMutant)).toEqual(['the server sign-out catch no longer re-checks that the attempt is current']);
  });

  it('tags native and client-side cleanup steps as local at their boundary, and leaves the RPC steps as service', () => {
    // Round-2 Codex review, P2-1: the failing operation decides provenance. The
    // native/local steps are wrapped so a device error code is classified local,
    // while the RPC steps keep their own service provenance and are not wrapped.
    expect(signOut).toContain('await runLocalSignOutStep(() => pauseNativePushRegistration());');
    expect(signOut).toContain('runLocalSignOutStep(() => clearNativePushPreferenceForSignOut(');
    expect(signOut).toContain('runLocalSignOutStep(() => revokeAndClearCapturedMobileSession(');
    expect(signOut).toContain(
      "tagSignOutProvenance(new Error('The persisted session changed during sign-out.'), 'local')",
    );
    expect(signOut).not.toContain('runLocalSignOutStep(() => serverCleanupClient');
    expect(signOut).not.toContain('runLocalSignOutStep(() => deleteNativePushInstallationForSignOut');
  });

  it('leaves the offline-lock attachment-cleanup message to its own record', () => {
    // BUG-UG-MOBILE-SIGNOUT-CACHE-PURGE-ABORT-20260905 owns this copy; this
    // record must not have altered it.
    expect(signOut).toContain(
      "setSignOutError('Union Ground could not clear temporary attachments. You remain signed in; keep the app open and try again.');",
    );
  });
});
