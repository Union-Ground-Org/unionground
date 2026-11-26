import { describe, expect, it, vi } from "vitest";
import { createSessionBoundWriter, WriterSessionChanged } from "../src/lib/sessionBoundWriter.js";

const session = { user: { id: "member-a" }, access_token: "synthetic-a" };
const binding = (options = {}) => createSessionBoundWriter({
  session,
  sharedClient: { auth: { getSession: async () => ({ data: { session } }) } },
  createSessionClient: (checked) => ({ checked }),
  ...options,
});

describe("sessionBoundWriter failure boundary (#9254)", () => {
  it.each([
    [null, "unavailable"],
    [{ auth: { getSession: async () => { throw new Error("offline"); } } }, "unavailable"],
    [{ auth: { getSession: async () => ({ data: { session }, error: new Error("offline") }) } }, "unavailable"],
    [{ auth: { getSession: async () => ({}) } }, "unavailable"],
    [{ auth: { getSession: async () => ({ data: {} }) } }, "unavailable"],
    [{ auth: { getSession: async () => ({ data: { session: {} } }) } }, "unavailable"],
    [{ auth: { getSession: async () => ({ data: { session: null } }) } }, "changed"],
    [{ auth: { getSession: async () => ({ data: { session: { user: { id: "member-b" }, access_token: "synthetic-b" } } }) } }, "changed"],
  ])("distinguishes unavailable proof from confirmed replacement without exposing Auth data", async (sharedClient, state) => {
    expect(await binding({ sharedClient }).check()).toBe(state);
  });
  it.each([null, {}, { user: { id: "member-a" } }, { access_token: "synthetic-a" }])("refuses an invalid initiating session %j", async (invalid) => {
    const writer = binding({ session: invalid });
    expect(writer.userId).toBeNull();
    await expect(writer.client()).rejects.toBeInstanceOf(WriterSessionChanged);
    expect(await writer.isCurrent()).toBe(false);
  });
  it.each([null, {}, { auth: {} }, { auth: { getSession: async () => { throw new Error("private transport detail"); } } },
    { auth: { getSession: async () => ({ data: { session }, error: new Error("auth unavailable") }) } },
    { auth: { getSession: async () => ({ data: { session: { ...session, access_token: "" } } }) } },
    { auth: { getSession: async () => ({ data: { session: null } }) } },
  ])("refuses an unprovable current account without leaking a transport error", async (sharedClient) => {
    const writer = binding({ sharedClient });
    await expect(writer.client()).rejects.toMatchObject({ message: "The account changed before this was sent.", details: "writer_session_changed" });
  });
  it.each([null, () => null, () => { throw new Error("private factory detail"); }])("never falls back when the captured client is unavailable", async (createSessionClient) => {
    await expect(binding({ createSessionClient }).client()).rejects.toBeInstanceOf(WriterSessionChanged);
  });
  it("captures identity before awaiting, and snapshots the exact checked session", async () => {
    const initiating = { ...session, user: { ...session.user } };
    const current = { ...session, access_token: "renewed-a", user: { ...session.user } };
    const factory = vi.fn((checked) => ({ checked }));
    const writer = binding({ session: initiating, sharedClient: { auth: { getSession: async () => ({ data: { session: current } }) } }, createSessionClient: factory });
    initiating.user.id = "replacement-b";
    const client = await writer.client();
    expect(client.checked).toEqual(current);
    expect(client.checked).not.toBe(current);
    expect(client.checked.user).not.toBe(current.user);
    current.access_token = "replacement-token";
    expect(client.checked.access_token).toBe("renewed-a");
    expect(await writer.acknowledged("accepted")).toEqual({ acknowledged: true, value: "accepted", continuationCurrent: true });
  });
});
