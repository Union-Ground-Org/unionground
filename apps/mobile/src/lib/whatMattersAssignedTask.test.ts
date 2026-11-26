// UX-UG-WHAT-MATTERS-NOW-SAYS-CAUGHT-UP-WITH-AN-ASSIGNED-TASK-20261112:
// native Home ranks an overdue or nearly due task assigned to the member
// through the shared web module, so it shows what web shows for the same data
// and never says caught up above it.
import { describe, expect, it } from 'vitest';

import { rankWhatMattersNow as webRank } from '../../../../src/features/memberHome/whatMattersNow.js';
import { whatMattersCopy } from './whatMattersCopy';
import { assignedTasksOf, rankWhatMattersNow } from './whatMattersShared';

// 2:12 AM Eastern on November 12, 2026.
const now = new Date('2026-11-12T07:12:00Z');
const base = { cases: [], ballots: [], events: [], surveys: [], notices: [], now };
const overdue = { id: 't1', title: 'Order the flyers', dueDate: '2026-11-10' };

describe('native What matters now with an assigned task', () => {
  it('names a worker\'s only overdue assigned task and opens the task', () => {
    const item = rankWhatMattersNow({ ...base, tasks: [overdue] });
    expect(item).toEqual({
      kind: 'assigned_task', urgency: 'warning', task: { id: 't1', title: 'Order the flyers' }, days: -2, deadline: '2026-11-10',
      action: { kind: 'open_task', taskId: 't1' },
    });
    expect(whatMattersCopy(item)).toEqual({
      reason: 'A task assigned to you is overdue',
      line: 'Order the flyers is 2 days overdue.',
      meta: 'Due Nov 10',
      action: 'Open the task',
      href: '/task-conversation/t1',
    });
    expect(whatMattersCopy(item, 'es')).toMatchObject({
      reason: 'Una tarea asignada a ti está atrasada',
      line: 'Order the flyers lleva 2 días vencido.',
      action: 'Abrir la tarea',
      href: '/task-conversation/t1',
    });
  });

  it('reads a task due tomorrow as coming up, not overdue', () => {
    const copy = whatMattersCopy(rankWhatMattersNow({ ...base, tasks: [{ ...overdue, dueDate: '2026-11-13' }] }));
    expect(copy).toMatchObject({ reason: 'A task assigned to you is due soon', line: 'Order the flyers is due tomorrow.' });
  });

  it('is caught up for a worker with nothing at all, or only far or undated tasks', () => {
    for (const tasks of [[], [{ ...overdue, dueDate: '2026-11-20' }, { ...overdue, id: 't2', dueDate: null }]]) {
      const copy = whatMattersCopy(rankWhatMattersNow({ ...base, tasks }));
      expect(copy).toEqual({ reason: 'You’re caught up', line: 'Nothing needs your attention right now.', meta: null, action: null, href: null });
    }
  });

  it('gives the same item as the web ranking for the same data', () => {
    for (const tasks of [[overdue], [], [{ ...overdue, dueDate: '2026-11-19' }]]) {
      expect(rankWhatMattersNow({ ...base, tasks })).toEqual(webRank({ ...base, tasks }));
    }
  });

  it('keeps only open tasks the worker is assigned, as web does', () => {
    expect(assignedTasksOf([
      { id: 't1', title: 'Mine', status: 'to_do', dueDate: null, assigneeId: 'me' },
      { id: 't2', title: 'Shared', status: 'in_progress', dueDate: '2026-11-10', assigneeId: 'other', assigneeIds: ['other', 'me'] },
      { id: 't3', title: 'Done', status: 'done', dueDate: '2026-11-10', assigneeId: 'me' },
    ], 'me').map((task) => task.id)).toEqual(['t1', 't2']);
  });
});
