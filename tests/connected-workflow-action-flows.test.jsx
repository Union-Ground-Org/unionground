import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectedRecordActions } from '../src/features/connectedWorkflows/ConnectedRecordActions.jsx';
import { ConnectedReminders } from '../src/features/connectedWorkflows/ConnectedReminders.jsx';

const selectedTime = vi.hoisted(() => new Date(Date.now() + 7 * 86400000).toISOString());
vi.mock('../src/components/ReminderTimePicker.jsx', () => ({ ReminderTimePicker: ({ onConfirm, onCancel, busy }) => <div><button disabled={busy} onClick={() => onConfirm(selectedTime)}>Confirm selected time</button><button onClick={onCancel}>Dismiss time chooser</button></div> }));
const reference = { kind: 'task', id: 'task-1' };
const base = { available: true, reference, canMessage: true, canRemind: true, sourceLinks: [] };
const client = (context = base) => ({ context: vi.fn().mockResolvedValue(context), recipients: vi.fn().mockResolvedValue({ items: [], nextCursor: null }), createTask: vi.fn().mockResolvedValue({ task: { id: 'linked' } }), remind: vi.fn().mockResolvedValue({}), send: vi.fn().mockResolvedValue({}) });
async function click(name, root = screen) { const button = await root.findByRole('button', { name }); await waitFor(() => expect(button).toBeEnabled()); fireEvent.click(button); }
async function open() { await click('Actions'); }

