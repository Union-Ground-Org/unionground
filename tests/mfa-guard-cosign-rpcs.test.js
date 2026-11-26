import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";

// Text pins are a tripwire, not a proof: they assert what THIS MIGRATION SAYS.
// The live-DB backstop is scripts/db-contract.json — both the per-function
// bodyContains needles AND the mfaCoverage sweep (every SECURITY DEFINER RPC
// reachable by authenticated is guarded or exempt), checked by `npm run
// verify:db`. REQ-UG-DEFINER-MFA-AUDIT batch 3 of 4 (cosign).

const sql = loadMigrationSql("mfa_guard_cosign_rpcs");

// Pins run on code with comments stripped (line, block, and trailing alike)
// so the header and the per-function "Assurance term added" comments cannot
// satisfy a load-bearing assertion. fnBody pins the exact function on its
// argument list: without that a hypothetical <name>_v2 placed earlier in the
// file would be silently matched instead.
const rpcBody = (name) => stripComments(fnBody(sql, name));

// All four co-sign RPCs are MEMBER RPCs bound to the caller's own rows; none is
// steward-gated, so all four take the member-style term private.mfa_satisfied().
const MEMBER_RPCS = ["invite_cosigner", "respond_to_cosign", "withdraw_cosign", "cosign_invite_preview"];

describe("cosign member RPCs force MFA step-up", () => {
  for (const rpc of MEMBER_RPCS) {
    describe(rpc, () => {
      const body = rpcBody(rpc);

      it("combines the assurance term into the existing caller guard", () => {
        expect(body).toMatch(/if caller is null or not private\.mfa_satisfied\(\) then/);
        expect(body).toContain("using errcode = '42501'");
      });

      it("leaves no bare 'if caller is null then' guard behind", () => {
        // The combined form does not match this; a leftover bare guard would.
        expect(body).not.toMatch(/if caller is null then/);
      });

      it("stays a definer function with an empty search_path (attributes pinned)", () => {
        // Attribute pins only — byte-level body preservation is proven by the
        // md5 chain in the migration header, not by these substrings.
        expect(body).toContain("SECURITY DEFINER");
        expect(body).toContain("SET search_path TO ''");
      });
    });
  }
});

describe("cosign_invite_preview guards before it discloses", () => {
  const body = rpcBody("cosign_invite_preview");

  it("places the MFA guard before the invitation lookup and both table reads", () => {
    // This is the family's one DISCLOSURE rpc (filer name + summary to the
    // invitee). The guard must fire before anything is read, and the
    // invitation-ownership check must still precede the member_forms /
    // member_profiles reads.
    const guardAt = body.search(/if caller is null or not private\.mfa_satisfied\(\) then/);
    const inviteLookupAt = body.indexOf("from public.member_form_cosigners");
    const formReadAt = body.indexOf("from public.member_forms");
    const profileReadAt = body.indexOf("from public.member_profiles");
    expect(guardAt).toBeGreaterThan(-1);
    expect(inviteLookupAt).toBeGreaterThan(guardAt);
    expect(formReadAt).toBeGreaterThan(inviteLookupAt);
    expect(profileReadAt).toBeGreaterThan(inviteLookupAt);
  });

  it("keeps the invitation-ownership refusal (body preserved)", () => {
    expect(body).toContain("'no co-sign invitation for you on this form'");
    expect(body).toContain("using errcode='22023'");
  });
});

