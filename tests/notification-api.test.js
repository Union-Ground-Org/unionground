// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  hasPushSubscription,
  subscribeToNotificationInserts,
  subscribeToPush,
  unsubscribeFromPush,
  urlBase64ToUint8Array,
} from "../src/lib/memberApi.js";

describe("subscribeToPush", () => {
  // A direct upsert cannot take an endpoint away from a previous owner (RLS
  // stops a member touching another member's row), so the write has to go
  // through the definer RPC or a shared device silently keeps delivering to
  // whoever enabled push first.
  it("claims the endpoint through the definer RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const from = vi.fn();
    await subscribeToPush({ rpc, from }, {
      endpoint: "https://fcm.googleapis.com/sub-a",
      keys: { p256dh: "p256-material", auth: "auth-material" },
    });
    expect(from).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith("upsert_push_subscription", {
      p_endpoint: "https://fcm.googleapis.com/sub-a",
      p_p256dh: "p256-material",
      p_auth: "auth-material",
    });
  });

  it("sends no device fingerprint", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    await subscribeToPush({ rpc }, { endpoint: "https://fcm.googleapis.com/x", keys: { p256dh: "k", auth: "a" } });
    const payload = JSON.stringify(rpc.mock.calls[0][1]);
    expect(payload).not.toMatch(/user_agent|userAgent/i);
  });

  it("throws on a write error instead of silently losing the subscription", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "denied" } });
    await expect(
      subscribeToPush({ rpc }, { endpoint: "https://fcm.googleapis.com/x", keys: {} }),
    ).rejects.toThrow(/denied/);
  });
});

describe("hasPushSubscription", () => {
  function client(result) {
    const maybeSingle = vi.fn().mockResolvedValue(result);
    const eqEndpoint = vi.fn().mockReturnValue({ maybeSingle });
    const eqUser = vi.fn().mockReturnValue({ eq: eqEndpoint });
    const select = vi.fn().mockReturnValue({ eq: eqUser });
    return { client: { from: vi.fn().mockReturnValue({ select }) }, eqUser, eqEndpoint };
  }

  it("scopes the lookup to this member and this endpoint", async () => {
    const { client: c, eqUser, eqEndpoint } = client({ data: { id: "s1" }, error: null });
    await expect(hasPushSubscription(c, "u1", "https://fcm.googleapis.com/a")).resolves.toBe(true);
    expect(eqUser).toHaveBeenCalledWith("user_id", "u1");
    expect(eqEndpoint).toHaveBeenCalledWith("endpoint", "https://fcm.googleapis.com/a");
  });

  // The row exists but belongs to the member who used this browser before, so
  // RLS hides it — which is exactly the answer the caller needs.
  it("reports false when the row belongs to someone else", async () => {
    const { client: c } = client({ data: null, error: null });
    await expect(hasPushSubscription(c, "u2", "https://fcm.googleapis.com/a")).resolves.toBe(false);
  });
});

describe("unsubscribeFromPush", () => {
  it("deletes exactly the caller's row for that endpoint", async () => {
    const eqEndpoint = vi.fn().mockResolvedValue({ data: null, error: null });
    const eqUser = vi.fn().mockReturnValue({ eq: eqEndpoint });
    const del = vi.fn().mockReturnValue({ eq: eqUser });
    const client = { from: vi.fn().mockReturnValue({ delete: del }) };
    await unsubscribeFromPush(client, "u1", "https://fcm.googleapis.com/sub-a");
    expect(client.from).toHaveBeenCalledWith("member_push_subscriptions");
    expect(eqUser).toHaveBeenCalledWith("user_id", "u1");
    expect(eqEndpoint).toHaveBeenCalledWith("endpoint", "https://fcm.googleapis.com/sub-a");
  });
});

