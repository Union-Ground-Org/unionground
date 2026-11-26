// BUG-UG-LOCAL-PROFILE-IS-READ-BY-NOTHING-AND-EVERY-UNION-SHARES-ONE-FOOTER-ADDRESS-20261122
// (#9507): an email footer that carries a postal address carries the sending
// organization's own address; an organization with no address on file sends
// none rather than another's. The deployment-wide ORG_POSTAL_ADDRESS stands in
// only for a claimed row with no postalAddress key at all (a database the
// migration has not reached yet), so nothing changes between the merge and the
// apply. The dispatcher reads it once at import, so each test sets it first
// and imports the modules fresh.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));

vi.mock("web-push", () => ({ default: { sendNotification: vi.fn(), setVapidDetails: vi.fn() } }));

const CRON = "footer-fixture-cron-secret-".repeat(2);
const SHARED = "999 Shared Street, Elsewhere";
const ALDER = "1 Alder Way, Fictionville";
const BIRCH = "2 Birch Road, Exampletown";

function reply(value) {
  return { ok: true, status: 200, text: async () => JSON.stringify(value) };
}

function emailRow(deliveryId, postalAddress) {
  return {
    deliveryId, attempt: 1, leaseEpoch: 1, kind: "cases", lang: "en", email: `${deliveryId}@example.test`,
    subscriptions: null, ...(postalAddress === undefined ? {} : { postalAddress }),
  };
}

function installFetch(emailRows) {
  const sent = [];
  let emailClaimed = false;
  vi.stubGlobal("fetch", vi.fn(async (url, init) => {
    const target = String(url);
    if (target.includes("/rest/v1/rpc/")) {
      const name = target.split("/rest/v1/rpc/")[1];
      const body = JSON.parse(init.body);
      if (name === "claim_notification_deliveries") {
        if (body.p_channel !== "email" || emailClaimed) return reply([]);
        emailClaimed = true;
        return reply(emailRows);
      }
      if (name === "record_notification_delivery_results") return reply({ applied: body.p_results.length, ignored: 0 });
      if (name === "expire_notification_deliveries") return reply({ expired: 0, exhausted: 0, ineligible: 0 });
      if (name === "get_notification_dispatch_health") return reply({ queue: { pending_email: 0, pending_push: 0 } });
      if (name === "prune_stale_native_push_installations") return reply(0);
      return reply([]);
    }
    if (new URL(target).hostname === "api.resend.com") {
      sent.push(JSON.parse(init.body));
      return reply({ id: `re-${sent.length}` });
    }
    throw new Error(`unexpected fetch ${target}`);
  }));
  return sent;
}

function response() {
  const out = { status: 0, body: null };
  return {
    out,
    status(code) { out.status = code; return this; },
    setHeader() {},
    end(payload) { out.body = JSON.parse(payload); },
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("ORG_POSTAL_ADDRESS", SHARED);
  vi.stubEnv("CRON_SECRET", CRON);
  vi.stubEnv("VITE_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "project");
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", `sb_publishable_${"p".repeat(40)}`);
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-value");
  vi.stubEnv("RESEND_API_KEY", "resend-test-key");
  vi.stubEnv("NOTIFY_FROM_ADDRESS", "notices@example.invalid");
  vi.stubEnv("NOTIFY_APP_URL", "https://app.unionground.test/m");
  for (const key of ["NOTIFY_KILL_SWITCH", "VITE_VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_CONTACT", "APNS_TEAM_ID", "APNS_KEY_ID", "APNS_PRIVATE_KEY", "APNS_BUNDLE_ID", "FCM_SERVICE_ACCOUNT_JSON"]) {
    vi.stubEnv(key, undefined);
  }
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("member notification email footers (#9507)", () => {
  it("prints each sending organization's own address, and none for an organization with none on file", async () => {
    const sent = installFetch([emailRow("alder", ALDER), emailRow("birch", BIRCH), emailRow("none", null), emailRow("empty", ""), emailRow("unusable", "3 Cedar <b>Court</b>")]);
    const { default: handler } = await import("../api/notifications-dispatch.js");
    const res = response();
    await handler({ method: "POST", headers: { authorization: `Bearer ${CRON}` } }, res);
    expect(res.out.status).toBe(200);
    const byRecipient = Object.fromEntries(sent.map((mail) => [mail.to[0].split("@")[0], mail]));
    expect(Object.keys(byRecipient).sort()).toEqual(["alder", "birch", "empty", "none", "unusable"]);
    expect(byRecipient.alder.text.endsWith(ALDER)).toBe(true);
    expect(byRecipient.alder.html).toContain(ALDER);
    expect(byRecipient.birch.text.endsWith(BIRCH)).toBe(true);
    expect(byRecipient.birch.html).toContain(BIRCH);
    expect(byRecipient.alder.html).not.toContain("Birch Road");
    expect(byRecipient.birch.html).not.toContain("Alder Way");
    for (const mail of Object.values(byRecipient)) {
      expect(mail.text).not.toContain("Shared Street");
      expect(mail.html).not.toContain("Shared Street");
    }
    expect(byRecipient.none.text.endsWith("/m/settings")).toBe(true);
    expect(byRecipient.empty.text.endsWith("/m/settings")).toBe(true);
    expect(byRecipient.unusable.text).not.toContain("Cedar");
    expect(byRecipient.unusable.html).not.toContain("Cedar");
  });

  it("keeps today's deployment-wide line for a row from a database not yet migrated (no postalAddress key)", async () => {
    const sent = installFetch([emailRow("unmigrated")]);
    const { default: handler } = await import("../api/notifications-dispatch.js");
    const res = response();
    await handler({ method: "POST", headers: { authorization: `Bearer ${CRON}` } }, res);
    expect(res.out.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0].text.endsWith(SHARED)).toBe(true);
    expect(sent[0].html).toContain(SHARED);
  });
});

describe("organizationFooterAddress", () => {
  it("keeps a stored office address on one line and refuses anything that is not one", async () => {
    const { organizationFooterAddress } = await import("../api/_lib/emailTemplate.js");
    expect(organizationFooterAddress("  1 Alder Way\r\n\r\nFictionville, ST 00000 ")).toBe("1 Alder Way, Fictionville, ST 00000");
    expect(organizationFooterAddress(BIRCH)).toBe(BIRCH);
    for (const value of [undefined, null, 42, {}, "", "   \n  ", "a <b>", "a > b", "tab\there", "x".repeat(301)]) {
      expect(organizationFooterAddress(value)).toBe("");
    }
    expect(organizationFooterAddress("x".repeat(300))).toBe("x".repeat(300));
  });
});
