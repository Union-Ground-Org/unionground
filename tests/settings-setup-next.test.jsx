// UX-UG-ADMIN-NOT-TOLD-ONBOARDING-NEEDS-CHECKLIST-20261018: a new
// organization's creator lands on Settings (?next=setup-review) to turn on
// two-step sign-in, and is offered Admin > Start setup once it is on.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsView } from "../src/views/SettingsView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

const ENROLLED = { required: true, holdsStaffRole: true, enrolled: true, blocked: false, suspendedRoles: [] };

function renderSettings({ search = "?next=setup-review", roles = ["admin"], staffMfa = ENROLLED, onNavigate = vi.fn(), lang = "en" } = {}) {
  window.history.replaceState({}, "", `/m/settings${search}`);
  render(
    <LanguageProvider lang={lang}>
      <SettingsView data={{ member: { initials: "AR" }, roles, staffMfa, organizationConfiguration: null }} lang={lang} onLanguage={vi.fn()} onNavigate={onNavigate} />
    </LanguageProvider>,
  );
  return { onNavigate };
}

afterEach(() => { window.history.replaceState({}, "", "/"); });

describe("Settings after creating an organization", () => {
  it("offers the setup page once two-step sign-in is on and the admin role is back", () => {
    const { onNavigate } = renderSettings();
    expect(screen.getByRole("heading", { name: "Next: set up your organization" })).toBeTruthy();
    const link = screen.getByRole("link", { name: "Start setup" });
    expect(link.getAttribute("href")).toBe("/m/admin/setup-review");
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledWith("admin", "/m/admin/setup-review");
  });

  it("says it in Spanish too", () => {
    renderSettings({ lang: "es" });
    expect(screen.getByRole("heading", { name: "Siguiente: configura tu organización" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Empezar la configuración" })).toBeTruthy();
  });

  it("waits while two-step sign-in is off or still blocking, and stays away from ordinary Settings visits", () => {
    for (const options of [
      { staffMfa: { ...ENROLLED, enrolled: false, blocked: true }, roles: [] },
      { staffMfa: { ...ENROLLED, blocked: true } },
      { staffMfa: null },
      { roles: ["steward"] },
      { search: "" },
    ]) {
      cleanup();
      renderSettings(options);
      expect(screen.queryByRole("heading", { name: "Next: set up your organization" })).toBeNull();
    }
  });

  it("lets a modified click open the link normally", () => {
    const { onNavigate } = renderSettings();
    fireEvent.click(screen.getByRole("link", { name: "Start setup" }), { metaKey: true });
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("sends the creator of a new organization to Settings with the follow-up marker", () => {
    const app = readFileSync(resolve("src/App.jsx"), "utf8");
    // #7670: the follow-up marker comes from createdOrganizationNextHref, which a
    // picked campaign extends with its local (tests/create-organization-union-picker.test.jsx).
    expect(app).toContain("onCreated={(_result, placement) => { window.location.assign(createdOrganizationNextHref(placement)); }}");
  });
});
