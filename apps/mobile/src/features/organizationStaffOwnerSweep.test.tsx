// @vitest-environment jsdom
// Part B of record 9254: extracted without changing assertions from businessOwnerSweep.test.tsx
// at e3e2edf61c6383a861124363beb7cdd770b5d3ad. Only Part B families retained; all selected cases keep their original assertions. Part A cases already shipped independently.
import { act, createElement, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestGeneration } from '../lib/requestGeneration';

const app = vi.hoisted(() => ({
  mode: 'authenticated', session: { user: { id: 'owner-a' }, access_token: 'fixture-a' },
  organizationID: 'org-a' as string | null, dashboard: { member: { chapterID: 'chapter-a' } } as { member: { chapterID: string } } | null,
  chapterMemberships: [{ chapterID: 'chapter-a', selected: true }], authorizedRoles: ['admin'],
  assuranceUnavailable: false, resumeDraftReads: { dashboard: true, memberships: true, staff: true },
}));
vi.mock('../state/AppProvider', () => ({ useApp: () => app }));
vi.mock('../services/supabase', () => ({ captureSessionWriter: () => ({ userId: app.session.user.id }) }));
import * as business from '../lib/useBusinessWriter';
import { useRequestGeneration } from '../lib/useRequestGeneration';
import { runInNewContext } from 'node:vm';
import { bindBusinessApi } from '../services/businessWriters';
import { createMemberSupportAdapter } from '../../../../src/features/memberSupport/adapter.js';
import { createHandshakeOperations } from './handshakeOperations';

type Control = { path: string; component: string; state: string; initial: string };
const controls: Control[] = [
{
    "path": "apps/mobile/src/features/MemberSupportScreen.tsx",
    "component": "MemberSupportScreen",
    "state": "busy",
    "initial": "false"
  },
{
    "path": "apps/mobile/src/features/StewardDeskSectionsScreen.tsx",
    "component": "RequestsSection",
    "state": "busyID",
    "initial": "null"
  },
{
    "path": "apps/mobile/src/features/StewardDeskSectionsScreen.tsx",
    "component": "FormsSection",
    "state": "busy",
    "initial": "null"
  },
{
    "path": "apps/mobile/src/features/FeatureScreen.tsx",
    "component": "LivePartnersFeature",
    "state": "busy",
    "initial": "null"
  },
{
    "path": "apps/mobile/src/features/FeatureScreen.tsx",
    "component": "LiveHealthFeature",
    "state": "busy",
    "initial": "false"
  },
{
    "path": "apps/mobile/src/features/mi1/OrganizationIntelligenceScreens.tsx",
    "component": "CollectiveActionsScreen",
    "state": "busy",
    "initial": "''"
  },
{
    "path": "apps/mobile/src/features/mi1/OperationsHealthScreen.tsx",
    "component": "OperationsHealthScreen",
    "state": "busyJobName",
    "initial": "null"
  }
];
const owners = [
['src/features/NotificationPreferencesCard.tsx', 'NotificationPreferencesCard'],
['src/features/NativeLearningPeriod.tsx', 'NativePracticeHistory'],
['src/features/NativeLearningPeriod.tsx', 'NativeLearningPeriodCard']
];
type Slot = [unknown, (value: unknown) => void];
function initializer(path: string, component: string, state: string): string {
  const relative = path.replace(/^apps\/mobile\//, '');
  const text = readFileSync(resolve(process.cwd(), relative), 'utf8');
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === component && node.body) {
      for (const statement of node.body.statements) if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          const name = declaration.name;
          if ((ts.isArrayBindingPattern(name) && name.elements[0]?.getText(file) === state)
            || (ts.isIdentifier(name) && name.text === state)) found = declaration.initializer;
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file); if (!found) throw new Error(`Missing production declaration: ${component}.${state}`);
  return ts.transpileModule(`const initialize = () => (${found.getText(file)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
}
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.assign(app, { mode: 'authenticated', organizationID: 'org-a', dashboard: { member: { chapterID: 'chapter-a' } },
    chapterMemberships: [{ chapterID: 'chapter-a', selected: true }], authorizedRoles: ['admin'], assuranceUnavailable: false,
    resumeDraftReads: { dashboard: true, memberships: true, staff: true } });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('pending operational state remains held for the composing person', () => {
  it.each(controls.filter(row => row.state !== 'acceptedWrite'))('$component.$state stays held across retirement until its own settlement', async row => {
    const code = initializer(row.path, row.component, row.state);
    const read = new Function('useBusinessState', 'useBusinessRequestState', 'requests', 'controls', `${code}\nreturn initialize();`) as
      (state: typeof business.useBusinessState, scoped: unknown, requests: RequestGeneration, controls: RequestGeneration) => Slot;
    let value: unknown; let set: Slot[1] = () => {};
    let requests: RequestGeneration;
    function Probe() {
      requests = business.useBusinessRequests({});
      [value, set] = read(business.useBusinessState, Reflect.get(business, 'useBusinessRequestState'), requests, requests);
      return createElement('button', { disabled: Boolean(value) }, 'Submit');
    }
    const render = async () => { await act(async () => root.render(createElement(Probe))); };
    const active = row.initial === 'false' ? true : 'request-in-flight';
    const idle = row.initial === 'false' ? false : row.initial === "''" ? '' : null;
    await render(); await act(async () => set(active)); const oldSet = set; const oldTicket = requests!.capture();
    const ready = { ...app };
    Object.assign(app, { mode: 'booting', organizationID: null, dashboard: null, chapterMemberships: [], authorizedRoles: [],
      resumeDraftReads: { dashboard: false, memberships: false, staff: false } });
    await render(); expect(oldTicket.isCurrent()).toBe(true); expect(value).toBe(active);
    Object.assign(app, ready); await render(); expect(value).toBe(active);
    app.chapterMemberships = [{ chapterID: 'chapter-b', selected: true }]; await render();
    expect(oldTicket.isCurrent()).toBe(false);
    expect(value, `${row.component}.${row.state} released an unfinished write`).toBe(active);
    expect(host.querySelector('button')?.disabled).toBe(true);
    await act(async () => oldSet(idle));
    expect(value, 'its own settled write must release the composing person').toBe(idle);
    expect(host.querySelector('button')?.disabled).toBe(false);
  });
});
