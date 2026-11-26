import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { render, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ProfileDialog } from "../src/components/Dialogs.jsx";
import { DesktopRail } from "../src/components/DesktopRail.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t } from "../src/lib/i18n.js";
import {
  displayOrganizationName, loadOrganizationName, OrganizationNameProvider, PRODUCT_NAME,
} from "../src/lib/organizationName.js";
import { declaredFor, mountStylesheets } from "./helpers/appStylesheet.js";

const member = { fullName: "Alex Example", firstName: "Alex", initials: "AE", roleLine: "", sinceYear: 2020, email: "alex@example.invalid" };

describe("organization name in the shell and member card", () => {
  it("names the member and organization on the profile eyebrow in both languages", () => {
    for (const lang of ["en", "es"]) {
      const { unmount } = render(
        <LanguageProvider lang={lang}>
          <OrganizationNameProvider value="Example Transit Local 2">
            <ProfileDialog member={member} onClose={() => {}} onSave={async () => {}} />
          </OrganizationNameProvider>
        </LanguageProvider>,
      );
      expect(screen.getByText("Example Transit Local 2 · Alex Example")).toBeInTheDocument();
      unmount();
    }
  });

  it("uses the product name without a provider", () => {
    render(
      <LanguageProvider lang="en">
        <ProfileDialog member={member} onClose={() => {}} onSave={async () => {}} />
      </LanguageProvider>,
    );
    expect(PRODUCT_NAME).toBe("Union Ground");
    expect(screen.getByText("Union Ground · Alex Example")).toBeInTheDocument();
    expect(displayOrganizationName(" Example Workers Local 1 ")).toBe("Example Workers Local 1");
    expect(displayOrganizationName(42)).toBe(PRODUCT_NAME);
  });

  it("shows the organization on the desktop rail and never repeats the product wordmark", () => {
    const rail = (value, roleLabel = null) => render(
      <LanguageProvider lang="en">
        <OrganizationNameProvider value={value}>
          <DesktopRail renderMode="desktop" active="today" onNavigate={() => {}} roleLabel={roleLabel} user={{ name: "Alex Example", initials: "AE", onProfile: () => {} }} />
        </OrganizationNameProvider>
      </LanguageProvider>,
    );
    let view = rail("Example Workers Local 1");
    expect(view.container.querySelector(".desktop-rail__org").textContent).toBe("Example Workers Local 1");
    view.unmount();
    view = rail(null);
    expect(view.container.querySelector(".desktop-rail__org")).toBeNull();
    view.unmount();
    view = rail(null, "Admin");
    expect(view.container.querySelector(".desktop-rail__org").textContent).toBe("Union Ground · Admin");
    view.unmount();
  });

  it("reads the caller's own organization row and returns null on any failure", async () => {
    const chain = (result) => {
      const query = { select: vi.fn(() => query), eq: vi.fn(() => query), maybeSingle: vi.fn(() => result) };
      return { from: vi.fn(() => query), query };
    };
    const ok = chain(Promise.resolve({ data: { name: "Example Workers Local 1" }, error: null }));
    expect(await loadOrganizationName(ok, "org-1")).toBe("Example Workers Local 1");
    expect(ok.from).toHaveBeenCalledWith("organizations");
    expect(ok.query.eq).toHaveBeenCalledWith("id", "org-1");
    expect(await loadOrganizationName(chain(Promise.resolve({ data: null, error: { code: "42501" } })), "org-1")).toBeNull();
    expect(await loadOrganizationName(chain(Promise.resolve({ data: { name: 3 }, error: null })), "org-1")).toBeNull();
    expect(await loadOrganizationName(chain(Promise.reject(new Error("offline"))), "org-1")).toBeNull();
    expect(await loadOrganizationName(null, "org-1")).toBeNull();
    expect(await loadOrganizationName(ok, null)).toBeNull();
  });
});

// Guardrail: no user-facing copy may name a specific real local. The scan
// covers src/ and api/ with comments stripped. One file is allowlisted: a
// historical donor-audit reject list (never rendered), which names the string
// precisely so imports of it are refused. The featured directory listings are
// scanned too since the 2026-10-01 removal of the last listing that matched.
const LEGACY = [/SEIU Local 509/, /SEIU 509/, /Local 509 ·/, /LOCAL 509/];
const HISTORICAL_RECORDS = new Set(["src/features/pay/provenance.js"]);

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(jsx?|mjs|tsx?)$/.test(name) ? [path] : [];
  });
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

