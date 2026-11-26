import { describe, expect, it, vi } from 'vitest';
import { messageActionChoices, messageActionRequest, MESSAGE_QUICK_ACTION } from '../src/features/messaging/actions.js';

describe('shared authorized message actions', () => {
  it('offers only server-confirmed editing and all non-gesture actions', () => {
    expect(messageActionChoices(null)).toEqual([]);
    expect(messageActionChoices({}).map((a) => a.id)).toEqual(['reply', 'react', 'save', 'remind']);
    expect(messageActionChoices({ canEdit: true, saved: true, reminders: [{}] })).toContainEqual({ id: 'edit', label: 'Edit message' });
    expect(messageActionChoices({ canEdit: 'true' }).some((a) => a.id === 'edit')).toBe(false);
    expect(messageActionChoices({ saved: true, reminders: [{}] })).toContainEqual({ id: 'unremind', label: 'Remove reminders' });
    expect(MESSAGE_QUICK_ACTION).toBe('like');
  });
  it.each(['private', 'channel'])('binds every %s request to the exact source', async (kind) => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: { saved: true }, error: null }) };
    await messageActionRequest(client, kind, 'row', 'save');
    expect(client.rpc).toHaveBeenLastCalledWith('act_on_member_message', { p_source_kind: kind, p_message_id: 'row', p_action: 'save', p_value: null });
    await messageActionRequest(client, kind, 'row', 'state');
    expect(client.rpc).toHaveBeenLastCalledWith('get_member_message_actions', { p_source_kind: kind, p_message_id: 'row' });
    await messageActionRequest(client, kind, 'row', 'reply', 'reply');
    expect(client.rpc).toHaveBeenLastCalledWith('reply_to_member_message', { p_source_kind: kind, p_message_id: 'row', p_body: 'reply' });
  });
  it('uses the edit RPC only for private messages', async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: { id: 'row' } }) };
    await messageActionRequest(client, 'private', 'row', 'edit', 'edited');
    expect(client.rpc).toHaveBeenCalledWith('edit_member_message', { p_message_id: 'row', p_body: 'edited' });
  });
  it('rejects missing confirmation, denial and unsupported boundaries', async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: null }) };
    await expect(messageActionRequest(client, 'private', 'row', 'save')).rejects.toThrow('not confirmed');
    client.rpc.mockResolvedValue({ error: new Error('denied') });
    await expect(messageActionRequest(client, 'channel', 'row', 'save')).rejects.toThrow('denied');
    for (const kind of ['task', 'announcement', null]) await expect(messageActionRequest(client, kind, 'row', 'save')).rejects.toThrow('unavailable');
    await expect(messageActionRequest(null, 'private', 'row', 'save')).rejects.toThrow('unavailable');
    await expect(messageActionRequest(client, 'private', '', 'save')).rejects.toThrow('unavailable');
  });
});
