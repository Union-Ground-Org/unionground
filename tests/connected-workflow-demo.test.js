import { describe, expect, it, vi } from 'vitest';
import { createDemoConnectedWorkflowApi } from '../src/features/connectedWorkflows/demoApi.js';

function fixture() {
  const data = {
    member: { id: 'me', chapterId: 'chapter', organizationId: 'org' },
    events: [{ id: 'event', startsAt: '2026-10-01T12:00:00-04:00', rsvpStatus: 'going' }, { id: 'cancelled', cancelledAt: '2026-09-29' }],
    tasks: [{ id: 'task', createdBy: 'me', assigneeId: 'alex' }, { id: 'assigned', createdBy: 'alex', assigneeId: 'me' }, { id: 'self', createdBy: 'me', assigneeId: 'me' }, { id: 'other', createdBy: 'alex', assigneeId: 'sam' }, { id: 'deleted', deletedAt: '2026-09-29' }],
    taskAssignees: [{ id: 'alex', fullName: 'Alex' }],
    conversations: [{ id: 'conversation', messages: [{ id: 'message', body: 'Private source words' }, { id: 'redacted', redacted_at: '2026-09-29' }] }],
    product: { spaces: [{ threads: [{ id: 'channel', posts: [{ id: 'post', body: 'Channel words' }] }] }] },
    taskMessages: [{ id: 'reply', taskId: 'task', senderId: 'me', recipientId: 'alex' }, { id: 'foreign-reply', senderId: 'alex', recipientId: 'sam' }],
    chapterStewards: [{ id: 'organizer', chapterId: 'chapter', name: 'Sam', contact: { conversation: true } }, { id: 'replacement', chapterId: 'chapter', name: 'Pat', contact: { conversation: true } }, { id: 'elsewhere', chapterId: 'elsewhere', contact: { conversation: true } }, { id: 'unreachable', chapterId: 'chapter' }],
    taskAttachments: [{ sourceKind: 'message', sourceId: 'message', taskId: 'assigned' }],
  };
  const state = { tasks: new Map(), sources: new Map(), reminders: new Map(), sends: new Map() };
  const staff = { value: true };
  const createTask = vi.fn().mockResolvedValue({ created: true, task: { id: 'followup', title: 'Follow up' } });
  const sendTaskMessage = vi.fn().mockResolvedValue({ id: 'sent' });
  const api = createDemoConnectedWorkflowApi({ getData: () => data, getStaffData: () => ({ threads: [{ id: 'staff-conversation', messages: [{ id: 'staff-message' }] }] }), state, isStaff: () => staff.value, createTask, sendTaskMessage });
  return { api, data, state, staff, createTask, sendTaskMessage };
}
const ref = (kind, id) => ({ kind, id });
const future = (days = 1) => new Date(Date.now() + days * 86400000).toISOString();