describe("db-contract records the coverage backstop after batch 3", () => {
  const contract = JSON.parse(readFileSync(resolve(process.cwd(), "scripts/db-contract.json"), "utf8"));
  const cov = contract.mfaCoverage;

  it("no longer exempts OR defers the four now-guarded cosign RPCs", () => {
    // They are covered by the guard, so they must not appear on either escape
    // list — otherwise a future guard removal would be silently tolerated.
    for (const rpc of MEMBER_RPCS) {
      expect(Object.keys(cov.exempt)).not.toContain(rpc);
      expect(Object.keys(cov.pending || {})).not.toContain(rpc);
    }
  });

  it("pins the full guard shape as bodyContains needles on each cosign RPC", () => {
    // The bare term "private.mfa_satisfied()" is satisfiable by a neutered
    // guard (or->and flip, dead conjunct, value-ignored perform). The needle
    // must be the whole guard line, plus the errcode to catch dead-raise
    // removal (batch-3 review, HIGH->MED adjudicated).
    for (const rpc of MEMBER_RPCS) {
      const entry = contract.functions.find((f) => f.sig.startsWith(`public.${rpc}(`));
      expect(entry, `${rpc} must have a contract entry`).toBeTruthy();
      expect(entry.bodyContains, `${rpc} must pin the guard shape`)
        .toContain("if caller is null or not private.mfa_satisfied() then");
      expect(entry.bodyContains, `${rpc} must pin the raise`)
        .toContain("using errcode = '42501'");
    }
  });

  it("no longer defers the capability trio — batch 4 drained the ratchet", () => {
    // Batch 4 pins the pending list EXACTLY EMPTY in its own test; here we
    // assert the once-pending names can never quietly re-enroll.
    const pending = Object.keys(cov.pending || {});
    for (const rpc of ["submit_workload_log", "save_member_guide_exchange", "revoke_calendar_feed_token"]) {
      expect(pending, `${rpc} is guarded (batch 4) and must not be re-deferred`).not.toContain(rpc);
    }
  });

  it("pins the exempt list as an exact set — growth requires a deliberate test edit", () => {
    // Without this pin, a future unguarded RPC could enroll itself exempt in
    // the same commit with only a self-authored justification string and no
    // failing check anywhere (batch-3 review).
    const exempt = Object.keys(cov.exempt || {});
    const expected = [
      "verify_ballot_receipt", "get_ballot_tally",
      "get_public_site_content",
      "get_public_directory",
      "get_public_event_detail",
      "get_public_chapter_microsite",
      // Union catalog read RPCs (20260925950000): public-record rows only, bounded, intentionally anonymous.
      "get_union_catalog_status", "search_union_catalog", "get_union_catalog_profile",
      //: the same bounded public-record readers with explicit locale filters.
      "search_union_catalog_by_country", "get_union_catalog_profile_by_country",
      // Organization landing read (20260930040000): verification state and catalog placement only.
      "get_organization_public_verification",
      "get_member_rewards_summary",
      // REQ-UG-MEMBER-REFERRAL-ATTRIBUTION-20261110: the same ordinary-member self read as
      // get_member_rewards_summary. Parameterless, every predicate from auth.uid(); returns only the caller's own referral
      // code and own aggregate count of referrals this year, never another member's row or identity. Any member without
      // staff power reaches it from Rewards; an MFA guard would hide an AAL1 member's own code.
      "get_member_referral_summary",
      // REQ-UG-RELEASE-HOLD-ON-ENTRY-SCREEN-CONTROLS-20261112: the sign-in screens'
      // release read runs before anyone signs in. Three booleans from three definition rows; no member content.
      "get_entry_screen_release_state",
      // REQ-UG-PUBLIC-PAGE-SECTION-SWITCHES-AND-SIGN-IN-DESIGNS-2-TO-4-20261117: the signed-out
      // pages' section release read. Names of released features.public_pages.* sections only; no member content.
      "get_public_section_release_state",
      // Ordinary-member, non-sensitive cosmetic selection: every selection and earned-item check is scoped to auth.uid() and the confirmed active organization, under the case-graph lock. Members need no enrolled MFA factor to choose or remove their own earned theme, badge or icon; private.free_cosmetic_context still enforces the existing session/MFA policy where applicable. No administrative grant or other member's selection is exposed.
      "set_free_cosmetic",
      "get_mfa_recovery_code_status",
      "get_my_mfa_requirement",
      "claim_mfa_recovery_code",
      "delete_my_native_push_installation",
      "prepare_my_signout",
      "caller_is_accepted_cosigner",
      //  (20261102005607) guards staff_can_see_user with the MFA term, so
      // it leaves this list.
      "form_is_owned_by_caller", "form_owner_in_steward_scope",
    ];
    expect(exempt.sort()).toEqual(expected.sort());
  });
});

