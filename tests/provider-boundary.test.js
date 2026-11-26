// @vitest-environment node
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MESH_ENDPOINTS, MESH_HOSTS, resolveMeshEndpoint } from "../api/_lib/compassAiGovernance.js";
import { DEFAULT_DEMO_HOST, DEFAULT_DEMO_ORIGIN, isDemoHost, isSaasHost, portalOrigin, SAAS_HOSTS } from "../src/lib/demoOrigin.js";
import { PUBLIC_CONTACTS, PUBLIC_POSTAL_ADDRESS, publicContact } from "../src/lib/publicContact.js";
import { PUBLIC_ORIGIN, SOCIAL_IMAGE_URL } from "../src/lib/publicPageMetadata.js";
import { catalogue } from "../src/lib/i18n/allLanguages.js";
import { FORBIDDEN as BUNDLE_FORBIDDEN, scanWebBundle } from "../scripts/verify-web-bundle-identity.mjs";
import { hasRetiredProjectName } from "../scripts/lib/retired-project-names.mjs";
import { siblingIdentityIn } from "../scripts/lib/sibling-deny-list.mjs";
import { runnerTimeout } from "../scripts/lib/runner-timeout.mjs";
import { DENIED_APP_HOST, DENIED_IDENTITY_TOKEN, DENIED_PRODUCTION_REF, DENIED_SAAS_HOST } from "./helpers/denied-identity-fixtures.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

