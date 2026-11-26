// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { act, createElement as h, type PropsWithChildren, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./ui', () => ({
  StateMessage: ({ title, body, action }: { title: string; body: string; action?: ReactNode }) => h('section', null, h('h2', null, title), h('p', null, body), action),
  Button: ({ label, onPress, disabled }: PropsWithChildren<{ label: string; onPress: () => void; disabled?: boolean }>) =>
    h('button', { disabled, onClick: onPress }, label),
}));

import { AccountUnavailable } from './AccountUnavailable';
import { nativeUiText } from '../lib/nativeUiCopy';

// UX-UG-NATIVE-ACCOUNT-DETAILS-NO-RETRY-20261018: the account-unavailable
// state retries in place with the same user refresh Home offers.
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const button = () => container.querySelector('button')!;

function operationPort() {
  const source = readFileSync(resolve(process.cwd(), 'src/lib/useBusinessWriter.ts'), 'utf8');
  const tree = ts.createSourceFile('useBusinessWriter.ts', source, ts.ScriptTarget.Latest, true);
  const node = tree.statements.find((entry: ts.Statement) => ts.isFunctionDeclaration(entry) && entry.name?.text === 'completeBusinessOperation');
  if (!node) throw new Error('Missing shared operation lifetime');
  const complete = runInNewContext(ts.transpile(`${node.getText(tree).replace(/^export /, '')}; completeBusinessOperation;`, { target: ts.ScriptTarget.ES2022 })) as
    (lock: { current: boolean }, kind: string, idle: null, setBusy: (value: string | null) => void, work: () => Promise<void>) => Promise<void>;
  const lock = { current: false };
  const setBusy = vi.fn<(value: string | null) => void>();
  return { lock, setBusy, runOperation: (kind: string, work: () => Promise<void>) => complete(lock, kind, null, setBusy, work) };
}

