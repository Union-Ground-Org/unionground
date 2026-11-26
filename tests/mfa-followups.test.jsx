import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { loadMigrationSql } from "./helpers/migration.js";
import { AdminView } from "../src/views/AdminView.jsx";
import { MfaChallenge, MfaSettings } from "../src/components/MfaSettings.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";

// Text pins are a tripwire, not a proof: they assert what THIS MIGRATION SAYS,
// not what the database ENDS UP WITH. A later create-or-replace can supersede
// every guard below and this file stays green. Current-state truth lives in
// scripts/db-contract.json, checked by `npm run verify:db`.
//
// Superseded here: upsert_push_subscription, redefined by 20260724034000_mfa_
// predicate_scope_and_capability_rpcs.

// MFA follow-ups (REQ-UG-MFA-ADMIN-VISIBILITY + the notify half of
// REQ-UG-MFA-ENROL-REAUTH): pins the migration's security shape, the
// loader's null-sentinel degrade, and the two client surfaces.

const sql = loadMigrationSql("20260724120000_mfa_admin_visibility_and_enrol_alert.sql");
const deliverySql = loadMigrationSql("20260723201000_notification_kind_and_deliveries.sql");

function wrap(ui, lang = "en") {
  return render(<LanguageProvider lang={lang}>{ui}</LanguageProvider>);
}

describe("get_admin_mfa_status migration shape", () => {
  it("is volatile because its role gate is volatile and lock-bearing", () => {
    const body = sql.slice(sql.indexOf("create function public.get_admin_mfa_status()"));
    expect(body).toMatch(/security definer\s+volatile\s+set search_path = ''/);
  });

  it("is an admin-gated definer with an empty search_path and explicit grants", () => {
    expect(sql).toContain("create function public.get_admin_mfa_status()");
    expect(sql).toContain("security definer");
    expect(sql).toContain("set search_path = ''");
    expect(sql).toContain("not public.member_has_role(array['admin'])");
    expect(sql).toContain("errcode = '42501'");
    expect(sql).toContain("revoke all on function public.get_admin_mfa_status() from public, anon;");
    expect(sql).toContain("grant execute on function public.get_admin_mfa_status() to authenticated;");
  });

  it("scopes the challengeable check to verified TOTP, matching the assurance predicate", () => {
    expect(sql).toContain("and f.factor_type = 'totp') as totp_verified");
    expect(sql).toContain("and f.factor_type <> 'totp')::integer as other_factors");
    expect(sql.match(/f\.status = 'verified'/g).length).toBeGreaterThanOrEqual(3);
  });

  it("returns the org-wide figure as a count, never a browsable member list", () => {
    expect(sql).toContain("pg_catalog.count(distinct f.user_id)");
    // Staff listing is scoped to role holders only.
    expect(sql).toContain("from (select distinct user_id from public.member_roles) r");
  });

  it("sorts unprotected staff first — the row an admin opens this to find", () => {
    expect(sql).toContain("order by s.totp_verified, s.full_name, s.user_id");
  });
});

