import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { memberNavGroups, staffNavGroups } from "../src/alt/nav.js";
import { APP_PATH_ALIASES, SPA_ROUTE_PATHS } from "../src/lib/appRoutes.js";
import { FEATURE_GROUPS, MEMBER_WORK_ITEMS, SITE_GUIDE_ITEM } from "../src/lib/mobileNav.js";
import { SHORTCUT_CATALOG } from "../src/lib/navigationPreferences.js";
import { STAFF_ROLE_NAVIGATION } from "../src/lib/staffNavigation.js";
import { STAFF_PLANES, STAFF_TOOLS } from "../src/lib/staffPlanes.js";
import { SETTINGS_PAGES, WORKSPACE_PAGES } from "../src/lib/workspacePages.js";

// REQ-UG-DEAD-IN-APP-LINKS-404-20261030: every in-app link target and
// every address members were seen typing must open a page, either because the
// SPA serves it (SPA_ROUTE_PATHS, mirrored by the vercel.json rewrites) or
// because vercel.json redirects it to one (APP_PATH_ALIASES).

const routes = new Set(SPA_ROUTE_PATHS);
const pathOnly = (target) => (String(target).split(/[?#]/, 1)[0].replace(/\/+$/, "") || "/");
const resolves = (target) => routes.has(pathOnly(target)) || Object.hasOwn(APP_PATH_ALIASES, pathOnly(target));

function navigationPaths(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const own = typeof value.path === "string" && value.path.startsWith("/") ? [value.path] : [];
  return [...own, ...Object.values(value).flatMap((child) => navigationPaths(child, seen))];
}

describe("in-app link inventory", () => {
  it("resolves every path in the signed-in navigation registries", () => {
    const t = (key) => key;
    const registries = {
      FEATURE_GROUPS, MEMBER_WORK_ITEMS, SITE_GUIDE_ITEM, SHORTCUT_CATALOG, STAFF_PLANES, STAFF_TOOLS,
      STAFF_ROLE_NAVIGATION, SETTINGS_PAGES, WORKSPACE_PAGES,
      altMember: memberNavGroups(t, {}, { siteGuide: true }),
      altStaff: STAFF_PLANES.map((plane) => staffNavGroups(t, plane.key)),
    };
    for (const [name, registry] of Object.entries(registries)) {
      const paths = navigationPaths(registry);
      expect(paths.length, name).toBeGreaterThan(0);
      expect(paths.filter((path) => !resolves(path)), name).toEqual([]);
    }
  });

  it("resolves every literal /m address in shipped source", () => {
    const files = execFileSync("git", ["ls-files", "src", "api", "supabase"], { encoding: "utf8" })
      .split("\n")
      .filter((file) => /\.(?:[cm]?jsx?|tsx?|json|sql)$/u.test(file) && !/\.test\.|__tests__/u.test(file));
    const dead = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      // A quoted (or URL-prefixed) address; a template's dynamic tail is cut
      // at "${", so `/m/steward/${slug}` checks /m/steward.
      for (const match of text.matchAll(/(?:["'`(]|unionground\.net)(\/m(?:\/[A-Za-z0-9_-]+)*\/?)(?=[?#"'`)$]|\s)/gu)) {
        const line = text.slice(0, match.index).split("\n").length;
        // Prose that describes a historical bad address (a comment) is not a link.
        if (/^\s*(?:\/\/|\*|--)/u.test(text.split("\n")[line - 1])) continue;
        // Immutable migration history retains two checkout redirects for the
        // service-only dues flow. There is no dues route or caller in this edition.
        if (file === "supabase/migrations/20260831170400_mi1_dues_settlement_reconciliation.sql"
            && match[1] === "/m/dues"
            && /^\s*prepared_(?:success|cancel)_url := origin \|\| '\/m\/dues\?payment=(?:success|cancel)';$/u.test(text.split("\n")[line - 1])) continue;
        if (!resolves(match[1])) dead.push(`${file}:${line} ${match[1]}`);
      }
    }
    expect(files.length).toBeGreaterThan(100);
    expect(dead).toEqual([]);
  });

  it("opens or redirects every address the Oct 29-30 role-play run reported as 404", () => {
    const reported = [
      "/m/calendar", "/m/be-heard", "/m/steward/cases", "/m/site-guide", "/m/admin/features",
      "/m/announcements", "/m/settings/tools", "/m/manage", "/admin", "/m/compass",
      "/m/chapter", "/m/roster", "/m/members",
    ];
    for (const address of reported) expect(resolves(address), address).toBe(true);
  });

  it("redirects the bare /settings address to Settings (BUG-UG-BARE-SETTINGS-ADDRESS-404-20261102)", () => {
    expect(APP_PATH_ALIASES["/settings"]).toBe("/m/settings");
    expect(routes.has("/m/settings")).toBe(true);
  });

  it("redirects every alias to a page the SPA serves, never to another alias", () => {
    for (const [alias, destination] of Object.entries(APP_PATH_ALIASES)) {
      expect(routes.has(pathOnly(destination)), `${alias} -> ${destination}`).toBe(true);
      expect(Object.hasOwn(APP_PATH_ALIASES, pathOnly(destination)), alias).toBe(false);
      expect(routes.has(alias), alias).toBe(false);
    }
  });
});
