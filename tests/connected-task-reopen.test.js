import { describe, expect, it, vi } from 'vitest';
import { loadAuthorizedChapterTask } from '../src/lib/memberApi.js';
import { isSourceGone } from '../src/features/connectedWorkflows/landing.js';

function clientReturning(result) {
  const query = { select: vi.fn(), eq: vi.fn(), is: vi.fn(), maybeSingle: vi.fn().mockResolvedValue(result) };
  for (const key of ['select', 'eq', 'is']) query[key].mockReturnValue(query);
  return { from: vi.fn().mockReturnValue(query), query };
}

describe('opening a linked task', () => {
  it('loads the exact task through RLS without the board page or completion-window filter', async () => {
    const client = clientReturning({ data: { id: 'older-task', chapter_id: 'chapter-a', task_number: 12, status: 'done' }, error: null });
    expect(await loadAuthorizedChapterTask(client, 'older-task')).toMatchObject({ id: 'older-task', chapterId: 'chapter-a', taskNumber: 12, status: 'done' });
    expect(client.from).toHaveBeenCalledWith('chapter_tasks');
    expect(client.query.eq).toHaveBeenCalledWith('id', 'older-task');
    expect(client.query.is).toHaveBeenCalledWith('deleted_at', null);
  });

  it('refuses an item hidden after a membership change or deletion', async () => {
    await expect(loadAuthorizedChapterTask(clientReturning({ data: null, error: null }), 'gone')).rejects.toThrow('Task unavailable');
    // #9912: a missing row is a gone task, so every opener says "no longer
    // available" rather than "could not be opened. Try again."
    const gone = await loadAuthorizedChapterTask(clientReturning({ data: null, error: null }), 'gone').catch((error) => error);
    expect(gone).toMatchObject({ code: 'task_unavailable' });
    expect(isSourceGone(gone)).toBe(true);
    expect(isSourceGone(await loadAuthorizedChapterTask(clientReturning({ data: null, error: null }), '').catch((error) => error))).toBe(true);
    const denied = { code: '42501' };
    await expect(loadAuthorizedChapterTask(clientReturning({ data: null, error: denied }), 'forbidden')).rejects.toEqual(denied);
  });

  it('never falls back to a cached row after the fresh read fails', async () => {
    const client = clientReturning({ data: null, error: new Error('offline') });
    await expect(loadAuthorizedChapterTask(client, 'cached-task')).rejects.toThrow('offline');
    expect(client.query.maybeSingle).toHaveBeenCalledTimes(1);
  });
});
