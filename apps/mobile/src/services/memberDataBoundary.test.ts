import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { authCallbackCopyFor, resolveAuthCallbackView } from '../lib/authCallbackRecovery';

const source = readFileSync(fileURLToPath(new URL('./supabase.ts', import.meta.url)), 'utf8');
const caseScreenSource = readFileSync(fileURLToPath(new URL('../../app/issue/[id].tsx', import.meta.url)), 'utf8');
const conversationScreenSource = readFileSync(fileURLToPath(new URL('../../app/conversation/[id].tsx', import.meta.url)), 'utf8');
const messagesScreenSource = readFileSync(fileURLToPath(new URL('../../app/messages.tsx', import.meta.url)), 'utf8');
const accountScreenSource = readFileSync(fileURLToPath(new URL('../../app/(tabs)/account.tsx', import.meta.url)), 'utf8');
const authCallbackSource = readFileSync(fileURLToPath(new URL('../../app/auth/callback.tsx', import.meta.url)), 'utf8');
const authCallbackRecoverySource = readFileSync(fileURLToPath(new URL('../lib/authCallbackRecovery.ts', import.meta.url)), 'utf8');
const compassSource = readFileSync(fileURLToPath(new URL('../components/CompassPanel.tsx', import.meta.url)), 'utf8');