describe("subscribeToNotificationInserts", () => {
  function harness() {
    const handlers = [];
    let statusCallback = null;
    const channel = {
      on: vi.fn((type, config, callback) => { handlers.push({ type, config, callback }); return channel; }),
      subscribe: vi.fn((cb) => { statusCallback = cb; return channel; }),
    };
    const client = { channel: vi.fn(() => channel), removeChannel: vi.fn() };
    return { channel, client, handlers, status: (s) => statusCallback?.(s) };
  }

  it("subscribes to self-filtered INSERTs and returns a cleanup that removes the channel", () => {
    const { client, channel, handlers } = harness();
    const onInsert = vi.fn();
    const cleanup = subscribeToNotificationInserts(client, "u1", onInsert);

    expect(client.channel).toHaveBeenCalledWith("member-notifications-u1");
    expect(handlers[0].type).toBe("postgres_changes");
    expect(handlers[0].config).toEqual({
      event: "INSERT", schema: "public", table: "member_notifications", filter: "user_id=eq.u1",
    });

    const row = { id: "n1", title: "T", kind: "cases", read_at: null };
    handlers[0].callback({ new: row });
    expect(onInsert).toHaveBeenCalledWith(row);

    cleanup();
    expect(client.removeChannel).toHaveBeenCalledWith(channel);
  });

  it("subscribes to participant-authorized task-message INSERTs and maps the payload", () => {
    const { client, handlers } = harness();
    const onTaskMessageInsert = vi.fn();
    subscribeToNotificationInserts(client, "u1", vi.fn(), vi.fn(), onTaskMessageInsert);

    expect(handlers[1].type).toBe("postgres_changes");
    expect(handlers[1].config).toEqual({
      event: "INSERT", schema: "public", table: "chapter_task_messages",
    });

    handlers[1].callback({
      new: {
        id: "tm1",
        task_id: "t1",
        chapter_id: "wor",
        sender_id: "u2",
        recipient_id: "u1",
        body: "Review is ready.",
        created_at: "2026-07-27T02:00:00Z",
      },
    });
    expect(onTaskMessageInsert).toHaveBeenCalledWith({
      id: "tm1",
      taskId: "t1",
      chapterId: "wor",
      senderId: "u2",
      recipientId: "u1",
      body: "Review is ready.",
      createdAt: "2026-07-27T02:00:00Z",
    });
  });

  // Rows inserted after the initial query but before the channel is live are in
  // neither source; the caller closes that window on SUBSCRIBED.
  it("signals only once the channel is actually live", () => {
    const { client, status } = harness();
    const onSubscribed = vi.fn();
    subscribeToNotificationInserts(client, "u1", vi.fn(), onSubscribed);

    status("SUBSCRIBING");
    status("CHANNEL_ERROR");
    expect(onSubscribed).not.toHaveBeenCalled();
    status("SUBSCRIBED");
    expect(onSubscribed).toHaveBeenCalledTimes(1);
  });

  it("tolerates a caller that supplies no subscribed handler", () => {
    const { client, status } = harness();
    subscribeToNotificationInserts(client, "u1", vi.fn());
    expect(() => status("SUBSCRIBED")).not.toThrow();
  });

  it("sets the current access token before subscribing after an assurance change", async () => {
    const { client } = harness();
    const setAuth = vi.fn().mockResolvedValue(undefined);
    client.realtime = { setAuth };
    subscribeToNotificationInserts(client, "u1", vi.fn(), undefined, "fresh-aal2-token");

    expect(setAuth).toHaveBeenCalledWith("fresh-aal2-token");
    expect(client.channel).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(client.channel).toHaveBeenCalledWith("member-notifications-u1"));
    expect(setAuth.mock.invocationCallOrder[0]).toBeLessThan(client.channel.mock.invocationCallOrder[0]);
  });
});

describe("urlBase64ToUint8Array", () => {
  it("decodes plain base64", () => {
    expect(Array.from(urlBase64ToUint8Array("AQID"))).toEqual([1, 2, 3]);
  });

  it("decodes base64url alphabet and repads", () => {
    // "-_8" is base64url for "+/8=" → 0xFB 0xFF
    expect(Array.from(urlBase64ToUint8Array("-_8"))).toEqual([0xfb, 0xff]);
  });
});
