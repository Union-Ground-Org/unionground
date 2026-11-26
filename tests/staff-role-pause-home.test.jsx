// REQ-UG-STAFF-ROLE-PAUSE-AND-RESTORE-CLARITY-20261030, finding 2:
// Home named a staff office ("Admin · Member") while that office was paused
// for two-step sign-in, so staff could not tell why their tools were missing.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TodayView } from "../src/views/TodayView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";

function homeData(staffMfa) {
  const data = structuredClone(fallbackData);
  data.member = { ...data.member, organizationRoles: ["admin"], chapterRoles: [] };
  data.roles = [];
  data.staffMfa = staffMfa;
  return data;
}

const paused = { required: true, holdsStaffRole: true, enrolled: false, blocked: true, suspendedRoles: ["admin"] };

afterEach(cleanup);

describe("Home while staff roles are paused for two-step sign-in", () => {
  it.each([false, true])("marks the office paused and links to the Security setup (desktop %s)", (desktop) => {
    render(<LanguageProvider lang="en"><TodayView data={homeData(paused)} desktop={desktop} /></LanguageProvider>);
    expect(screen.getByText(/Admin \(paused\) · /)).toBeInTheDocument();
    expect(screen.queryByText(/Admin · /)).toBeNull();
    const note = screen.getByText(/Your staff roles are paused until you turn on two-step sign-in/);
    expect(note).toHaveAttribute("role", "status");
    expect(screen.getByRole("link", { name: "Turn on two-step sign-in" })).toHaveAttribute("href", expect.stringContaining("/m/settings/security"));
  });


  it("names an active office plainly once two-step is satisfied", () => {
    render(<LanguageProvider lang="en"><TodayView data={homeData({ ...paused, enrolled: true, blocked: false, suspendedRoles: [] })} /></LanguageProvider>);
    expect(screen.queryByText(/\(paused\)/)).toBeNull();
    expect(screen.queryByText(/Your staff roles are paused/)).toBeNull();
  });
});

describe("Security after a reload with two-step on and staff roles still paused", () => {
  it("asks for the staff standing once on its own and keeps the Restore control", async () => {
    const { MfaSettings } = await import("../src/components/MfaSettings.jsx");
    const { waitFor } = await import("@testing-library/react");
    const verifiedFactor = { id: "f1", factor_type: "totp", status: "verified", friendly_name: "Phone" };
    const client = {
      auth: {
        mfa: {
          listFactors: async () => ({ data: { all: [verifiedFactor], totp: [verifiedFactor] }, error: null }),
          getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: "aal2", nextLevel: "aal2" }, error: null }),
        },
      },
      rpc: async () => ({ data: null, error: { code: "PGRST202", message: "missing" } }),
    };
    let release;
    const onStandingChanged = vi.fn(() => new Promise((resolve) => { release = resolve; }));
    render(<LanguageProvider lang="en"><MfaSettings client={client} staffMfa={paused} onStandingChanged={onStandingChanged} /></LanguageProvider>);
    await waitFor(() => expect(onStandingChanged).toHaveBeenCalledTimes(1));
    release();
    expect(await screen.findByRole("button", { name: "Restore my staff roles" })).toBeEnabled();
    expect(onStandingChanged).toHaveBeenCalledTimes(1);
  });
});

// Finding 25: the invite form's "Starting access" choice says what each role
// is, and that Administrator is an app role, not a union office.
describe("invite form starting access help", () => {
  it("has an English and Spanish line for every starting access", async () => {
    const { catalogue } = await import("../src/lib/i18n.js");
    const { chapterAccessCatalogue } = await import("../src/lib/i18n/chapterAccess.js");
    const copy = Object.fromEntries(["en", "es"].map((lang) => [lang, { ...catalogue[lang], ...chapterAccessCatalogue[lang] }]));
    for (const role of ["member", "steward", "coordinator", "advisor", "admin", "vp", "secretary", "records"]) {
      for (const lang of ["en", "es"]) {
        expect(copy[lang][`admin.inviteRoleHelp.${role}`], `${lang} ${role}`).toEqual(expect.any(String));
      }
    }
    expect(copy.en["admin.inviteRoleHelp.admin"]).toContain("not a union office");
    expect(copy.es["admin.inviteRoleHelp.admin"]).toContain("no un cargo sindical");
    expect(catalogue.en["admin.inviteRoleHelpGeneral"]).toContain("two-step sign-in");
  });
});

describe("desktop rail while staff roles are paused", () => {
  it("says the roles are paused and opens the Security setup", async () => {
    const { DesktopRail } = await import("../src/components/DesktopRail.jsx");
    const { fireEvent } = await import("@testing-library/react");
    const onNavigate = vi.fn();
    render(<LanguageProvider lang="en"><DesktopRail renderMode="desktop" active="today" onNavigate={onNavigate} onAsk={() => {}} staffRolesPaused /></LanguageProvider>);
    const link = screen.getByRole("link", { name: "Staff roles paused: turn on two-step sign-in" });
    expect(link).toHaveAttribute("href", "/m/settings/security");
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledWith("settings", "/m/settings/security", "");
  });

  it("shows nothing when roles are not paused", async () => {
    const { DesktopRail } = await import("../src/components/DesktopRail.jsx");
    render(<LanguageProvider lang="en"><DesktopRail renderMode="desktop" active="today" onNavigate={() => {}} onAsk={() => {}} /></LanguageProvider>);
    expect(screen.queryByText(/Staff roles paused/)).toBeNull();
  });
});
