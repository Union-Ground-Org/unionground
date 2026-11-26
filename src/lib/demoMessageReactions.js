import { isMessageReactionKind } from '../features/messaging/reactions.js';

// A preview keeps its own confirmed toggle state. No backend call or shared
// fixture mutation: the caller owns the mounted preview's data projection.
export function createDemoMessageReactionToggle({ getActorId, getData, updateData }) {
  const selections = new Map();
  return async (sourceKind, messageId, reaction) => {
    const actorId = getActorId();
    if (!actorId || !['private', 'channel', 'task'].includes(sourceKind) || !isMessageReactionKind(reaction)) {
      throw new Error('Invalid preview reaction');
    }
    const data = getData();
    const rows = sourceKind === 'private'
      ? [...(data.conversations || []), ...(data.threads || [])].flatMap(thread => thread.messages || [])
      : sourceKind === 'task' ? data.taskMessages || []
        : (data.product?.spaces || []).flatMap(space => (space.threads || []).flatMap(thread => thread.posts || []));
    const current = rows.find(row => row.id === messageId);
    const key = JSON.stringify([actorId, sourceKind, messageId, reaction]);
    const selected = selections.has(key) ? selections.get(key)
      : (current?.reactions || []).some(row => row.actor_id === actorId && row.reaction === reaction);
    const reacted = !selected;
    selections.set(key, reacted);
    const replace = row => {
      if (row.id !== messageId) return row;
      const others = (row.reactions || []).filter(item => item.actor_id !== actorId || item.reaction !== reaction);
      return { ...row, reactions: reacted ? [...others, { actor_id: actorId, reaction }] : others };
    };
    updateData(latest => {
      if (sourceKind === 'private') return {
        ...latest,
        ...(latest.conversations && { conversations: latest.conversations.map(thread => ({ ...thread, messages: (thread.messages || []).map(replace) })) }),
        ...(latest.threads && { threads: latest.threads.map(thread => ({ ...thread, messages: (thread.messages || []).map(replace) })) }),
      };
      if (sourceKind === 'task') return { ...latest, taskMessages: (latest.taskMessages || []).map(replace) };
      return { ...latest, product: { ...latest.product, spaces: (latest.product?.spaces || []).map(space => ({
        ...space, threads: (space.threads || []).map(thread => ({ ...thread, posts: (thread.posts || []).map(replace) })),
      })) } };
    });
    return { reacted, samplePreview: true };
  };
}
