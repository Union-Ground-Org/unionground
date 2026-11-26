import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EventContactSettings } from '../src/features/connectedWorkflows/EventContactSettings.jsx';
import { EventDiscussion } from '../src/features/connectedWorkflows/EventDiscussion.jsx';
import { LanguageProvider } from '../src/lib/LanguageContext.jsx';

const reference = { kind: 'event', id: 'event-1' };
const context = { available: true, canManageOrganizer: true, canContactOptIn: true, contactOptIn: false, organizer: { id: 'organizer-1', label: 'Alex' } };
const api = () => ({
  eventOrganizerCandidates: vi.fn().mockResolvedValue({ items: [{ id: 'organizer-1', label: 'Alex' }], nextCursor: null }),
  setEventOrganizer: vi.fn().mockResolvedValue({}), setEventContactOptIn: vi.fn().mockResolvedValue({}),
  recipients: vi.fn().mockResolvedValue({ items: [{ id: 'participant-1', label: 'Sam' }], nextCursor: null }),
  eventMessages: vi.fn().mockResolvedValue({ items: [{ id: 'm1', mine: false, senderRole: 'participant', body: 'Can we meet at the accessible entrance?', createdAt: '2026-09-29T13:00:00Z' }], nextCursor: null }),
});
const run = (work) => work();

