// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AdminSigninRecoveryError,
  recoverMemberSigninAddress,
  reissueMemberPassword,
} from "../src/lib/adminSigninRecoveryApi.js";

const session = { access_token: "admin-access-token" };
const userId = "10000000-0000-4000-8000-000000000001";

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("admin sign-in recovery client", () => {
  it("sends only the closed recovery request with current bearer credentials", async () => {
    const fetchMock = vi.fn(async () => response({ completed: true }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(recoverMemberSigninAddress(session, {
      userId, newEmail: "new@example.com", reason: "lost_inbox",
      identityVerified: true, oldEmail: "must-not-leave",
    })).resolves.toEqual({ completed: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/admin-signin-recovery");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store" });
    expect(init.headers.Authorization).toBe("Bearer admin-access-token");
    expect(JSON.parse(init.body)).toEqual({
      userId, newEmail: "new@example.com", reason: "lost_inbox", identityVerified: true,
    });
    expect(init.body).not.toMatch(/oldEmail|password|service/i);
  });

  it("fails closed before fetch without a session", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(recoverMemberSigninAddress(null, {})).rejects.toMatchObject({ code: "session-expired" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // REQ-UG-BLOCK-GOVERNMENT-AND-EMPLOYER-EMAIL-DOMAINS-20261102.
  it("keeps the email-domain-blocked refusal so the desk can name it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ error: "email-domain-blocked" }, 400)));
    await expect(recoverMemberSigninAddress(session, { userId, newEmail: "new@agency.gov", reason: "lost_inbox", identityVerified: true }))
      .rejects.toMatchObject({ code: "email-domain-blocked" });
  });

  it("maps only stable error codes and drops upstream detail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({
      error: "recovery-unavailable", provider: "address private@example.com exists",
    }, 409)));
    const error = await recoverMemberSigninAddress(session, {
      userId, newEmail: "private@example.com", reason: "lost_inbox", identityVerified: true,
    }).catch((caught) => caught);
    expect(error).toBeInstanceOf(AdminSigninRecoveryError);
    expect(error.code).toBe("recovery-unavailable");
    expect(error.message).toBe("recovery-unavailable");
    expect(JSON.stringify(error)).not.toContain("provider");
  });

  it("maps malformed and unknown failures to the stable service error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => { throw new Error("bad json"); } })));
    await expect(recoverMemberSigninAddress(session, {
      userId, newEmail: "new@example.com", reason: "lost_inbox", identityVerified: false,
    })).rejects.toMatchObject({ code: "service-unavailable" });

    vi.stubGlobal("fetch", vi.fn(async () => response({ error: "provider-secret" }, 503)));
    await expect(recoverMemberSigninAddress(session, {
      userId, newEmail: "new@example.com", reason: "lost_inbox", identityVerified: false,
    })).rejects.toMatchObject({ code: "service-unavailable" });
  });
});

describe("admin password reissue client", () => {
  it("sends only the target and verified identity flag with current bearer credentials", async () => {
    const fetchMock = vi.fn(async () => response({ completed: true }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(reissueMemberPassword(session, {
      userId, identityVerified: true, password: "must-not-leave",
    })).resolves.toEqual({ completed: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/admin-password-reissue");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store" });
    expect(init.headers.Authorization).toBe("Bearer admin-access-token");
    expect(JSON.parse(init.body)).toEqual({ userId, identityVerified: true });
    expect(init.body).not.toMatch(/password|email|service/i);
  });

  it("fails closed before fetch without a session", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(reissueMemberPassword(null, {})).rejects.toMatchObject({ code: "session-expired" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves safe failures and maps provider or malformed detail to the service error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ error: "not-permitted" }, 403)));
    await expect(reissueMemberPassword(session, { userId, identityVerified: true }))
      .rejects.toMatchObject({ code: "not-permitted" });

    vi.stubGlobal("fetch", vi.fn(async () => response({ error: "reissue-unavailable" }, 409)));
    await expect(reissueMemberPassword(session, { userId, identityVerified: true }))
      .rejects.toMatchObject({ code: "reissue-unavailable" });
    // The route's 502 after authorization keeps its own class for the admin page.
    vi.stubGlobal("fetch", vi.fn(async () => response({ error: "reissue-incomplete" }, 502)));
    await expect(reissueMemberPassword(session, { userId, identityVerified: true }))
      .rejects.toMatchObject({ code: "reissue-incomplete" });

    vi.stubGlobal("fetch", vi.fn(async () => response({ error: "provider-private-detail" }, 503)));
    await expect(reissueMemberPassword(session, { userId, identityVerified: false }))
      .rejects.toMatchObject({ code: "service-unavailable" });

    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => { throw new Error("bad json"); } })));
    await expect(reissueMemberPassword(session, { userId, identityVerified: false }))
      .rejects.toMatchObject({ code: "service-unavailable" });
  });
});