describe("enrolment notification trigger shape", () => {
  it("is a definer the client cannot execute, with an empty search_path", () => {
    expect(sql).toContain("create function private.notify_mfa_enrolment()");
    expect(sql).toContain("revoke all on function private.notify_mfa_enrolment() from public, anon, authenticated;");
  });

  it("can never make GoTrue's enrolment transaction fail", () => {
    const body = sql.slice(sql.indexOf("create function private.notify_mfa_enrolment()"));
    expect(body).toContain("exception when others then");
    expect(body).toContain("raise warning");
    expect(body).toContain("return null;");
  });

  it("fires only on a factor becoming verified, on both insert and update paths", () => {
    expect(sql).toContain("after insert on auth.mfa_factors");
    expect(sql).toContain("when (new.status = 'verified')");
    expect(sql).toContain("after update on auth.mfa_factors");
    expect(sql).toContain("when (old.status is distinct from new.status and new.status = 'verified')");
  });

  it("rate-limits the warning to one per member-hour, killing the re-enrol flood loop", () => {
    const body = sql.slice(sql.indexOf("create function private.notify_mfa_enrolment()"));
    expect(body).toContain("interval '1 hour'");
    expect(body).toMatch(/if exists \(\s*select 1 from public\.member_notifications n/);
    // The cooldown must run BEFORE the insert, not after.
    expect(body.indexOf("interval '1 hour'")).toBeLessThan(body.indexOf("insert into public.member_notifications"));
  });

  it("writes a localized in-app row and does not mislabel it as outbound", () => {
    expect(sql).toContain("insert into public.member_notifications (user_id, title, body, kind)");
    expect(sql).toContain("'Two-step sign-in was turned on'");
    expect(sql).toContain("'Se activó la verificación en dos pasos'");
    expect(sql.match(/'general'\);/g).length).toBe(2);
    expect(sql).not.toMatch(/via email\/push|once outbound is activated/);
    // General notifications are deliberately in-app only. The outbound
    // enqueue function accepts a fixed set of other kinds and returns early.
    expect(sql).not.toContain("notification_deliveries");
    expect(deliverySql).toContain("if new.kind not in ('deadlines', 'cases', 'forms', 'votes', 'events') then");
    expect(deliverySql).toMatch(/if new\.kind not in \('deadlines', 'cases', 'forms', 'votes', 'events'\) then\s+return new;/);
  });
});

describe("loadAdminDesk MFA degrade + mapping", () => {
  const baseRpc = (name) => {
    if (name === "get_staff_roster") return { data: [{ userId: "u1" }], error: null };
    if (name === "get_admin_events") return { data: [], error: null };
    if (name === "get_admin_audit") return { data: [], error: null };
    if (name === "get_admin_reward_queue") return { data: [], error: null };
    return null;
  };

  it("degrades a failed MFA read to null — never to an empty 'nobody enrolled'", async () => {
    const { loadAdminDesk } = await import("../src/lib/memberApi.js");
    const client = { rpc: async (name) => baseRpc(name) ?? { data: null, error: { message: "mfa down" } } };
    const desk = await loadAdminDesk(client);
    expect(desk.mfa).toBeNull();
    expect(desk.roster).toHaveLength(1);
  });

  it("maps verifiedAt to a localized label and coerces the org count", async () => {
    const { loadAdminDesk } = await import("../src/lib/memberApi.js");
    const client = {
      rpc: async (name) => baseRpc(name) ?? {
        data: {
          enrolledMembers: "3",
          staff: [{ userId: "u1", fullName: "A", initials: "A", roles: ["admin"], totpVerified: true, verifiedAt: "2026-07-12T10:00:00Z", otherFactors: 0 }],
        },
        error: null,
      },
    };
    const desk = await loadAdminDesk(client);
    expect(desk.mfa.enrolledMembers).toBe(3);
    expect(desk.mfa.staff[0].verifiedLabel).toContain("Jul");
  });
});

