import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/App.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { primeDemoData } from "../src/data/demoData.js";
import { AdminView } from "../src/views/AdminView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { primeDemoHat } from "./helpers/demoHat.js";
import { choosePage, findPageMenuTrigger } from "./helpers/workspacePageMenu.js";
import {
  attestCompassAiProvider,
  loadAdminDesk,
  setCompassAiEnabled,
  setCompassAiRoleLimit,
} from "../src/lib/memberApi.js";

const roles = ["member", "steward", "coordinator", "advisor", "admin", "vp"];
const governance = {
  enabled: false,
  gateway: "union-ground-mesh",
  model: "union-ground/compass-mesh:v1",
  requiredZeroDataRetention: true,
  requiredDisallowPromptTraining: true,
  attestationReady: false,
  latestAttestation: null,
  roleLimits: roles.map((role) => ({ role, hourlyLimit: 20 })),
  attestations: [],
};
const desk = {
  roster: [],
  events: [],
  audit: [],
  rewardQueue: [],
  mfa: { enrolledMembers: 1, staff: [] },
  mfaPolicy: { requireStaffMfa: true, staffTotal: 1, staffEnrolled: 1, callerEnrolled: true },
  compassAiGovernance: governance,
};

function wrap(api, lang = "en") {
  return render(
    <LanguageProvider lang={lang}>
      <AdminView
        data={{ member: { initials: "AR" } }}
        api={api}
        onNotice={vi.fn()}
      />
    </LanguageProvider>,
  );
}

function deskClient(compassResult = { data: governance, error: null }, platformResult = { data: { canManage: true }, error: null }) {
  return {
    rpc: vi.fn(async (name) => {
      if (name === "get_compass_platform_ai") return platformResult;
      if (name === "get_staff_roster") return { data: [], error: null };
      if (name === "get_admin_events") return { data: [], error: null };
      if (name === "get_admin_audit") return { data: [], error: null };
      if (name === "get_admin_mfa_status") return { data: { enrolledMembers: 1, staff: [] }, error: null };
      if (name === "get_admin_reward_queue") return { data: [], error: null };
      if (name === "get_staff_mfa_policy") return { data: { requireStaffMfa: true, staffTotal: 1, staffEnrolled: 1, callerEnrolled: true }, error: null };
      if (name === "get_admin_governance_requests") return { data: [], error: null };
      if (name === "list_vp_case_reviews") return { data: [], error: null };
      if (name === "get_compass_ai_governance") return compassResult;
      if (name === "get_member_invitations") return { data: { chapter: null, items: [] }, error: null };
      if (name === "get_admin_member_directory") return { data: { items: [], nextCursor: null }, error: null };
      if (name === "get_admin_org_structure") return { data: { scope: "chapter", chapters: [] }, error: null };
      if (name === "get_admin_organization_configuration") return { data: null, error: null };
      if (name === "list_failed_login_operations_inbox") return { data: null, error: null };
      if (name === "get_organization_retention_engine") return { data: null, error: { message: "optional unavailable" } };
      throw new Error(`unexpected RPC ${name}`);
    }),
  };
}

