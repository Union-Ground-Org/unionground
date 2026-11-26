// @vitest-environment jsdom
import { stubSessionWriter } from '../testing/stubSessionWriter';
// BUG-UG-NATIVE-COORDINATOR-ROLE-SHOWS-NO-CASE-QUEUE-20261118 (,
// part 2): an organization-wide Grievance Coordinator opens a case from the
// phone's Case queue and assigns or changes its steward, through the
// website's reads and write: the server's candidate list, assign_member_case
// with the coordinator left unchanged, then onSaved, which hands the case
// screen its updated_case access-history entry (caseAccessHistory.screen.test).
// The backend is a stand-in that keeps the case row and records calls.
import { readFileSync } from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => {
  const state = {
    row: { id: 'case-4', user_id: 'member-9', organization_id: 'org-harrow', steward_user_id: 'steward-a' } as Record<string, unknown>,
    candidates: [
      { userId: 'steward-a', fullName: 'Avery Lind', roles: ['steward'] },
      { userId: 'steward-b', fullName: 'Bo Okafor', roles: ['coordinator', 'steward'] },
      { userId: 'coordinator-c', fullName: 'Cam Reyes', roles: ['coordinator'] },
    ] as unknown,
    rpcCalls: [] as [string, Record<string, unknown>][],
    assignError: null as null | { code: string; message: string },
    loadError: null as null | { message: string },
    candidateError: null as null | { code: string; message: string },
  };
  const backend = {
    from: (table: string) => {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => (table === 'member_cases' && !state.loadError ? { data: { ...state.row }, error: null } : { data: null, error: state.loadError ?? { message: 'unexpected table' } }),
      };
      return query;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.rpcCalls.push([name, args]);
      if (name === 'list_member_case_assignment_candidates') return state.candidateError ? { data: null, error: state.candidateError } : state.loadError ? { data: null, error: state.loadError } : { data: state.candidates, error: null };
      if (name === 'assign_member_case') {
        if (state.assignError) return { data: null, error: state.assignError };
        if (args.p_steward !== '00000000-0000-0000-0000-000000000000') state.row.steward_user_id = args.p_steward;
        return { data: null, error: null };
      }
      return { data: null, error: { message: 'unexpected rpc' } };
    },
  };
  return { state, backend };
});
const language = vi.hoisted(() => ({ member: 'en', check: vi.fn<() => Promise<'current' | 'unavailable' | 'changed'>>() }));

vi.mock('../services/supabase', async () => {
  const fixture = await (() => ({ getSupabaseClient: () => db.backend }))();
  return { ...fixture, captureSessionWriter: () => ({ ...stubSessionWriter(() => fixture.getSupabaseClient()), check: language.check }) };
});
vi.mock('../state/AppProvider', () => ({ useApp: () => ({ memberLanguage: language.member, dashboard: { member: { language: language.member } } }) }));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => ({ destructive: '#a00' }) }));
vi.mock('../lib/announce', () => ({ queueAccessibilityAnnouncement: vi.fn() }));
vi.mock('../components/ui', () => ({
  Body: ({ children, accessibilityRole }: { children?: ReactNode; accessibilityRole?: string }) => createElement('p', { role: accessibilityRole }, children),
  Heading: ({ children }: { children?: ReactNode }) => createElement('h2', null, children),
  Card: ({ children }: { children?: ReactNode }) => createElement('section', null, children),
  Button: ({ label, onPress, disabled, busy, selected }: { label: string; onPress: () => void; disabled?: boolean; busy?: boolean; selected?: boolean }) => createElement('button', { onClick: onPress, disabled: disabled || busy, 'aria-pressed': selected }, label),
}));

import { CaseStewardAssignment } from './CaseStewardAssignment';
import { queueAccessibilityAnnouncement } from '../lib/announce';

let root: Root; let host: HTMLDivElement; let onSaved = vi.fn();
const settle = async () => { for (let round = 0; round < 4; round += 1) await act(async () => { await Promise.resolve(); }); };
const button = (label: string) => [...host.querySelectorAll('button')].find((node) => node.textContent === label);
const click = async (label: string) => { const node = button(label); expect(node, label).toBeTruthy(); await act(async () => { node!.click(); }); await settle(); };
const mount = async () => {
  await act(async () => { root.render(createElement(CaseStewardAssignment, { caseID: 'case-4', onSaved })); });
  await settle();
};

