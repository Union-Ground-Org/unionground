import { sameAuthSessionLineage } from "./exactSessionStorage.js";
import { WriterSessionChanged } from "./sessionBoundWriter.js";

// Auth configuration keeps the stronger original session lineage. The shared
// writer supplies the checked current token; all Auth dispatch is isolated.
export function createAccountSessionClient({ writer, session, sharedClient, createAccountClient, clearCapturedSession }) {
  async function checked() {
    if (!writer) throw new WriterSessionChanged();
    const current = await writer.session();
    if (!sameAuthSessionLineage(session, current)) throw new WriterSessionChanged();
    return current;
  }
  async function invoke(namespace, method, args) {
    const current = await checked();
    const linking = !namespace && method === "linkIdentity";
    const isolated = await createAccountClient(current, { pkce: linking });
    try {
      const api = namespace ? isolated.auth[namespace] : isolated.auth;
      const credentials = args[0];
      const result = await api[method](...(linking
        ? [{ ...credentials, options: { ...credentials?.options, skipBrowserRedirect: true } }] : args));
      if (!result.error && !namespace && method === "updateUser") {
        // The isolated update owns its acknowledgement. Refresh only this
        // checked live lineage so Home and durable Auth see the new metadata.
        // Exact-session storage fences a replacement that wins the Auth lock.
        try { await sharedClient.auth.setSession(await checked()); }
        catch { /* swallow-ok: metadata refresh cannot undo an acknowledged account update */ }
      }
      if (!result.error && namespace === "mfa" && ["verify", "challengeAndVerify"].includes(method)) {
        const candidate = result.data;
        if (!candidate?.access_token || !sameAuthSessionLineage(current, candidate)) throw new WriterSessionChanged();
        await checked();
        // The real browser client serializes this install on its Auth lock.
        // Its exact-session storage rejects a closed old lineage when another
        // login wins that lock between the check and installation.
        const installed = await sharedClient.auth.setSession(candidate);
        if (installed.error || !sameAuthSessionLineage(candidate, installed.data?.session)) throw new WriterSessionChanged();
      }
      if (!result.error && linking) {
        await checked();
        if (!credentials?.options?.skipBrowserRedirect && result.data?.url) globalThis.window?.location?.assign(result.data.url);
      }
      return result;
    } finally {
      try { await isolated.auth.dispose?.(); }
      catch { /* swallow-ok: isolated-client disposal cannot undo an acknowledged account change */ }
    }
  }
  const namespace = (name) => new Proxy({}, {
    get: (_target, method) => typeof method === "string" ? (...args) => invoke(name, method, args) : undefined,
  });
  return {
    getSession: async () => ({ data: { session: await checked() }, error: null }),
    getUser: (...args) => invoke(null, "getUser", args),
    updateUser: (...args) => invoke(null, "updateUser", args),
    registerPasskey: (...args) => invoke(null, "registerPasskey", args),
    reauthenticate: (...args) => invoke(null, "reauthenticate", args),
    linkIdentity: (...args) => invoke(null, "linkIdentity", args),
    unlinkIdentity: (...args) => invoke(null, "unlinkIdentity", args),
    mfa: namespace("mfa"),
    passkey: namespace("passkey"),
    signOut: async ({ scope = "local" } = {}) => {
      const current = await checked();
      const result = await sharedClient.auth.admin.signOut(current.access_token, scope);
      if (!result.error) await clearCapturedSession(current);
      return result;
    },
  };
}
