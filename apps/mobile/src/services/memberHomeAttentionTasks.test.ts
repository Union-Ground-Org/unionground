// UX-UG-WHAT-MATTERS-NOW-SAYS-CAUGHT-UP-WITH-AN-ASSIGNED-TASK-20261112:
// the native read of the member's own open assigned tasks behind "What matters
// for you now".
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Query = Record<string, (...args: unknown[]) => Query> & { then: (resolve: (value: unknown) => void) => void };

const backend = vi.hoisted(() => ({
  calls: [] as { table: string; method: string; args: unknown[] }[],
  results: new Map<string, unknown>(),
  client: null as unknown,
}));

vi.mock('./supabase', () => ({
  createCapturedSessionRpcClient: vi.fn(),
  getSupabaseClient: () => backend.client,
  loadMobileBallots: vi.fn(),
}));

import { loadWhatMattersTasks } from './memberHomeAttention';

const USER = '00000000-0000-4000-8000-0000000000a1';
const TASK = '00000000-0000-4000-8000-0000000000b1';

function query(table: string): Query {
  const chain = {} as Query;
  for (const method of ['select', 'eq', 'neq', 'or', 'order', 'limit']) {
    chain[method] = (...args: unknown[]) => { backend.calls.push({ table, method, args }); return chain; };
  }
  const own = backend.calls.length;
  chain.then = (resolve) => {
    const result = backend.results.get(table);
    // A function result is a small server: it answers from this query's own calls.
    resolve(typeof result === 'function' ? (result as (calls: { method: string; args: unknown[] }[]) => unknown)(backend.calls.slice(own).filter((call) => call.table === table)) : result);
  };
  return chain;
}

beforeEach(() => {
  backend.calls = [];
  backend.results = new Map();
  backend.client = { from: (table: string) => query(table) };
});

