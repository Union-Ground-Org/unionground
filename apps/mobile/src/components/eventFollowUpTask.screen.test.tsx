import { stubSessionWriter } from '../testing/stubSessionWriter';
// @vitest-environment jsdom
// BUG-UG-NATIVE-IOS-EVENT-FOLLOW-UP-TASK-OPENS-NOTHING-20261117 (#9080):
// an event's "Create follow-up task" left a task titled "Follow up on event"
// with nobody assigned, and "Open linked task" failed as "Action not confirmed"
// when the worn role (an organization-wide grant) could not open Chapter work.
// These drive the sheet on both phones: create, then title, person and due date
// saved through update_chapter_task_fields; and a linked task opening either in
// Chapter work or, with the reason, in the task form.
import { act, createElement as h } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessibilityInfo, getExposed, press, render, setPlatform, type, type Rendered } from '../testing/reactNativeStandIn';
import palette from '../theme/palette.json';
import { connectedRecordActions } from '../../../../src/features/connectedWorkflows/actions.js';

const port = vi.hoisted(() => ({
  linked: null as null | { id: string; title: string; status: string },
  api: {} as { context: ReturnType<typeof vi.fn>; createTask: ReturnType<typeof vi.fn> },
  rpc: vi.fn(),
  row: {} as Record<string, unknown>,
  push: vi.fn(),
  app: {} as Record<string, unknown>,
  proof: null as Promise<void> | null,
}));
vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => palette['union-ground'] }));
vi.mock('./EventDiscussionReader', () => ({ EventDiscussionReader: () => null }));
vi.mock('./ReminderPicker', () => ({ ReminderPicker: () => null }));
vi.mock('../lib/connectedWorkflows', async () => {
  const { explicitLiveStaffHat } = await import('../lib/hatFunctions');
  return {
  // The real rule: a live staff hat is one explicitly held staff role.
  connectedStaffAccess: ({ mode, authorizedRoles }: { mode: string; authorizedRoles?: string[] }) =>
    mode === 'authenticated' && explicitLiveStaffHat(authorizedRoles ?? []) !== null,
  connectedWorkflowApi: () => port.api,
  recordActions: (context: unknown, options: unknown) => connectedRecordActions(context as never, options as never),
  newConnectedRequestId: () => 'request-1',
  retainRecipients: (selected: string[]) => selected,
  CONNECTED_MESSAGE_LIMITS: { maxBody: 4000, maxRecipients: 12 },
  };
});
vi.mock('../services/supabase', () => ({ captureSessionWriter: (session: { user?: { id?: string } } | null) => ({ ...stubSessionWriter(() => ({
    rpc: port.rpc,
    from: (table: string) => {
      expect(table).toBe('chapter_tasks');
      const chain = {
        select: () => chain,
        eq: (column: string, value: string) => { expect([column, value]).toEqual(['id', 'task-new']); return chain; },
        is: () => chain,
        maybeSingle: async () => ({ data: { ...port.row }, error: null }),
      };
      return chain;
    },
  }), session?.user?.id ?? 'member-a'), isCurrent: async () => { if (port.proof) { const proof = port.proof; port.proof = null; await proof; } return true; } }),
  getSupabaseClient: () => ({
    rpc: port.rpc,
    from: (table: string) => {
      expect(table).toBe('chapter_tasks');
      const chain = {
        select: () => chain,
        eq: (column: string, value: string) => { expect([column, value]).toEqual(['id', 'task-new']); return chain; },
        is: () => chain,
        maybeSingle: async () => ({ data: { ...port.row }, error: null }),
      };
      return chain;
    },
  }),
}));

vi.mock('expo-router', () => ({ useRouter: () => ({ push: port.push }) }));
vi.mock('../state/AppProvider', () => ({ useApp: () => port.app }));
vi.mock('./NativeMessageActions', () => ({ NativeMessageActions: () => null }));

import { ConnectedRecordActions } from './ConnectedRecordActions';
import { WorkflowActions } from './WorkflowActions';
import { ConnectedTaskEditor } from './ConnectedTaskEditor';

