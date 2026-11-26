// #9403 round 1 (item 8): the test models of member_forms must store exactly
// what the database stores, so no test can pass on a column the database
// leaves empty. Each fact below is read from the migrations themselves (the
// latest definition, in migration order), then the small-new-organization
// fixture backend's row for each save function is held to it.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createSmallNewOrganizationBackend } from "./fixtures/small-new-organization/backend.js";
import { organization, otherOrganization, otherPeople, people } from "./fixtures/small-new-organization/organization.js";

const officer = people.organizationOfficer;

const MIGRATIONS = resolve(process.cwd(), "supabase/migrations");
const migrations = readdirSync(MIGRATIONS).filter((name) => name.endsWith(".sql")).sort()
  .map((name) => ({ name, text: readFileSync(resolve(MIGRATIONS, name), "utf8") }));
// The body of the latest definition of a function, in migration order.
const latestDefinition = (signature) => {
  const pattern = new RegExp(`create (?:or replace )?function public\\.${signature}\\(`, "i");
  const file = migrations.filter(({ text }) => pattern.test(text)).at(-1);
  expect(file, signature).toBeTruthy();
  const start = file.text.search(pattern);
  const end = file.text.slice(start).search(/\$(?:function|\w*)\$;/i);
  return file.text.slice(start, start + (end === -1 ? 20000 : end));
};
const insertColumns = (body) => {
  const match = body.match(/insert into public\.member_forms \(([^)]*)\)/i);
  return match ? match[1].split(",").map((column) => column.trim()) : null;
};

const saveFormDraft = latestDefinition("save_form_draft");
const ORDINARY_INSERT = insertColumns(saveFormDraft);
// Columns the database fills by itself on such an insert: the key and status
// defaults, the revision trigger, the time stamps, and the two this check is
// about, left at their defaults.
const SYSTEM = ["id", "status", "revision", "created_at", "updated_at", "organization_id", "settings_scope"];

describe("what the database stores on a member_forms row", () => {
  it("an ordinary save inserts only the member, template, version, answers and step", () => {
    expect(ORDINARY_INSERT).toEqual(["user_id", "template_key", "template_version", "answers", "step"]);
    expect(ORDINARY_INSERT).not.toContain("organization_id");
    expect(ORDINARY_INSERT).not.toContain("settings_scope");
  });

  it("save_member_form_draft writes through save_form_draft and answers with the form and its revision; the unit twin calls it", () => {
    const revision = latestDefinition("save_member_form_draft");
    expect(revision).toMatch(/public\.save_form_draft\(/);
    expect(revision).toMatch(/jsonb_build_object\('formId', saved, 'revision', saved_revision\)/);
    expect(latestDefinition("save_unit_member_form_draft")).toMatch(/public\.save_member_form_draft\(/);
  });

  it("organization_id is set only for a sealed form, and settings_scope defaults to {} and is stamped {chapterId, unitId, unitName}", () => {
    const sealed = migrations.find(({ name }) => name.startsWith("20261028174500_")).text;
    expect(sealed).toMatch(/organization_id is\s+'Organization a sealed \(FMLA\) form''s envelope is bound to;[^']*Null for other templates\.'/);
    expect(insertColumns(sealed.slice(sealed.search(/function public\.prepare_sealed_form\(/i)))).toContain("organization_id");
    const units = migrations.find(({ name }) => name.startsWith("20261113124000_")).text;
    expect(units).toMatch(/alter table public\.member_forms add column settings_scope jsonb not null default '\{\}'::jsonb/);
    expect(units).toMatch(/jsonb_build_object\('chapterId',chapter,'unitId',selected,\s*'unitName'/);
  });
});

describe("the fixture backend runs the unit wrapper's checks before the revision, as the SQL does", () => {
  const backend = createSmallNewOrganizationBackend({});
  backend.signInAs("organizationOfficer");
  const save = (extra) => backend.client.rpc("save_unit_member_form_draft", { p_template_key: "row_shape_unit_checks", p_answers: {}, p_step: 0, p_expected_form_id: null, p_base_revision: 0, ...extra });
  it("refuses another work context or a named unit (42501) and accepts the person's own context with no unit", async () => {
    const own = { p_unit: null, p_actor: officer.id, p_chapter: officer.chapterId, p_organization: organization.id };
    expect((await save({ ...own, p_actor: "someone-else" })).error).toMatchObject({ code: "42501" });
    expect((await save({ ...own, p_chapter: "another-chapter" })).error).toMatchObject({ code: "42501" });
    expect((await save({ ...own, p_unit: "5e11ffff-0000-4000-8000-000000000001" })).error).toMatchObject({ code: "42501", message: "unit membership changed" });
    // Refused before the revision: a stale base revision still answers 42501.
    expect((await save({ ...own, p_unit: "5e11ffff-0000-4000-8000-000000000001", p_base_revision: 9 })).error).toMatchObject({ code: "42501" });
    expect((await save({ ...own, p_organization: otherOrganization.id })).error).toMatchObject({ code: "42501" });
    expect((await save(own)).error).toBeNull();
  });

  // Require_unit_workflow_context compares with the
  // signed-in person's own organization, so the second organization's officer
  // saves in their context and is refused in the first organization's.
  it("compares the organization with the signed-in person's own, for a second organization's officer too", async () => {
    const other = createSmallNewOrganizationBackend({});
    other.signInAs("officer");
    const saveAsOther = (extra) => other.client.rpc("save_unit_member_form_draft", { p_template_key: "row_shape_unit_checks_other", p_answers: {}, p_step: 0, p_expected_form_id: null, p_base_revision: 0, ...extra });
    const own = { p_unit: null, p_actor: otherPeople.officer.id, p_chapter: otherPeople.officer.chapterId, p_organization: otherOrganization.id };
    expect((await saveAsOther({ ...own, p_organization: organization.id })).error).toMatchObject({ code: "42501", message: "work context changed; reload" });
    expect((await saveAsOther(own)).error).toBeNull();
  });
});

describe("the fixture backend stores what the database stores", () => {
  const backend = createSmallNewOrganizationBackend({});
  backend.signInAs("organizationOfficer");
  const rowAfter = async (name, extra = {}) => {
    const templateKey = `row_shape_${name}`;
    const args = { p_template_key: templateKey, p_answers: { summary: "Fictional" }, p_step: 0, ...extra };
    const { error } = await backend.client.rpc(name, args);
    expect(error).toBeNull();
    return (backend.state.rows["table:member_forms"] ?? []).find((row) => row.template_key === templateKey);
  };

  for (const [name, extra] of [
    ["save_form_draft", {}],
    ["save_member_form_draft", { p_expected_form_id: null, p_base_revision: 0 }],
    ["save_unit_member_form_draft", { p_expected_form_id: null, p_base_revision: 0, p_unit: null, p_actor: officer.id, p_chapter: officer.chapterId, p_organization: organization.id }],
  ]) {
    it(`${name}: a new row holds the insert's columns and the database's defaults, organization_id null and settings_scope {}`, async () => {
      const row = await rowAfter(name, extra);
      expect(Object.keys(row).sort()).toEqual([...ORDINARY_INSERT, ...SYSTEM].sort());
      expect(row.organization_id).toBeNull();
      expect(row.settings_scope).toEqual({});
      expect(row.revision).toBe(1);
    });
  }
});
