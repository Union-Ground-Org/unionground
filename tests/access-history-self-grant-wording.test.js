import { describe, expect, it } from "vitest";
import { normalizeAccessEvent } from "../src/features/accessHistory/event.js";
import { presentAccessHistory } from "../src/features/accessHistory/presenters.js";

// BUG-UG-HOME-AND-TOP-BAR-CALL-OFFICERS-MEMBER-20261006: a role change
// the caller made themselves reads as their own action, not "Renata gave you".
const base = { organizationId: "org", subjectUserId: "me", actorRole: "staff", actorLabel: "Renata", entityType: "role_grant", occurredAt: "2026-10-06T23:00:00Z" };

describe("self role-change wording in access history", () => {
  it("keeps the self flag only when the feed says exactly true", () => {
    expect(normalizeAccessEvent({ ...base, id: "a", action: "granted_role", actorIsSelf: true }).actorIsSelf).toBe(true);
    for (const value of [false, "true", 1, undefined, null]) {
      expect(normalizeAccessEvent({ ...base, id: "b", action: "granted_role", actorIsSelf: value }).actorIsSelf).toBe(false);
    }
  });

  it.each([
    ["en", "You gave yourself a staff role", "You removed a staff role from your own account", "Renata gave you a staff role"],
    ["es", "Te diste un rol de personal", "Te retiraste un rol de personal de tu cuenta", "Renata te dio un rol de personal"],
  ])("words self grants and revocations as the reader's own action in %s", (lang, granted, revoked, staff) => {
    const labels = presentAccessHistory({
      ok: true,
      events: [
        { ...base, id: "g", action: "granted_role", actorIsSelf: true },
        { ...base, id: "r", action: "revoked_role", actorIsSelf: true },
        { ...base, id: "s", action: "granted_role", actorIsSelf: false },
      ],
    }, lang).events.map((event) => event.label);
    expect(labels).toEqual([granted, revoked, staff]);
  });

  it("does not reword a non-role event even when flagged", () => {
    const [event] = presentAccessHistory({ ok: true, events: [{ ...base, id: "v", action: "viewed_profile", actorIsSelf: true }] }).events;
    expect(event.label).toBe("Renata viewed your profile");
  });
});