const event = { kind: 'event' as const, id: 'chapter-meeting' };
const context = () => ({
  available: true, reference: event, canMessage: false, canRemind: true, canCreateTask: true,
  linkedTask: port.linked, sourceLinks: [], cancelled: false, contactRole: null,
});
let screen: Rendered | null = null;
async function settle() {
  await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); });
}
async function open(props: { onNavigate?: (route: string) => void; canNavigate?: (route: string) => boolean } = {}) {
  screen = await render(h(ConnectedRecordActions, { reference: event, recordTitle: 'Campaign meeting', staffAccess: true, language: 'en', visible: true, renderTrigger: false, ...props }));
  await settle();
  return screen.container;
}

beforeEach(() => {
  vi.clearAllMocks();
  port.proof = null;
  port.linked = null;
  port.row = { id: 'task-new', title: 'Follow up on meeting', assignee_id: null, assignee_name: '', start_date: null, due_date: null, updated_at: '2026-11-17T21:44:00Z' };
  port.api = {
    context: vi.fn(async () => context()),
    createTask: vi.fn(async () => {
      port.linked = { id: 'task-new', title: 'Follow up on meeting', status: 'backlog' };
      return { task: port.linked, attachment: null, created: true, taskKey: null, href: null };
    }),
  };
  port.rpc.mockImplementation(async (name: string, args: { p_fields?: Record<string, unknown> }) => {
    if (name === 'list_chapter_task_assignees') {
      return { data: [{ user_id: 'steward-rowan', full_name: 'Rowan Pike', initials: 'RP' }, { user_id: 'member-sam', full_name: 'Sam Ortiz', initials: 'SO' }], error: null };
    }
    if (name === 'update_chapter_task_fields') {
      const fields = args.p_fields ?? {};
      port.row = { ...port.row, title: fields.title, assignee_id: fields.assignee_id, assignee_name: fields.assignee_id ? 'Rowan Pike' : '', due_date: fields.due_date, updated_at: '2026-11-17T21:45:00Z' };
      return { data: [{ ...port.row }], error: null };
    }
    throw new Error(`unexpected rpc ${name}`);
  });
});
afterEach(async () => { await screen?.unmount(); screen = null; setPlatform('ios'); });

it.each<['en' | 'es', string, string, string, string, string]>([
  ['en', 'Save task', 'Task title', 'Due date (YYYY-MM-DD)',
    'Give the task a title of up to 160 characters.', 'Enter the due date as year-month-day, for example 2026-12-01.'],
  ['es', 'Guardar tarea', 'Título de la tarea', 'Fecha límite (AAAA-MM-DD)',
    'Ponle a la tarea un título de hasta 160 caracteres.', 'Escribe la fecha límite como año-mes-día, por ejemplo 2026-12-01.'],
])('explains in %s which field is blocking Save task', async (language, label, title, dueDate, titleReason, dateReason) => {
  screen = await render(h(ConnectedTaskEditor, { taskId: 'task-new', language }));
  await settle();
  const { container } = screen;
  await type(getExposed(container, title), '');
  await type(getExposed(container, dueDate), '2026-02-31');
  let save = getExposed(container, label);
  expect(save.getAttribute('aria-disabled')).toBe('true');
  expect(save.getAttribute('aria-description')).toBe(titleReason);
  await press(save);
  expect(port.rpc).not.toHaveBeenCalledWith('update_chapter_task_fields', expect.anything());

  await type(getExposed(container, title), 'Meeting notes');
  save = getExposed(container, label);
  expect(save.getAttribute('aria-description')).toBe(dateReason);
  await type(getExposed(container, dueDate), '2026-12-01');
  save = getExposed(container, label);
  expect(save.getAttribute('aria-disabled')).toBeNull();
  expect(save.getAttribute('aria-description')).toBeNull();
});

it('suppresses the task callback when the editor unmounts during its Auth proof', async () => {
  const onSaved = vi.fn();
  screen = await render(h(ConnectedTaskEditor, { taskId: 'task-new', language: 'en', onSaved }));
  await settle();
  let release!: () => void;
  port.proof = new Promise<void>((resolve) => { release = resolve; });
  await press(getExposed(screen.container, 'Save task')); await settle();
  await screen.unmount(); screen = null;
  await act(async () => { release(); }); await settle();
  expect(onSaved).not.toHaveBeenCalled();
});