describe('account write operation lifetime', () => {
  it.each(['updateSmsConsent'])('%s refuses a retained second press until the accepted reply and proof settle', async (name) => {
    const path = 'app/(tabs)/account.tsx';
    const tree = ts.createSourceFile(path, readFileSync(resolve(process.cwd(), path), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let handler = '';
    function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) handler = node.getText(tree); ts.forEachChild(node, visit); }
    visit(tree);
    let releaseWrite = () => {}; let releaseProof = () => {};
    const write = new Promise<void>(resolve => { releaseWrite = resolve; });
    const proof = new Promise<void>(resolve => { releaseProof = resolve; });
    const send = vi.fn(async () => { await write; return {}; });
    const operation = operationPort();
    const check = vi.fn(async () => { await proof; return 'unavailable'; });
    const action = runInNewContext(ts.transpile(`${handler}; ${name};`, { target: ts.ScriptTarget.ES2022 }), {
      ...operation, session: {}, busy: null, pin: '284719', confirm: '284719', status: { hasPin: true },
      captureSessionWriter: () => ({ check, isCurrent: async () => { await proof; return false; } }),
      pinFormatIssue: () => null, t: (text: string) => text, catalogLabel: (text: string) => text,
      setBusy: operation.setBusy, setSmsBusy: vi.fn(), setNotice: vi.fn(), setSmsError: vi.fn(), setSettingsNotice: vi.fn(),
      setPin: vi.fn(), setConfirm: vi.fn(), setEditing: vi.fn(), setConfirmingRemove: vi.fn(), setSmsPhone: vi.fn(),
      setLoadFailed: vi.fn(), setSmsNeedsRefresh: vi.fn(), normalizedSmsPhone: '+16175550111',
      saveMyMemberPin: send, endMyMemberPinSessions: send, removeMyMemberPin: send, setMobileSmsConsent: send,
    }) as (consented?: boolean) => Promise<void>;
    const first = action(true); const duplicate = action(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(operation.lock.current).toBe(true);
    releaseWrite(); await Promise.resolve(); await Promise.resolve();
    expect(operation.lock.current).toBe(true);
    releaseProof(); await Promise.all([first, duplicate]);
    expect(operation.lock.current).toBe(false);
    expect(operation.setBusy).toHaveBeenLastCalledWith(null);
  });

  it.each(['submit', 'recover'])('MFA %s shares the synchronous lock while its remote result is pending', async (name) => {
    const path = 'app/mfa-challenge.tsx';
    const tree = ts.createSourceFile(path, readFileSync(resolve(process.cwd(), path), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let handler = '';
    function visit(node: ts.Node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) handler = node.getText(tree); ts.forEachChild(node, visit); }
    visit(tree);
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const send = vi.fn(async () => { await held; return 'recovered'; });
    const operation = operationPort();
    const action = runInNewContext(ts.transpile(`${handler}; ${name};`, { target: ts.ScriptTarget.ES2022 }), {
      ...operation, code: '123456', recoveryCode: 'a-saved-code', mounted: { current: true },
      recoveryCleanup: { current: null }, finishMfaRecovery: vi.fn(async () => true),
      isAuthenticatorCode: () => true, getSupabaseClient: () => ({}), beginMfaRecovery: () => ({}),
      setMessage: vi.fn(), setRecovering: vi.fn(), setRecoveryCode: vi.fn(), report: vi.fn(),
      verifyMfa: send, redeemMfaRecoveryCode: send, resolveMfaRecoveryApiOrigin: vi.fn(),
      forceReverificationRequested: false, mfaRecoveryMessage: (value: string) => value,
    }) as () => Promise<void>;
    const first = action(); const second = action();
    expect(send).toHaveBeenCalledTimes(1);
    expect(operation.lock.current).toBe(true);
    release(); await Promise.all([first, second]);
    expect(operation.lock.current).toBe(false);
  });
});

describe('account read ordering and unavailable proof', () => {
  it.each(['loadSmsStatus'])('%s retains the newer answer when an older read returns last', async (name) => {
    const path = 'app/(tabs)/account.tsx';
    const tree = ts.createSourceFile(path, readFileSync(resolve(process.cwd(), path), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let callback = '';
    function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0]?.getText(tree) ?? '';
      ts.forEachChild(node, visit);
    }
    visit(tree);
    let release = () => {};
    const old = new Promise<void>(resolve => { release = resolve; });
    const read = vi.fn().mockImplementationOnce(async () => { await old; return { value: 'old' }; }).mockResolvedValue({ value: 'new' });
    const apply = vi.fn();
    const env = {
      readGeneration: { current: 0 }, smsReadGeneration: { current: 0 }, mounted: { current: true }, smsMounted: { current: true },
      loadMyMemberPinStatus: read, loadMobileSmsPreference: read, setStatus: apply, setSmsPreference: apply,
      setLoadFailed: vi.fn(), setSmsNeedsRefresh: vi.fn(), setSmsError: vi.fn(), t: (text: string) => text,
    };
    const load = runInNewContext(ts.transpile(`(${callback})`, { target: ts.ScriptTarget.ES2022 }), env) as (writer: { check: () => Promise<string> }) => Promise<void>;
    const writer = { check: async () => 'current' };
    const first = load(writer); await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    await load(writer); release(); await first;
    expect(apply.mock.calls).toEqual([[{ value: 'new' }]]);
    read.mockClear(); apply.mockClear();
    await load({ check: async () => 'unavailable' });
    expect(read).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });
});

describe('account write failure feedback uses three-state ownership', () => {
  const writes: ReadonlyArray<readonly [string, string]> = [
    ['app/(tabs)/account.tsx', 'updateSmsConsent'],
  ];
  for (const [path, name] of writes) {
    it.each<'current' | 'changed' | 'unavailable'>(['current', 'changed', 'unavailable'])(`${name} reports a failed send only to its owner when proof is %s`, async (proof) => {
      const source = readFileSync(resolve(process.cwd(), path), 'utf8');
      const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      let handler = '';
      function visit(node: ts.Node) {
        if (ts.isFunctionDeclaration(node) && node.name?.text === name) handler = node.getText(tree);
        ts.forEachChild(node, visit);
      }
      visit(tree);
      if (!handler) throw new Error(`Missing account handler ${name}`);
      const feedback = vi.fn<(value: unknown) => void>();
      const failedSend = vi.fn(async () => { throw new Error('Transport unavailable'); });
      const action = runInNewContext(ts.transpile(`${handler}; ${name};`, { target: ts.ScriptTarget.ES2022 }), {
        ...operationPort(),
        captureSessionWriter: () => ({ check: async () => proof, isCurrent: async () => proof === 'current' }),
        session: { user: { id: 'member-a' } }, busy: false, pin: '284719', confirm: '284719',
        pinFormatIssue: () => null, issueOf: () => 'member-pin-failed', PIN_ISSUE_COPY: { 'member-pin-failed': 'Could not send' },
        catalogLabel: (text: string) => text, t: (text: string) => text,
        setBusy: vi.fn(), setPin: vi.fn(), setConfirm: vi.fn(), setNotice: feedback, setSettingsNotice: vi.fn(),
        setSmsBusy: vi.fn(), setSmsError: feedback, setSmsNeedsRefresh: vi.fn(), setLoadFailed: vi.fn(), normalizedSmsPhone: '+16175550111',
        saveMyMemberPin: failedSend, endMyMemberPinSessions: failedSend, removeMyMemberPin: failedSend, setMobileSmsConsent: failedSend,
      }) as (consented?: boolean) => Promise<void>;
      await action(true);
      // The first null clears an old notice; only a retained owner receives failure text.
      expect(feedback.mock.calls.filter(([value]) => value !== null)).toHaveLength(proof === 'changed' ? 0 : 1);
      expect(failedSend).toHaveBeenCalledTimes(1);
    });
  }
});

describe('accepted account writes explain an unavailable refresh', () => {
  const writes: ReadonlyArray<readonly [string, string, boolean, boolean, string, string]> = [
    ['app/(tabs)/account.tsx', 'updateSmsConsent', true, false, 'SMS consent was changed.', 'Se cambió el consentimiento para SMS.'],
    ['app/(tabs)/account.tsx', 'updateSmsConsent', false, false, 'SMS consent was changed.', 'Se cambió el consentimiento para SMS.'],
  ];
  for (const [path, name, consented, hasPin, english, spanish] of writes) {
    for (const language of ['en', 'es']) {
      it.each<'current' | 'changed' | 'unavailable'>(['current', 'changed', 'unavailable'])(`${name} consent=${consented} hasPin=${hasPin} in ${language}, accepted with proof %s`, async (proof) => {
        const source = readFileSync(resolve(process.cwd(), path), 'utf8');
        const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
        let handler = '';
        function visit(node: ts.Node) {
          if (ts.isFunctionDeclaration(node) && node.name?.text === name) handler = node.getText(tree);
          ts.forEachChild(node, visit);
        }
        visit(tree);
        if (!handler) throw new Error(`Missing account handler ${name}`);
        const feedback = vi.fn<(value: { text: string } | null) => void>();
        const failure = vi.fn<(value: unknown) => void>();
        const saved = { consented, phoneLast4: consented ? '0111' : null };
        const acceptedSend = vi.fn(async () => saved);
        const refresh = vi.fn(async () => undefined);
        const setSmsPreference = vi.fn();
        const setEditing = vi.fn();
        const setConfirmingRemove = vi.fn();
        const action = runInNewContext(ts.transpile(`${handler}; ${name};`, { target: ts.ScriptTarget.ES2022 }), {
          ...operationPort(),
          captureSessionWriter: () => ({ check: async () => proof, isCurrent: async () => proof === 'current' }),
          session: { user: { id: 'member-a' } }, status: { hasPin }, busy: false, pin: '284719', confirm: '284719',
          pinFormatIssue: () => null, issueOf: () => 'member-pin-failed', PIN_ISSUE_COPY: { 'member-pin-failed': 'Could not send' },
          catalogLabel: (text: string) => text, t: nativeUiText(language === 'es' ? 'es' : 'en'),
          setBusy: vi.fn(), setPin: vi.fn(), setConfirm: vi.fn(), setNotice: feedback, setSettingsNotice: feedback,
          setSmsBusy: vi.fn(), setSmsError: failure, normalizedSmsPhone: '+16175550111', setSmsPhone: vi.fn(),
          setSmsPreference, refreshStatus: refresh, setEditing, setConfirmingRemove, setLoadFailed: vi.fn(), setSmsNeedsRefresh: vi.fn(),
          saveMyMemberPin: acceptedSend, endMyMemberPinSessions: acceptedSend, removeMyMemberPin: acceptedSend, setMobileSmsConsent: acceptedSend,
        }) as (consented?: boolean) => Promise<void>;
        await action(consented);
        expect(acceptedSend).toHaveBeenCalledTimes(1);
        expect(failure.mock.calls.filter(([value]) => value !== null)).toEqual([]);
        const notices = feedback.mock.calls.flatMap(([value]) => value ? [value.text] : []);
        if (proof === 'unavailable') {
          expect(notices).toEqual([`${language === 'es' ? spanish : english} ${language === 'es' ? 'Actualice su cuenta cuando vuelva la conexión.' : 'Refresh your account when your connection returns.'}`]);
        } else if (proof === 'changed') {
          expect(notices).toEqual([]);
        } else if (name !== 'updateSmsConsent') {
          expect(notices).toEqual([language === 'es' ? spanish : english]);
        }
        expect(refresh).toHaveBeenCalledTimes(proof === 'current' && name !== 'updateSmsConsent' ? 1 : 0);
        expect(setSmsPreference).toHaveBeenCalledTimes(proof === 'current' && name === 'updateSmsConsent' ? 1 : 0);
        // Accepted drafts/confirmations settle for the composing owner before
        // proof; the user-keyed screen prevents a replacement seeing them.
        expect(setEditing).toHaveBeenCalledTimes(name === 'save' || name === 'remove' ? 1 : 0);
        expect(setConfirmingRemove).toHaveBeenCalledTimes(name === 'remove' ? 1 : 0);
      });
    }
  }
});

function accountHandler(name: string, context: Record<string, unknown>) {
  const path = 'app/(tabs)/account.tsx';
  const source = readFileSync(resolve(process.cwd(), path), 'utf8');
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let handler = '';
  ts.forEachChild(tree, function visit(node): void {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) handler = node.getText(tree);
    ts.forEachChild(node, visit);
  });
  if (!handler) throw new Error(`Missing account handler ${name}`);
  return runInNewContext(ts.transpile(`${handler}; ${name};`, { target: ts.ScriptTarget.ES2022 }), context) as (value?: boolean) => Promise<void>;
}

// SEC-UG-ONLINE-PHONE-WRITES-CAN-SEND-AS-REPLACEMENT-ACCOUNT-20261119,
// A failed SMS consent write shows the person's own
// language, never the writer's raw English message.
describe('a failed SMS consent write explains itself in the person language', () => {
  const languages: ReadonlyArray<'en' | 'es'> = ['en', 'es'];
  for (const language of languages) {
    it.each<'current' | 'unavailable'>(['current', 'unavailable'])(`in ${language} with proof %s`, async (proof) => {
      const failure = vi.fn<(value: unknown) => void>();
      const failedSend = vi.fn(async () => { throw new Error('This phone write belongs to another account.'); });
      const action = accountHandler('updateSmsConsent', {
        // The thrown error is the test realm's, so the handler must see the
        // same Error constructor or it could never take the raw-message path.
        Error,
        ...operationPort(),
        captureSessionWriter: () => ({ check: async () => proof, isCurrent: async () => proof === 'current' }),
        session: { user: { id: 'member-a' } }, t: nativeUiText(language), normalizedSmsPhone: '+16175550111',
        setSmsError: failure, setSettingsNotice: vi.fn(), setSmsPhone: vi.fn(), setSmsNeedsRefresh: vi.fn(), setSmsPreference: vi.fn(),
        setMobileSmsConsent: failedSend,
      });
      await action(true);
      expect(failedSend).toHaveBeenCalledTimes(1);
      expect(failure.mock.calls.filter(([value]) => value !== null)).toEqual([[language === 'es' ? 'No se cambió el consentimiento para SMS.' : 'SMS consent was not changed.']]);
    });
  }
});

// Same record, a review note: after a language save is accepted with an
// unavailable refresh, AppProvider keeps the accepted language in
// memberLanguage and withholds the dashboard update. A later name save must
// send that accepted language, not the dashboard's older one.
describe('a name save keeps the language the person last saved', () => {
  type Language = 'en' | 'es';
  function provider(dashboardLanguage: Language | null, memberLanguage: Language | null) {
    const member = { id: 'member-a', firstName: 'Ana', fullName: 'Ana Ruiz', language: dashboardLanguage };
    const state = { available: true };
    const context: Record<string, unknown> = {
      dashboard: dashboardLanguage ? { member } : null,
      memberLanguage,
      profileBusy: false, languageBusy: false, session: { user: { id: 'member-a' } },
      firstName: 'Ana María', fullName: 'Ana María Ruiz', BUSINESS_SAVED_STALE: 'Saved; refresh to see it.',
      t: (text: string) => text, captureAccountSessionGuard: () => () => true,
      setProfileBusy: vi.fn(), setProfileError: vi.fn(), setEditingProfile: vi.fn(),
    };
    // Mirrors AppProvider.saveProfile: an unavailable refresh keeps the
    // accepted language in memberLanguage and leaves the dashboard as it was.
    const saveProfile = vi.fn(async (input: { firstName: string; fullName: string; language: Language }) => {
      const saved = { ...member, ...input };
      if (state.available) context.dashboard = { member: saved };
      context.memberLanguage = saved.language;
      return state.available ? 'current' : 'unavailable';
    });
    context.saveProfile = saveProfile;
    // useNativeUi shows memberLanguage first, then the dashboard's.
    const shown = () => ((context.memberLanguage ?? (context.dashboard as { member: typeof member } | null)?.member.language) === 'es' ? 'es' : 'en');
    return { context, state, saveProfile, shown, submitProfile: accountHandler('submitProfile', context) };
  }

  it('after an unavailable Spanish language save, a name save sends and shows Spanish', async () => {
    const { context, state, saveProfile, shown, submitProfile } = provider('en', 'en');
    state.available = false;
    // LanguageSettingsCard's save: accepted, refresh unavailable.
    await expect((context.saveProfile as typeof saveProfile)({ firstName: 'Ana', fullName: 'Ana Ruiz', language: 'es' })).resolves.toBe('unavailable');
    expect((context.dashboard as { member: { language: Language } }).member.language).toBe('en');
    await submitProfile();
    expect(saveProfile).toHaveBeenLastCalledWith({ firstName: 'Ana María', fullName: 'Ana María Ruiz', language: 'es' });
    expect(context.memberLanguage).toBe('es');
    expect(shown()).toBe('es');
  });

  it.each<[Language | null, Language | null, Language]>([
    ['en', 'en', 'en'],
    ['es', 'es', 'es'],
    ['es', null, 'es'],
    [null, null, 'en'],
  ])('with dashboard %s and accepted %s a name save sends %s', async (dashboardLanguage, memberLanguage, sent) => {
    const { saveProfile, shown, submitProfile } = provider(dashboardLanguage, memberLanguage);
    await submitProfile();
    expect(saveProfile).toHaveBeenCalledTimes(1);
    expect(saveProfile).toHaveBeenLastCalledWith({ firstName: 'Ana María', fullName: 'Ana María Ruiz', language: sent });
    expect(shown()).toBe(sent);
  });
});

describe('Account details unavailable', () => {
  it('pressing Try again asks for the refresh and no longer sends the worker to Home', async () => {
    const onRetry = vi.fn();
    await act(async () => root.render(h(AccountUnavailable, { refreshing: false, onRetry })));
    expect(container.textContent).toContain('Account details unavailable');
    expect(container.textContent).toContain('sign out below');
    expect(container.textContent).not.toContain('retry from Home');
    expect(button().textContent).toBe('Try again');
    expect(button().disabled).toBe(false);
    await act(async () => button().click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('is disabled and says Retrying… while a refresh is pending', async () => {
    const onRetry = vi.fn();
    await act(async () => root.render(h(AccountUnavailable, { refreshing: true, onRetry })));
    expect(button().textContent).toBe('Retrying…');
    expect(button().disabled).toBe(true);
    await act(async () => button().click());
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('is what the Account screen renders without a dashboard, wired to the user refresh', () => {
    const account = readFileSync(resolve(process.cwd(), 'app/(tabs)/account.tsx'), 'utf8');
    expect(account).toContain("<AccountUnavailable refreshing={refreshing} onRetry={() => { void refresh('user-refresh'); }} />");
    expect(account).not.toContain('retry from Home');
    const context = [...account.matchAll(/const \{[^}]*\} = useApp\(\);/g)].map((match) => match[0]).find((value) => /\brefresh\b/.test(value)) ?? '';
    expect(context).toMatch(/\brefresh\b/);
    expect(context).toMatch(/\brefreshing\b/);
  });
});
