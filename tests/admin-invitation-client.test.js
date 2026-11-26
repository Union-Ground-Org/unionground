// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdminInvitationError, invitationErrorKey, inviteMember, memberSentInvitationsEnabled, resendMemberInvitation, revokeMemberInvitation,
} from "../src/lib/adminInvitationApi.js";

const session = { access_token: "member-access-token" };
const invitationId = "10000000-0000-4000-8000-000000000001";

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("admin invitation client", () => {
  // REQ-UG-BLOCK-GOVERNMENT-AND-EMPLOYER-EMAIL-DOMAINS-20261102.
  it("keeps the email-domain-blocked refusal and names it in the error copy", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ error: "email-domain-blocked" }, 400)));
    const failure = await inviteMember(session, { email: "member@agency.gov", fullName: "Member Name", chapterId: "wor", initialRole: null, locale: "en" })
      .catch((error) => error);
    expect(failure).toBeInstanceOf(AdminInvitationError);
    expect(failure.code).toBe("email-domain-blocked");
    expect(invitationErrorKey(failure)).toBe("admin.emailDomainBlocked");
  });

  // REQ-UG-MEMBER-SENT-INVITATIONS-20261111 (#8171).
  it("sends a member's own invitation with no chapter, role or other field, and keeps the limit's time", async () => {
    const fetchMock = vi.fn(async () => response({ accepted: true }, 202));
    vi.stubGlobal("fetch", fetchMock);
    await expect(inviteMember(session, { memberSent: true, email: "dana@example.com", fullName: "Dana Wu", locale: "es", chapterId: "other", initialRole: "admin", requestId: "r1" }))
      .resolves.toEqual({ accepted: true });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ action: "member-send", email: "dana@example.com", fullName: "Dana Wu", locale: "es" });
    await inviteMember(session, { memberSent: true, email: "dana@example.com", fullName: "Dana Wu", locale: "fr" });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).locale).toBe("en");
    vi.stubGlobal("fetch", vi.fn(async () => response({ error: "rate-limited", limit: "limits.security.invitation_member_daily", retryAt: "2026-11-12T15:00:00.000Z" }, 429)));
    const limited = await inviteMember(session, { memberSent: true, email: "dana@example.com", fullName: "Dana Wu", locale: "en" }).catch((error) => error);
    expect(limited).toMatchObject({ code: "rate-limited", limit: "limits.security.invitation_member_daily", retryAt: "2026-11-12T15:00:00.000Z" });
  });

  it("reads the organization's member-invitations switch only when it is exactly on", () => {
    expect(memberSentInvitationsEnabled({ organizationConfiguration: { switches: { "features.member_invitations.enabled": true } } })).toBe(true);
    for (const data of [null, {}, { organizationConfiguration: null }, { organizationConfiguration: { switches: { "features.member_invitations.enabled": "true" } } },
      { organizationConfiguration: { switches: { "features.member_invitations.enabled": false } } }]) {
      expect(memberSentInvitationsEnabled(data)).toBe(false);
    }
  });

  it("sends the session bearer and only invitation fields", async () => {
    const fetchMock = vi.fn(async () => response({ accepted: true }, 202));
    vi.stubGlobal("fetch", fetchMock);
    await expect(inviteMember(session, {
      email: "member@example.com", fullName: "Member Name", chapterId: "wor",
      initialRole: null, locale: "en", password: "must-not-leave",
    })).resolves.toEqual({ accepted: true });
    const [, init] = fetchMock.mock.calls[0];
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store" });
    expect(init.headers.Authorization).toBe("Bearer member-access-token");
    expect(JSON.parse(init.body)).toEqual({
      action: "create", email: "member@example.com", fullName: "Member Name",
      chapterId: "wor", initialRole: null, locale: "en",
    });
    expect(init.body).not.toMatch(/password|token_hash|service/i);
  });

  it("sends the former-member flag only when asked, with no initial role", async () => {
    const fetchMock = vi.fn(async () => response({ accepted: true }, 202));
    vi.stubGlobal("fetch", fetchMock);
    await inviteMember(session, {
      email: "former@example.com", fullName: "", chapterId: "wor", initialRole: "steward", locale: "es", formerMember: true,
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      action: "create", email: "former@example.com", fullName: "", chapterId: "wor", initialRole: null, locale: "es", formerMember: true,
    });
  });

  // REQ-UG-INVITATION-SUGGESTIONS-AND-ACCESS-REQUESTS-20261030
  it("names the member suggestion being approved, and only then", async () => {
    const fetchMock = vi.fn(async () => response({ accepted: true }, 202));
    vi.stubGlobal("fetch", fetchMock);
    await inviteMember(session, { requestId: "r-1", email: "y@example.com", fullName: "Yuqing Li", chapterId: "wor", locale: "en" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ action: "create", requestId: "r-1", initialRole: null });
    await inviteMember(session, { email: "y@example.com", fullName: "Yuqing Li", chapterId: "wor", locale: "en" });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty("requestId");
  });

  // UX-UG-ROSTER-IMPORT-TAKES-DAYS-20261018
  it("sends the roster source for CSV rows and carries a roster limit stop", async () => {
    const fetchMock = vi.fn(async () => response({ accepted: true }, 202));
    vi.stubGlobal("fetch", fetchMock);
    await inviteMember(session, { email: "r@example.com", fullName: "Roster Row", chapterId: "wor", locale: "en", source: "roster" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ action: "create", source: "roster", initialRole: null });
    await inviteMember(session, { email: "f@example.com", chapterId: "wor", locale: "en", formerMember: true, source: "roster" });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty("source");

    const retryAt = "2026-10-22T03:00:00.000Z";
    vi.stubGlobal("fetch", vi.fn(async () => response({ error: "rate-limited", limit: "limits.security.invitation_roster_admin_hourly", retryAt }, 429)));
    const limited = await inviteMember(session, { email: "r@example.com", fullName: "Roster Row", chapterId: "wor", locale: "en", source: "roster" }).catch((error) => error);
    expect(limited).toBeInstanceOf(AdminInvitationError);
    expect(limited).toMatchObject({ code: "rate-limited", status: 429, limit: "limits.security.invitation_roster_admin_hourly", retryAt });

    vi.stubGlobal("fetch", vi.fn(async () => response({ error: "rate-limited", limit: 5, retryAt: "later" }, 429)));
    const malformed = await inviteMember(session, { email: "r@example.com", fullName: "Roster Row", chapterId: "wor", locale: "en", source: "roster" }).catch((error) => error);
    expect(malformed).toMatchObject({ code: "rate-limited", limit: null, retryAt: null });
  });

  it("uses opaque ids for resend/revoke and returns one stable shape", async () => {
    const fetchMock = vi.fn(async () => response({ accepted: true }, 202));
    vi.stubGlobal("fetch", fetchMock);
    await resendMemberInvitation(session, invitationId);
    await revokeMemberInvitation(session, invitationId);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body))).toEqual([
      { action: "resend", invitationId },
      { action: "revoke", invitationId },
    ]);
  });

  it("fails before fetch on a missing session", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(inviteMember(null, {})).rejects.toMatchObject({ code: "session-expired" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps server codes without exposing provider response detail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({
      error: "delivery-unavailable", provider: "private upstream detail",
    }, 502)));
    const error = await inviteMember(session, {
      email: "member@example.com", fullName: "Member Name", chapterId: "wor",
      initialRole: null, locale: "en",
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(AdminInvitationError);
    expect(error.code).toBe("delivery-unavailable");
    expect(error.message).toBe("delivery-unavailable");
    expect(JSON.stringify(error)).not.toContain("private upstream detail");
  });
});