describe("Compass governance member API", () => {
  it("maps the governance read independently and preserves unavailable as null", async () => {
    const loaded = await loadAdminDesk(deskClient());
    expect(loaded.compassAiGovernance).toMatchObject({
      enabled: false,
      gateway: "union-ground-mesh",
      model: "union-ground/compass-mesh:v1",
      requiredZeroDataRetention: true,
      requiredDisallowPromptTraining: true,
      attestationReady: false,
      roleLimits: roles.map((role) => ({ role, hourlyLimit: 20 })),
    });

    const unavailable = await loadAdminDesk(deskClient({ data: null, error: { message: "function unavailable" } }));
    expect(unavailable.compassAiGovernance).toBeNull();
  });

  // BUG-UG-ADMIN-PAGES-FIRE-REFUSED-COMPASS-GOVERNANCE-READ-20261006:
  // every organization admin's desk load sent the operator-only read and got
  // a 403. Only a verified platform operator (canManage) sends it now.
  it.each([
    ["an organization admin", { data: { canManage: false }, error: null }],
    ["an older probe without canManage", { data: { enabled: true }, error: null }],
  ])("never sends the operator-only governance read for %s", async (_label, platformResult) => {
    const client = deskClient(undefined, platformResult);
    const loaded = await loadAdminDesk(client);
    const names = client.rpc.mock.calls.map(([name]) => name);
    expect(names).toContain("get_compass_platform_ai");
    expect(names).not.toContain("get_compass_ai_governance");
    expect(loaded.compassAiGovernance).toBeNull();
    expect(loaded.roster).toEqual([]);
  });

  it("keeps the governance read for a verified platform operator", async () => {
    const client = deskClient();
    const loaded = await loadAdminDesk(client);
    expect(client.rpc.mock.calls.map(([name]) => name)).toContain("get_compass_ai_governance");
    expect(loaded.compassAiGovernance).toMatchObject({ gateway: "union-ground-mesh" });
  });

  it("still fails the desk when the operator probe finds the session gone", async () => {
    const client = deskClient(undefined, { data: null, error: { code: "PGRST301", message: "JWT expired" } });
    await expect(loadAdminDesk(client)).rejects.toMatchObject({ code: "PGRST301" });
    expect(client.rpc.mock.calls.map(([name]) => name)).not.toContain("get_compass_ai_governance");
  });

  it("rejects malformed or policy-downgraded governance reads instead of rendering them as paused", async () => {
    for (const malformed of [
      { ...governance, requiredZeroDataRetention: false },
      { ...governance, requiredDisallowPromptTraining: null },
      { ...governance, roleLimits: governance.roleLimits.slice(1) },
      { ...governance, gateway: "" },
    ]) {
      const loaded = await loadAdminDesk(deskClient({ data: malformed, error: null }));
      expect(loaded.compassAiGovernance).toBeNull();
    }
  });

  it("sends exact bounded mutation payloads and surfaces refusals", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { changed: true }, error: null });
    await setCompassAiEnabled({ rpc }, true);
    await setCompassAiRoleLimit({ rpc }, "steward", 7);
    await attestCompassAiProvider({ rpc }, {
      evidenceRef: "Vercel contract review TKT-509",
      expiresAt: "2026-09-01T16:00:00.000Z",
      confirmZeroDataRetention: true,
      confirmDisallowPromptTraining: true,
      status: "verified",
    });
    expect(rpc.mock.calls).toEqual([
      ["set_compass_ai_enabled", { p_enabled: true }],
      ["set_compass_ai_role_limit", { p_role: "steward", p_hourly_limit: 7 }],
      ["attest_compass_ai_provider", {
        p_evidence_ref: "Vercel contract review TKT-509",
        p_expires_at: "2026-09-01T16:00:00.000Z",
        p_confirm_zero_data_retention: true,
        p_confirm_disallow_prompt_training: true,
        p_status: "verified",
      }],
    ]);

    await expect(setCompassAiEnabled({ rpc: vi.fn().mockResolvedValue({ data: null, error: { code: "42501", message: "MFA required" } }) }, false))
      .rejects.toMatchObject({ code: "42501" });
  });
});

