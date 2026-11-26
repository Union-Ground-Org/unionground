import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import type { ExactSessionIdentity } from '../services/sessionResume';
import { createAccountSessionIdentity } from './accountSessionIdentity';

const SID_A = '11111111-1111-4111-8111-111111111111';
const SID_B = '22222222-2222-4222-8222-222222222222';
function identity(userID: string, sessionID = SID_A, version = 1): ExactSessionIdentity {
  const payload = Buffer.from(JSON.stringify({ session_id: sessionID, version })).toString('base64url');
  return { userID, accessToken: `header.${payload}.signature`, refreshToken: `refresh-${version}` };
}

describe('account login ownership', () => {
  it('keeps a captured owner through a token rotation in the same server session', () => {
    const ref = createAccountSessionIdentity();
    ref.current = identity('user-a');
    const current = ref.captureGuard('user-a');
    ref.current = identity('user-a', SID_A, 2);
    expect(current()).toBe(true);
  });
  it('permanently retires a cleared login even if the exact old tuple is restored', () => {
    const ref = createAccountSessionIdentity();
    const initial = identity('user-a');
    ref.current = initial;
    const current = ref.captureGuard('user-a');
    ref.current = null;
    expect(current()).toBe(false);
    ref.current = initial;
    expect(current()).toBe(false);
    expect(ref.captureGuard('user-a')()).toBe(true);
  });
  it('does not revive the original login after an intervening different account', () => {
    const ref = createAccountSessionIdentity();
    const initial = identity('user-a');
    ref.current = initial;
    const current = ref.captureGuard('user-a');
    ref.current = identity('user-b', SID_B);
    expect(current()).toBe(false);
    ref.current = initial;
    expect(current()).toBe(false);
    expect(ref.captureGuard('user-a')()).toBe(true);
  });
  it('retires a same-account replacement login without needing an intermediate null', () => {
    const ref = createAccountSessionIdentity();
    ref.current = identity('user-a');
    const current = ref.captureGuard('user-a');
    ref.current = identity('user-a', SID_B);
    expect(current()).toBe(false);
    expect(ref.captureGuard('user-a')()).toBe(true);
  });
  it('does not infer continuity between different opaque access tokens', () => {
    const ref = createAccountSessionIdentity();
    ref.current = { userID: 'user-a', accessToken: 'opaque-a', refreshToken: 'refresh-a' };
    const current = ref.captureGuard('user-a');
    ref.current = { userID: 'user-a', accessToken: 'opaque-a', refreshToken: 'refresh-b' };
    expect(current()).toBe(true);
    ref.current = { userID: 'user-a', accessToken: 'opaque-b', refreshToken: 'refresh-b' };
    expect(current()).toBe(false);
  });
  it('never authorizes a capture made without the requested account identity', () => {
    const ref = createAccountSessionIdentity();
    const absent = ref.captureGuard('user-a');
    const anonymous = ref.captureGuard(null);
    ref.current = identity('user-a');
    expect(absent()).toBe(false);
    expect(anonymous()).toBe(false);
    expect(ref.captureGuard('user-b')()).toBe(false);
  });
});

// Run the provider's actual identity-ref initialization and both actual guard
// callbacks, rather than duplicating their ownership conditions in the test.
const source = readFileSync(new URL('../state/AppProvider.tsx', import.meta.url), 'utf8');
const tree = ts.createSourceFile('AppProvider.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let initialization = '';
let accountCallback = '';
let transitionCallback = '';
(function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.initializer) {
    const name = node.name.getText(tree);
    if (name === 'observedAuthIdentity') initialization = `const observedAuthIdentity = ${node.initializer.getText(tree)};`;
    if (ts.isCallExpression(node.initializer)) {
      if (name === 'captureAccountSessionGuard') accountCallback = node.initializer.arguments[0]!.getText(tree);
      if (name === 'captureAuthenticatedSessionGuard') transitionCallback = node.initializer.arguments[0]!.getText(tree);
    }
  }
  ts.forEachChild(node, visit);
})(tree);
if (!initialization || !accountCallback || !transitionCallback) throw new Error('Provider ownership code not found');

function provider() {
  const activeUserID = { current: 'user-a' as string | null };
  const sessionTransition = { current: 0 };
  const compiled = ts.transpile(`(() => { ${initialization}
    return { observedAuthIdentity, account: (${accountCallback}), transition: (${transitionCallback}) };
  })()`, { target: ts.ScriptTarget.ES2022 });
  const callbacks = runInNewContext(compiled, {
    createAccountSessionIdentity, activeUserID, sessionTransition,
    useRef: <T>(current: T) => ({ current }),
  }) as {
    observedAuthIdentity: ReturnType<typeof createAccountSessionIdentity>;
    account(userID: string | null): () => boolean;
    transition(): () => boolean;
  };
  callbacks.observedAuthIdentity.current = identity('user-a');
  return { ...callbacks, activeUserID, sessionTransition };
}

describe('AppProvider capture ownership', () => {
  it('keeps local account capture live across a transition while the reauthorization guard expires', () => {
    const f = provider();
    const account = f.account('user-a');
    const transition = f.transition();
    f.sessionTransition.current++;
    expect(account()).toBe(true);
    expect(transition()).toBe(false);
    f.observedAuthIdentity.current = identity('user-a', SID_A, 2);
    expect(account()).toBe(true);
  });
  it('refuses a mismatched rendered user and a cleared active user', () => {
    const f = provider();
    expect(f.account('user-b')()).toBe(false);
    const account = f.account('user-a');
    f.activeUserID.current = null;
    expect(account()).toBe(false);
  });
  it('never revives a retired provider callback on same-account replacement', () => {
    const f = provider();
    const account = f.account('user-a');
    f.observedAuthIdentity.current = null;
    f.activeUserID.current = null;
    f.observedAuthIdentity.current = identity('user-a');
    f.activeUserID.current = 'user-a';
    expect(account()).toBe(false);
    expect(f.account('user-a')()).toBe(true);
  });
});
