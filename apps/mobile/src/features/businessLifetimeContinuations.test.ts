import { businessHandlerContext } from '../testing/businessHandlerContext';
// @vitest-environment jsdom
// Family 1 (finance/settings) of part B, record 9254: extracted without changing assertions from businessLifetimeContinuations.test.ts
// at e3e2edf61c6383a861124363beb7cdd770b5d3ad. Only Part B families retained; all selected cases keep their original assertions. Part A cases already shipped independently.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { BUSINESS_SAVED_STALE, checkBusinessContinuation, settleBusinessWrite } from '../lib/businessWriteContinuation';
import { createRequestGeneration } from '../lib/requestGeneration';
import { useBusinessRequests, useBusinessState, useBusinessOperation } from '../lib/useBusinessWriter';
import { useBusinessDraftState } from '../lib/useBusinessDraftState';
import type { RequestGeneration } from '../lib/requestGeneration';

const projection = vi.hoisted(() => ({ phase: 'ready', grant: false }));
vi.mock('../state/AppProvider', () => ({ useApp: () => {
  const ready = projection.phase === 'ready';
  return { mode: projection.phase === 'booting' ? 'booting' : projection.phase === 'mfa' ? 'mfaRequired' : 'authenticated',
    session: { user: { id: 'actor' }, access_token: 'fixture-token' }, organizationID: ready ? 'org' : null,
    dashboard: ready ? { member: { chapterID: 'chapter' } } : null, chapterMemberships: ready ? [{ chapterID: 'chapter', selected: true }] : [],
    authorizedRoles: ready ? projection.grant ? ['admin', 'coordinator'] : ['admin'] : [], assuranceUnavailable: projection.phase === 'mfa',
    resumeDraftReads: { dashboard: ready, memberships: ready, staff: ready } };
} }));
vi.mock('../services/supabase', () => ({ captureSessionWriter: () => ({ userId: 'actor' }) }));

// Execute each production caller, including its real awaits, with Auth held
// across a scope retirement. Owner-bucket setters are deliberately independent
// from the shared reads, parent callbacks, announcements and navigation below.
function callback(path: string, component: string, name: string, context: Record<string, unknown>) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8');
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const scope = tree.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === component);
  let expression = '';
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) expression = node.getText(tree);
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name && node.initializer) {
      expression = ts.isCallExpression(node.initializer) ? node.initializer.arguments[0]!.getText(tree) : node.initializer.getText(tree);
    }
    ts.forEachChild(node, visit);
  }
  if (!scope) throw new Error(component);
  visit(scope);
  if (!expression) throw new Error(name);
  return runInNewContext(ts.transpile(`(${expression})`, { target: ts.ScriptTarget.ES2022 }), businessHandlerContext({
    BUSINESS_SAVED_STALE, checkBusinessContinuation, settleBusinessWrite, ...context,
  }, component)) as (...args: unknown[]) => Promise<unknown>;
}

type Case = [path: string, component: string, name: string, args: unknown[], context?: Record<string, unknown>];
const success = async () => ({ ok: true, value: { id: 'saved' } });
const cases: Case[] = [
['./mi1/PayToolsScreen.tsx', 'CatalogPublisherCard', 'publish', ['grade', success]],
['./NativeUnitSettings.tsx', 'WorkloadEntry', 'save', [], {
    fields: [], definition: { statuses: ['open'] }, status: 'open', form: { version: 1 }, canonicalWorkloadValues: () => ({}),
    workloadValueProblems: () => ({ form: null, fields: [] }), write: async () => {}, blank: () => ({}), onBusy: vi.fn(), queueAccessibilityAnnouncement: vi.fn(),
    // #9240 pull request D: the entry waits on the shared draft hook.
    draft: { shown: true, pending: false, stale: false, value: { unit: null, values: {}, status: 'open' }, begin: () => ({ value: { unit: null, values: {}, status: 'open' }, key: 'attempt', settle: () => true }) },
    withReadDeadline: <T,>(request: Promise<T>) => request, workloadOutcomeUnknown: () => false, WORKLOAD_RELOAD: 'Reload',
  }]
];

