import { stubSessionWriter } from '../testing/stubSessionWriter';
// @vitest-environment jsdom
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getExposed, press, render, setPlatform, type Rendered } from '../testing/reactNativeStandIn';

// BUG-UG-NATIVE-IOS-STEWARD-CANNOT-WORK-AN-ASSIGNED-CASE-20261117
//, part 1: the note card on its own; it saves through
// steward_add_case_note. The case screen's own test (stewardCaseNote.screen)
// covers who gets it (the screen's assignment read) and the reloaded timeline.
const port = vi.hoisted(() => ({
  rpc: vi.fn<(name: string, args?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>>(),
  language: 'en' as 'en' | 'es',
  // The steward assignment read (member_cases): assigned, or not.
  assigned: true,
  deadlineMs: null as number | null,
  // The session writer refuses before sending (its own WriterSessionChanged).
  writerRefuses: false,
}));
//  round 1: a shorter write deadline for the timeout rows only.
type ReadDeadlineModule = typeof import('../lib/readDeadline');
vi.mock('../lib/readDeadline', async (original) => {
  const actual = await original<ReadDeadlineModule>();
  return { ...actual, withReadDeadline: <T,>(request: Promise<T>, ms?: number) => actual.withReadDeadline(request, port.deadlineMs ?? ms) };
});
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('../components/ui', () => import('../testing/uiStandIn'));
vi.mock('expo-crypto', () => ({ randomUUID: () => `attempt-${Math.random().toString(36).slice(2)}` }));
//  PR E: the one signed-in fixture (src/testing/retainedDraftHarness),
// synced into the draft holder before each render as the provider does.
vi.mock('../state/AppProvider', async () => {
  const { appProviderStandIn } = await import('../testing/retainedDraftHarness');
  return { useApp: () => ({ ...appProviderStandIn.useApp(), memberLanguage: port.language }) };
});
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => ({ foreground: '#21152C', input: '#FFFFFF', border: '#827486', primary: '#3D2A4F', destructive: '#9A1B1B', appearance: 'light' }) }));
const assignmentRead = () => {
  const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: port.assigned ? { id: 'case-1' } : null, error: null }) };
  return query;
};
vi.mock('../services/supabase', () => ({ captureSessionWriter: (session: { user?: { id?: string } } | null) => stubSessionWriter(() => { if (port.writerRefuses) throw new WriterSessionChanged(); return { rpc: port.rpc }; }, session?.user?.id ?? 'member-a'),  getSupabaseClient: () => ({ rpc: port.rpc, from: assignmentRead }) }));
import { WriterSessionChanged } from '../../../../src/lib/sessionBoundWriter.js';
import { StewardCaseNoteCard } from './StewardCaseNoteCard';
import { useAssignedStewardCase } from './useAssignedStewardCase';
import { useApp } from '../state/AppProvider';
import { boot, leaveChapter, leaveOrganization, mfa, otherAccount, restore, signIn, signOut, unconfirmReads } from '../testing/retainedDraftHarness';

let screen: Rendered | null = null;
const onSaved = vi.fn<(noteID: string | null) => Promise<'shown' | 'saved' | 'stale'>>();
const onRefresh = vi.fn<(noteID: string | null) => Promise<'shown' | 'saved' | 'stale'>>();
beforeEach(() => { signIn('chapter'); port.assigned = true; port.deadlineMs = null; port.writerRefuses = false; port.language = 'en'; port.rpc.mockResolvedValue({ data: { id: 'u2' }, error: null }); onSaved.mockResolvedValue('shown'); onRefresh.mockResolvedValue('shown'); });
afterEach(async () => { await screen?.unmount(); screen = null; setPlatform('ios'); port.rpc.mockReset(); onSaved.mockReset(); onRefresh.mockReset(); });

