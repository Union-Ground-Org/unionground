// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { fnBody, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";
import { ENGAGEMENT_EMAIL_PREFERENCE_KEYS, NOTIFICATION_TOPIC_KEYS, updateMemberSettings } from "../src/lib/memberApi.js";

// Text pins are a tripwire, not a proof: they assert what THIS MIGRATION SAYS,
// not what the database ENDS UP WITH. A later create-or-replace can supersede
// every guard below and this file stays green. Current-state truth lives in
// scripts/db-contract.json, checked by `npm run verify:db`.

const sql = loadMigrationSql("member_settings_language_and_notification_prefs");

// The kind gate has to come from the last CREATE OR REPLACE of
// private.enqueue_notification_deliveries(), not from a literal copied out of
// it. fnBody cuts on a contiguous `$function$;` / `$$;` and on the first
// `function <name>(` it sees. The current definition puts that semicolon on
// the next line and is preceded by `alter function`, so a raw fnBody call
// throws and the pin would stay on the previous migration. Normalize this
// one declaration, then cut it with fnBody. A file that declares the function
// but cannot be cut stays the latest candidate and fails the test.
function latestEnqueueNotificationDeliveries() {
  let found = null;
  for (const entry of migrationFiles()) {
    if (!/enqueue_notification_deliveries/i.test(entry.sql)) continue;
    const source = stripComments(entry.sql);
    const starts = [...source.matchAll(/create\s+(?:or\s+replace\s+)?function\s+private\.enqueue_notification_deliveries\s*\(/gi)];
    if (starts.length === 0) continue;
    const tail = source.slice(starts[starts.length - 1].index);
    const open = /as\s+\$([A-Za-z0-9_]*)\$/i.exec(tail);
    if (!open) {
      found = { name: entry.name, body: null, reason: "declaration has no dollar-quoted body" };
      continue;
    }
    const rest = tail.slice(open.index + open[0].length);
    const close = new RegExp(`\\$${open[1]}\\$\\s*;`).exec(rest);
    if (!close) {
      found = { name: entry.name, body: null, reason: "declaration does not terminate" };
      continue;
    }
    const normalized = `${tail.slice(0, open.index + open[0].length)}${rest.slice(0, close.index)}$${open[1]}$;`;
    try {
      found = { name: entry.name, body: fnBody(normalized, "private.enqueue_notification_deliveries"), reason: null };
    } catch (error) {
      found = { name: entry.name, body: null, reason: error.message };
    }
  }
  return found;
}

describe("member settings migration invariants", () => {
  it("adds language with an en/es CHECK", () => {
    expect(sql).toContain("add column language text not null default 'en' check (language in ('en', 'es'))");
  });

  it("bounds notification_prefs to a small object via a shape/size CHECK", () => {
    expect(sql).toContain("notification_prefs jsonb not null");
    expect(sql).toContain("pg_catalog.jsonb_typeof(notification_prefs) = 'object'");
    expect(sql).toContain("pg_catalog.length(notification_prefs::text) < 512");
  });
});

describe("updateMemberSettings client", () => {
  // #7026 round 2: the account the form was opened for travels with the save,
  // so a session switched under an open form is refused server-side.
  it("names the account the form was opened for", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }));
    await updateMemberSettings({ rpc }, "account-a", { language: "es" });
    expect(rpc).toHaveBeenCalledWith("update_my_member_profile", { p_expected_user_id: "account-a", p_fields: { language: "es" } });
  });

  it("writes complete navigation arrays without accepting injected preference fields", async () => {
    const update = vi.fn();
    const client = { rpc: vi.fn(async (name, args) => { expect(name).toBe("update_my_member_profile"); expect(args.p_expected_user_id).toBe("u1"); update(args.p_fields); return { data: null, error: null }; }) };
    await updateMemberSettings(client, "u1", {
      shortcutKeys: ["cases", "messages"],
      workWidgetOrder: ["cases", "messages", "appointments"],
      navigationPreferences: { injected: "<x>" },
    });
    expect(update).toHaveBeenCalledWith({
      shortcut_keys: ["cases", "messages"],
      work_widget_order: ["cases", "messages", "appointments"],
    });
  });

  it("does not clear either navigation array when that field is omitted or malformed", async () => {
    const update = vi.fn();
    const client = { rpc: vi.fn(async (name, args) => { expect(name).toBe("update_my_member_profile"); expect(args.p_expected_user_id).toBe("u1"); update(args.p_fields); return { data: null, error: null }; }) };
    await updateMemberSettings(client, "u1", { language: "es", shortcutKeys: "cases", workWidgetOrder: null });
    expect(update).toHaveBeenCalledWith({ language: "es" });
  });

  it("writes only the language when a valid language is given", async () => {
    const update = vi.fn();
    const client = { rpc: vi.fn(async (name, args) => { expect(name).toBe("update_my_member_profile"); expect(args.p_expected_user_id).toBe("u1"); update(args.p_fields); return { data: null, error: null }; }) };
    await updateMemberSettings(client, "u1", { language: "es" });
    expect(update).toHaveBeenCalledWith({ language: "es" });
  });

  it("ignores an invalid language and coerces prefs to only the known boolean topics", async () => {
    const update = vi.fn();
    const client = { rpc: vi.fn(async (name, args) => { expect(name).toBe("update_my_member_profile"); expect(args.p_expected_user_id).toBe("u1"); update(args.p_fields); return { data: null, error: null }; }) };
    await updateMemberSettings(client, "u1", { language: "fr", notificationPrefs: { deadlines: false, cases: true, forms: true, votes: true, events: false, injected: "<x>" } });
    // 'tasks' was not sent, and an ABSENT key writes true: absent-means-enabled
    // is the trigger's rule, and coercing absent to false would have silently
    // switched a topic off for a member who never touched it.
    expect(update).toHaveBeenCalledWith({
      notification_prefs: { deadlines: false, cases: true, forms: true, votes: true, events: false, tasks: true, appointments: true, workload: true, messages: true },
    });
    const arg = update.mock.calls[0][0];
    expect(arg).not.toHaveProperty("language");
    expect(arg.notification_prefs).not.toHaveProperty("injected");
    // Dues are left out of Union Ground, so there is no dues topic to write.
    expect(arg.notification_prefs).not.toHaveProperty("dues");
  });

  // SEC-UG-ENGAGEMENT-EMAIL-OPT-OUT-UNSUBSCRIBE-20261001: a union email
  // choice is written only when the caller sends it. An omitted one is left to
  // the database, which keeps the stored value, so an unsubscribe survives
  // every topic save.
  it("writes a union email choice only when the caller sends it", async () => {
    expect(ENGAGEMENT_EMAIL_PREFERENCE_KEYS).toEqual(["announcements", "surveys", "welcome"]);
    const update = vi.fn();
    const client = { rpc: vi.fn(async (name, args) => { expect(name).toBe("update_my_member_profile"); expect(args.p_expected_user_id).toBe("u1"); update(args.p_fields); return { data: null, error: null }; }) };
    const allOn = Object.fromEntries(NOTIFICATION_TOPIC_KEYS.map((k) => [k, true]));
    await updateMemberSettings(client, "u1", { notificationPrefs: { ...allOn, announcements: false } });
    expect(update.mock.calls[0][0].notification_prefs).toEqual({ ...allOn, announcements: false });
    await updateMemberSettings(client, "u1", { notificationPrefs: allOn });
    expect(update.mock.calls[1][0].notification_prefs).toEqual(allOn);
    await updateMemberSettings(client, "u1", { notificationPrefs: { ...allOn, welcome: false } });
    expect(update.mock.calls[2][0].notification_prefs).toEqual({ ...allOn, welcome: false });
    expect(ENGAGEMENT_EMAIL_PREFERENCE_KEYS.some((key) => NOTIFICATION_TOPIC_KEYS.includes(key))).toBe(false);
  });

  // A topic the writer cannot persist is worse than a topic that does not
  // exist: the switch renders, the member turns it off, the key is dropped,
  // the trigger reads absent-as-enabled, and the mail keeps coming while the
  // UI springs back to on. Every topic offered MUST survive a write.
  it.each(NOTIFICATION_TOPIC_KEYS)("persists the %s topic when switched off", async (key) => {
    const update = vi.fn();
    const client = { rpc: vi.fn(async (name, args) => { expect(name).toBe("update_my_member_profile"); expect(args.p_expected_user_id).toBe("u1"); update(args.p_fields); return { data: null, error: null }; }) };
    const allOn = Object.fromEntries(NOTIFICATION_TOPIC_KEYS.map((k) => [k, true]));
    await updateMemberSettings(client, "u1", { notificationPrefs: { ...allOn, [key]: false } });
    const written = update.mock.calls[0][0].notification_prefs;
    expect(Object.keys(written).sort()).toEqual([...NOTIFICATION_TOPIC_KEYS].sort());
    expect(written[key]).toBe(false);
  });

  it("covers every kind the enqueue trigger can produce an outbound delivery for", () => {
    // The trigger enqueues for exactly these kinds; 'general' never enqueues,
    // so it is deliberately not a member-facing toggle. 'tasks' is the sixth
    // topic (20260727 tasks_notification_topic migration in this same PR
    // widens the kind CHECK and the trigger's list to match); 'appointments'
    // is the eighth kind (20260801120000 steward appointments), same shape.
    const definition = latestEnqueueNotificationDeliveries();
    expect(definition, "no migration declares private.enqueue_notification_deliveries()").not.toBeNull();
    expect(definition.body, `${definition.name}: ${definition.reason}`).toBeTruthy();
    // The first `new.kind not in (...)` is the early-return gate. A later
    // predicate repeats a subset for the weekly rate limit; if the gate is
    // renamed or removed, this match is missing or is that subset, and the
    // comparison below fails instead of passing against an empty extract.
    const gate = definition.body.match(/new\.kind\s+not\s+in\s*\(([^)]*)\)/i);
    expect(gate, `${definition.name}: enqueue gate \`new.kind not in (...)\` was not found`).not.toBeNull();
    const enqueueableKinds = [...gate[1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
    expect(enqueueableKinds, `${definition.name}: extracted enqueue kind list is empty`).not.toEqual([]);
    // Dues are left out of Union Ground: the shared schema may still name
    // the kind (inert, nothing in the web app produces it), but no member
    // toggle is offered for it. Every other enqueueable kind is a topic.
    const LEFT_OUT_KINDS = ["dues"];
    expect(NOTIFICATION_TOPIC_KEYS).not.toContain("dues");
    expect([...NOTIFICATION_TOPIC_KEYS].sort(), definition.name)
      .toEqual(enqueueableKinds.filter((kind) => !LEFT_OUT_KINDS.includes(kind)).sort());
  });
});
