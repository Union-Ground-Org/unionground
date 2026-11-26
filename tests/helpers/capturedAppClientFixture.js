// Existing UI fixtures define server replies with Promises. The real SDK RPC
// builder also supports setHeader/abortSignal before it is awaited. Preserve
// those query methods when a bound App client replays the fixture request.
export function capturedAppClientFixture(client) {
  return {
    ...client,
    rpc(...args) {
      const request = Promise.resolve(client.rpc(...args));
      request.setHeader = () => request;
      request.abortSignal = () => request;
      return request;
    },
  };
}

export function capturedAppAccountFixture(client) {
  return {
    ...client,
    auth: {
      ...client.auth,
      passkey: client.auth.passkey ?? { list: async () => ({ data: null, error: new Error('passkeys-unavailable') }) },
    },
  };
}