// Owned by this test, not by src/data/fallback.js: an unrelated edit to the
// shared demo dataset (adding a staff member, changing enrolledMembers) must
// not break an MFA-specific assertion. Shape matches adminDesk.mfa /
// adminDesk.mfaPolicy exactly; skeleton fields for the rest of the card
// (roster, organization, etc.) still come from the shared fixture below.
const MFA_CARD_FIXTURE = {
  enrolledMembers: 214,
  staff: [
    { userId: "staff-an", fullName: "Avery Nguyen", initials: "AN", roles: ["advisor"], totpVerified: false, verifiedLabel: "", otherFactors: 0 },
    { userId: "staff-so", fullName: "Sam Okafor", initials: "SO", roles: ["steward"], totpVerified: false, verifiedLabel: "", otherFactors: 1 },
    { userId: "staff-jp", fullName: "Jordan Patel", initials: "JP", roles: ["coordinator"], totpVerified: false, verifiedLabel: "", otherFactors: 0 },
    { userId: "staff-tm", fullName: "Taylor Morgan", initials: "TM", roles: ["vp"], totpVerified: false, verifiedLabel: "", otherFactors: 0 },
    { userId: "staff-ar", fullName: "Alex Rivera", initials: "AR", roles: ["admin"], totpVerified: true, verifiedLabel: "Jul 12", otherFactors: 0 },
    { userId: "staff-pc", fullName: "Priya Chandran", initials: "PC", roles: ["steward"], totpVerified: true, verifiedLabel: "Jun 30", otherFactors: 0 },
  ],
};
const MFA_POLICY_CARD_FIXTURE = { requireStaffMfa: false, staffTotal: 6, staffEnrolled: 2, callerEnrolled: true };

function adminDeskWithMfaFixture() {
  const desk = JSON.parse(JSON.stringify(fallbackData.adminDesk));
  desk.mfa = JSON.parse(JSON.stringify(MFA_CARD_FIXTURE));
  desk.mfaPolicy = { ...MFA_POLICY_CARD_FIXTURE };
  return desk;
}

