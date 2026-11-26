// @vitest-environment node
import fs from "node:fs";
import { AuthApiError, AuthSessionMissingError } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { inspectAndRemoveBrowserPush, signOutSafely } from "../src/lib/sessionManagement.js";
import {
  createMemoryStore,
  enqueueWrite,
  forgetDepartedMemberDevice,
  pendingCount,
  sessionStamp,
} from "../src/lib/outbox.js";
import { createSessionGuard } from "../src/lib/sessionGuard.js";
import {
  availableBrowserAuthStorage,
  createExactSessionStorage,
  readAuthStorageSessionLineage,
  sameAuthSessionLineage,
  storageEventClosesAuthSession,
  storageEventExplicitlySignsOutSession,
} from "../src/lib/exactSessionStorage.js";
import { MemberApiError, listMemberSessions, prepareMemberSignOut, revokeMemberSession } from "../src/lib/memberApi.js";

const sql = fs.readFileSync(new URL("../supabase/migrations/20260810180000_member_session_inventory.sql", import.meta.url), "utf8");

describe("member session inventory", () => {
  it("is self-scoped and returns coarse labels without sensitive session metadata", () => {
    expect(sql).toContain("s.user_id = caller");
    expect(sql).toContain("auth.jwt() ->> 'session_id'");
    expect(sql).toContain("'deviceLabel'");
    expect(sql).toContain("'browserLabel'");
    expect(sql).not.toMatch(/'ip'|'userAgent'|'sessionId'|'refreshToken'/);
  });
});

