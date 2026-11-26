import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectedEventLanding } from '../src/features/connectedWorkflows/ConnectedEventLanding.jsx';
import { loadAuthorizedCalendarEvent } from '../src/lib/memberApi.js';

const show = (data) => <ul>{data.events.map((event) => <li key={event.id}>{event.title}{event.cancelledAt ? ' — Cancelled' : ''}</li>)}</ul>;
describe('exact authorized event arrival', () => {
  it('keeps ordinary discovery unchanged when no exact event was requested', () => {
    const load = vi.fn();
    render(<ConnectedEventLanding data={{ events: [{ id: 'one', title: 'Discovery event' }] }} scopeKey="member" loadEvent={load}>{show}</ConnectedEventLanding>);
    expect(screen.getByText('Discovery event')).toBeInTheDocument(); expect(load).not.toHaveBeenCalled();
  });
  it('replaces a cached event with a fresh authorized read and preserves other ordinary discovery rows', async () => {
    const load = vi.fn().mockResolvedValue({ id: 'one', title: 'Fresh event' });
    render(<ConnectedEventLanding data={{ events: [{ id: 'one', title: 'Stale event' }, { id: 'two', title: 'Other event' }] }} requestedId="one" scopeKey="member" loadEvent={load}>{show}</ConnectedEventLanding>);
    await screen.findByText('Fresh event'); expect(screen.getByText('Other event')).toBeInTheDocument(); expect(screen.queryByText('Stale event')).not.toBeInTheDocument();
  });
  it('lets an interrupted read retry without showing the cached source', async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue({ id: 'one', title: 'Recovered event' });
    render(<ConnectedEventLanding data={{}} requestedId="one" scopeKey="member" loadEvent={load}>{show}</ConnectedEventLanding>);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    await screen.findByText('Recovered event'); expect(load).toHaveBeenCalledTimes(2);
  });
  it('projects only the authorized event when a staff link grants no general Events entrance', async () => {
    const load = vi.fn().mockResolvedValue({ id: 'selected', title: 'Selected event' });
    render(<ConnectedEventLanding data={{ events: [{ id: 'other', title: 'Other cached event' }] }} requestedId="selected" scopeKey="staff" loadEvent={load} selectedOnly>{show}</ConnectedEventLanding>);
    await screen.findByText('Selected event');
    expect(screen.queryByText('Other cached event')).not.toBeInTheDocument();
  });
  it('loads a cancelled event outside the discovery window and clears it after access is lost', async () => {
    const load = vi.fn().mockResolvedValue({ id: 'older', title: 'Earlier event', cancelledAt: '2026-09-28T12:00:00-04:00' });
    const view = render(<ConnectedEventLanding data={{ events: [] }} requestedId="older" scopeKey="member" loadEvent={load}>{show}</ConnectedEventLanding>);
    await screen.findByText('Earlier event — Cancelled');
    expect(load).toHaveBeenCalledWith('older');
    load.mockResolvedValue(null);
    view.rerender(<ConnectedEventLanding data={{ events: [] }} requestedId="older" scopeKey="member" loadEvent={load}>{show}</ConnectedEventLanding>);
    await screen.findByRole('alert');
    expect(screen.queryByText('Earlier event — Cancelled')).not.toBeInTheDocument();
  });
  it('discards an outstanding read from the prior identity', async () => {
    let resolve;
    const load = vi.fn().mockImplementationOnce(() => new Promise((done) => { resolve = done; })).mockResolvedValue({ id: 'next', title: 'Current event' });
    const view = render(<ConnectedEventLanding data={{ events: [] }} requestedId="old" scopeKey="a" loadEvent={load}>{show}</ConnectedEventLanding>);
    await waitFor(() => expect(load).toHaveBeenCalled());
    view.rerender(<ConnectedEventLanding data={{ events: [] }} requestedId="next" scopeKey="b" loadEvent={load}>{show}</ConnectedEventLanding>);
    await screen.findByText('Current event');
    await act(async () => resolve({ id: 'old', title: 'Private old event' }));
    expect(screen.queryByText('Private old event')).not.toBeInTheDocument();
  });
  it('reads only the selected event and the caller’s own attendance without inferring contact consent', async () => {
    const responses = {
      member_events: { data: { id: 'event', chapter_id: 'chapter', starts_at: '2026-10-01T12:00:00-04:00', cancelled_at: '2026-09-28T12:00:00-04:00' } },
      member_event_rsvps: { data: { status: 'going' } }, member_event_checkins: { data: null },
    };
    const queries = {};
    const client = { from: vi.fn((table) => {
      const q = { select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn().mockResolvedValue(responses[table]) };
      q.select.mockReturnValue(q); q.eq.mockReturnValue(q); queries[table] = q; return q;
    }) };
    const result = await loadAuthorizedCalendarEvent(client, 'event', 'caller');
    expect(result).toMatchObject({ id: 'event', rsvpStatus: 'going', checkedIn: false, cancelledAt: '2026-09-28T12:00:00-04:00' });
    expect(result).not.toHaveProperty('contactOptIn');
    expect(queries.member_events.eq).toHaveBeenCalledWith('id', 'event');
    for (const name of ['member_event_rsvps', 'member_event_checkins']) {
      expect(queries[name].eq).toHaveBeenCalledWith('event_id', 'event');
      expect(queries[name].eq).toHaveBeenCalledWith('user_id', 'caller');
    }
    responses.member_events = { data: null };
    await expect(loadAuthorizedCalendarEvent(client, 'event', 'caller')).rejects.toThrow('Event unavailable');
  });
});
