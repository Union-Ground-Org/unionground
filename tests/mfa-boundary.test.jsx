import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fnBody, loadMigrationSql, migrationFiles, stripComments } from "./helpers/migration.js";
import { MfaSettings, MfaChallenge, MfaEnrollment } from "../src/components/MfaSettings.jsx";
import { owesASecondFactor } from "../src/App.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { catalogue } from "../src/lib/i18n.js";

// Text pins are a tripwire, not a proof: they assert what THIS MIGRATION SAYS,
// not what the database ENDS UP WITH. A later create-or-replace can supersede
// every guard below and this file stays green. Current-state truth lives in
// scripts/db-contract.json, checked by `npm run verify:db`.
//
// Superseded here: member_has_role and the mfa_assurance policy body. The
// policy is applied to every RLS table by a DO loop AT MIGRATION TIME, so a
// table created by a later migration silently lacks it -- a gap no text pin can
// see and the contract's coverage sweep exists to catch.

const read = (p) => readFileSync(resolve(process.cwd(), p), "utf8");

function wrap(ui, lang = "en") {
  return render(<LanguageProvider lang={lang}>{ui}</LanguageProvider>);
}

function mfaClient(overrides = {}) {
  return {
    auth: {
      mfa: {
        listFactors: vi.fn().mockResolvedValue({ data: { all: [], totp: [] }, error: null }),
        enroll: vi.fn().mockResolvedValue({ data: { id: "f1", totp: { qr_code: "", secret: "S" } }, error: null }),
        challenge: vi.fn().mockResolvedValue({ data: { id: "c1" }, error: null }),
        verify: vi.fn().mockResolvedValue({ error: null }),
        unenroll: vi.fn().mockResolvedValue({ error: null }),
        ...overrides,
      },
    },
  };
}

const verified = (id) => ({ id, factor_type: "totp", status: "verified" });
const unverified = (id) => ({ id, factor_type: "totp", status: "unverified" });

// ---------------------------------------------------------------------------
// The assurance boundary is enforced in SQL, so these pin the migration itself.
// A UI-only MFA gate was the original defect: an aal1 token read
// member_profiles and member_notifications straight through PostgREST while the
// app refused to render. If these assertions ever fail, the gate is theatre
// again.
// ---------------------------------------------------------------------------
describe("MFA assurance boundary migration", () => {
  const sql = loadMigrationSql("20260724030000_mfa_assurance_boundary.sql");

  it("covers every RLS table by generating the policy rather than hand-listing", () => {
    expect(sql).toMatch(/c\.relrowsecurity/);
    expect(sql).toMatch(/create policy mfa_assurance on %s as restrictive/);
  });

  it("guards INSERT as well as SELECT", () => {
    // USING alone would let a member who owes a code still write rows.
    expect(sql).toMatch(/with check \(\(select private\.mfa_satisfied\(\)\)\)/);
    expect(sql).toMatch(/for all to authenticated/);
  });

  it("wraps the predicate in a subselect so it is an InitPlan, not per-row", () => {
    expect(sql).toMatch(/using \(\(select private\.mfa_satisfied\(\)\)\)/);
  });

  it("reads auth.mfa_factors through a definer function, which authenticated cannot do itself", () => {
    expect(sql).toMatch(/security definer/);
    expect(sql).toMatch(/set search_path = ''/);
    expect(sql).toMatch(/grant execute on function private\.mfa_satisfied\(\) to authenticated/);
  });

  it("admits a member with no verified factor and refuses one who owes a code", () => {
    // CASE, not OR: a NULL aal claim must land in the ELSE branch rather than
    // making the whole predicate NULL.
    expect(sql).toMatch(/when \(select auth\.jwt\(\) ->> 'aal'\) = 'aal2' then true/);
    expect(sql).toMatch(/else not exists/);
    expect(sql).toMatch(/status = 'verified'/);
  });

  it("refuses to apply as a silent no-op", () => {
    expect(sql).toMatch(/if n = 0 then\s*\n\s*raise exception/);
  });
});

describe("staff gate and admin reset migration", () => {
  const sql = loadMigrationSql("20260724031000_mfa_staff_gate_and_reset.sql");

  it("extends the boundary over security-definer staff RPCs via member_has_role", () => {
    // Definer functions bypass RLS entirely, so the table policy does nothing
    // for the 27 staff RPCs that gate on this one function.
    expect(sql).toMatch(/create or replace function public\.member_has_role/);
    expect(sql).toMatch(/select \(select private\.mfa_satisfied\(\)\)\s*\n\s*and exists/);
  });

  it("refuses self-reset, which would make the endpoint an MFA bypass", () => {
    expect(sql).toMatch(/if p_user_id = caller then/);
    expect(sql).toMatch(/an admin cannot reset their own second factor/);
  });

  it("audits the reset after the fact and allows the new action value", () => {
    expect(sql).toMatch(/'reset_mfa'/);
    expect(sql).toMatch(/create or replace function public\.record_mfa_reset/);
  });

  it("does not qualify greatest(), which is a grammar construct and would raise 42883", () => {
    expect(sql).not.toMatch(/pg_catalog\.greatest/);
    expect(sql).not.toMatch(/pg_catalog\.coalesce/);
  });
});

