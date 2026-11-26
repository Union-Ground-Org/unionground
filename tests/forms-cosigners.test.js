// @vitest-environment node
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql } from "./helpers/migration.js";

// Text pins are a tripwire, not a proof: they assert what THIS MIGRATION SAYS,
// not what the database ENDS UP WITH. A later create-or-replace can supersede
// every guard below and this file stays green. Current-state truth lives in
// scripts/db-contract.json, checked by `npm run verify:db`.
//
// Superseded here: save_form_draft, redefined by 20260723112000_member_forms_
// template_registry_fk after this migration wrote it.

const sql = loadMigrationSql("alliance_cosigners");
const body = (functionName) => fnBody(sql, functionName);

function policy(name) {
  const start = sql.indexOf(`create policy ${name}`);
  expect(start, `${name} policy must exist`).toBeGreaterThan(-1);
  return sql.slice(start, sql.indexOf(";", start));
}

describe("alliance co-signers migration invariants", () => {
  // ---- ledger + grants -----------------------------------------------------
  it("creates the ledger with RLS on and no client write grant", () => {
    expect(sql).toContain("create table if not exists public.member_form_cosigners");
    expect(sql).toContain("alter table public.member_form_cosigners enable row level security");
    expect(sql).toContain("grant select on public.member_form_cosigners to authenticated");
    // definer RPCs are the only writers — no insert/update/delete grant to clients
    expect(sql).not.toMatch(
      /grant [^;]*(insert|update|delete)[^;]*on public\.member_form_cosigners[^;]*to (anon|authenticated)/i,
    );
    // one invite per email per form
    expect(sql).toContain("unique (form_id, invited_email)");
    // status domain is the closed consent lifecycle
    expect(sql).toContain("status in ('invited','accepted','declined','reaffirm_needed','withdrawn')");
  });

  // ---- anti-recursion: cross-table RLS checks must be SECURITY DEFINER ------
  it("routes every cross-table RLS check through a SECURITY DEFINER helper (no 42P17 recursion)", () => {
    for (const fn of [
      "public.form_is_owned_by_caller",
      "public.caller_is_accepted_cosigner",
      "public.form_is_alliance_reviewable",
    ]) {
      const def = body(fn);
      expect(def, `${fn} must be security definer`).toContain("security definer");
      expect(def, `${fn} must pin search_path`).toContain("set search_path = ''");
    }
  });

  // ---- the HIGH-risk cross-member read -------------------------------------
  it("scopes the cross-member grievance read to alliance_grievance + accepted co-signer only", () => {
    const p = policy("member_forms_select_cosigner");
    expect(p).toContain("for select to authenticated");
    expect(p).toContain("template_key = 'alliance_grievance'");
    expect(p).toContain("public.caller_is_accepted_cosigner(id)");
    // must NOT widen to other templates or bypass the accepted gate
    expect(p).not.toContain("or true");
  });

  it("the accepted-cosigner gate requires status='accepted' and the caller's own id", () => {
    const def = body("public.caller_is_accepted_cosigner");
    expect(def).toContain("cosigner_user_id = (select auth.uid())");
    expect(def).toContain("status = 'accepted'");
  });

  // ---- invitee / filer / steward read policies -----------------------------
  it("invitee reads only their own invite (by id or JWT email), never siblings", () => {
    const p = policy("member_form_cosigners_select_invitee");
    expect(p).toContain("cosigner_user_id = (select auth.uid())");
    expect(p).toContain("pg_catalog.lower(invited_email) = pg_catalog.lower(coalesce((select auth.email()), ''))");
  });

  it("steward sees accepted co-signers only, and only on reviewable alliance forms", () => {
    const p = policy("member_form_cosigners_select_steward");
    expect(p).toContain("status = 'accepted'");
    expect(p).toContain("public.member_has_role(array['steward'])");
    expect(p).toContain("public.form_is_alliance_reviewable(form_id)");
  });

  // ---- D1: uniform-success invite, no membership oracle --------------------
  it("invite_cosigner never persists the resolved member id at invite time (D1 membership oracle)", () => {
    const fn = body("public.invite_cosigner");
    // resolution is local, for notification only
    expect(fn).toContain("select id into target from auth.users where pg_catalog.lower(email) = norm");
    // inserted / re-invited rows carry a NULL cosigner_user_id
    expect(fn).toContain("values (p_form_id, norm, null, caller)");
    expect(fn).toContain("set status='invited', cosigner_user_id=null");
    // uniform success regardless of membership
    expect(fn).toContain("return pg_catalog.jsonb_build_object('status','invited')");
    // members notified, non-members inert
    expect(fn).toContain("if target is not null then");
    // guards
    expect(fn).toContain("you cannot invite yourself");
    expect(fn).toContain("co-signer limit reached (max 10)");
    expect(fn).toContain("frec.template_key <> 'alliance_grievance'");
  });

  // ---- D2: summary-only preview, no PII ------------------------------------
  it("cosign_invite_preview exposes only the summary + filer name, never narrative/remedy/affected", () => {
    const fn = body("public.cosign_invite_preview");
    expect(fn).toContain("frec.answers->>'summary'");
    for (const preview of [fn, fnBody(loadMigrationSql("mfa_guard_cosign_rpcs"), "public.cosign_invite_preview")]) {
      expect(preview).not.toMatch(/\b(?:insert|update|delete|merge|perform|execute|call)\b/i);
    }
    expect(fn).toContain("'filerName'");
    // the pre-accept preview must not surface the private grievance body
    expect(fn).not.toContain("answers->>'narrative'");
    expect(fn).not.toContain("answers->>'remedy'");
    expect(fn).not.toContain("answers->>'affected'");
  });

  // ---- respond / withdraw --------------------------------------------------
  it("respond_to_cosign stamps the id only on accept and notifies the filer", () => {
    const fn = body("public.respond_to_cosign");
    expect(fn).toContain("case when p_accept then 'accepted' else 'declined' end");
    expect(fn).toContain("cosigner_user_id = case when p_accept then caller else cosigner_user_id end");
    expect(fn).toContain("status in ('invited','reaffirm_needed')"); // only pending/reaffirm respondable
    expect(fn).toContain("'Co-signer accepted'");
  });

  it("withdraw_cosign flips an accepted co-signature to withdrawn (D7)", () => {
    const fn = body("public.withdraw_cosign");
    expect(fn).toContain("and cosigner_user_id = caller and status = 'accepted'");
    expect(fn).toContain("set status = 'withdrawn'");
  });

  // ---- D4: bait-and-switch reaffirm ----------------------------------------
  it("save_form_draft resets accepted co-signers to reaffirm_needed on a real edit (D4)", () => {
    const fn = body("public.save_form_draft");
    expect(fn).toContain("p_template_key = 'alliance_grievance' and clean is distinct from prev_answers");
    expect(fn).toContain("set status='reaffirm_needed'");
    expect(fn).toContain("where form_id=existing and status='accepted'");
    // still a member-self writer with the advisory lock intact
    expect(fn).toContain("pg_advisory_xact_lock");
  });

  // ---- progress notice -----------------------------------------------------
  it("notifies accepted co-signers when the grievance is approved", () => {
    const fn = body("private.notify_cosigners_on_approve");
    expect(fn).toContain("c.status = 'accepted'");
    expect(fn).toContain("'Group workplace issue approved'");
    expect(sql).toContain("when (new.template_key = 'alliance_grievance' and new.status = 'approved'");
  });

  // ---- grants on the new RPCs ----------------------------------------------
  it("grants execute on all four co-signer RPCs to authenticated only", () => {
    for (const sig of [
      "public.invite_cosigner(uuid, text)",
      "public.respond_to_cosign(uuid, boolean)",
      "public.cosign_invite_preview(uuid)",
      "public.withdraw_cosign(uuid)",
    ]) {
      expect(sql).toContain(`revoke all on function ${sig} from public, anon`);
      expect(sql).toContain(`grant execute on function ${sig} to authenticated`);
    }
  });
});