describe('loadWhatMattersTasks', () => {
  it('reads the worker\'s open tasks as primary or co-assignee in the selected campaign', async () => {
    backend.results.set('chapter_task_assignments', { data: [{ task_id: TASK }, { task_id: 'not-a-uuid' }, { task_id: 7 }], error: null });
    backend.results.set('chapter_tasks', { data: [
      { id: TASK, title: 'Order the flyers', status: 'in_progress', due_date: '2026-11-10' },
      { id: 'undated', title: null, status: 'to_do', due_date: null },
      { id: 'done', title: 'Done', status: 'done', due_date: '2026-11-01' },
      { id: 9, title: 'Bad id', status: 'to_do', due_date: null },
    ], error: null });
    expect(await loadWhatMattersTasks(USER, 'ch-1')).toEqual([
      { id: TASK, title: 'Order the flyers', dueDate: '2026-11-10' },
      { id: 'undated', title: '', dueDate: null },
    ]);
    expect(backend.calls).toContainEqual({ table: 'chapter_task_assignments', method: 'eq', args: ['assignee_id', USER] });
    expect(backend.calls).toContainEqual({ table: 'chapter_task_assignments', method: 'eq', args: ['chapter_id', 'ch-1'] });
    expect(backend.calls).toContainEqual({ table: 'chapter_task_assignments', method: 'select', args: ['task_id,chapter_tasks!inner(status)'] });
    expect(backend.calls).toContainEqual({ table: 'chapter_task_assignments', method: 'neq', args: ['chapter_tasks.status', 'done'] });
    expect(backend.calls).toContainEqual({ table: 'chapter_tasks', method: 'eq', args: ['chapter_id', 'ch-1'] });
    expect(backend.calls).toContainEqual({ table: 'chapter_tasks', method: 'neq', args: ['status', 'done'] });
    expect(backend.calls).toContainEqual({ table: 'chapter_tasks', method: 'or', args: [`assignee_id.eq.${USER},id.in.(${TASK})`] });
  });

  it('reads only the primary assignment when there are no co-assignments', async () => {
    backend.results.set('chapter_task_assignments', { data: [], error: null });
    backend.results.set('chapter_tasks', { data: null, error: null });
    expect(await loadWhatMattersTasks(USER, 'ch-1')).toEqual([]);
    expect(backend.calls).toContainEqual({ table: 'chapter_tasks', method: 'or', args: [`assignee_id.eq.${USER}`] });
  });

  it('reads nothing without a campaign and fails loudly on a failed or unconfigured read', async () => {
    expect(await loadWhatMattersTasks(USER, null)).toEqual([]);
    expect(backend.calls).toEqual([]);
    backend.results.set('chapter_task_assignments', { data: null, error: new Error('offline') });
    await expect(loadWhatMattersTasks(USER, 'ch-1')).rejects.toThrow('offline');
    backend.results.set('chapter_task_assignments', { data: [], error: null });
    backend.results.set('chapter_tasks', { data: null, error: new Error('down') });
    await expect(loadWhatMattersTasks(USER, 'ch-1')).rejects.toThrow('down');
    backend.client = null;
    await expect(loadWhatMattersTasks(USER, 'ch-1')).rejects.toThrow('not configured');
  });

  it('ranks live Home with the worker\'s assigned tasks and never calls it caught up before they are read', () => {
    const hook = readFileSync(join(__dirname, '../features/home/WhatMattersNow.tsx'), 'utf8');
    expect(hook).toContain('loadWhatMattersTasks(userID, chapterID),');
    expect(hook).toContain('tasks: settled.tasks?.value ?? [],');
    expect(hook).toContain("const WHAT_MATTERS_INPUTS: readonly WhatMattersInput[] = ['ballots', 'events', 'surveys', 'notices', 'tasks'];");
  });

  // BUG-UG-NATIVE-HOME-CAUGHT-UP-PAST-200-TASK-ASSIGNMENTS-20261115 (#8776).
  it('finds one overdue open co-assigned task among more than 200 finished assignments', async () => {
    const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    const overdue = id(9999);
    // 250 finished assignments are newer than the one open co-assignment.
    const assignments = [
      ...Array.from({ length: 250 }, (_, index) => ({ task_id: id(index), assigned_at: `2026-11-${String(10 + (index % 5)).padStart(2, '0')}T12:00:00Z`, chapter_tasks: { status: 'done' } })),
      { task_id: overdue, assigned_at: '2026-10-01T12:00:00Z', chapter_tasks: { status: 'to_do' } },
    ];
    backend.results.set('chapter_task_assignments', (calls: { method: string; args: unknown[] }[]) => {
      let data = assignments;
      if (calls.some((call) => call.method === 'neq' && call.args[0] === 'chapter_tasks.status' && call.args[1] === 'done')) data = data.filter((row) => row.chapter_tasks.status !== 'done');
      const order = calls.find((call) => call.method === 'order' && call.args[0] === 'assigned_at');
      if (order) {
        const ascending = (order.args[1] as { ascending?: boolean } | undefined)?.ascending !== false;
        data = [...data].sort((a, b) => (ascending ? a.assigned_at.localeCompare(b.assigned_at) : b.assigned_at.localeCompare(a.assigned_at)));
      }
      const limit = calls.find((call) => call.method === 'limit')?.args[0] as number;
      return { data: data.slice(0, limit), error: null };
    });
    backend.results.set('chapter_tasks', (calls: { method: string; args: unknown[] }[]) => {
      const owners = String(calls.find((call) => call.method === 'or')?.args[0] ?? '');
      return { data: owners.includes(overdue) ? [{ id: overdue, title: 'Return the strike-fund ledger', status: 'to_do', due_date: '2026-10-20' }] : [], error: null };
    });
    expect(await loadWhatMattersTasks(USER, 'ch-1')).toEqual([{ id: overdue, title: 'Return the strike-fund ledger', dueDate: '2026-10-20' }]);
  });

  // More than 200 OPEN co-assignments keep the oldest
  // assigned, the likeliest to be overdue, not the newest 200.
  it('keeps the oldest open co-assignment when a worker has more than 200 open ones', async () => {
    const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    const oldest = id(9999);
    const assignments = [
      ...Array.from({ length: 250 }, (_, index) => ({ task_id: id(index), assigned_at: `2026-11-${String(10 + (index % 5)).padStart(2, '0')}T12:00:00Z`, chapter_tasks: { status: 'to_do' } })),
      { task_id: oldest, assigned_at: '2026-09-01T12:00:00Z', chapter_tasks: { status: 'to_do' } },
    ];
    backend.results.set('chapter_task_assignments', (calls: { method: string; args: unknown[] }[]) => {
      const order = calls.find((call) => call.method === 'order' && call.args[0] === 'assigned_at');
      const ascending = (order?.args[1] as { ascending?: boolean } | undefined)?.ascending !== false;
      const data = [...assignments].sort((a, b) => (ascending ? a.assigned_at.localeCompare(b.assigned_at) : b.assigned_at.localeCompare(a.assigned_at)));
      return { data: data.slice(0, calls.find((call) => call.method === 'limit')?.args[0] as number), error: null };
    });
    backend.results.set('chapter_tasks', (calls: { method: string; args: unknown[] }[]) => {
      const owners = String(calls.find((call) => call.method === 'or')?.args[0] ?? '');
      return { data: owners.includes(oldest) ? [{ id: oldest, title: 'File the September grievance answer', status: 'to_do', due_date: '2026-09-15' }] : [], error: null };
    });
    expect(await loadWhatMattersTasks(USER, 'ch-1')).toEqual([{ id: oldest, title: 'File the September grievance answer', dueDate: '2026-09-15' }]);
  });
});
