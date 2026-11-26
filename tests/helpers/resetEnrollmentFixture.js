import handler from "../../api/password-reset.js";
import { resetTicketKey, sealResetTicket } from "../../api/_lib/passwordReset.js";
import { PORTAL_HOST, PORTAL_ORIGIN, SUPABASE_ORIGIN, SUPABASE_REF } from "./fictional-provider.js";

// The real reset handler and client transports, with only Auth replaced.
// Every fetch is intercepted; this fixture cannot contact a hosted service.
export function resetEnrollmentFixture(vi) {
  const service = "fixture-reset-service-key-long-enough";
  let user = "11111111-2222-4333-8444-555555555555";
  const origin = SUPABASE_ORIGIN;
  const factors = new Map();
  let nextFactor = 0;
  let enrollmentFailure = 0;
  let deletionFailure = 0;
  const factorOwners = new Map();
  const response = (body, status = 200) => new Response(JSON.stringify(body), { status });
  const fetcher = async (url, init = {}) => {
    const path = new URL(url, PORTAL_ORIGIN).pathname;
    if (path === "/api/password-reset") {
      let status = 0;
      let body;
      const res = { status(code) { status = code; return this; }, setHeader() {}, end(value) { body = value; } };
      await handler({ method: "POST", headers: { host: PORTAL_HOST, origin: PORTAL_ORIGIN, "x-vercel-forwarded-for": "203.0.113.9" }, body: JSON.parse(init.body) }, res);
      return new Response(body, { status });
    }
    if (path === "/rest/v1/rpc/consume_password_reset_attempt") return response(true);
    if (path === "/auth/v1/verify") return response({ access_token: "fixture-access", user: { id: user } });
    if (path === `/auth/v1/admin/users/${user}/factors`) return response([...factors.values()].filter(factor => factorOwners.get(factor.id) === user));
    if (init.method === "DELETE" && path.startsWith(`/auth/v1/admin/users/${user}/factors/`)) {
      if (deletionFailure) return response({}, deletionFailure);
      factors.delete(path.split("/").at(-1));
      return response({});
    }
    if (path === "/auth/v1/factors") {
      if (enrollmentFailure === "transport") throw new TypeError("fetch failed");
      if (enrollmentFailure) return response({}, enrollmentFailure);
      const id = `aaaaaaaa-bbbb-4ccc-8ddd-${String(++nextFactor).padStart(12, "0")}`;
      factors.set(id, { id, factor_type: "totp", status: "unverified" });
      factorOwners.set(id, user);
      return response({ id, totp: { secret: "JBSWY3DPEHPK3PXP" } });
    }
    throw new Error(`Unexpected fixture request: ${path}`);
  };
  for (const [key, value] of Object.entries({ VITE_SUPABASE_URL: origin, UNIONGROUND_SUPABASE_PROJECT_REF: SUPABASE_REF, VITE_SUPABASE_PUBLISHABLE_KEY: "fixture-public-key", SUPABASE_SERVICE_ROLE_KEY: service, INVITATION_APP_ORIGIN: PORTAL_ORIGIN })) vi.stubEnv(key, value);
  vi.stubGlobal("fetch", fetcher);
  return {
    fetcher,
    ticketA: sealResetTicket(resetTicketKey(service), "a1".repeat(28)),
    ticketB: sealResetTicket(resetTicketKey(service), "b2".repeat(28)),
    failEnrollment(status) { enrollmentFailure = status; },
    failDeletion(status) { deletionFailure = status; },
    useOtherAccount() { user = "22222222-3333-4444-8555-666666666666"; },
    // An abandoned unverified factor of the current account (BUG-UNIONGROUND-
    // RESET-PENDING-RECORD-ACCOUNT-BINDING-20261021: the other account's own).
    seedFactor() {
      const id = `aaaaaaaa-bbbb-4ccc-8ddd-${String(++nextFactor).padStart(12, "0")}`;
      factors.set(id, { id, factor_type: "totp", status: "unverified" });
      factorOwners.set(id, user);
    },
    factorCount() { return factors.size; },
  };
}