describe("Union Ground provider isolation", () => {
  it("contains no active sibling-product domain or Supabase target", () => {
    const active = [
      ".env.example",
      "vercel.json",
      "src/lib/supabase.js",
      "api/calendar.js",
      "api/admin-mfa-reset.js",
      "api/guide.js",
      "api/notifications-dispatch.js",
      "api/connect.js",
      "api/connect-purge.js",
      "src/App.jsx",
      "src/views/LearnView.jsx",
      "src/views/ConnectView.jsx",
      "src/views/RetiredLegacyView.jsx",
    ].map(read).join("\n");
    // Every sibling host, Supabase project and account identifier on the
    // digest deny list (config/sample-backend.json); a host counts only on a
    // label boundary, so Union Ground's own org.unionground.app ids do not.
    expect(siblingIdentityIn(active)).toEqual([]);
    expect(active).not.toMatch(/\bRUN_[A-Z0-9_]*ACTIVE_USER_STRESS\b/);
    expect(existsSync(join(root, "public", "design"))).toBe(false);
  });

  // The native app was rebuilt from the sibling product's Expo app. Its
  // shipped code, config and native modules must carry none of that product's
  // hosts, Supabase projects, application ids, EAS project, OAuth client, or
  // Apple team. Tests are exempt: they name those targets to prove refusal.
  it("keeps the native app free of sibling-product targets", () => {
    const mobileRoot = join(root, "apps", "mobile");
    const skip = new Set(["node_modules", "ios", "android", ".expo", "dist"]);
    const files = [];
    const walk = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (!/\.test\.ts$/.test(entry.name) && /\.(ts|tsx|js|mjs|cjs|json|plist|kt|swift|xml|gradle|podspec|strings|md)$/.test(entry.name)) files.push(path);
      }
    };
    walk(mobileRoot);
    expect(files.length).toBeGreaterThan(200);
    // The names below in clear; hosts, Supabase projects, the EAS project,
    // OAuth client and Apple team through the digest deny list.
    const forbidden = ["net.unionground", "unionbase"];
    // Deny lists name the sibling's targets in order to refuse them.
    const denyLists = new Set(["apps/mobile/scripts/verify-bundle-identity.mjs"]);
    const offenders = [];
    for (const file of files) {
      if (file.endsWith("package-lock.json") || denyLists.has(file.slice(root.length + 1))) continue;
      const text = readFileSync(file, "utf8");
      for (const value of forbidden) if (text.includes(value)) offenders.push(`${file.slice(root.length + 1)}: ${value}`);
      for (const value of siblingIdentityIn(text)) offenders.push(`${file.slice(root.length + 1)}: ${value}`);
    }
    expect(offenders).toEqual([]);
  });

  // The web, API and public files came from the sibling product too. None of
  // them may name its hosts, mailboxes, app ids, native scheme, AI mesh,
  // Supabase projects or company. Deny lists that name a sibling target in
  // order to refuse it are the only exemptions.
  it("keeps web source, API and public files free of sibling-product targets", () => {
    const skip = new Set(["node_modules", "dist"]);
    const files = [];
    const walk = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(js|jsx|mjs|cjs|ts|json|html|css|txt|xml|webmanifest|svg|md)$/.test(entry.name)) files.push(path);
      }
    };
    for (const directory of ["src", "api", "public"]) walk(join(root, directory));
    for (const file of ["index.html", "vite.config.mjs", "scripts/public-route-metadata.mjs", "data/reference/labor-rights/documents.json"]) files.push(join(root, file));
    expect(files.length).toBeGreaterThan(500);
    const denyLists = new Set(["src/lib/providerContract.js", "src/features/pay/provenance.js"]);
    // "Union Base" is the sibling's design-source name; comments cite it as
    // provenance, and the code-strings check below keeps it out of code.
    const forbidden = BUNDLE_FORBIDDEN.filter((value) => value !== "Union Base");
    const offenders = [];
    for (const file of files) {
      const relative = file.slice(root.length + 1);
      if (denyLists.has(relative)) continue;
      const text = readFileSync(file, "utf8");
      for (const value of forbidden) if (text.includes(value)) offenders.push(`${relative}: ${value}`);
      if (hasRetiredProjectName(text)) offenders.push(`${relative}: retired project name`);
      for (const value of siblingIdentityIn(text)) offenders.push(`${relative}: ${value}`);
    }
    expect(offenders).toEqual([]);
    // Digesting every token of about 15 MB of source takes about 6 s on an idle
    // workstation, close to the 10 s default once a shard is busy.
  }, runnerTimeout(30_000));

  it("never prints a retired name in web copy or code strings", () => {
    const retired = (value) => value.includes("Union Base") || hasRetiredProjectName(value);
    for (const lang of ["en", "es"]) {
      const named = Object.entries(catalogue[lang]).filter(([, value]) => retired(value));
      expect(named.map(([key]) => `${lang}:${key}`)).toEqual([]);
    }
    // Comments may cite "Union Base" as design provenance; code may not.
    const offenders = [];
    const walk = (directory) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) { walk(path); continue; }
        if (!/\.(js|jsx|mjs)$/.test(entry.name)) continue;
        const relative = path.slice(root.length + 1);
        readFileSync(path, "utf8").split("\n").forEach((line, index) => {
          const code = line.trim();
          if (/^(\/\/|\*|\/\*|\{\/\*)/.test(code)) return;
          if (retired(code)) offenders.push(`${relative}:${index + 1}`);
        });
      }
    };
    walk(join(root, "src"));
    walk(join(root, "api"));
    expect(offenders).toEqual([]);
  });

  it("names no Union Ground host, mailbox, public site or AI mesh until the owner approves one", () => {
    // The SAMPLE host is the reserved placeholder from config/sample-backend.json.
    expect(DEFAULT_DEMO_HOST).toBe("unionground.invalid");
    expect(DEFAULT_DEMO_ORIGIN).toBe("https://unionground.invalid");
    expect(SAAS_HOSTS).toEqual([]);
    expect(isSaasHost(DENIED_SAAS_HOST)).toBe(false);
    expect(isDemoHost(DENIED_APP_HOST)).toBe(false);
    expect(isDemoHost("")).toBe(false);
    expect(isDemoHost("unionground.invalid")).toBe(true);
    expect(portalOrigin("saas")).toBe("");
    expect(portalOrigin("demo")).toBe("");
    expect(PUBLIC_CONTACTS).toEqual({});
    expect(PUBLIC_POSTAL_ADDRESS).toBeNull();
    for (const role of ["owner", "sales", "support", "personal"]) expect(publicContact(role)).toBeNull();
    expect(PUBLIC_ORIGIN).toBe("");
    expect(SOCIAL_IMAGE_URL).toBe("");
    expect(MESH_ENDPOINTS).toEqual({ saas: "", demo: "" });
    expect(MESH_HOSTS).toEqual([]);
    expect(resolveMeshEndpoint("saas", {})).toBe("");
    expect(() => resolveMeshEndpoint("saas", { MESH_AI_ENDPOINT: `https://mesh.${DENIED_SAAS_HOST}/v1/chat/completions` })).toThrow();
    expect(() => resolveMeshEndpoint("demo", { SAMPLE_MESH_AI_ENDPOINT: "https://mesh.example.org/v1/chat/completions" })).toThrow();
    expect(read("public/sitemap.xml")).not.toContain("<loc>");
    expect(read("public/robots.txt")).not.toMatch(/^Sitemap:/m);
    expect(existsSync(join(root, "public", "native-credentials"))).toBe(false);
  });

  it("fails the dist scan on any sibling identity and passes a clean bundle", () => {
    const dist = mkdtempSync(join(tmpdir(), "psg-web-bundle-"));
    try {
      mkdirSync(join(dist, "assets"));
      writeFileSync(join(dist, "index.html"), "<title>Union Ground</title>");
      // The project's own name, company and package scope are allowed.
      writeFileSync(join(dist, "assets", "index.js"), 'const s="Union Ground",o="Open Union Ground · Legal",c="Union Ground LLC",p="@unionground/mobile";');
      expect(scanWebBundle(dist)).toEqual({ scanned: 2, hits: [] });
      for (const value of [...BUNDLE_FORBIDDEN,
        `https://${DENIED_APP_HOST}/`, `${DENIED_PRODUCTION_REF}.supabase.co`, DENIED_IDENTITY_TOKEN]) {
        writeFileSync(join(dist, "assets", "leak.js"), `const leak=${JSON.stringify(value)};`);
        expect(scanWebBundle(dist).hits.length, value).toBeGreaterThan(0);
      }
    } finally {
      rmSync(dist, { recursive: true, force: true });
    }
    expect(JSON.parse(read("package.json")).scripts.check).toMatch(/npm run build && npm run verify:web-bundle-identity/);
  });

  it("pins no sibling Supabase project in the shared sample contract", () => {
    const sample = JSON.parse(read("config/sample-backend.json"));
    expect(sample.sampleSupabaseRef).toBe("");
    expect(sample.sampleSupabaseOrigin).toBe("");
    expect(sample.samplePortalOrigin).toBe("https://unionground.invalid");
    // The sibling refs appear only as digests in the deny list app.config.ts enforces.
    expect(sample.forbiddenSupabaseRefSha256.length).toBeGreaterThan(0);
    // Only the deny-list comment names the fictional fixtures; nothing names a real target.
    const { $denyListComment, ...contract } = sample;
    expect($denyListComment).toMatch(/digests/);
    expect(siblingIdentityIn(JSON.stringify(contract))).toEqual([]);
    expect(JSON.stringify(sample.samplePersonas)).not.toMatch(/unionground\.net/);
    expect(siblingIdentityIn(JSON.stringify(sample.samplePersonas))).toEqual([]);
    expect(read("src/lib/trustedBackends.js")).toContain("Object.freeze({})");
    expect(read("src/lib/emailLinkHosts.js")).toContain("Object.freeze([])");
  });

  // The archived plans moved out of this repository on November 11, 2026,
  // together with the scan that kept source-system Supabase refs and hosts out
  // of them. A plan checked in here again would escape that scan, so the
  // folder must stay gone.
  it("keeps archived plans out of this repository", () => {
    expect(existsSync(join(root, "specs"))).toBe(false);
  });

  // The file worklist was retired on November 11, 2026; work is tracked in
  // GitHub Issues. A root copy would be a second ledger.
  it.each(["worklist.md", "worklist.json"])("keeps the retired file worklist's %s out of this repository", (file) => {
    expect(existsSync(join(root, file))).toBe(false);
  });

  it("revokes inherited stress mutation RPCs from service_role", () => {
    const migration = read(
      "supabase/migrations/20261014004000_unionground_disable_legacy_stress.sql",
    );
    for (const fn of [
      "member_stress_begin",
      "member_stress_apply_batch",
      "member_stress_status",
      "member_stress_verify",
      "member_stress_begin_remove",
      "member_stress_remove_batch",
      // Later bulk seed/remove lanes; the reconciled migration closes them
      // the same way.
      "member_stress_enrich_batch",
      "member_stress_enrich_verify",
      "uniondemo_begin",
      "uniondemo_apply_batch",
      "uniondemo_enrich_batch",
      "uniondemo_seed_org",
      "uniondemo_begin_remove",
      "uniondemo_remove_batch",
      "uniondemo_topup_upcoming_events",
      "presg_demo_begin",
      "presg_demo_apply_batch",
      "presg_demo_enrich_batch",
      "presg_demo_seed_org",
      "presg_demo_begin_remove",
      "presg_demo_remove_batch",
      "sensitive_demo_seed_plan",
    ]) {
      expect(migration).toContain(`revoke all on function public.${fn} (`);
    }
    // Every revoke in the file reaches all four API roles, and nothing else
    // is revoked or granted.
    const revokes = migration.match(/^revoke all on function public\.[a-z_]+ \([^)]*\)\n {2}from [^;]*;/gm);
    expect(revokes).toHaveLength(36);
    for (const revoke of revokes) {
      expect(revoke).toMatch(/\n {2}from public, anon, authenticated, service_role;$/);
    }
    expect(migration.match(/from public, anon, authenticated, service_role/g)).toHaveLength(36);
    expect(migration).not.toContain("grant execute");
    expect(migration).not.toMatch(/drop\s+(function|table)/i);
    const pkg = JSON.parse(read("package.json"));
    expect(Object.keys(pkg.scripts).filter((name) => name.startsWith("stress:"))).toEqual([]);
  });
});