// ---------------------------------------------------------------------------
// Design wire-in step 2 (2026-07-28). Two later migrations re-emit members of
// this family: 20260728220954 adds the 30-day re-invite cooldown to
// invite_cosigner, and 20260728221544 (the notification copy sweep) re-emits
// invite_cosigner, respond_to_cosign, withdraw_cosign AND save_form_draft to
// route their notices through private.notify_member.
//
// The sweep is exactly where this campaign nearly shipped a regression: the
// package's copies were stale pre-2026-07-25 bodies missing the MFA guards and
// the cooldown, and every pin above reads only the 20260725190000 file — a pin
// on a superseded generation stays green forever (append-only lesson: the
// decisive assertion is on the FINAL state). Everything below therefore pins
// the LAST emitter, found by scanning the whole chain, not a hardcoded file.
// ---------------------------------------------------------------------------

const SWEEP_FILE = "20260728221544_notification_copy_sweep.sql";
const FORM_CONCURRENCY_FILE = "20260812222529_form_filing_concurrency.sql";
// The FMLA seed-version delivery (20261022192718) re-emitted save_form_draft
// so organization copies outrank newer platform seeds; the sealed FMLA
// delivery re-emits it again to refuse sealed templates . Its MFA
// guard, signature reset and notice stay intact.
const SEALED_FORMS_FILE = "20261028174500_sealed_fmla_form_answers.sql";
//  re-emits save_form_draft with an optional expected form id checked
// under the form lock; the guard, signature reset and notice stay.
const EXPECTED_REVIEW_FILE = "20261113114500_sign_member_form_expected_review.sql";
// Typed signatures  replace respond_to_cosign with a version that takes
// an optional typed name; its MFA guard and notice stay intact.
const TYPED_SIGNATURE_FILE = "20261113120500_forms_typed_signature.sql";
//  re-emits respond_to_cosign with an optional expected review digest
// checked under the form lock, and cosign_invite_preview to return that digest;
// the guards, the case-graph entry and the notice stay.
const COSIGN_REVIEW_FILE = "20261113122700_cosign_preview_review_digest.sql";
//  re-emits it again with an optional base, the answers the client last
// knew to be stored; the guard, signature reset and notice stay.
const BASE_ANSWERS_FILE = "20261113134400_save_form_draft_base_answers.sql";
const cooldownSql = loadMigrationSql("cosign_decline_cooldown");
const sweepSql = loadMigrationSql("notification_copy_sweep");
const REEMITTED = ["invite_cosigner", "respond_to_cosign", "withdraw_cosign", "save_form_draft"];
const FINAL_EMITTER = {
  invite_cosigner: FORM_CONCURRENCY_FILE,
  respond_to_cosign: COSIGN_REVIEW_FILE,
  withdraw_cosign: FORM_CONCURRENCY_FILE,
  save_form_draft: BASE_ANSWERS_FILE,
};
// These are pg_get_functiondef hashes captured after transaction-applying the
// official-delivery migration to the local reference schema. That emitter uses
// ordinary $$ source quoting, not pg_get_functiondef's normalized $function$
// form, so an offline text hash would pin a representation Postgres never
// returns. verify:db independently compares these values to the live catalog.
// The 041000 case-graph wrapper preserves the last declared source verbatim
// inside its first-acquisition block. These final installed-definition pins
// include that block; the lock inventory verifies each original source hash.
const FINAL_BODY_MD5 = {
  invite_cosigner: "ee80002205578c6a7000db00fe1ce719",
  respond_to_cosign: "e3eefd7920ed0ac179b5595f8d910a9d",
  withdraw_cosign: "75c7da0d3f4b58291e7d68ebf555044e",
  save_form_draft: "676990840ef522a137d96c250523c5cc",
};

// Every migration that DECLARES the function (comments stripped, so a file
// that merely talks about one does not count), in apply order.
function emittersOf(name) {
  const pattern = new RegExp(
    `create\\s+(?:or\\s+replace\\s+)?function\\s+(?:public\\.)?${name}\\s*\\(`,
    "i",
  );
  return migrationFiles().filter((entry) => pattern.test(stripComments(entry.sql))).map((entry) => entry.name);
}