describe('stage 422 complete caller lifetime class', () => {
  it.each(cases)('%s %s.%s fences a late current Auth answer', async (path, component, name, args, extra = {}) => {
    for (const transition of ['live', 'retired', 'booting', 'refresh', 'mfa']) {
      const retired = transition === 'retired';
      let requests: RequestGeneration = createRequestGeneration();
      const host = document.createElement('div');
      const root = createRoot(host);
      Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
      function Probe() { requests = useBusinessRequests({}, 'subject'); return null; }
      const resume = transition !== 'live' && !retired;
      projection.phase = 'ready';
      if (resume) await act(async () => { root.render(createElement(Probe)); });
      try {
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const entered = vi.fn(); const shared = vi.fn(async () => ({}));
      const writer = { check: async () => { entered(); await held; return 'current'; }, isCurrent: async () => { entered(); await held; return true; } };
      const setters = Object.fromEntries(('setBusy setOutcome setLocked setOpen setNotice setAcceptedSubmit setErrors setAccepted setFailure setMessageId setForm setTitle setDescription setAmount setDueOn setScopeKind setChapterId setPreview setError setChoiceLocked setPendingOperation setFeedback setProviderStatus setConfirmDisconnectActorKey setConfirming setPurpose setDataScope setComposing setSending setCategory setDetails setBusyID setActionError setOpenID setNote setBusyJobName setNoticeVersion setErrorVersion setAcceptedWrite setValues setStatus setMessage setProblems setRefusal setModel setTask setAssigneeId setDue').split(' ').map((key): [string, Mock<(value: unknown) => void>] => [key, vi.fn<(value: unknown) => void>()]));
      const currentScope = { current: 'task|actor' }; const alive = { current: true };
      const run = callback(path, component, name, {
        ...setters, unconfirmedWrite: false, setUnconfirmedWrite: vi.fn(), providerControl: { current: false }, acceptedOperations: new Set(), setAcceptedOperations: vi.fn(), request: { current: 0 }, setPage: vi.fn(), requests, writer, mounted: { current: true }, t: (text: string) => text, errorCopy: () => 'failed',
        haptics: { success: vi.fn(), warning: vi.fn() }, onSaved: shared, onBooked: shared, onChanged: shared, onUpdated: shared,
        onCompleteAttempt: shared, onClose: shared, setReload: shared, refresh: shared, retry: shared, onPublished: shared,
        queueAnnouncement: shared, announce: shared, load: shared, reread: shared, queue: { refreshThrough: shared, reread: shared }, loadWorkspace: shared, publishNotice: vi.fn(), ...extra,
        currentScope, alive,
        ...('booking' in extra ? { booking: { current: false } } : {}), ...('saving' in extra ? { saving: { current: false } } : {}),
      });
      const pending = run(...args);
      for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
      expect(entered, `${component}.${name} must reach the real proof await`).toHaveBeenCalled();
      if (resume) {
        const ticket = requests.capture();
        projection.phase = transition;
        await act(async () => { root.render(createElement(Probe)); });
        expect(ticket.isCurrent(), `${component}.${name} retired during ${transition}`).toBe(true);
        if (component === 'ConnectedTaskEditor') {
          currentScope.current = 'task|signed-out';
          release(); await pending;
        }
        projection.phase = 'ready';
        await act(async () => { root.render(createElement(Probe)); });
        expect(ticket.isCurrent()).toBe(true);
      }
      if (retired) { requests.dispose(); alive.current = false; }
      release(); const result = await pending;
      if (retired) expect(shared, `${component}.${name} completed into a retired scope`).not.toHaveBeenCalled();
      else expect(shared, `${component}.${name} lost a live completion`).toHaveBeenCalled();
      if (component === 'MemberSupportScreen') expect(result).toBe(!retired);
      if (!retired) {
        const controls: Record<string, [string, unknown]> = {
          ConnectedTaskEditor: ['setBusy', false], AppointmentBookingCard: ['setBusy', false], CampaignDraftCard: ['setBusy', false], LiveSurveyCard: ['setBusy', null],
          AddressForm: ['setBusy', false], BillTracker: ['setBusy', false], Composer: ['setBusy', null],
          AssessmentCard: ['setBusy', false], StaffActionCard: ['setBusy', false], NativeProviderSetup: ['setPendingOperation', null],
          LivePartnersFeature: ['setBusy', null], LiveHealthFeature: ['setBusy', false], LiveCampaignsScreen: ['setBusy', null],
          LiveBeHeardScreen: ['setSending', false], RequestsSection: ['setBusyID', null], FormsSection: ['setBusy', null],
          CatalogPublisherCard: ['setBusy', null], CollectiveActionsScreen: ['setBusy', ''], OperationsHealthScreen: ['setBusyJobName', null],
          MemberQaScreen: ['setBusy', false], MemberSupportScreen: ['setBusy', false], WorkloadEntry: ['setBusy', false],
        };
        const [key, expected] = controls[component]!;
        const terminal = setters[key]!.mock.calls.at(-1)?.[0];
        const value = typeof terminal === 'function' ? (terminal as (previous: unknown) => unknown)(component === 'CollectiveActionsScreen' ? args[0] : { actorKey: 'actor', value: 'disconnect' }) : terminal;
        expect(value, `${component}.${name} did not release its control after ${transition}`).toBe(expected);
      }
      } finally { await act(async () => { root.unmount(); }); host.remove(); }
    }
  });
});