async function write(value: string, label = 'Issue note') {
  const input = getExposed(screen!.container, label);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe.each<'ios' | 'android'>(['ios', 'android'])('committee member issue note card on %s', (os) => {
  it('saves a trimmed note to the assigned issue and tells the screen', async () => {
    setPlatform(os);
    screen = await render(h(StewardCaseNoteCard, { caseID: 'case-1', onSaved, onRefresh }));
    await write('  Called the worker back about the overtime list.  ');
    await press(getExposed(screen.container, 'Save issue note'));
    expect(port.rpc).toHaveBeenCalledExactlyOnceWith('steward_add_case_note', { p_case_id: 'case-1', p_body: 'Called the worker back about the overtime list.', p_occurred_on: null });
    // The screen gets the saved note's id to look for in its reread.
    expect(onSaved).toHaveBeenCalledExactlyOnceWith('u2');
    expect(screen.container.textContent).toContain('Issue note saved. It is in the issue timeline.');
  });
});

//  successor: no answer proves the note was not saved (a gateway can
// answer with any code or text after it committed), so a refusal code and an
// unnamed failure both keep the note locked as unconfirmed (Save again,
// Discard) instead of offering an ordinary Save.
it('keeps the draft locked as unconfirmed after a refusal code and after an unnamed failure', async () => {
  screen = await render(h(StewardCaseNoteCard, { caseID: 'case-1', onSaved, onRefresh }));
  await write('Met the supervisor.');
  port.rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'issue not found or not yours' } });
  await press(getExposed(screen.container, 'Save issue note'));
  expect(screen.container.textContent).toContain('We could not confirm this issue note was saved.');
  expect(screen.container.textContent).not.toContain('This issue is not assigned to you as committee member');
  port.rpc.mockResolvedValueOnce({ data: null, error: { code: '57014', message: 'statement timeout' } });
  await press(getExposed(screen.container, 'Save again'));
  expect(screen.container.textContent).toContain('We could not confirm this issue note was saved.');
  expect((getExposed(screen.container, 'Issue note') as HTMLTextAreaElement).value).toBe('Met the supervisor.');
  expect((getExposed(screen.container, 'Issue note') as HTMLTextAreaElement).disabled).toBe(true);
  expect(getExposed(screen.container, 'Save again')).toBeTruthy();
  expect(onSaved).not.toHaveBeenCalled();
});

// named each refusal the routine raises.  successor:
// none of them proves the note was not saved, so each locks it as unconfirmed
// in the profile's language and never says it was refused.
const refusals: ['en' | 'es', string, string][] = [
  ['en', 'committee member role and MFA required', 'Adding an issue note needs the Committee role and two-step verification on this account, so the note was not saved.'],
  ['en', 'issue not found or not yours', 'This issue is not assigned to you as committee member, so the note was not saved.'],
  ['en', 'step-up required', 'Sign in with your password to add an issue note. The note was not saved.'],
  ['en', 'sensitive-data-trusted-write-required', 'Your access to this issue was refused, so the note was not saved.'],
  ['es', 'committee member role and MFA required', 'Para agregar una nota al asunto se necesita el rol de Comité y la verificación en dos pasos en esta cuenta, así que la nota no se guardó.'],
  ['es', 'issue not found or not yours', 'Este asunto no le está asignado como integrante del comité, así que la nota no se guardó.'],
  ['es', 'step-up required', 'Inicie sesión con su contraseña para agregar una nota al asunto. La nota no se guardó.'],
  ['es', 'sensitive-data-trusted-write-required', 'Se rechazó su acceso a este asunto, así que la nota no se guardó.'],
];
it.each(refusals)('locks the note as unconfirmed on the %s refusal "%s", never naming it', async (language, reason, shown) => {
  port.language = language;
  screen = await render(h(StewardCaseNoteCard, { caseID: 'case-1', onSaved, onRefresh }));
  await write('Met the supervisor.', language === 'es' ? 'Nota del asunto' : 'Issue note');
  port.rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: reason } });
  await press(getExposed(screen.container, language === 'es' ? 'Guardar nota del asunto' : 'Save issue note'));
  expect(screen.container.textContent).not.toContain(shown);
  expect(screen.container.textContent).toContain(language === 'es' ? 'No pudimos confirmar que esta nota del asunto se guardó.' : 'We could not confirm this issue note was saved.');
  expect(getExposed(screen.container, language === 'es' ? 'Guardar de nuevo' : 'Save again')).toBeTruthy();
  expect(getExposed(screen.container, language === 'es' ? 'Descartar' : 'Discard')).toBeTruthy();
  expect(onSaved).not.toHaveBeenCalled();
});

