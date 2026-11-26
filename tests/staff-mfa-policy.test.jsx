import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AdminView } from "../src/views/AdminView.jsx";
import { MfaSettings } from "../src/components/MfaSettings.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { loadAdminDesk, loadMemberApp, setStaffMfaPolicy } from "../src/lib/memberApi.js";
import { fnBody, loadMigrationSql, migrationNames, stripComments } from "./helpers/migration.js";

const MIGRATION = "20260812091000_staff_mfa_policy.sql";
const rawSql = loadMigrationSql(MIGRATION);
const sql = stripComments(rawSql).toLowerCase();

const functionSql = (name) => stripComments(fnBody(rawSql, name)).toLowerCase();

function chainable(result) {
  const proxy = new Proxy(function () {}, {
    get(_target, prop) {
      if (prop === "then") return (...args) => Promise.resolve(result).then(...args);
      return () => proxy;
    },
  });
  return proxy;
}

function memberClient({ roles = [], standing = null, standingError = null } = {}) {
  return {
    from: (table) => chainable(table === "member_profiles"
      ? {
        data: {
          id: "member-1",
          first_name: "Ana",
          full_name: "Ana Rivera",
          initials: "AR",
          role_line: "Member",
          member_since: 2024,
          language: "en",
          notification_prefs: {},
          chapter_id: "chapter-1",
        },
        error: null,
      }
      : table === "member_roles"
        ? { data: roles.map((role) => ({ role })), error: null }
        : { data: [], error: null }),
    rpc: (name) => {
      if (name === "get_staff_mfa_standing") return Promise.resolve({ data: standing, error: standingError });
      if (name === "get_member_rewards_summary" || name === "get_workload_stats") {
        return Promise.resolve({ data: {}, error: null });
      }
      return Promise.resolve({ data: [], error: null });
    },
  };
}

function mfaClient({ factors = [[], [{ id: "totp-1", factor_type: "totp", status: "verified" }]] } = {}) {
  const listFactors = vi.fn();
  for (const value of factors) listFactors.mockResolvedValueOnce({ data: { all: value, totp: value }, error: null });
  return {
    auth: {
      mfa: {
        listFactors,
        enroll: vi.fn().mockResolvedValue({ data: { id: "totp-1", totp: { qr_code: "", secret: "SECRET" } }, error: null }),
        challenge: vi.fn().mockResolvedValue({ data: { id: "challenge-1" }, error: null }),
        verify: vi.fn().mockResolvedValue({ data: {}, error: null }),
        unenroll: vi.fn().mockResolvedValue({ error: null }),
      },
    },
  };
}

function renderEnglish(ui) {
  return render(<LanguageProvider lang="en">{ui}</LanguageProvider>);
}