describe("no user-facing copy names a specific local", () => {
  it("finds none of the legacy literals in src/ or api/", () => {
    const root = resolve(process.cwd());
    const hits = [];
    for (const dir of ["src", "api"]) {
      for (const file of sourceFiles(join(root, dir))) {
        const relative = file.slice(root.length + 1);
        if (HISTORICAL_RECORDS.has(relative)) continue;
        const code = stripComments(readFileSync(file, "utf8"));
        for (const pattern of LEGACY) if (pattern.test(code)) hits.push(`${relative}: ${pattern}`);
      }
    }
    expect(hits).toEqual([]);
  });
});

// BUG-UG-WEB-RAIL-ORG-NAME-BREAKS-MID-WORD-20261002. Beside the 44px
// home mark and the 44px bell the org line had about 94px and
// `overflow-wrap: anywhere`, so "COMMONWEALTH PUBLIC SERVICE UNION · STEWARD"
// broke as COMMONWEA / LTH. The line now takes the brand's second row at the
// rail's full width and wraps only between words; nothing is truncated, so
// the whole name stays readable and is the line's accessible text.
describe("desktop rail organization line", () => {
  let unmountStyles;
  beforeAll(() => { unmountStyles = mountStylesheets(); });
  afterAll(() => unmountStyles());
  const LONG = "Commonwealth Public Service Employees International Association";

  function renderRail(theme) {
    return render(
      <LanguageProvider lang="en">
        <OrganizationNameProvider value={LONG}>
          <DesktopRail renderMode="desktop" active="today" workspaceTheme={theme} onNavigate={() => {}} onNotifications={() => {}} roleLabel="Steward" user={{ name: "Alex Example", initials: "AE", onProfile: () => {} }} />
        </OrganizationNameProvider>
      </LanguageProvider>,
    );
  }

  it("renders a long organization name in full, with the role, as the line's text", () => {
    const { container } = renderRail();
    const org = container.querySelector(".desktop-rail__org");
    expect(org.textContent).toBe(`${LONG} · Steward`);
    expect(screen.getByText(`${LONG} · Steward`)).toBe(org);
    // No truncation: no clamp, ellipsis or hidden overflow on the line.
    const style = getComputedStyle(org);
    expect(style.textOverflow).not.toBe("ellipsis");
    expect(style.overflow).not.toBe("hidden");
    expect(declaredFor(".desktop-rail__org")).not.toMatch(/line-clamp/);
  });

  it("wraps only between words, on its own full-width row under the mark, wordmark and bell", () => {
    const { container } = renderRail();
    const brand = container.querySelector(".desktop-rail__brand");
    const org = container.querySelector(".desktop-rail__org");
    expect(getComputedStyle(org).overflowWrap).not.toBe("anywhere");
    expect(declaredFor(".desktop-rail__org")).not.toMatch(/overflow-wrap:\s*anywhere/);
    expect(getComputedStyle(brand).flexWrap).toBe("wrap");
    // The text wrapper steps aside so the wordmark and the org line are the
    // brand row's own items: the wordmark between mark and bell, the org line
    // ordered after the bell at full width.
    expect(getComputedStyle(container.querySelector(".desktop-rail__brand-text")).display).toBe("contents");
    expect(getComputedStyle(org).order).toBe("1");
    expect(getComputedStyle(org).flexBasis).toBe("100%");
    expect(container.querySelector(".desktop-rail__bell")).not.toBeNull();
  });

  // Union green is the only theme (owner ruling, November 3, 2026): the
  // retired Cobalt Signal brand-row exclusion is gone, so the wrapping row
  // holds in the identity.
  it.each(["union-ground"])("wraps the brand row the same way in %s", (theme) => {
    const { container } = renderRail(theme);
    expect(getComputedStyle(container.querySelector(".desktop-rail__brand")).flexWrap).toBe("wrap");
    expect(getComputedStyle(container.querySelector(".desktop-rail__brand-text")).display).toBe("contents");
  });
});
