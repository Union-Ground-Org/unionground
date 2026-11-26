import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectedRecordActions } from '../src/features/connectedWorkflows/ConnectedRecordActions.jsx';
import { ConnectedReminders } from '../src/features/connectedWorkflows/ConnectedReminders.jsx';
import { expectHeldWriteFocus, expectOneWriteFromOneTick } from './helpers/busyWriteFocus.js';

const reference = { kind: 'task', id: 'task-1', chapterId: 'chapter-1' };
const context = { available: true, canMessage: true, canRemind: true, sourceLinks: [], href: '/m/tasks?task=task-1' };
const setup = (overrides = {}) => ({
  context: vi.fn().mockResolvedValue(context),
  recipients: vi.fn().mockResolvedValue({ items: [{ id: 'person-1', label: 'Alex' }], nextCursor: null }),
  send: vi.fn().mockResolvedValue({ sent: true }), remind: vi.fn().mockResolvedValue({}), ...overrides,
});
async function openMessage() {
  fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Message…' }));
  await screen.findByRole('checkbox', { name: 'Alex' });
}

describe('connected drafts and record lifetime', () => {
  it('shows distinct reminder source titles, member notes and honest missing-source fallbacks', async () => {
    const api = setup({ listReminders: vi.fn().mockResolvedValue({ items: [
      { id: 'shift', kind: 'event', status: 'scheduled', remindAt: '2027-01-01T17:00:00Z', available: true, title: 'Quillmere shift meeting', note: 'Bring the schedule proposal' },
      { id: 'safety', kind: 'event', status: 'scheduled', remindAt: '2027-01-01T17:00:00Z', available: true, title: 'Quillmere safety meeting', note: 'Bring the inspection notes' },
      { id: 'removed', kind: 'event', status: 'scheduled', remindAt: '2027-01-01T17:00:00Z', available: false, title: 'Stale title', note: 'My retained note' },
      { id: 'untitled', kind: 'event', status: 'scheduled', remindAt: '2027-01-01T17:00:00Z', available: true, title: null, note: '' },
    ], nextCursor: null }) });
    render(<ConnectedReminders api={api} scopeKey="member-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Load reminders' }));
    const cards = await screen.findAllByRole('article');
    expect(within(cards[0]).getByText('Quillmere shift meeting')).toBeInTheDocument();
    expect(within(cards[0]).getByText('Bring the schedule proposal')).toBeInTheDocument();
    expect(within(cards[1]).getByText('Quillmere safety meeting')).toBeInTheDocument();
    expect(within(cards[1]).getByText('Bring the inspection notes')).toBeInTheDocument();
    expect(within(cards[2]).getByText('Original unavailable')).toBeInTheDocument();
    expect(within(cards[2]).getByText('My retained note')).toBeInTheDocument();
    expect(within(cards[3]).getByText('Reminder')).toBeInTheDocument();
    expect(screen.queryByText('Stale title')).not.toBeInTheDocument();
  });

  it('opens an empty editable draft, selects no recipients, and sends only after explicit confirmation', async () => {
    const api = setup();
    render(<ConnectedRecordActions reference={reference} api={api} />);
    await openMessage();
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
    expect(screen.getByRole('checkbox', { name: 'Alex' })).not.toBeChecked();
    expect(api.send).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Please review this task.' } });
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Alex' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(api.send).toHaveBeenCalledWith(reference, ['person-1'], 'Please review this task.', expect.any(String)));
    expect(api.send).toHaveBeenCalledTimes(1);
  });

  it('reuses the send request on an unchanged retry and binds a new request to an edited draft', async () => {
    const api = setup({ send: vi.fn().mockRejectedValue(new Error('network interrupted')) });
    render(<ConnectedRecordActions reference={reference} api={api} />); await openMessage();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Alex' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Original draft' } });
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
      await waitFor(() => expect(api.send).toHaveBeenCalledTimes(attempt));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Send message' })).not.toBeDisabled());
    }
    expect(api.send.mock.calls[1][3]).toBe(api.send.mock.calls[0][3]);
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Edited draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(3));
    expect(api.send.mock.calls[2][3]).not.toBe(api.send.mock.calls[0][3]);
  });

  it('rechecks access at send and clears a draft when membership has changed', async () => {
    const api = setup(); render(<ConnectedRecordActions reference={reference} api={api} />);
    await openMessage();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Alex' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Private draft' } });
    api.context.mockResolvedValue({ available: false });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await screen.findByText('This item is no longer available.');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(api.send).not.toHaveBeenCalled();
  });

  it('does not transfer late recipients to another selected record', async () => {
    let finish;
    const api = setup({ recipients: vi.fn().mockImplementation(() => new Promise((resolve) => { finish = resolve; })) });
    const mounted = render(<ConnectedRecordActions reference={reference} api={api} />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Message…' }));
    await waitFor(() => expect(api.recipients).toHaveBeenCalled());
    mounted.rerender(<ConnectedRecordActions reference={{ ...reference, id: 'task-2' }} api={api} />);
    await act(async () => finish({ items: [{ id: 'person-1', label: 'Alex' }], nextCursor: null }));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Actions' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('does not select recipients when another page loads', async () => {
    const api = setup({ recipients: vi.fn().mockResolvedValueOnce({ items: [{ id: 'person-1', label: 'Alex' }], nextCursor: 'page-2' }).mockResolvedValueOnce({ items: [{ id: 'person-2', label: 'Sam' }], nextCursor: null }) });
    render(<ConnectedRecordActions reference={reference} api={api} />); await openMessage();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Alex' }));
    fireEvent.click(screen.getByRole('button', { name: 'More recipients' }));
    expect(await screen.findByRole('checkbox', { name: 'Sam' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Alex' })).toBeChecked();
  });
  it('clears the old recipient list when authorization is lost during pagination', async () => {
    const api = setup({ recipients: vi.fn().mockResolvedValueOnce({ items: [{ id: 'person-1', label: 'Alex' }], nextCursor: 'page-2' }).mockResolvedValueOnce({ status: 'unavailable', items: [], nextCursor: null }) });
    render(<ConnectedRecordActions reference={reference} api={api} />); await openMessage();
    fireEvent.click(screen.getByRole('button', { name: 'More recipients' }));
    await screen.findByText('This item is no longer available.');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(api.send).not.toHaveBeenCalled();
  });

  // The reminders' synchronous `working` ref refuses a second row
  // action started in the same tick, and Complete keeps focus while it runs.
  it('completes a reminder once when Complete is activated twice in one tick, and keeps it focused', async () => {
    const items = [{ id: 'r1', kind: 'private_message', status: 'scheduled', remindAt: '2027-01-01T17:00:00Z', available: true }];
    const api = setup({ listReminders: vi.fn().mockResolvedValue({ items, nextCursor: null }), updateReminder: vi.fn(async () => ({ available: true })) });
    render(<ConnectedReminders api={api} scopeKey="member-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Load reminders' }));
    const complete = await screen.findByRole('button', { name: 'Complete' });
    await expectOneWriteFromOneTick(api.updateReminder, [() => fireEvent.click(complete), () => fireEvent.click(complete)]);
    expect(api.updateReminder).toHaveBeenCalledExactlyOnceWith('r1', 'complete', null);
  });

  it('keeps Complete focused while the reminder is completed', async () => {
    const items = [{ id: 'r1', kind: 'private_message', status: 'scheduled', remindAt: '2027-01-01T17:00:00Z', available: true }];
    const api = setup({ listReminders: vi.fn().mockResolvedValue({ items, nextCursor: null }), updateReminder: vi.fn(async () => ({ available: true })) });
    render(<ConnectedReminders api={api} scopeKey="member-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Load reminders' }));
    await expectHeldWriteFocus(api.updateReminder, await screen.findByRole('button', { name: 'Complete' }));
    expect(api.updateReminder).toHaveBeenCalledTimes(1);
  });

  it('rechecks a reminder through its owner endpoint and allows completing a removed source', async () => {
    const api = setup({ listReminders: vi.fn().mockResolvedValue({ items: [{ id: 'r1', kind: 'private_message', status: 'scheduled', remindAt: '2027-01-01T17:00:00Z', available: false }], nextCursor: null }), updateReminder: vi.fn().mockResolvedValue({ available: false }) });
    const navigate = vi.fn(); render(<ConnectedReminders api={api} scopeKey="member-1" onNavigate={navigate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Load reminders' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open original' }));
    await screen.findByText('The original item is no longer available.');
    expect(api.updateReminder).toHaveBeenCalledWith('r1', 'open'); expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Complete' }));
    await waitFor(() => expect(api.updateReminder).toHaveBeenCalledWith('r1', 'complete', null));
    expect(await screen.findByText('No active reminders.')).toBeInTheDocument();
  });
});

// REQ-UG-FIRST-CLICK-AND-DEAD-CONTROLS-20261030: on a meeting near the
// bottom of the events list the panel opened below the window, so Actions
// looked like it opened nothing. The panel is brought into view when it opens
// and once its choices arrive, and later work in it never moves the page.
describe('connected actions panel stays in sight', () => {
  it('scrolls the opened panel into view on open and when its choices load, then leaves the page alone', async () => {
    const scrolled = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function scrollIntoView(options) { scrolled.push({ id: this.id, options }); };
    try {
      let resolveContext;
      const api = setup({ context: vi.fn().mockImplementationOnce(() => new Promise((resolve) => { resolveContext = resolve; })).mockResolvedValue(context) });
      render(<ConnectedRecordActions reference={{ ...reference, kind: 'event', id: 'event-1' }} api={api} />);
      const trigger = screen.getByRole('button', { name: 'Actions' });
      fireEvent.click(trigger);
      const panelId = trigger.getAttribute('aria-controls');
      expect(scrolled).toEqual([{ id: panelId, options: { block: 'nearest' } }]);
      await act(async () => { resolveContext(context); });
      await screen.findByRole('button', { name: 'Message…' });
      expect(scrolled).toHaveLength(2);
      expect(scrolled[1]).toEqual({ id: panelId, options: { block: 'nearest' } });
      fireEvent.click(screen.getByRole('button', { name: 'Message…' }));
      await screen.findByRole('checkbox', { name: 'Alex' });
      expect(scrolled).toHaveLength(2);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});