// A saved note whose reread fails is not claimed to be in
// the timeline; Refresh rereads without sending the note again.
it('says the timeline could not be updated when the reread fails, and rereads on Refresh', async () => {
  onSaved.mockResolvedValueOnce('stale');
  screen = await render(h(StewardCaseNoteCard, { caseID: 'case-1', onSaved, onRefresh }));
  await write('Grievance meeting moved to Tuesday.');
  await press(getExposed(screen.container, 'Save issue note'));
  expect(screen.container.textContent).toContain('Issue note saved, but the issue timeline could not be updated.');
  expect(screen.container.textContent).not.toContain('It is in the issue timeline');
  expect((getExposed(screen.container, 'Issue note') as HTMLTextAreaElement).value).toBe('');
  await press(getExposed(screen.container, 'Refresh the issue'));
  expect(onSaved).toHaveBeenCalledExactlyOnceWith('u2');
  expect(onRefresh).toHaveBeenCalledExactlyOnceWith('u2');
  expect(port.rpc).toHaveBeenCalledTimes(1);
  expect(screen.container.textContent).toContain('Issue note saved. It is in the issue timeline.');
  expect(() => getExposed(screen!.container, 'Refresh the issue')).toThrow();
});

// Review R-9228, P2-2: a reread that succeeds without the saved note (its
// timeline window does not reach it) says only that the note was saved, as
// the website does, and never that it is in the timeline.
it('says only that the note was saved when the reread does not show it', async () => {
  onSaved.mockResolvedValueOnce('saved');
  screen = await render(h(StewardCaseNoteCard, { caseID: 'case-1', onSaved, onRefresh }));
  await write('Grievance meeting moved to Tuesday.');
  await press(getExposed(screen.container, 'Save issue note'));
  expect(screen.container.textContent).toContain('Issue note saved.');
  expect(screen.container.textContent).not.toContain('It is in the issue timeline');
  expect(() => getExposed(screen!.container, 'Refresh the issue')).toThrow();
});

it('names every reader of the note, as the screen\'s own notice does', async () => {
  screen = await render(h(StewardCaseNoteCard, { caseID: 'case-1', onSaved, onRefresh }));
  expect(screen.container.textContent).toContain('The worker, their committee member, the campaign’s committee members and campaign leads can read them.');
});

it('speaks Spanish for a Spanish profile', async () => {
  port.language = 'es';
  screen = await render(h(StewardCaseNoteCard, { caseID: 'case-1', onSaved, onRefresh }));
  expect(screen.container.textContent).toContain('Agregar una nota al asunto');
  expect(getExposed(screen.container, 'Guardar nota del asunto')).toBeTruthy();
  expect(screen.container.textContent).toContain('los integrantes del comité de la campaña y los líderes de la campaña pueden leerlas');
});

//  pull request E (design R-9240D, row E): the unsent note waits in
// memory through a session check for the same person, place and hat, keyed by
// the case. The case screen unmounts the card while the session is checked
// and mounts it again, keyed afresh, once it holds the case; this host does
// the same (app/issue/[id].tsx is not edited).
function Host({ caseID }: { caseID: string }) {
  const { mode, dashboard } = useApp();
  return mode === 'authenticated' && dashboard ? h(StewardCaseNoteCard, { caseID, onSaved, onRefresh }) : null;
}
const noteField = () => screen!.container.querySelector('textarea[aria-label="Issue note"]');
async function check(change: () => void, caseID = 'case-1') {
  boot(); await screen!.rerender(h(Host, { caseID }));
  change(); await screen!.rerender(h(Host, { caseID }));
}

