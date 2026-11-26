// The clients ship before the keyed overloads reach the database. PostgREST
// rejects an unknown signature during request planning, before any write.
// Every other result (including a lost response) must stay on the keyed path.
/**
 * @template {{ data: unknown, error: unknown, status?: number }} Result
 * @param {(args: Record<string, string>) => PromiseLike<Result>} send
 * @param {"send_reward_peer_message" | "start_officer_conversation"} name
 * @param {Record<string, string>} legacyArgs
 * @param {string} [operationId]
 */
export async function callPeerMessageRpc(send, name, legacyArgs, operationId) {
  if (!operationId) return send(legacyArgs);

  const args = { ...legacyArgs, p_operation_id: operationId };
  const result = await send(args);
  const signature = Object.keys(args).sort().join(", ");
  const qualifiedName = `public.${name}`;
  const { error } = result;
  if (result.status === 404 && result.data === null
      && error?.code === "PGRST202"
      && error.message === `Could not find the function ${qualifiedName}(${signature}) in the schema cache`
      && error.details === `Searched for the function ${qualifiedName} with parameters ${signature} or with a single unnamed json/jsonb parameter, but no matches were found in the schema cache.`) {
    return send(legacyArgs);
  }
  return result;
}