describe("admin view MFA status card", () => {
  function renderAdmin(desk, lang = "en") {
    const api = {
      loadDesk: vi.fn().mockResolvedValue(desk),
      grantRole: vi.fn(),
      revokeRole: vi.fn(),
      searchMembers: vi.fn(),
      createEvent: vi.fn(),
      updateEvent: vi.fn(),
      loadFormTemplates: vi.fn().mockResolvedValue([]),
      saveFormTemplate: vi.fn(),
      deactivateFormTemplate: vi.fn(),
      reactivateFormTemplate: vi.fn(),
      updateOrganizationSetting: vi.fn().mockResolvedValue({ updated: true }),
      updateOrganizationLabel: vi.fn().mockResolvedValue({ updated: true }),
      loadFailedLoginInbox: vi.fn().mockResolvedValue({ items: [], openLast24Hours: 0, attentionThreshold: 5 }),
      dispositionFailedLoginAttempt: vi.fn().mockResolvedValue({ updated: true }),
    };
    render(
      <LanguageProvider lang={lang}>
        <AdminView data={{ member: { initials: "AR" } }} api={api} onNotice={vi.fn()} />
      </LanguageProvider>,
    );
    return api;
  }

  it("summarizes staff coverage and the org-wide count, on-status chips per person", async () => {
    renderAdmin(adminDeskWithMfaFixture());
    expect(await screen.findByText("2 of 6 staff members have two-step sign-in on · 214 workers in all have it on")).toBeInTheDocument();
    const mfa = within(document.getElementById("admin-mfa"));
    expect(mfa.getByText("On · Jul 12")).toBeInTheDocument();
    expect(mfa.getAllByText("Off").length).toBe(4);
    // A verified factor this client cannot challenge must be visible, not
    // silently counted as protection.
    expect(mfa.getByText("1 other two-step method this app can't use")).toBeInTheDocument();
  });

  it("says 'unavailable', not 'off for everyone', when the MFA reader fails", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.adminDesk));
    seed.mfa = null;
    renderAdmin(seed);
    expect(await screen.findByText("Two-step status could not be loaded.")).toBeInTheDocument();
    expect(screen.queryByText(/staff members have two-step sign-in on/)).not.toBeInTheDocument();
  });

  it("explains an empty roster instead of rendering a blank card", async () => {
    const seed = JSON.parse(JSON.stringify(fallbackData.adminDesk));
    seed.mfa = { enrolledMembers: 0, staff: [] };
    renderAdmin(seed);
    expect(await screen.findByText("No staff roles are granted yet, so there is nobody to check.")).toBeInTheDocument();
  });

  // #9533 A-1: "35 members org-wide" beside 66 staff read as the organization's
  // size; it counts members with two-step on. The "staff must set up" line
  // said nothing of the staff still Off. The reset stays on every other row:
  // the endpoint deletes every factor GoTrue lists (unverified ones too) and
  // releases recovery locks and sessions, while a row counts verified factors
  // only, so no row can show there is nothing to reset (gate read of 28640011).
  it("keeps the reset on Off rows, rows without indicators and verified rows, and counts staff still to set up", async () => {
    const desk = adminDeskWithMfaFixture();
    desk.mfaPolicy = { ...MFA_POLICY_CARD_FIXTURE, requireStaffMfa: true };
    // Avery's row carries no indicators at all; Jordan's carries nulls.
    const avery = desk.mfa.staff.find((row) => row.userId === "staff-an");
    delete avery.totpVerified; delete avery.otherFactors;
    Object.assign(desk.mfa.staff.find((row) => row.userId === "staff-jp"), { totpVerified: null, otherFactors: null });
    renderAdmin(desk);
    await screen.findByText(/workers in all have it on/);
    const mfa = within(document.getElementById("admin-mfa"));
    const resetFor = (name) => mfa.queryByRole("button", { name: new RegExp(`Reset two-step sign-in for ${name}`) });
    for (const name of ["Avery Nguyen", "Jordan Patel", "Taylor Morgan", "Sam Okafor", "Alex Rivera", "Priya Chandran"]) {
      expect(resetFor(name)).not.toBeNull();
    }
    expect(screen.getByText("4 of 6 staff members have not set it up yet, so they cannot use their staff roles until they do.")).toBeInTheDocument();
  });

  // #9533 verify read: with one staff member in all, "1 of 1 staff members"
  // read wrong; the note names the only staff member instead.
  it.each([
    ["en", "Your one staff member has not set it up yet, so they cannot use a staff role until they do."],
    ["es", "La única persona del personal todavía no lo ha configurado, así que no puede usar sus roles hasta entonces."],
  ])("says the only staff member is waiting when the staff total is one (%s)", async (lang, waiting) => {
    const desk = adminDeskWithMfaFixture();
    desk.mfa = { enrolledMembers: 0, staff: MFA_CARD_FIXTURE.staff.slice(0, 1) };
    desk.mfaPolicy = { requireStaffMfa: true, staffTotal: 1, staffEnrolled: 0, callerEnrolled: true };
    renderAdmin(desk, lang);
    expect(await screen.findByText(waiting)).toBeInTheDocument();
    expect(screen.queryByText(/^1 (of|de) 1 /)).toBeNull();
  });

  it.each([
    ["en", "1 of 2 staff members have two-step sign-in on · 1 worker in all has it on", "1 of 2 staff members has not set it up yet, so that person cannot use a staff role until they do."],
    ["es", "1 de 2 integrantes del personal tienen el inicio en dos pasos activo · 1 trabajador en total lo tiene activo", "1 de 2 integrantes del personal todavía no lo ha configurado, así que no puede usar sus roles hasta entonces."],
  ])("says one member and one waiting staff member in the singular (%s)", async (lang, summary, waiting) => {
    const desk = adminDeskWithMfaFixture();
    desk.mfa = { enrolledMembers: 1, staff: MFA_CARD_FIXTURE.staff.slice(4, 5).concat(MFA_CARD_FIXTURE.staff.slice(0, 1)) };
    desk.mfaPolicy = { requireStaffMfa: true, staffTotal: 2, staffEnrolled: 1, callerEnrolled: true };
    renderAdmin(desk, lang);
    expect(await screen.findByText(summary)).toBeInTheDocument();
    expect(screen.getByText(waiting)).toBeInTheDocument();
  });

  it("renders the card in Spanish", async () => {
    renderAdmin(adminDeskWithMfaFixture(), "es");
    expect(await screen.findByText("2 de 6 integrantes del personal tienen el inicio en dos pasos activo · 214 trabajadores en total lo tienen activo")).toBeInTheDocument();
    expect(screen.getByText("Activo · Jul 12")).toBeInTheDocument();
  });
});

