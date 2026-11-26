// @vitest-environment node
// BUG-UG-ORG-CALENDAR-CREATE-RETRY-DUPLICATES-20261020
import { describe, expect, it } from "vitest";
import { runOrganizationCalendarPush } from "../api/_lib/organizationCalendar.js";

const config = { clientId: "local-client", clientSecret: "local-secret" };
const reply = (body, status = 200) => new Response(body == null ? null : JSON.stringify(body), { status });

// External boundaries only: execute the real push pass against a provider
// model with Google's supplied-ID uniqueness and a durable result mapping.
function fixture({ fault, recoveryFailure, organizationId = "organization-one", calendarId = "calendar-one", remote = new Map() } = {}) {
  const source = { title: "Chapter meeting", startsAt: "2026-11-01T18:00:00-05:00", summary: "First version", location: "Room" };
  let mapping = null;
  let cancelled = false;
  let failOnce = Boolean(fault);
  let generated = 0;
  let resultWrites = 0;
  let failRecoveryOnce = Boolean(recoveryFailure);
  const writes = [];
  const requests = [];
  const tombstones = new Map();
  const service = async (name, args) => {
    if (name === "list_organization_calendar_push_work") return [{ organizationId, operations: [{
      op: cancelled ? "delete" : "upsert", eventId: "source-event", calendarId,
      googleEventId: mapping, contentHash: source.summary, event: { ...source },
    }] }];
    if (name === "read_organization_calendar_refresh_token") return { refreshToken: "local-refresh" };
    if (name === "record_organization_calendar_push_result") {
      if (args.p_outcome === "upserted") {
        resultWrites += 1;
        if (failOnce && (fault === "result-write" || (fault === "replacement-result-write" && resultWrites === 2))) {
          failOnce = false;
          throw new Error("result write unavailable after remote create");
        }
      }
      writes.push(args);
      if (args.p_outcome === "upserted") mapping = args.p_google_event_id;
      if (args.p_outcome === "deleted") mapping = null;
    }
    return null;
  };
  const fetchImpl = async (url, init) => {
    if (String(url).includes("oauth2.googleapis.com")) return reply({ access_token: "local-access" });
    const path = new URL(url).pathname;
    const parts = path.split("/events");
    const calendar = parts[0];
    const id = decodeURIComponent(parts[1].slice(1));
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ method: init.method, path, id, body });
    if (failRecoveryOnce && init.method === recoveryFailure.method) {
      failRecoveryOnce = false;
      return reply({}, recoveryFailure.status);
    }
    const key = (eventId) => `${calendar}/${eventId}`;
    if (init.method === "POST") {
      const createdId = body.id || `generated-${++generated}`;
      if (remote.has(key(createdId)) || tombstones.has(key(createdId))) return reply({ error: { code: 409 } }, 409);
      remote.set(key(createdId), { ...body, id: createdId });
      if (failOnce && fault === "lost-response") { failOnce = false; throw new Error("response lost after commit"); }
      if (failOnce && fault === "ambiguous-503") { failOnce = false; return reply({}, 503); }
      return reply({ id: createdId });
    }
    if (init.method === "GET") return remote.has(key(id)) ? reply(remote.get(key(id)))
      : tombstones.has(key(id)) ? reply(tombstones.get(key(id))) : reply({}, 404);
    if (init.method === "PUT") {
      if (!remote.has(key(id)) && !tombstones.has(key(id))) return reply({}, 404);
      if (tombstones.has(key(id)) && body.status !== "confirmed") return reply({}, 410);
      tombstones.delete(key(id));
      remote.set(key(id), { ...body, id });
      return reply({ id });
    }
    if (init.method === "DELETE") {
      if (remote.has(key(id))) tombstones.set(key(id), { ...remote.get(key(id)), status: "cancelled" });
      remote.delete(key(id));
      return reply(null, 204);
    }
    throw new Error(`Unexpected method ${init.method}`);
  };
  return {
    remote, source, writes, requests,
    run: () => runOrganizationCalendarPush({ service, config, fetchImpl }),
    mapping: () => mapping,
    cancel: () => { cancelled = true; },
    restore: () => { cancelled = false; },
  };
}

