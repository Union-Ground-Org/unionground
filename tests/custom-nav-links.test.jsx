// REQ-UG-CUSTOM-NAV-LINKS-20261001: the organization's two admin-set links
// render in the web rail and the phone menu only with a label and an https://
// address, open in a new tab without an opener, and the admin page refuses
// any other address before the database does.
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopRail } from "../src/components/DesktopRail.jsx";
import { MobileCardNav } from "../src/components/MobileCardNav.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";
import { customNavLinkSettingValid, customNavLinks, isAllowedCustomLinkUrl } from "../src/lib/customNavLinks.js";
import { validValue } from "../src/lib/organizationSettingsAdmin.js";

afterEach(cleanup);

const configuration = (values) => ({ switches: {
  "text.navigation.custom_link_1_label": "", "text.navigation.custom_link_1_url": "",
  "text.navigation.custom_link_2_label": "", "text.navigation.custom_link_2_url": "",
  ...values,
} });

describe("custom navigation link rules", () => {
  it("accepts only https addresses without credentials", () => {
    for (const ok of ["https://example.org", "https://example.org/contracts?year=2026#a-12", "https://sub.example.org:8443/x"]) {
      expect(isAllowedCustomLinkUrl(ok), ok).toBe(true);
    }
    for (const bad of [
      "", "javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,x", "http://example.org", "//example.org",
      "example.org", "https://user:secret@example.org", "https://example.org/a b", "https://example.org/\"x", `https://example.org/${"a".repeat(240)}`,
    ]) expect(isAllowedCustomLinkUrl(bad), bad).toBe(false);
  });

  it("renders a slot only with both a label and an allowed address", () => {
    expect(customNavLinks(configuration({}))).toEqual([]);
    expect(customNavLinks(configuration({ "text.navigation.custom_link_1_label": "Library" }))).toEqual([]);
    expect(customNavLinks(configuration({ "text.navigation.custom_link_1_label": "Library", "text.navigation.custom_link_1_url": "javascript:alert(1)" }))).toEqual([]);
    expect(customNavLinks(configuration({
      "text.navigation.custom_link_1_label": "Library", "text.navigation.custom_link_1_url": "https://example.org/library",
      "text.navigation.custom_link_2_label": "Benefits", "text.navigation.custom_link_2_url": "https://benefits.example.org",
    }))).toEqual([
      { key: "custom-link-1", label: "Library", url: "https://example.org/library" },
      { key: "custom-link-2", label: "Benefits", url: "https://benefits.example.org" },
    ]);
    expect(customNavLinks(null)).toEqual([]);
  });

  it("makes the admin page refuse an unsafe address or label before saving", () => {
    const urlItem = { key: "text.navigation.custom_link_1_url", kind: "text", allowedValues: null };
    const labelItem = { key: "text.navigation.custom_link_1_label", kind: "text", allowedValues: null };
    expect(validValue(urlItem, "https://example.org")).toBe(true);
    expect(validValue(urlItem, "")).toBe(true);
    expect(validValue(urlItem, "javascript:alert(1)")).toBe(false);
    expect(validValue(urlItem, "http://example.org")).toBe(false);
    expect(validValue(labelItem, "Library")).toBe(true);
    expect(validValue(labelItem, "x".repeat(41))).toBe(false);
    expect(validValue(labelItem, "<b>x</b>")).toBe(false);
    expect(customNavLinkSettingValid("features.other", "anything")).toBe(true);
  });

  it("declares the copy in English and Spanish", () => {
    for (const key of [
      "shell.groupLinks", "nav.customLinkOpens",
      "settings.def.text.navigation.custom_link_1_label.label", "settings.def.text.navigation.custom_link_2_url.description",
    ]) {
      expect(catalogue.en[key], key).toBeTruthy();
      expect(catalogue.es[key], key).toBeTruthy();
    }
  });
});

describe("custom links in the navigation", () => {
  const links = [{ key: "custom-link-1", label: "Contract library", url: "https://example.org/library" }];

  it("adds a Links group to the desktop rail that opens in a new tab", () => {
    render(<LanguageProvider lang="en"><DesktopRail active="today" activeHat="member" demo={false} memberId="member-a" onAsk={() => {}} onNavigate={vi.fn()} renderMode="desktop" customLinks={links} /></LanguageProvider>);
    const link = screen.getByRole("link", { name: "Contract library (opens in a new tab)" });
    expect(link).toHaveAttribute("href", "https://example.org/library");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText("Links")).toBeInTheDocument();
  });

  it("renders no Links group without links", () => {
    render(<LanguageProvider lang="en"><DesktopRail active="today" activeHat="member" demo={false} memberId="member-a" onAsk={() => {}} onNavigate={vi.fn()} renderMode="desktop" /></LanguageProvider>);
    expect(screen.queryByText("Links")).not.toBeInTheDocument();
  });

  it("lists the links in the phone All features card", () => {
    render(<LanguageProvider lang="es"><MobileCardNav onNavigate={vi.fn()} onAsk={vi.fn()} customLinks={links}><p>Home</p></MobileCardNav></LanguageProvider>);
    const panel = document.querySelector("#card-nav-panel-features");
    const link = within(panel).getByRole("link", { name: "Contract library (se abre en una pestaña nueva)" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(within(panel).getByText("Enlaces")).toBeInTheDocument();
  });
});
