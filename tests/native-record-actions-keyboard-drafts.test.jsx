import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connectedRecordActions } from '../src/features/connectedWorkflows/actions.js';

// BUG-UG-NATIVE-IOS-TASK-DISCUSSION-KEYBOARD-COVERS-SEND-20261111: in a
// task discussion on iPhone the keyboard covered "Send message", "Open
// discussion" left the actions sheet over the conversation, and closing the
// sheet lost the unsent draft. The real sheet is mounted with native drawing,
// the workflow API and the router boundary replaced.
const wire = vi.hoisted(() => ({ api: null, sequence: 0 }));
vi.mock('../apps/mobile/src/state/AppProvider', () => ({useApp: () => ({session: null})}));
vi.mock('../apps/mobile/src/lib/connectedWorkflows', () => ({
  connectedWorkflowApi: () => wire.api,
  recordActions: (context, options) => connectedRecordActions(context, options),
  newConnectedRequestId: () => `request-${++wire.sequence}`,
  retainRecipients: (selected, people) => selected.filter((id) => people.some((person) => person.id === id)),
  CONNECTED_MESSAGE_LIMITS: { maxBody: 4000, maxRecipients: 12 },
}));
vi.mock('../apps/mobile/src/theme/ThemeProvider', () => ({ useTheme: () => ({ background: '#fff', foreground: '#111', input: '#fff', border: '#777', primary: '#155f40', primaryForeground: '#fff', mutedForeground: '#444', popover: '#fff', destructive: '#800' }) }));
vi.mock('../apps/mobile/src/components/EventDiscussionReader', () => ({ EventDiscussionReader: () => null }));
// The follow-up task form reads through the native Supabase client; its own
// suite is apps/mobile/src/components/eventFollowUpTask.screen.test.tsx.
vi.mock('../apps/mobile/src/components/ConnectedTaskEditor', () => ({ ConnectedTaskEditor: () => null }));
vi.mock('../apps/mobile/src/lib/screenReader', () => ({ useScreenReader: () => false, useScreenReaderKnownOff: () => true }));
vi.mock('../apps/mobile/src/services/haptics', () => ({ haptics: { select: vi.fn(), success: vi.fn(), warning: vi.fn() } }));
vi.mock('../apps/mobile/src/components/ReminderPicker', () => ({ ReminderPicker: () => null }));
vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('react-native', async () => {
  const React = await import('react');
  const box = (tag, marker) => ({ children, accessibilityLabel, accessibilityRole, behavior }) => React.createElement(tag, {
    'aria-label': accessibilityLabel,
    role: accessibilityRole === 'header' ? 'heading' : accessibilityRole === 'alert' ? 'alert' : undefined,
    'data-part': marker,
    'data-behavior': behavior,
  }, children);
  return {
    Platform: { OS: 'ios' },
    // #9963: the composer announces its status lines through the app's queue on iOS.
    AccessibilityInfo: { announceForAccessibility: () => {}, announceForAccessibilityWithOptions: () => {} },
    View: box('div'), Text: box('div'), ScrollView: box('div', 'scroll'), KeyboardAvoidingView: box('section', 'keyboard-avoiding'),
    StyleSheet: { create: (value) => value, hairlineWidth: 1, absoluteFill: {} },
    Modal: ({ children, visible }) => visible ? React.createElement('div', { role: 'dialog' }, children) : null,
    Pressable: ({ children, onPress, disabled, accessibilityRole, accessibilityLabel, accessibilityState }) => React.createElement('button', { onClick: onPress, disabled, role: accessibilityRole, 'aria-label': accessibilityLabel, 'aria-checked': accessibilityState?.checked }, children),
    TextInput: ({ value, onChangeText, editable, accessibilityLabel, maxLength }) => React.createElement('textarea', { value, maxLength, onChange: (event) => onChangeText(event.target.value), disabled: editable === false, 'aria-label': accessibilityLabel }),
  };
});
import { ConnectedRecordActions } from '../apps/mobile/src/components/ConnectedRecordActions';

