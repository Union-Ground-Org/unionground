import { describe, expect, it } from 'vitest';
import { createDemoMessageReactionToggle } from '../src/lib/demoMessageReactions.js';

describe('preview reaction confirmation', () => {
  it.each(['conversations', 'threads'])('preserves seeded and peer selections in the %s adapter', async (key) => {
    const seed = { [key]: [{ id: 'thread', messages: [{ id: 'same', reactions: [
      { actor_id: 'member', reaction: 'support' }, { actor_id: 'peer', reaction: 'support' },
    ] }] }] };
    let data = seed;
    const toggle = createDemoMessageReactionToggle({ getActorId: () => 'member', getData: () => data, updateData: update => { data = update(data); } });
    expect(await toggle('private', 'same', 'support')).toEqual({ reacted: false, samplePreview: true });
    expect(data[key][0].messages[0].reactions).toEqual([{ actor_id: 'peer', reaction: 'support' }]);
    expect(await toggle('private', 'same', 'solidarity')).toMatchObject({ reacted: true });
    expect(await toggle('private', 'same', 'solidarity')).toMatchObject({ reacted: false });
    expect(seed[key][0].messages[0].reactions).toHaveLength(2);
  });
  it('isolates actor, source, message and reaction identities and resets with each preview instance', async () => {
    let actor = 'one';
    const options = { getActorId: () => actor, getData: () => ({}), updateData: () => {} };
    const toggle = createDemoMessageReactionToggle(options);
    for (const args of [['private', 'same', 'care'], ['channel', 'same', 'care'], ['task', 'same', 'care'], ['private', 'other', 'care'], ['private', 'same', 'victory']]) {
      expect(await toggle(...args)).toMatchObject({ reacted: true });
    }
    actor = 'two'; expect(await toggle('private', 'same', 'care')).toMatchObject({ reacted: true });
    actor = 'one'; expect(await toggle('private', 'same', 'care')).toMatchObject({ reacted: false });
    const fresh = createDemoMessageReactionToggle(options);
    expect(await fresh('private', 'same', 'care')).toMatchObject({ reacted: true });
    await expect(toggle('broadcast', 'same', 'care')).rejects.toThrow('Invalid preview reaction');
    await expect(toggle('private', 'same', 'unknown')).rejects.toThrow('Invalid preview reaction');
  });
  it.each(['channel', 'task'])('projects confirmed %s toggles without changing peers or the seed', async (source) => {
    const messages = [{ id: 'target', reactions: [{ actor_id: 'peer', reaction: 'care' }] }, { id: 'other' }];
    const seed = source === 'task' ? { taskMessages: messages } : {
      product: { spaces: [{ id: 'empty' }, { id: 'space', threads: [{ id: 'empty' }, { id: 'thread', posts: messages }] }] },
    };
    const select = value => source === 'task' ? value.taskMessages : value.product.spaces[1].threads[1].posts;
    let data = seed;
    const toggle = createDemoMessageReactionToggle({ getActorId: () => 'member', getData: () => data, updateData: update => { data = update(data); } });

    expect(await toggle(source, 'target', 'care')).toEqual({ reacted: true, samplePreview: true });
    expect(select(data)[0].reactions).toEqual([
      { actor_id: 'peer', reaction: 'care' }, { actor_id: 'member', reaction: 'care' },
    ]);
    expect(select(data)[1]).toBe(messages[1]);
    expect(await toggle(source, 'target', 'care')).toEqual({ reacted: false, samplePreview: true });
    expect(select(data)[0].reactions).toEqual([{ actor_id: 'peer', reaction: 'care' }]);
    expect(select(seed)).toBe(messages);
    expect(messages[0].reactions).toEqual([{ actor_id: 'peer', reaction: 'care' }]);
  });
  it('rejects reactions after the preview actor disappears without changing the projection', async () => {
    let updates = 0;
    const toggle = createDemoMessageReactionToggle({ getActorId: () => null, getData: () => ({}), updateData: () => { updates += 1; } });
    await expect(toggle('task', 'message', 'care')).rejects.toThrow('Invalid preview reaction');
    expect(updates).toBe(0);
  });
});
