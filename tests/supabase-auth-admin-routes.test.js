// @vitest-environment node
// BUG-UG-ADMIN-SESSION-REVOKE-ENDPOINT-20261003
//
// Admin password reissue, sign-in address recovery and MFA reset called
// POST /auth/v1/admin/users/{id}/logout, which Supabase Auth does not have, so
// all three failed on production while their mocked tests passed. This pins
// every Supabase Auth admin path the server code calls to the admin routes
// Supabase Auth actually serves (internal/api/api.go, "/admin" router).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("..", import.meta.url).pathname;

// Supabase Auth admin routes, path parameters written as {}.
const SUPABASE_AUTH_ADMIN_ROUTES = [
  "/admin/audit",
  "/admin/users",
  "/admin/users/{}",
  "/admin/users/{}/factors",
  "/admin/users/{}/factors/{}",
  "/admin/users/{}/passkeys",
  "/admin/users/{}/passkeys/{}",
  "/admin/generate_link",
  "/admin/sso/providers",
  "/admin/sso/providers/{}",
];

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sourceFiles(path);
    return /\.(?:js|mjs)$/.test(name) ? [path] : [];
  });
}

function adminPathsIn(source) {
  const paths = [];
  for (const match of source.matchAll(/\/auth\/v1(\/admin\/[^`"'?\s)]*)/g)) {
    const path = match[1]
      .replace(/\$\{[^{}]*\}/g, "{}") // template parameters
      .replace(/\$\{.*$/, "") // a conditional suffix such as ${update ? `/${id}` : ""}
      .replace(/\{[a-z_]+\}/gi, "{}") // parameters written as {id} in comments
      .replace(/\/+$/, "");
    paths.push(path);
  }
  return paths;
}

describe("Supabase Auth admin routes called by the server", () => {
  const files = sourceFiles(join(ROOT, "api"));
  const used = files.flatMap((file) => adminPathsIn(readFileSync(file, "utf8")).map((path) => ({ file: file.slice(ROOT.length), path })));

  it("finds the admin calls it is meant to check", () => {
    expect(used.length).toBeGreaterThan(5);
    expect(used.map((use) => use.path)).toContain("/admin/users/{}");
  });

  it("calls only admin routes that Supabase Auth serves", () => {
    const unknown = used.filter((use) => !SUPABASE_AUTH_ADMIN_ROUTES.includes(use.path));
    expect(unknown).toEqual([]);
  });

  it("recognizes the route that broke admin recovery as unknown", () => {
    expect(adminPathsIn("fetch(`${url}/auth/v1/admin/users/${userId}/logout`, {")).toEqual(["/admin/users/{}/logout"]);
    expect(SUPABASE_AUTH_ADMIN_ROUTES).not.toContain("/admin/users/{}/logout");
  });
});
