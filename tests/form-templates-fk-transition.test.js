// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql } from "./helpers/migration.js";

// Text pins are a tripwire, not a proof: they assert what THIS MIGRATION SAYS,
// not what the database ENDS UP WITH. A later create-or-replace can supersede
// every guard below and this file stays green. Current-state truth lives in
// scripts/db-contract.json, checked by `npm run verify:db`.
//
// Superseded here: open_form_as_case, save_form_draft, submit_form and
// approve_form, all redefined by 20260723112000_member_forms_template_registry_fk
// and, for the first three, by 20260724111000_form_templates_lookup_rewrite's
// registry reads.

const sql = loadMigrationSql("member_forms_template_registry_fk");
const memberApi = readFileSync(new URL("../src/lib/memberApi.js", import.meta.url), "utf8");
const formsView = readFileSync(new URL("../src/views/FormsView.jsx", import.meta.url), "utf8");
const adminView = readFileSync(new URL("../src/views/AdminView.jsx", import.meta.url), "utf8");
const app = readFileSync(new URL("../src/App.jsx", import.meta.url), "utf8");
const body = (functionName) => fnBody(sql, functionName);

describe("member_forms CHECK → FK transition", () => {
  it("adds template_version by constant default (metadata-only backfill)", () => {
    expect(sql).toContain("add column template_version integer not null default 1");
    expect(sql, "no data-modifying backfill").not.toMatch(/update\s+public\.member_forms\s+set\s+template_version/i);
  });

  it("attaches the composite FK not valid, validates, then drops the old CHECK by name", () => {
    expect(sql).toContain("add constraint member_forms_template_fkey");
    expect(sql).toContain("references public.form_templates(key, version)");
    expect(sql).toContain("not valid");
    expect(sql).toContain("validate constraint member_forms_template_fkey");
    expect(sql).toContain("drop constraint member_forms_template_key_check");
  });
});

describe("save_form_draft registry rewrite", () => {
  it("replaces the hardcoded key list with a registry lookup", () => {
    const draft = body("save_form_draft");
    expect(draft).toContain("from public.form_templates");
    expect(draft, "hardcoded template list must be gone").not.toContain("'fmla_self','fmla_family','grievance'");
  });

  it("gates active only on the new-draft branch and stamps the version", () => {
    const draft = body("save_form_draft");
    const newBranch = draft.slice(draft.indexOf("if existing is null then"), draft.indexOf("else"));
    expect(newBranch, "active gate lives inside the new-draft branch").toContain("if not tpl.active then");
    expect(newBranch).toContain("no longer accepting new submissions");
    expect(newBranch).toContain("insert into public.member_forms (user_id, template_key, template_version, answers, step)");
    const updateBranch = draft.slice(draft.indexOf("else"));
    expect(updateBranch, "in-flight drafts of retired templates stay editable").not.toContain("tpl.active");
    expect(updateBranch, "template_version stays pinned on update").not.toContain("template_version");
  });

  it("keeps the cosigner reaffirm hook byte-identical", () => {
    const draft = body("save_form_draft");
    expect(draft).toContain("if p_template_key = 'alliance_grievance' and clean is distinct from prev_answers then");
    expect(draft).toContain("set status='reaffirm_needed', responded_at=now()");
    expect(draft).toContain("'Re-affirm your co-signature'");
    expect(draft).toContain("pg_advisory_xact_lock");
  });
});

describe("submit_form version pinning", () => {
  it("validates against the form's own stored version via the 2-arg overload", () => {
    const submit = body("submit_form");
    expect(submit).toContain("select id, user_id, status, template_key, template_version, answers into rec");
    expect(submit).toContain("private.form_required_keys(rec.template_key, rec.template_version)");
    expect(submit, "truthful award reporting preserved").toContain("had_event");
  });
});

describe("steward review RPCs: localization + chapter scope", () => {
  it("localizes every notification to the recipient's profile language", () => {
    for (const fn of ["approve_form", "return_form", "open_form_as_case"]) {
      const def = body(fn);
      expect(def, `${fn} must join the recipient language`).toContain("coalesce(p.language, 'en') as lang");
      expect(def, `${fn} must use the version-pinned localized label`).toContain(
        "form_template_label_localized(rec.template_key, rec.template_version, rec.lang)",
      );
      expect(def, `${fn} must branch on the language`).toContain("if rec.lang = 'es' then");
      expect(def, `${fn} must lock only the form row`).toContain("for update of f");
    }
    expect(body("approve_form")).toContain("'Formulario aprobado'");
    expect(body("return_form")).toContain("'Formulario devuelto'");
    expect(body("open_form_as_case")).toContain("'Caso de queja abierto'");
  });

  it("folds the chapter-scope guard into the collapsed row guards (no oracle)", () => {
    for (const fn of ["approve_form", "return_form", "open_form_as_case", "steward_start_review"]) {
      const def = body(fn);
      expect(def, `${fn} must keep the steward role gate`).toContain("member_has_role(array['steward'])");
      expect(def, `${fn} must scope to the steward's chapter`).toContain("staff_can_see_user(");
    }
    const approve = body("approve_form");
    const approveGuard = approve.slice(approve.indexOf("if not found"), approve.indexOf("end if;", approve.indexOf("if not found")));
    expect(approveGuard, "scope failure collapses into the generic guard").toContain("staff_can_see_user(rec.user_id, 'steward')");
    const start = body("steward_start_review");
    expect(start).toContain("and public.staff_can_see_user(user_id, 'steward')");
    expect(start).toContain("get diagnostics updated = row_count");
  });

  it("preserves the open_form_as_case anti-oracle and single-shot case guards", () => {
    const open = body("open_form_as_case");
    expect(open).toContain("rec.status in ('draft', 'returned')");
    expect(open).toContain("if rec.case_id is not null then");
    expect(open).toContain("'GR-' || pg_catalog.to_char(now(), 'YYYY') || '-F'");
    expect(open, "steward actions never mint member points").not.toContain("member_action_log");
  });
});