function finalSqlFor(rpc) {
  const file = migrationFiles().find((entry) => entry.name === FINAL_EMITTER[rpc]);
  expect(file, `${rpc}'s final emitter must exist`).toBeTruthy();
  return file.sql;
}

describe("the contract follows each RPC's actual LAST emitter", () => {
  it.each(REEMITTED)("%s's final declaration is explicitly pinned", (rpc) => {
    const chain = emittersOf(rpc);
    expect(chain.length, `${rpc} must be declared somewhere`).toBeGreaterThan(0);
    // If this fails because a NEWER migration re-emitted the function, move
    // every final-state assertion below onto that file — do not delete them.
    expect(chain[chain.length - 1]).toBe(FINAL_EMITTER[rpc]);
  });

  it("re-emits save_form_draft after the sealed-template refusal, so the final body keeps it", () => {
    const chain = emittersOf("save_form_draft");
    expect(chain.indexOf(SEALED_FORMS_FILE)).toBeGreaterThan(-1);
    expect(chain.indexOf(SEALED_FORMS_FILE)).toBeLessThan(chain.indexOf(EXPECTED_REVIEW_FILE));
    expect(chain.indexOf(EXPECTED_REVIEW_FILE)).toBeLessThan(chain.indexOf(BASE_ANSWERS_FILE));
    expect(stripComments(fnBody(finalSqlFor("save_form_draft"), "save_form_draft")))
      .toContain("raise exception 'sealed form templates save through the sensitive content API' using errcode = '22023'");
  });

  it("orders the cooldown before the sweep, so the sweep body is the one that must carry it", () => {
    const chain = emittersOf("invite_cosigner");
    expect(chain).toContain("20260728220954_cosign_decline_cooldown.sql");
    expect(chain.indexOf("20260728220954_cosign_decline_cooldown.sql"))
      .toBeLessThan(chain.indexOf(SWEEP_FILE));
  });
});

describe("the cooldown branch exists in BOTH emissions of invite_cosigner", () => {
  // 20260728220954 introduces it; 20260728221544 re-emits the function and is
  // what production actually runs. Losing the branch in the re-emission is the
  // exact regression the stale package would have shipped.
  it.each([
    ["20260728220954 (introduction)", cooldownSql],
    ["20260728221544 (final emission)", sweepSql],
  ])("%s carries the 30-day re-invite cooldown", (_label, sql) => {
    const body = stripComments(fnBody(sql, "invite_cosigner"));
    expect(body).toContain("cooldown constant interval := interval '30 days'");
    expect(body).toContain("select id, status, responded_at into existing");
    expect(body).toContain("existing.responded_at + cooldown > now()");
    expect(body).toContain("you can ask again after");
    // The refusal must RAISE (22023), never return the uniform 'invited' —
    // returning it would tell the filer an invitation was sent.
    expect(body).toMatch(/you can ask again after[\s\S]{0,200}using errcode='22023'/);
  });
});

describe("all four final regenerated bodies keep their MFA guards", () => {
  for (const rpc of REEMITTED) {
    describe(rpc, () => {
      const body = stripComments(fnBody(finalSqlFor(rpc), rpc));

      it("still combines the assurance term into the caller guard", () => {
        expect(body).toMatch(/if caller is null or not private\.mfa_satisfied\(\) then/);
        expect(body).toContain("using errcode = '42501'");
      });

      it("leaves no bare 'if caller is null then' guard behind", () => {
        expect(body).not.toMatch(/if caller is null then/);
      });

      it("swaps the notice onto private.notify_member and nothing else", () => {
        expect(body).toContain("private.notify_member(");
        // The direct insert is exactly what the sweep exists to remove; its
        // presence would mean a stale body was pasted back in.
        expect(body).not.toContain("insert into public.member_notifications");
      });
    });
  }
});

