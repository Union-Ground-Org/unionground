// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, migrationFiles, stripComments } from "./helpers/migration.js";
import { helperFirst } from "../scripts/account-case-graph-inventory.mjs";

const migrations = migrationFiles();

function latestFunction(signature) {
  const name = signature.slice(0, signature.indexOf("("));
  const migration = [...migrations].reverse().find(({ sql }) => (
    stripComments(sql).toLowerCase().match(new RegExp(`function ${name.toLowerCase().replaceAll(".", "\\.")}\\s*\\(`))
  ));
  expect(migration, `missing migration for ${signature}`).toBeTruthy();
  return stripComments(fnBody(migration.sql, name));
}

function latestPolicy(name) {
  const migration = [...migrations].reverse().find(({ sql }) => (
    stripComments(sql).toLowerCase().includes(`create policy ${name.toLowerCase()}`)
  ));
  expect(migration, `missing migration for policy ${name}`).toBeTruthy();
  const sql = stripComments(migration.sql);
  const start = sql.toLowerCase().lastIndexOf(`create policy ${name.toLowerCase()}`);
  return sql.slice(start, sql.indexOf(";", start) + 1);
}

describe("member events never widen across organizations", () => {
  it("checks tenant equality before chapter, agency, or cross-agency visibility", () => {
    // Break caught: either public flag may widen chapter visibility, but never
    // the owning organization. The member table policy is the read boundary,
    // and caller context must be init-plan shaped rather than a correlated
    // SECURITY DEFINER call for every historical event row.
    const policy = latestPolicy("member_events_select_scoped");
    expect(policy).not.toContain("private.member_can_access_event_scope(");
    expect(policy).toContain("event_chapter.organization_id = (select private.current_member_organization())");
    expect(policy).toContain("event_chapter.id = (select private.current_member_chapter())");
    expect(policy.indexOf("event_chapter.organization_id = (select private.current_member_organization())"))
      .toBeLessThan(policy.indexOf("or coalesce(member_events.is_public_across_agencies"));

    const scope = latestFunction("private.member_can_access_event_scope_for_user(p_user_id uuid, p_chapter_id text, p_is_public boolean, p_is_public_across_agencies boolean)");
    expect(scope).toContain("event_chapter.organization_id = member_chapter.organization_id");
    expect(scope).toContain("member_chapter.organization_id is not null");
    expect(scope.indexOf("event_chapter.organization_id = member_chapter.organization_id"))
      .toBeLessThan(scope.indexOf("or coalesce(p_is_public_across_agencies"));

    const callerScope = latestFunction("private.member_can_access_event_scope(p_chapter_id text, p_is_public boolean, p_is_public_across_agencies boolean)");
    expect(callerScope).toMatch(/private\.member_can_access_event_scope_for_user\(\s*\(select auth\.uid\(\)\)/);
  });

  it.each(["public.create_member_event(", "public.create_member_event_model("])("%s notifications never leave the owning organization", (signature) => {
    const create = latestFunction(signature);
    const recipientQuery = create.slice(create.indexOf("select recipient.id"));
    const tenantBound = recipientQuery.indexOf(
      "recipient_chapter.organization_id = publisher_chapter.organization_id",
    );
    const acrossAgencies = recipientQuery.indexOf("p_is_public_across_agencies");
    const region = recipientQuery.indexOf("recipient_chapter.region = publisher_chapter.region");
    expect(tenantBound).toBeGreaterThan(-1);
    expect(acrossAgencies).toBeGreaterThan(-1);
    expect(tenantBound).toBeLessThan(acrossAgencies);
    expect(region).toBeGreaterThan(acrossAgencies);
    expect(create).toContain("recipient.chapter_id = caller_chapter");
    expect(create).toContain("join public.organization_memberships recipient_membership");
    expect(create).toContain("recipient_membership.user_id = recipient.id");
    expect(create).toContain("recipient_membership.organization_id = publisher_chapter.organization_id");
    expect(create).toContain("recipient_membership.status = 'active'");
    expect(create).toContain("when others then");
    expect(create).toContain("raise warning 'event.created notify failed");
    expect(create.replace(/\s+/g, " ")).toContain(
      "and recipient_chapter.organization_id = publisher_chapter.organization_id and (",
    );
  });

  it('keeps model updates within the staff chapter and tenant-scoped attendance recipients', () => {
    const update = latestFunction('public.update_member_event_model(');
    expect(update).toContain('caller_chapter := private.current_member_chapter()');
    expect(update.match(/where id = p_id and chapter_id = caller_chapter/g)).toHaveLength(3);
    expect(update).toContain('private.member_can_manage_events()');
    const scope = latestFunction('private.member_can_access_event_scope_for_user(');
    expect(scope).toContain('event_chapter.organization_id = member_chapter.organization_id');
    const notify = latestFunction('private.notify_member_event(');
    expect(notify).toContain('private.member_can_access_event_scope_for_user');
    expect(update).toContain("private.notify_member_event(m.user_id, p_id, 'rescheduled')");
  });

  it("keeps the installed case-graph lock as the first statement of the re-emitted event writer", () => {
    const create = latestFunction("public.create_member_event(");
    // Re-emitters use either $$ or pg_get_functiondef's $function$ quoting.
    const tag = create.match(/\bas\s+(\$[a-z_]*\$)/i)[1];
    expect(helperFirst(create.slice(create.indexOf(tag) + tag.length, create.lastIndexOf(tag)))).toBe(true);
  });

  it("keeps every event-created recipient inside the owning organization for each visibility class", () => {
    const create = latestFunction("public.create_member_event(");
    const recipientQuery = create.slice(create.indexOf("select recipient.id"));
    expect(recipientQuery).toContain("recipient_chapter.organization_id = publisher_chapter.organization_id");
    expect(recipientQuery).toContain("join public.organization_memberships recipient_membership");
    expect(recipientQuery).toContain("recipient_membership.status = 'active'");
    expect(recipientQuery).toContain("recipient.chapter_id = caller_chapter");
    expect(recipientQuery).toContain("p_is_public_across_agencies");
    expect(recipientQuery).toContain("p_is_public and publisher_chapter.region is not null");
    expect(recipientQuery).toContain("recipient_chapter.region = publisher_chapter.region");

    const publisher = { id: "admin-a", chapterId: "a1", organizationId: "org-a", region: "west", membership: "active" };
    const members = [
      publisher,
      { id: "member-a1", chapterId: "a1", organizationId: "org-a", region: "west", membership: "active" },
      { id: "member-a2", chapterId: "a2", organizationId: "org-a", region: "west", membership: "active" },
      { id: "member-a3", chapterId: "a3", organizationId: "org-a", region: "east", membership: "active" },
      { id: "member-revoked", chapterId: "a1", organizationId: "org-a", region: "west", membership: "revoked" },
      { id: "member-b1", chapterId: "b1", organizationId: "org-b", region: "west", membership: "active" },
    ];

    const recipients = ({ isPublic, isPublicAcrossAgencies }) => members
      .filter((recipient) => (
        recipient.id !== publisher.id
        && recipient.membership === "active"
        && recipient.organizationId === publisher.organizationId
        && (
          recipient.chapterId === publisher.chapterId
          || isPublicAcrossAgencies
          || (isPublic && publisher.region != null && recipient.region === publisher.region)
        )
      ))
      .map((recipient) => recipient.id);

    expect(recipients({ isPublic: false, isPublicAcrossAgencies: false })).toEqual(["member-a1"]);
    expect(recipients({ isPublic: true, isPublicAcrossAgencies: false })).toEqual(["member-a1", "member-a2"]);
    expect(recipients({ isPublic: false, isPublicAcrossAgencies: true })).toEqual([
      "member-a1",
      "member-a2",
      "member-a3",
    ]);
    for (const visibility of [
      { isPublic: false, isPublicAcrossAgencies: false },
      { isPublic: true, isPublicAcrossAgencies: false },
      { isPublic: false, isPublicAcrossAgencies: true },
    ]) {
      expect(recipients(visibility)).not.toContain("member-b1");
      expect(recipients(visibility)).not.toContain("member-revoked");
      expect(new Set(recipients(visibility).map((id) => members.find((member) => member.id === id).organizationId)))
        .toEqual(new Set(["org-a"]));
    }
  });

  it("reuses the same tenant-first predicate for RSVP, check-in, and token minting", () => {
    for (const signature of [
      "public.rsvp_to_event(p_event_id text, p_status text)",
      "public.check_in_to_event(p_event_id text, p_code text)",
      "public.request_event_checkin_token(p_event_id text)",
    ]) {
      expect(latestFunction(signature)).toMatch(
        /private\.member_can_access_event_scope\(\s*e\.chapter_id,\s*e\.is_public,\s*e\.is_public_across_agencies\s*\)/,
      );
    }
  });

  it("keeps token-owner calendar reads tenant-bound without relying on caller JWT state", () => {
    const feed = latestFunction("public.get_calendar_feed_events(p_token text)");
    expect(feed).toMatch(
      /private\.member_can_access_event_scope_for_user\(\s*target,\s*e\.chapter_id,\s*e\.is_public,\s*e\.is_public_across_agencies\s*\)/,
    );
  });
});
