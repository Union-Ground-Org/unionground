// @vitest-environment node
//
// Repo-wide guard against RE-WIDENING a column-scoped grant.
//
// WHY THIS FILE EXISTS. tests/steward-requests-insert-scope.test.js carries a
// negative pin asserting its migration issues no table-form INSERT grant. An
// adversarial review on 2026-07-26 showed that pin has two blind spots, and
// both were reproduced before this file was written:
//
//   1. SPELLING. The pin's regex requires the literal `public.` prefix, so
//      `grant insert on member_steward_requests to authenticated;` — which
//      executes identically under the normal search_path — slips past, as does
//      the quoted `"public"."member_steward_requests"` form.
//   2. SCOPE. The pin reads ONE file. A table-form grant added by any LATER
//      migration re-widens the same privilege and no offline check sees it.
//
// The live half of the defence (`npm run verify:db` reading column_privileges)
// catches both — but it SKIPs green while SUPABASE_DB_URL is unset, which it is.
// Until that secret lands this sweep is the only thing standing between a
// re-widening grant and production.
//
// WHAT IT CHECKS. Grants accumulate in order, so the question is about the END
// of the chain, not about any single file. A column scope makes TWO claims and
// each is replayed separately, because a chain can break either one:
//
//   CLAIM 1  the role does not hold the privilege table-wide
//   CLAIM 2  the role still holds it on the contract's columns
//
// Checking only "the last event was a column grant" conflates them and is wrong
// both ways: it fails a legitimate chain ending in a table-form REVOKE, and —
// once that revoke is accepted — it would pass a chain that has revoked the
// column grant out of existence. Postgres semantics quoted at each function.
//
// The protected list is DERIVED from scripts/db-contract.json#columnGrants
// rather than hardcoded, so adding a new column-scoped grant to the contract
// extends this sweep automatically instead of quietly leaving it unguarded.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { migrationFiles } from "./helpers/migration.js";
import { stripSqlComments } from "../scripts/lib/sql-text.mjs";

const contract = JSON.parse(readFileSync(new URL("../scripts/db-contract.json", import.meta.url), "utf8"));

// Targets that are not tables. `grant execute on function ...` is the common
// one; none of them can carry a column list, so none can re-widen a column
// grant, and matching them would only generate noise.
const NON_TABLE_TARGETS = /^(?:function|procedure|routine|schema|sequence|database|domain|type|language|tablespace|foreign)\b/i;

const PRIVILEGE = /\b(select|insert|update|delete|truncate|references|trigger|maintain|all(?:\s+privileges)?)\b\s*(?:\(([^)]*)\))?/gi;

// Postgres folds an unquoted identifier to lower case and preserves a quoted
// one. Skipping the fold was the first version's bug: `ON PUBLIC.MEMBER_STEWARD_REQUESTS`
// executes identically to the lower-case spelling and sailed straight through,
// which is the whole defect class this file exists to catch.
function unquote(identifier) {
  const text = identifier.trim();
  const quoted = /^".*"$/s.test(text);
  return quoted ? text.slice(1, -1) : text.toLowerCase();
}

// `public.t`, `"public"."t"`, `t` and `table public.t` all name the same table.
// A bare name is qualified to public, which is what the migrations run under.
function normaliseTarget(raw) {
  const text = raw.trim().replace(/^table\s+/i, "").trim();
  if (/^all\s+tables\s+in\s+schema\b/i.test(text)) {
    const schema = unquote(text.replace(/^all\s+tables\s+in\s+schema\s+/i, "").split(/[,\s]/)[0] || "");
    // A blanket grant over the schema hits every table in it, including the
    // locked ones. Modelled as a wildcard rather than ignored.
    return { schema, table: "*" };
  }
  if (NON_TABLE_TARGETS.test(text)) return null;
  const parts = text.split(".");
  if (parts.length === 1) return { schema: "public", table: unquote(parts[0]) };
  return { schema: unquote(parts[0]), table: unquote(parts[1]) };
}