beforeEach(() => {
  language.check.mockReset().mockResolvedValue('current');
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  db.state.row = { id: 'case-4', user_id: 'member-9', organization_id: 'org-harrow', steward_user_id: 'steward-a' };
  db.state.rpcCalls = []; db.state.assignError = null; db.state.loadError = null; db.state.candidateError = null; language.member = 'en'; onSaved = vi.fn();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); });

describe('a campaign lead assigns or changes an issue committee member on the phone (#9098 part 2)', () => {
  it.each(['en', 'es'])('keeps accepted staff writes stale through unavailable then changed proof without follow-ups in %s', async (locale) => {
    language.member = locale;
    const spanish = locale === 'es';
    await mount();
    vi.mocked(queueAccessibilityAnnouncement).mockClear();
    language.check.mockResolvedValueOnce('unavailable').mockResolvedValueOnce('changed');
    for (const person of ['Bo Okafor', spanish ? 'Sin asignar' : 'Unassigned']) {
      await click(person);
      await click(spanish ? 'Confirmo que esta asignación es correcta para este asunto.' : 'I confirm this assignment is correct for this issue.');
      await click(spanish ? 'Guardar asignación' : 'Save assignment');
      expect(host.textContent).toContain(spanish ? 'La asignación se guardó. Actualice para verla.' : 'Assignment saved. Refresh to see it.');
      expect(host.textContent).toContain((spanish ? 'Comité asignado: ' : 'Assigned committee member: ') + person);
      expect(button(spanish ? 'Actualizar el asunto' : 'Refresh the issue')).toBeTruthy();
      expect(onSaved).not.toHaveBeenCalled(); expect(queueAccessibilityAnnouncement).not.toHaveBeenCalled();
      expect(db.state.rpcCalls.filter(([name]) => name === 'list_member_case_assignment_candidates')).toHaveLength(1);
    }
    expect(db.state.rpcCalls.filter(([name]) => name === 'assign_member_case')).toHaveLength(2);
    expect(language.check).toHaveBeenCalledTimes(2);
  });
  it('retires an old issue acknowledgement before its receipt, draft reset and feedback', async () => {
    await mount(); await click('Bo Okafor'); await click('I confirm this assignment is correct for this issue.');
    let release!: (value: { data: null; error: null }) => void;
    const write = vi.spyOn(db.backend, 'rpc').mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    await click('Save assignment');
    const nextSaved = vi.fn();
    db.state.row.id = 'case-5';
    await act(async () => { root.render(createElement(CaseStewardAssignment, { caseID: 'case-5', onSaved: nextSaved })); });
    await settle();
    expect(button('Bo Okafor')?.disabled).toBe(true);
    await act(async () => { release({ data: null, error: null }); }); await settle();
    expect(onSaved).not.toHaveBeenCalled(); expect(nextSaved).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('Assignment saved.');
    await click('Bo Okafor'); await click('I confirm this assignment is correct for this issue.');
    expect(button('Save assignment')?.disabled).toBe(false);
    await click('Save assignment'); expect(nextSaved).toHaveBeenCalledOnce();
    write.mockRestore();
  });
  it('lists only eligible committee members, needs a confirmation, and changes the committee member through assign_member_case', async () => {
    await mount();
    expect(db.state.rpcCalls[0]).toEqual(['list_member_case_assignment_candidates', { p_case_id: 'case-4' }]);
    expect(host.textContent).toContain('Assigned committee member: Avery Lind');
    expect(button('Cam Reyes')).toBeUndefined();
    expect(button('Save assignment')?.disabled).toBe(true);
    await click('Bo Okafor');
    expect(button('Save assignment')?.disabled).toBe(true);
    await click('I confirm this assignment is correct for this issue.');
    await click('Save assignment');
    expect(db.state.rpcCalls).toContainEqual(['assign_member_case', { p_case_id: 'case-4', p_steward: 'steward-b', p_coordinator: '00000000-0000-0000-0000-000000000000' }]);
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('Assignment saved.');
    expect(host.textContent).toContain('Assigned committee member: Bo Okafor');
    expect(button('Save assignment')?.disabled).toBe(true);
  });

  it('clears the committee member with an explicit Unassigned choice', async () => {
    await mount();
    await click('Unassigned'); await click('I confirm this assignment is correct for this issue.'); await click('Save assignment');
    expect(db.state.rpcCalls).toContainEqual(['assign_member_case', { p_case_id: 'case-4', p_steward: null, p_coordinator: '00000000-0000-0000-0000-000000000000' }]);
    expect(host.textContent).toContain('Assigned committee member: Unassigned');
  });

  it('says when the server refuses a committee member outside the issue scope, and changes nothing', async () => {
    db.state.assignError = { code: '23514', message: 'committee member is outside issue scope or lacks role' };
    await mount();
    await click('Bo Okafor'); await click('I confirm this assignment is correct for this issue.'); await click('Save assignment');
    expect(host.textContent).toContain('That committee member is outside this issue’s scope or no longer holds the committee member role. Nothing was changed.');
    expect(onSaved).not.toHaveBeenCalled();
    expect(host.textContent).toContain('Assigned committee member: Avery Lind');
  });

  it('offers a retry when the eligible committee members cannot load', async () => {
    db.state.loadError = { message: 'campaign lead role and MFA required' };
    await mount();
    expect(host.textContent).toContain('Eligible assignees couldn’t be loaded.');
    db.state.loadError = null;
    await click('Try again');
    expect(host.textContent).toContain('Assigned committee member: Avery Lind');
  });

  it('speaks Spanish for a Spanish-language campaign lead', async () => {
    language.member = 'es';
    await mount();
    for (const text of ['Asignación del asunto', 'Comité asignado: Avery Lind', 'Elija el integrante del comité', 'Sin asignar', 'Guardar asignación']) expect(host.textContent).toContain(text);
  });

  it('is shown on the issue screen for the campaign lead hat only', () => {
    const screen = readFileSync(fileURLToPath(new NodeURL('../../app/issue/[id].tsx', import.meta.url)), 'utf8');
    expect(screen).toContain("{mode === 'authenticated' && coordinatorAccess && detail ? <CaseStewardAssignment caseID={item.id} onSaved={recordCaseUpdate} /> : null}");
    expect(screen).toContain("const coordinatorAccess = liveStaffHat === 'coordinator';");
  });

  // The server's refusal reason reaches the screen.
  it.each<['en' | 'es', string]>([
    ['en', 'Your role or two-step verification doesn’t allow this assignment right now. Nothing was changed.'],
    ['es', 'Su rol o la verificación en dos pasos no permiten esta asignación en este momento. No se cambió nada.'],
  ])('explains a 42501 refusal of the save in %s', async (lang, text) => {
    language.member = lang;
    db.state.assignError = { code: '42501', message: 'campaign lead role and MFA required' };
    await mount();
    await click('Bo Okafor');
    await click(lang === 'en' ? 'I confirm this assignment is correct for this issue.' : 'Confirmo que esta asignación es correcta para este asunto.');
    await click(lang === 'en' ? 'Save assignment' : 'Guardar asignación');
    expect(host.textContent).toContain(text);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('explains an issue that is no longer visible when saving', async () => {
    db.state.assignError = { code: 'P0002', message: 'issue not found' };
    await mount();
    await click('Bo Okafor'); await click('I confirm this assignment is correct for this issue.'); await click('Save assignment');
    expect(host.textContent).toContain('This issue is no longer available to you. Nothing was changed.');
  });

  it.each<[string, { code: string; message: string }, string]>([
    ['42501', { code: '42501', message: 'campaign lead role and MFA required' }, 'Your role or two-step verification doesn’t allow issue assignment right now. Work as Campaign lead with two-step verification complete, then try again.'],
    ['P0002', { code: 'P0002', message: 'issue not found' }, 'This issue is no longer available to you.'],
    ['an unknown code', { code: 'XX000', message: 'boom' }, 'Eligible assignees couldn’t be loaded.'],
  ])('explains %s when the eligible committee members cannot load', async (_label, error, text) => {
    db.state.candidateError = error;
    await mount();
    expect(host.textContent).toContain(text);
    expect(button('Try again')).toBeTruthy();
  });

  it('saves once on two presses in the same turn', async () => {
    await mount();
    await click('Bo Okafor'); await click('I confirm this assignment is correct for this issue.');
    const save = button('Save assignment');
    await act(async () => { save!.click(); save!.click(); });
    await settle();
    expect(db.state.rpcCalls.filter(([name]) => name === 'assign_member_case')).toHaveLength(1);
    expect(onSaved).toHaveBeenCalledTimes(1);
  });
});
