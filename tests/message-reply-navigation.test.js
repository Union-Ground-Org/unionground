// @vitest-environment node
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { messageReplyCounts, messageReplyPage } from '../src/features/messaging/replies.js';

it('counts every requested source in bounded batches rather than counting loaded replies', async () => {
  const ids = Array.from({ length: 401 }, (_, i) => `message-${i}`);
  const rpc = vi.fn(async (_name, args) => ({ data: Object.fromEntries(args.p_message_ids.map((id) => [id, 1250])) }));
  expect(await messageReplyCounts({ rpc }, 'channel', ids)).toEqual(Object.fromEntries(ids.map((id) => [id, 1250])));
  expect(rpc.mock.calls.map((call) => call[1].p_message_ids.length)).toEqual([200, 200, 1]);
});

it.each(['private', 'channel'])('retrieves an unloaded %s parent and uses the exact chronological cursor', async (kind) => {
  const rpc = vi.fn().mockResolvedValue({ data: { parent: { id: 'old' }, replies: [] } });
  const cursor = { created_at: '2026-09-07T01:00:00Z', id: 'tie' };
  await messageReplyPage({ rpc }, kind, 'old', 'target', cursor);
  expect(rpc).toHaveBeenCalledWith('get_member_message_replies', { p_source_kind: kind, p_parent_id: 'old', p_target_id: 'target', p_after_at: cursor.created_at, p_after_id: 'tie', p_limit: 50 });
});

it('forwards an abort signal onto the replies rpc builder', async () => {
  const controller = new AbortController();
  const abortSignal = vi.fn(function abortSignal() { return this; });
  const rpc = vi.fn(() => {
    const result = Promise.resolve({ data: { parent: { id: 'old' }, replies: [] } });
    result.abortSignal = abortSignal;
    return result;
  });
  await messageReplyPage({ rpc }, 'private', 'old', 'target', null, controller.signal);
  expect(abortSignal).toHaveBeenCalledWith(controller.signal);
});

it('fails closed for invalid kinds and read denial, including a later count batch', async () => {
  const rpc = vi.fn().mockResolvedValueOnce({ data: {} }).mockResolvedValueOnce({ error: new Error('denied') });
  await expect(messageReplyCounts({ rpc }, 'private', Array.from({ length: 201 }, (_, i) => `${i}`))).rejects.toThrow('denied');
  await expect(messageReplyPage({ rpc }, 'task', 'parent', 'target')).rejects.toThrow('unavailable');
  await expect(messageReplyCounts({ rpc }, 'announcement', [])).rejects.toThrow('unavailable');
  expect(rpc).toHaveBeenCalledTimes(2);
});

it('migration preserves fail-closed source and target boundaries and bounded keyset pages', () => {
  const sql = readFileSync('supabase/migrations/20260907141000_message_reply_navigation.sql', 'utf8');
  expect(sql).toMatch(/begin;[\s\S]*commit;/);
  expect(sql.match(/private\.lock_message_lifecycle\(\)/g)).toHaveLength(2);
  expect(sql).toContain('target is distinct from p_target_id');
  expect(sql).toContain('private.mfa_satisfied() is not true');
  expect(sql).toContain('(m.created_at, m.id) > (p_after_at, p_after_id)');
  expect(sql).toContain('(p.created_at, p.id) > (p_after_at, p_after_id)');
  expect(sql).toContain('m.conversation_id = parent.conversation_id');
  expect(sql).toContain('p.thread_id = parent.thread_id');
});