describe.each<'ios' | 'android'>(['ios', 'android'])('an issue note through a session check on %s', (os) => {
  beforeEach(() => { setPlatform(os); });

  it('comes back word for word for the same committee member on the same issue', async () => {
    screen = await render(h(Host, { caseID: 'case-1' }));
    await write('Called the worker back about the overtime list.');
    await check(restore);
    expect((noteField() as HTMLTextAreaElement).value).toBe('Called the worker back about the overtime list.');
    await press(getExposed(screen.container, 'Save issue note'));
    expect(port.rpc).toHaveBeenCalledExactlyOnceWith('steward_add_case_note', { p_case_id: 'case-1', p_body: 'Called the worker back about the overtime list.', p_occurred_on: null });
  });

  it('shows nothing it holds while the session is checked or the access reads are unconfirmed', async () => {
    screen = await render(h(Host, { caseID: 'case-1' }));
    await write('Held while checking.');
    boot(); await screen.rerender(h(Host, { caseID: 'case-1' }));
    expect(screen.container.textContent).not.toContain('Held while checking.');
    unconfirmReads(); await screen.rerender(h(Host, { caseID: 'case-1' }));
    expect(noteField()).toBeNull();
    expect(screen.container.innerHTML).not.toContain('Held while checking.');
    restore(); await screen.rerender(h(Host, { caseID: 'case-1' }));
    expect((noteField() as HTMLTextAreaElement).value).toBe('Held while checking.');
  });

  //  round 1: leaving the case for another discards its note.
  it('gives another issue nothing, and starts blank on returning to the first issue', async () => {
    screen = await render(h(Host, { caseID: 'case-1' }));
    await write('Only for issue one.');
    await check(restore, 'case-2');
    expect((noteField() as HTMLTextAreaElement).value).toBe('');
    await screen.rerender(h(Host, { caseID: 'case-1' }));
    expect((noteField() as HTMLTextAreaElement).value).toBe('');
    expect(screen.container.innerHTML).not.toContain('Only for issue one.');
  });

  it.each<[string, () => void]>([
    ['another account', otherAccount], ['another campaign', leaveChapter], ['another organization', leaveOrganization],
  ])('starts blank for %s', async (_name, change) => {
    screen = await render(h(Host, { caseID: 'case-1' }));
    await write('Not for anyone else.');
    await check(change);
    expect((noteField() as HTMLTextAreaElement).value).toBe('');
    expect(screen.container.innerHTML).not.toContain('Not for anyone else.');
  });

  it.each<[string, () => void]>([['sign-out', signOut], ['an MFA challenge', mfa]])('retires the note on %s', async (_name, change) => {
    screen = await render(h(Host, { caseID: 'case-1' }));
    await write('Retired on the way out.');
    await check(change);
    restore(); await screen.rerender(h(Host, { caseID: 'case-1' }));
    expect((noteField() as HTMLTextAreaElement).value).toBe('');
  });

  it('sends a note that was in flight at the check once, and comes back blank once it is saved', async () => {
    let answer!: (reply: { data: unknown; error: unknown }) => void;
    port.rpc.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    screen = await render(h(Host, { caseID: 'case-1' }));
    await write('In flight at the check.');
    await press(getExposed(screen.container, 'Save issue note'));
    await check(restore);
    // Still sending: the field and Save stay locked; nothing can send it again.
    expect((noteField() as HTMLTextAreaElement).disabled).toBe(true);
    await press(getExposed(screen.container, 'Saving…'));
    await act(async () => { answer({ data: { id: 'u9' }, error: null }); });
    expect(port.rpc).toHaveBeenCalledTimes(1);
    expect((noteField() as HTMLTextAreaElement).value).toBe('');
  });

  it('keeps a note answered with a refusal code after the check locked as unconfirmed', async () => {
    let answer!: (reply: { data: unknown; error: unknown }) => void;
    port.rpc.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    screen = await render(h(Host, { caseID: 'case-1' }));
    await write('Failed after the check.');
    await press(getExposed(screen.container, 'Save issue note'));
    await check(restore);
    await act(async () => { answer({ data: null, error: { code: '42501', message: 'issue not found or not yours' } }); });
    expect((noteField() as HTMLTextAreaElement).value).toBe('Failed after the check.');
    expect((noteField() as HTMLTextAreaElement).disabled).toBe(true);
    expect(getExposed(screen.container, 'Save again')).toBeTruthy();
    expect(screen.container.textContent).not.toContain('This issue is not assigned to you as committee member');
  });

  it('returns the note as editable text when the session writer refuses before sending, after the check', async () => {
    screen = await render(h(Host, { caseID: 'case-1' }));
    await write('Refused before sending.');
    await check(restore);
    port.writerRefuses = true;
    await press(getExposed(screen.container, 'Save issue note'));
    expect(port.rpc).not.toHaveBeenCalled();
    expect((noteField() as HTMLTextAreaElement).value).toBe('Refused before sending.');
    expect((noteField() as HTMLTextAreaElement).disabled).toBe(false);
    expect(screen.container.textContent).toContain('Your issue note was not saved. Try again in a moment.');
    expect(() => getExposed(screen!.container, 'Save again')).toThrow();
  });

  // Ledger 551: two presses in one turn, before React draws Saving…, save once.
  it('saves once for two presses in the same turn', async () => {
    screen = await render(h(Host, { caseID: 'case-1' }));
    await write('Pressed twice.');
    const save = getExposed(screen.container, 'Save issue note');
    await act(async () => { save.click(); save.click(); });
    expect(port.rpc).toHaveBeenCalledTimes(1);
  });

  // Loss of access retires held work: the steward's assignment read on the
  // case screen answering that the case is no longer theirs.
  it('retires the note when the issue is no longer assigned to the committee member', async () => {
    let generation = 0;
    function Route() {
      const { mode, dashboard } = useApp();
      const assigned = useAssignedStewardCase('case-1', mode === 'authenticated' ? 'officer-a' : null, generation);
      return mode === 'authenticated' && dashboard && assigned ? h(StewardCaseNoteCard, { key: `note-${generation}`, caseID: 'case-1', onSaved, onRefresh }) : null;
    }
    screen = await render(h(Route));
    await act(async () => { await Promise.resolve(); });
    await write('Reassigned away.');
    generation += 1; boot(); await screen.rerender(h(Route));
    port.assigned = false;
    generation += 1; restore(); await screen.rerender(h(Route));
    await act(async () => { await Promise.resolve(); });
    expect(noteField()).toBeNull();
    // Reassigned to the same steward later: the old note does not come back.
    port.assigned = true;
    generation += 1; await screen.rerender(h(Route));
    await act(async () => { await Promise.resolve(); });
    expect((noteField() as HTMLTextAreaElement).value).toBe('');
  });
});

