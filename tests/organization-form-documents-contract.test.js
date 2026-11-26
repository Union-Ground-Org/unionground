// @vitest-environment node
// REQ-UG-ORG-RESOURCE-HTML-FORMS-20261030: the storage, sandbox and
// no-seeding contract around organization HTML forms.
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ORG_FORM_FRAME_PATH, ORG_FORM_FRAME_SANDBOX } from "../src/lib/organizationHtmlForms.js";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const migration = read("supabase/migrations/20261030201500_organization_form_documents.sql");
const vercel = JSON.parse(read("vercel.json"));
const frame = read("public/org-form-frame.html");

describe("organization form documents migration", () => {
  it("stores only blank templates, per organization, with no client table access", () => {
    expect(migration).toContain("create table private.organization_form_documents (");
    expect(migration).toContain("organization_id uuid not null references public.organizations(id)");
    expect(migration).toContain("check (document_kind = 'blank_template')");
    expect(migration).toContain("revoke all on table private.organization_form_documents from public, anon, authenticated, service_role;");
    expect(migration).not.toMatch(/grant\s+(select|insert|update|delete)[^;]*organization_form_documents/i);
    expect(migration).not.toMatch(/references auth\.users/i);
  });

  it("defines every function as security definer with an empty search path and authenticated-only execute", () => {
    const functions = [...migration.matchAll(/create function ([a-z_.]+)\(/g)].map((match) => match[1]);
    expect(functions).toEqual([
      "private.organization_form_reader_organization",
      "public.list_organization_form_documents",
      "public.get_organization_form_document",
      "public.accept_organization_form_document",
      "public.retire_organization_form_document",
    ]);
    const bodies = migration.split(/create function /).slice(1);
    for (const body of bodies) {
      expect(body.slice(0, body.indexOf("$function$"))).toMatch(/security definer\s+set search_path = ''/);
    }
    for (const name of functions) {
      expect(migration).toMatch(new RegExp(`revoke all on function ${name.replace(".", "\\.")}\\([^)]*\\) from public, anon, authenticated, service_role;`));
    }
    expect(migration).not.toMatch(/grant execute on function private\./);
    expect(migration).not.toMatch(/to anon/);
  });

  it("gates readers on the selected organization and writers on the administrator role with MFA", () => {
    expect(migration).toMatch(/when \(select private\.member_pin_session_restricted\(\)\) then null/);
    // PR 6599 review r4428121081: readers resolve the organization exactly as
    // the administrator writers do, so an administrator with no selected
    // chapter still lists, opens and retires what they imported.
    expect(migration).toContain("else (select private.current_mobile_staff_organization())");
    expect(migration).not.toContain("private.current_member_organization()");
    // The writers take the case-graph gate before resolving the organization.
    expect(migration.match(/perform private\.lock_case_graph\(array\[\(select auth\.uid\(\)\)\], array\[\]::uuid\[\]\);\n {2}caller := \(select auth\.uid\(\)\);\n {2}org := private\.current_mobile_staff_organization\(\);/g)).toHaveLength(2);
    expect(migration.match(/org uuid := private\.organization_form_reader_organization\(\);/g)).toHaveLength(2);
    expect(migration.match(/private\.has_organization_role\(org, array\['admin'\]\)/g)).toHaveLength(2);
    expect(migration).toContain("if p_attested is not true then");
    expect(migration).toContain("pg_catalog.strpos(p_document_html, 'data-ug-form-instance') > 0");
    expect(migration).toContain("pg_catalog.strpos(p_document_html, 'ug-saved-signatures') > 0");
  });

  it("seeds nothing: no migration or seed inserts organization form documents outside the writer", () => {
    const outsideWriter = migration.replace(/create function public\.accept_organization_form_document[\s\S]*?\$function\$;\n/, "");
    expect(outsideWriter).not.toMatch(/insert into private\.organization_form_documents/);
    const seedRoots = ["supabase"];
    for (const root of seedRoots) {
      for (const file of readdirSync(new URL(`../${root}`, import.meta.url), { recursive: true })) {
        if (!/\.sql$/.test(file) || file.endsWith("20261030201500_organization_form_documents.sql")) continue;
        expect(read(`${root}/${file}`)).not.toContain("organization_form_documents");
      }
    }
  });
});

describe("organization form frame", () => {
  const cspOf = (source) => vercel.headers
    .find((entry) => entry.source === source && !entry.has)
    ?.headers.find((header) => header.key === "Content-Security-Policy")?.value;

  it("serves the frame with an opaque-origin sandbox and no network", () => {
    const csp = cspOf(ORG_FORM_FRAME_PATH);
    const directives = Object.fromEntries(csp.split(";").map((part) => part.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
    expect(directives["default-src"]).toEqual(["'none'"]);
    expect(directives["connect-src"]).toEqual(["data:", "blob:"]);
    expect(directives["form-action"]).toEqual(["'none'"]);
    expect(directives["frame-ancestors"]).toEqual(["'self'"]);
    expect(directives.sandbox.join(" ")).toBe(ORG_FORM_FRAME_SANDBOX);
    expect(directives.sandbox).not.toContain("allow-same-origin");
    expect(csp).not.toMatch(/https?:|'self' https|\*/);
    const siteIndex = vercel.headers.findIndex((entry) => entry.source === "/(.*)" && !entry.has);
    expect(vercel.headers.findIndex((entry) => entry.source === ORG_FORM_FRAME_PATH)).toBeGreaterThan(siteIndex);
  });

  it("accepts a document only from its parent and does nothing on its own", () => {
    expect(frame).toContain("if (window.parent === window) return;");
    expect(frame).toContain("if (event.source !== window.parent) return;");
    expect(frame).toContain('data.type !== "ug-org-form:load"');
    expect(frame).not.toMatch(/<script\s+src=|https?:\/\/(?!www\.w3)/);
  });
});