describe("organization calendar create recovery", () => {
  it.each(["result-write", "lost-response", "ambiguous-503"])("recovers one remote event after %s and keeps updates/deletion on that event", async (fault) => {
    const f = fixture({ fault });
    expect(await f.run()).toMatchObject({ failed: 1, upserted: 0 });
    expect(f.remote.size).toBe(1);
    expect(f.mapping()).toBeNull();
    // A changed source between retries must reach the recovered event before
    // its new content hash is recorded, rather than being silently skipped.
    f.source.summary = "Changed before retry";
    expect(await f.run()).toMatchObject({ failed: 0, upserted: 1 });
    expect(f.remote.size).toBe(1);
    const remembered = f.mapping();
    expect([...f.remote.values()][0]).toMatchObject({ id: remembered, description: "Changed before retry\n\nShared from Union Ground." });
    expect(f.writes.find((w) => w.p_outcome === "upserted")).toMatchObject({ p_google_event_id: remembered, p_content_hash: "Changed before retry" });
    f.source.summary = "Later update";
    await f.run();
    expect(f.mapping()).toBe(remembered);
    expect([...f.remote.values()][0].description).toContain("Later update");
    f.cancel();
    expect(await f.run()).toMatchObject({ deleted: 1, failed: 0 });
    expect(f.remote.size).toBe(0);
    expect(f.requests.at(-1)).toMatchObject({ method: "DELETE", id: remembered });
  });

  it("concurrent unrecorded work converges on one remote identity", async () => {
    const f = fixture();
    const results = await Promise.all([f.run(), f.run()]);
    expect(results.every((r) => r.failed === 0 && r.upserted === 1)).toBe(true);
    expect(f.remote.size).toBe(1);
    expect(new Set(f.writes.filter((w) => w.p_outcome === "upserted").map((w) => w.p_google_event_id)).size).toBe(1);
  });

  it("separates identical source IDs in different organizations and calendars", async () => {
    const remote = new Map();
    const first = fixture({ remote });
    const otherOrg = fixture({ remote, organizationId: "organization-two" });
    const otherCalendar = fixture({ remote, calendarId: "calendar-two" });
    await first.run(); await otherOrg.run(); await otherCalendar.run();
    expect(remote.size).toBe(3);
    expect(new Set([first.mapping(), otherOrg.mapping(), otherCalendar.mapping()]).size).toBe(3);
    expect([...remote.values()].every((e) => /^[0-9a-v]{5,1024}$/.test(e.id))).toBe(true);
  });

  it("refuses to adopt or overwrite an unrelated ID conflict", async () => {
    const f = fixture({ fault: "result-write" });
    await f.run();
    const key = [...f.remote.keys()][0];
    const foreign = { ...f.remote.get(key), summary: "Unrelated event", extendedProperties: { private: { unionGroundEventId: "other-source" } } };
    f.remote.set(key, foreign);
    expect(await f.run()).toMatchObject({ failed: 1, upserted: 0 });
    expect(f.mapping()).toBeNull();
    expect(f.remote.size).toBe(1);
    expect(f.remote.get(key)).toEqual(foreign);
  });

  it.each(["wrong-owner", "unowned-cancelled"])("does not recover a %s conflict as an active copy", async (conflict) => {
    const f = fixture({ fault: "result-write" });
    await f.run();
    const key = [...f.remote.keys()][0];
    const existing = f.remote.get(key);
    const invalid = conflict === "unowned-cancelled" ? { id: existing.id, status: "cancelled" }
      : { ...existing, extendedProperties: { private: { unionGroundEventId: "source-event", unionGroundPushKey: "someone-else" } } };
    f.remote.set(key, invalid);
    expect(await f.run()).toMatchObject({ failed: 1, upserted: 0 });
    expect(f.remote.get(key)).toEqual(invalid);
    expect(f.mapping()).toBeNull();
  });

  it("recreates a vanished recorded copy and makes its replacement retry-safe", async () => {
    const f = fixture();
    await f.run();
    const oldId = f.mapping();
    f.remote.clear();
    expect(await f.run()).toMatchObject({ upserted: 1, failed: 0 });
    expect(f.remote.size).toBe(1);
    expect(f.mapping()).not.toBe(oldId);
    await f.run();
    expect(f.remote.size).toBe(1);
  });

  it("recovers a replacement whose result write failed while the old mapping remains", async () => {
    const f = fixture({ fault: "replacement-result-write" });
    await f.run();
    const oldId = f.mapping();
    f.remote.clear();
    expect(await f.run()).toMatchObject({ failed: 1, upserted: 0 });
    expect(f.mapping()).toBe(oldId);
    expect(f.remote.size).toBe(1);
    expect(await f.run()).toMatchObject({ failed: 0, upserted: 1 });
    expect(f.remote.size).toBe(1);
    expect(f.mapping()).not.toBe(oldId);
    expect([...f.remote.values()][0].id).toBe(f.mapping());
  });

  it("restores our own cancelled copy after the database delete cleared its mapping", async () => {
    const f = fixture();
    await f.run();
    const id = f.mapping();
    f.cancel();
    await f.run();
    expect(f.remote.size).toBe(0);
    expect(f.mapping()).toBeNull();
    f.restore();
    expect(await f.run()).toMatchObject({ failed: 0, upserted: 1 });
    expect(f.remote.size).toBe(1);
    expect(f.mapping()).toBe(id);
    expect([...f.remote.values()][0]).toMatchObject({ status: "confirmed" });
  });

  it.each([
    { method: "GET", status: 404, code: "calendar_not_found" },
    { method: "GET", status: 503, code: "calendar_unavailable" },
    { method: "PUT", status: 403, code: "calendar_forbidden" },
    { method: "PUT", status: 503, code: "calendar_unavailable" },
    { method: "PUT", status: 200, code: "calendar_unavailable" },
  ])("keeps recovery retryable after a $method response with status $status", async (recoveryFailure) => {
    const f = fixture({ fault: "result-write", recoveryFailure });
    await f.run();
    f.source.summary = "Changed before failed recovery";
    expect(await f.run()).toMatchObject({ failed: 1, upserted: 0 });
    expect(f.mapping()).toBeNull();
    expect(f.remote.size).toBe(1);
    expect([...f.remote.values()][0].description).toContain("First version");
    expect(f.writes.at(-1)).toMatchObject({ p_outcome: "failed", p_google_event_id: null, p_error_code: recoveryFailure.code });
    expect(await f.run()).toMatchObject({ failed: 0, upserted: 1 });
    expect(f.remote.size).toBe(1);
    expect([...f.remote.values()][0]).toMatchObject({ id: f.mapping(), description: "Changed before failed recovery\n\nShared from Union Ground." });
  });

  it("preserves a known provider mapping after an update is refused", async () => {
    const f = fixture({ recoveryFailure: { method: "PUT", status: 403 } });
    await f.run();
    const id = f.mapping();
    f.source.summary = "Changed before refused update";
    expect(await f.run()).toMatchObject({ failed: 1, upserted: 0 });
    expect(f.mapping()).toBe(id);
    expect(f.remote.size).toBe(1);
    expect(f.writes.at(-1)).toMatchObject({ p_outcome: "failed", p_error_code: "calendar_forbidden" });
    expect(await f.run()).toMatchObject({ failed: 0, upserted: 1 });
    expect([...f.remote.values()][0]).toMatchObject({ id, description: "Changed before refused update\n\nShared from Union Ground." });
  });
});