describe('fixture-only connected workflow behavior', () => {
  it('retains exact source routes and exposes no source words in context metadata', async () => {
    const { api } = fixture();
    const cases = [
      ['event', 'event', '/m/events?event=event'], ['task', 'task', '/m/tasks?task=task'],
      ['private_message', 'message', '/m/messages?conversation=conversation&message=message'],
      ['private_message', 'staff-message', '/m/steward?thread=staff-conversation&message=staff-message'],
      ['channel_post', 'post', '/m/messages?channel=channel&post=post'], ['task_message', 'reply', '/m/messages?taskThread=task&message=reply'],
    ];
    for (const [kind, id, href] of cases) {
      const value = await api.context(ref(kind, id));
      expect(value).toMatchObject({ available: true, href, samplePreview: true });
      expect(JSON.stringify(value)).not.toMatch(/Private source words|Channel words/);
    }
    expect((await api.context(ref('private_message', 'message'))).linkedTask.id).toBe('assigned');
    expect((await api.context(ref('task_message', 'reply'))).linkedTask.id).toBe('task');
  });
  it('refuses stale tenant references, missing records and records outside the selected identity', async () => {
    const { api, staff } = fixture();
    for (const source of [{ ...ref('event', 'event'), chapterId: 'other' }, { ...ref('event', 'event'), organizationId: 'other' }, ref('event', 'missing'), ref('task', 'deleted'), ref('channel_post', 'missing'), ref('task_message', 'foreign-reply'), ref('unknown', 'event')]) {
      expect((await api.context(source)).available).toBe(false);
    }
    staff.value = false;
    expect((await api.context(ref('private_message', 'staff-message'))).available).toBe(false);
    await expect(api.createTask(ref('event', 'event'))).rejects.toThrow('Unavailable');
    expect((await api.context(ref('private_message', 'redacted'))).canRemind).toBe(false);
  });
  it('limits task recipients to the other participant and never invents an event audience', async () => {
    const { api, data } = fixture();
    for (const id of ['task', 'assigned']) expect((await api.recipients(ref('task', id))).items).toEqual([{ id: 'alex', label: 'Alex' }]);
    for (const [kind, id] of [['event', 'event'], ['task', 'self'], ['task', 'other'], ['task', 'missing']]) expect((await api.recipients(ref(kind, id))).items).toEqual([]);
    data.taskAssignees = [];
    data.tasks[0].assigneeName = 'Assigned person';
    expect((await api.recipients(ref('task', 'task'))).items[0].label).toBe('Assigned person');
    delete data.tasks[0].assigneeName;
    expect((await api.recipients(ref('task', 'task'))).items[0].label).toBe('Task participant');
  });
  it('coalesces simultaneous task creation and retains a generic source return link', async () => {
    const { api, state, createTask } = fixture();
    let complete;
    createTask.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const source = ref('event', 'event');
    const first = api.createTask(source), retry = api.createTask(source);
    await vi.waitFor(() => expect(createTask).toHaveBeenCalledTimes(1));
    complete({ created: true, task: { id: 'followup', title: 'Follow up' } });
    expect((await first).created).toBe(true); expect((await retry).created).toBe(false);
    expect(state.sources.get('followup')).toEqual([{ reference: source, label: 'Calendar event' }]);
    expect((await api.context(source)).linkedTask.id).toBe('followup');
    for (const [kind, id, label] of [['private_message', 'message', 'Message'], ['channel_post', 'post', 'Channel post']]) {
      await api.createTask(ref(kind, id)); expect(state.sources.get('followup')[0].label).toBe(label);
    }
    expect(createTask).toHaveBeenCalledWith('message', 'message');
  });
  it('allows task creation to retry after a failed operation', async () => {
    const { api, createTask } = fixture();
    createTask.mockRejectedValueOnce(new Error('network'));
    await expect(api.createTask(ref('event', 'event'))).rejects.toThrow('network');
    await expect(api.createTask(ref('event', 'event'))).resolves.toMatchObject({ created: true });
    expect(createTask).toHaveBeenCalledTimes(2);
  });
  it('requires explicit organizer selection and consent to that organizer, and clears consent on replacement', async () => {
    const { api, staff, state } = fixture();
    expect((await api.context(ref('event', 'event'))).contactOptIn).toBe(false);
    expect((await api.eventOrganizerCandidates('event')).items.map(x => x.id)).toEqual(['organizer', 'replacement']);
    await expect(api.setEventOrganizer('event', 'elsewhere')).rejects.toThrow();
    await expect(api.setEventContactOptIn('event', true, 'organizer')).rejects.toThrow();
    await api.setEventOrganizer('event', 'organizer');
    await expect(api.setEventContactOptIn('event', true, 'replacement')).rejects.toThrow();
    await api.setEventContactOptIn('event', true, 'organizer');
    await api.setEventOrganizer('event', 'organizer');
    expect(state.optIns.get('event')).toBe(true);
    await api.setEventOrganizer('event', 'replacement');
    expect((await api.context(ref('event', 'event'))).contactOptIn).toBe(false);
    await api.setEventContactOptIn('event', true, 'replacement');
    await api.setEventContactOptIn('event', false, null);
    expect(state.optIns.get('event')).toBe(false);
    await api.setEventOrganizer('event', null);
    expect((await api.context(ref('event', 'event'))).organizer).toBeNull();
    await expect(api.eventOrganizerCandidates('missing')).rejects.toThrow();
    staff.value = false; await expect(api.eventOrganizerCandidates('event')).rejects.toThrow();
  });
  it('rechecks sources when reminders open or snooze, while completion and cancellation remain possible', async () => {
    const { api, data } = fixture(); const at = future(); const source = ref('event', 'event');
    const first = await api.remind(source, at);
    expect((await api.remind(source, at)).created).toBe(false);
    expect((await api.listReminders()).items).toHaveLength(1);
    expect((await api.updateReminder(first.reminder.id, 'open')).href).toBe('/m/events?event=event');
    await api.updateReminder(first.reminder.id, 'snooze', future(2));
    await expect(api.updateReminder(first.reminder.id, 'snooze', 'invalid')).rejects.toThrow();
    data.events = [];
    expect((await api.updateReminder(first.reminder.id, 'open')).available).toBe(false);
    await expect(api.updateReminder(first.reminder.id, 'snooze', future(3))).rejects.toThrow();
    await api.updateReminder(first.reminder.id, 'complete');
    expect((await api.listReminders()).items).toEqual([]);
    const second = await api.remind(ref('task', 'task'), future());
    await api.updateReminder(second.reminder.id, 'cancel');
    expect((await api.listReminders()).items).toEqual([]);
    await expect(api.updateReminder('missing', 'open')).rejects.toThrow();
    await expect(api.updateReminder(second.reminder.id, 'unknown')).rejects.toThrow();
    await expect(api.remind(ref('task', 'task'), 'invalid')).rejects.toThrow();
    await expect(api.remind(ref('event', 'cancelled'), future())).rejects.toThrow();
  });
  it('sends only to an explicit task recipient, converges retries and releases failed requests', async () => {
    const { api, sendTaskMessage } = fixture(); const source = ref('task', 'task');
    for (const args of [[[], 'hello', 'request'], [['stranger'], 'hello', 'request'], [['alex'], '', 'request'], [['alex'], 'hello', null]]) await expect(api.send(source, ...args)).rejects.toThrow();
    expect(sendTaskMessage).not.toHaveBeenCalled();
    await api.send(source, ['alex'], 'Hello', 'request');
    await api.send(source, ['alex'], 'Hello', 'request');
    expect(sendTaskMessage).toHaveBeenCalledTimes(1);
    sendTaskMessage.mockRejectedValueOnce(new Error('network'));
    await expect(api.send(source, ['alex'], 'Next', 'next')).rejects.toThrow('network');
    await api.send(source, ['alex'], 'Next', 'next');
    expect(sendTaskMessage).toHaveBeenCalledTimes(3);
  });
});