describe("staff MFA policy migration", () => {
  it("uses the collision-safe migration timestamp and no earlier colliding name", () => {
    expect(migrationNames().filter((name) => name.endsWith("_staff_mfa_policy.sql"))).toEqual([MIGRATION]);
  });

  it("starts fail-closed and keeps the singleton table behind definer RPCs", () => {
    expect(sql).toMatch(/create table if not exists public\.org_security_policy[\s\S]*require_staff_mfa boolean not null default true/);
    expect(sql).toMatch(/id boolean primary key default true check \(id\)/);
    expect(sql).toContain("alter table public.org_security_policy enable row level security");
    expect(sql).toMatch(/create policy mfa_assurance on public\.org_security_policy\s+as restrictive for all to authenticated/);
    expect(sql.match(/create policy [a-z_]+ on public\.org_security_policy/g)).toHaveLength(1);
    expect(sql).toContain("revoke all on table public.org_security_policy from public, anon, authenticated");
    expect(functionSql("private.staff_mfa_required()")).toContain("true)");
  });

  it("counts only verified factor types the shipped challenge can answer", () => {
    const types = functionSql("private.challengeable_factor_types()");
    const enrolled = functionSql("private.has_second_factor(p_user uuid)");
    expect(types).toContain("array['totp']::auth.factor_type[]");
    expect(enrolled).toContain("f.status = 'verified'");
    expect(enrolled).toContain("f.factor_type = any (private.challengeable_factor_types())");
  });

  it("requires assurance, a granted role, and enrollment when policy is on", () => {
    const body = functionSql("public.member_has_role(p_roles text[])");
    expect(body).toContain("private.mfa_satisfied()");
    expect(body).toContain("from public.member_roles");
    expect(body).toContain("private.staff_mfa_required()");
    expect(body).toContain("private.has_second_factor((select auth.uid()))");
    expect(body.indexOf("from public.member_roles")).toBeLessThan(body.indexOf("private.staff_mfa_required()"));
  });

  it("does not give a password-only blocked admin an MFA policy bypass", () => {
    for (const name of ["public.get_staff_mfa_policy()", "public.set_staff_mfa_policy(p_required boolean)"]) {
      const body = functionSql(name);
      expect(body).toContain("public.member_has_role(array['admin'])");
      expect(body).not.toContain("role_before_staff_policy");
    }
    const setter = functionSql("public.set_staff_mfa_policy(p_required boolean)");
    expect(setter).toContain("p_required and not private.has_second_factor(caller)");
  });

  it("repairs and locks the singleton before deciding whether to audit a change", () => {
    const setter = functionSql("public.set_staff_mfa_policy(p_required boolean)");
    expect(setter).toContain("insert into public.org_security_policy");
    expect(setter).toContain("values (true, true)");
    expect(setter).toContain("on conflict (id) do nothing");
    expect(setter).toMatch(/select p\.require_staff_mfa[\s\S]*into current_value[\s\S]*for update/);
    const lock = setter.indexOf("for update");
    expect(setter.indexOf("public.member_has_role(array['admin'])", lock)).toBeGreaterThan(lock);
    expect(setter.indexOf("p_required and not private.has_second_factor(caller)", lock)).toBeGreaterThan(lock);
    expect(setter).toContain("current_value is distinct from p_required");
    expect(setter).toContain("'set_staff_mfa_policy'");
  });

  it("keeps the standing read self-scoped and reachable without a staff-role gate", () => {
    const standing = functionSql("public.get_staff_mfa_standing()");
    expect(standing).toContain("where user_id = caller");
    expect(standing).toContain("required and holds_role and not enrolled");
    expect(standing).not.toContain("member_has_role(");
  });
});

describe("staff MFA member API boundary", () => {
  it("suspends every granted hat while preserving the withheld roles for explanation", async () => {
    const out = await loadMemberApp(memberClient({
      roles: ["admin", "steward"],
      standing: { requireStaffMfa: true, holdsStaffRole: true, enrolled: false, blocked: true },
    }), { id: "member-1", email: "ana@example.org" });
    expect(out.roles).toEqual([]);
    expect(out.staffMfa).toEqual({
      required: true,
      holdsStaffRole: true,
      enrolled: false,
      blocked: true,
      suspendedRoles: ["admin", "steward"],
    });
  });

  it("preserves granted hats when the caller complies or the additive read is unavailable", async () => {
    const compliant = await loadMemberApp(memberClient({
      roles: ["advisor"],
      standing: { requireStaffMfa: true, holdsStaffRole: true, enrolled: true, blocked: false },
    }), { id: "member-1", email: "ana@example.org" });
    expect(compliant.roles).toEqual(["advisor"]);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const preMigration = await loadMemberApp(memberClient({
      roles: ["advisor"],
      standingError: { message: "function missing" },
    }), { id: "member-1", email: "ana@example.org" });
    expect(preMigration.roles).toEqual(["advisor"]);
    expect(preMigration.staffMfa).toBeNull();
    warn.mockRestore();
  });

  it("maps the admin policy independently from the MFA roster", async () => {
    const rpc = vi.fn(async (name) => {
      if (name === "get_staff_roster") return { data: [], error: null };
      if (name === "get_admin_events") return { data: [], error: null };
      if (name === "get_admin_audit") return { data: [], error: null };
      if (name === "get_admin_reward_queue") return { data: [], error: null };
      if (name === "get_admin_mfa_status") return { data: null, error: { message: "roster unavailable" } };
      return { data: { requireStaffMfa: true, staffTotal: "7", staffEnrolled: "5", callerEnrolled: true }, error: null };
    });
    const desk = await loadAdminDesk({ rpc });
    expect(desk.mfa).toBeNull();
    expect(desk.mfaPolicy).toEqual({ requireStaffMfa: true, requireMemberMfa: false, staffTotal: 7, staffEnrolled: 5, callerEnrolled: true });
  });

  it("sends a boolean policy write and surfaces a refusal", async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: { requireStaffMfa: true, changed: true }, error: null });
    await expect(setStaffMfaPolicy({ rpc }, true)).resolves.toEqual({ requireStaffMfa: true, changed: true });
    expect(rpc).toHaveBeenCalledWith("set_staff_mfa_policy", { p_required: true });
    await expect(setStaffMfaPolicy({ rpc: vi.fn().mockResolvedValue({ data: null, error: { message: "admin role required", code: "42501" } }) }, false))
      .rejects.toMatchObject({ code: "42501" });
  });
});

