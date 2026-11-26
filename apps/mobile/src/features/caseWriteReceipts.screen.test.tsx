// @vitest-environment jsdom
import { act, createElement as h, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearHeldDrafts } from '../testing/retainedDraftHarness';
import { getExposed, press, render, setPlatform, type Rendered } from '../testing/reactNativeStandIn';
import type { MemberCaseDetail } from '../models/member';
import palette from '../theme/palette.json';
import { stubSessionWriter } from '../testing/stubSessionWriter';

// #9091 final unit: actual route, cards, date fields and write/receipt adapters.
// Only the native picker, unrelated panels and backend boundary are stand-ins.
// One acknowledged write leaves one member-history entry; failed rereads and
// every Refresh are read-only. Refusals/conflicts leave no update entry.
const port = vi.hoisted(() => ({
  app: {} as Record<string, unknown>,
  detail: null as MemberCaseDetail | null,
  deadlines: [] as Record<string, unknown>[],
  extensions: [] as Record<string, unknown>[],
  saved: [] as { name: string; args: Record<string, unknown> }[],
  access: [] as string[],
  events: [] as string[],
  error: null as { code: string; message: string } | null,
  writeWait: null as Promise<void> | null,
  receiptWait: null as Promise<void> | null,
  receiptFails: false,
  failedReads: 0,
  pick: 0,
  platform: 'ios' as 'ios' | 'android',
  loadCaseDetail: vi.fn<() => Promise<MemberCaseDetail | null>>(),
  rpc: vi.fn<(name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>>(),
}));

vi.mock('react-native', () => import('../testing/reactNativeStandIn'));
vi.mock('expo-crypto', () => ({ randomUUID: () => 'extension-attempt' }));
vi.mock('../components/ui', async () => {
  const ui = await import('../testing/uiStandIn');
  const { Pressable, Text } = await import('../testing/reactNativeStandIn');
  return {
    ...ui,
    StatusPill: ({ label }: { label: string }) => h('span', null, label),
    StateMessage: ({ title, body }: { title: string; body?: string }) => h('section', null, title, body),
    Button: ({ label, onPress, disabled, busy, selected, accessibilityLabel }: { label: string; onPress?: () => void; disabled?: boolean; busy?: boolean; selected?: boolean; accessibilityLabel?: string }) =>
      h(Pressable, { accessibilityLabel: accessibilityLabel ?? label, onPress, disabled: disabled || busy, accessibilityRole: selected === undefined ? 'button' : 'radio', accessibilityState: { disabled: disabled || busy, busy, selected } }, h(Text, null, label)),
  };
});
vi.mock('../lib/nativeDateTimePicker', async () => {
  const { Pressable, Text } = await import('../testing/reactNativeStandIn');
  return {
    loadNativeDateTimePicker: () => ({ mode, onChange }: { mode: string; onChange: (event: { type: string; nativeEvent: { timestamp: number } }) => void }) =>
      h(Pressable, { accessibilityLabel: `Pick ${mode}`, onPress: () => onChange({ type: 'set', nativeEvent: { timestamp: port.pick } }) }, h(Text, null, mode)),
  };
});
vi.mock('expo-router', () => ({ useLocalSearchParams: () => ({ id: 'case-1' }), useRouter: () => ({ push: vi.fn() }), Redirect: () => null }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
// #9240 PR E: the case cards' drafts wait in the draft holder; sync this
// fixture into it on each render, as the provider does, and start each
// test with nothing held.
vi.mock('../state/AppProvider', async () => {
  const { syncedApp } = await import('../testing/retainedDraftHarness');
  return { useApp: () => syncedApp(port.app) };
});
vi.mock('../theme/ThemeProvider', () => ({ useTheme: () => palette['union-ground'] }));
function from(table: string) {
  const query = {
    select: () => query,
    eq: () => query,
    in: () => query,
    maybeSingle: async () => ({ data: { id: 'case-1' }, error: null }),
    order: async () => {
      port.events.push(table);
      return { data: table === 'casework_deadlines' ? port.deadlines : port.extensions, error: null };
    },
  };
  return query;
}
vi.mock('../services/supabase', () => ({
  captureSessionWriter: (session: { user: { id: string } } | null) => stubSessionWriter(() => ({ rpc: port.rpc, from }), session?.user.id ?? 'signed-out'),
  loadCaseDetail: port.loadCaseDetail,
  getSupabaseClient: () => ({ rpc: port.rpc, from }),
}));
vi.mock('../components/PinnedHeader', () => ({ PinnedHeaderScreen: ({ children }: { children?: ReactNode }) => h('div', null, children) }));
vi.mock('../components/AttachmentPanel', () => ({ AttachmentPanel: () => null }));
vi.mock('../components/CompassCaseHelp', () => ({ CompassCaseHelp: () => null }));
vi.mock('./CaseRowTopicCards', () => ({ CaseRowTopicCard: () => null }));
vi.mock('./StewardCaseNoteCard', () => ({ StewardCaseNoteCard: () => null }));
vi.mock('./CaseStewardAssignment', () => ({ CaseStewardAssignment: () => null }));
const { default: CaseDetailScreen } = await import('../../app/issue/[id]');

const due = { id: 'deadline-1', kind: 'response', label: 'Employer answer', due_at: '2026-12-01T17:00:00Z', status: 'active' };
const extension = { id: 'extension-1', deadline_id: 'deadline-1', requested_due_at: '2026-12-15T17:00:00.000Z', reason: 'Employer asked for two more weeks.', status: 'requested', created_at: '2026-11-18T17:00:00Z' };
const reason = 'Employer agreed to a later meeting.';
type Writer = {
  name: string;
  role: 'steward' | 'coordinator';
  rpc: string;
  button: string;
  args: Record<string, unknown>;
  message: string;
};
const writers: Writer[] = [
  { name: 'campaign lead note', role: 'coordinator', rpc: 'coordinator_add_case_note', button: 'Add issue note', args: { p_case_id: 'case-1', p_body: 'Met the supervisor.' }, message: 'Issue note saved.' },
  { name: 'employer contact', role: 'coordinator', rpc: 'coordinator_log_case_contact', button: 'Log contact', args: { p_case_id: 'case-1', p_contact_type: 'meeting', p_direction: 'inbound', p_summary: 'Supervisor offered the overtime slot.', p_contacted_at: '2026-11-18T15:00:00.000Z' }, message: 'Contact logged.' },
  { name: 'issue deadline', role: 'coordinator', rpc: 'coordinator_update_case', button: 'Save the new deadline', args: { p_case_id: 'case-1', p_deadline: '2026-12-15', p_reason: reason }, message: 'Issue deadline changed.' },
];

function persist(name: string, args: Record<string, unknown>) {
  port.saved.push({ name, args });
  if (name === 'casework_create_deadline') port.deadlines.push({ ...due, id: 'deadline-2', kind: args.p_kind, label: args.p_label, due_at: args.p_due_at });
  if (name === 'casework_request_deadline_extension') port.extensions.push({ ...extension, reason: args.p_reason });
  if (name === 'casework_decide_deadline_extension') {
    port.extensions = [{ ...extension, status: args.p_decision }];
    if (args.p_decision === 'approved') port.deadlines = [{ ...due, due_at: extension.requested_due_at, status: 'extended' }];
  }
  if (name === 'casework_set_deadline_status') port.deadlines = [{ ...due, status: args.p_status }];
  if (name === 'coordinator_update_case') port.detail = { ...port.detail!, item: { ...port.detail!.item, deadline: String(args.p_deadline) } };
  if (name === 'coordinator_add_case_note' || name === 'coordinator_log_case_contact') port.detail = {
    ...port.detail!, updates: [{ id: 'saved-1', caseID: 'case-1', body: String(args.p_body ?? args.p_summary), createdAt: '2026-11-18T15:00:00Z' }],
  };
}

let screen: Rendered | null = null;
beforeEach(() => { clearHeldDrafts(); });
beforeEach(() => {
  port.detail = { item: { id: 'case-1', ownerID: 'member-b', reference: 'GR-2026-41960', title: 'Overtime assignment out of order', deadline: '2026-12-01', caseType: 'Pay', step: 'intake', status: 'active', updatedAt: '2026-11-18T12:00:00Z' }, updates: [] };
  port.deadlines = [{ ...due }]; port.extensions = []; port.saved = []; port.access = []; port.events = [];
  port.error = null; port.writeWait = null; port.receiptWait = null; port.receiptFails = false; port.failedReads = 0;
  port.loadCaseDetail.mockImplementation(async () => {
    port.events.push('detail');
    if (port.failedReads > 0) { port.failedReads -= 1; throw new Error('detail read unavailable'); }
    return port.detail;
  });
  port.rpc.mockImplementation(async (name, args) => {
    if (name === 'record_member_access_event') {
      const action = String(args.p_action);
      port.access.push(action); port.events.push(action);
      if (action === 'updated_case') await port.receiptWait;
      return { data: null, error: action === 'updated_case' && port.receiptFails ? { code: '42501', message: 'receipt refused' } : null };
    }
    port.events.push(name);
    await port.writeWait;
    if (port.error) return { data: null, error: port.error };
    persist(name, args);
    port.events.push('ack');
    return { data: name === 'casework_decide_deadline_extension' ? { ...extension, status: args.p_decision } : 'saved-1', error: null };
  });
});
afterEach(async () => { await screen?.unmount(); screen = null; setPlatform('ios'); port.loadCaseDetail.mockReset(); port.rpc.mockReset(); });

async function type(label: string, value: string, element: typeof HTMLInputElement | typeof HTMLTextAreaElement = HTMLTextAreaElement) {
  const input = getExposed(screen!.container, label);
  await act(async () => {
    Object.getOwnPropertyDescriptor(element.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function pick(label: string, value: string, dateOnly = false) {
  port.pick = Date.parse(value);
  await press(getExposed(screen!.container, `${label}: ${dateOnly ? 'Choose a date' : 'Choose date and time'}`));
  if (dateOnly) await press(getExposed(screen!.container, 'Pick date'));
  else if (port.platform === 'android') {
    await press(getExposed(screen!.container, 'Pick date'));
    await press(getExposed(screen!.container, 'Pick time'));
  } else await press(getExposed(screen!.container, 'Pick datetime'));
}
async function open(writer: Writer, os: 'ios' | 'android') {
  setPlatform(os); port.platform = os;
  port.app = { mode: 'authenticated', session: { user: { id: 'staff-a' } }, sessionRestricted: false, organizationID: 'org-a', authorizedRoles: [writer.role], memberLanguage: 'en', dashboard: { member: { id: 'staff-a', chapterID: 'chapter-a', language: 'en' }, cases: [] } };
  screen = await render(h(CaseDetailScreen));
  switch (writer.name) {
    case 'campaign lead note': await type('Issue note', 'Met the supervisor.'); break;
    case 'employer contact':
      await press(getExposed(screen.container, 'Meeting'));
      await press(getExposed(screen.container, 'Inbound'));
      await pick('Contacted at', '2026-11-18T15:00:00Z');
      await type('Contact summary', 'Supervisor offered the overtime slot.');
      break;
    case 'issue deadline':
      await pick('Next deadline', '2026-12-15T17:00:00Z', true);
      await type('Reason for change', reason);
      break;
  }
  expect(port.access).toEqual(['viewed_case']);
  port.events = [];
}
const writeCalls = () => port.rpc.mock.calls.filter(([name]) => name !== 'record_member_access_event');

describe.each<'ios' | 'android'>(['ios', 'android'])('new issue write receipts on %s', (os) => {
  describe.each(writers)('$name', (writer) => {
    it('rejects two presses in one React turn before pending state renders', async () => {
      await open(writer, os);
      let acknowledge!: () => void;
      port.writeWait = new Promise<void>((resolve) => { acknowledge = resolve; });
      const button = getExposed(screen!.container, writer.button);
      await act(async () => { button.click(); button.click(); });
      const count = writeCalls().length;
      await act(async () => { acknowledge(); });
      expect({ requests: count, saved: port.saved.length, receipts: port.access.filter((entry) => entry === 'updated_case').length })
        .toEqual({ requests: 1, saved: 1, receipts: 1 });
    });

    it('releases its submission lock after a refused write so a later retry can save', async () => {
      await open(writer, os);
      port.error = { code: '42501', message: 'staff access refused' };
      await press(getExposed(screen!.container, writer.button));
      expect(port.access).toEqual(['viewed_case']);
      port.error = null;
      // #9440 successor: a write with no key stays unconfirmed after any
      // answer (no code proves it was not saved), so the retry is the
      // deliberate Save again; a keyed or one-tap write retries as before.
      const unkeyed = ['create deadline', 'campaign lead note', 'employer contact', 'issue deadline'].includes(writer.name);
      await press(getExposed(screen!.container, unkeyed ? 'Save again' : writer.button));
      expect(writeCalls()).toHaveLength(2);
      expect(port.saved).toEqual([{ name: writer.rpc, args: writer.args }]);
      expect(port.access).toEqual(['viewed_case', 'updated_case']);
    });

    it('records only at acknowledgement, waits for the receipt, and every Refresh only rereads', async () => {
      await open(writer, os);
      let acknowledge!: () => void;
      let logReceipt!: () => void;
      port.writeWait = new Promise<void>((resolve) => { acknowledge = resolve; });
      port.receiptWait = new Promise<void>((resolve) => { logReceipt = resolve; });
      port.failedReads = 2;
      await press(getExposed(screen!.container, writer.button));
      expect(writeCalls()).toEqual([[writer.rpc, writer.args]]);
      expect(port.saved).toEqual([]);
      expect(port.access).toEqual(['viewed_case']);
      expect(port.loadCaseDetail).toHaveBeenCalledTimes(1);

      await act(async () => { acknowledge(); });
      expect(port.saved).toEqual([{ name: writer.rpc, args: writer.args }]);
      expect(port.events).toEqual([writer.rpc, 'ack', 'updated_case']);
      expect(port.loadCaseDetail).toHaveBeenCalledTimes(1);
      await act(async () => { logReceipt(); });
      expect(port.events.slice(0, 4)).toEqual([writer.rpc, 'ack', 'updated_case', 'detail']);
      expect(screen!.container.textContent).toContain('could not be');
      await press(getExposed(screen!.container, 'Refresh the issue'));
      expect(getExposed(screen!.container, 'Refresh the issue')).toBeTruthy();
      await press(getExposed(screen!.container, 'Refresh the issue'));
      expect(port.loadCaseDetail).toHaveBeenCalledTimes(4);
      expect(writeCalls()).toEqual([[writer.rpc, writer.args]]);
      expect(port.saved).toEqual([{ name: writer.rpc, args: writer.args }]);
      expect(port.access).toEqual(['viewed_case', 'updated_case']);
      expect(screen!.container.textContent).toContain(writer.message);
      expect(() => getExposed(screen!.container, 'Refresh the issue')).toThrow();
    });

    it.each([
      ['refused', '42501', 'staff access refused'],
      ['conflicting', 'PT409', 'someone else changed the issue'],
    ])('writes no receipt for a %s write', async (_kind, code, message) => {
      await open(writer, os);
      port.error = { code, message };
      await press(getExposed(screen!.container, writer.button));
      expect(writeCalls()).toEqual([[writer.rpc, writer.args]]);
      expect(port.saved).toEqual([]);
      expect(port.access).toEqual(['viewed_case']);
      expect(port.loadCaseDetail).toHaveBeenCalledTimes(1);
      expect(screen!.container.textContent).not.toContain('its access-history entry could not be logged');
    });

    it('retries only the receipt when Try again follows a saved but unlogged write', async () => {
      await open(writer, os);
      port.receiptFails = true;
      await press(getExposed(screen!.container, writer.button));
      expect(screen!.container.textContent).toContain('The issue was saved, but its access-history entry could not be logged.');
      port.receiptFails = false;
      const reads = port.loadCaseDetail.mock.calls.length;
      await press(getExposed(screen!.container, 'Try again'));
      expect(port.access).toEqual(['viewed_case', 'updated_case', 'updated_case']);
      expect(writeCalls()).toEqual([[writer.rpc, writer.args]]);
      expect(port.saved).toEqual([{ name: writer.rpc, args: writer.args }]);
      expect(port.loadCaseDetail).toHaveBeenCalledTimes(reads);
      expect(screen!.container.textContent).not.toContain('its access-history entry could not be logged');
    });
  });

});
