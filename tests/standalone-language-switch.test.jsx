// UX-UG-STANDALONE-PAGES-NO-LANGUAGE-SWITCH-20261018: the invitation,
// reset, request-invite and get-app pages offer the sign-in card's
// English/Español switch, remember the choice like the sign-in card does. The
// pages with the site header carry the switch inside that header instead
// (#9539; tests/public-site-language-switch.test.jsx).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LANGUAGE_SWITCH_STANDALONE_PATHS, StandaloneLanguageShell } from "../src/components/StandaloneLanguageShell.jsx";
import { RequestInviteView } from "../src/views/RequestInviteView.jsx";
import { InvitationAcceptView } from "../src/views/InvitationAcceptView.jsx";

beforeEach(() => { localStorage.clear(); });
afterEach(() => { localStorage.clear(); document.documentElement.lang = ""; });

describe("standalone page language switch", () => {
  it("switches the request-invite page to Spanish and back, and remembers the choice", async () => {
    render(<StandaloneLanguageShell languageSwitch><RequestInviteView fetcher={vi.fn()} /></StandaloneLanguageShell>);
    const group = screen.getByRole("group", { name: "Language" });
    expect(screen.getByRole("heading", { level: 1, name: "Request an invite" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "English" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Español" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Pide una invitación" })).toBeInTheDocument();
    await waitFor(() => expect(document.documentElement.lang).toBe("es"));
    expect(localStorage.getItem("sg-lang")).toBe("es");
    expect(screen.getByRole("group", { name: "Idioma" })).toBe(group);
    expect(screen.getByRole("button", { name: "Español" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "English" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Request an invite" })).toBeInTheDocument();
    expect(localStorage.getItem("sg-lang")).toBe("en");
  });

  // BUG-UG-STANDALONE-LANGUAGE-TOUCH-TARGET-20261025: the shared
  // .segment button rule gives 44px; the standalone bar's own rule must win.
  it("gives both standalone language buttons a 48px minimum touch target over the 44px segment default", () => {
    const css = readFileSync(resolve("src/styles.css"), "utf8");
    const rule = selector => css.split("\n").find(line => line.startsWith(`${selector} {`));
    const segment = rule(".segment button");
    const standalone = rule(".standalone-language-bar .auth-language button");
    expect(segment).toContain("min-height: 44px");
    expect(standalone).toBe(".standalone-language-bar .auth-language button { min-height: 48px; }");
    const style = document.createElement("style");
    style.textContent = `${segment}\n${standalone}`;
    document.head.append(style);
    try {
      render(<StandaloneLanguageShell languageSwitch><RequestInviteView fetcher={vi.fn()} /></StandaloneLanguageShell>);
      for (const name of ["English", "Español"]) {
        const button = screen.getByRole("button", { name });
        expect(button.closest(".standalone-language-bar .auth-language")).not.toBeNull();
        expect(getComputedStyle(button).minHeight).toBe("48px");
      }
    } finally { style.remove(); }
  });

  // BUG-UG-STANDALONE-LANGUAGE-PILL-UNFINISHED-20261106: the bar's
  // look matches the landing toggle (outline track, gold current half), only
  // inside the standalone shell; the sign-in card's switch keeps its own rules.
  it("styles the standalone bar like the landing toggle without touching the sign-in card's switch", () => {
    const css = readFileSync(resolve("src/styles.css"), "utf8");
    const rule = selector => css.split("\n").find(line => line.startsWith(`${selector} {`));
    expect(rule(".standalone-shell > .standalone-language-bar")).toContain("width: min(100%, 512px)");
    expect(rule(".standalone-shell > .standalone-language-bar .auth-language")).toContain("border: 1px solid var(--border)");
    expect(rule(".standalone-shell > .standalone-language-bar .auth-language button[aria-pressed=\"true\"]")).toContain("background: var(--gold)");
    expect(css.split("\n").filter(line => line.startsWith(".auth-language") && !line.includes("standalone"))).toEqual([".auth-language button { padding: 7px 10px; font-size: 12px; }", ".auth-language {"]);
  });

  it("switches the invitation page copy to Spanish", async () => {
    render(<StandaloneLanguageShell languageSwitch><InvitationAcceptView fetcher={vi.fn()} /></StandaloneLanguageShell>);
    const before = screen.getByRole("heading", { level: 1 }).textContent;
    fireEvent.click(screen.getByRole("button", { name: "Español" }));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 }).textContent).not.toBe(before));
    expect(document.documentElement.lang).toBe("es");
  });

  it("starts from a remembered Spanish choice", async () => {
    localStorage.setItem("sg-lang", "es");
    render(<StandaloneLanguageShell languageSwitch><RequestInviteView fetcher={vi.fn()} /></StandaloneLanguageShell>);
    expect(await screen.findByRole("heading", { level: 1, name: "Pide una invitación" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Español" })).toHaveAttribute("aria-pressed", "true");
  });

  it("renders no switch for pages that keep the boot language", () => {
    render(<StandaloneLanguageShell><RequestInviteView fetcher={vi.fn()} /></StandaloneLanguageShell>);
    expect(screen.queryByRole("group", { name: "Language" })).toBeNull();
    expect(document.querySelector(".standalone-language-bar")).toBeNull();
  });

  // Free pilot and Ask your union left the bar for the toggle in their site
  // header (#9539 C-3; tests/public-site-language-switch.test.jsx).
  it("covers exactly the invitation, reset, request-invite and get-app paths in App", () => {
    expect([...LANGUAGE_SWITCH_STANDALONE_PATHS]).toEqual(["/invite", "/app/invite", "/reset-password", "/app/reset-password", "/get-app", "/request-invite"]);
    const app = readFileSync(resolve("src/AppRouter.jsx"), "utf8");
    expect(app).toContain("const standaloneLanguageSwitch = LANGUAGE_SWITCH_STANDALONE_PATHS.includes(normalizeAppPath(pathname));");
    expect(app).toContain("<StandaloneLanguageShell languageSwitch={standaloneLanguageSwitch} loadBootLanguage={standaloneBootLanguage}>");
    expect(app).not.toMatch(/"\/join"[^\n]*LANGUAGE_SWITCH/);
  });
});