//  round 1: the note is a new row with no key. A save with no answer, or
// one that runs into the 20-second deadline, may have gone through: the note
// stays locked as unconfirmed with Save again and Discard, nothing sends it
// again on its own, and Save again sends it exactly once more.
const waitTask = (ms = 20) => act(async () => { await new Promise((resolve) => { setTimeout(resolve, ms); }); });
const noteWrites = () => port.rpc.mock.calls.filter(([name]) => name === 'steward_add_case_note').length;
describe.each<'ios' | 'android'>(['ios', 'android'])('an unconfirmed issue note on %s', (os) => {
  beforeEach(() => { setPlatform(os); });
  const lost = () => { port.rpc.mockResolvedValueOnce({ data: null, error: { message: 'TypeError: Network request failed' } }); };
  const hung = () => { port.deadlineMs = 5; port.rpc.mockImplementationOnce(() => new Promise(() => {})); };
  // A PostgREST-shaped 403 answer carrying 42501, as the client reports it.
  const forbidden = { data: null, error: { code: '42501', message: 'permission denied for function', details: null, hint: null }, status: 403, statusText: 'Forbidden' };
  const postgrest = () => { port.rpc.mockResolvedValueOnce(forbidden); };
  const marked = () => { port.rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'The account changed before this was sent.', details: 'writer_session_changed' } }); };
  it.each<[string, () => void]>([['a lost answer', lost], ['the write deadline', hung], ['a PostgREST 403 carrying 42501', postgrest], ['an answer carrying the writer marker', marked]])('locks the note after %s, offers Save again and Discard, and sends once per press', async (_name, fail) => {
    screen = await render(h(StewardCaseNoteCard, { caseID: 'case-1', onSaved, onRefresh }));
    await write('May have been saved.');
    fail();
    await press(getExposed(screen.container, 'Save issue note'));
    await waitTask();
    expect(noteWrites()).toBe(1);
    const field = getExposed(screen.container, 'Issue note') as HTMLTextAreaElement;
    expect(field.value).toBe('May have been saved.');
    expect(field.disabled).toBe(true);
    expect(screen.container.textContent).toContain('We could not confirm this issue note was saved. Check the issue timeline first: saving it again may add it twice.');
    expect(screen.container.textContent).not.toContain('Your issue note was not saved.');
    // Nothing sends it again on its own.
    await waitTask();
    expect(noteWrites()).toBe(1);
    // Save again: exactly one more write; still unconfirmed when it is lost too.
    fail();
    await press(getExposed(screen.container, 'Save again'));
    await waitTask();
    expect(noteWrites()).toBe(2);
    expect((getExposed(screen.container, 'Issue note') as HTMLTextAreaElement).disabled).toBe(true);
    // Discard: the note goes and the field is editable again.
    await press(getExposed(screen.container, 'Discard'));
    expect((getExposed(screen.container, 'Issue note') as HTMLTextAreaElement).value).toBe('');
    expect((getExposed(screen.container, 'Issue note') as HTMLTextAreaElement).disabled).toBe(false);
    expect(noteWrites()).toBe(2);
  });
  it('saves on Save again once it is answered, and comes back blank', async () => {
    screen = await render(h(StewardCaseNoteCard, { caseID: 'case-1', onSaved, onRefresh }));
    await write('Second try lands.');
    lost();
    await press(getExposed(screen.container, 'Save issue note'));
    await press(getExposed(screen.container, 'Save again'));
    expect(noteWrites()).toBe(2);
    expect((getExposed(screen.container, 'Issue note') as HTMLTextAreaElement).value).toBe('');
    expect(screen.container.textContent).toContain('Issue note saved. It is in the issue timeline.');
  });
});

