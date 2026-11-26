import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectedTaskLanding } from '../src/features/connectedWorkflows/ConnectedTaskLanding.jsx';

const show = (data) => <ul>{data.tasks.map((task) => <li key={task.id}>{task.title}</li>)}</ul>;
describe('authorized task arrival outside the board window', () => {
  it('loads the exact task after navigation even when the board window is empty', async () => {
    const load = vi.fn().mockResolvedValue({ id: 'linked', title: 'Authorized follow-up' });
    render(<ConnectedTaskLanding data={{ tasks: [] }} requestedId="linked" scopeKey="member:chapter:steward" loadTask={load}>{show}</ConnectedTaskLanding>);
    expect(screen.getByRole('status')).toHaveTextContent('Checking task access');
    await screen.findByText('Authorized follow-up');
    expect(load).toHaveBeenCalledWith('linked');
  });
  it('removes a previously loaded task when a new authorized board snapshot fails its reread', async () => {
    const load = vi.fn().mockResolvedValue({ id: 'linked', title: 'Previously available' });
    const mounted = render(<ConnectedTaskLanding data={{ tasks: [] }} requestedId="linked" scopeKey="staff" loadTask={load}>{show}</ConnectedTaskLanding>);
    await screen.findByText('Previously available');
    load.mockRejectedValue(new Error('revoked'));
    mounted.rerender(<ConnectedTaskLanding data={{ tasks: [{ id: 'other', title: 'Other task' }] }} requestedId="linked" scopeKey="staff" loadTask={load}>{show}</ConnectedTaskLanding>);
    await screen.findByRole('alert');
    expect(screen.queryByText('Previously available')).not.toBeInTheDocument();
  });
  it('discards a late result after the selected source or identity changes', async () => {
    let resolveFirst;
    const load = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; })).mockResolvedValue({ id: 'second', title: 'Second task' });
    const mounted = render(<ConnectedTaskLanding data={{ tasks: [] }} requestedId="first" scopeKey="chapter-a" loadTask={load}>{show}</ConnectedTaskLanding>);
    await waitFor(() => expect(load).toHaveBeenCalledWith('first'));
    mounted.rerender(<ConnectedTaskLanding data={{ tasks: [] }} requestedId="second" scopeKey="chapter-b" loadTask={load}>{show}</ConnectedTaskLanding>);
    await screen.findByText('Second task');
    await act(async () => resolveFirst({ id: 'first', title: 'Old task' }));
    expect(screen.queryByText('Old task')).not.toBeInTheDocument();
  });
});
