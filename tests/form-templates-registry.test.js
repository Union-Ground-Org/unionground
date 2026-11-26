// @vitest-environment node
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// tests/setup.js registers Spanish only for DOM files; this node file reads it.
import "../src/lib/i18n/allLanguages.js";
import { fnBody, loadMigrationSql } from "./helpers/migration.js";
import { FORM_TEMPLATES } from "../src/lib/formTemplates.js";
import { catalogue } from "../src/lib/i18n.js";

// Text pins are a tripwire, not a proof: they assert what THIS MIGRATION SAYS,
// not what the database ENDS UP WITH. A later create-or-replace can supersede
// every guard below and this file stays green. Current-state truth lives in
// scripts/db-contract.json, checked by `npm run verify:db`.
//
// The seed-fidelity assertions against src/lib/formTemplates.js are pure
// tripwires and stay that way; the registry's live shape (composite PK,
// column-scoped grants, the partial active/sort index) is contracted instead.

const sql = loadMigrationSql("form_templates_registry");
const body = (functionName, source = sql) => fnBody(source, functionName);

describe("form_templates table security", () => {
  it("is read-only reference data with updated_by hidden from clients", () => {
    expect(sql).toContain("alter table public.form_templates enable row level security");
    expect(sql).toContain("create policy form_templates_select_all on public.form_templates");
    expect(sql).toContain("revoke all on public.form_templates from anon, authenticated");
    const grantStart = sql.indexOf("grant select (key, version");
    expect(grantStart, "column-scoped select grant must exist").toBeGreaterThan(-1);
    const grant = sql.slice(grantStart, sql.indexOf(";", grantStart));
    expect(grant, "admin identity stays hidden").not.toContain("updated_by");
    expect(sql, "no client write path").not.toMatch(
      /grant\s+[^;(]*\b(insert|update|delete)\b[^;]*on public\.form_templates[^;]*to (anon|authenticated)/i,
    );
  });

  it("keys are versioned with a single active-partial index", () => {
    expect(sql).toContain("primary key (key, version)");
    expect(sql).toContain("create index form_templates_active_sort_idx on public.form_templates (sort) where active");
  });
});

describe("admin write RPCs", () => {
  it("gates every writer on the admin role with pinned search_path", () => {
    for (const fn of ["upsert_form_template", "deactivate_form_template", "reactivate_form_template"]) {
      const def = body(fn);
      expect(def, `${fn} must check admin role`).toContain("member_has_role(array['admin'])");
      expect(def, `${fn} must pin search_path`).toContain("set search_path = ''");
      expect(def).toContain("security definer");
    }
  });

  it("upsert always mints a new version and deactivates the prior active row", () => {
    const upsert = body("upsert_form_template");
    expect(upsert).toContain("coalesce(max(version), 0) + 1");
    expect(upsert).toContain("set active = false");
    expect(upsert, "concurrent upserts must serialize per key").toContain("pg_advisory_xact_lock");
    expect(upsert).toContain("private.validate_form_template_schema(p_field_schema)");
    expect(upsert, "content is never edited in place").not.toMatch(/update public\.form_templates\s+set (label|blurb|icon|points|sort|field_schema)/i);
  });

  it("deactivate and reactivate touch only the current (max) version", () => {
    for (const fn of ["deactivate_form_template", "reactivate_form_template"]) {
      expect(body(fn)).toContain("version = (select max(version) from public.form_templates where key = p_key)");
      // Without the same per-key lock as upsert, a racing upsert can make the
      // max(version) subquery re-target the OLD version (EvalPlanQual) —
      // leaving two active rows (reactivate) or a lost deactivation.
      expect(body(fn), `${fn} must take the per-key advisory lock`).toContain(
        "pg_advisory_xact_lock(pg_catalog.hashtextextended('form-template-' || p_key, 509))",
      );
    }
    expect(sql, "templates are never deleted").not.toMatch(/delete from public\.form_templates/i);
  });

  it("revokes then grants execute to authenticated only", () => {
    expect(sql).toContain("revoke all on function private.validate_form_template_schema(jsonb) from public, anon, authenticated");
    for (const sig of [
      "public.upsert_form_template(text, text, text, text, text, text, integer, smallint, boolean, jsonb)",
      "public.deactivate_form_template(text)",
      "public.reactivate_form_template(text)",
    ]) {
      expect(sql).toContain(`revoke all on function ${sig} from public, anon`);
      expect(sql).toContain(`grant execute on function ${sig} to authenticated`);
    }
  });
});

describe("schema validator", () => {
  it("pins the FieldControl type allow-list, duplicate-key rejection, and bounds", () => {
    const validate = body("private.validate_form_template_schema");
    expect(validate).toContain("'text', 'textarea', 'date', 'select', 'radio', 'checkbox', 'multiselect', 'number'");
    expect(validate).toContain("duplicate field key");
    expect(validate).toContain("maxLength must be an integer 1-4000");
    expect(validate).toContain("1-12 steps");
    expect(validate).toContain("1-30 fields");
    expect(validate).toContain("1-40 options");
  });

  it("rejects validator-passing shapes that would crash the client", () => {
    const validate = body("private.validate_form_template_schema");
    // #>> stringifies objects/arrays to non-empty text, so every title/label
    // check must ALSO assert jsonb string type or React throws on the value.
    expect(validate).toContain("jsonb_typeof(step #> '{title,en}') is distinct from 'string'");
    expect(validate).toContain("jsonb_typeof(field #> '{label,en}') is distinct from 'string'");
    expect(validate).toContain("jsonb_typeof(opt #> '{label,en}') is distinct from 'string'");
    expect(validate).toContain("every step needs string title.en and title.es");
    expect(validate).toContain("needs string label.en and label.es");
    expect(validate).toContain("options need string label.en and label.es");
    // templateFromDbRow maps options when present, so a stray options value on
    // a text/date/number/checkbox field must be rejected server-side too.
    expect(validate).toContain("is not a choice type and must not carry options");
  });
});

describe("seed fidelity (one-time historical pin against the client source)", () => {
  const en = catalogue.en;
  const es = catalogue.es;
  const pair = (key) => ({ en: en[key], es: es[key] });
  const POINTS = {
    grievance: 25, alliance_grievance: 25, non_selection: 20,
    fmla_self: 15, fmla_family: 15, alt_work: 15, service_request: 10,
  };

  function seedJsonFor(key) {
    const pattern = new RegExp(
      `insert into public\\.form_templates \\(key, version, label_en, label_es, blurb_en, blurb_es, icon, points, active, sort, field_schema\\) values\\s*\\n\\s*\\('${key}', 1, .*?\\n\\s*'(\\{.*?\\})'::jsonb\\);`,
      "s",
    );
    const match = sql.match(pattern);
    expect(match, `seed insert for ${key} must exist`).toBeTruthy();
    return JSON.parse(match[1].replace(/''/g, "'"));
  }

  const LEFT_OUT_FIELDS = { grievance: ["articles"], alliance_grievance: ["articles"] };
  const LEFT_OUT_OPTIONS = { service_request: { category: ["dues"] } };
  // Union Ground's organizing seed-copy migration (database group,
  // 20261014013000) relabels the one field whose historical v1 seed and the
  // client catalogue differ. The historical seed is proven to carry Union
  // Ground's label, the relabel migration (when present in this tree) is
  // proven to write the organizing label, and that label then has to equal
  // the client source exactly like every other field.
  const SEED_COPY_MIGRATION = "supabase/migrations/20261014013000_unionground_organizing_seed_copy.sql";
  const seedCopy = existsSync(SEED_COPY_MIGRATION) ? readFileSync(SEED_COPY_MIGRATION, "utf8") : null;
  const RELABELED_FIELDS = {
    alliance_grievance: {
      affected: { historical: { en: "Affected members", es: "Miembros afectados" }, current: { en: "Affected workers", es: "Trabajadores afectados" } },
    },
  };

  // FIX-UG-FMLA-FORMS-GINA-NOTICE-AND-NO-DIAGNOSIS-HINT-20261022: the
  // two FMLA templates moved to a new platform seed version; the client source
  // now matches that seed, and version 1 keeps its original payload.
  const FMLA = new Set(["fmla_self", "fmla_family"]);
  const fmlaSql = loadMigrationSql("fmla_templates_gina_notice_seed_version");
  function fmlaSeedJsonFor(key) {
    const block = fmlaSql.split("insert into public.form_templates").find((part) => part.includes(`where s.key = '${key}' and s.version = 1 and s.is_platform_seed;`));
    expect(block, `new seed insert for ${key} must exist`).toBeTruthy();
    const json = block.slice(block.indexOf("'{") + 1, block.indexOf("}'::jsonb") + 1);
    return JSON.parse(json.replace(/''/g, "'"));
  }

  it("keeps the FMLA version-1 seeds' original reason and family-member fields", () => {
    const self = seedJsonFor("fmla_self").steps[0].fields[0];
    expect(self).toMatchObject({ key: "reason", label: { en: "Reason for leave", es: "Motivo de la licencia" } });
    const member = seedJsonFor("fmla_family").steps[0].fields[1];
    expect(member).toMatchObject({ key: "family_member", maxLength: 120, label: { en: en["forms.f.familyMember"], es: es["forms.f.familyMember"] } });
  });

  it("seeds all 7 templates at version 1 with the exact ported field schemas (FMLA: at the new seed version)", () => {
    for (const tpl of FORM_TEMPLATES) {
      const expected = {
        steps: tpl.steps.map((step) => ({
          title: pair(step.titleKey),
          fields: step.fields.map((field) => {
            const out = { key: field.key, type: field.type, label: pair(field.labelKey), required: Boolean(field.required) };
            if (field.maxLength != null) out.maxLength = field.maxLength;
            if (field.options) out.options = field.options.map((opt) => ({ value: opt.value, label: pair(opt.labelKey) }));
            return out;
          }),
        })),
      };
      const seeded = FMLA.has(tpl.key) ? fmlaSeedJsonFor(tpl.key) : seedJsonFor(tpl.key);
      // Contract articles and dues are left out of Union Ground: the two
      // static grievance templates no longer ask for "Article(s) cited", and
      // the service request no longer offers a "Dues / membership" category,
      // while the historical seed still carries each of them. Strip exactly
      // those (after proving each is there) and compare everything else exactly.
      for (const key of LEFT_OUT_FIELDS[tpl.key] ?? []) {
        const found = seeded.steps.flatMap((step) => step.fields).filter((field) => field.key === key);
        expect(found, `the historical ${tpl.key} seed carries one ${key} field`).toHaveLength(1);
        seeded.steps = seeded.steps.map((step) => ({ ...step, fields: step.fields.filter((field) => field.key !== key) }));
      }
      for (const [fieldKey, values] of Object.entries(LEFT_OUT_OPTIONS[tpl.key] ?? {})) {
        const field = seeded.steps.flatMap((step) => step.fields).find((candidate) => candidate.key === fieldKey);
        for (const value of values) {
          expect(field.options.map((option) => option.value), `the historical ${tpl.key}.${fieldKey} seed offers ${value}`).toContain(value);
        }
        field.options = field.options.filter((option) => !values.includes(option.value));
      }
      for (const [fieldKey, { historical, current }] of Object.entries(RELABELED_FIELDS[tpl.key] ?? {})) {
        const field = seeded.steps.flatMap((step) => step.fields).find((candidate) => candidate.key === fieldKey);
        expect(field?.label, `the historical ${tpl.key}.${fieldKey} seed label`).toEqual(historical);
        if (seedCopy) {
          expect(seedCopy, `the seed-copy migration relabels ${tpl.key}`).toContain(tpl.key);
          for (const label of [current.en, current.es]) expect(seedCopy).toContain(label);
        }
        field.label = current;
      }
      expect(seeded, `${tpl.key} schema must match the client source exactly`).toEqual(expected);
    }
  });

  it("asks for no contract article and offers no dues category on any static template", () => {
    for (const tpl of FORM_TEMPLATES) {
      for (const field of tpl.steps.flatMap((step) => step.fields)) {
        expect(field.key, `${tpl.key} still has an articles field`).not.toBe("articles");
        expect((field.options ?? []).map((option) => option.value), `${tpl.key}.${field.key} still offers dues`).not.toContain("dues");
      }
    }
  });

  it("seeds the live per-template point values and bilingual labels", () => {
    for (const tpl of FORM_TEMPLATES) {
      const labelEn = en[tpl.titleKey].replace(/'/g, "''");
      const labelEs = es[tpl.titleKey].replace(/'/g, "''");
      const row = sql.match(new RegExp(`\\('${tpl.key}', 1, '([^']*(?:''[^']*)*)', '([^']*(?:''[^']*)*)', .*?, (\\d+), true, (\\d+),`, "s"));
      expect(row, `${tpl.key} seed row`).toBeTruthy();
      expect(row[1]).toBe(labelEn);
      expect(row[2]).toBe(labelEs);
      expect(Number(row[3]), `${tpl.key} points`).toBe(POINTS[tpl.key]);
    }
  });
});
