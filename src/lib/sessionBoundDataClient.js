// Adapter for synchronous Supabase query builders. Building a query does not
// dispatch it: replay its SDK method chain only after the shared writer has
// checked the composing person and produced a captured client. All transport,
// headers, serialization, filters and deadlines remain the real SDK's.
export function createSessionBoundDataClient(writer, sharedClient, { verifySession } = {}) {
  async function run(steps) {
    if (!writer) throw new Error("The account changed before this was sent.");
    let result = await writer.client();
    for (const [method, args] of steps) {
      // Older adapters may pin an earlier preflight token on their builder.
      // The checked client's current bearer owns this dispatch.
      if (method === "setHeader" && String(args[0]).toLowerCase() === "authorization") continue;
      result = result[method](...args);
    }
    return result;
  }
  function query(steps) {
    let dispatched;
    const start = () => dispatched ??= run(steps);
    return new Proxy({}, {
      get(_target, name) {
        if (name === "then") return (resolve, reject) => start().then(resolve, reject);
        if (name === "catch") return (reject) => start().catch(reject);
        if (name === "finally") return (finish) => start().finally(finish);
        if (typeof name !== "string") return undefined;
        return (...args) => query([...steps, [name, args]]);
      },
    });
  }
  const session = async () => {
    if (!writer) throw new Error("The account changed before this was sent.");
    return writer.session();
  };
  return {
    rpc: (...args) => query([["rpc", args]]),
    from: (...args) => query([["from", args]]),
    storage: {
      from: (...args) => new Proxy({}, {
        get(_target, method) {
          // Public URL construction is synchronous and sends no request.
          if (method === "getPublicUrl") return (...options) => sharedClient.storage.from(...args).getPublicUrl(...options);
          return async (...options) => {
            if (!writer) throw new Error("The account changed before this was sent.");
            const storage = (await writer.client()).storage.from(...args);
            return storage[method](...options);
          };
        },
      }),
    },
    functions: { invoke: async (...args) => {
      if (!writer) throw new Error("The account changed before this was sent.");
      return (await writer.client()).functions.invoke(...args);
    } },
    // HTTP helpers consume the checked session; they never read the mutable
    // shared session after selecting the composing person.
    auth: {
      getSession: async () => ({ data: { session: await session() }, error: null }),
      getUser: async () => {
        const current = await session();
        if (!verifySession) throw new Error("The authenticated reader is unavailable.");
        return verifySession(current);
      },
    },
    // Subscription setup/teardown remains on the live socket. Application
    // writes use rpc/from/storage above, never the mutable socket's bearer.
    channel: (...args) => sharedClient.channel(...args),
    removeChannel: (...args) => sharedClient.removeChannel(...args),
  };
}
