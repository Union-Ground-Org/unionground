// @vitest-environment node
// BUG-UG-WEB-SAVED-REMINDER-FILTERS-STALE-20261003: Save message and
// Remind me reported success and flipped their buttons, but the Saved and
// Reminders filters kept their boot-time rows until a full reload, because
// nothing re-read the member's saved and reminder rows after the action.
import { afterEach, expect, it } from "vitest";
import { createMemberSessionLoader } from "../src/lib/memberSessionLoader.js";
import { MESSAGE_ACTIVITY_RESOURCES, refreshMessageActivityAfter } from "../src/features/messaging/messageActivityRefresh.js";

let loader = null;
afterEach(() => { loader?.dispose(); loader = null; });

function harness() {
  const activity = { saved: [], reminders: [] };
  const rpcCalls = [];
  const client = {
    from() {
      let query;
      query = new Proxy({}, { get(_target, key) {
        if (key === "then") return (resolve, reject) => Promise.resolve({ data: [], error: null }).then(resolve, reject);
        return () => query;
      } });
      return query;
    },
    rpc: async (name) => {
      rpcCalls.push(name);
      return { data: name === "list_member_message_activity" ? structuredClone(activity) : null, error: null };
    },
  };
  loader = createMemberSessionLoader(client, { id: "member" });
  return { activity, rpcCalls };
}

const savedRow = { id: "saved-1", sourceKind: "private", messageId: "message-1", available: true, targetId: "conversation-1", savedAt: "2026-10-05T12:00:00Z" };
const reminderRow = { id: "reminder-1", sourceKind: "private", messageId: "message-1", available: true, targetId: "conversation-1", remindAt: "2026-10-06T12:00:00Z" };

it("re-reads the saved and reminder rows after save, so the filters change without a reload", async () => {
  const { activity } = harness();
  let projection = await loader.loadRoute("messages");
  expect(projection.savedMessages).toEqual([]);
  expect(projection.messageReminders).toEqual([]);

  // The server now holds the saved message and the reminder.
  activity.saved = [savedRow];
  activity.reminders = [reminderRow];
  // Without a refresh the loader keeps answering from its boot-time read.
  projection = await loader.loadRoute("messages");
  expect(projection.savedMessages).toEqual([]);

  expect(refreshMessageActivityAfter(loader, "save")).toBe(true);
  projection = await loader.loadRoute("messages");
  expect(projection.savedMessages.map((item) => item.messageId)).toEqual(["message-1"]);
  expect(projection.messageReminders.map((item) => item.messageId)).toEqual(["message-1"]);

  // Unsave and removing the reminder drop them again.
  activity.saved = [];
  activity.reminders = [];
  refreshMessageActivityAfter(loader, "unsave");
  refreshMessageActivityAfter(loader, "unremind");
  projection = await loader.loadRoute("messages");
  expect(projection.savedMessages).toEqual([]);
  expect(projection.messageReminders).toEqual([]);
});

it("refreshes only for the four actions that change saved and reminder rows", () => {
  const invalidated = [];
  const fake = { invalidateResources: (names) => invalidated.push([...names]) };
  for (const action of ["save", "unsave", "remind", "unremind"]) expect(refreshMessageActivityAfter(fake, action)).toBe(true);
  for (const action of ["react", "edit", "reply", "state"]) expect(refreshMessageActivityAfter(fake, action)).toBe(false);
  expect(invalidated).toEqual(Array(4).fill([...MESSAGE_ACTIVITY_RESOURCES]));
  expect(refreshMessageActivityAfter(null, "save")).toBe(true);
});

it("the App's message action wiring calls the refresh with its loader (source check)", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  const wiring = source.slice(source.indexOf("messageAction: (sourceKind, messageId, action, value) => memberOperation.run("));
  expect(wiring.slice(0, 2000)).toMatch(/refreshMessageActivityAfter\(loader, action\);/);
});

it("the direct save, remind and reminder-cancel methods refresh too (source check)", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
  const api = source.slice(source.indexOf("const sessionMessagingApi = {"));
  const head = api.slice(0, api.indexOf("loadTaskLanding:"));
  for (const [method, action] of [["toggleSaved", "save"], ["remind", "remind"], ["cancelReminder", "unremind"]]) {
    const start = head.indexOf(`    ${method}: (`);
    expect(start, method).toBeGreaterThan(-1);
    expect(head.slice(start, start + 400)).toContain(`refreshMessageActivityAfter(memberLoaderRef.current, "${action}");`);
  }
});

