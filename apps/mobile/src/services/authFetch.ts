/** Keep the original HTTP status ahead of auth-js's error normalization. */
export function createFailClosedAuthFetch(backendUrl: string, transport: typeof fetch = (...args) => fetch(...args)): typeof fetch {
  const authRoot = `${backendUrl.replace(/\/$/, '')}/auth/v1/`;
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(authRoot)) return transport(input, init);
    // A hung native fetch otherwise holds auth-js's process lock indefinitely,
    // so even a new session check queues behind the failed outage request.
    const callerSignal = init?.signal ?? (typeof input === 'object' && 'signal' in input ? input.signal : undefined);
    const cancelledError = () => Object.assign(new Error('Account security request was interrupted.'), { name: 'AbortError' });
    if (callerSignal?.aborted) throw cancelledError();
    const controller = new AbortController();
    let rejectCancelled!: (reason: Error) => void;
    const cancelled = new Promise<Response>((_resolve, reject) => { rejectCancelled = reject; });
    const cancel = () => { controller.abort(); rejectCancelled(cancelledError()); };
    callerSignal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, 10_000);
    try {
      // Race as well as abort: an unavailable native transport may ignore its
      // signal. Its eventual response cannot settle the expired Auth request.
      const response = await Promise.race([transport(input, { ...init, signal: controller.signal }), cancelled]);
      if (response.status >= 500) {
        // auth-js recognizes only some 5xx codes. Never let it parse an outage
        // body as session_not_found and remove the stored refresh lineage.
        const error = new Error('Auth server answer is unavailable.');
        Object.assign(error, { status: response.status });
        throw error;
      }
      return response;
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', cancel);
    }
  };
}