const reference = { kind: 'task_message', id: 'message-one' };
const context = { available: true, canMessage: true, canRemind: true, linkedTask: null, sourceLinks: [], reference, discussionHref: '/m/messages?taskThread=5b0d6c2e-7f41-4c39-9a52-1f3e8d7c6b10' };
const scope = '["user-one","org","tamarack-eastgate",["coordinator"],null]';

beforeEach(() => {
  wire.api = {
    context: vi.fn().mockResolvedValue(context),
    recipients: vi.fn().mockResolvedValue({ status: 'available', items: [{ id: 'alex', label: 'Alex' }], nextCursor: null }),
    send: vi.fn().mockResolvedValue({}),
  };
});

const sheet = (props = {}) => <ConnectedRecordActions reference={reference} scopeKey={scope} recordTitle="Posting photo" staffAccess language="en" {...props} />;
const openSheet = () => fireEvent.click(screen.getByRole('button', { name: 'Task actions: Posting photo' }));
async function openComposer() {
  fireEvent.click(await screen.findByRole('button', { name: 'Message…' }));
  await screen.findByRole('checkbox', { name: 'Alex' });
}

describe('task discussion composer on iPhone', () => {
  it('keeps the composer and Send above the keyboard: the sheet avoids the keyboard and Send sits outside the scrolling body', async () => {
    render(sheet());
    openSheet();
    await openComposer();
    const send = screen.getByRole('button', { name: 'Send message' });
    const avoiding = send.closest('[data-part="keyboard-avoiding"]');
    expect(avoiding).not.toBeNull();
    expect(avoiding).toHaveAttribute('data-behavior', 'padding');
    expect(send.closest('[data-part="scroll"]')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Message' }).closest('[data-part="keyboard-avoiding"]')).toBe(avoiding);
  });

  it('keeps an unsent draft through closing and reopening the sheet, and clears it once sent', async () => {
    const { unmount } = render(sheet());
    openSheet();
    await openComposer();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'I can post it Thursday.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    unmount();

    render(sheet());
    openSheet();
    await openComposer();
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('I can post it Thursday.');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Alex' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(wire.api.send).toHaveBeenCalledWith(reference, ['alex'], 'I can post it Thursday.', 'request-1'));
    await openComposer();
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
  });

  // BUG-UG-NATIVE-RECORD-SHEET-CLOSE-DURING-SEND-CHECK-DELETES-DRAFT-20261115 (#8773).
  it('keeps the draft when the sheet closes while Send is still checking, and offers it next time', async () => {
    const { unmount } = render(sheet());
    openSheet();
    await openComposer();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Closing before the check returns.' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Alex' }));
    let answer;
    wire.api.context.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(answer).toBeTypeOf('function'));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    answer(context);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(wire.api.send).not.toHaveBeenCalled();
    unmount();

    render(sheet());
    openSheet();
    await openComposer();
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Closing before the check returns.');
  });

  it('still discards the draft when the send check says the member can no longer message', async () => {
    const { unmount } = render(sheet());
    openSheet();
    await openComposer();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Access is about to change.' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Alex' }));
    wire.api.context.mockResolvedValueOnce({ ...context, canMessage: false });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Message' })).toBeNull());
    expect(wire.api.send).not.toHaveBeenCalled();
    unmount();

    render(sheet());
    openSheet();
    await openComposer();
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
  });

  it('never carries a draft into another signed-in scope', async () => {
    const { unmount } = render(sheet());
    openSheet();
    await openComposer();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Private draft' } });
    unmount();
    render(sheet({ scopeKey: '["user-two","org","tamarack-eastgate",["member"],null]' }));
    openSheet();
    await openComposer();
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
  });

  it('closes the actions sheet when "Open discussion" opens the conversation', async () => {
    const onNavigate = vi.fn();
    render(sheet({ onNavigate }));
    openSheet();
    fireEvent.click(await screen.findByRole('button', { name: 'Open discussion' }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('/task-conversation/5b0d6c2e-7f41-4c39-9a52-1f3e8d7c6b10'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('stays open with its notice when the destination cannot be opened', async () => {
    const onNavigate = vi.fn(() => { throw new Error('Destination unavailable'); });
    render(sheet({ onNavigate }));
    openSheet();
    fireEvent.click(await screen.findByRole('button', { name: 'Open discussion' }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalled());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});
