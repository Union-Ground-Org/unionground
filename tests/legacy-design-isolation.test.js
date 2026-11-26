// @vitest-environment node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { siblingIdentityIn } from "../scripts/lib/sibling-deny-list.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vercel = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8"));

// The legacy trees must stay outside the application and its public assets.
const LEGACY_TREES = ["design-source", join("apps", "contractsurvey"), join("public", "design")];

// Matches a path segment naming a legacy tree, with or without a relative
// prefix: "design-source/x", "../../apps/contractsurvey", "public/design/y".
// The bare word "design" is deliberately not matched — src/App.jsx routes the
// retired "/design" URL to RetiredLegacyView, which is the correct behaviour.
const LEGACY_REFERENCE = /(?:\.{0,2}\/)?(?:design-source|apps\/contractsurvey|public\/design)\//;

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.(js|jsx|mjs|css)$/.test(entry.name) ? [full] : [];
  });
}

describe("legacy design isolation", () => {
  it("keeps the inherited trees out of the working tree", () => {
    for (const path of LEGACY_TREES) {
      expect(existsSync(join(root, path)), path).toBe(false);
    }
  });

  it("never imports or reads a legacy tree from src/ or api/", () => {
    const offenders = [...sourceFiles(join(root, "src")), ...sourceFiles(join(root, "api"))]
      .filter((file) => LEGACY_REFERENCE.test(readFileSync(file, "utf8")))
      .map((file) => relative(root, file));
    expect(offenders).toEqual([]);
  });

  // Union Ground's exact-allowlist rewrites replaced the single catch-all, so
  // each retired tree is listed explicitly: the bare address and every path
  // under it reach the SPA (RetiredLegacyView), never a static file, and no
  // redirect sends them anywhere else.
  it("routes legacy paths to the isolated application response instead of static files", () => {
    const LEGACY_SPA_SOURCES = ["/contractsurvey", "/contractsurvey/:path*", "/design", "/design/:path*"];
    for (const source of LEGACY_SPA_SOURCES) {
      expect(vercel.rewrites).toContainEqual({ source, destination: "/index.html" });
    }
    const legacyRewrites = vercel.rewrites.filter((rule) => /^\/(design|contractsurvey)\b/.test(rule.source));
    expect(legacyRewrites.map((rule) => rule.source).sort()).toEqual([...LEGACY_SPA_SOURCES].sort());
    expect((vercel.redirects || []).filter((rule) => /^\/(design|contractsurvey)\b/.test(rule.source))).toEqual([]);
    expect(vercel.rewrites.some((rule) => rule.source.startsWith("/api/guide") && rule.destination === "/index.html")).toBe(false);
  });

  it("does not allow external frames or a path-scoped design CSP", () => {
    const serialized = JSON.stringify(vercel);
    // No sibling product host, the retired contract-survey frame among them.
    expect(siblingIdentityIn(serialized)).toEqual([]);
    expect(serialized).not.toContain('"source":"/design/(.*)"');
    // A retired tree may carry a noindex header, never a Content-Security-Policy
    // of its own that would loosen the site-wide one.
    for (const entry of vercel.headers.filter((rule) => /^\/(design|contractsurvey)\b/.test(rule.source))) {
      expect(entry.headers.map((header) => header.key)).toEqual(["X-Robots-Tag"]);
      expect(entry.headers[0].value).toContain("noindex");
    }
  });

  it("keeps the site-wide Content-Security-Policy closed by default", () => {
    const siteHeaders = vercel.headers.find((entry) => entry.source === "/(.*)").headers;
    const csp = siteHeaders.find((header) => header.key === "Content-Security-Policy").value;

    // Semicolon-terminated so a host added to either directive fails here: these
    // two are what stop injected script from executing or exfiltrating.
    expect(csp).toContain("default-src 'self';");
    expect(csp).toContain("script-src 'self';");

    expect(csp).toContain("object-src 'none'");
    // Same-origin frames only (Union Ground's in-app companion and document
    // previews); no external host may be framed.
    expect(csp).toContain("frame-src 'self';");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");

    // Present and self-scoped. Their allowlists may legitimately grow (the
    // Supabase project host lives in connect-src), so only the origin is pinned.
    for (const directive of ["style-src", "img-src", "font-src", "connect-src", "worker-src"]) {
      expect(csp).toContain(`${directive} 'self'`);
    }

    // 'unsafe-inline' is tolerable in style-src only, because React renders
    // style={{...}} as an inline style attribute. Anywhere else it is a hole,
    // and 'unsafe-eval' is never acceptable.
    const relaxed = [...csp.matchAll(/([a-z-]+-src)[^;]*'unsafe-inline'/g)].map((match) => match[1]);
    expect(relaxed).toEqual(["style-src"]);
    expect(csp).not.toContain("'unsafe-eval'");

    const hsts = siteHeaders.find((header) => header.key === "Strict-Transport-Security").value;
    expect(Number(hsts.match(/max-age=(\d+)/)?.[1])).toBeGreaterThanOrEqual(31536000);
  });

  it("schedules independent encrypted-intake retention cleanup", () => {
    expect(vercel.crons).toContainEqual({
      path: "/api/connect-purge",
      schedule: "17 3 * * *",
    });
  });
});
