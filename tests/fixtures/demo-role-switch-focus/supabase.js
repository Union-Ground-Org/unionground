// Stand-in for src/lib/supabase.js on the demo host: setSession publishes the
// new persona to getSession and every auth listener, as auth-js does.
import { samplePersonaForHat } from "../../../src/lib/sampleBackend.js";
import { currentLegalVersions } from "../../../src/lib/legalInstruments.js";

function personaSession(hat) {
  const { email } = samplePersonaForHat(hat);
  const payload = btoa(JSON.stringify({ email, session_id: "11111111-1111-4111-8111-111111111111" })).replace(/=+$/, "");
  return { user: { id: `persona-${hat}`, email }, access_token: `header.${payload}.signature` };
}

let session = personaSession(new URLSearchParams(window.location.search).get("startHat") || "steward");
const listeners = new Set();
const empty = { data: [], error: null, count: 0 };
const query = () => new Proxy(() => {}, {
  get: (_target, key) => (key === "then" ? (resolve) => resolve(empty) : () => query()),
});
const channel = { on: () => channel, subscribe: () => channel, unsubscribe() {} };
const client = {
  from: () => query(),
  rpc: async (name) => ({ data: name === "get_my_legal_acceptance_state" ? { versions: currentLegalVersions(), acceptedAt: null } : [], error: null }),
  auth: {
    getSession: async () => ({ data: { session }, error: null }),
    onAuthStateChange: (callback) => {
      listeners.add(callback);
      return { data: { subscription: { unsubscribe: () => listeners.delete(callback) } } };
    },
    setSession: async ({ access_token: token }) => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      session = personaSession(token.replace(/^access-/, ""));
      for (const listener of [...listeners]) listener("SIGNED_IN", session);
      return { data: { session }, error: null };
    },
    signOut: async () => ({ error: null }),
    mfa: {
      listFactors: async () => ({ data: { all: [], totp: [] }, error: null }),
      getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal1", nextLevel: "aal1" }, error: null }),
    },
  },
  realtime: { setAuth: async () => {} },
  channel: () => channel,
  removeChannel() {},
};

export const supabase = null;
export const hasSupabaseConfig = false;
export const sampleSupabase = client;
export const hasSampleSupabaseConfig = true;
export const appSupabase = client;
export const hasAppBackend = true;
export const appBackendKind = "sample";
export const appBackendIsSampleProject = true;
export const appAuthStorageKey = "sample-auth-storage";
export const appAuthStorageUnavailable = false;
export const appAuthSessionIsClosed = () => false;
export const authStorageAdapter = () => globalThis.localStorage;
export const createPublicReadClient = () => client;
export const createCapturedAppSessionRpcClient = () => client;
export const createCapturedAppAccountClient = async () => client;
export const verifyCapturedAppSession = async () => ({ data: { user: session.user }, error: null });
export const clearCapturedAppSessionLocally = async () => true;
export const clearRefusedAppSessionLocally = async () => true;