describe('connected actions across task, reminder and source handoffs', () => {
  it('creates one linked task and subsequently opens that exact task', async () => {
    const api = client({ ...base, canCreateTask: true }); const openTask = vi.fn();
    api.createTask.mockImplementation(async () => { api.context.mockResolvedValue({ ...base, linkedTask: { id: 'linked' } }); return { task: { id: 'linked' } }; });
    render(<ConnectedRecordActions reference={reference} api={api} staffAccess onOpenTask={openTask} />);
    await open(); await click('Create follow-up task');
    await click('Open linked task');
    expect(api.createTask).toHaveBeenCalledTimes(1); await waitFor(() => expect(openTask).toHaveBeenCalledWith({ id: 'linked' }, reference));
    await click('Actions'); expect(screen.queryByRole('button', { name: 'Open linked task' })).not.toBeInTheDocument();
  });
  it('rechecks an original source before navigation and refuses a removed source', async () => {
    const source = { kind: 'private_message', id: 'message' };
    const api = client({ ...base, sourceLinks: [{ reference: source, label: 'Selected message' }] }); const navigate = vi.fn();
    render(<ConnectedRecordActions reference={reference} api={api} onNavigate={navigate} />);
    await open(); await click('Open source');
    api.context.mockResolvedValueOnce({ available: false }); await click('Selected message');
    await screen.findByText('This item is no longer available.'); expect(navigate).not.toHaveBeenCalled();
    api.context.mockResolvedValueOnce({ available: true, href: '/m/messages?message=message' }); await click('Selected message');
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/m/messages?message=message', expect.objectContaining({ available: true })));
  });
  it('opens a task discussion without sending a message', async () => {
    const api = client({ ...base, discussionHref: '/m/messages?task=task-1' }); const navigate = vi.fn();
    render(<ConnectedRecordActions reference={reference} api={api} onNavigate={navigate} />);
    await open(); await click('Open discussion');
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/m/messages?task=task-1', expect.any(Object))); expect(api.send).not.toHaveBeenCalled();
  });
  it('opens an event discussion with an explicit event identity', async () => {
    const event = { kind: 'event', id: 'event' }; const api = client({ ...base, reference: event, contactRole: 'participant', discussionHref: '/m/events?event=event&discussion=1' });
    api.eventMessages = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    render(<ConnectedRecordActions reference={event} api={api} />); await open(); await click('Open discussion');
    await waitFor(() => expect(api.eventMessages).toHaveBeenCalledWith('event', null));
    await screen.findByText('No messages in this discussion.');
  });
  it('requires time confirmation, permits dismissal and refuses a reminder after permission is lost', async () => {
    const api = client(); const notice = vi.fn(); render(<ConnectedRecordActions reference={reference} api={api} onNotice={notice} />);
    await open(); await click('Remind me…'); expect(api.remind).not.toHaveBeenCalled(); await click('Dismiss time chooser');
    await click('Remind me…'); await click('Confirm selected time');
    await waitFor(() => expect(api.remind).toHaveBeenCalledWith(reference, selectedTime)); await waitFor(() => expect(notice).toHaveBeenCalledWith('Reminder set.'));
    await click('Remind me…'); api.context.mockResolvedValue({ ...base, canRemind: false }); await click('Confirm selected time');
    await screen.findByText('This item is no longer available.'); expect(api.remind).toHaveBeenCalledTimes(1);
  });
  it('shows cancelled or unavailable actions without falling back to a default action', async () => {
    const api = client({ available: true, cancelled: true }); const view = render(<ConnectedRecordActions reference={reference} api={api} />);
    await open(); await screen.findByText('This meeting is cancelled.'); expect(screen.getByText('No actions are available.')).toBeInTheDocument();
    view.rerender(<ConnectedRecordActions reference={reference} api={null} />); expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
  it('clears a draft on an authorization error and offers a fresh retry', async () => {
    const api = client(); api.recipients.mockRejectedValueOnce({ code: 'organizer_changed' });
    render(<ConnectedRecordActions reference={reference} api={api} />); await open(); await click('Message…');
    await screen.findByRole('alert'); expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    await click('Try again'); await click('Message…'); await screen.findByText('No authorized recipients are available.');
    await click('Cancel'); expect(api.send).not.toHaveBeenCalled();
  });
  it('does not open a draft when the audience read is refused', async () => {
    const api = client(); api.recipients.mockResolvedValue({ status: 'unavailable', items: [] });
    render(<ConnectedRecordActions reference={reference} api={api} />); await open(); await click('Message…');
    await screen.findByText('This item is no longer available.'); expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
  it('drops a late context after leaving the selected record', async () => {
    let finish; const api = client(); api.context.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const view = render(<ConnectedRecordActions reference={reference} api={api} />); await open(); view.unmount();
    await act(async () => finish(base)); expect(api.send).not.toHaveBeenCalled();
  });
});

describe('reminder owner actions and paging', () => {
  it('marks the reminder list ready only after its delayed read paints the source rows', async () => {
    let resolve;
    const api = { listReminders: vi.fn(() => new Promise((yes) => { resolve = yes; })) };
    const view = render(<ConnectedReminders api={api} scopeKey="a" />);
    const list = view.container.querySelector('.connected-reminders');
    expect(list).toHaveAttribute('data-load-state', 'idle');
    await click('Load reminders');
    expect(list).toHaveAttribute('data-load-state', 'loading');
    expect(list).not.toHaveAttribute('aria-busy');
    await act(async () => resolve({ items: [{ id: 'one', kind: 'private_message', sourceId: 'message-one', status: 'scheduled', remindAt: selectedTime }], nextCursor: null }));
    expect(list).toHaveAttribute('data-load-state', 'ready');
    expect(list).not.toHaveAttribute('aria-busy');
    expect(list.querySelector('article')).toHaveAttribute('data-source-id', 'message-one');
  });

  const row = (id, kind = 'task') => ({ id, kind, sourceId: `source-${id}`, status: 'scheduled', remindAt: '2026-10-01T12:00:00-04:00' });
  it('deduplicates pages, opens the reauthorized source, snoozes and cancels', async () => {
    const api = { listReminders: vi.fn().mockResolvedValueOnce({ items: [row('one')], nextCursor: 'next' }).mockResolvedValueOnce({ items: [row('one'), row('two', 'event')], nextCursor: null }), updateReminder: vi.fn().mockResolvedValue({ available: true, href: '/m/tasks?task=one' }) };
    const navigate = vi.fn(); render(<ConnectedReminders api={api} scopeKey="a" onNavigate={navigate} />);
    await click('Load reminders'); await click('More reminders');
    await screen.findByRole('heading', { name: 'Calendar event' }); expect(screen.getAllByRole('button', { name: 'Open original' })).toHaveLength(2);
    const task = within(screen.getByRole('heading', { name: 'Task' }).closest('article'));
    expect(screen.getByRole('heading', { name: 'Task' }).closest('article')).toHaveAttribute('data-source-kind', 'task');
    expect(screen.getByRole('heading', { name: 'Task' }).closest('article')).toHaveAttribute('data-source-id', 'source-one');
    await click('Open original', task); await waitFor(() => expect(navigate).toHaveBeenCalledWith('/m/tasks?task=one', expect.any(Object)));
    await click('Snooze…', task); await click('Dismiss time chooser', task); await click('Snooze…', task); await click('Confirm selected time', task);
    await waitFor(() => expect(api.updateReminder).toHaveBeenCalledWith('one', 'snooze', selectedTime));
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Task' }).closest('article').querySelector('time')).toHaveAttribute('dateTime', selectedTime));
    await click('Cancel reminder', task); await waitFor(() => expect(screen.queryByRole('heading', { name: 'Task' })).not.toBeInTheDocument());
    expect(api.listReminders).toHaveBeenLastCalledWith('next');
  });
  it('keeps a failed mutation visible and retries an interrupted list load', async () => {
    const api = { listReminders: vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue({ items: [row('one', 'private_message')], nextCursor: null }), updateReminder: vi.fn().mockRejectedValue(new Error('network')) };
    render(<ConnectedReminders api={api} scopeKey="a" />); await click('Load reminders'); await screen.findByRole('alert'); await click('Load reminders');
    await click('Cancel reminder'); await screen.findByRole('alert'); expect(screen.getByRole('heading', { name: 'Message' })).toBeInTheDocument();
  });
  it('ignores a late list after the acting scope is replaced', async () => {
    let finish; const api = { listReminders: vi.fn().mockImplementation(() => new Promise(resolve => { finish = resolve; })) };
    const view = render(<ConnectedReminders api={api} scopeKey="a" />); await click('Load reminders'); view.rerender(<ConnectedReminders api={api} scopeKey="b" />);
    await act(async () => finish({ items: [row('one')], nextCursor: null })); expect(screen.queryByRole('heading', { name: 'Task' })).not.toBeInTheDocument();
    view.rerender(<ConnectedReminders api={null} scopeKey="b" />); expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });
});
