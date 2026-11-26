// @vitest-environment node
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql } from "./helpers/migration.js";
import { offlinePostgres, postgresBin } from "./tamarack-postgres-helper.mjs";

const owner = "11111111-1111-4111-8111-111111111111";
const other = "99999999-9999-4999-8999-999999999999";
const zeroId = "44444444-4444-4444-8444-444444444444";
const signedId = "33333333-3333-4333-8333-333333333333";
const retired = loadMigrationSql("unionground_safe_recognition");
const submitSql = loadMigrationSql("forms_signature_only_on_signed_statements");
const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

// Native PostgreSQL, isolated Unix socket, no hosted database or network.
// Auth/signature/attachment prerequisites are fixture helpers; the submission,
// ownership, signature checks and retired-award behavior come from the shipped SQL.
describe.skipIf(!postgresBin)("zero-point form submission in PostgreSQL", () => {
  let db;
  const query = async (sql, args = []) => (await db.client.query(sql, args)).rows;
  async function form(id, template, user = owner) {
    await query("insert into public.member_forms(id,user_id,status,template_key,template_version,answers) values($1,$2,'draft',$3,1,'{}')", [id, user, template]);
    await query("insert into private.member_form_signatures values($1,'filer',$2,'fixture-digest','fixture-signature','[]')", [id, user]);
  }
  const submit = async id => (await query("select public.submit_form($1) result", [id]))[0].result;
  beforeAll(async () => {
    db = await offlinePostgres({ durable: false });
    await query(`
      create schema private; create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select '${owner}'::uuid $$;
      create function private.lock_case_graph(uuid[],uuid[]) returns void language sql as $$ select $$;
      create function private.mfa_satisfied() returns boolean language sql as $$ select true $$;
      create function private.lock_member_form(uuid) returns void language sql as $$ select $$;
      create function private.current_member_organization() returns uuid language sql as $$ select '22222222-2222-4222-8222-222222222222'::uuid $$;
      create function private.form_content_digest(uuid) returns text language sql as $$ select 'fixture-digest' $$;
      create function private.form_signature_digest(text,uuid,jsonb) returns text language sql as $$ select 'fixture-signature' $$;
      create function private.form_required_keys(text,integer) returns text[] language sql as $$ select '{}'::text[] $$;
      create function private.private_upload_is_current(text,text) returns boolean language sql as $$ select true $$;
      create table public.member_point_events(id uuid default gen_random_uuid(),user_id uuid,action_key text,action_kind text,points integer not null check(points between 1 and 100),occurred_at timestamptz default now(),unique(user_id,action_key));
      create table public.member_forms(id uuid primary key,user_id uuid,status text,template_key text,template_version integer,answers jsonb,encrypted_content jsonb,submitted_at timestamptz,review_note text,content_digest text,updated_at timestamptz);
      create table public.member_form_files(id uuid,form_id uuid,deletion_requested_at timestamptz,confirmed_at timestamptz,bucket_id text,object_name text);
      create table private.member_form_signatures(form_id uuid,signer_kind text,signer_user_id uuid,content_digest text,signature_digest text,strokes jsonb);
      create table public.member_action_log(user_id uuid,action_key text,action_kind text,unique(user_id,action_key));
      create function private.form_template_is_sealed(text) returns boolean language sql as $$ select false $$;
    `);
    await query(fnBody(submitSql, "private.form_template_requires_signature"));
    await query(fnBody(submitSql, "public.submit_form"));
  }, 30000);
  afterAll(async () => { if (db) await db.close(); });
  beforeEach(async () => { await query("begin"); });
  afterEach(async () => { await query("rollback"); });

  it("submits a zero-point form, retains the action and mints no point event", async () => {
    await form(zeroId, "zero_form");
    expect(await submit(zeroId)).toEqual({ status: "submitted", awardedPoints: 0 });
    expect(await query("select status from public.member_forms where id=$1", [zeroId])).toEqual([{ status: "submitted" }]);
    expect(await query("select action_key from public.member_action_log")).toEqual([{ action_key: `form-${zeroId}` }]);
    expect(await query("select * from public.member_point_events")).toEqual([]);
  });

  it("keeps the action log idempotent when a returned form is resubmitted", async () => {
    await form(signedId, "signed_form");
    expect(await submit(signedId)).toEqual({ status: "submitted", awardedPoints: 0 });
    await query("update public.member_forms set status='returned' where id=$1", [signedId]);
    expect(await submit(signedId)).toEqual({ status: "submitted", awardedPoints: 0 });
    expect(await query("select * from public.member_point_events")).toEqual([]);
    expect(await query("select count(*)::int count from public.member_action_log")).toEqual([{ count: 1 }]);
  });

  it("creates no awards from unbacked, draft or other-worker form actions", async () => {
    await form(zeroId, "signed_form");
    await form(signedId, "signed_form", other);
    await query("update public.member_forms set status='submitted' where id=$1", [signedId]);
    for (const key of [`form-${zeroId}`, `form-${signedId}`, "form-absent", "not-a-form"]) {
      await query("insert into public.member_action_log values($1,$2,'form')", [owner, key]);
    }
    expect(await query("select * from public.member_point_events")).toEqual([]);
  });

  it("retains submission ownership and signature guards", async () => {
    await form(signedId, "signed_form", other);
    await expect(submit(signedId)).rejects.toMatchObject({ code: "22023" });
    await query("rollback; begin");
    await form(zeroId, "zero_form");
    await query("delete from private.member_form_signatures");
    await expect(submit(zeroId)).rejects.toMatchObject({ code: "22023" });
  });

  it("keeps the retirement and pins the live submission definition", async () => {
    expect(retired).toContain("drop trigger if exists member_action_log_award_points");
    expect(retired).toContain("drop function if exists private.award_member_points()");
    expect(contract.functions.find((row) => row.sig === "private.award_member_points()")).toBeUndefined();
    const hash = (await query("select md5(pg_get_functiondef('public.submit_form(uuid,jsonb)'::regprocedure)) hash"))[0].hash;
    expect(contract.functions.find((row) => row.sig === "public.submit_form(p_form_id uuid, p_expected jsonb)")?.bodyMd5).toBe(hash);
  });
});