function parseRoles(raw) {
  return raw
    .replace(/\bwith\s+grant\s+option\b/gi, "")
    .replace(/\b(cascade|restrict)\b/gi, "")
    .split(",")
    // The trailing quote is what a grant built as dynamic SQL inside a
    // `do $$ ... execute 'grant ...' ... $$` block leaves behind. Stripping it
    // means such a statement is read rather than silently discarded.
    .map((role) => unquote(role.replace(/'/g, "")))
    .filter(Boolean);
}

// Every GRANT/REVOKE in the chain, flattened to one row per
// (action, table, role, privilege) with the column list that privilege carried.
export function grantEvents(files) {
  const events = [];
  for (const { name, sql } of files) {
    // ALTER DEFAULT PRIVILEGES changes what FUTURE objects are born with. Every
    // locked table already exists, so it cannot re-widen one — and its `on
    // tables` clause otherwise parses as a table literally named `tables`.
    const statements = stripSqlComments(sql).replace(/alter\s+default\s+privileges\b[^;]*;/gi, "");
    const re = /\b(grant|revoke)\b\s+(grant\s+option\s+for\s+)?([\s\S]*?)\s+\bon\b\s+([\s\S]*?)\s+\b(?:to|from)\b\s+([^;]*)/gi;
    let match;
    while ((match = re.exec(statements)) !== null) {
      const [, action, grantOption, privilegeText, targetText, roleText] = match;
      const target = normaliseTarget(targetText);
      if (!target) continue;
      const roles = parseRoles(roleText);
      PRIVILEGE.lastIndex = 0;
      let privilege;
      while ((privilege = PRIVILEGE.exec(privilegeText)) !== null) {
        const verb = privilege[1].toLowerCase().startsWith("all") ? "ALL" : privilege[1].toUpperCase();
        const columns = privilege[2] ? privilege[2].split(",").map(unquote) : null;
        for (const role of roles) {
          events.push({
            migration: name,
            action: action.toLowerCase(),
            ...target,
            role,
            privilege: verb,
            columns,
            // REVOKE GRANT OPTION FOR ... withdraws only the right to re-grant.
            // PostgreSQL: "only the grant option for the privilege is revoked,
            // not the privilege itself." Treating it as a revoke is a false
            // green — the privilege is still held afterwards.
            grantOptionOnly: Boolean(grantOption),
          });
        }
      }
    }
  }
  return events;
}

// Which of the lock's two privilege sources this event lands in, or null if it
// does not bear on the lock at all.
//
// PostgreSQL: "PUBLIC can be thought of as an implicitly defined group that
// always includes all roles", and a role holds "the sum of privileges granted
// directly to it ... and privileges granted to PUBLIC". So `grant insert on t
// to public` reaches `authenticated` and re-widens the lock just as surely as
// naming the role.
//
// The two sources are tracked SEPARATELY rather than merged, because revoking
// one does not touch the other: "revoking SELECT privilege from PUBLIC does not
// necessarily mean that all roles have lost SELECT privilege on the object:
// those who have it granted directly ... will still have it."
function slotFor(event, lock) {
  if (event.schema !== lock.schema) return null;
  if (event.table !== lock.table && event.table !== "*") return null;
  if (event.privilege !== lock.privilege && event.privilege !== "ALL") return null;
  if (event.role === lock.role) return "direct";
  if (event.role === "public") return "public";
  return null;
}

const affects = (event, lock) => slotFor(event, lock) !== null;

const LOCKS = contract.columnGrants.map((entry) => {
  const [schema, table] = entry.table.split(".");
  return {
    schema,
    table,
    role: entry.role.toLowerCase(),
    privilege: entry.privilege.toUpperCase(),
    columns: entry.columns.split(",").map((column) => column.trim()).filter(Boolean),
    label: `${entry.table} ${entry.role} ${entry.privilege}`,
  };
});

// A column scope makes two claims, and a chain can break either one, so both
// are replayed. An earlier revision checked only "the last event was a column
// grant", which conflates them and is wrong in both directions.
//
// CLAIM 1 — the role must NOT hold the privilege table-wide. Re-widening
// restores exactly this, so it is the headline invariant.
function outstandingTableGrant(events, lock) {
  const held = { direct: null, public: null };
  for (const event of events) {
    const slot = slotFor(event, lock);
    if (!slot) continue;
    if (event.columns) continue; // column-form: never confers the table-wide privilege
    if (event.grantOptionOnly) continue; // withdraws the right to re-grant, not the privilege
    held[slot] = event.action === "grant" ? event : null;
  }
  return held.direct ?? held.public;
}

// CLAIM 2 — the role must STILL hold the privilege on the contract's columns.
// This is the half the headline invariant cannot see: a chain ending in
// `revoke all on t from authenticated` leaves nothing outstanding and passes
// CLAIM 1, while having destroyed the column grant the contract requires.
// PostgreSQL: "When revoking privileges on a table, the corresponding column
// privileges (if any) are automatically revoked on each column of the table, as
// well." So a table-form REVOKE clears this ledger too — a fact an earlier
// comment here asserted the opposite of.
//
// Only asserted for locks the chain narrows in-repo; a lock established through
// some other route (this project has real history of DDL arriving via untracked
// execute_sql) has no in-repo grant to lose.
function outstandingColumnGrant(events, lock) {
  const held = { direct: null, public: null };
  for (const event of events) {
    const slot = slotFor(event, lock);
    if (!slot) continue;
    if (event.grantOptionOnly) continue;
    if (event.action === "revoke") held[slot] = null;
    else if (event.columns) held[slot] = event;
  }
  return held.direct ?? held.public;
}

const events = grantEvents(migrationFiles());

describe("no migration re-widens a column-scoped grant", () => {
  it("parses real grant events, including at least one column-scoped narrowing", () => {
    // A sweep that silently matches nothing passes forever. This asserts the
    // parser is still finding real events before anything below trusts it.
    expect(LOCKS.length, "contract declares column-scoped grants").toBeGreaterThan(0);
    expect(events.length, "the chain contains parseable grant statements").toBeGreaterThan(0);
    const narrowed = LOCKS.filter((lock) => events.some((e) => affects(e, lock) && e.action === "grant" && e.columns));
    expect(narrowed.length, "at least one lock is narrowed in-repo").toBeGreaterThan(0);
  });

  it.each(LOCKS.map((lock) => [lock.label, lock]))("%s is not held table-wide when the chain ends", (_label, lock) => {
    const held = outstandingTableGrant(events, lock);
    expect(
      held && `${held.migration} grants ${held.privilege} on ${held.schema}.${held.table} to ${held.role} table-wide`,
      "an outstanding table-form grant re-widens the contract's column scope",
    ).toBeNull();
  });

  // An empty contract column list is an explicit RPC-only/denied-all decision:
  // it still participates in the table-wide re-widening check above, but it
  // must not be forced to retain a historical column grant. Only contracts
  // that currently promise direct writable columns need CLAIM 2.
  const narrowedLocks = LOCKS.filter((lock) => lock.columns.length > 0
    && events.some((e) => affects(e, lock) && e.action === "grant" && e.columns));

  it.each(narrowedLocks.map((lock) => [lock.label, lock]))("%s still holds its column grant when the chain ends", (_label, lock) => {
    // The mirror of the test above. A later table-form REVOKE satisfies that
    // one by leaving nothing outstanding, while taking the column privileges
    // with it — the feature works for nobody rather than for too many.
    expect(
      outstandingColumnGrant(events, lock),
      "the chain narrows this privilege to columns and then revokes it away entirely",
    ).not.toBeNull();
  });
});

describe("the sweep's own parser (proven against the evasions that motivated it)", () => {
  const lock = { schema: "public", table: "member_steward_requests", role: "authenticated", privilege: "INSERT" };
  const narrow = "revoke insert on public.member_steward_requests from authenticated;\n"
    + "grant  insert (user_id, lesson_id) on public.member_steward_requests to authenticated;\n";
  const heldBy = (sql) => outstandingTableGrant(grantEvents([{ name: "20260726030000_x.sql", sql }]), lock);

  it("accepts the real migration's shape", () => {
    expect(heldBy(narrow)).toBeNull();
  });

  it.each([
    ["schema-qualified", "grant insert on public.member_steward_requests to authenticated;"],
    ["unqualified", "grant insert on member_steward_requests to authenticated;"],
    ["quoted", 'grant insert on "public"."member_steward_requests" to authenticated;'],
    ["TABLE keyword", "grant insert on table public.member_steward_requests to authenticated;"],
    ["privilege list", "grant insert, update on public.member_steward_requests to authenticated;"],
    ["ALL PRIVILEGES", "grant all privileges on public.member_steward_requests to authenticated;"],
    ["multi-role", "grant insert on public.member_steward_requests to anon, authenticated;"],
    ["whole schema", "grant insert on all tables in schema public to authenticated;"],
    ["ALL CAPS", "GRANT INSERT ON PUBLIC.MEMBER_STEWARD_REQUESTS TO AUTHENTICATED;"],
    ["mixed case", "grant insert on public.Member_Steward_Requests to authenticated;"],
    ["quoted schema, bare table", 'grant insert on "public".MEMBER_STEWARD_REQUESTS to authenticated;'],
    ["dynamic SQL in a DO block", "do $$ begin execute 'grant insert on public.member_steward_requests to authenticated'; end $$;"],
    ["TO PUBLIC", "grant insert on public.member_steward_requests to public;"],
    [
      "table-wide then GRANT OPTION FOR revoked",
      "grant insert on public.member_steward_requests to authenticated;\n"
      + "revoke grant option for insert on public.member_steward_requests from authenticated;",
    ],
    [
      "TO PUBLIC then revoked from the role only",
      "grant insert on public.member_steward_requests to public;\n"
      + "revoke insert on public.member_steward_requests from authenticated;",
    ],
  ])("catches a re-widening grant spelled %s", (_name, mutation) => {
    // The mutation is passed THROUGH AS WRITTEN. An earlier revision of this
    // test lowercased it first, which quietly turned the two case variants into
    // duplicates of the lower-case case and hid a real evasion behind a green
    // suite: Postgres folds unquoted identifiers, so every spelling below
    // reverts the fix identically.
    expect(heldBy(narrow + mutation)).not.toBeNull();
  });

  it("is not fooled by a comment that quotes the forbidden grant", () => {
    // The migration's own header quotes the rollback statement it warns
    // against. A pin that reads raw text instead of stripped SQL fails here.
    expect(heldBy(`${narrow}-- ROLLBACK: grant insert on public.member_steward_requests to authenticated;\n`)).toBeNull();
  });

  it("reports no table-wide grant after a trailing table-form REVOKE, but sees the column grant destroyed", () => {
    // An earlier revision named this "leaves column grants standing" and said
    // so in a comment. That is the opposite of the documented behaviour:
    // "When revoking privileges on a table, the corresponding column privileges
    // (if any) are automatically revoked on each column of the table, as well."
    //
    // Nothing is held table-wide afterwards, so CLAIM 1 is satisfied honestly —
    // nothing outstanding means nothing widened. But the contract's column
    // grant is gone, which is why CLAIM 2 exists and is asserted separately.
    const sql = `${narrow}revoke all on public.member_steward_requests from authenticated;\n`;
    const parsed = grantEvents([{ name: "20260726030000_x.sql", sql }]);
    expect(outstandingTableGrant(parsed, lock)).toBeNull();
    expect(outstandingColumnGrant(parsed, lock)).toBeNull();
  });

  it("keeps the column grant standing when only the GRANT OPTION is revoked", () => {
    const sql = `${narrow}revoke grant option for insert on public.member_steward_requests from authenticated;\n`;
    const parsed = grantEvents([{ name: "20260726030000_x.sql", sql }]);
    expect(outstandingTableGrant(parsed, lock)).toBeNull();
    expect(outstandingColumnGrant(parsed, lock)).not.toBeNull();
  });

  it("does not let a revoke from PUBLIC cancel a grant made directly to the role", () => {
    // "revoking SELECT privilege from PUBLIC does not necessarily mean that all
    // roles have lost SELECT privilege on the object: those who have it granted
    // directly ... will still have it."
    const sql = `${narrow}grant insert on public.member_steward_requests to authenticated;\n`
      + "revoke insert on public.member_steward_requests from public;\n";
    expect(heldBy(sql)).not.toBeNull();
  });

  it("ignores a grant on a different table, role or object class", () => {
    for (const noise of [
      "grant insert on public.member_forms to authenticated;",
      "grant insert on public.member_steward_requests to service_role;",
      "grant execute on function public.triage_steward_request(uuid) to authenticated;",
      "alter default privileges in schema public grant insert on tables to authenticated;",
    ]) {
      expect(heldBy(narrow + noise), noise).toBeNull();
    }
  });
});