describe("MFA challenge screen tells a victim the way out", () => {
  const client = { auth: { mfa: { listFactors: vi.fn().mockResolvedValue({ data: { all: [] }, error: null }) } } };

  it("names the not-you path in English", () => {
    wrap(<MfaChallenge client={client} onCleared={vi.fn()} onSignOut={vi.fn()} />);
    expect(screen.getByText(/If you never added an authenticator/)).toBeInTheDocument();
  });

  it("names the not-you path in Spanish", () => {
    wrap(<MfaChallenge client={client} onCleared={vi.fn()} onSignOut={vi.fn()} />, "es");
    expect(screen.getByText(/Si nunca agregaste un autenticador/)).toBeInTheDocument();
  });
});

// UX-UG-WEB-MFA-SCREENS-SHOW-ENGLISH-GOTRUE-ERRORS-20260920.
//
// Both screens used to print `error.message` whenever GoTrue supplied one, with
// the translated line beside it reachable only for an error carrying no message
// at all — so in practice a Spanish-reading member saw GoTrue's English on the
// wrong code, the failed enrolment and the failed turn-off. These render in
// Spanish and demand the catalogue line, and that the English is absent: the
// two halves are separate failures (showing nothing, and showing the server
// copy) and a test that only checked one of them would pass on the other.
describe("MFA failures speak the member's language, not GoTrue's", () => {
  // Real GoTrue copy, English-only on every locale.
  const GOTRUE_BAD_CODE = "Invalid TOTP code entered";
  const GOTRUE_ENROLL = "MFA enroll is disabled";
  const GOTRUE_UNENROLL = "Factor not found";

  const ES_CODE_REJECTED = "Los códigos cambian cada 30 segundos, así que ese puede haber vencido. Escribe el código que muestra tu app ahora. Si los códigos nuevos siguen fallando, activa la fecha y hora automáticas en tu teléfono.";
  const ES_ENROLL_FAILED = "No se pudo configurar el inicio de sesión en dos pasos.";
  const ES_DISABLE_FAILED = "No se pudo desactivar el inicio de sesión en dos pasos.";
  const ES_NO_FACTOR = "No hay ninguna app de autenticación configurada para esta cuenta.";

  const totp = (id, status = "verified") => ({ id, factor_type: "totp", status });

  function settingsClient(mfa = {}) {
    return {
      auth: {
        mfa: {
          listFactors: vi.fn().mockResolvedValue({ data: { all: [], totp: [] }, error: null }),
          enroll: vi.fn().mockResolvedValue({ data: { id: "f1", totp: { qr_code: "", secret: "S" } }, error: null }),
          challenge: vi.fn().mockResolvedValue({ data: { id: "c1" }, error: null }),
          verify: vi.fn().mockResolvedValue({ error: null }),
          unenroll: vi.fn().mockResolvedValue({ error: null }),
          ...mfa,
        },
      },
      rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
  }

  it("shows the catalogue rejection on the sign-in challenge, not GoTrue's English", async () => {
    const client = {
      auth: {
        mfa: {
          listFactors: vi.fn().mockResolvedValue({ data: { all: [totp("f9")] }, error: null }),
          challenge: vi.fn().mockResolvedValue({ data: { id: "c9" }, error: null }),
          verify: vi.fn().mockResolvedValue({ error: { message: GOTRUE_BAD_CODE } }),
        },
      },
    };
    const { container } = wrap(<MfaChallenge client={client} onCleared={vi.fn()} onSignOut={vi.fn()} />, "es");
    fireEvent.change(container.querySelector('input[name="code"]'), { target: { value: "000000" } });
    fireEvent.submit(container.querySelector("form"));

    await waitFor(() => expect(container.querySelector(".auth-message")).toBeTruthy());
    expect(container.querySelector(".auth-message").textContent).toBe(ES_CODE_REJECTED);
    expect(screen.queryByText(GOTRUE_BAD_CODE)).toBeNull();
  });

  it("still shows the challenge's own translated line when no factor can be challenged", async () => {
    // The counterweight: suppressing the server message must not also suppress
    // the messages this app raises through the same catch, which travelled on
    // error.message too.
    const client = {
      auth: {
        mfa: {
          listFactors: vi.fn().mockResolvedValue({
            data: { all: [{ id: "p1", factor_type: "phone", status: "verified" }] },
            error: null,
          }),
          challenge: vi.fn(),
          verify: vi.fn(),
        },
      },
    };
    const { container } = wrap(<MfaChallenge client={client} onCleared={vi.fn()} onSignOut={vi.fn()} />, "es");
    fireEvent.change(container.querySelector('input[name="code"]'), { target: { value: "123456" } });
    fireEvent.submit(container.querySelector("form"));

    await waitFor(() => expect(container.querySelector(".auth-message")).toBeTruthy());
    expect(container.querySelector(".auth-message").textContent).toBe(ES_NO_FACTOR);
  });

  it("shows the catalogue setup failure when enrolment is refused", async () => {
    const client = settingsClient({
      enroll: vi.fn().mockResolvedValue({ data: null, error: { message: GOTRUE_ENROLL } }),
    });
    const { container } = wrap(<MfaSettings client={client} />, "es");
    const enable = await screen.findByRole("button", { name: "Activar el inicio de sesión en dos pasos" });
    fireEvent.click(enable);

    await waitFor(() => expect(container.querySelector(".auth-message--error")).toBeTruthy());
    expect(container.querySelector(".auth-message--error").textContent).toBe(ES_ENROLL_FAILED);
    expect(screen.queryByText(GOTRUE_ENROLL)).toBeNull();
  });

  it("shows the catalogue rejection when the enrolment code is wrong", async () => {
    const client = settingsClient({
      verify: vi.fn().mockResolvedValue({ error: { message: GOTRUE_BAD_CODE } }),
    });
    const { container } = wrap(<MfaSettings client={client} />, "es");
    fireEvent.click(await screen.findByRole("button", { name: "Activar el inicio de sesión en dos pasos" }));
    const code = await waitFor(() => {
      const input = container.querySelector('.mfa-enroll input[name="code"]');
      expect(input).toBeTruthy();
      return input;
    });
    fireEvent.change(code, { target: { value: "000000" } });
    fireEvent.submit(container.querySelector(".mfa-enroll"));

    await waitFor(() => expect(container.querySelector(".auth-message--error")).toBeTruthy());
    expect(container.querySelector(".auth-message--error").textContent).toBe(ES_CODE_REJECTED);
    expect(screen.queryByText(GOTRUE_BAD_CODE)).toBeNull();
  });

  it("shows the catalogue turn-off failure when unenrolment throws", async () => {
    const client = settingsClient({
      listFactors: vi.fn().mockResolvedValue({ data: { all: [totp("f1")], totp: [totp("f1")] }, error: null }),
      unenroll: vi.fn().mockRejectedValue(new Error(GOTRUE_UNENROLL)),
    });
    const { container } = wrap(<MfaSettings client={client} />, "es");
    fireEvent.click(await screen.findByRole("button", { name: "Desactivar el inicio de sesión en dos pasos" }));
    fireEvent.click(screen.getByRole("button", { name: "Desactivarlo" }));

    await waitFor(() => expect(container.querySelector(".auth-message--error")).toBeTruthy());
    expect(container.querySelector(".auth-message--error").textContent).toBe(ES_DISABLE_FAILED);
    expect(screen.queryByText(GOTRUE_UNENROLL)).toBeNull();
  });
});