describe('event organizer and attendee consent', () => {
  it('pages organizer candidates without duplicating an existing choice', async () => {
    const client = api();
    client.eventOrganizerCandidates.mockResolvedValueOnce({ items: [{ id: 'organizer-1', label: 'Alex' }], nextCursor: 'next' }).mockResolvedValueOnce({ items: [{ id: 'organizer-1', label: 'Alex' }, { id: 'organizer-2', label: 'Pat' }], nextCursor: null });
    render(<EventContactSettings reference={reference} context={context} api={client} staffAccess run={run} refresh={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose organizer' })); fireEvent.click(await screen.findByRole('button', { name: 'More organizers' }));
    await screen.findByRole('option', { name: 'Pat' }); expect(screen.getAllByRole('option', { name: 'Alex' })).toHaveLength(1);
    expect(client.eventOrganizerCandidates).toHaveBeenLastCalledWith('event-1', 'next');
    expect(client.setEventOrganizer).not.toHaveBeenCalled();
  });
  it('withdraws existing contact consent only after Save', async () => {
    const client = api(); render(<EventContactSettings reference={reference} context={{ ...context, contactOptIn: true }} api={client} run={run} refresh={vi.fn()} />);
    expect(screen.getByRole('checkbox')).toBeChecked(); fireEvent.click(screen.getByRole('checkbox')); expect(client.setEventContactOptIn).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save contact preference' }));
    await waitFor(() => expect(client.setEventContactOptIn).toHaveBeenCalledWith('event-1', false, 'organizer-1'));
  });
  it('requires separate selection and save to change the organizer', async () => {
    const client = api();
    const onNotice = vi.fn();
    render(<EventContactSettings reference={reference} context={{ ...context, organizer: null }} api={client} staffAccess run={run} refresh={vi.fn()} onNotice={onNotice} />);
    expect(client.eventOrganizerCandidates).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Choose organizer' }));
    const select = await screen.findByRole('combobox', { name: 'Organizer' });
    expect(select).toHaveValue(''); expect(client.setEventOrganizer).not.toHaveBeenCalled();
    fireEvent.change(select, { target: { value: 'organizer-1' } });
    expect(client.setEventOrganizer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save organizer' }));
    await waitFor(() => expect(client.setEventOrganizer).toHaveBeenCalledWith('event-1', 'organizer-1', null));
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith('Organizer setting saved.'));
  });
  it('sends the event version the organizer editor opened with', async () => {
    const client = api();
    render(<EventContactSettings reference={reference} context={{ ...context, organizer: null, eventVersion: 7 }} api={client} staffAccess run={run} refresh={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose organizer' }));
    fireEvent.change(await screen.findByRole('combobox', { name: 'Organizer' }), { target: { value: 'organizer-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save organizer' }));
    await waitFor(() => expect(client.setEventOrganizer).toHaveBeenCalledWith('event-1', 'organizer-1', 7));
  });
  it('does not infer attendee consent from opening the event or changing a checkbox', async () => {
    const client = api();
    render(<EventContactSettings reference={reference} context={context} api={client} run={run} refresh={vi.fn()} />);
    const consent = screen.getByRole('checkbox');
    expect(consent).not.toBeChecked();
    expect(client.setEventContactOptIn).not.toHaveBeenCalled();
    fireEvent.click(consent);
    expect(client.setEventContactOptIn).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save contact preference' }));
    await waitFor(() => expect(client.setEventContactOptIn).toHaveBeenCalledWith('event-1', true, 'organizer-1'));
  });
  it('allows an explicit save of no organizer to revoke the assignment', async () => {
    const client = api();
    render(<EventContactSettings reference={reference} context={{ ...context, organizer: { id: 'organizer-1', label: 'Alex' } }} api={client} staffAccess run={run} refresh={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose organizer' }));
    const select = await screen.findByRole('combobox', { name: 'Organizer' });
    fireEvent.change(select, { target: { value: '' } });
    expect(select.checkValidity()).toBe(true);
    expect(client.setEventOrganizer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save organizer' }));
    await waitFor(() => expect(client.setEventOrganizer).toHaveBeenCalledWith('event-1', null, null));
  });
  // #9470 (W7-22): a save says so next to its button, only after the server accepts it.
  it('says the contact preference was saved, and forgets it on the next change', async () => {
    const client = api();
    render(<EventContactSettings reference={reference} context={context} api={client} run={run} refresh={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('');
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Save contact preference' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Contact preference saved.'));
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('status')).toHaveTextContent('');
  });
  it('keeps the saved line when the event catches up to the saved value, and drops it when the value changes again', async () => {
    const client = api();
    const props = { reference, api: client, run, refresh: vi.fn() };
    const { rerender } = render(<EventContactSettings {...props} context={context} />);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Save contact preference' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Contact preference saved.'));
    rerender(<EventContactSettings {...props} context={{ ...context, contactOptIn: true }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Contact preference saved.');
    rerender(<EventContactSettings {...props} context={{ ...context, contactOptIn: false }} />);
    expect(screen.getByRole('status')).toHaveTextContent('');
  });
  it('says nothing when the save is refused, and speaks Spanish on a Spanish page', async () => {
    const client = api(); client.setEventContactOptIn.mockRejectedValueOnce(new Error('refused'));
    render(<LanguageProvider lang="es"><EventContactSettings reference={reference} context={context} api={client} run={(work) => work().catch(() => {})} refresh={vi.fn()} /></LanguageProvider>);
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'Guardar preferencia de contacto' }));
    await waitFor(() => expect(client.setEventContactOptIn).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('status')).toHaveTextContent('');
    fireEvent.click(screen.getByRole('button', { name: 'Guardar preferencia de contacto' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Preferencia de contacto guardada.'));
  });
  it('does not expose organizer management under the member identity', () => {
    render(<EventContactSettings reference={reference} context={context} api={api()} staffAccess={false} run={run} refresh={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Choose organizer' })).not.toBeInTheDocument();
  });
  it('requires the organizer to choose an authorized participant before reading a discussion', async () => {
    const client = api();
    render(<EventDiscussion reference={reference} context={{ ...context, contactRole: 'organizer' }} api={client} />);
    await screen.findByRole('option', { name: 'Sam' });
    expect(client.eventMessages).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('combobox', { name: 'Participant' }), { target: { value: 'participant-1' } });
    expect(await screen.findByText('Can we meet at the accessible entrance?')).toBeInTheDocument();
    expect(client.eventMessages).toHaveBeenCalledWith('event-1', 'participant-1');
  });
  it('clears already displayed history when a later page refuses access', async () => {
    const client = api();
    client.eventMessages.mockResolvedValueOnce({ items: [{ id: 'm1', mine: false, senderRole: 'organizer', body: 'Private event message', createdAt: '2026-09-29T13:00:00Z' }], nextCursor: 'older' })
      .mockResolvedValueOnce({ available: false, items: [], nextCursor: null });
    render(<EventDiscussion reference={reference} context={{ ...context, contactRole: 'participant' }} api={client} />);
    await screen.findByText('Private event message');
    fireEvent.click(screen.getByRole('button', { name: 'Earlier messages' }));
    await screen.findByRole('alert');
    expect(screen.queryByText('Private event message')).not.toBeInTheDocument();
  });
  it('pages the authorized attendee picker and shows only the selected discussion in chronological order', async () => {
    const client = api();
    client.recipients.mockResolvedValueOnce({ items: [{ id: 'participant-1', label: 'Sam' }], nextCursor: 'people-next' }).mockResolvedValueOnce({ items: [{ id: 'participant-1', label: 'Sam' }, { id: 'participant-2', label: 'Pat' }], nextCursor: null });
    const message = (id, body, extra = {}) => ({ id, body, mine: false, senderRole: 'organizer', createdAt: '2026-10-01T12:00:00-04:00', ...extra });
    client.eventMessages.mockResolvedValueOnce({ items: [message('b', 'Newer', { mine: true })], nextCursor: 'messages-next' }).mockResolvedValueOnce({ items: [message('a', 'Do not display removed words', { redacted: true }), message('b', 'Newer', { mine: true }), message('c', 'Attendee words', { senderRole: 'participant' })], nextCursor: null });
    render(<EventDiscussion reference={reference} context={{ ...context, contactRole: 'organizer' }} api={client} />);
    fireEvent.click(await screen.findByRole('button', { name: 'More participants' })); await screen.findByRole('option', { name: 'Pat' });
    expect(screen.getAllByRole('option', { name: 'Sam' })).toHaveLength(1); expect(client.eventMessages).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('combobox', { name: 'Participant' }), { target: { value: 'participant-2' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Earlier messages' })); await screen.findByText('Message removed');
    expect(screen.getAllByText('Newer')).toHaveLength(1); expect(screen.queryByText('Do not display removed words')).not.toBeInTheDocument();
    expect(screen.getByText('You')).toBeInTheDocument(); expect(screen.getByText('Attendee')).toBeInTheDocument();
    expect(client.eventMessages).toHaveBeenLastCalledWith('event-1', 'participant-2', 'messages-next');
  });
  it('clears an earlier page after a network failure fetching the next one', async () => {
    const client = api(); client.eventMessages.mockResolvedValueOnce({ items: [{ id: 'one', body: 'Earlier private words', mine: false, senderRole: 'organizer', createdAt: '2026-10-01T12:00:00-04:00' }], nextCursor: 'next' }).mockRejectedValueOnce(new Error('network'));
    render(<EventDiscussion reference={reference} context={{ ...context, contactRole: 'participant' }} api={client} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Earlier messages' })); await screen.findByRole('alert'); expect(screen.queryByText('Earlier private words')).not.toBeInTheDocument();
  });
  it.each(['rejected', 'unavailable'])('fails closed when the initial discussion is %s', async (failure) => {
    const client = api(); if (failure === 'rejected') client.eventMessages.mockRejectedValue(new Error('network')); else client.eventMessages.mockResolvedValue({ available: false, items: [] });
    render(<EventDiscussion reference={reference} context={{ ...context, contactRole: 'participant' }} api={client} />);
    await screen.findByRole('alert'); expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });
  it('discards an old event read after navigation changes the exact event', async () => {
    const client = api(); let finish;
    client.eventMessages.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue({ items: [], nextCursor: null });
    const view = render(<EventDiscussion reference={reference} context={{ ...context, contactRole: 'participant' }} api={client} />);
    await waitFor(() => expect(client.eventMessages).toHaveBeenCalled()); view.rerender(<EventDiscussion reference={{ kind: 'event', id: 'new-event' }} context={{ ...context, contactRole: 'participant' }} api={client} />);
    await screen.findByText('No messages in this discussion.');
    await act(async () => finish({ items: [{ id: 'old', body: 'Old private words' }], nextCursor: null })); expect(screen.queryByText('Old private words')).not.toBeInTheDocument();
  });
});
