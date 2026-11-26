// #9595 unit 5 (D1-19): Settings, Worker tools promised "a real person ...
// answers, usually within the hour" and its Message a committee member button opened
// an empty inbox, even when no steward was named for the reader. The panel now
// reads the same shared answer (stewardPresence) as the other member pages:
// with none, no-chapter or only-self it says who is missing, and an
// administrator who can open the admin desk is pointed at setup instead.
// Named, paused and unknown keep what Main said.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SettingsView } from "../src/views/SettingsView.jsx";
import { explicitHatAllowsView } from "../src/App.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

const NO_STEWARD = ["none", "no-chapter", "only-self"];
const KEEPS_MAIN = ["named", "paused", "unknown", null];

function hub({ presence, roles = [], hat = null, lang = "en", guard, memberHatOpensHeldPlanes = false }) {
  const onNavigate = vi.fn();
  const canNavigateView = guard ?? (hat ? (view, path) => explicitHatAllowsView(hat, view, false, roles, true, path) : null);
  const { container } = render(
    <LanguageProvider lang={lang}>
      <SettingsView
        data={{ member: { initials: "IC" }, roles }}
        lang={lang}
        stewardPresence={presence}
        onNavigate={onNavigate}
        canNavigateView={canNavigateView}
        memberHatOpensHeldPlanes={memberHatOpensHeldPlanes}
        onAssistant={vi.fn()}
        onProfile={vi.fn()}
      />
    </LanguageProvider>,
  );
  const cta = container.querySelector(".morehub-cta");
  return { onNavigate, cta };
}

describe("Settings, Worker tools with no steward named (#9595 D1-19)", () => {
  it.each(NO_STEWARD)("promises no reply and opens no inbox for a member when %s", (presence) => {
    const { cta } = hub({ presence });
    expect(within(cta).queryByRole("button")).toBeNull();
    expect(cta).not.toHaveTextContent(/within the hour/);
    expect(cta).not.toHaveTextContent(/real person/);
    expect(cta).toHaveAttribute("data-no-steward", presence);
  });

  it("says who is missing and who can name one, by state", () => {
    let { cta } = hub({ presence: "none" });
    expect(cta).toHaveTextContent("No committee member is named for your campaign yet.");
    expect(cta).toHaveTextContent("Your campaign administrator can name a committee member.");
    document.body.innerHTML = "";
    ({ cta } = hub({ presence: "no-chapter" }));
    expect(cta).toHaveTextContent("No committee member is named for you yet.");
    expect(cta).toHaveTextContent("Your organization's administrator can name a committee member.");
    document.body.innerHTML = "";
    ({ cta } = hub({ presence: "only-self", roles: ["committee member"] }));
    expect(cta).toHaveTextContent("No other committee member is named for your campaign to contact.");
    expect(cta).toHaveTextContent("Your campaign administrator can name another committee member.");
  });

  it("points an administrator with no chapter to chapter setup", () => {
    const { cta, onNavigate } = hub({ presence: "no-chapter", roles: ["admin"], hat: "admin" });
    expect(cta).toHaveTextContent("You hold the administrator role, so you can name one in setup.");
    fireEvent.click(within(cta).getByRole("button", { name: "Set up campaigns and committee members" }));
    expect(onNavigate).toHaveBeenCalledWith("admin", "/m/admin/setup-review");
  });

  it.each(["none", "only-self"])("points an administrator in a chapter to Roles & access when %s", (presence) => {
    const { cta, onNavigate } = hub({ presence, roles: ["admin", "committee member"], hat: "admin" });
    fireEvent.click(within(cta).getByRole("button", { name: "Name a committee member" }));
    expect(onNavigate).toHaveBeenCalledWith("admin", "/m/admin/access");
  });

  it("offers the setup step under the Member hat only where the shell lets that hat open the admin desk", () => {
    const refuseAdmin = (view) => view !== "admin";
    let { cta } = hub({ presence: "none", roles: ["admin"], guard: refuseAdmin });
    expect(within(cta).queryByRole("button")).toBeNull();
    expect(cta).toHaveTextContent("Your campaign administrator can name a committee member.");
    document.body.innerHTML = "";
    ({ cta } = hub({ presence: "none", roles: ["admin"], guard: refuseAdmin, memberHatOpensHeldPlanes: true }));
    expect(within(cta).getByRole("button", { name: "Name a committee member" })).toBeInTheDocument();
  });

  // Sol read of 19af1b3e, P3: with no guard passed at all (a mount that gives
  // none), the step follows the page's existing admin link (adminDeskOpens):
  // offered to a reader with the administrator role, as that link is.
  it("follows the page's existing admin link when no guard is passed", () => {
    const { cta, onNavigate } = hub({ presence: "none", roles: ["admin"] });
    fireEvent.click(within(cta).getByRole("button", { name: "Name a committee member" }));
    expect(onNavigate).toHaveBeenCalledWith("admin", "/m/admin/access");
    const source = readFileSync(resolve(process.cwd(), "src/views/SettingsView.jsx"), "utf8");
    expect(source).toContain("const adminLinkAllowed = adminDeskOpens(adminSetupPath);");
    expect(source).toContain("&& adminDeskOpens(nameStewardPath);");
  });

  it("never offers the setup step to a reader without the administrator role", () => {
    const { cta } = hub({ presence: "no-chapter", roles: ["committee member"], guard: () => true, memberHatOpensHeldPlanes: true });
    expect(within(cta).queryByRole("button")).toBeNull();
  });

  it("speaks Spanish too", () => {
    let { cta } = hub({ presence: "none", lang: "es" });
    expect(cta).toHaveTextContent("Todavía no hay un miembro del comité nombrado para tu campaña.");
    expect(cta).not.toHaveTextContent(/menos de una hora/);
    document.body.innerHTML = "";
    ({ cta } = hub({ presence: "no-chapter", roles: ["admin"], hat: "admin", lang: "es" }));
    expect(within(cta).getByRole("button", { name: "Configurar campañas y miembros del comité" })).toBeInTheDocument();
  });
});

describe("Settings, Worker tools when a steward may answer (#9595 keeps Main)", () => {
  it.each(KEEPS_MAIN)("keeps the promise and Message a committee member when %s", (presence) => {
    const { cta, onNavigate } = hub({ presence, roles: ["admin"], hat: "admin" });
    expect(cta).toHaveTextContent(/usually within the hour/);
    expect(cta).not.toHaveAttribute("data-no-steward");
    fireEvent.click(within(cta).getByRole("button", { name: "Message a committee member" }));
    expect(onNavigate).toHaveBeenCalledWith("messages", "/m/messages");
  });

  it("is wired to the shell's one answer at the mount", () => {
    const app = readFileSync(resolve(process.cwd(), "src/App.jsx"), "utf8");
    const mount = app.split("\n").find((line) => line.includes("settings: <SettingsView"));
    expect(mount).toContain("stewardPresence={memberStewardPresence}");
  });
});