describe("safe sign-out", () => {
  const expectedUserID = "00000000-0000-4000-8000-000000000102";
  const capturedSession = {
    user: { id: expectedUserID },
    access_token: "captured-access-token",
    refresh_token: "captured-refresh-token",
  };

  function harness({
    browserOk = true,
    serverOk = true,
    lookupError = null,
    serverError,
    revokeError = null,
    localClear = true,
    afterRpc,
  } = {}) {
    const order = [];
    const subscription = { endpoint: "https://push.example/device", unsubscribe: vi.fn(async () => { order.push("browser"); return browserOk; }) };
    const serviceWorker = { ready: Promise.resolve({ pushManager: { getSubscription: vi.fn().mockResolvedValue(subscription) } }) };
    const client = {
      rpc: vi.fn(async (name, args) => {
        order.push(`rpc:${name}:${args?.p_scope || ""}`);
        afterRpc?.();
        return serverOk
          ? { data: { serverCleanupComplete: true }, error: null }
          : { data: null, error: serverError ?? { message: "db down", code: "08006" } };
      }),
      auth: {
        getUser: vi.fn(async () => ({ data: { user: { id: expectedUserID } }, error: null })),
        admin: {
          signOut: vi.fn(async (_accessToken, scope) => {
            order.push(`revoke:${scope}`);
            return { error: revokeError };
          }),
        },
        signOut: vi.fn(async () => { throw new Error("mutable signOut must not be called"); }),
      },
    };
    if (lookupError) serviceWorker.ready = Promise.reject(lookupError);
    const compareAndClearLocalSession = vi.fn(async () => {
      order.push("local-clear");
      return localClear;
    });
    const onLocalSessionCleared = vi.fn(() => { order.push("local-publish"); });
    return {
      client,
      serviceWorker,
      subscription,
      order,
      options: {
        expectedUserID,
        capturedSession,
        capturedRpcClient: client,
        verifyCapturedSession: vi.fn(async () => ({ data: { user: { id: expectedUserID } }, error: null })),
        compareAndClearLocalSession,
        onLocalSessionCleared,
      },
    };
  }

  it("prepares authoritative server cleanup before captured Auth revocation", async () => {
    const h = harness();
    await signOutSafely(h.client, { serviceWorker: h.serviceWorker, scope: "local", ...h.options });
    expect(h.order).toEqual([
      "rpc:prepare_my_signout:local",
      "revoke:local",
      "local-clear",
      "local-publish",
    ]);
    expect(h.client.rpc).toHaveBeenCalledWith("prepare_my_signout", {
      p_scope: "local",
      p_expected_user_id: expectedUserID,
    });
  });

  it("awaits the local session-cleared callback before resolving sign-out", async () => {
    const h = harness();
    let releaseLocalClear;
    let callbackStarted;
    const callbackStartedPromise = new Promise((resolve) => { callbackStarted = resolve; });
    const pendingLocalClear = new Promise((resolve) => { releaseLocalClear = resolve; });
    const onLocalSessionCleared = vi.fn(() => {
      callbackStarted();
      return pendingLocalClear;
    });
    let resolved = false;
    const signingOut = signOutSafely(h.client, {
      serviceWorker: h.serviceWorker,
      ...h.options,
      onLocalSessionCleared,
    }).then(() => { resolved = true; });

    await callbackStartedPromise;
    await Promise.resolve();
    expect(resolved).toBe(false);
    releaseLocalClear();
    await signingOut;
    expect(resolved).toBe(true);
  });

  it("requires server cleanup and never mutates the origin push subscription during sign-out", async () => {
    const serverOnly = harness({ browserOk: false });
    await expect(signOutSafely(serverOnly.client, { serviceWorker: serverOnly.serviceWorker, ...serverOnly.options })).resolves.toBeDefined();
    const browserOnly = harness({ serverOk: false });
    await expect(signOutSafely(browserOnly.client, { serviceWorker: browserOnly.serviceWorker, ...browserOnly.options }))
      .rejects.toThrow(/cleanup/i);
    expect(serverOnly.subscription.unsubscribe).not.toHaveBeenCalled();
    expect(browserOnly.subscription.unsubscribe).not.toHaveBeenCalled();
  });

  it("keeps Auth when authoritative server cleanup cannot prove privacy", async () => {
    const h = harness({ serverOk: false });
    await expect(signOutSafely(h.client, { serviceWorker: h.serviceWorker, ...h.options })).rejects.toThrow(/cleanup/i);
    expect(h.client.auth.signOut).not.toHaveBeenCalled();
    expect(h.client.auth.admin.signOut).not.toHaveBeenCalled();
  });

  it("does not use browser or Auth fallback after the server refuses the captured identity", async () => {
    const h = harness({
      serverOk: false,
      serverError: { message: "member session required", code: "42501" },
    });

    await expect(signOutSafely(h.client, { serviceWorker: h.serviceWorker, ...h.options }))
      .rejects.toMatchObject({ code: "42501" });
    expect(h.subscription.unsubscribe).not.toHaveBeenCalled();
    expect(h.client.auth.signOut).not.toHaveBeenCalled();
  });

  it("skips browser mutation after identity changes and still revokes only the captured Auth session", async () => {
    let current = true;
    const h = harness({ afterRpc: () => { current = false; } });

    await expect(signOutSafely(h.client, {
      serviceWorker: h.serviceWorker,
      ...h.options,
      isCurrent: () => current,
    })).resolves.toMatchObject({ localCleared: true });
    expect(h.subscription.unsubscribe).not.toHaveBeenCalled();
    expect(h.client.auth.signOut).not.toHaveBeenCalled();
    expect(h.client.auth.admin.signOut).toHaveBeenCalledWith("captured-access-token", "local");
    expect(h.options.onLocalSessionCleared).not.toHaveBeenCalled();
  });

  it("revokes only the captured session and preserves a replacement account installed before local clear", async () => {
    const capturedSession = {
      user: { id: expectedUserID },
      access_token: "access-a",
      refresh_token: "refresh-a",
    };
    const replacementSession = {
      user: { id: "00000000-0000-4000-8000-000000000103" },
      access_token: "access-b",
      refresh_token: "refresh-b",
    };
    let currentSession = capturedSession;
    let persistedSession = capturedSession;
    const revokedAccessTokens = [];
    const mutableSignOut = vi.fn(async () => {
      currentSession = replacementSession;
      persistedSession = replacementSession;
      revokedAccessTokens.push(currentSession.access_token);
      persistedSession = null;
      return { error: null };
    });
    const revokeCaptured = vi.fn(async (accessToken) => {
      revokedAccessTokens.push(accessToken);
      currentSession = replacementSession;
      persistedSession = replacementSession;
      return { error: null };
    });
    const compareAndClearLocalSession = vi.fn(async () => {
      if (
        persistedSession?.user?.id === capturedSession.user.id
        && persistedSession?.access_token === capturedSession.access_token
        && persistedSession?.refresh_token === capturedSession.refresh_token
      ) {
        persistedSession = null;
        return true;
      }
      return false;
    });
    const client = {
      rpc: vi.fn(async () => ({ data: { serverCleanupComplete: true }, error: null })),
      auth: {
        admin: { signOut: revokeCaptured },
        signOut: mutableSignOut,
      },
    };
    const onLocalSessionCleared = vi.fn(() => { currentSession = null; });

    await signOutSafely(client, {
      serviceWorker: null,
      scope: "local",
      expectedUserID,
      capturedSession,
      capturedRpcClient: client,
      compareAndClearLocalSession,
      onLocalSessionCleared,
      isCurrent: () => currentSession === capturedSession,
    });

    expect(mutableSignOut).not.toHaveBeenCalled();
    expect(revokeCaptured).toHaveBeenCalledWith("access-a", "local");
    expect(revokedAccessTokens).toEqual(["access-a"]);
    expect(compareAndClearLocalSession).toHaveBeenCalledTimes(1);
    expect(onLocalSessionCleared).not.toHaveBeenCalled();
    expect(currentSession).toBe(replacementSession);
    expect(persistedSession).toBe(replacementSession);
  });

  it("closes a token-rotated generation of the captured session without touching a new session", async () => {
    const sessionID = "00000000-0000-4000-8000-000000000301";
    const token = (generation) => {
      const payload = Buffer.from(JSON.stringify({ session_id: sessionID, generation })).toString("base64url");
      return `header.${payload}.signature`;
    };
    const captured = {
      user: { id: expectedUserID },
      access_token: token("captured"),
      refresh_token: "refresh-captured",
    };
    const rotated = {
      user: { id: expectedUserID },
      access_token: token("rotated"),
      refresh_token: "refresh-rotated",
    };
    const values = new Map();
    const storageKey = "sb-project-auth-token";
    const exactStorage = createExactSessionStorage({
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    });
    await exactStorage.setItem(storageKey, JSON.stringify(captured));
    let currentSession = captured;
    const capturedRpcClient = {
      rpc: vi.fn(async () => {
        currentSession = rotated;
        await exactStorage.setItem(storageKey, JSON.stringify(rotated));
        return { data: { serverCleanupComplete: true }, error: null };
      }),
    };
    const client = {
      auth: { admin: { signOut: vi.fn(async () => ({ error: null })) } },
    };
    const capturedRpcClientForSession = vi.fn(() => capturedRpcClient);

    await expect(signOutSafely(client, {
      serviceWorker: null,
      expectedUserID,
      capturedSession: captured,
      capturedRpcClientForSession,
      getCurrentSession: () => currentSession,
      compareAndClearLocalSession: (expected) => exactStorage.removeSessionIfMatches(storageKey, expected),
      onLocalSessionCleared: () => { currentSession = null; },
      isCurrent: () => sameAuthSessionLineage(currentSession, captured),
    })).resolves.toMatchObject({ localCleared: true });

    expect(currentSession).toBeNull();
    expect(capturedRpcClientForSession).toHaveBeenCalledWith(captured);
    expect(client.auth.admin.signOut).toHaveBeenCalledWith(rotated.access_token, "local");
    expect(await exactStorage.getItem(storageKey)).toBeNull();
  });

  it("requires a valid captured authenticated UUID before any cleanup mutation", async () => {
    const h = harness();

    await expect(signOutSafely(h.client, { serviceWorker: h.serviceWorker, ...h.options, expectedUserID: undefined }))
      .rejects.toThrow(/identity/i);
    await expect(signOutSafely(h.client, { serviceWorker: h.serviceWorker, ...h.options, expectedUserID: "user-a" }))
      .rejects.toThrow(/identity/i);
    expect(h.client.rpc).not.toHaveBeenCalled();
    expect(h.subscription.unsubscribe).not.toHaveBeenCalled();
    expect(h.client.auth.signOut).not.toHaveBeenCalled();
  });

  it("requires server-wide cleanup for the explicit everywhere action", async () => {
    const failed = harness({ serverOk: false });
    await expect(signOutSafely(failed.client, { serviceWorker: failed.serviceWorker, scope: "global", ...failed.options })).rejects.toThrow(/every device/i);
    expect(failed.client.auth.signOut).not.toHaveBeenCalled();
    expect(failed.client.auth.admin.signOut).not.toHaveBeenCalled();
    const passed = harness({ browserOk: false });
    await signOutSafely(passed.client, { serviceWorker: passed.serviceWorker, scope: "global", ...passed.options });
    expect(passed.client.auth.admin.signOut).toHaveBeenCalledWith("captured-access-token", "global");
    expect(passed.client.auth.signOut).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404])(
    "keeps local auth after ambiguous captured-session revocation status %i",
    async (status) => {
      const h = harness({ revokeError: { status } });

      await expect(signOutSafely(h.client, {
        serviceWorker: h.serviceWorker,
        ...h.options,
      })).rejects.toThrow(/securely closed/i);
      expect(h.options.compareAndClearLocalSession).not.toHaveBeenCalled();
      expect(h.options.onLocalSessionCleared).not.toHaveBeenCalled();
    },
  );

  it.each([new AuthSessionMissingError(), new AuthApiError("user absent", 403, "user_not_found")])(
    "clears a revoked local session when captured-token verification proves %j",
    async (error) => {
      const h = harness({ serverOk: false, serverError: { code: "42501" } });
      h.options.verifyCapturedSession.mockResolvedValue({ data: { user: null }, error });

      await expect(signOutSafely(h.client, h.options)).resolves.toMatchObject({ localCleared: true });

      expect(h.options.verifyCapturedSession).toHaveBeenCalledWith(capturedSession);
      expect(h.client.auth.getUser).not.toHaveBeenCalled();
      expect(h.client.auth.admin.signOut).not.toHaveBeenCalled();
      expect(h.options.compareAndClearLocalSession).toHaveBeenCalledWith(capturedSession);
      expect(h.options.onLocalSessionCleared).toHaveBeenCalledWith(capturedSession);
    },
  );

  it.each([{ status: 403 }, { status: 503, code: "session_not_found" }])(
    "does not infer revocation from an ambiguous captured-token refusal %j",
    async (error) => {
      const h = harness({ serverOk: false, serverError: { code: "42501" } });
      h.options.verifyCapturedSession.mockResolvedValue({ data: { user: null }, error });
      await expect(signOutSafely(h.client, h.options)).rejects.toMatchObject({ code: "42501" });
      expect(h.options.compareAndClearLocalSession).not.toHaveBeenCalled();
    },
  );

  it("preserves a replacement session when definitive revocation is learned after the account changes", async () => {
    let current = true;
    const h = harness({
      serverOk: false, serverError: { code: "42501" }, localClear: false,
      afterRpc: () => { current = false; },
    });
    h.options.verifyCapturedSession.mockResolvedValue({ data: { user: null }, error: new AuthSessionMissingError() });
    await expect(signOutSafely(h.client, { ...h.options, isCurrent: () => current }))
      .resolves.toMatchObject({ localCleared: false });
    expect(h.options.compareAndClearLocalSession).toHaveBeenCalledWith(capturedSession);
    expect(h.options.onLocalSessionCleared).not.toHaveBeenCalled();
  });

  it("does not claim global success or clear a replacement account when the captured session is absent", async () => {
    let current = true;
    const h = harness({
      serverOk: false, serverError: { code: "42501" }, localClear: false,
      afterRpc: () => { current = false; },
    });
    h.options.verifyCapturedSession.mockResolvedValue({ data: { user: null }, error: new AuthSessionMissingError() });
    await expect(signOutSafely(h.client, { ...h.options, scope: "global", isCurrent: () => current }))
      .rejects.toMatchObject({ code: "SIGN_OUT_OTHER_DEVICES_UNVERIFIED" });
    expect(h.options.onLocalSessionCleared).not.toHaveBeenCalled();
  });

  it("retains auth without falling back to the mutable client when no isolated verifier is available", async () => {
    const h = harness({ serverOk: false, serverError: { code: "42501" } });
    await expect(signOutSafely(h.client, { ...h.options, verifyCapturedSession: undefined }))
      .rejects.toMatchObject({ code: "42501" });
    expect(h.client.auth.getUser).not.toHaveBeenCalled();
    expect(h.options.compareAndClearLocalSession).not.toHaveBeenCalled();
  });

  it("clears locally when the captured revoke reports that the session is already gone", async () => {
    const h = harness({ revokeError: new AuthSessionMissingError() });
    await expect(signOutSafely(h.client, h.options)).resolves.toMatchObject({ localCleared: true });
    expect(h.options.onLocalSessionCleared).toHaveBeenCalledWith(capturedSession);
  });

  it("clears a definitively revoked local session without claiming other sessions were revoked", async () => {
    const h = harness({ revokeError: new AuthSessionMissingError() });
    await expect(signOutSafely(h.client, { ...h.options, scope: "global" }))
      .rejects.toMatchObject({ code: "SIGN_OUT_OTHER_DEVICES_UNVERIFIED" });
    expect(h.options.onLocalSessionCleared).toHaveBeenCalledWith(capturedSession);
  });

  it("rejects a 5xx captured-session revocation without clearing local auth", async () => {
    const h = harness({ revokeError: { status: 503 } });

    await expect(signOutSafely(h.client, {
      serviceWorker: h.serviceWorker,
      ...h.options,
    })).rejects.toThrow(/securely closed/i);
    await expect(signOutSafely(h.client, h.options)).rejects.toMatchObject({ code: "SIGN_OUT_PUSH_PAUSED" });
    expect(h.options.compareAndClearLocalSession).not.toHaveBeenCalled();
    expect(h.options.onLocalSessionCleared).not.toHaveBeenCalled();
    expect(h.client.auth.signOut).not.toHaveBeenCalled();
  });

  it("runs server cleanup through the captured-token RPC client", async () => {
    const h = harness();
    const capturedRpcClient = {
      rpc: vi.fn(async () => ({ data: { serverCleanupComplete: true }, error: null })),
    };

    await signOutSafely(h.client, {
      serviceWorker: h.serviceWorker,
      ...h.options,
      capturedRpcClient,
    });

    expect(capturedRpcClient.rpc).toHaveBeenCalledWith("prepare_my_signout", {
      p_scope: "local",
      p_expected_user_id: expectedUserID,
    });
    expect(h.client.rpc).not.toHaveBeenCalled();
  });

  it("distinguishes an absent browser subscription from an unverifiable browser", async () => {
    await expect(inspectAndRemoveBrowserPush(null)).resolves.toEqual({
      browserRemoved: false,
      noSubscription: true,
      browserVerified: true,
    });
    const none = { getRegistration: vi.fn(async () => ({ pushManager: { getSubscription: vi.fn(async () => null) } })) };
    await expect(inspectAndRemoveBrowserPush(none)).resolves.toMatchObject({ noSubscription: true, browserVerified: true });
    const unknown = { getRegistration: vi.fn().mockRejectedValue(new Error("worker unavailable")) };
    await expect(inspectAndRemoveBrowserPush(unknown)).resolves.toMatchObject({ noSubscription: false, browserVerified: false });
  });

  it("removes an inspected browser subscription and reports the verified outcome", async () => {
    const unsubscribe = vi.fn().mockResolvedValue(true);
    const serviceWorker = {
      getRegistration: vi.fn().mockResolvedValue({
        pushManager: { getSubscription: vi.fn().mockResolvedValue({ endpoint: "https://push.example/device", unsubscribe }) },
      }),
    };

    await expect(inspectAndRemoveBrowserPush(serviceWorker)).resolves.toEqual({
      browserRemoved: true,
      noSubscription: false,
      browserVerified: true,
    });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it("rejects invented logout scopes before mutation", async () => {
    const h = harness();
    await expect(signOutSafely(h.client, { serviceWorker: h.serviceWorker, scope: "others", ...h.options })).rejects.toThrow(/scope/i);
    expect(h.client.rpc).not.toHaveBeenCalled();
    expect(h.client.auth.signOut).not.toHaveBeenCalled();
  });
});

describe("exact browser auth session storage", () => {
  const storageKey = "sb-project-auth-token";
  const sessionID = "00000000-0000-4000-8000-000000000201";
  const jwt = (id, suffix = "") => {
    const payload = Buffer.from(JSON.stringify({ session_id: id, suffix })).toString("base64url");
    return `header.${payload}.signature`;
  };
  const session = (userID, accessToken, refreshToken) => ({
    user: { id: userID },
    access_token: accessToken,
    refresh_token: refreshToken,
  });

  function memoryStorage() {
    const values = new Map();
    return {
      values,
      getItem: vi.fn((key) => values.get(key) ?? null),
      setItem: vi.fn((key, value) => { values.set(key, value); }),
      removeItem: vi.fn((key) => { values.delete(key); }),
    };
  }

  it("fails closed when the persistent browser storage realm cannot be inspected", () => {
    const denied = {};
    Object.defineProperty(denied, "localStorage", {
      get() { throw new DOMException("denied", "SecurityError"); },
    });
    const unavailable = availableBrowserAuthStorage(denied);

    expect(() => unavailable.getItem(storageKey)).toThrow(/cannot be verified or cleared safely/i);
    expect(() => unavailable.setItem(storageKey, "session")).toThrow(/cannot be verified or cleared safely/i);
    expect(() => unavailable.removeItem(storageKey)).toThrow(/cannot be verified or cleared safely/i);
  });

  it.each(["setItem", "removeItem"])(
    "retains an existing durable session when browser storage permits reads but %s throws",
    (deniedOperation) => {
      const values = new Map([[storageKey, "durable-session"]]);
      const readOnlyStorage = {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => {
          if (deniedOperation === "setItem") throw new DOMException("denied", "SecurityError");
          values.set(key, value);
        },
        removeItem: (key) => {
          if (deniedOperation === "removeItem") throw new DOMException("denied", "SecurityError");
          values.delete(key);
        },
      };
      const selectedStorage = availableBrowserAuthStorage({
        localStorage: readOnlyStorage,
        crypto: { randomUUID: () => `probe-${deniedOperation}` },
      });

      expect(selectedStorage).toBe(readOnlyStorage);
      expect(selectedStorage.getItem(storageKey)).toBe("durable-session");
      expect(() => selectedStorage[deniedOperation](storageKey, "replacement"))
        .toThrow(/denied/i);
      expect(values.get(storageKey)).toBe("durable-session");
    },
  );

  it("uses isolated memory only when no persistent browser storage implementation exists", () => {
    const fallback = availableBrowserAuthStorage({});
    fallback.setItem(storageKey, "session");
    expect(fallback.getItem(storageKey)).toBe("session");
    fallback.removeItem(storageKey);
    expect(fallback.getItem(storageKey)).toBeNull();
  });

  it("fails safely across malformed persisted metadata and unavailable lock or fence reads", async () => {
    expect(() => createExactSessionStorage({})).toThrow(/unavailable/i);

    const throwingWindow = {};
    Object.defineProperty(throwingWindow, "navigator", {
      get() { throw new DOMException("denied", "SecurityError"); },
    });
    vi.stubGlobal("window", throwingWindow);

    const rawStorage = memoryStorage();
    rawStorage.values.set(storageKey, "{");
    rawStorage.values.set(`${storageKey}.closed-session-index`, "{");
    const exactStorage = createExactSessionStorage(rawStorage);
    expect(await exactStorage.getItem(storageKey)).toBe("{");

    const captured = session(
      "00000000-0000-4000-8000-000000000202",
      jwt(sessionID, "captured"),
      "refresh-a",
    );
    await exactStorage.setItem(storageKey, JSON.stringify(captured));
    expect(await exactStorage.removeSessionIfMatches(storageKey, captured)).toBe(true);
    await exactStorage.removeItem(storageKey);

    const malformedPayload = Buffer.from("{").toString("base64url");
    expect(storageEventClosesAuthSession({
      key: `${storageKey}.closed-session.${sessionID}`,
      newValue: "closed",
    }, storageKey, { access_token: `header.${malformedPayload}.signature` })).toBe(false);

    const unreadableStorage = createExactSessionStorage({
      getItem: () => { throw new DOMException("denied", "SecurityError"); },
      setItem: vi.fn(),
      removeItem: vi.fn(),
    });
    expect(unreadableStorage.isSessionClosed(storageKey, captured)).toBe(true);
  });

  it("logically clears a readable session when physical removal is denied but its tombstone is durable", async () => {
    const userID = "00000000-0000-4000-8000-000000000202";
    const captured = session(userID, jwt(sessionID, "captured"), "refresh-a");
    const rotated = session(userID, jwt(sessionID, "rotated"), "refresh-b");
    const values = new Map([[storageKey, JSON.stringify(captured)]]);
    const durableButRemoveDenied = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: () => { throw new DOMException("denied", "SecurityError"); },
    };
    const exactStorage = createExactSessionStorage(
      availableBrowserAuthStorage({ localStorage: durableButRemoveDenied }),
    );

    await expect(Promise.resolve(exactStorage.removeSessionIfMatches(storageKey, captured))).resolves.toBe(true);
    await expect(Promise.resolve(exactStorage.getItem(storageKey))).resolves.toBeNull();
    await expect(Promise.resolve().then(() => exactStorage.setItem(storageKey, JSON.stringify(rotated))))
      .rejects.toThrow(/closed browser session/i);
    expect(values.get(storageKey)).toBe(JSON.stringify(captured));
  });

  it("refuses to claim local cleanup when a readable session cannot receive a durable tombstone", async () => {
    const userID = "00000000-0000-4000-8000-000000000202";
    const captured = session(userID, jwt(sessionID, "captured"), "refresh-a");
    const values = new Map([[storageKey, JSON.stringify(captured)]]);
    const readOnlyStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: () => { throw new DOMException("denied", "SecurityError"); },
      removeItem: (key) => { values.delete(key); },
    };
    const exactStorage = createExactSessionStorage(
      availableBrowserAuthStorage({ localStorage: readOnlyStorage }),
    );

    await expect(Promise.resolve().then(() => exactStorage.removeSessionIfMatches(storageKey, captured)))
      .rejects.toThrow(/denied/i);
    await expect(Promise.resolve(exactStorage.getItem(storageKey))).resolves.toBe(JSON.stringify(captured));
  });

  it("removes only an exact user/access/refresh match and preserves a replacement session", async () => {
    const rawStorage = memoryStorage();
    const exactStorage = createExactSessionStorage(rawStorage);
    const captured = session(
      "00000000-0000-4000-8000-000000000202",
      jwt(sessionID, "a"),
      "refresh-a",
    );
    const replacement = session(
      "00000000-0000-4000-8000-000000000203",
      jwt("00000000-0000-4000-8000-000000000204", "b"),
      "refresh-b",
    );

    await exactStorage.setItem(storageKey, JSON.stringify(replacement));
    expect(await exactStorage.removeSessionIfMatches(storageKey, captured)).toBe(false);
    expect(await exactStorage.getItem(storageKey)).toBe(JSON.stringify(replacement));
    expect(rawStorage.removeItem).not.toHaveBeenCalled();
  });

  it.each([false, true])("publishes an explicit signal only for requested explicit sign-out (%s)", async (explicitSignOut) => {
    const raw = memoryStorage();
    const adapter = createExactSessionStorage(raw);
    const captured = session("00000000-0000-4000-8000-000000000202", jwt(sessionID, "a"), "refresh-a");
    await adapter.setItem(storageKey, JSON.stringify(captured));
    expect(await adapter.removeSessionIfMatches(storageKey, captured, { explicitSignOut })).toBe(true);
    expect(raw.getItem(`${storageKey}.explicit-sign-out`)).toBe(explicitSignOut ? sessionID : null);
    expect(raw.getItem(`${storageKey}.closed-session.${sessionID}`)).toBe("closed");
    expect(storageEventExplicitlySignsOutSession({ key: `${storageKey}.explicit-sign-out`, newValue: sessionID }, storageKey, sessionID)).toBe(true);
    expect(storageEventExplicitlySignsOutSession({ key: `${storageKey}.explicit-sign-out`, newValue: null }, storageKey, sessionID)).toBe(false);
  });

  it("does not announce an obsolete sign-out over a replacement login", async () => {
    const raw = memoryStorage();
    const adapter = createExactSessionStorage(raw);
    const captured = session("00000000-0000-4000-8000-000000000202", jwt(sessionID, "a"), "refresh-a");
    const newer = session(captured.user.id, jwt("00000000-0000-4000-8000-000000000204", "b"), "refresh-b");
    await adapter.setItem(storageKey, JSON.stringify(newer));
    expect(await adapter.removeSessionIfMatches(storageKey, captured, { explicitSignOut: true })).toBe(false);
    expect(raw.getItem(`${storageKey}.explicit-sign-out`)).toBeNull();
    expect(await adapter.getItem(storageKey)).toBe(JSON.stringify(newer));
  });

  it("blocks a late refresh write from the cleared session without blocking a new session", async () => {
    const rawStorage = memoryStorage();
    const exactStorage = createExactSessionStorage(rawStorage);
    const userID = "00000000-0000-4000-8000-000000000202";
    const captured = session(userID, jwt(sessionID, "a"), "refresh-a");
    const lateRefresh = session(userID, jwt(sessionID, "rotated"), "refresh-rotated");
    const replacement = session(
      "00000000-0000-4000-8000-000000000203",
      jwt("00000000-0000-4000-8000-000000000204", "b"),
      "refresh-b",
    );

    await exactStorage.setItem(storageKey, JSON.stringify(captured));
    expect(await exactStorage.removeSessionIfMatches(storageKey, captured)).toBe(true);
    await expect(Promise.resolve().then(() => exactStorage.setItem(storageKey, JSON.stringify(lateRefresh))))
      .rejects.toThrow(/closed browser session/i);
    expect(await exactStorage.getItem(storageKey)).toBeNull();
    await exactStorage.setItem(storageKey, JSON.stringify(replacement));
    expect(await exactStorage.getItem(storageKey)).toBe(JSON.stringify(replacement));
  });

  it("clears a rotated token from the same session lineage but preserves a same-user new login", async () => {
    const rawStorage = memoryStorage();
    const exactStorage = createExactSessionStorage(rawStorage);
    const userID = "00000000-0000-4000-8000-000000000202";
    const captured = session(userID, jwt(sessionID, "a"), "refresh-a");
    const rotated = session(userID, jwt(sessionID, "rotated"), "refresh-rotated");
    const newLogin = session(
      userID,
      jwt("00000000-0000-4000-8000-000000000205", "new-login"),
      "refresh-new-login",
    );

    await exactStorage.setItem(storageKey, JSON.stringify(rotated));
    expect(await exactStorage.removeSessionIfMatches(storageKey, captured)).toBe(true);
    expect(await exactStorage.getItem(storageKey)).toBeNull();

    await exactStorage.setItem(storageKey, JSON.stringify(newLogin));
    expect(await exactStorage.removeSessionIfMatches(storageKey, captured)).toBe(false);
    expect(await exactStorage.getItem(storageKey)).toBe(JSON.stringify(newLogin));
  });

  it("shares durable tombstones across tab-local adapters and blocks resurrection", async () => {
    const rawStorage = memoryStorage();
    const tabOne = createExactSessionStorage(rawStorage);
    const tabTwo = createExactSessionStorage(rawStorage);
    const userID = "00000000-0000-4000-8000-000000000202";
    const captured = session(userID, jwt(sessionID, "captured"), "refresh-a");
    const rotated = session(userID, jwt(sessionID, "rotated"), "refresh-b");

    await tabOne.setItem(storageKey, JSON.stringify(captured));
    expect(await tabTwo.getItem(storageKey)).toBe(JSON.stringify(captured));
    expect(await tabOne.removeSessionIfMatches(storageKey, captured)).toBe(true);
    expect(tabTwo.isSessionClosed(storageKey, rotated)).toBe(true);
    await expect(Promise.resolve().then(() => tabTwo.setItem(storageKey, JSON.stringify(rotated))))
      .rejects.toThrow(/closed browser session/i);
    expect(await tabTwo.getItem(storageKey)).toBeNull();
  });

  it("terminally fences a displaced lineage when a distinct session replaces it", async () => {
    const rawStorage = memoryStorage();
    const tabOne = createExactSessionStorage(rawStorage);
    const tabTwo = createExactSessionStorage(rawStorage);
    const userID = "00000000-0000-4000-8000-000000000202";
    const first = session(userID, jwt(sessionID, "first"), "refresh-first");
    const replacement = session(
      userID,
      jwt("00000000-0000-4000-8000-000000000205", "replacement"),
      "refresh-replacement",
    );
    const staleRefresh = session(userID, jwt(sessionID, "stale"), "refresh-stale");

    await tabOne.setItem(storageKey, JSON.stringify(first));
    await tabTwo.setItem(storageKey, JSON.stringify(replacement));

    expect(tabOne.isSessionClosed(storageKey, first)).toBe(true);
    await expect(Promise.resolve().then(() => tabOne.setItem(storageKey, JSON.stringify(staleRefresh))))
      .rejects.toThrow(/closed browser session/i);
    expect(await tabTwo.getItem(storageKey)).toBe(JSON.stringify(replacement));
  });

  it("keeps the original lineage usable when the replacement tuple cannot be written", async () => {
    const raw = memoryStorage();
    const adapter = createExactSessionStorage(raw);
    const first = session("00000000-0000-4000-8000-000000000202", jwt(sessionID), "first");
    const replacement = session(first.user.id, jwt("00000000-0000-4000-8000-000000000205"), "replacement");
    await adapter.setItem(storageKey, JSON.stringify(first));
    raw.setItem.mockImplementation((key, value) => {
      if (key === storageKey && value === JSON.stringify(replacement)) throw new DOMException("full", "QuotaExceededError");
      raw.values.set(key, value);
    });

    await expect(Promise.resolve().then(() => adapter.setItem(storageKey, JSON.stringify(replacement))))
      .rejects.toThrow("full");
    expect(adapter.isSessionClosed(storageKey, first)).toBe(false);
    expect(await adapter.getItem(storageKey)).toBe(JSON.stringify(first));
  });

  it("restores the original tuple if a replacement commits but its displaced-lineage fence cannot be written", async () => {
    const raw = memoryStorage();
    const adapter = createExactSessionStorage(raw);
    const first = session("00000000-0000-4000-8000-000000000202", jwt(sessionID), "first");
    const replacement = session(first.user.id, jwt("00000000-0000-4000-8000-000000000205"), "replacement");
    await adapter.setItem(storageKey, JSON.stringify(first));
    raw.setItem.mockImplementation((key, value) => {
      if (key.startsWith(`${storageKey}.closed-session.`)) throw new DOMException("full", "QuotaExceededError");
      raw.values.set(key, value);
    });

    await expect(Promise.resolve().then(() => adapter.setItem(storageKey, JSON.stringify(replacement))))
      .rejects.toThrow("full");
    expect(adapter.isSessionClosed(storageKey, first)).toBe(false);
    expect(await adapter.getItem(storageKey)).toBe(JSON.stringify(first));
  });

  it("leaves no orphan fence when its index cannot be persisted", async () => {
    const raw = memoryStorage();
    const adapter = createExactSessionStorage(raw);
    const first = session("00000000-0000-4000-8000-000000000202", jwt(sessionID), "first");
    const replacement = session(first.user.id, jwt("00000000-0000-4000-8000-000000000205"), "replacement");
    await adapter.setItem(storageKey, JSON.stringify(first));
    raw.setItem.mockImplementation((key, value) => {
      if (key === `${storageKey}.closed-session-index`) throw new DOMException("full", "QuotaExceededError");
      raw.values.set(key, value);
    });

    await expect(Promise.resolve().then(() => adapter.setItem(storageKey, JSON.stringify(replacement))))
      .rejects.toThrow("full");
    expect(adapter.isSessionClosed(storageKey, first)).toBe(false);
    expect(await adapter.getItem(storageKey)).toBe(JSON.stringify(first));
  });

  it("preserves the replacement and indexed fence if a storage writer commits the fence then throws", async () => {
    const raw = memoryStorage();
    const adapter = createExactSessionStorage(raw);
    const first = session("00000000-0000-4000-8000-000000000202", jwt(sessionID), "first");
    const replacement = session(first.user.id, jwt("00000000-0000-4000-8000-000000000205"), "replacement");
    await adapter.setItem(storageKey, JSON.stringify(first));
    raw.setItem.mockImplementation((key, value) => {
      raw.values.set(key, value);
      if (key.startsWith(`${storageKey}.closed-session.`)) throw new Error("committed before failure");
    });
    await expect(Promise.resolve().then(() => adapter.setItem(storageKey, JSON.stringify(replacement))))
      .rejects.toThrow("committed before failure");
    expect(adapter.isSessionClosed(storageKey, first)).toBe(true);
    expect(await adapter.getItem(storageKey)).toBe(JSON.stringify(replacement));
    expect(JSON.parse(raw.getItem(`${storageKey}.closed-session-index`))).toContain(sessionID);
  });

  it("preserves a replacement when stale auth-js removal resumes in an older tab", async () => {
    const rawStorage = memoryStorage();
    const staleTab = createExactSessionStorage(rawStorage);
    const replacementTab = createExactSessionStorage(rawStorage);
    const userID = "00000000-0000-4000-8000-000000000202";
    const first = session(userID, jwt(sessionID, "first"), "refresh-first");
    const replacement = session(
      userID,
      jwt("00000000-0000-4000-8000-000000000205", "replacement"),
      "refresh-replacement",
    );

    await staleTab.setItem(storageKey, JSON.stringify(first));
    expect(await staleTab.getItem(storageKey)).toBe(JSON.stringify(first));
    await replacementTab.setItem(storageKey, JSON.stringify(replacement));

    await expect(Promise.resolve().then(() => staleTab.removeItem(storageKey)))
      .rejects.toThrow(/stale browser auth operation/i);

    expect(await replacementTab.getItem(storageKey)).toBe(JSON.stringify(replacement));
    expect(rawStorage.removeItem).not.toHaveBeenCalledWith(storageKey);
  });

  it("fences and removes the same lineage observed by auth-js", async () => {
    const rawStorage = memoryStorage();
    const exactStorage = createExactSessionStorage(rawStorage);
    const current = session(
      "00000000-0000-4000-8000-000000000202",
      jwt(sessionID, "current"),
      "refresh-current",
    );

    await exactStorage.setItem(storageKey, JSON.stringify(current));
    expect(await exactStorage.getItem(storageKey)).toBe(JSON.stringify(current));
    await exactStorage.removeItem(storageKey);

    expect(await exactStorage.getItem(storageKey)).toBeNull();
    expect(exactStorage.isSessionClosed(storageKey, current)).toBe(true);
    expect(rawStorage.removeItem).toHaveBeenCalledWith(storageKey);
  });

  it("bounds durable tombstones while retaining the newest closed-session fence", async () => {
    const rawStorage = memoryStorage();
    const exactStorage = createExactSessionStorage(rawStorage);
    const userID = "00000000-0000-4000-8000-000000000202";
    let newest;
    let newestID;

    for (let index = 1; index <= 70; index += 1) {
      const id = `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
      newestID = id;
      newest = session(userID, jwt(id, `closed-${index}`), `refresh-${index}`);
      await exactStorage.setItem(storageKey, JSON.stringify(newest));
      expect(await exactStorage.removeSessionIfMatches(storageKey, newest)).toBe(true);
    }

    const tombstones = [...rawStorage.values.keys()]
      .filter((key) => key.startsWith(`${storageKey}.closed-session.`));
    expect(tombstones.length).toBeLessThanOrEqual(64);
    expect(rawStorage.values.get(`${storageKey}.closed-session.${newestID}`)).toBe("closed");
    expect(exactStorage.isSessionClosed(storageKey, newest)).toBe(true);
  });

  it("maps only the exact durable tombstone event to its open session lineage", () => {
    const current = session(
      "00000000-0000-4000-8000-000000000202",
      jwt(sessionID, "current"),
      "refresh-current",
    );
    const replacement = session(
      current.user.id,
      jwt("00000000-0000-4000-8000-000000000299", "replacement"),
      "refresh-replacement",
    );
    const event = {
      key: `${storageKey}.closed-session.${sessionID}`,
      newValue: "closed",
    };

    expect(storageEventClosesAuthSession(event, storageKey, current)).toBe(true);
    expect(storageEventClosesAuthSession(event, storageKey, replacement)).toBe(false);
  });
});

describe("auth storage session lineage through the configured adapter", () => {
  const storageKey = "sb-project-auth-token";
  const sessionID = "00000000-0000-4000-8000-000000000201";
  const userID = "00000000-0000-4000-8000-000000000202";
  const jwt = (id, suffix = "") => {
    const payload = Buffer.from(JSON.stringify({ session_id: id, suffix })).toString("base64url");
    return `header.${payload}.signature`;
  };
  const sessionTuple = (id = sessionID) => JSON.stringify({
    user: { id: userID },
    access_token: jwt(id),
    refresh_token: "refresh-a",
  });

  it("restores lineage, allows sensitive writes, and sweeps residue when localStorage is absent", async () => {
    const browserStorage = availableBrowserAuthStorage({});
    expect(browserStorage.__unionGroundIsolated).toBe(true);

    const configured = createExactSessionStorage(browserStorage);
    await configured.setItem(storageKey, sessionTuple());

    const readLineage = () => readAuthStorageSessionLineage(browserStorage, storageKey);
    expect(readAuthStorageSessionLineage(globalThis.localStorage, storageKey)).toBeUndefined();
    expect(readLineage()).toBe(sessionID);

    const store = createMemoryStore();
    const stamp = sessionStamp(1, "memory-boot", sessionID);

    // A saved copy an older build left behind (nothing writes one now) is
    // residue of this lineage and goes with the sweep below.
    await store.putSnapshot({ userId: userID, savedAt: 1000, data: { member: { id: userID } }, ...stamp });
    expect(await store.getSnapshot(userID)).toMatchObject({ sessionLineage: sessionID });

    await expect(enqueueWrite(store, userID, {
      kind: "profile",
      key: "self",
      args: { fullName: "Ada" },
    }, 1000, stamp, () => true, readLineage)).resolves.toBe(true);
    await expect(enqueueWrite(store, userID, {
      kind: "formDraft",
      key: "grievance",
      args: { fields: { statement: "offline draft" } },
    }, 1100, stamp, () => true, readLineage)).resolves.toBe(true);

    browserStorage.setItem(`${storageKey}.closed-session.${sessionID}`, "closed");
    expect(readLineage()).toBeNull();

    await forgetDepartedMemberDevice(store, userID, {
      sessionGeneration: stamp.sessionGeneration,
      deviceBoot: stamp.deviceBoot,
      sessionLineage: sessionID,
      readActiveSessionLineage: readLineage,
    });

    expect(await store.getSnapshot(userID)).toBeNull();
    expect(await pendingCount(store, userID)).toBe(0);
  });

  it("keeps the durable localStorage lineage path unchanged", () => {
    const values = new Map();
    const durable = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
      removeItem: (key) => { values.delete(key); },
    };
    const adapter = availableBrowserAuthStorage({ localStorage: durable });
    expect(adapter).toBe(durable);
    adapter.setItem(storageKey, sessionTuple());
    expect(readAuthStorageSessionLineage(adapter, storageKey)).toBe(sessionID);
    adapter.setItem(`${storageKey}.closed-session.${sessionID}`, "closed");
    expect(readAuthStorageSessionLineage(adapter, storageKey)).toBeNull();
  });

  it("returns undefined when the configured adapter cannot be read", () => {
    expect(readAuthStorageSessionLineage(null, storageKey)).toBeUndefined();
    expect(readAuthStorageSessionLineage({ getItem: () => { throw new DOMException("denied", "SecurityError"); } }, storageKey))
      .toBeUndefined();
    expect(readAuthStorageSessionLineage({ getItem: () => null }, storageKey)).toBeNull();
  });

  it("reads App lineage through the configured adapter rather than globalThis.localStorage", () => {
    const app = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
    const start = app.indexOf("function appAuthStorageSessionLineage");
    const end = app.indexOf("function MemberApp");
    const fn = app.slice(start, end);
    expect(start).toBeGreaterThan(-1);
    expect(fn).toContain("authStorageAdapter()");
    expect(fn).toContain("readAuthStorageSessionLineage(");
    expect(fn).not.toContain("globalThis.localStorage");
  });
});

describe("web auth publication wiring", () => {
  it("publishes the auth callback session to sessionRef before any React state transition", () => {
    const app = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
    const listenerStart = app.indexOf("supabase.auth.onAuthStateChange((event, nextSession) => {");
    const listenerEnd = app.indexOf("\n    });", listenerStart);
    const listener = app.slice(listenerStart, listenerEnd);
    const refWrite = listener.indexOf("sessionRef.current = nextSession");
    const generationWrite = listener.indexOf("beginSessionGeneration(", refWrite);
    const reactWrite = listener.indexOf("setSession(nextSession)", refWrite);

    expect(listenerStart).toBeGreaterThan(-1);
    expect(refWrite).toBeGreaterThan(-1);
    expect(refWrite).toBeLessThan(generationWrite);
    expect(refWrite).toBeLessThan(reactWrite);
    expect(app).not.toContain("useEffect(() => { sessionRef.current = session; }, [session])");
  });

  it("does not let a stale initial getSession result overwrite a newer auth event", () => {
    const app = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
    const effectStart = app.indexOf("if (!hasAppBackend || demoActive) return undefined;");
    const effectEnd = app.indexOf("}, [beginSessionGeneration, demoActive, landSignedOutAtRoot]);", effectStart);
    const authEffect = app.slice(effectStart, effectEnd);
    const initialGuard = authEffect.indexOf("authRevisionRef.current !== restoreRevision");
    const listenerStart = authEffect.indexOf("supabase.auth.onAuthStateChange");
    const revisionAdvance = authEffect.indexOf("authRevisionRef.current += 1;", listenerStart);
    const tombstoneRefusal = authEffect.indexOf("appAuthSessionIsClosed(nextSession)", listenerStart);
    const publish = authEffect.indexOf("sessionRef.current = nextSession;", listenerStart);

    expect(effectStart).toBeGreaterThan(-1);
    expect(initialGuard).toBeGreaterThan(-1);
    expect(revisionAdvance).toBeGreaterThan(listenerStart);
    expect(tombstoneRefusal).toBeGreaterThan(revisionAdvance);
    expect(tombstoneRefusal).toBeLessThan(publish);
    expect(authEffect.slice(tombstoneRefusal, publish)).toContain("sameAuthSessionLineage(current, nextSession)");
    expect(publish).toBeGreaterThan(revisionAdvance);
    expect(authEffect.indexOf("setLoading(false);", publish)).toBeGreaterThan(publish);
  });

  it("routes an uninspectable auth store to recovery instead of normal signed-out entry", () => {
    const app = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
    const effectStart = app.indexOf("if (!hasAppBackend || demoActive) return undefined;");
    const effectEnd = app.indexOf("}, [beginSessionGeneration, demoActive, landSignedOutAtRoot]);", effectStart);
    const authEffect = app.slice(effectStart, effectEnd);
    const initialNullGuard = authEffect.indexOf('event === "INITIAL_SESSION" && !nextSession && !initialSessionSettled');
    const explicitFailure = authEffect.indexOf("setAuthStorageUnavailable(true)");
    const restoreRevisionGuard = authEffect.indexOf("authRevisionRef.current !== restoreRevision");
    const recoveryScreen = app.indexOf("if (authStorageUnavailable)");
    const signedOutScreen = app.indexOf("if (!session) {", recoveryScreen);

    expect(authEffect).toContain("if (appAuthStorageUnavailable)");
    expect(initialNullGuard).toBeGreaterThan(-1);
    expect(explicitFailure).toBeGreaterThan(-1);
    expect(restoreRevisionGuard).toBeGreaterThan(-1);
    expect(restoreRevisionGuard).toBeLessThan(explicitFailure);
    expect(recoveryScreen).toBeGreaterThan(-1);
    expect(recoveryScreen).toBeLessThan(signedOutScreen);
    expect(app.slice(recoveryScreen, signedOutScreen)).toContain('tr("app.authStorageBody")');
  });

  it("generation-checks a deferred MFA session read and handles exact cross-tab closure", () => {
    const app = fs.readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
    const mfaStart = app.indexOf("const handleMfaStandingChanged");
    const mfaEnd = app.indexOf("// Same pattern", mfaStart);
    const mfa = app.slice(mfaStart, mfaEnd);
    const storageStart = app.indexOf("const onStorage = (event) =>");
    const storageEnd = app.indexOf("globalThis.addEventListener", storageStart);
    const storage = app.slice(storageStart, storageEnd);

    expect(mfa).toContain("const expectedRevision = authRevisionRef.current;");
    expect(mfa).toContain("authRevisionRef.current !== expectedRevision");
    expect(mfa.match(/sameAuthSessionLineage/g)).toHaveLength(3);
    expect(storage).toContain("storageEventClosesAuthSession(event, appAuthStorageKey, current)");
    expect(storage.indexOf("authRevisionRef.current += 1;")).toBeLessThan(
      storage.indexOf("sessionRef.current = null;"),
    );
  });
});

describe("session RPC adapters", () => {
  it("uses parameter-free self inventory and opaque revoke/signout arguments", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: [{ handle: "a".repeat(64) }], error: null })
      .mockResolvedValueOnce({ data: { revoked: true }, error: null })
      .mockResolvedValueOnce({ data: { serverCleanupComplete: true }, error: null });
    const client = { rpc };
    await listMemberSessions(client);
    await revokeMemberSession(client, "b".repeat(64));
    await prepareMemberSignOut(client, "global", "00000000-0000-4000-8000-000000000102");
    expect(rpc.mock.calls).toEqual([
      ["list_my_sessions"],
      ["revoke_my_session", { p_session_handle: "b".repeat(64) }],
      ["prepare_my_signout", {
        p_scope: "global",
        p_expected_user_id: "00000000-0000-4000-8000-000000000102",
      }],
    ]);
  });
});

describe("listMemberSessions", () => {
  // The caller never sends its own user id: the row-inventory RPC is
  // definer-scoped to `auth.uid()` server-side (see "s.user_id = caller"
  // above), so a client that had to pass an id could be tricked into asking
  // for someone else's devices. Pin the zero-argument call so that scoping
  // stays server-side rather than drifting back onto the client.
  it("asks the self-scoped RPC for the caller's own sessions, with no arguments", async () => {
    const rows = [{ deviceLabel: "Windows computer", browserLabel: "Chrome", current: true }];
    const rpc = vi.fn().mockResolvedValue({ data: rows, error: null });
    await expect(listMemberSessions({ rpc })).resolves.toBe(rows);
    expect(rpc).toHaveBeenCalledWith("list_my_sessions");
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  // requireData defaults a null payload to [], which matters here: an empty
  // row set (every other session already expired) must render as "no other
  // devices", not crash the settings list on a null map/length read.
  it("falls back to an empty list instead of null when the RPC reports no rows", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    await expect(listMemberSessions({ rpc })).resolves.toEqual([]);
  });

  // A refusal here must surface as the same MemberApiError shape every other
  // read uses, carrying the server's code/details/hint, so the Settings view
  // error boundary and any future caller can branch on `code` instead of
  // parsing a sentence.
  it("wraps an RPC failure in a MemberApiError labeled Sessions", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "permission denied for function list_my_sessions", code: "42501" },
    });
    const thrown = await listMemberSessions({ rpc }).then(() => null, (error) => error);
    expect(thrown).toBeInstanceOf(MemberApiError);
    expect(thrown.label).toBe("Sessions");
    expect(thrown.code).toBe("42501");
    expect(thrown.message).toBe("Sessions: permission denied for function list_my_sessions");
  });
});

// BUG-UG-SIGN-OUT-EVERYWHERE-OTHER-DEVICE-STALE-20261103 (#6885), gate
// r3s1: a session the revocation watcher already proved absent goes straight
// to the local cleanup, so a prepare call that never answers cannot hold it.
describe("signOutSafely with a session already proved absent", () => {
  const userID = "00000000-0000-4000-8000-000000006885";
  const token = (sessionID) => `header.${btoa(JSON.stringify({ session_id: sessionID }))}.sig`;
  const captured = { user: { id: userID }, access_token: token("10000000-0000-4000-8000-000000006885"), refresh_token: "r-6885" };

  function options(overrides = {}) {
    const order = [];
    const stalled = { rpc: vi.fn(() => new Promise(() => {})) };
    return {
      order,
      stalled,
      client: { auth: { admin: { signOut: vi.fn(async () => ({ error: null })) } } },
      options: {
        scope: "local",
        expectedUserID: userID,
        capturedSession: captured,
        capturedRpcClient: stalled,
        verifyCapturedSession: vi.fn(() => new Promise(() => {})),
        compareAndClearLocalSession: vi.fn(async () => { order.push("local-clear"); return true; }),
        onLocalSessionCleared: vi.fn(async () => { order.push("local-publish"); }),
        ...overrides,
      },
    };
  }

  it("skips prepare and revocation and clears this device when the proof matches the lineage", async () => {
    const h = options({ provenAbsentSession: { ...captured, access_token: captured.access_token } });
    await expect(signOutSafely(h.client, h.options)).resolves.toEqual({ error: null, localCleared: true });
    expect(h.stalled.rpc).not.toHaveBeenCalled();
    expect(h.options.verifyCapturedSession).not.toHaveBeenCalled();
    expect(h.client.auth.admin.signOut).not.toHaveBeenCalled();
    expect(h.order).toEqual(["local-clear", "local-publish"]);
  });

  it("still prepares when the proof is for another session lineage", async () => {
    const other = { ...captured, access_token: token("20000000-0000-4000-8000-000000006885") };
    const h = options({ provenAbsentSession: other });
    void signOutSafely(h.client, h.options);
    await Promise.resolve();
    expect(h.stalled.rpc).toHaveBeenCalledWith("prepare_my_signout", { p_scope: "local", p_expected_user_id: userID });
    expect(h.order).toEqual([]);
  });

  it("does not claim other devices on a global sign-out from a proof", async () => {
    const h = options({ scope: "global", provenAbsentSession: captured });
    await expect(signOutSafely(h.client, h.options)).rejects.toMatchObject({ code: "SIGN_OUT_OTHER_DEVICES_UNVERIFIED" });
    expect(h.stalled.rpc).not.toHaveBeenCalled();
    expect(h.order).toEqual(["local-clear", "local-publish"]);
  });
});