describe("client version threading", () => {
  it("selects template_version on both the member and steward form reads", () => {
    expect(memberApi).toContain('"id,user_id,template_key,template_version,status,answers,revision,step,review_note,submitted_at,updated_at,filer_signed_at,filer_signature_digest,content_digest,artifact_digest,artifact_approved_at,artifact_approved_by"');
    // UB-DESK-01: the steward inbox reads through the list_steward_forms
    // pager whose SQL returns template_version — the flat capped select is
    // gone; tests/steward-desk-paging-migration.test.js pins the SQL side.
    expect(memberApi).toContain('client.rpc("list_steward_forms"');
    expect(memberApi).toContain("templateVersion: r.template_version ?? 1");
    expect(memberApi).toContain("templateVersion: item.template_version ?? 1");
  });

  it("loads the registry fail-soft on both surfaces", () => {
    // sol PR #734 F8: both surfaces read the WHOLE registry through the
    // shared page-loop — the silent 500 cap and the orderless steward read
    // are gone; a mid-loop failure degrades to the static fallback, never a
    // partial registry that could miss a draft's pinned version.
    expect(
      memberApi,
      "member read must fetch EVERY version (incl. inactive) so pinned drafts can render",
    ).toContain('fetchAllFormTemplates(client, "key,version,label_en,label_es,blurb_en,blurb_es,icon,points,active,sort,field_schema")');
    expect(memberApi).toContain('fetchAllFormTemplates(client, "key,version,label_en,field_schema")');
    expect(memberApi, "the walk is deterministic — (sort, key, version) totally orders the registry").toContain('.order("sort").order("key").order("version")');
    expect(memberApi).toContain(".range(from, from + TEMPLATE_PAGE - 1)");
    expect(memberApi, "a failed page surfaces the error with no rows").toContain("if (error) return { data: null, error };");
    expect(memberApi, "no raw capped registry read may remain").not.toMatch(/form_templates"\)\.select\([^)]*\)\.limit\(/);
    expect(memberApi, "start tiles use only active rows").toContain("resolveFormTemplates(currentFormTemplateRows(templateRows).filter((row) => row.active), lang, { loaded: !requests[28].error })");
    expect(memberApi, "every version resolves for pinned rendering").toContain("templateRows.map((row) => templateFromDbRow(row, lang))");
    expect(memberApi).toContain("formTemplateVersions");
  });

  it("renders existing member forms under their PINNED version, not the current one", () => {
    expect(formsView).toContain("template.key === form.templateKey && template.version === form.templateVersion");
    expect(formsView, "in-progress cards resolve by pinned version").toContain("template={pinnedTemplate(form)}");
    expect(formsView, "resumed editors render the pinned schema; fresh starts the active one").toContain(
      "template={editor.form ? pinnedTemplate(editor.form) : byKey(editor.templateKey)}",
    );
    expect(formsView, "reviewed list resolves by pinned version").toContain("const template = pinnedTemplate(form);");
  });

  // Registry wrappers are permitted only while the admin plane renders their
  // editor and calls every operation. This keeps a future partial revert from
  // leaving privileged, unreachable client code behind again.
  it("ships registry clients only with their reachable admin editor", () => {
    for (const name of ["loadAdminFormTemplates", "upsertFormTemplate", "deactivateFormTemplate", "reactivateFormTemplate"]) {
      expect(memberApi, `${name} must be an exported wrapper`).toContain(`function ${name}(`);
      expect(app, `${name} must be wired to the real admin api`).toContain(name);
    }
    expect(adminView).toContain("AdminFormTemplateEditor");
    // The table's SELECT grant is column-scoped; select("*") would 42501 for
    // every caller, so the admin read must name the granted columns.
    expect(memberApi, "admin surface reads all versions via the granted column list").toContain(
      '"key,version,label_en,label_es,blurb_en,blurb_es,icon,points,active,sort,field_schema,created_at,updated_at,organization_id,is_platform_seed"',
    );
    expect(memberApi, "no read may use the star selector on form_templates").not.toMatch(
      /form_templates"\)\s*\.select\("\*"\)/,
    );
    expect(memberApi, "the admin client must never write the registry directly").not.toMatch(
      /form_templates"\)\s*\.(insert|update|delete|upsert)\(/,
    );
  });

  it("always saves a form template with zero points", () => {
    // Union Ground has no points economy: the admin editor has no Points
    // field and the wrapper pins the RPC's points argument to 0.
    const upsert = memberApi.slice(memberApi.indexOf("export async function upsertFormTemplate("));
    const call = upsert.slice(0, upsert.indexOf("}), \"Save form template\")"));
    expect(call).toContain("p_points: 0,");
    expect(call).not.toMatch(/fields\.points/);
  });
});