// ---------------------------------------------------------------------------
describe("predicate scope and capability RPCs", () => {
  const sql = loadMigrationSql("20260724034000_mfa_predicate_scope_and_capability_rpcs.sql");

  it("counts only TOTP, the one factor type this client can challenge", () => {
    // A verified phone/WebAuthn factor would otherwise make RLS demand aal2
    // while the UI shows "no authenticator" and offers no way to elevate —
    // turning the boundary into a permanent lockout.
    //
    // That narrowing landed on the SERVER only. App.jsx went on deciding the
    // gate from auth-js's factor-type-AGNOSTIC nextLevel, so the lockout this
    // comment describes was still reachable — from the other side, and with RLS
    // now willing to serve the member the UI was refusing to render. Whoever
    // reads this next: the two scopes are a pair, and the pair is what the
    // "client and server agree on which factor types count" block below tests.
    expect(sql).toMatch(/and f\.factor_type = 'totp'/);
  });

  it("guards the two RPCs that hand out capabilities outliving the session", () => {
    // Definer functions bypass RLS, so the table policy does nothing for them.
    // rotate_calendar_feed_token mints a bearer URL that streams the member's
    // events forever; upsert_push_subscription redirects their notifications.
    // Both are disclosure, not writes.
    expect(sql).toMatch(/create or replace function public\.rotate_calendar_feed_token/);
    expect(sql).toMatch(/create or replace function public\.upsert_push_subscription/);
    const guards = sql.match(/if caller is null or not private\.mfa_satisfied\(\) then/g) || [];
    expect(guards.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The client half of the same boundary.
//
// Neither side had a test that could see the other. tests/auth-depth.test.jsx
// pinned App.jsx's predicate literally and the block above pins the migration's
// factor-type clause, and BOTH stayed green through three releases in which the
// two disagreed: the server counted TOTP, the client counted anything verified.
// A member whose only factor was a phone or a security key was admitted by RLS
// and refused by the UI, on a screen whose only working control was sign out.
//
// So this block asserts the RELATIONSHIP rather than either spelling. Narrowing
// one side again cannot ship without the other.
// ---------------------------------------------------------------------------
describe("client and server agree on which factor types count", () => {
  // Comments are stripped from both languages before scanning, because the code
  // on each side necessarily QUOTES the other's clause to explain itself, and a
  // comment is not behaviour. Nothing else is normalised — no lowercasing, no
  // whitespace collapsing, no de-duplication of the sources. A guard that
  // launders its own input is how the last one passed while broken.
  //
  // The SQL stripper is the repo's single scanner (scripts/lib/sql-text.mjs),
  // not a local `/--[^\n]*/g`, which would eat the hyphens inside quoted
  // literals; the migration's only mention of "phone" IS in a `--` comment, so
  // getting this wrong flips the answer.
  const stripJs = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // Trailing `//` comments too, not just whole-line ones. The whole-line-only
    // form let `x = 1; // factor_type !== "phone"` contribute a type.
    .replace(/(^|[^:'"\\])\/\/.*$/gm, "$1");

  // The LAST migration that defines private.mfa_satisfied(), not a hardcoded
  // filename.
  //
  // This is the finding two independent adversarial reviewers reached first, and
  // they were right. Applied migrations cannot be edited in place — the repo's
  // own migration-history guard forbids it — so a real server-side change never
  // arrives by editing 20260724034000. It arrives as a NEW migration doing
  // `create or replace function private.mfa_satisfied()`, which a pinned
  // filename cannot see. The guard would have stayed green through exactly the
  // change it exists to catch, and the seven mutations that "proved" it all
  // edited files, so none of them ran that case.
  //
  // It also has to be the LAST definition rather than a union over all of them:
  // 20260724030000 defines this function with NO factor-type clause at all, and
  // 20260724034000 supersedes it. Unioning would silently read the superseded
  // version's scope alongside the live one.
  //
  // The backstop that would otherwise cover this (scripts/db-contract.json's
  // bodyContains pin) runs only under `verify:db`, which SKIPs green whenever
  // SUPABASE_DB_URL is unset — which is every CI run today.
  // `or replace` is OPTIONAL here, and that word is the whole point. Both
  // existing definitions use it, so requiring it looked like a faithful
  // description of house style — but Postgres accepts `drop function` followed
  // by a plain `create function` just as happily, and a third reviewer proved
  // the escape: a new migration written that way widened the server to
  // ('totp','phone') and the suite stayed green, because this filter never
  // matched it, `liveDefinition` stayed on 034000, and the filename pin below
  // therefore never fired either. That is the pinned-filename bug again wearing
  // a different word. Comments are stripped first so a migration that merely
  // TALKS about redefining the predicate is not mistaken for one that does, and
  // the trailing `(` keeps a hypothetical mfa_satisfied_v2 from matching.
  const definingMigrations = migrationFiles()
    .filter((entry) => /create\s+(?:or\s+replace\s+)?function\s+"?private"?\.\s*"?mfa_satisfied"?\s*\(/i
      .test(stripComments(entry.sql)));
  const liveDefinition = definingMigrations[definingMigrations.length - 1];

  // Capture the whole right-hand side, then every literal inside it. Matching
  // one literal per clause looked equivalent and was not: `in ('totp','phone')`
  // read as {totp}, so a widening written that way compared EQUAL to the client
  // and the set assertion passed. Only the migration-name pin caught it — and
  // that pin is the one a legitimate new migration makes you update, which is
  // precisely when this hole would have opened.
  //
  // Read the dollar-quoted BODY rather than fnBody()'s whole statement. The
  // statement carries its own `create or replace`, and the disjunction
  // assertion below would trip on that `or` forever.
  const liveBody = (() => {
    const statement = stripComments(fnBody(liveDefinition.sql, "private.mfa_satisfied()"));
    const at = statement.search(/\$\$|\$function\$/);
    return at === -1 ? statement : statement.slice(at);
  })();

  // `=` and `<>` are NOT one operator, and reading them as one was the worst
  // bug this file has carried. `factor_type <> 'totp'` extracts the very same
  // {totp} that `= 'totp'` does, so a POLARITY INVERSION of the live predicate
  // compared EQUAL to the client and this guard called it agreement — while
  // `not exists(verified AND factor_type <> 'totp')` is TRUE for a TOTP-enrolled
  // member sitting at aal1, admitting them on all 51 tables without ever asking
  // for a code. A total server-side bypass, read as a match. Only the positive
  // forms may contribute literals; anything else is caught by the parse
  // assertion below rather than silently reinterpreted.
  //
  // A function per call, not a shared /g regex: lastIndex is exactly the kind
  // of shared state that makes one of two identical-looking calls return fewer
  // matches than the other.
  const scopeClauses = (text) => [...text.matchAll(/factor_type\s*(?:=|\bin\b)\s*(\([^)]*\)|'[a-z]+')/gi)];
  const sqlTypes = new Set(
    scopeClauses(liveBody).flatMap((m) => [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1])),
  );
  // Same rule on the JS side, for the same reason: `factor_type !== "totp"`
  // extracts {totp} too. That inversion is separately caught by the truth table
  // below (a phone-only member would start owing a code), but a scanner that
  // quietly reads a negation as its opposite should not exist in this file at
  // all — with `!==` gone from the pattern, such a rewrite empties the set and
  // trips the non-vacuity assertion instead of matching.
  const jsTypes = (path) => new Set(
    [...stripJs(read(path)).matchAll(/factor_type\s*===\s*"([a-z]+)"/g)].map((m) => m[1]),
  );

  // Every source must name at least one type. Without this, deleting the clause
  // from one side empties BOTH sets, set equality holds vacuously, and the guard
  // reports agreement precisely when the two have stopped agreeing.
  it("finds a factor-type scope on every side, so equality below is not vacuous", () => {
    expect(sqlTypes.size, "the live mfa_satisfied definition names no factor type").toBeGreaterThan(0);
    expect(jsTypes("src/App.jsx").size, "App.jsx's gate names no factor type").toBeGreaterThan(0);
    expect(jsTypes("src/components/MfaSettings.jsx").size, "MfaSettings names no factor type").toBeGreaterThan(0);
  });

  // Non-vacuity is not enough. The scanner must also have UNDERSTOOD the whole
  // clause it read, and every escape a third review found exploited the gap
  // between those two things: keep one literal the regex can see, and express
  // the widening in a form it cannot. `and (f.factor_type = 'totp' or
  // f.factor_type = any(array['phone','webauthn']))` yields {totp}. So does
  // `and (f.factor_type = 'totp' or true)`, which needs no second literal at
  // all — the SQL twin of the `|| true` escape this file already closed on the
  // JS side, and closing it there only made the asymmetry easier to miss.
  //
  // So refuse to interpret a predicate this file cannot fully parse, rather
  // than reporting agreement on the fragment it happened to recognise. Both
  // assertions fail LOUDLY and both are meant to be re-armed by hand: widening
  // the scanner is fine, deciding the client agrees is the part a person has to
  // do.
  it("refuses to read a scope it cannot fully parse", () => {
    const mentions = (liveBody.match(/factor_type/gi) ?? []).length;
    expect(
      scopeClauses(liveBody).length,
      "mfa_satisfied compares factor_type in a form this guard cannot read — a negation, `= any(...)`, `like`, `is distinct from`, a CASE arm — so the set below would be built from only the clauses it recognised",
    ).toBe(mentions);
    expect(
      liveBody,
      "mfa_satisfied grew a disjunction; every widening that has slipped past this guard was written as one, so re-verify the client scope by hand before relaxing this",
    ).not.toMatch(/\bor\b/i);
  });

  it("reads the LAST migration defining mfa_satisfied, so a new one cannot slip past", () => {
    // Today that is the G5 recovery-lock boundary, which preserves the reset
    // timestamp and adds a fail-closed in-progress self-recovery check. When a
    // future migration redefines the function this assertion changes with it
    // — which is the point: the set comparison then reads the NEW body, and a
    // server-side widening fails until the client is widened too.
    expect(definingMigrations.length).toBeGreaterThan(1);
    // "Last" only means "live" because migrationFiles() hands back filename
    // order, which is the order Postgres applies them in. That is a contract in
    // another module, so pin it there rather than here: the previous version of
    // this line compared the FILTERED subset to a sorted copy of itself, which
    // reads like a guard against filename ambiguity but can only ever fail if
    // the helper stops sorting — the same condition, stated about a sample
    // instead of the source.
    const allNames = migrationFiles().map((entry) => entry.name);
    expect(allNames, "migrationFiles() stopped returning apply order, so `last` no longer means `live`")
      .toEqual([...allNames].sort());
    //  runs the same query from PL/pgSQL (cached plan); the body is unchanged.
    expect(liveDefinition.name).toBe("20261106221000_staff_desk_overviews_setwise_access_and_cached_helper_plans.sql");
    //:49:08 PM and about 11:04 PM ET:
    // server-verified UV sessions count for all accounts, including staff.
    expect(liveBody).toContain("private.verified_key_session");
    expect(liveBody).toContain("ug_key_uv");
    // And the superseded one really is unscoped, so a union over all migrations
    // would have silently read a scope that is no longer live.
    expect(stripComments(fnBody(definingMigrations[0].sql, "private.mfa_satisfied()")))
      .not.toMatch(/factor_type/);
  });

  it("scopes the shell gate to exactly the set private.mfa_satisfied() counts", () => {
    expect([...jsTypes("src/App.jsx")].sort()).toEqual([...sqlTypes].sort());
  });

  it("scopes the settings and challenge screens to that same set", () => {
    // MfaChallenge lives in this file too, and it is the screen the gate sends
    // people to. A gate that admits a type the challenge cannot verify is the
    // lockout; a challenge offering a type the gate never demands is dead code.
    expect([...jsTypes("src/components/MfaSettings.jsx")].sort()).toEqual([...sqlTypes].sort());
  });

  it("keeps the two original terms as a CONJUNCTION, not two loose substrings", () => {
    const app = stripJs(read("src/App.jsx"));
    // Pinning `nextLevel === "aal2"` and `currentLevel !== "aal2"` separately is
    // not the same assertion: an adversarial review rewrote the pair as `||`,
    // which re-challenges every TOTP member forever even at aal2, and both
    // separate pins still passed. Pin the conjunction.
    expect(app).toContain('assurance.nextLevel === "aal2" && assurance.currentLevel !== "aal2"');
  });

  it("pins the effect to owesASecondFactor(), so the truth table describes the SHIPPED decision", () => {
    // Everything above this line reasons about an EXPORTED function. Nothing
    // above it says the gate calls that function — and this commit is what
    // opened that gap: it deleted the two assertions that held the call site
    // (`const canBeChallenged = (session.user.factors ?? [])` and `data &&
    // canBeChallenged`) and replaced them with a truth table, which is a better
    // test of the decision and no test at all of whether the decision is used.
    //
    // Inline the pre-fix expression back into owesACode() and leave
    // owesASecondFactor exported but uncalled, and the whole file still passes:
    // the truth table exercises the dead function, the conjunction pin matches
    // text inside it, and jsTypes finds `factor_type === "totp"` there too. The
    // lockout returns in production with 1292 green tests behind it.
    const app = stripJs(read("src/App.jsx"));
    expect(app).toContain("const owes = owesASecondFactor(data, session.user);");
    expect(app).toContain('if (owes || data?.currentLevel === "aal2") return owes;');
  });

  it("keeps the gate off the network, so an offline boot still renders", () => {
    // listFactors() is a getUser() round-trip. On the boot path it blocks the
    // shell behind the request that fails slowest exactly when the app most
    // needs its cache — and mfaRequired stays null throughout, which also holds
    // the outbox replay effect closed, because that waits on mfaRequired ===
    // false. session.user.factors is the same data, already in memory.
    expect(stripJs(read("src/App.jsx"))).not.toMatch(/mfa\.listFactors\(/);
  });

  it("still fails open when the assurance level cannot be read at all", () => {
    // RLS is the boundary; this gate only explains it. Failing closed would trap
    // the members with no second factor at all — the ones the database admits
    // without question — and it would trap every one of them at once.
    expect(stripJs(read("src/App.jsx")))
      .toMatch(/\.catch\(\(\) => \{ if \(mounted && operation\.isCurrent\(\)\) setMfaRequired\(false\); \}\)/);
  });

  it("leaves demo mode short-circuited before any of it runs", () => {
    expect(stripJs(read("src/App.jsx")))
      .toMatch(/if \(demoActive \|\| !supabase \|\| !session\?\.user\) \{\s*mfaAnswerLoginRef\.current = null;\s*setMfaRequired\(false\);\s*return undefined;\s*\}/);
  });
});

// ---------------------------------------------------------------------------
// Everything above reads source text. Text pins see SPELLING, not meaning: an
// adversarial review appended `|| true` to the old inline expression and every
// pin in this file still passed. So the decision is now a pure exported
// function, and this is the truth table nothing in the repo had.
// ---------------------------------------------------------------------------
describe("owesASecondFactor", () => {
  const aal = (currentLevel, nextLevel) => ({ currentLevel, nextLevel });
  const user = (...factors) => ({ factors });
  const totp = { id: "t", factor_type: "totp", status: "verified" };
  const phone = { id: "p", factor_type: "phone", status: "verified" };
  const webauthn = { id: "w", factor_type: "webauthn", status: "verified" };

  it("challenges a member holding a verified TOTP factor at aal1", () => {
    expect(owesASecondFactor(aal("aal1", "aal2"), user(totp))).toBe(true);
  });

  it("ADMITS a member whose only verified factor is one it cannot challenge", () => {
    // The defect this PR exists to remove. RLS admits these members; the gate
    // refused them and MfaChallenge answered every code with "no authenticator
    // is set up", leaving sign-out as the only working control.
    expect(owesASecondFactor(aal("aal1", "aal2"), user(phone))).toBe(false);
    expect(owesASecondFactor(aal("aal1", "aal2"), user(webauthn))).toBe(false);
    expect(owesASecondFactor(aal("aal1", "aal2"), user(phone, webauthn))).toBe(false);
  });

  it("still challenges when a TOTP factor sits alongside ones it cannot challenge", () => {
    expect(owesASecondFactor(aal("aal1", "aal2"), user(phone, totp))).toBe(true);
  });

  it("does not re-challenge a member who has just cleared TOTP", () => {
    // Dropping the currentLevel term here is the same lockout from the other
    // direction: an aal2 member sent back to the code screen forever.
    expect(owesASecondFactor(aal("aal2", "aal2"), user(totp))).toBe(false);
  });

  it("admits a member with no factor at all, and one with only an unverified TOTP", () => {
    expect(owesASecondFactor(aal("aal1", "aal1"), user())).toBe(false);
    expect(owesASecondFactor(aal("aal1", "aal1"), { })).toBe(false);
    expect(owesASecondFactor(aal("aal1", "aal2"), user({ ...totp, status: "unverified" }))).toBe(false);
  });

  it("returns false rather than throwing on a missing or corrupt factor list", () => {
    // A throw here escapes into the effect and freezes mfaRequired at null,
    // which renders an eternal loading screen — the same dead end in a new coat.
    expect(() => owesASecondFactor(aal("aal1", "aal2"), { factors: "corrupt" })).not.toThrow();
    expect(owesASecondFactor(aal("aal1", "aal2"), { factors: "corrupt" })).toBe(false);
    expect(owesASecondFactor(aal("aal1", "aal2"), null)).toBe(false);
    expect(owesASecondFactor(aal("aal1", "aal2"), undefined)).toBe(false);
  });

  it("returns false when the assurance level itself is missing", () => {
    expect(owesASecondFactor(null, user(totp))).toBe(false);
    expect(owesASecondFactor(undefined, user(totp))).toBe(false);
  });

  it("cannot be satisfied by the factor scope alone", () => {
    // Guards against the scope term being kept while the level terms are lost.
    expect(owesASecondFactor(aal("aal2", "aal2"), user(totp))).toBe(false);
    expect(owesASecondFactor(aal("aal1", "aal1"), user(totp))).toBe(false);
  });
});

describe("the live contract survives the new policy", () => {
  // These assertions used to read scripts/verify-notification-schema.sql, whose
  // catalog half now lives in the DB contract. The property is unchanged and
  // still worth pinning: the assurance boundary puts one RESTRICTIVE policy on
  // every table, member_notification_deliveries included, so any check written
  // as "zero policies" instead of "zero permissive policies" starts failing the
  // moment the boundary lands.
  const contract = JSON.parse(read("scripts/db-contract.json"));

  it("asks for zero PERMISSIVE policies on the delivery queue, not zero policies", () => {
    expect(contract.policyCoverage.noPermissivePolicies).toContain("member_notification_deliveries");
    expect(contract.policies.some((p) => p.table === "member_notification_deliveries")).toBe(false);
  });

  it("contracts mfa_assurance as restrictive-for-all, on every RLS table", () => {
    const restrictive = contract.policyCoverage.restrictiveOnEveryRlsTable;
    expect(restrictive.name).toBe("mfa_assurance");
    expect(restrictive.permissive).toBe(false);
    expect(restrictive.cmd).toBe("*");
    expect(restrictive.roles).toBe("authenticated");
    expect(restrictive.qual).toContain("private.mfa_satisfied()");
    expect(restrictive.withCheck).toContain("private.mfa_satisfied()");
    // A DO loop applies it at migration time, so the coverage sweep — not a
    // per-table list — is what catches a table created afterwards.
    expect(contract.policyCoverage.everyPublicTableHasRls).toBe(true);
  });
});

describe("admin reset revokes live sessions", () => {
  it("logs the member out so a thief's token cannot outlive the reset", () => {
    // Clearing factors makes mfa_satisfied() true for EVERY token the member
    // has, including one an attacker holds.
    const api = read("api/admin-mfa-reset.js");
    // Supabase Auth has no admin logout route; the service-role RPC deletes
    // the member's sessions (BUG-UG-ADMIN-SESSION-REVOKE-ENDPOINT-20261003).
    expect(api).toContain("revoked = await logoutAuthUser(supabaseUrl, serviceRoleKey, userId);");
    expect(api).not.toMatch(/admin\/users\/\$\{userId\}\/logout/);
    expect(api).toMatch(/revoked/);
  });
});

// The /reset recovery screen — takeAuthFragment's history scrub, the
// PASSWORD_RECOVERY-only unlock, its language resolution and RESET_KEYS
// coverage — was removed with the member-facing password path (owner ruling
// 2026-07-31): no resetPasswordForEmail call remains to mint a recovery link.

describe("mfa and admin-reset i18n coverage", () => {
  it("covers the MFA and admin-reset keys in both locales", () => {
    for (const key of [
      "mfa.enrollCaution", "mfa.unknownSub", "mfa.retry", "mfa.disablePartial", "mfa.otherFactors",
      "admin.resetMfa", "admin.resetMfaConfirm", "admin.resetMfaGo",
      "admin.mfaReset", "admin.mfaResetNone", "admin.actionResetMfa",
    ]) {
      expect(catalogue.en[key], `missing en: ${key}`).toBeTruthy();
      expect(catalogue.es[key], `missing es: ${key}`).toBeTruthy();
    }
  });
});

describe("ordinary sign-out stays local", () => {
  it("uses local by default and reserves global for the explicit everywhere action", () => {
    // Comments are stripped first — the helper's own comment necessarily quotes
    // the call it exists to replace, and matching that would be a false pass
    // that flips to a false failure the moment the wording changes.
    const app = read("src/App.jsx")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // Revoke the exact captured access token through the admin client; the
    // explicit scope still decides local versus every-device revocation.
    const helper = read("src/lib/sessionManagement.js");
    expect(helper).not.toMatch(/auth\.signOut\(\)/);
    expect(helper).toContain('new Set(["local", "global"])');
    expect(helper).toContain('scope = "local"');
    expect(helper).toContain("auth.admin.signOut(revocationSession.access_token, scope)");
    expect(app).toContain('signOutAndForget(scope = "local"');
    // The visible Sign out controls run through signOutOnce, which keeps the
    // caller's scope and hands it to signOutAndForget unchanged
    // (REQ-UG-FIRST-CLICK-AND-DEAD-CONTROLS-20261030), with the
    // options a revocation watcher sign-out carries .
    expect(app).toContain('signOutOnce(scope = "local"');
    expect(app).toContain('signOutOnce("local", true)');
    expect(app).toContain("flight.promise = signOutAndForget(scope, true, options)");
    expect(app).toContain('signOutAndForget("local", true)');
    expect(app).toContain('signOutAndForget("global", true)');
  });
});

// ---------------------------------------------------------------------------
describe("MfaChallenge with more than one verified factor", () => {
  it("tries the code against every verified factor, not just the first", async () => {
    const verify = vi.fn()
      .mockResolvedValueOnce({ error: { message: "Invalid TOTP code" } })
      .mockResolvedValueOnce({ error: null });
    const client = mfaClient({
      listFactors: vi.fn().mockResolvedValue({ data: { all: [verified("lost"), verified("working")] }, error: null }),
      verify,
    });
    const onCleared = vi.fn();
    const { container } = wrap(<MfaChallenge client={client} onCleared={onCleared} onSignOut={vi.fn()} />);

    fireEvent.change(container.querySelector('input[name="code"]'), { target: { value: "123456" } });
    fireEvent.submit(container.querySelector("form"));

    // Without this, a member holding a working authenticator is rejected
    // forever because the lost one happens to sort first.
    await waitFor(() => expect(onCleared).toHaveBeenCalled());
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it("refuses a factor type it cannot verify instead of trying to", async () => {
    // The set-equality guard unions matches across the whole file, and
    // MfaSettings has three factor_type sites — so widening THIS filter alone
    // leaves the file's set at {totp} and every text assertion passes. An
    // adversarial review demonstrated exactly that escape. This is the
    // behavioural pin that closes it.
    //
    // It also documents the contract the shell gate now depends on: if
    // MfaChallenge ever learns to verify a type, owesASecondFactor must demand
    // it in the same commit, or the pair is out of step again.
    const verify = vi.fn();
    const client = mfaClient({
      listFactors: vi.fn().mockResolvedValue({
        data: { all: [{ id: "p1", factor_type: "phone", status: "verified" }] },
        error: null,
      }),
      verify,
    });
    const onCleared = vi.fn();
    const { container } = wrap(<MfaChallenge client={client} onCleared={onCleared} onSignOut={vi.fn()} />);
    fireEvent.change(container.querySelector('input[name="code"]'), { target: { value: "123456" } });
    fireEvent.submit(container.querySelector("form"));

    await waitFor(() => expect(screen.queryByText(/no authenticator is set up/i)).toBeTruthy());
    expect(verify, "a phone factor must never be handed to the TOTP verify path").not.toHaveBeenCalled();
    expect(onCleared).not.toHaveBeenCalled();
  });

  it("reports rejection when the code matches no factor", async () => {
    const client = mfaClient({
      listFactors: vi.fn().mockResolvedValue({ data: { all: [verified("a")] }, error: null }),
      verify: vi.fn().mockResolvedValue({ error: { message: "Invalid TOTP code" } }),
    });
    const onCleared = vi.fn();
    const { container } = wrap(<MfaChallenge client={client} onCleared={onCleared} onSignOut={vi.fn()} />);
    fireEvent.change(container.querySelector('input[name="code"]'), { target: { value: "000000" } });
    fireEvent.submit(container.querySelector("form"));
    await waitFor(() => expect(container.querySelector(".auth-message")).toBeTruthy());
    expect(onCleared).not.toHaveBeenCalled();
  });
});

describe("MfaSettings factor-list truth", () => {
  it("does not claim MFA is off when the factor list could not be read", async () => {
    const client = mfaClient({ listFactors: vi.fn().mockResolvedValue({ data: null, error: { message: "network" } }) });
    wrap(<MfaSettings client={client} />);
    // Claiming "your sign-in link alone signs you in" to a member who HAS a
    // factor is a lie about their account security, and the Enable button it
    // offered then failed on a duplicate factor.
    await waitFor(() => expect(screen.queryByText(/we could not check/i)).toBeTruthy());
    expect(screen.queryByText(/alone signs you in/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /turn on two-step/i })).toBeNull();
  });

  it("reads unverified factors from data.all, which is the only place they appear", async () => {
    const unenroll = vi.fn().mockResolvedValue({ error: null });
    const client = mfaClient({
      listFactors: vi.fn().mockResolvedValue({ data: { all: [unverified("stale")], totp: [] }, error: null }),
      unenroll,
    });
    const { container } = wrap(<MfaSettings client={client} />);
    await waitFor(() => expect(container.querySelector(".mfa-settings")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /turn on two-step/i }));
    // auth-js types `totp` as verified-only, so the old cleanup could never see
    // an abandoned enrolment and every one of them leaked a factor slot.
    await waitFor(() => expect(unenroll).toHaveBeenCalledWith({ factorId: "stale" }));
  });

  it("keeps going after a failed unenrol and says two-step is still on", async () => {
    const client = mfaClient({
      listFactors: vi.fn().mockResolvedValue({ data: { all: [verified("works"), verified("dead")] }, error: null }),
      unenroll: vi.fn()
        .mockResolvedValueOnce({ error: null })
        .mockResolvedValueOnce({ error: { message: "nope" } }),
    });
    wrap(<MfaSettings client={client} />);
    await waitFor(() => expect(screen.queryByRole("button", { name: /turn off two-step/i })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /turn off two-step/i }));
    fireEvent.click(screen.getByRole("button", { name: "Turn it off" }));
    // Aborting on the first failure could delete the WORKING factor and leave
    // the dead one — turning "turn this off" into a permanent lockout.
    await waitFor(() => expect(screen.queryByText(/could not be removed/i)).toBeTruthy());
  });

  it("warns before enrolment that losing the device needs an admin", async () => {
    const client = mfaClient();
    wrap(<MfaSettings client={client} />);
    await waitFor(() => expect(screen.queryByText(/an admin has to clear it/i)).toBeTruthy());
  });
});

describe("organization-required two-step enrollment", () => {
  it.each(["en", "es"])("enrolls before member data loads without losing typed digits (%s)", async (lang) => {
    const copy = catalogue[lang];
    let finishVerification;
    const verification = new Promise((resolve) => { finishVerification = resolve; });
    const client = mfaClient({
      listFactors: vi.fn()
        .mockResolvedValueOnce({ data: { all: [] }, error: null })
        .mockResolvedValue({ data: { all: [verified("f1")] }, error: null }),
      enroll: vi.fn().mockResolvedValue({ data: { id: "f1", totp: { qr_code: "data:image/svg+xml,qr", secret: "SETUP-SECRET" } }, error: null }),
      verify: vi.fn().mockReturnValue(verification),
    });
    client.rpc = vi.fn().mockResolvedValue({ data: null, error: null });
    const onCleared = vi.fn().mockResolvedValue(undefined);
    const onSignOut = vi.fn();
    const view = wrap(<MfaEnrollment client={client} onCleared={onCleared} onSignOut={onSignOut} />, lang);

    expect(screen.getByRole("heading", { name: copy["mfa.organizationRequiredTitle"] })).toBeInTheDocument();
    expect(screen.getByText(copy["mfa.organizationRequiredBody"])).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: copy["mfa.enable"] }));
    const form = await screen.findByRole("form", { name: copy["mfa.enable"] });
    // Setup moves focus to the form in an effect after the commit that draws
    // it, so wait for the move instead of asserting in the same tick (#6878).
    await waitFor(() => expect(form).toHaveFocus());
    expect(screen.getByRole("img", { name: copy["mfa.qrAlt"] })).toBeVisible();
    const code = within(form).getByRole("textbox", { name: copy["mfa.codeLabel"] });
    code.focus();
    for (const digit of "012345") {
      fireEvent.change(code, { target: { value: code.value + digit } });
      view.rerender(<LanguageProvider lang={lang}><MfaEnrollment client={client} onCleared={onCleared} onSignOut={onSignOut} /></LanguageProvider>);
      expect(code).toHaveFocus();
    }
    expect(code).toHaveValue("012345");
    fireEvent.submit(form);
    await waitFor(() => expect(client.auth.mfa.verify).toHaveBeenCalledWith({ factorId: "f1", challengeId: "c1", code: "012345" }));
    expect(onCleared).not.toHaveBeenCalled();
    // Record 8435: pending while the code is verified, not natively disabled.
    expect(within(form).getByRole("button", { name: copy["auth.working"] })).toHaveAttribute("aria-disabled", "true");

    await act(async () => finishVerification({ error: null }));
    await waitFor(() => expect(onCleared).toHaveBeenCalledTimes(1));
    expect(screen.getByText(copy["mfa.onSub"])).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy["mfa.disable"] })).toBeNull();
    expect(client.auth.mfa.unenroll).not.toHaveBeenCalled();
    expect(client.rpc).toHaveBeenCalledWith("get_mfa_recovery_code_status");
    expect(client.rpc.mock.calls.every(([name]) => name === "get_mfa_recovery_code_status")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: copy["app.signOut"] }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });
});

describe("MfaSettings and a factor this app cannot challenge", () => {
  const phone = (id) => ({ id, factor_type: "phone", status: "verified" });
  const withFactors = (all) => mfaClient({
    listFactors: vi.fn().mockResolvedValue({ data: { all, totp: [] }, error: null }),
  });

  it("tells a phone-only member that the factor does not protect this account", async () => {
    wrap(<MfaSettings client={withFactors([phone("p1")])} />);
    // The screen used to filter non-TOTP factors out before deciding anything,
    // so this member was shown a plain "Off" and nothing else. "Off" is now
    // literally true — the server admits them at aal1 — but it is not the whole
    // truth to someone who believes they turned two-step on somewhere.
    await waitFor(() => expect(screen.queryByText(/this app can't ask you for/i)).toBeTruthy());
  });

  it("still offers enrolment, because that factor secures nothing here", async () => {
    wrap(<MfaSettings client={withFactors([phone("p1")])} />);
    await waitFor(() => expect(screen.queryByRole("button", { name: /turn on two-step/i })).toBeTruthy());
    // And NOT the disable button: reaching it needs a verified TOTP, which is
    // what keeps disable() — which unenrols only what it lists — away from a
    // factor it would leave behind while reporting success.
    expect(screen.queryByRole("button", { name: /turn off two-step/i })).toBeNull();
  });

  it("says nothing extra when every factor is one it can challenge", async () => {
    wrap(<MfaSettings client={withFactors([verified("t1")])} />);
    await waitFor(() => expect(screen.queryByRole("button", { name: /turn off two-step/i })).toBeTruthy());
    expect(screen.queryByText(/this app can't ask you for/i)).toBeNull();
  });

  it("does not count an unverified one, which protects nothing anywhere", async () => {
    wrap(<MfaSettings client={withFactors([{ id: "p2", factor_type: "phone", status: "unverified" }])} />);
    await waitFor(() => expect(screen.queryByRole("button", { name: /turn on two-step/i })).toBeTruthy());
    expect(screen.queryByText(/this app can't ask you for/i)).toBeNull();
  });

  it("claims nothing at all when the list could not be read", async () => {
    const client = mfaClient({ listFactors: vi.fn().mockResolvedValue({ data: null, error: { message: "network" } }) });
    wrap(<MfaSettings client={client} />);
    await waitFor(() => expect(screen.queryByText(/we could not check/i)).toBeTruthy());
    expect(screen.queryByText(/this app can't ask you for/i)).toBeNull();
  });
});

// The pin on the MFA reset migration
// (20261014006000). It was reconciled onto the shared reset boundary on
// 2026-10-14 (the July security-epoch design is not created), so the pin now
// holds the file to that reconciliation: the reset starts before any factor
// is deleted, live tokens die through the session boundary, the
// additive calendar-feed revocation stays, and a second reset path fails the
// migration instead of shipping beside it.
describe("admin reset invalidates live access and refresh tokens", () => {
  const epoch = read("supabase/migrations/20261014006000_unionground_mfa_reset_epoch.sql");

  it("creates the reset boundary before deleting factors", () => {
    const api = read("api/admin-mfa-reset.js");
    expect(api).toContain('"begin_mfa_reset"');
    expect(api.indexOf('"begin_mfa_reset"')).toBeLessThan(api.indexOf("adminListFactors"));
    expect(api).not.toMatch(/admin\/users\/\$\{userId\}\/logout/);
    // Live tokens die through Union Ground's boundary, which the migration
    // refuses to apply without.
    expect(epoch).toMatch(/pg_get_functiondef\('private\.mfa_satisfied\(\)'::regprocedure\)/);
    expect(epoch).toMatch(/strpos\(predicate, 'private\.member_mfa_reset_boundaries'\) = 0/);
    expect(epoch).toMatch(/strpos\(predicate, 'auth\.sessions'\) = 0/);
    expect(epoch).toMatch(/to_regprocedure\('public\.begin_mfa_reset\(uuid\)'\) is null/);
    expect(epoch).toMatch(/raise exception 'Union Ground MFA reset boundary is missing; Union Ground relies on it'/);
    // No second reset entry point or epoch table may exist beside it.
    expect(epoch).toMatch(/to_regprocedure\('public\.begin_mfa_reset\(uuid, uuid\)'\) is not null/);
    expect(epoch).toMatch(/to_regclass\('private\.unionground_member_security_epochs'\) is not null/);
    expect(epoch).not.toMatch(/create (or replace )?function private\.mfa_satisfied/i);
    // The additive revocation kept from the July design.
    expect(epoch).toMatch(/after insert or update of invalid_before on private\.member_mfa_reset_boundaries/);
    expect(epoch).toMatch(/delete from public\.member_calendar_feed_tokens\s+where user_id = new\.user_id/);
  });
});