//  round 1: the session writer's refusal of Save again proves only that
// the retry was not sent; the first save may have committed. The note stays
// locked (unconfirmed line, Save again, Discard) with the refusal named beside
// it, and only a confirmed save or Discard releases it.
describe.each<'ios' | 'android'>(['ios', 'android'])('a refused Save again on an unconfirmed issue note on %s', (os) => {
  it('keeps the note locked and names the refusal; a later Save again sends it once', async () => {
    setPlatform(os);
    screen = await render(h(StewardCaseNoteCard, { caseID: 'case-1', onSaved, onRefresh }));
    await write('First save unconfirmed.');
    port.rpc.mockResolvedValueOnce({ data: null, error: { message: 'TypeError: Network request failed' } });
    await press(getExposed(screen.container, 'Save issue note'));
    expect(noteWrites()).toBe(1);
    port.writerRefuses = true;
    await press(getExposed(screen.container, 'Save again'));
    expect(noteWrites()).toBe(1);
    const field = getExposed(screen.container, 'Issue note') as HTMLTextAreaElement;
    expect(field.value).toBe('First save unconfirmed.');
    expect(field.disabled).toBe(true);
    expect(screen.container.textContent).toContain('We could not confirm this issue note was saved.');
    expect(screen.container.textContent).toContain('Save again was refused before it was sent. The first save is still unconfirmed, so it stays locked.');
    expect(screen.container.textContent).not.toContain('Your issue note was not saved.');
    expect(getExposed(screen.container, 'Save again')).toBeTruthy();
    expect(getExposed(screen.container, 'Discard')).toBeTruthy();
    port.writerRefuses = false;
    await press(getExposed(screen.container, 'Save again'));
    expect(noteWrites()).toBe(2);
    expect((getExposed(screen.container, 'Issue note') as HTMLTextAreaElement).value).toBe('');
  });
});
