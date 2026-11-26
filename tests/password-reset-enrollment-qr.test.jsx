import { render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import resetHandler from "../api/password-reset.js";
import { resetTicketKey, sealResetTicket } from "../api/_lib/passwordReset.js";
import { PasswordResetView } from "../src/views/PasswordResetView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { PORTAL_HOST, PORTAL_ORIGIN, SUPABASE_ORIGIN, SUPABASE_REF } from "./helpers/fictional-provider.js";

vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule());
vi.mock("../src/lib/emailLinkHosts.js", async () => (await import("./helpers/fictional-provider.js")).emailLinkHostsModule());

// Raw GoTrue response, before auth-js adds a data-image prefix. Synthetic SVG
// and enrollment secret only; no external account or provider is contacted.
const bareSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21"><path fill="#000" d="M0 0h7v7H0z"/></svg>';
const xmlSvg = '<?xml version="1.0" encoding="UTF-8"?>\n' + bareSvg;
afterEach(() => { window.sessionStorage.clear(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it.each([bareSvg, xmlSvg])("renders the GoTrue SVG through the real reset API and browser adapter (%#)", async (svg) => {
  const factor = { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", totp: { qr_code: svg, secret: "JBSWY3DPEHPK3PXP" } };
  const backend = SUPABASE_ORIGIN;
  const service = "server-secret-key-long-enough";
  const user = "11111111-2222-4333-8444-555555555555";
  vi.stubEnv("VITE_SUPABASE_URL", backend);
  vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", SUPABASE_REF);
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "publishable-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", service);
  vi.stubEnv("INVITATION_APP_ORIGIN", PORTAL_ORIGIN);
  const routes = {
    [`${backend}/rest/v1/rpc/consume_password_reset_attempt`]: true,
    [`${backend}/auth/v1/verify`]: { access_token: "fixture-aal1-token", user: { id: user } },
    [`${backend}/auth/v1/admin/users/${user}/factors`]: [],
    [`${backend}/auth/v1/factors`]: factor,
  };
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    if (!Object.hasOwn(routes, String(url))) throw new Error("Unexpected network request");
    return new Response(JSON.stringify(routes[String(url)]), { status: 200 });
  }));
  let payload;
  const transport = async (_url, init) => {
    let status;
    await resetHandler({ method: "POST", headers: { host: PORTAL_HOST, origin: PORTAL_ORIGIN, "x-vercel-forwarded-for": "203.0.113.9" }, body: JSON.parse(init.body) }, {
      status(value) { status = value; return this; },
      setHeader() {},
      end(body) { payload = JSON.parse(body); },
    });
    return { ok: status === 200, status, json: async () => payload };
  };
  const ticket = sealResetTicket(resetTicketKey(service), "a1".repeat(28));
  render(<LanguageProvider lang="en"><PasswordResetView fetcher={transport} readToken={() => ticket} /></LanguageProvider>);
  const image = await screen.findByRole("img", { name: /QR/i });
  expect(image).toBeVisible();
  expect(image.getAttribute("src")).toBe(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  expect(decodeURIComponent(image.getAttribute("src").split(",")[1])).toBe(svg);
  expect(payload).toMatchObject({ mode: "enroll", secret: factor.totp.secret });
  expect(JSON.stringify(payload)).not.toContain("fixture-aal1-token");
  expect(screen.getByRole("button", { name: "Save new password" })).toHaveAttribute("aria-disabled", "true");
});
