import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MfaSettings } from "../src/components/MfaSettings.jsx";
import { SetupTwoStepNotice, TwoStepSettingsLink } from "../src/features/orgSetup/SetupTwoStepNotice.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

// BUG-UG-TWO-STEP-NOTICE-OPENS-SETTINGS-OVERVIEW-20261018: the
// two-step form renders only in the Settings security section, so the setup
// notice must open /m/settings/security, and an enrolled administrator is
// offered the way back to Admin.
const workspace = vi.hoisted(() => ({ current: null }));
vi.mock("../src/components/WorkspacePages.jsx", async (original) => ({
  ...await original(),
  useWorkspace: () => workspace.current,
}));

const blocked = { required: true, holdsStaffRole: true, enrolled: false, blocked: true, suspendedRoles: ["admin"] };
const restored = { required: true, holdsStaffRole: true, enrolled: true, blocked: false, suspendedRoles: [] };

function verifiedClient() {
  const verified = [{ id: "totp-1", factor_type: "totp", status: "verified" }];
  return {
    auth: {
      mfa: {
        listFactors: vi.fn().mockResolvedValue({ data: { all: verified, totp: verified }, error: null }),
        enroll: vi.fn(), challenge: vi.fn(), verify: vi.fn(), unenroll: vi.fn(),
      },
    },
  };
}

beforeEach(() => { workspace.current = null; });

describe("two-step setup links", () => {
  it("carries the explicit setup-review return through its plain draft-protected link", () => {
    const open = vi.fn();
    workspace.current = { open };
    const target = "/m/admin/setup-review?union=olms-900000077&build=chapter";
    render(<LanguageProvider lang="en"><TwoStepSettingsLink plain returnTo={target}>Open Settings</TwoStepSettingsLink></LanguageProvider>);
    const link = screen.getByRole("link", { name: "Open Settings" });
    const url = new URL(link.href);
    expect(url.pathname).toBe("/m/settings/security");
    expect(url.searchParams.get("setupReturnTo")).toBe(target);
    expect(fireEvent.click(link)).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it.each(["https://other.example/m/admin", "//other.example/m/admin", "/m/admin/../settings", "/m/admin?token=private"])("refuses an unsupported Admin return href %s", async (adminSetupPath) => {
    render(<LanguageProvider lang="en"><MfaSettings client={verifiedClient()} adminSetupPath={adminSetupPath} staffMfa={restored} /></LanguageProvider>);
    await screen.findByRole("button", { name: "Turn off two-step sign-in" });
    expect(screen.queryByRole("link", { name: "Continue to Admin setup" })).toBeNull();
  });

  it("targets the security section and opens it in the workspace without a page load", () => {
    const open = vi.fn();
    workspace.current = { open };
    render(<LanguageProvider lang="en"><SetupTwoStepNotice staffMfa={blocked} /></LanguageProvider>);
    const link = screen.getByRole("link", { name: "Open Settings" });
    expect(link).toHaveAttribute("href", "/m/settings/security");
    expect(fireEvent.click(link)).toBe(false);
    expect(open).toHaveBeenCalledWith("/m/settings/security", "settings");
  });

  it("leaves a new-tab or modified click to the browser", () => {
    const open = vi.fn();
    workspace.current = { open };
    render(<LanguageProvider lang="en"><SetupTwoStepNotice staffMfa={blocked} /></LanguageProvider>);
    expect(fireEvent.click(screen.getByRole("link", { name: "Open Settings" }), { ctrlKey: true })).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it("is a plain full-page link, never an in-place navigation, where unsaved work is on the page", () => {
    const open = vi.fn();
    workspace.current = { open };
    render(<LanguageProvider lang="en"><TwoStepSettingsLink plain>Open Settings</TwoStepSettingsLink></LanguageProvider>);
    const link = screen.getByRole("link", { name: "Open Settings" });
    expect(link).toHaveAttribute("href", "/m/settings/security");
    expect(link).not.toHaveAttribute("target");
    expect(fireEvent.click(link)).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it("leaves the plain link alone when no workspace is mounted", () => {
    render(<LanguageProvider lang="en"><SetupTwoStepNotice staffMfa={blocked} /></LanguageProvider>);
    expect(fireEvent.click(screen.getByRole("link", { name: "Open Settings" }))).toBe(true);
  });

  it("offers Continue to Admin setup only once the factor exists and the roles are back", async () => {
    const open = vi.fn();
    workspace.current = { open };
    const props = { client: verifiedClient(), adminSetupPath: "/m/admin" };
    const view = render(<LanguageProvider lang="en"><MfaSettings {...props} staffMfa={blocked} /></LanguageProvider>);
    await screen.findByText(/^On — /);
    expect(screen.queryByRole("link", { name: "Continue to Admin setup" })).toBeNull();
    view.rerender(<LanguageProvider lang="en"><MfaSettings {...props} staffMfa={restored} /></LanguageProvider>);
    const link = await screen.findByRole("link", { name: "Continue to Admin setup" });
    expect(link).toHaveAttribute("href", "/m/admin");
    expect(fireEvent.click(link)).toBe(false);
    expect(open).toHaveBeenCalledWith("/m/admin", "admin");
  });

  it("keeps the Admin link a plain link without a workspace", async () => {
    render(<LanguageProvider lang="en"><MfaSettings client={verifiedClient()} adminSetupPath="/m/admin" staffMfa={restored} /></LanguageProvider>);
    expect(fireEvent.click(await screen.findByRole("link", { name: "Continue to Admin setup" }))).toBe(true);
  });

  it("offers no Admin link to someone without the Admin hat", async () => {
    render(<LanguageProvider lang="en"><MfaSettings client={verifiedClient()} staffMfa={restored} /></LanguageProvider>);
    await screen.findByText(/Your organization requires two-step sign-in while you use a staff role/);
    expect(screen.queryByRole("link", { name: "Continue to Admin setup" })).toBeNull();
  });
});