describe.each(['ios', 'android'])('part B complete operation on %s', platform => {
  for (const [path, component, name, args, extra = {}] of cases) {
    for (const boundary of ['proof', 'follow-up'] as const) {
      it(component + '.' + name + ' holds through ' + boundary + ' across a same-person grant refresh', async () => {
        projection.phase = 'ready'; projection.grant = false;
        const host = document.createElement('div'); const root = createRoot(host);
        Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
        let release = () => {}; const held = new Promise<void>(resolve => { release = resolve; });
        const entered = vi.fn(); const dispatch = vi.fn();
        const setters = Object.fromEntries('setBusy setSending setBusyID setBusyJobName setPendingOperation setError setOutcome setLocked setOpen setNotice setAcceptedSubmit setTitle setBody setDescription setAmount setDueOn setScopeKind setChapterId setPreview setAccepted setActiveAttempt setChoiceLocked setFeedback setProviderStatus setConfirmDisconnectActorKey setConfirming setPurpose setDataScope setComposing setCategory setDetails setActionError setOpenID setNote setNoticeVersion setErrorVersion setAcceptedWrite setValues setStatus setMessage setProblems setRefusal setModel setTask setAssigneeId setDue setPage setAcceptedOperations'.split(' ').map(key => [key, vi.fn()]));
        const proof = async () => { if (boundary === 'proof') { entered(); await held; } return 'current' as const; };
        const follow = async () => { if (boundary === 'follow-up') { entered(); await held; } return true; };
        const stringIdle = component === 'CollectiveActionsScreen';
        const nullIdle = ['LiveSurveyCard','LivePartnersFeature','LiveCampaignsScreen','RequestsSection','FormsSection','CatalogPublisherCard','OperationsHealthScreen'].includes(component);
        const idle = stringIdle ? '' : nullIdle ? null : false;
        let run: (...args: unknown[]) => Promise<unknown> = async () => {};
        let pending: Promise<unknown> = Promise.resolve();
        function Probe() {
          const [busy, setBusy] = useBusinessState<unknown>(idle);
          const [operate] = useBusinessOperation<unknown>(setBusy, idle);
          const [control] = useBusinessState(() => ({ current: false }));
          const requests = useBusinessRequests({}, 'same-subject');
          const acceptedOperations = new Set<string>();
          const ports: Record<string, unknown> = {
            ...setters, ...extra, unconfirmedWrite: false, setUnconfirmedWrite: vi.fn(), busy, requests, operate, control, providerControl: control,
            acceptedOperations, acceptedActions: new Set(), setAcceptedActions: vi.fn(), request: { current: 0 }, mounted: { current: true },
            writer: { check: proof, isCurrent: async () => (await proof()) === 'current' },
            t: (value: string) => value, errorCopy: () => 'Failed', haptics: { success: vi.fn(), warning: vi.fn() },
            onSaved: follow, onBooked: follow, onChanged: follow, onUpdated: follow, onCompleteAttempt: vi.fn(), onClose: vi.fn(),
            setReload: follow, refresh: follow, reread: follow, retry: follow, onPublished: follow,
            queueAnnouncement: vi.fn(), announce: vi.fn(), load: follow, loadWorkspace: follow,
            publishNotice: vi.fn(), queue: { refreshThrough: follow, reread: follow },
          };
          for (const key of ['setBusy','setSending','setBusyID','setBusyJobName','setPendingOperation']) ports[key] = setBusy;
          // Count actual writes; the adapters keep their production-family input
          // construction and return shape from the existing continuation matrix.
          for (const [key, value] of Object.entries(extra)) {
            if (typeof value === 'function' && /^(saveMobile|saveTaskEdits|bookMobile|sendBeHeard|requestMobile|changeCampaign|recordMobile|addMobile|triage|reviewSteward|acknowledgeMobile)/.test(key)) {
              ports[key] = async (...values: unknown[]) => { dispatch(); return (value as (...args: unknown[]) => Promise<unknown>)(...values); };
            }
          }
          for (const key of ['adapter','handshakes']) if (extra[key]) ports[key] = Object.fromEntries(Object.entries(extra[key] as Record<string, unknown>).map(([method, value]) => [method, typeof value === 'function' ? async (...values: unknown[]) => { dispatch(); return (value as (...args: unknown[]) => Promise<unknown>)(...values); } : value]));
          run = callback(path, component, name, ports);
          return createElement('button', { disabled: Boolean(busy), 'data-platform': platform }, 'Submit');
        }
        try {
          await act(async () => { root.render(createElement(Probe)); });
          await act(async () => { pending = run(...args); await Promise.resolve(); });
          // Some callbacks await an intermediate check before reaching their
          // follow-up; drain microtasks, never the held fixture.
          await act(async () => { for (let turn = 0; turn < 20; turn += 1) await Promise.resolve(); });
          expect(entered, component + '.' + name + ' reaches ' + boundary).toHaveBeenCalled();
          expect(host.querySelector('button')!.disabled).toBe(true);
          const before = dispatch.mock.calls.length;
          projection.grant = true;
          await act(async () => { root.render(createElement(Probe)); });
          expect(host.querySelector('button')!.disabled).toBe(true);
          await act(async () => { await run(...args); });
          expect(dispatch).toHaveBeenCalledTimes(before);
          await act(async () => { release(); await pending; });
          expect(host.querySelector('button')!.disabled).toBe(false);
        } finally {
          release(); await act(async () => { await pending; root.unmount(); }); host.remove(); projection.grant = false;
        }
      });
    }
  }
});