describe("the contract's bodyMd5 pins are computed from the FINAL emissions", () => {
  // scripts/verify-db-contract.mjs pins md5(pg_get_functiondef(oid)) — the
  // whole definition, original case, comments included, plus the trailing
  // newline pg_get_functiondef emits. The sweep writes its four bodies in
  // pg_get_functiondef form precisely so this offline recomputation equals the
  // post-apply live value (the same construction proved the 20260725190000
  // pins). If this fails, either a body changed without a re-pin, or the
  // contract was re-pinned against something other than the last emitter.
  const contract = JSON.parse(readFileSync(resolve(process.cwd(), "scripts/db-contract.json"), "utf8"));

  it.each(REEMITTED)("%s bodyMd5 equals md5 of its final definition", (rpc) => {
    const entry = contract.functions.find((f) => f.sig.startsWith(`public.${rpc}(`));
    expect(entry?.bodyMd5, `${rpc} must carry a bodyMd5 pin`).toBeTruthy();
    if (FINAL_EMITTER[rpc] !== SWEEP_FILE) {
      expect(entry.bodyMd5).toBe(FINAL_BODY_MD5[rpc]);
      return;
    }
    const statement = fnBody(finalSqlFor(rpc), `public.${rpc}`);
    expect(statement.endsWith("$function$;"), "offline hashing requires pg_get_functiondef quoting").toBe(true);
    const md5 = createHash("md5").update(`${statement.slice(0, -1)}\n`).digest("hex");
    expect(md5).toBe(entry.bodyMd5);
  });
});

describe("respond_to_cosign's final emission keeps the typed signature (#8701) under the review digest (#8703)", () => {
  it("re-emits after the typed-signature migration and keeps its typed-name branch", () => {
    const chain = emittersOf("respond_to_cosign");
    expect(chain.indexOf(TYPED_SIGNATURE_FILE)).toBeGreaterThan(-1);
    expect(chain.indexOf(TYPED_SIGNATURE_FILE)).toBe(chain.indexOf(COSIGN_REVIEW_FILE) - 1);
    const body = stripComments(fnBody(finalSqlFor("respond_to_cosign"), "respond_to_cosign"));
    expect(body).toContain("p_typed_name text default null, p_expected_digest text default null");
    expect(body).toContain("signed_name := private.normalize_form_typed_signature(p_typed_name);");
    expect(body).toContain("private.form_signature_digest(current_digest, inv.id, material)");
  });
});

describe("cosign_invite_preview's final emission keeps its guards and only adds the review digest (#8703)", () => {
  const body = stripComments(fnBody(loadMigrationSql("cosign_preview_review_digest"), "public.cosign_invite_preview"));
  const contract = JSON.parse(readFileSync(resolve(process.cwd(), "scripts/db-contract.json"), "utf8"));

  it("is the last migration that declares it, and the contract pins that definition", () => {
    const chain = emittersOf("cosign_invite_preview");
    expect(chain[chain.length - 1]).toBe(COSIGN_REVIEW_FILE);
    const entry = contract.functions.find((f) => f.sig === "public.cosign_invite_preview(p_form_id uuid)");
    // The pin is this edition's final definition as the live replay hashed it
    // (its comments differ from upstream's, so upstream's md5 cannot match);
    // verify-db-contract compares it with the database.
    expect(entry.bodyMd5).toMatch(/^[0-9a-f]{32}$/);
    expect(entry.bodyMd5).not.toBe("df5817600f9a9c5bcf6771e87e71aab6");
  });

  it("guards before every read and discloses only the summary, the filer's name and the keyed digest", () => {
    const pinAt = body.indexOf("perform private.member_pin_require_full_session();");
    const guardAt = body.search(/if caller is null or not private\.mfa_satisfied\(\) then/);
    expect(pinAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(pinAt);
    expect(body.indexOf("from public.member_form_cosigners")).toBeGreaterThan(guardAt);
    expect(body).toContain("private.form_content_digest(f.id) as content_digest");
    expect(body).toContain("'reviewDigest', private.cosign_review_digest(inv.id, frec.content_digest)");
    expect(body).not.toMatch(/answers->>'(?:narrative|remedy|affected)'/);
    expect(body).not.toMatch(/\b(?:insert|update|delete|merge|execute|call)\b/i);
  });
});
