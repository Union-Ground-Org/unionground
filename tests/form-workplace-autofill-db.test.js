// @vitest-environment node
//
// REQ-UG-FORMS-OFFER-WORKPLACE-AUTOFILL-20261030
//
// get_my_form_autofill returns only the caller's own values, and their work
// details only while shared with the organization; the preference writer and
// the accepted-fields record touch only the caller's own rows.
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROOF_FILES, assertDisposableProofUrl } from "../scripts/run-required-db-proofs.mjs";

const migration = readFileSync(
  new URL("../supabase/migrations/20261031130301_form_workplace_autofill.sql", import.meta.url),
  "utf8",
);
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));
const SIGS = [
  "public.get_my_form_autofill()",
  "public.set_my_form_autofill_preference(p_preference text)",
  "public.record_form_profile_autofill(p_form_id uuid, p_fields jsonb)",
];

describe("form workplace autofill (static)", () => {
  it("takes no user id, gates every routine on two-step sign-in, and pins each in the contract", () => {
    expect(migration).not.toMatch(/function public\.[a-z_]+\([^)]*p_user/);
    for (const sig of SIGS) {
      const entry = contract.functions.find((row) => row.sig === sig);
      expect(entry, sig).toMatchObject({ secdef: true, exec: "authenticated" });
      for (const needle of entry.bodyContains) expect(migration, `${sig}: ${needle}`).toContain(needle);
    }
    expect(migration).toContain("revoke all on function public.get_my_form_autofill() from public, anon, authenticated, service_role;");
  });

  it("is registered in the required database proof lane", () => {
    expect(PROOF_FILES).toContain("tests/form-workplace-autofill-db.test.js");
  });
});

const ID = {
  org: "50906642-0000-4000-8000-000000000001",
  member: "50906642-0000-4000-8000-000000000101",
  other: "50906642-0000-4000-8000-000000000102",
  form: "50906642-0000-4000-8000-000000000301",
  otherForm: "50906642-0000-4000-8000-000000000302",
};
const SESSION = {
  [ID.member]: "50906642-0000-4000-8000-000000000201",
  [ID.other]: "50906642-0000-4000-8000-000000000202",
};
const CHAPTER = "form-autofill-proof";
const live = process.env.SUPABASE_DB_URL ? describe : describe.skip;