// The Android live regions (accessibilityLiveRegion other than 'none') around a
// text, read from the props the rendering components were given: the stand-in
// host elements do not carry the prop.
type PropsFiber = { memoizedProps?: { accessibilityLiveRegion?: string }; stateNode?: unknown; return?: PropsFiber | null };
function liveRegionsAround(root: HTMLElement, text: string): number {
  return [root, ...root.querySelectorAll('*')].filter((element) => {
    if (!element.textContent?.includes(text)) return false;
    const key = Object.keys(element).find((name) => name.startsWith('__reactFiber$'));
    const host = key ? (element as Element & Record<string, PropsFiber>)[key] : null;
    for (let fiber = host?.return ?? null; fiber && !(fiber.stateNode instanceof HTMLElement); fiber = fiber.return ?? null) {
      const region = fiber.memoizedProps?.accessibilityLiveRegion;
      if (region !== undefined) return region !== 'none';
    }
    return false;
  }).length;
}

describe.each(['ios', 'android'] as const)('meeting follow-up task on %s', (os) => {
  it('creates the task, opens its form, and saves the title, the committee member and the due date', async () => {
    setPlatform(os);
    const sheet = await open();
    await press(getExposed(sheet, 'Create follow-up task'));
    await settle();
    expect(port.api.createTask).toHaveBeenCalledWith(event);
    expect(sheet.textContent).toContain('Follow-up task created.');
    expect(sheet.textContent).not.toContain('Action not confirmed');
    expect((getExposed(sheet, 'Task title') as HTMLInputElement).value).toBe('Follow up on meeting');

    await type(getExposed(sheet, 'Task title'), 'Collect the meeting sign-in sheets');
    await press(getExposed(sheet, 'Rowan Pike'));
    await type(getExposed(sheet, 'Due date (YYYY-MM-DD)'), '2026-12-01');
    await press(getExposed(sheet, 'Save task'));
    await settle();

    expect(port.rpc).toHaveBeenCalledWith('update_chapter_task_fields', {
      p_task_id: 'task-new',
      p_fields: { title: 'Collect the meeting sign-in sheets', assignee_id: 'steward-rowan', due_date: '2026-12-01' },
      p_expected_updated_at: '2026-11-17T21:44:00Z',
    });
    expect(port.row).toMatchObject({ assignee_id: 'steward-rowan', due_date: '2026-12-01', title: 'Collect the meeting sign-in sheets' });
    expect(sheet.textContent).toContain('Task saved.');
    expect(getExposed(sheet, 'Rowan Pike').getAttribute('aria-selected')).toBe('true');
    expect((getExposed(sheet, 'Due date (YYYY-MM-DD)') as HTMLInputElement).value).toBe('2026-12-01');
  });

  // UX-UG-NATIVE-TASK-FORM-SAVE-CONFIRMATION-OFF-SCREEN-20261118
  // (#9140): the outcome sat at the top of the form, off screen below a long
  // assignee list, and only Android read it. It now shows directly above Save
  // task, after the last field, and is spoken on both phones.
  it('shows and speaks a save outcome next to Save task, saved or refused', async () => {
    setPlatform(os);
    const speak = vi.spyOn(AccessibilityInfo, os === 'ios' ? 'announceForAccessibilityWithOptions' : 'announceForAccessibility');
    const sheet = await open();
    await press(getExposed(sheet, 'Create follow-up task'));
    await settle();
    const outcomeBesideSave = (text: string) => {
      const actions = getExposed(sheet, 'Save task').parentElement as HTMLElement;
      const beside = actions.previousElementSibling as HTMLElement;
      expect(beside.textContent).toContain(text);
      const due = getExposed(sheet, 'Due date (YYYY-MM-DD)');
      expect(due.compareDocumentPosition(beside) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(sheet.textContent?.indexOf(text)).toBe(sheet.textContent?.lastIndexOf(text));
    };

    // One feedback channel per outcome: the announcement queue speaks it once,
    // and no Android live region around it speaks it again (gate review F1 on
    // #9208: a refusal was heard twice under TalkBack).
    const spokenTimes = (text: string) => { const calls: unknown[][] = speak.mock.calls; return calls.filter(([message]) => String(message).includes(text)).length; };
    const oneChannel = async (text: string) => {
      await vi.waitFor(() => expect(spokenTimes(text)).toBe(1));
      if (os === 'android') expect([spokenTimes(text) > 0, liveRegionsAround(sheet, text) > 0].filter(Boolean)).toHaveLength(1);
      expect(liveRegionsAround(sheet, text)).toBe(0);
    };

    await press(getExposed(sheet, 'Save task'));
    await settle();
    outcomeBesideSave('Task saved.');
    await vi.waitFor(() => expect(speak).toHaveBeenCalledWith('Task saved.', ...(os === 'ios' ? [{ queue: true }] : [])));
    await oneChannel('Task saved.');

    port.rpc.mockImplementationOnce(async () => ({ data: null, error: { code: 'PT409', message: 'task changed; reload before saving' } }));
    await press(getExposed(sheet, 'Save task'));
    await settle();
    expect(sheet.textContent).not.toContain('Task saved.');
    outcomeBesideSave('Someone changed this task after you opened it.');
    await vi.waitFor(() => expect(speak).toHaveBeenCalledWith(expect.stringContaining('Someone changed this task after you opened it.'), ...(os === 'ios' ? [{ queue: true }] : [])));
    await oneChannel('Someone changed this task after you opened it.');
    speak.mockRestore();
  });

  // A load failure has no form and no announcement, so its polite live region
  // is the one channel that tells TalkBack the task did not open.
  it('keeps the live region for a task that could not load', async () => {
    setPlatform(os);
    const speak = vi.spyOn(AccessibilityInfo, os === 'ios' ? 'announceForAccessibilityWithOptions' : 'announceForAccessibility');
    port.rpc.mockImplementationOnce(async () => ({ data: null, error: { code: 'XX000', message: 'roster unavailable' } }));
    const sheet = await open();
    await press(getExposed(sheet, 'Create follow-up task'));
    await settle();
    expect(sheet.textContent).not.toContain('Save task');
    const alert = sheet.querySelector('[role="alert"]') as HTMLElement;
    const reason = alert.querySelector('span')?.textContent ?? '';
    expect(reason).not.toBe('');
    expect(liveRegionsAround(sheet, reason)).toBe(1);
    const calls: unknown[][] = speak.mock.calls;
    expect(calls.filter(([message]) => String(message).includes(reason))).toHaveLength(0);
    speak.mockRestore();
  });

  it('opens a linked task Campaign work would refuse in the task form, and names why', async () => {
    setPlatform(os);
    port.linked = { id: 'task-new', title: 'Follow up on meeting', status: 'backlog' };
    const onNavigate = vi.fn();
    const sheet = await open({ onNavigate, canNavigate: () => false });
    await press(getExposed(sheet, 'Open linked task'));
    await settle();
    expect(onNavigate).not.toHaveBeenCalled();
    expect(sheet.textContent).not.toContain('Action not confirmed');
    expect(sheet.textContent).toContain('Campaign work opens only for a role held in this campaign');
    expect((getExposed(sheet, 'Task title') as HTMLInputElement).value).toBe('Follow up on meeting');
    expect(() => getExposed(sheet, 'Open in Campaign work')).toThrow();
  });

  it('opens a linked task in Campaign work when the worn role can open it', async () => {
    setPlatform(os);
    port.linked = { id: 'task-new', title: 'Follow up on meeting', status: 'backlog' };
    const onNavigate = vi.fn();
    const sheet = await open({ onNavigate, canNavigate: () => true });
    await press(getExposed(sheet, 'Open linked task'));
    await settle();
    expect(onNavigate).toHaveBeenCalledWith('/feature/tasks?source=task-new');
  });
});

describe('a screen the worn role cannot open', () => {
  it('names the reason instead of "Action not confirmed"', async () => {
    const onNavigate = vi.fn();
    port.api.context.mockImplementation(async () => ({ ...context(), discussionHref: '/m/tasks?task=task-new' }));
    // An event's discussion opens in the sheet; a task's opens its screen.
    screen = await render(h(ConnectedRecordActions, { reference: { kind: 'task', id: 'task-new' }, staffAccess: true, language: 'en', visible: true, renderTrigger: false, onNavigate, canNavigate: () => false }));
    await settle();
    await press(getExposed(screen.container, 'Open discussion'));
    await settle();
    expect(onNavigate).not.toHaveBeenCalled();
    expect(screen.container.textContent).toContain('The role you are using cannot open that screen.');
    expect(screen.container.textContent).not.toContain('Action not confirmed');
  });
});

describe('follow-up task form refusals', () => {
  it('holds Save for an impossible due date and an empty title', async () => {
    const sheet = await open();
    await press(getExposed(sheet, 'Create follow-up task'));
    await settle();
    await type(getExposed(sheet, 'Due date (YYYY-MM-DD)'), '2026-02-30');
    expect(sheet.textContent).toContain('Enter the due date as year-month-day');
    expect(getExposed(sheet, 'Save task').getAttribute('aria-disabled')).toBe('true');
    await type(getExposed(sheet, 'Due date (YYYY-MM-DD)'), '');
    await type(getExposed(sheet, 'Task title'), '   ');
    expect(sheet.textContent).toContain('Give the task a title');
    expect(getExposed(sheet, 'Save task').getAttribute('aria-disabled')).toBe('true');
    expect(port.rpc).not.toHaveBeenCalledWith('update_chapter_task_fields', expect.anything());
  });

  it('says the task changed when the server refuses a stale save, and reloads it on request', async () => {
    const sheet = await open();
    await press(getExposed(sheet, 'Create follow-up task'));
    await settle();
    port.rpc.mockImplementationOnce(async () => ({ data: null, error: { code: 'PT409', message: 'task changed; reload before saving' } }));
    await press(getExposed(sheet, 'Save task'));
    await settle();
    expect(sheet.textContent).toContain('Someone changed this task after you opened it.');
    await press(getExposed(sheet, 'Reload task'));
    await settle();
    expect(sheet.textContent).not.toContain('Someone changed this task');
  });
});

// The scoreboard's president holds an organization-wide President grant and no
// chapter grant: the record sheet offers the task actions, Chapter work does not
// open for that role, and the server still accepts the task writes.
describe('the worn role decides where a linked task opens', () => {
  const app = (chapterRoles: string[], organizationRoles: string[]) => ({
    mode: 'authenticated', session: { user: { id: 'president-a' } }, organizationID: 'org-a',
    dashboard: { member: { chapterID: 'chapter-a', language: 'en' } },
    authorizedRoles: [...new Set([...chapterRoles, ...organizationRoles])], chapterRoles, organizationRoles,
  });
  it('opens the task form for an organization-wide Campaign chair', async () => {
    port.linked = { id: 'task-new', title: 'Follow up on meeting', status: 'backlog' };
    port.app = app([], ['vp']);
    screen = await render(h(WorkflowActions, { kind: 'event', id: event.id, recordTitle: 'Campaign meeting', visible: true }));
    await settle();
    await press(getExposed(screen.container, 'Open linked task'));
    await settle();
    expect(port.push).not.toHaveBeenCalled();
    expect(screen.container.textContent).not.toContain('Action not confirmed');
    expect((getExposed(screen.container, 'Task title') as HTMLInputElement).value).toBe('Follow up on meeting');
  });
  it('opens Campaign work for a Campaign chair held in this campaign', async () => {
    port.linked = { id: 'task-new', title: 'Follow up on meeting', status: 'backlog' };
    port.app = app(['vp'], []);
    screen = await render(h(WorkflowActions, { kind: 'event', id: event.id, recordTitle: 'Campaign meeting', visible: true }));
    await settle();
    await press(getExposed(screen.container, 'Open linked task'));
    await settle();
    expect(port.push).toHaveBeenCalledWith('/feature/tasks?source=task-new');
  });
});
