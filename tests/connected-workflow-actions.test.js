import { describe, expect, it } from 'vitest';
import { connectedRecordActions, connectedReminderActions, retainAuthorizedRecipients } from '../src/features/connectedWorkflows/actions.js';

describe('shared connected actions', () => {
  const available = { available: true, canMessage: true, canRemind: true, canCreateTask: true, discussionHref: '/m/messages?task=t' };
  it('requires both a server capability and the currently selected staff identity', () => {
    expect(connectedRecordActions(available).map((action) => action.id)).toEqual(['message', 'remind', 'discussion']);
    expect(connectedRecordActions(available, { staffAccess: true }).map((action) => action.id)).toContain('createTask');
    expect(connectedRecordActions({ ...available, canCreateTask: false }, { staffAccess: true }).map((action) => action.id)).not.toContain('createTask');
    expect(connectedRecordActions({ ...available, available: false }, { staffAccess: true })).toEqual([]);
  });
  it('replaces creation with opening an existing linked task', () => {
    const actions = connectedRecordActions({ ...available, linkedTask: { id: 'existing' } }, { staffAccess: true });
    expect(actions.map((action) => action.id)).toContain('openTask');
    expect(actions.map((action) => action.id)).not.toContain('createTask');
  });
  it('requires the selected staff identity for organizer audience actions', () => {
    const event = { ...available, kind: 'event', contactRole: 'organizer' };
    expect(connectedRecordActions(event).map((action) => action.id)).toEqual(['remind']);
    expect(connectedRecordActions({ ...event, kind: undefined, reference: { kind: 'event', id: 'event-1' } }).map((action) => action.id)).toEqual(['remind']);
    expect(connectedRecordActions(event, { staffAccess: true }).map((action) => action.id)).toContain('message');
    expect(connectedRecordActions({ ...event, contactRole: 'participant' }).map((action) => action.id)).toContain('message');
  });
  it('retains cancellation and completion even when the source is gone', () => {
    expect(connectedReminderActions({ id: 'r', status: 'sent', available: false }).map((a) => a.id)).toEqual(['source', 'snooze', 'complete', 'cancel']);
    expect(connectedReminderActions({ id: 'r', status: 'completed' }).map((a) => a.id)).toEqual(['source']);
  });
  it('never selects newly eligible recipients and removes lost authorization', () => {
    expect(retainAuthorizedRecipients(['a', 'b', 'a'], [{ id: 'b' }, { id: 'c' }])).toEqual(['b']);
    expect(retainAuthorizedRecipients([], [{ id: 'b' }])).toEqual([]);
  });
});