describe("Compass governance admin UI", () => {
  it("renders the governance card from an explicitly injected unit fixture under Strict Mode", async () => {
    primeDemoData(fallbackData);
    primeDemoHat("member");
    window.history.replaceState({}, "", "/m?demo=1");
    try {
      render(<StrictMode><App /></StrictMode>);
      // Strict Mode bootstraps the lazy App before exposing the picker;
      // leave scheduling headroom on loaded runners without skipping it.
      fireEvent.change(await screen.findByRole("combobox", { name: "Switch role" }, { timeout: 15_000 }), { target: { value: "admin" } });
      choosePage(await findPageMenuTrigger(), "/m/admin/compass-governance");
      expect(await screen.findByRole("heading", { name: "Guide AI governance" }, { timeout: 8_000 })).toBeInTheDocument();
      expect(screen.getByText(/PREVIEW — these controls and attestations/)).toBeInTheDocument();
    } finally {
      primeDemoData(fallbackData);
    }
  });

  it("renders an honest unavailable state without an enabled-looking switch", async () => {
    wrap({ loadDesk: vi.fn().mockResolvedValue({ ...desk, compassAiGovernance: null }) });
    expect(await screen.findByRole("heading", { name: "Guide AI governance" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Compass/ })).not.toBeInTheDocument();
    expect(screen.getByText(catalogue.en["admin.compassGovernanceUnavailable"])).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enable the Guide" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Enable Compass/ })).not.toBeInTheDocument();
  });

  it("shows paused/unattested state, six labelled limits, and refuses enablement", async () => {
    wrap({ loadDesk: vi.fn().mockResolvedValue(desk) });
    expect(await screen.findByText("Paused — a current owner/admin attestation is required before the Guide can be enabled.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Enable the Guide" })).toBeDisabled();
    for (const label of ["Worker", "Committee", "Campaign lead", "Advisor", "Admin", "Campaign chair"]) {
      expect(screen.getByRole("spinbutton", { name: `${label} hourly limit` })).toHaveAttribute("min", "0");
      expect(screen.getByRole("spinbutton", { name: `${label} hourly limit` })).toHaveAttribute("max", "200");
    }
    expect(screen.queryByRole("spinbutton", { name: "President hourly limit" })).not.toBeInTheDocument();
  });

  it("pauses an enabled policy through the audited API and reloads", async () => {
    const ready = {
      ...governance,
      enabled: true,
      attestationReady: true,
      latestAttestation: { id: "att-1", status: "verified", evidenceRef: "TKT-509", expiresAt: "2026-09-01T16:00:00Z", attestedBy: "admin-1", createdAt: "2026-08-12T12:00:00Z" },
    };
    const api = {
      loadDesk: vi.fn().mockResolvedValue({ ...desk, compassAiGovernance: ready }),
      setCompassAiEnabled: vi.fn().mockResolvedValue({ changed: true }),
    };
    wrap(api);
    fireEvent.click(await screen.findByRole("button", { name: "Pause the Guide" }));
    await waitFor(() => expect(api.setCompassAiEnabled).toHaveBeenCalledWith(false));
    await waitFor(() => expect(api.loadDesk).toHaveBeenCalledTimes(2));
  });

  it("saves a labelled role limit and creates an attestation only after both confirmations", async () => {
    const api = {
      loadDesk: vi.fn().mockResolvedValue(desk),
      setCompassAiRoleLimit: vi.fn().mockResolvedValue({ changed: true }),
      attestCompassAiProvider: vi.fn().mockResolvedValue({ id: "att-1" }),
    };
    wrap(api);

    const memberLimit = await screen.findByRole("spinbutton", { name: "Worker hourly limit" });
    fireEvent.change(memberLimit, { target: { value: "8" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Worker limit" }));
    await waitFor(() => expect(api.setCompassAiRoleLimit).toHaveBeenCalledWith("member", 8));
    // The save holds the card busy until it settles; the attestation checks below are about the confirmations, not the save.
    await waitFor(() => expect(screen.getByRole("button", { name: "Save Worker limit" })).toBeEnabled());

    fireEvent.change(screen.getByRole("textbox", { name: "Evidence reference" }), { target: { value: "Vercel contract review TKT-509" } });
    fireEvent.change(screen.getByLabelText("Attestation expires"), { target: { value: "2026-09-01T12:00" } });
    const create = screen.getByRole("button", { name: "Create owner/admin attestation" });
    expect(create).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "I verified zero-data-retention coverage for the exact provider route and model above." }));
    expect(create).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "I verified that this provider path cannot train on worker prompts." }));
    expect(create).toBeEnabled();
    fireEvent.click(create);
    await waitFor(() => expect(api.attestCompassAiProvider).toHaveBeenCalledWith(expect.objectContaining({
      evidenceRef: "Vercel contract review TKT-509",
      confirmZeroDataRetention: true,
      confirmDisallowPromptTraining: true,
      status: "verified",
    })));
  });

  it("ships every governance sentence in English and Spanish", () => {
    for (const key of [
      "admin.compassGovernanceTitle", "admin.compassGovernanceSub", "admin.compassGovernanceUnavailable",
      "admin.compassPausedUnattested", "admin.compassPausedReady", "admin.compassEnabled",
      "admin.compassEnable", "admin.compassPause", "admin.compassRoleLimit",
      "admin.compassEvidence", "admin.compassExpiry", "admin.compassConfirmZdr",
      "admin.compassConfirmTraining", "admin.compassAttest", "admin.compassAttestationTitle",
    ]) {
      expect(catalogue.en[key], `missing en: ${key}`).toBeTruthy();
      expect(catalogue.es[key], `missing es: ${key}`).toBeTruthy();
    }
  });
});
