vi.mock('../state/AppProvider', () => ({ useApp: () => ({}) }));
vi.mock('../services/supabase', () => ({ captureSessionWriter: vi.fn() }));
import { BUSINESS_SAVED_STALE, checkBusinessContinuation } from '../lib/businessWriteContinuation';
import { businessHandlerContext } from '../testing/businessHandlerContext';
// Family 1 (finance/settings) of part B, record 9254: extracted without changing assertions from businessScopeContinuations.test.ts
// at e3e2edf61c6383a861124363beb7cdd770b5d3ad. Only Part B families retained; all selected cases keep their original assertions. Part A cases already shipped independently.
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { createRequestGeneration } from '../lib/requestGeneration';
import { createAccountSessionIdentity } from '../lib/accountSessionIdentity';
import { isAuthoritativeReadRefusal } from '../lib/readRefusal';
import { resumeDraftOwnerFacts, type ResumeDraftReads } from '../lib/resumeDraftOwnership';
import { noteResumeDraftReadFailure } from '../lib/resumeDraftHolder';

// Run the actual source callbacks with held transport replies. Scope retirement
// is the same request generation used by the mounted components; no duplicate
// implementation of their continuation rules is under test.
function callback(path: string, container: string, name: string, context: Record<string, unknown>) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const scope = tree.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === container);
  let expression = '';
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) expression = node.getText(tree);
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name && node.initializer) {
      expression = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0]!.getText(tree) : node.initializer.getText(tree);
    }
    ts.forEachChild(node, visit);
  }
  if (!scope) throw new Error(container);
  visit(scope);
  if (!expression) throw new Error(name);
  return runInNewContext(ts.transpile(`(${expression})`, { target: ts.ScriptTarget.ES2022 }), businessHandlerContext({ reads: { current: 0 }, profileSaveOwnership: { current: { owner: { scope: 'scope-a' }, available: true } }, checkBusinessContinuation, noteResumeDraftReadFailure, requests: createRequestGeneration(), ...context }, container)) as (...args: unknown[]) => Promise<unknown>;
}
function deferred() {
  let resolve!: (value?: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('confirmed census continuation families', () => {
  it.each(['name','language'])('keeps accepted %s through a real membership transport invalidation without restoring the concealed dashboard',async field=>{
    const held=deferred(), membershipScopeChanged={current:0};
    let reads:ResumeDraftReads={dashboard:true,memberships:true,staff:true};
    const context=()=>({mode:'authenticated',session:{user:{id:'A'}},organizationID:'org',dashboard:{member:{chapterID:'chapter-a'}},chapterMemberships:[{chapterID:'chapter-a',selected:true}],resumeDraftReads:reads});
    const profileSaveOwnership={current:{owner:resumeDraftOwnerFacts(context(),null),available:true}};
    const setDashboard=vi.fn(),language=vi.fn();
    const ports={mode:'authenticated',dashboard:{member:{id:'A'}},session:{user:{id:'A'}},providerMounted:{current:true},membershipScopeChanged,
      currentReadChapter:()=> 'chapter-a',captureAccountSessionGuard:()=>()=>true,profileSaveOwnership,
      updateMemberProfile:()=>held.promise,setDashboard,setMemberLanguage:language,haptics:{success:vi.fn()},sampleHat:null,
      isAuthoritativeReadRefusal,settledMembershipAt:{current:0},retireRefusedResumeDraftScope:vi.fn(),
      setResumeDraftReads:(update:(value:ResumeDraftReads)=>ResumeDraftReads)=>{reads=update(reads);const facts=resumeDraftOwnerFacts(context(),profileSaveOwnership.current.owner);profileSaveOwnership.current={owner:facts.checkingSamePerson&&!facts.knownScopeChange?profileSaveOwnership.current.owner:facts,available:!facts.checking};},
    };
    const pending=callback('../state/AppProvider.tsx','AppProvider','saveProfile',ports)(field==='name'?{fullName:'Saved name'}:{language:'es'});
    await callback('../state/AppProvider.tsx','AppProvider','invalidateResumeDraftRead',ports)('A','memberships',new TypeError('Transport unavailable'),'chapter-a',2);
    expect(membershipScopeChanged.current).toBe(2);expect(profileSaveOwnership.current.available).toBe(false);
    held.resolve({id:'A',fullName:'Saved name',language:'es'});
    expect(await pending).toBe('unavailable');expect(language).toHaveBeenCalledWith('es');expect(setDashboard).not.toHaveBeenCalled();
  });
  it.each(['unavailable','changed'])('profile editor reports accepted %s instead of closing as ordinary success',async proof=>{
    const close=vi.fn(),notice=vi.fn();
    await callback('../../app/(tabs)/account.tsx','AccountScreenContent','submitProfile',{
      profileBusy:false,languageBusy:false,dashboard:{member:{language:'en'}},memberLanguage:'en',session:{user:{id:'A'}},firstName:'Saved',fullName:'Saved Name',
      captureAccountSessionGuard:()=>()=>true,saveProfile:async()=>proof,setProfileBusy:vi.fn(),setProfileError:notice,setEditingProfile:close,t:(s:string)=>s,BUSINESS_SAVED_STALE,
    })();
    expect(close).not.toHaveBeenCalled();expect(notice).toHaveBeenCalledWith(BUSINESS_SAVED_STALE);
  });
  it.each(['name', 'language'])('profile %s keeps a same-login refresh and rejects replacement or workspace change using real guards', async field => {
    for (const transition of ['refresh','replacement','workspace','unmount']) {
      const held = deferred();
      const sessionTransition = { current: 1 }, activeUserID = { current: 'A' }, providerMounted = { current: true }, membershipScopeChanged = { current: 0 };
      let chapter = 'chapter-a';
      const token = (signature: string) => `fixture.${Buffer.from(JSON.stringify({ session_id: '00000000-0000-4000-8000-000000000001' })).toString('base64url')}.${signature}`;
      const observedAuthIdentity = createAccountSessionIdentity();
      observedAuthIdentity.current = { userID: 'A', accessToken: token('original'), refreshToken: 'fixture-refresh' };
      const ports: Record<string, unknown> = { sessionTransition, activeUserID, providerMounted, membershipScopeChanged, observedAuthIdentity, currentReadChapter: () => chapter };
      // Extract both actual provider guards; no mocked always-current guard.
      ports.captureAuthenticatedSessionGuard = callback('../state/AppProvider.tsx','AppProvider','captureAuthenticatedSessionGuard',ports);
      ports.captureAccountSessionGuard = callback('../state/AppProvider.tsx','AppProvider','captureAccountSessionGuard',ports);
      const setDashboard = vi.fn(), setMemberLanguage = vi.fn(), success = vi.fn();
      const save = callback('../state/AppProvider.tsx','AppProvider','saveProfile',{
        ...ports, dashboard: { member: { id: 'A' } }, session: { user: { id: 'A' } }, sampleHat: null, updateMemberProfile: () => held.promise,
        setDashboard, setMemberLanguage, haptics: { success },
      });
      const pending = save(field === 'name' ? { fullName: 'Saved name' } : { language: 'es' });
      sessionTransition.current += 1;
      if (transition === 'refresh') observedAuthIdentity.current = { userID: 'A', accessToken: token('renewed'), refreshToken: 'fixture-renewed' };
      if (transition === 'replacement') { activeUserID.current = 'B'; observedAuthIdentity.current = { userID: 'B', accessToken: token('replacement'), refreshToken: 'fixture-replacement' }; }
      if (transition === 'workspace') { chapter = 'chapter-b'; membershipScopeChanged.current += 1; }
      if (transition === 'unmount') providerMounted.current = false;
      const member = { id: 'A', fullName: 'Saved name', language: 'es' };
      held.resolve(member); await pending;
      expect(setDashboard).toHaveBeenCalledTimes(transition === 'refresh' ? 1 : 0);
      expect(setMemberLanguage).toHaveBeenCalledTimes(transition === 'refresh' ? 1 : 0);
      expect(success).toHaveBeenCalledTimes(transition === 'refresh' ? 1 : 0);
      if (transition === 'refresh') {
        expect(setDashboard.mock.calls[0]![0]({ member: { id: 'A' } }).member).toBe(member);
        activeUserID.current = 'B';
        const replacement = { member: { id: 'B' } };
        expect(setDashboard.mock.calls[0]![0](replacement)).toBe(replacement);
      }
    }
  });
  it.each([false, true])('preferences keep the composing scope, retired=%s', async (retired) => {
    const held = deferred(); const requests = createRequestGeneration();
    const saved = { topics: {}, engagementEmail: {}, dndEnabled: false };
    const setSaved = vi.fn(); const finish = vi.fn(); const notice = vi.fn();
    const save = callback('./NotificationPreferencesCard.tsx', 'NotificationPreferencesCard', 'save', {
      requests, userID: 'A', saved, writer: { userId: 'A', check: async () => 'current' }, mode: 'authenticated', authorizedRoles: ['admin'], chosenStaffRole: 'admin',
      setDraft: vi.fn(), setSaving: vi.fn(), setSaved, setNotice: notice,
      copy: { saved: 'Saved', saveError: 'Failed' }, saveMemberNotificationPreferences: () => held.promise,
      liveStaffGuideHat: () => 'admin', finishStaffGuide: finish,
    });
    const pending = save({}, saved); if (retired) requests.dispose();
    held.resolve({ ...saved, dndEnabled: true }); await pending;
    expect(setSaved).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledTimes(retired ? 0 : 1);
    if (!retired) expect(finish.mock.calls[0]?.[0]).toMatchObject({ userId: 'A' });
  });

  it.each([false, true])('profile feedback and deferred updater stay with A, retired=%s', async (retired) => {
    const held = deferred(); let current = true; const setDashboard = vi.fn(); const language = vi.fn(); const success = vi.fn();
    const save = callback('../state/AppProvider.tsx', 'AppProvider', 'saveProfile', {
      dashboard: { member: { id: 'A' } }, session: { user: { id: 'A' } }, captureAccountSessionGuard: () => () => current,
      providerMounted: { current: true }, membershipScopeChanged: { current: 0 }, currentReadChapter: () => 'chapter-a',
      updateMemberProfile: () => held.promise, setDashboard, setMemberLanguage: language, haptics: { success }, sampleHat: null,
    });
    const pending = save({ language: 'es' }); if (retired) current = false;
    held.resolve({ id: 'A', language: 'es' }); await pending;
    expect(language).toHaveBeenCalledTimes(retired ? 0 : 1); expect(success).toHaveBeenCalledTimes(retired ? 0 : 1);
    if (!retired) {
      current = false;
      const replacement = { member: { id: 'B' } };
      expect(setDashboard.mock.calls[0]![0](replacement)).toBe(replacement);
    }
  });

  it.each(['start', 'endEarly', 'undo'])('learning %s suppresses accepted and failed retired replies', async (name) => {
    for (const refused of [false, true]) {
      const held = deferred(); const requests = createRequestGeneration(); const message = vi.fn(); const refresh = vi.fn(); const announce = vi.fn();
      const action = callback('./NativeLearningPeriod.tsx', name === 'undo' ? 'NativePracticeHistory' : 'NativeLearningPeriodCard', name, {
        requests, writer: { check: async () => 'current' }, api: { start: () => held.promise, endEarly: () => held.promise, undo: () => held.promise }, length: 14,
        entries: [], undoChain: () => [], setBusy: vi.fn(), setFailed: message, setMessage: message, setConfirmEnd: vi.fn(),
        setRefusals: vi.fn(), setConfirmId: vi.fn(), announceLearningUndone: announce, undoRefusalReason: () => 'failed',
        t: (key: string) => key, formatPeriodWhen: () => 'Friday', organizationControlFailure: () => 'failed',
        refresh, load: refresh, onChanged: refresh,
      });
      const pending = action({ id: 'entry', version: 1, actionKind: 'task_edit' }); requests.dispose();
      if (refused) held.reject(new Error('refused')); else held.resolve({ endAt: '2030-01-01', status: 'undone', undoneCount: 1 });
      await pending;
      if (refused || name === 'undo' && refused) expect(message.mock.calls.every(([value]) => value === '')).toBe(true);
      else expect(message.mock.calls.some(([value]) => typeof value === 'string' && value !== '')).toBe(true);
      expect(refresh).not.toHaveBeenCalled(); expect(announce).not.toHaveBeenCalled();
    }
  });
});
