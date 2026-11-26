import { stubSessionWriter } from '../apps/mobile/src/testing/stubSessionWriter';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connectedRecordActions } from '../src/features/connectedWorkflows/actions.js';

const wire = vi.hoisted(() => ({ api: null, sequence: 0, rpc: vi.fn() }));
vi.mock('../apps/mobile/src/lib/connectedWorkflows', () => ({
  connectedWorkflowApi: () => wire.api,
  recordActions: (context, options) => connectedRecordActions(context, options),
  newConnectedRequestId: () => `request-${++wire.sequence}`,
  retainRecipients: (selected, people) => selected.filter((id) => people.some((person) => person.id === id)),
  CONNECTED_MESSAGE_LIMITS: { maxBody: 4000, maxRecipients: 12 },
}));
vi.mock('../apps/mobile/src/theme/ThemeProvider', () => ({ useTheme: () => ({ background: '#fff', foreground: '#111', input: '#fff', border: '#777', primary: '#155f40', primaryForeground: '#fff', mutedForeground: '#444', popover: '#fff', destructive: '#800' }) }));
vi.mock('../apps/mobile/src/components/EventDiscussionReader', () => ({ EventDiscussionReader: () => null }));
vi.mock('../apps/mobile/src/lib/screenReader', () => ({ useScreenReader: () => false, useScreenReaderKnownOff: () => true }));
vi.mock('../apps/mobile/src/services/supabase', () => ({captureSessionWriter: () => stubSessionWriter(() => ({rpc:wire.rpc})), getSupabaseClient: () => ({ rpc: wire.rpc }) }));
vi.mock('../apps/mobile/src/state/AppProvider', () => ({ useApp: () => ({ memberLanguage: 'en' }) }));
vi.mock('../apps/mobile/src/services/haptics', () => ({ haptics: { select: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
// Reaction rendering has its own native component suite; this suite exercises
// the source-bound connected sheet and reminder handoff.
vi.mock('../apps/mobile/src/components/MessageReactions', () => ({ MessageReactionPicker: () => null }));
vi.mock('../apps/mobile/src/components/ReminderPicker', () => ({ ReminderPicker: ({ visible, onConfirm }) => visible ? <button onClick={() => onConfirm({ iso: '2026-10-01T12:00:00-04:00', note: 'Bring the document' })}>Confirm reminder with note</button> : null }));
// Root CI has no Expo SDK; the actions control's icon renders nothing here.
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('react-native', async () => {
  const React = await import('react');
  const box = ({ children, accessibilityLabel, accessibilityRole, ...props }) => React.createElement('div', { 'aria-label': accessibilityLabel, role: accessibilityRole === 'header' ? 'heading' : accessibilityRole === 'alert' ? 'alert' : undefined }, children);
  return {
    Platform: { OS: 'ios' },
    // #9963: the composer announces its status lines through the app's queue on iOS.
    AccessibilityInfo: { announceForAccessibility: () => {}, announceForAccessibilityWithOptions: () => {} },
    ActionSheetIOS: { showActionSheetWithOptions: (options, choose) => choose(options.options.indexOf('Remind me…')) },
    View: box, Text: box, ScrollView: box, KeyboardAvoidingView: box,
    StyleSheet: { create: (value) => value, hairlineWidth: 1, absoluteFill: {} },
    Modal: ({ children, visible }) => visible ? React.createElement('div', { role: 'dialog' }, children) : null,
    Pressable: ({ children, onPress, disabled, accessibilityRole, accessibilityLabel, accessibilityState }) => React.createElement('button', { onClick: onPress, disabled, role: accessibilityRole, 'aria-label': accessibilityLabel, 'aria-checked': accessibilityState?.checked }, children),
    TextInput: ({ value, onChangeText, editable, accessibilityLabel, maxLength }) => React.createElement('textarea', { value, maxLength, onChange: (event) => onChangeText(event.target.value), disabled: editable === false, 'aria-label': accessibilityLabel }),
  };
});
import { ConnectedRecordActions } from '../apps/mobile/src/components/ConnectedRecordActions';
import { NativeMessageActions } from '../apps/mobile/src/components/NativeMessageActions';

const reference = { kind: 'task', id: 'task-one' };
const context = { available: true, canMessage: true, canRemind: true, linkedTask: null, sourceLinks: [], reference };
beforeEach(() => { wire.api = { context: vi.fn().mockResolvedValue(context), recipients: vi.fn().mockResolvedValue({ status: 'available', items: [{ id: 'alex', label: 'Alex' }], nextCursor: null }), send: vi.fn().mockResolvedValue({}) }; });
async function draft() {
  fireEvent.click(await screen.findByRole('button', { name: 'Message…' }));
  await screen.findByRole('checkbox', { name: 'Alex' });
}
describe('native connected action sheet behavior', () => {
  it.each(['event', 'task'])('names the %s in its trigger and sheet heading', async (kind) => {
    const title = kind === 'event' ? 'Chapter meeting' : 'Review the meeting notes';
    wire.api.context.mockResolvedValue({ ...context, reference: { kind, id: `${kind}-one` } });
    render(<ConnectedRecordActions reference={{ kind, id: `${kind}-one` }} recordTitle={title} staffAccess language="en" />);
    fireEvent.click(screen.getByRole('button', { name: `${kind === 'event' ? 'Meeting' : 'Task'} actions: ${title}` }));
    expect(await screen.findByRole('heading', { name: `Actions: ${title}` })).toBeInTheDocument();
  });

  it('preserves the optional note on a reply row reminder', async () => {
    wire.api.remind = vi.fn().mockResolvedValue({});
    wire.rpc.mockResolvedValue({ data: { canEdit: false, saved: false, reminders: [], reactions: [] }, error: null });
    render(<NativeMessageActions sourceKind="private" messageID="reply-one" onCompose={vi.fn()}>Reply</NativeMessageActions>);
    fireEvent.click(screen.getByRole('button', { name: 'Open message actions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm reminder with note' }));
    await waitFor(() => expect(wire.api.remind).toHaveBeenCalledWith({ kind: 'private_message', id: 'reply-one' }, '2026-10-01T12:00:00-04:00', 'Bring the document'));
  });
  it('enforces the task writer’s 2000-character limit before sending', async () => {
    render(<ConnectedRecordActions reference={reference} staffAccess language="en" visible renderTrigger={false} />);
    await draft();
    const input = screen.getByRole('textbox', { name: 'Message' });
    expect(input).toHaveAttribute('maxlength', '2000');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Alex' }));
    fireEvent.change(input, { target: { value: 'a'.repeat(2001) } });
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    expect(wire.api.send).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'a'.repeat(2000) } });
    expect(screen.getByRole('button', { name: 'Send message' })).toBeEnabled();
  });
  it('loads a controlled sheet, opens an empty draft, and requires an explicit recipient and send', async () => {
    render(<ConnectedRecordActions reference={reference} staffAccess language="en" visible renderTrigger={false} />);
    await draft();
    expect(screen.getByRole('checkbox', { name: 'Alex' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
    expect(wire.api.send).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Please review.' } });
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Alex' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(wire.api.send).toHaveBeenCalledWith(reference, ['alex'], 'Please review.', expect.any(String)));
  });
  it('discards late recipients when the selected record or acting scope changes', async () => {
    let release;
    wire.api.recipients.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const view = render(<ConnectedRecordActions reference={reference} scopeKey="actor-one" staffAccess language="en" visible renderTrigger={false} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Message…' }));
    await waitFor(() => expect(wire.api.recipients).toHaveBeenCalled());
    view.rerender(<ConnectedRecordActions reference={{ kind: 'task', id: 'task-two' }} scopeKey="actor-two" staffAccess language="en" visible renderTrigger={false} />);
    await act(async () => release({ status: 'available', items: [{ id: 'alex', label: 'Alex' }], nextCursor: null }));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(wire.api.send).not.toHaveBeenCalled();
  });
  it('binds retry ids to the unchanged draft and clears a draft after access is withdrawn', async () => {
    wire.api.send.mockRejectedValue(new Error('network'));
    render(<ConnectedRecordActions reference={reference} staffAccess language="en" visible renderTrigger={false} />);
    await draft(); fireEvent.click(screen.getByRole('checkbox', { name: 'Alex' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'First draft' } });
    for (let count = 1; count <= 2; count += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
      await waitFor(() => expect(wire.api.send).toHaveBeenCalledTimes(count));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).not.toBeDisabled());
    }
    expect(wire.api.send.mock.calls[0][3]).toBe(wire.api.send.mock.calls[1][3]);
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Changed draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(wire.api.send).toHaveBeenCalledTimes(3));
    expect(wire.api.send.mock.calls[2][3]).not.toBe(wire.api.send.mock.calls[0][3]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).not.toBeDisabled());
    wire.api.context.mockResolvedValue({ available: false });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
    expect(wire.api.send).toHaveBeenCalledTimes(3);
  });
});