describe("staff MFA policy UI", () => {
  const desk = {
    roster: [],
    events: [],
    audit: [{ id: "audit-policy", action: "set_staff_mfa_policy", actorName: "Ana Rivera", targetName: null, detail: { requireStaffMfa: true }, createdLabel: "Aug 12" }],
    rewardQueue: [],
    mfa: { enrolledMembers: 5, staff: [] },
    mfaPolicy: { requireStaffMfa: false, staffTotal: 7, staffEnrolled: 5, callerEnrolled: true },
  };

  it.each([
    ["en", false], ["en", true], ["es", false], ["es", true],
  ])("keeps the staff policy copy consistent in %s (required=%s)", async (lang, required) => {
    const nextDesk = { ...desk, mfaPolicy: { ...desk.mfaPolicy, requireStaffMfa: required } };
    render(<LanguageProvider lang={lang}><AdminView
      data={{ member: { initials: "AR" }, rewardItems: [] }}
      api={{ loadDesk: vi.fn().mockResolvedValue(nextDesk) }} onNotice={vi.fn()}
    /></LanguageProvider>);
    const copy = catalogue[lang];
    expect(await screen.findByText(copy[required ? "admin.mfaPolicyOn" : "admin.mfaPolicyOff"])).toBeInTheDocument();
    expect(screen.queryByText(copy[required ? "admin.mfaPolicyOff" : "admin.mfaPolicyOn"])).toBeNull();
    expect(screen.getByText(copy[required ? "admin.mfaPolicySource" : "admin.mfaPolicyRecommendation"])).toBeInTheDocument();
    expect(screen.queryByText(copy[required ? "admin.mfaPolicyRecommendation" : "admin.mfaPolicySource"])).toBeNull();
    const enable = screen.queryByRole("button", { name: copy["admin.mfaPolicyEnable"] });
    if (required) expect(enable).toBeNull();
    else {
      expect(enable).toBeEnabled();
      expect(screen.getByText(lang === "en"
        ? "If you require two-step for staff, 2 of 7 staff members will lose their staff roles until they set up an authenticator app."
        : "Si exiges dos pasos al personal, 2 de 7 integrantes del personal perderán sus roles hasta que configuren una app de autenticación.")).toBeInTheDocument();
    }
  });

  it("lets an admin require all members without offering to disable staff two-step", async () => {
    const nextDesk = { ...desk, mfaPolicy: { ...desk.mfaPolicy, requireStaffMfa: true, requireMemberMfa: false } };
    const api = { loadDesk: vi.fn().mockResolvedValue(nextDesk), setMemberMfaPolicy: vi.fn().mockResolvedValue({ changed: true }) };
    renderEnglish(<AdminView data={{ member: { initials: "AR" }, rewardItems: [] }} api={api} onNotice={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "Require for all workers" }));
    await waitFor(() => expect(api.setMemberMfaPolicy).toHaveBeenCalledWith(true));
    expect(screen.queryByRole("button", { name: "Make optional", exact: true })).toBeNull();
    expect(screen.getByText(/This requirement cannot be turned off here/)).toBeInTheDocument();
    expect(api.loadDesk).toHaveBeenCalledTimes(2);
  });

  it.each([true, false])("attributes the member-policy audit to its actor (required=%s)", async (required) => {
    const nextDesk = { ...desk, audit: [{ id: "member-policy", action: "set_staff_mfa_policy", actorName: "Ana Rivera",
      targetName: null, detail: { requireStaffMfa: true, requireMemberMfa: required } }] };
    renderEnglish(<AdminView data={{ member: { initials: "AR" }, rewardItems: [] }} api={{ loadDesk: vi.fn().mockResolvedValue(nextDesk) }} onNotice={vi.fn()} />);
    expect(await screen.findByText(required ? "Ana Rivera required two-step sign-in for all workers" : "Ana Rivera made two-step optional for other workers")).toBeInTheDocument();
  });

  it("states the blast radius before enabling and reloads after the audited write", async () => {
    const api = {
      loadDesk: vi.fn().mockResolvedValue(desk),
      setStaffMfaPolicy: vi.fn().mockResolvedValue({ requireStaffMfa: true, changed: true }),
    };
    const onNotice = vi.fn();
    renderEnglish(<AdminView data={{ member: { initials: "AR" }, rewardItems: [] }} api={api} onNotice={onNotice} />);
    expect(await screen.findByText("If you require two-step for staff, 2 of 7 staff members will lose their staff roles until they set up an authenticator app.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Require for staff" }));
    await waitFor(() => expect(api.setStaffMfaPolicy).toHaveBeenCalledWith(true));
    await waitFor(() => expect(api.loadDesk).toHaveBeenCalledTimes(2));
    expect(onNotice).toHaveBeenCalledWith("Staff two-step sign-in is now required.");
    expect(screen.getByText("Ana Rivera required staff two-step sign-in")).toBeInTheDocument();
  });

  it("refuses to offer enable until the calling admin enrolls", async () => {
    const nextDesk = { ...desk, mfaPolicy: { ...desk.mfaPolicy, callerEnrolled: false } };
    renderEnglish(<AdminView data={{ member: { initials: "AR" } }} api={{ loadDesk: vi.fn().mockResolvedValue(nextDesk) }} onNotice={vi.fn()} />);
    expect(await screen.findByText("Set up your own authenticator app before requiring it for staff.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Require for staff" })).toBeDisabled();
  });

  it("tells a blocked staffer why the hats are paused and refreshes standing after enrollment", async () => {
    const client = mfaClient();
    const onStandingChanged = vi.fn().mockResolvedValue(undefined);
    renderEnglish(<MfaSettings
      client={client}
      staffMfa={{ required: true, holdsStaffRole: true, enrolled: false, blocked: true, suspendedRoles: ["steward"] }}
      onStandingChanged={onStandingChanged}
    />);
    expect(await screen.findByText(catalogue.en["mfa.staffRequiredBlocked"])).toBeInTheDocument();
    expect(screen.getByText(catalogue.en["mfa.appOnly"])).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Turn on two-step sign-in" }));
    await screen.findByText("Or type this code in by hand");
    fireEvent.change(screen.getByLabelText("Code from your app"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() => expect(onStandingChanged).toHaveBeenCalledTimes(1));
  });

  // BUG-UG-TWO-STEP-ON-BUT-STAFF-HATS-STILL-PAUSED-20261006.
  it("never says On and set-up-to-restore together, and clears the notice once standing refreshes", async () => {
    const blocked = { required: true, holdsStaffRole: true, enrolled: false, blocked: true, suspendedRoles: ["coordinator"] };
    const restored = { required: true, holdsStaffRole: true, enrolled: true, blocked: false, suspendedRoles: [] };
    let release;
    const onStandingChanged = vi.fn(() => new Promise((resolveRefresh) => { release = resolveRefresh; }));
    const client = mfaClient();
    const view = renderEnglish(<MfaSettings client={client} staffMfa={blocked} onStandingChanged={onStandingChanged} />);
    fireEvent.click(await screen.findByRole("button", { name: "Turn on two-step sign-in" }));
    await screen.findByText("Or type this code in by hand");
    fireEvent.change(screen.getByLabelText("Code from your app"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));

    // Verified, standing still stale while the shell refresh is in flight.
    expect(await screen.findByText("Restoring your staff roles…")).toBeInTheDocument();
    expect(screen.queryByText(/Set up an authenticator app to restore them/)).toBeNull();

    // The refresh resolved but the shell still hands over stale standing:
    // offer the same refresh again instead of telling the member to reload.
    release();
    const retry = await screen.findByRole("button", { name: "Restore my staff roles" });
    expect(screen.getByText("Your staff roles have not come back on this screen yet.")).toBeInTheDocument();
    fireEvent.click(retry);
    await waitFor(() => expect(onStandingChanged).toHaveBeenCalledTimes(2));
    release();

    // Fresh standing arrives: the paused notice is gone and the policy line shows.
    view.rerender(<LanguageProvider lang="en"><MfaSettings client={client} staffMfa={restored} onStandingChanged={onStandingChanged} /></LanguageProvider>);
    // The pause notice is gone and the screen confirms the roles are back
    // (REQ-UG-STAFF-ROLE-PAUSE-AND-RESTORE-CLARITY-20261030).
    await waitFor(() => expect(screen.queryByText(/have not come back|Restoring your staff roles/)).toBeNull());
    expect(screen.getByText("Your staff roles are back.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Restore my staff roles" })).toBeNull();
    expect(screen.getByText(catalogue.en["mfa.staffRequiredOn"])).toBeInTheDocument();
  });

  it("never shows the set-up sentence after a successful verify, even when the factor re-read fails", async () => {
    const blocked = { required: true, holdsStaffRole: true, enrolled: false, blocked: true, suspendedRoles: ["coordinator"] };
    const client = mfaClient({ factors: [[]] });
    let failRead;
    client.auth.mfa.listFactors.mockImplementationOnce(() => new Promise((_, reject) => { failRead = reject; }));
    renderEnglish(<MfaSettings client={client} staffMfa={blocked} onStandingChanged={vi.fn().mockResolvedValue(undefined)} />);
    fireEvent.click(await screen.findByRole("button", { name: "Turn on two-step sign-in" }));
    await screen.findByText("Or type this code in by hand");
    fireEvent.change(screen.getByLabelText("Code from your app"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    // While the factor re-read is still in flight.
    expect(await screen.findByText("On — you'll be asked for a code from your authenticator app.")).toBeInTheDocument();
    expect(screen.queryByText(/Set up an authenticator app to restore them/)).toBeNull();
    expect(screen.getByText("Restoring your staff roles…")).toBeInTheDocument();
    // The re-read fails: the verified outcome stands.
    failRead(new Error("network"));
    expect(await screen.findByRole("button", { name: "Restore my staff roles" })).toBeEnabled();
    expect(screen.queryByText(/Set up an authenticator app to restore them/)).toBeNull();
  });

  it("retires the restore panel and its button while two-step is being turned off", async () => {
    const blocked = { required: true, holdsStaffRole: true, enrolled: false, blocked: true, suspendedRoles: ["coordinator"] };
    const client = mfaClient({ factors: [[{ id: "totp-1", factor_type: "totp", status: "verified" }], []] });
    let finishUnenroll;
    client.auth.mfa.unenroll.mockImplementationOnce(() => new Promise((resolve) => { finishUnenroll = resolve; }));
    const onStandingChanged = vi.fn().mockResolvedValue(undefined);
    renderEnglish(<MfaSettings client={client} staffMfa={blocked} onStandingChanged={onStandingChanged} />);
    expect(await screen.findByRole("button", { name: "Restore my staff roles" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Turn off two-step sign-in" }));
    fireEvent.click(screen.getByRole("button", { name: "Turn it off" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Restore my staff roles" })).toBeNull());
    expect(screen.queryByText(/your staff roles have not come back/)).toBeNull();
    finishUnenroll({ error: null });
    await waitFor(() => expect(onStandingChanged).toHaveBeenCalledTimes(1));
  });

  it("ships every new policy sentence in English and Spanish", () => {
    for (const key of [
      "mfa.staffHatsRestoring", "mfa.staffHatsRestorePending", "mfa.staffHatsRestore",
      "mfa.appOnly", "mfa.staffRequiredBlocked", "mfa.staffRequiredOn",
      "admin.mfaPolicyTitle", "admin.mfaPolicyOn", "admin.mfaPolicyOff",
      "admin.mfaPolicySource", "admin.mfaPolicyRecommendation",
      "admin.mfaPolicyImpact", "admin.mfaPolicySelfFirst", "admin.mfaPolicyEnable",
      "admin.mfaPolicyDisable", "admin.mfaPolicyEnabled", "admin.mfaPolicyDisabled",
      "admin.mfaPolicyUnavailable", "admin.actionSetStaffMfaOn", "admin.actionSetStaffMfaOff",
    ]) {
      expect(catalogue.en[key], `missing en: ${key}`).toBeTruthy();
      expect(catalogue.es[key], `missing es: ${key}`).toBeTruthy();
    }
  });

  // Organizers see who signed cards, so
  // the staff two-step requirement covers them. The sentences that tell a
  // person which hats the policy pauses must name the Organizer hat too.
  it("names the Organizer hat among the staff hats the policy covers", () => {
    for (const key of ["mfa.staffRequiredBlocked", "mfa.staffRequiredOn"]) {
      expect(catalogue.en[key], key).toMatch(/\borganizer\b/i);
      expect(catalogue.es[key], key).toMatch(/\borganizador\/a\b/i);
      for (const hat of ["committee", "campaign lead", "advisor", "admin", "campaign chair"]) {
        expect(catalogue.en[key], `${key} ${hat}`).toContain(hat);
      }
    }
  });

  it("wires the live admin writer and post-enrollment member refresh", () => {
    const app = readFileSync(resolve(process.cwd(), "src/App.jsx"), "utf8");
    expect(app).toContain("setStaffMfaPolicy,");
    expect(app).toContain("setStaffMfaPolicy: (required) => setStaffMfaPolicy(sessionDataClient, required)");
    expect(app).toContain("onMfaChanged={handleMfaStandingChanged}");
  });
});
