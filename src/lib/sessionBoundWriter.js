// #9254 / #9229: capture the composing person before the first await. Auth's
// current-session read waits for a replacement already in flight. Build the
// private client from THAT checked read, never from the shared client's later
// mutable token. Same-person refresh/sign-in deliberately remains supported.
export class WriterSessionChanged extends Error {
  constructor() {
    super("The account changed before this was sent.");
    this.name = "WriterSessionChanged";
    this.details = "writer_session_changed";
  }
}

export function createSessionBoundWriter({ session, sharedClient, createSessionClient }) {
  const userId = session?.user?.id;
  const valid = Boolean(userId && session?.access_token);
  const readSession = async () => {
    if (!valid) return { state: "changed" };
    if (typeof sharedClient?.auth?.getSession !== "function") return { state: "unavailable" };
    let result;
    try { result = await sharedClient.auth.getSession(); }
    catch { return { state: "unavailable" }; }
    const current = result?.data?.session;
    if (result?.error || !result?.data || current === undefined || current && (!current.user?.id || !current.access_token)) return { state: "unavailable" };
    if (current?.user?.id !== userId) return { state: "changed" };
    // Copy both values; a caller must never mutate the checked identity/token
    // between this read and the captured client's synchronous construction.
    return { state: "current", session: { ...current, access_token: current.access_token, user: { ...current.user } } };
  };
  const checkedSession = async () => {
    const proof = await readSession();
    if (proof.state !== "current") throw new WriterSessionChanged();
    return proof.session;
  };
  // Only failure feedback may survive unavailable proof, under its screen's
  // own generation. Dispatch and successful continuation always fail closed.
  const check = async () => (await readSession()).state;
  const isCurrent = async () => (await check()) === "current";
  return {
    userId: valid ? userId : null,
    session: checkedSession,
    check,
    async client() {
      const current = await checkedSession();
      if (typeof createSessionClient !== "function") throw new WriterSessionChanged();
      try {
        const client = createSessionClient(current);
        if (!client) throw new WriterSessionChanged();
        return client;
      } catch { throw new WriterSessionChanged(); }
    },
    isCurrent,
    // Called only AFTER the server acknowledges. A retired continuation is
    // still an accepted write; it must never become a retryable send failure.
    async acknowledged(value) {
      return { acknowledged: true, value, continuationCurrent: await isCurrent() };
    },
  };
}