function functionBody(name: string, nextName: string): string {
  const start = source.indexOf(`export async function ${name}`);
  const end = source.indexOf(`export async function ${nextName}`, start + 1);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('native worker data boundary', () => {
  it('scopes notification read-state writes to both the authenticated worker and record', () => {
    const body = functionBody('setNotificationReadState', 'loadConversationThread');
    expect(body).toContain(".eq('user_id', userID)");
    expect(body).toContain(".eq('id', notificationID)");
    expect(body).not.toContain('service_role');
  });

  it('scopes issue timeline and conversation reads to the worker plus protected parent record', () => {
    const caseBody = functionBody('loadCaseDetail', 'setNotificationReadState');
    const conversationBody = functionBody('loadConversationThread', 'markConversationRead');
    expect(caseBody.match(/\.eq\('user_id', userID\)/g)).toHaveLength(2);
    expect(caseBody).toContain(".eq('case_id', caseID)");
    expect(conversationBody.match(/\.eq\('user_id', userID\)/g)).toHaveLength(3);
    expect(conversationBody).toContain(".eq('conversation_id', conversationID)");
  });

  it('never substitutes dashboard cache for a failed authenticated issue reauthorization', () => {
    expect(caseScreenSource).toContain("detail?.item ?? (mode === 'preview' ? dashboardItem : null)");
    expect(caseScreenSource).not.toContain('detail?.item ?? dashboardItem');
  });

  it('keeps protected deep links loading during boot and clears a thread before reauthorization', () => {
    // BUG-UG-MOBILE-ATTACHMENT-UPLOAD-SILENT-FAILURE-20260905: the case
    // screen now decides through caseDetailPresence so a loaded case (and its
    // attachment panel) stays mounted through 'booting'; a case that has not
    // loaded still shows the loading message during boot.
    expect(caseScreenSource).toContain("const presence = caseDetailPresence({ mode, loading, hasItem: item !== null });");
    expect(caseScreenSource).toContain("if (presence === 'loading') return");
    expect(conversationScreenSource).toContain("loading || mode === 'booting'");
    expect(caseScreenSource).toMatch(/setLoading\(true\);\s+\}\s+setLoadError\(null\);[\s\S]*if \(mode === 'booting'\) return/);
    expect(conversationScreenSource).toMatch(/setLoading\(true\);\s+setLoadError\(null\);[\s\S]*if \(mode === 'booting'\) return/);
    expect(caseScreenSource).not.toMatch(/mode !== 'authenticated'[\s\S]{0,100}setLoading\(false\)/);
    expect(conversationScreenSource).not.toMatch(/mode !== 'authenticated'[\s\S]{0,100}setLoading\(false\)/);
    expect(conversationScreenSource).toMatch(/useEffect\(\(\) => \{\s+let active = true;\s+setThread\(null\);\s+setLoading\(true\);/);
  });

  it('loads the newest bounded conversation window in chronological order and announces write failures', () => {
    const conversationBody = functionBody('loadConversationThread', 'markConversationRead');
    // BUG-UG-NATIVE-DIRECT-THREAD-HIDES-OLDER-MESSAGES-20261109: the
    // newest page stays bounded at 200 with an id tie-break; earlier history
    // is read in further bounded pages before the same cursor.
    expect(conversationBody).toContain('export const THREAD_MESSAGE_PAGE = 200;');
    expect(conversationBody).toMatch(/\.order\('created_at', \{ ascending: false \}\)\.order\('id', \{ ascending: false \}\)\.limit\(THREAD_MESSAGE_PAGE\)/);
    expect(conversationBody).toContain('const rows = [...newestFirst].reverse();');
    expect(conversationScreenSource).toContain('sendError ? <View accessibilityLiveRegion="polite">');
    expect(accountScreenSource).toContain('profileError ? <View accessibilityLiveRegion="polite">');
    expect(messagesScreenSource).toContain('minimumFontScale={0.5}');
    expect(messagesScreenSource).toContain('numberOfLines={1}');
  });

  it('bounds every dashboard collection used by the mobile summary', () => {
    const dashboardBody = functionBody('loadDashboard', 'loadCaseDetail');
    expect(dashboardBody).toContain(".from('member_notifications')");
    expect(dashboardBody).toContain('.limit(MAX_DASHBOARD_NOTIFICATIONS)');
    expect(dashboardBody).toContain('.limit(MAX_DASHBOARD_CASES)');
    expect(dashboardBody).toContain('.limit(MAX_DASHBOARD_CONVERSATIONS)');
    expect(dashboardBody).toContain(".from('member_conversation_summaries')");
    expect(dashboardBody).not.toContain(".from('member_messages')\n      .select('id,conversation_id,sender_kind,sender_name,body,read_at,created_at')\n      .eq('user_id', userID)\n      .order('created_at', { ascending: false })\n      .limit(1_000)");
  });

  it('never renders raw auth or Guide backend error text', () => {
    // The callback renders fixed localized copy only; the thrown auth error is
    // dropped at the exchange boundary and never reaches the screen.
    expect(authCallbackCopyFor('en').recovery.exchangeFailed.body).toBe('This sign-in link could not be verified. Request a new one.');
    expect(authCallbackSource).toContain("void exchangeAuthCode(code).then(() => settle('complete'), () => settle('failed'));");
    expect(authCallbackSource).not.toContain('nextError.message');
    expect(authCallbackSource).not.toContain('.message');
    expect(authCallbackSource).not.toMatch(/catch\s*\(\s*\w/);
    expect(authCallbackRecoverySource).not.toContain('.message');
    expect(source).not.toContain('payload?.error');
    expect(source).toContain("payload?.code === 'compass_paused'");
    expect(source).toContain('throw new CompassPausedError()');
    expect(source).toContain("super('The Guide is paused by an administrator.')");
    expect(compassSource).toContain('The Guide is unavailable right now.');
    expect(compassSource).not.toContain('nextError.message');
    const provider = readFileSync(fileURLToPath(new URL('../state/AppProvider.tsx', import.meta.url)), 'utf8');
    expect(provider).not.toContain('function messageFrom');
    expect(provider).not.toContain('nextError.message');
  });

  it('recovers every completed auth exchange whose mode is not authenticated or mfaRequired', () => {
    // BUG-UG-MOBILE-IOS-AUTH-CALLBACK-SPINNER-NO-RECOVERY-20260919: these
    // modes used to keep the callback spinner forever.
    type UnrecoveredMode = 'booting' | 'signedOut' | 'preview';
    const unrecoveredModes: UnrecoveredMode[] = ['booting', 'signedOut', 'preview'];
    const complete = (mode: UnrecoveredMode, waitTimedOut: boolean) => (
      resolveAuthCallbackView({ hasCode: true, exchange: 'complete', mode, waitTimedOut })
    );
    expect(complete('signedOut', false)).toEqual({ kind: 'recovery', reason: 'sessionRejected', actions: ['returnToSignIn'] });
    expect(complete('preview', false)).toEqual({ kind: 'recovery', reason: 'previewActive', actions: ['returnToDemo', 'leaveDemoAndSignIn'] });
    // `booting` is the live session still being established: a bounded wait,
    // then a recovery state. It is never an unbounded spinner.
    expect(complete('booting', false)).toEqual({ kind: 'waiting', phase: 'finishing' });
    expect(complete('booting', true)).toEqual({ kind: 'recovery', reason: 'sessionStalled', actions: ['keepWaiting', 'returnToSignIn'] });
    for (const mode of unrecoveredModes) {
      expect(complete(mode, true).kind).toBe('recovery');
    }

    // In the demo a plain return to sign-in lands back in the demo, so every
    // recovery there offers the demo or leaving it (not only previewActive).
    expect(resolveAuthCallbackView({ hasCode: true, exchange: 'failed', mode: 'preview', waitTimedOut: false }))
      .toEqual({ kind: 'recovery', reason: 'exchangeFailed', actions: ['returnToDemo', 'leaveDemoAndSignIn'] });
    // The rule that makes that true: sign-in redirects the demo and a live
    // session Home, and a pending MFA session to its challenge.
    const signInSource = readFileSync(fileURLToPath(new URL('../../app/sign-in.tsx', import.meta.url)), 'utf8');
    expect(signInSource).toContain("if (mode === 'authenticated' || mode === 'preview') {");
    expect(signInSource).toContain("if (mode === 'mfaRequired') {");

    // The screen's behaviour is unit-tested through the pure reducer and render
    // model in authCallbackRecovery.test.ts. What is left for the screen is to
    // draw that model and run its effects, pinned here: state only moves
    // through the reducer, the budget timer is keyed on the model's wait key,
    // and every destination comes from the model, never a literal route.
    expect(authCallbackSource).toContain('const [state, dispatch] = useReducer(authCallbackReduce, AUTH_CALLBACK_INITIAL_STATE);');
    expect(authCallbackSource).toMatch(/const model = authCallbackScreenModel\(\{\s*hasCode: Boolean\(code\),\s*(?:\/\/[^\n]*\n\s*)*linkRejected: Boolean\(params\.error \|\| params\.error_code\),\s*state,\s*mode,\s*language: /);
    expect(authCallbackSource).toContain('const waitKey = model.waitKey;');
    expect(authCallbackSource).toMatch(/if \(waitKey === null\) return undefined;\s*const timer = setTimeout\(\(\) => dispatch\(\{ type: 'budgetElapsed' \}\), AUTH_CALLBACK_WAIT_BUDGET_MS\);\s*return \(\) => clearTimeout\(timer\);\s*\}, \[waitKey\]\);/);
    expect(authCallbackSource).toContain("if (model.kind === 'redirect') return <Redirect href={model.href} />;");
    expect(authCallbackSource).toMatch(/if \(effect\.kind === 'dispatch'\) \{\s*dispatch\(effect\.event\);/);
    expect(authCallbackSource).toMatch(/else if \(effect\.kind === 'navigate'\) \{\s*router\.replace\(effect\.href\);/);
    expect(authCallbackSource).toMatch(/void signOut\(\)\.catch\(\(\) => undefined\)\.then\(\(\) => \{\s*setLeavingDemo\(false\);\s*router\.replace\(effect\.href\);/);
    expect(authCallbackSource).toContain('onPress={() => run(button)}');
    expect(authCallbackSource).not.toMatch(/['"`]\/(sign-in|mfa-challenge|\(tabs\)|auth)/);
    expect(authCallbackSource).not.toMatch(/\b(href|replace|push|navigate)\s*[=(]\s*\{?\s*['"`]/);
    expect(authCallbackSource).not.toContain('useState<AuthCallback');
    expect(authCallbackSource).not.toContain('setWaitTimedOut');
    expect(authCallbackSource).not.toContain('complete && mode === ');
    // A failed PKCE exchange cannot be retried, so the screen has no retry path.
    expect(authCallbackSource).not.toMatch(/retryExchange|setAttempt|\battempt\b\s*[,)\]]/);
    expect(authCallbackRecoverySource).not.toContain("'retryExchange'");
    // The spinner exists only inside the bounded waiting branch.
    expect(authCallbackSource.match(/<ActivityIndicator/g)).toHaveLength(1);
    expect(authCallbackSource.indexOf('<ActivityIndicator')).toBeGreaterThan(authCallbackSource.indexOf("if (model.kind === 'waiting') {"));
    expect(authCallbackSource.indexOf('<ActivityIndicator')).toBeLessThan(authCallbackSource.indexOf('const run = '));
    // Recovery states reach the lifecycle channel as enumerated tokens only; the
    // exchange rejection handler above still takes no argument.
    expect(authCallbackSource).toContain("recordLifecycleEvent({ scope: 'auth-callback', step: diagnosticStep, outcome: diagnosticOutcome });");
    expect(authCallbackSource.match(/recordLifecycleEvent\(/g)).toHaveLength(1);
    // No handler binds or dereferences a thrown error (the zero-argument
    // rejection handler, `.message` and `catch (x` are pinned above).
    expect(authCallbackSource).not.toMatch(/\b(error|err)\b\s*(\)\s*=>|=>|\.\w)/i);
    // Screen-effect invariants: one exchange per code, a superseded code never
    // settles state, and recovery is recorded once per state rather than on
    // every render. Shared StateMessage owns its cross-platform announcement.
    expect(authCallbackSource).toContain('if (startedExchange.current === code) return;');
    expect(authCallbackSource).toContain("if (startedExchange.current === code) dispatch({ type: 'exchangeSettled', exchange });");
    expect(authCallbackSource).not.toContain('announceForAccessibility');
    expect(authCallbackSource).not.toContain('const announcement =');
    expect(authCallbackSource).toMatch(/outcome: diagnosticOutcome \}\);\s*\}, \[diagnosticStep, diagnosticOutcome\]\);/);
  });

  it('uses the existing MFA-gated RPC writers and restricts editable profile columns', () => {
    const sendBody = functionBody('sendMemberMessage', 'startMemberConversation');
    const startBody = functionBody('startMemberConversation', 'updateMemberProfile');
    const profileBody = source.slice(source.indexOf('export async function updateMemberProfile'));
    expect(sendBody).toContain("supabase.rpc('send_member_message'");
    expect(startBody).toContain("supabase.rpc('start_member_conversation'");
    expect(sendBody).not.toContain("from('member_messages').insert");
    expect(profileBody).toContain("supabase.rpc('update_my_member_profile'");
    expect(profileBody).toContain('p_fields: { first_name: firstName, full_name: fullName, initials, language: input.language }');
    expect(functionBody('updateMemberProfile', 'loadMemberNotificationPreferences')).not.toContain('.update(');
    expect(profileBody).not.toContain('role_line:');
    expect(profileBody).not.toContain('chapter_id:');
  });
});