live("form workplace autofill on a disposable database", () => {
  let db;

  async function as(userId, sql, values = [], aal = "aal2") {
    await db.query("savepoint as_user");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({
        sub: userId, role: "authenticated", session_id: SESSION[userId], aal,
      })]);
      await db.query("set local role authenticated");
      const rows = (await db.query(sql, values)).rows;
      await db.query("reset role");
      await db.query("select set_config('request.jwt.claims', '', true)");
      await db.query("release savepoint as_user");
      return rows;
    } catch (error) {
      await db.query("rollback to savepoint as_user");
      await db.query("reset role");
      await db.query("select set_config('request.jwt.claims', '', true)");
      throw error;
    }
  }
  const autofill = async (userId, aal) => (await as(userId, "select public.get_my_form_autofill() result", [], aal))[0].result;

  beforeAll(async () => {
    db = new pg.Client({ connectionString: assertDisposableProofUrl(process.env.SUPABASE_DB_URL), ssl: false, application_name: "form-workplace-autofill-proof" });
    await db.connect();
    await db.query("begin");
    await db.query("set local statement_timeout = '60s'");
    await db.query("set local lock_timeout = '15s'");
    for (const id of [ID.member, ID.other]) {
      await db.query("insert into auth.users(id, email) values ($1, $2)", [id, `autofill-${id.slice(-3)}@example.invalid`]);
      await db.query("insert into auth.sessions(id, user_id, aal, created_at, updated_at) values ($1, $2, 'aal2', now(), now())", [SESSION[id], id]);
      await db.query(
        `insert into auth.mfa_factors(id, user_id, friendly_name, factor_type, status, created_at, updated_at)
         values (gen_random_uuid(), $1, 'autofill-proof-totp', 'totp', 'verified', now(), now())`,
        [id],
      );
    }
    await db.query("insert into public.organizations(id, slug, name, created_by) values ($1, 'form-autofill-proof', 'Form autofill proof', $2)", [ID.org, ID.member]);
    await db.query("insert into public.chapters(id, name, slug, organization_id, is_default, order_index) values ($1, 'Garage 4', $1, $2, false, 9930)", [CHAPTER, ID.org]);
    for (const id of [ID.member, ID.other]) {
      await db.query("insert into public.organization_memberships(organization_id, user_id, status) values ($1, $2, 'active')", [ID.org, id]);
      await db.query("insert into public.member_chapter_memberships(user_id, chapter_id, status) values ($1, $2, 'active')", [id, CHAPTER]);
      await db.query("update public.member_profiles set chapter_id = $2 where id = $1", [id, CHAPTER]);
    }
    await db.query("insert into private.organization_local_profiles(organization_id, employer) values ($1, 'Metro Transit Authority')", [ID.org]);
    await db.query(
      `insert into public.member_profile_details(user_id, job_title, worksite, shift, classification, details_visibility)
       values ($1, 'Bus operator', 'North garage', 'Nights', 'Operator II', 'only_me'),
              ($2, 'Mechanic', 'South garage', 'Days', 'Mechanic I', 'admins')`,
      [ID.member, ID.other],
    );
    await db.query(
      `insert into public.member_forms(id, user_id, template_key, template_version, answers, step)
       values ($1, $3, 'grievance', 1, '{}'::jsonb, 0), ($2, $4, 'grievance', 1, '{}'::jsonb, 0)`,
      [ID.form, ID.otherForm, ID.member, ID.other],
    );
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  });

  it("returns the chapter and employer, and no work detail the member keeps to themselves", async () => {
    expect(await autofill(ID.member)).toEqual({
      preference: "ask",
      shared: false,
      values: { employer: "Metro Transit Authority", chapter: "Garage 4", jobTitle: null, worksite: null, shift: null, classification: null },
    });
  });

  it("returns the work details once the member shares them, and only their own", async () => {
    await db.query("update public.member_profile_details set details_visibility = 'admins' where user_id = $1", [ID.member]);
    const result = await autofill(ID.member);
    expect(result).toMatchObject({ shared: true, values: { jobTitle: "Bus operator", worksite: "North garage", shift: "Nights", classification: "Operator II" } });
    expect(JSON.stringify(result)).not.toContain("Mechanic");
    expect((await autofill(ID.other)).values).toMatchObject({ jobTitle: "Mechanic", worksite: "South garage" });
  });

  it("keeps the member's own preference and refuses an unknown one", async () => {
    expect((await as(ID.member, "select public.set_my_form_autofill_preference('always') result"))[0].result).toEqual({ preference: "always" });
    expect((await autofill(ID.member)).preference).toBe("always");
    expect((await autofill(ID.other)).preference).toBe("ask");
    await expect(as(ID.member, "select public.set_my_form_autofill_preference('sometimes')")).rejects.toMatchObject({ code: "22023" });
  });

  it("records accepted fields and kinds on the member's own draft only", async () => {
    const record = (formId, fields) => as(ID.member, "select public.record_form_profile_autofill($1, $2::jsonb) result", [formId, JSON.stringify(fields)]);
    const recorded = (await record(ID.form, { job_title: "jobTitle", local: "chapter" }))[0].result;
    expect(recorded).toEqual({ formId: ID.form, fields: { job_title: "jobTitle", local: "chapter" } });
    expect((await db.query("select profile_autofill from public.member_forms where id = $1", [ID.form])).rows[0].profile_autofill).toEqual({ job_title: "jobTitle", local: "chapter" });
    expect((await record(ID.form, {}))[0].result.fields).toEqual({});
    await expect(record(ID.otherForm, { local: "chapter" })).rejects.toMatchObject({ code: "P0002" });
    await expect(record(ID.form, { phone: "phone" })).rejects.toMatchObject({ code: "22023" });
    await expect(record(ID.form, { "bad key": "chapter" })).rejects.toMatchObject({ code: "22023" });
    await expect(record(ID.form, { a: "chapter", b: "chapter" })).rejects.toMatchObject({ code: "22023" });
    await expect(as(ID.member, "select public.record_form_profile_autofill($1, '[]'::jsonb)", [ID.form])).rejects.toMatchObject({ code: "22023" });
    await db.query("update public.member_forms set status = 'submitted', submitted_at = now() where id = $1", [ID.form]);
    await expect(record(ID.form, { local: "chapter" })).rejects.toMatchObject({ code: "P0002" });
  });

  it("refuses without two-step sign-in", async () => {
    await expect(autofill(ID.member, "aal1")).rejects.toMatchObject({ code: "42501" });
    await expect(as(ID.member, "select public.set_my_form_autofill_preference('never')", [], "aal1")).rejects.toMatchObject({ code: "42501" });
  });
});
