/** @param {string[]} messageIDs @returns {Promise<Record<string, number>>} */
export async function messageReplyCounts(client, sourceKind, messageIDs) {
  if (!client || !['private', 'channel'].includes(sourceKind)) throw new Error('Message unavailable.');
  const counts = {};
  const ids = [...new Set(messageIDs)];
  for (let offset = 0; offset < ids.length; offset += 200) {
    const { data, error } = await client.rpc('get_member_message_reply_counts', {
      p_source_kind: sourceKind, p_message_ids: ids.slice(offset, offset + 200),
    });
    if (error) throw error;
    if (!data) throw new Error('Replies unavailable.');
    Object.assign(counts, data);
  }
  return counts;
}

/**
 * @param {{created_at: string, id: string} | null} cursor
 * @param {AbortSignal} [signal]
 * @returns {Promise<unknown>}
 */
export async function messageReplyPage(client, sourceKind, parentID, targetID, cursor = null, signal) {
  if (!client || !['private', 'channel'].includes(sourceKind) || !parentID || !targetID) throw new Error('Message unavailable.');
  if (signal?.aborted) {
    const abortError = new Error('Reply load aborted');
    abortError.name = 'AbortError';
    throw abortError;
  }
  const query = client.rpc('get_member_message_replies', {
    p_source_kind: sourceKind, p_parent_id: parentID, p_target_id: targetID,
    p_after_at: cursor?.created_at ?? null, p_after_id: cursor?.id ?? null, p_limit: 50,
  });
  const request = signal && typeof query.abortSignal === 'function' ? query.abortSignal(signal) : query;
  const { data, error } = await request;
  if (error) throw error;
  if (!data) throw new Error('Replies unavailable.');
  return data;
}
