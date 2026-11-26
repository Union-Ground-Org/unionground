// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { markNotificationsRead } from "../src/lib/memberApi.js";
import { createMemberSessionLoader } from "../src/lib/memberSessionLoader.js";

// BUG-UG-READ-SECURITY-NOTICE-COMES-BACK-UNREAD-20261006:
// read_at is browser time; created_at is database time. A delayed INSERT
// must not undo a committed read when the browser clock is behind.
afterEach(() => vi.useRealTimers());

it.each(["before", "after"])("keeps a security notice read when its INSERT arrives %s the read snapshot", async (arrival) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-06T22:55:00-04:00"));
  const inserted = {
    id: "mfa", user_id: "member", title: "Two-step sign-in was turned on",
    created_at: "2026-10-06T23:00:00-04:00", read_at: null,
  };
  const rows = [inserted, { ...inserted, id: "foreign", user_id: "another-member" }];
  let held = false;
  let resolveRead;
  let readStarted;
  const started = new Promise(resolve => { readStarted = resolve; });
  const client = {
    from(table) {
      let patch;
      const filters = [];
      let query;
      query = new Proxy({}, { get(_target, key) {
        if (key === "then") return (resolve, reject) => {
          const ownRows = rows.filter(row => filters.every(([column, value]) => row[column] === value));
          if (patch) {
            for (const row of ownRows) Object.assign(row, patch);
            return Promise.resolve({ data: null, error: null }).then(resolve, reject);
          }
          const data = table === "member_profiles" ? { id: "member", first_name: "Member" }
            : table === "member_notifications" ? structuredClone(ownRows) : [];
          const result = { data, error: null };
          if (table === "member_notifications" && held) {
            readStarted();
            return new Promise(done => { resolveRead = () => done(result); }).then(resolve, reject);
          }
          return Promise.resolve(result).then(resolve, reject);
        };
        return (...args) => {
          if (key === "update") patch = args[0];
          if (key === "eq" || key === "is") filters.push(args);
          return query;
        };
      } });
      return query;
    },
    rpc: async () => ({ data: null, error: null }),
  };
  const loader = createMemberSessionLoader(client, { id: "member" });
  try {
    // The before case covers an INSERT buffered before the first snapshot.
    if (arrival === "after") expect((await loader.loadShell()).member.notificationCount).toBe(1);
    await markNotificationsRead(client, "member");
    const readAt = rows[0].read_at;
    expect(Date.parse(readAt)).toBeLessThan(Date.parse(inserted.created_at));
    expect(rows[1].read_at).toBeNull();
    // A retry touches only unread rows; the original read timestamp survives.
    vi.setSystemTime(new Date(Date.parse(readAt) + 60_000));
    await markNotificationsRead(client, "member");
    expect(rows[0].read_at).toBe(readAt);
    held = true;
    const refresh = loader.reconcileRealtime();
    await started;
    const delayedInsert = { ...inserted, read_at: null };
    if (arrival === "before") expect(loader.noteLive("table:member_notifications", delayedInsert)).toBe(true);
    held = false;
    resolveRead();
    expect((await refresh).notifications).toEqual([expect.objectContaining({ id: "mfa", read_at: readAt })]);
    expect(loader.noteLive("table:member_notifications", delayedInsert)).toBe(false);
    const reloaded = await loader.loadShell();
    expect(reloaded.notifications).toHaveLength(1);
    expect(reloaded.notifications[0].read_at).toBe(readAt);
    expect(reloaded.member.notificationCount).toBe(0);
  } finally {
    loader.dispose();
  }
});
