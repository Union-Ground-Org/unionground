#!/usr/bin/env node

// Ported on November 11, 2026 from an earlier repository's checker
// (scripts/verify-repository-conventions.mjs at 7ecfc1101c).
// Record and pull request numbers quoted below as "upstream #N" belong to that
// repository, not this one.
//
// Documents-as-code for the conventions this repository follows, and the
// deterministic checks that keep the documents true:
//
//   1. Migration identifiers  — docs/conventions/migration-naming.md
//   2. RLS policy rationale   — docs/conventions/rls-policy-comments.md
//   3. Provenance             — docs/conventions/provenance.md
//   4. Repository hygiene     — the added-file guard, the dependency-override
//                               register and its lockfile libc selectors, the
//                               Supabase CLI pin, the retired Supabase logs
//                               endpoint and Vercel's includeFiles cap
//   5. Shared-code guards     — the database contract inventories
//                               (docs/conventions/db-contract-inventories.md),
//                               Eastern-time and fixed-zone scans, swallowed
//                               errors and inline operation keys
//
// Left out of the port on purpose:
//   - The architecture-diagram notice and the design-proof-mechanisms document:
//     both describe the sibling product's diagrams and proof tooling, which this
//     repository does not have.
//   - The SAMPLE evidence write boundary: SAMPLE is the sibling product's
//     operator organization, and the check matched that product's host and
//     Supabase project, which never belong in this repository.
//
// Existing migrations are grandfathered twice over: everything at the comparison
// base is historical, and config/migration-conventions-baseline.json records the
// files that predate the rules, so the rules bind new migrations only.
//
// A deliberate inversion is encoded here. The donor repository's
// docs/conventions/migration-version-naming.md BANNED timestamp prefixes and
// scripts/lint-migrations.mjs enforced that ban. Every one of this repository's
// migrations uses a fourteen-digit timestamp prefix, because Supabase's CLI
// generates them and its remote history table is keyed on them. Porting the
// donor rule would have condemned the entire tree. What is checked below is the
// convention in force, not the one that was inherited.

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateDocument } from "./lib/provenance.mjs";
import { checkEasternTime } from "./lib/eastern-time-scan.mjs";
import { checkFixedZones } from "./lib/fixed-zone-scan.mjs";
import { inventoryOrderIssues } from "./lib/db-contract-inventories.mjs";
import { checkSwallowedErrors } from "./lib/swallowed-error-scan.mjs";
import { readRlsTableInventory } from "./lib/db-contract-tables.mjs";
import { checkInlineOperationKeys } from "./lib/inline-operation-key-scan.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "supabase", "migrations");
const baselinePath = join(root, "config", "migration-conventions-baseline.json");
const referenceDataDir = join(root, "data", "reference");

// The default branch. A pull request run passes its base commit in CI_BASE_SHA
// (or CONVENTIONS_BASE_REF); every other run compares against the merge base of
// HEAD with this ref.
const DEFAULT_BRANCH = "main";
const DEFAULT_BASE_REF = `origin/${DEFAULT_BRANCH}`;
const explicitBaseRef = () => process.env.CONVENTIONS_BASE_REF || process.env.CI_BASE_SHA || "";

const MIGRATION_NAME = /^(\d{14})_([a-z0-9]+(?:_[a-z0-9]+)*)\.sql$/;

// Anything that could carry a member, staff or organization identity out of the
// database and into a schema comment that every authenticated role can read.
const PROTECTED_IN_COMMENT = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/, "an email address"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, "a UUID"],
  [/\+\d[\d ()-]{7,}\d/, "a phone number"],
  [/(?<!\w)(?:1[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-]?)\d{3}[ .-]?\d{4}(?!\w)/, "a phone number"],
];

const failures = [];
const comparisonBaseMigrationNames = new Set();
const warnings = [];
// On a push to the default branch, two migration PRs that merged out of version
// order are already history; the duplicate-identifier check and the DB
// assurance (which applies migrations in version order on the merged tree)
// remain the guards there. Pull-request and local runs still fail.
const isMainPush = process.env.GITHUB_EVENT_NAME === "push" && process.env.GITHUB_REF === `refs/heads/${DEFAULT_BRANCH}`;
// A pull-request run's blob-filtered checkout has no token after checkout, so
// a base size it does not hold cannot be read there.
const isPullRequestRun = process.env.GITHUB_EVENT_NAME === "pull_request";
// The comparison base named by the environment. A pull request's CI_BASE_SHA is
// the default branch's tip when the run starts; a branch cut from an older tip
// does not contain it, so every change since the cut would read as this
// branch's. The merge base of that trusted tip and HEAD is still a commit of
// the default branch. When no merge base is held (a
// shallow checkout) the ref is returned unchanged and the callers fail closed.
let resolvedComparisonBase;
function comparisonBaseRef() {
  if (resolvedComparisonBase !== undefined) return resolvedComparisonBase || undefined;
  const ref = explicitBaseRef();
  resolvedComparisonBase = ref;
  if (!ref) return undefined;
  const git = (...args) => execFileSync("git", args, {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
  }).trim();
  try {
    const commit = git("rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`);
    try {
      git("merge-base", "--is-ancestor", commit, "HEAD");
    } catch {
      resolvedComparisonBase = git("merge-base", commit, "HEAD") || ref;
    }
  } catch {
    // Unresolvable ref or no merge base: leave it as given.
  }
  return resolvedComparisonBase;
}
function fail(message) {
  failures.push(message);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`${label} is not readable JSON: ${error.message}`);
    return null;
  }
}

function repoPath(absolute) {
  return relative(root, absolute).replaceAll("\\", "/");
}

// ---------------------------------------------------------------------------
// 1. Migration identifiers
// ---------------------------------------------------------------------------

// The first eight digits are a real calendar date. The last six are a SEQUENCE
// POSITION, not a clock reading, and fifteen migrations in the tree prove it:
// repairs reserve ordering space with values like 026000, 156000 and 240000,
// which are not valid times and were never meant to be. Rejecting them would be
// rejecting the convention this repository actually uses, so only the date half
// is checked as a date; the ordering half is checked as an ordering.
function datePartIsReal(stamp) {
  const year = Number(stamp.slice(0, 4));
  const month = Number(stamp.slice(4, 6));
  const day = Number(stamp.slice(6, 8));
  if (year < 2000 || year > 2999) return false;
  const at = new Date(Date.UTC(year, month - 1, day));
  return at.getUTCFullYear() === year
    && at.getUTCMonth() === month - 1
    && at.getUTCDate() === day;
}

function migrationFiles() {
  if (!existsSync(migrationsDir)) {
    fail("supabase/migrations does not exist");
    return [];
  }
  return readdirSync(migrationsDir).filter((name) => !name.startsWith(".")).sort();
}

function checkMigrationIdentifiers(names, baseline) {
  const duplicateSlugExempt = new Set(baseline?.duplicateSlugExempt ?? []);
  for (const name of duplicateSlugExempt) {
    if (!names.includes(name)) {
      fail(`config/migration-conventions-baseline.json exempts ${name} from the slug rule, but it no longer exists`);
    }
  }
  const byStamp = new Map();
  const bySlug = new Map();
  for (const name of names) {
    if (!name.endsWith(".sql")) {
      fail(`supabase/migrations/${name}: only .sql migrations belong in this directory`);
      continue;
    }
    const match = MIGRATION_NAME.exec(name);
    if (!match) {
      fail(`supabase/migrations/${name}: identifier must be <14-digit UTC timestamp>_<snake_case_slug>.sql`);
      continue;
    }
    const [, stamp, slug] = match;
    if (!datePartIsReal(stamp)) {
      fail(`supabase/migrations/${name}: ${stamp.slice(0, 8)} is not a real calendar date`);
      continue;
    }
    const duplicate = byStamp.get(stamp);
    if (duplicate) {
      fail(`supabase/migrations/${name}: duplicate migration identifier ${stamp}, already used by ${duplicate}`);
    } else {
      byStamp.set(stamp, name);
    }
    const sameSlug = bySlug.get(slug);
    if (sameSlug && !duplicateSlugExempt.has(name)) {
      fail(`supabase/migrations/${name}: slug "${slug}" repeats ${sameSlug}; a repaired migration needs a distinct slug so remote history stays readable`);
    } else if (!sameSlug) {
      bySlug.set(slug, name);
    }
  }
  // Read the base inventory from Git objects, never from candidate baseline JSON.
  // Use the local merge-base rule and the explicit CI coordinates without
  // fetching or moving refs.
  try {
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const ref = comparisonBaseRef();
    const base = ref
      ? git("rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`)
      : git("merge-base", "HEAD", DEFAULT_BASE_REF);
    git("merge-base", "--is-ancestor", base, "HEAD");
    const baseNames = git("ls-tree", "--name-only", base, "supabase/migrations/")
      .split("\n").filter(Boolean).map((path) => path.split("/").at(-1));
    comparisonBaseMigrationNames.clear();
    for (const name of baseNames) comparisonBaseMigrationNames.add(name);
    // After merging the default branch in, the current branch contains
    // migrations introduced on both parents. Treat files already present on the
    // first parent at that merge as historical too; otherwise the later
    // default-branch timestamp would incorrectly reject an earlier,
    // already-reviewed batch.
    const integratedNames = new Set();
    const latestMerge = git("log", "-1", "--first-parent", "--merges", "--format=%H", "HEAD");
    if (latestMerge) {
      const firstParentNames = git("ls-tree", "--name-only", `${latestMerge}^1`, "supabase/migrations/")
        .split("\n").filter(Boolean).map((path) => path.split("/").at(-1));
      for (const name of firstParentNames) integratedNames.add(name);
    }
    const baseVersions = new Set(baseNames.map((name) => MIGRATION_NAME.exec(name)?.[1]).filter(Boolean));
    const maximum = [...baseVersions].sort().at(-1);
    // A historical migration whose file was renamed (same version, content at
    // least half the same, Git's default rename detection) is still that
    // historical migration: the database records it by version, and its
    // content stays covered by the hash and replay checks. It is neither a
    // re-used version nor a new apply.
    const renamedHistorical = new Set();
    const renames = git("diff", "-M50%", "--name-status", "--diff-filter=R", "-z", base, "--", "supabase/migrations/").split("\0");
    for (let index = 0; index + 2 < renames.length; index += 3) {
      const before = renames[index + 1].split("/").at(-1);
      const after = renames[index + 2].split("/").at(-1);
      const version = MIGRATION_NAME.exec(after)?.[1];
      if (version && version === MIGRATION_NAME.exec(before)?.[1] && baseNames.includes(before)) renamedHistorical.add(after);
    }
    for (const name of names) {
      if (baseNames.includes(name) || integratedNames.has(name) || renamedHistorical.has(name)) continue;
      const stamp = MIGRATION_NAME.exec(name)?.[1];
      if (stamp && baseVersions.has(stamp)) fail(`${name}: re-used migration version ${stamp} from comparison base`);
      else if (stamp && maximum && stamp <= maximum) {
        const message = `${name}: added migration must follow comparison base maximum ${maximum}`;
        if (isMainPush) warnings.push(message);
        else fail(message);
      }
    }
    // The adopted baseline preserves older history as-is. Every migration
    // introduced after that baseline must remain one atomic unit, as documented
    // in migration-naming.md; a bare DDL file is not an acceptable new apply.
    // The ordering allowance above is not an atomicity exemption: a candidate
    // remains new even when it existed on the feature parent of a merge.
    for (const name of names.filter((candidate) => !baseNames.includes(candidate) && !renamedHistorical.has(candidate))) {
      try {
        const statements = sqlStatements(readFileSync(join(migrationsDir, name), "utf8"));
        validateTransactionWrapper(statements);
      } catch (error) {
        fail(`supabase/migrations/${name}: cannot validate transaction wrapper: ${error.message}`);
      }
    }
  } catch {
    fail(`migration ordering: cannot resolve an authenticated comparison base; provide an ancestor CONVENTIONS_BASE_REF or CI_BASE_SHA, or materialize ${DEFAULT_BASE_REF} history`);
  }
  return byStamp;
}

// ---------------------------------------------------------------------------
// 2. COMMENT ON POLICY rationale for new and materially changed policies
// ---------------------------------------------------------------------------

// Lex statements before recognizing policy grammar. SQL strings are opaque,
// including dollar bodies containing other dollar tags; nested block comments
// are discarded only outside literals. Semicolons inside expressions/literals
// never terminate a statement. Unsupported policy grammar fails closed.
function sqlStatements(sql) {
  const statements = [];
  let tokens = [], i = 0, depth = 0, separatorHasNewline = false;
  const push = (kind, value) => {
    tokens.push({ kind, value });
    separatorHasNewline = false;
  };
  while (i < sql.length) {
    // PostgreSQL's whitespace only: any other non-ASCII character, NBSP
    // included, is part of an identifier.
    if (/[ \t\n\r\f\v]/.test(sql[i])) {
      if (sql[i] === "\r" || sql[i] === "\n") separatorHasNewline = true;
      i++;
      continue;
    }
    if (sql.startsWith("--", i)) {
      let end = i + 2;
      while (end < sql.length && sql[end] !== "\r" && sql[end] !== "\n") end++;
      i = end;
      continue;
    }
    if (sql.startsWith("/*", i)) {
      const commentStart = i;
      let nested = 1; i += 2;
      while (i < sql.length && nested) {
        if (sql.startsWith("/*", i)) { nested++; i += 2; }
        else if (sql.startsWith("*/", i)) { nested--; i += 2; }
        else i++;
      }
      if (nested) throw new Error("unterminated block comment");
      if (/[\r\n]/.test(sql.slice(commentStart, i))) separatorHasNewline = true;
      continue;
    }
    const tag = /^\$(?:[a-zA-Z_][a-zA-Z0-9_]*)?\$/.exec(sql.slice(i))?.[0];
    if (tag) {
      const end = sql.indexOf(tag, i + tag.length);
      if (end < 0) throw new Error("unterminated dollar-quoted literal");
      push("literal", sql.slice(i + tag.length, end)); i = end + tag.length; continue;
    }
    if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i++]; let value = "", closed = false;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { value += quote; i += 2; }
          else { i++; closed = true; break; }
        } else value += sql[i++];
      }
      if (!closed) throw new Error("unterminated quoted token");
      if (quote === "'" && separatorHasNewline && tokens.at(-1)?.kind === "literal") {
        tokens.at(-1).value += value;
        separatorHasNewline = false;
      } else {
        push(quote === "'" ? "literal" : "identifier", value);
      }
      continue;
    }
    // Unquoted identifiers take any non-ASCII character, as in PostgreSQL, and
    // fold only ASCII letters: privées.reference_x is one schema name.
    const word = /^[a-zA-Z_\u0080-\uffff][a-zA-Z0-9_$\u0080-\uffff]*/.exec(sql.slice(i))?.[0];
    if (word) {
      if ((word.toLowerCase() === "e" && sql[i + word.length] === "'")
          || (word.toLowerCase() === "u" && ["&'", '&"'].includes(sql.slice(i + word.length, i + word.length + 2)))) {
        throw new Error("escape-string literals and U& identifiers are unsupported; use standard single, double or dollar quoting");
      }
      push("word", word.replace(/[A-Z]/g, (letter) => letter.toLowerCase())); i += word.length; continue;
    }
    const char = sql[i++];
    if (char === "(") depth++;
    if (char === ")" && --depth < 0) throw new Error("unbalanced parentheses");
    if (char === ";" && depth === 0) {
      if (tokens.length) statements.push(tokens);
      tokens = [];
      separatorHasNewline = false;
    }
    else push("symbol", char);
  }
  if (depth) throw new Error("unbalanced parentheses");
  if (tokens.length) statements.push(tokens);
  return statements;
}

function tokenIs(tokens, i, word) {
  return tokens[i]?.kind === "word" && tokens[i].value === word;
}

const TRANSACTION_CONTROL_WORDS = new Set([
  "begin", "start", "commit", "end", "rollback", "abort", "prepare", "savepoint", "release",
]);

// Return the complete transaction-control statement represented by one lexer
// statement, or null for ordinary SQL. A malformed statement that starts with
// a control keyword is explicitly invalid; treating it as DDL would let a
// prepared transaction or a second outer transaction evade the wrapper check.
function transactionControl(tokens) {
  const isName = (index) => ["word", "identifier"].includes(tokens[index]?.kind);
  const first = tokens[0]?.value;
  if (!TRANSACTION_CONTROL_WORDS.has(first)) return null;
  if (first === "begin" || first === "start") {
    if (first === "start" && !tokenIs(tokens, 1, "transaction")) return "invalid";
    if (first === "begin" && tokens.length > 2) return "invalid";
    if (first === "start" && tokens.length !== 2) return "invalid";
    if (first === "begin" && tokens.length === 2 && !["work", "transaction"].includes(tokens[1].value)) return "invalid";
    return "open";
  }
  const hasChainSuffix = (start) => {
    if (tokens.length === start) return true;
    if (!tokenIs(tokens, start, "and")) return false;
    if (tokenIs(tokens, start + 1, "chain") && tokens.length === start + 2) return true;
    return tokenIs(tokens, start + 1, "no")
      && tokenIs(tokens, start + 2, "chain")
      && tokens.length === start + 3;
  };
  if (first === "commit" || first === "end") {
    if (tokenIs(tokens, 1, "prepared")) return "prepared";
    const optionEnd = tokens.length > 1 && ["work", "transaction"].includes(tokens[1].value) ? 2 : 1;
    return hasChainSuffix(optionEnd) ? "close" : "invalid";
  }
  if (first === "prepare") {
    return tokenIs(tokens, 1, "transaction") ? "prepared" : "invalid";
  }
  if (first === "rollback" || first === "abort") {
    if (first === "rollback" && tokenIs(tokens, 1, "prepared")) return "prepared";
    const optionEnd = tokens.length > 1 && ["work", "transaction"].includes(tokens[1].value) ? 2 : 1;
    if (first === "abort" || !tokenIs(tokens, 1, "to")) {
      return hasChainSuffix(optionEnd) ? "rollback" : "invalid";
    }
    if (first === "rollback" && tokenIs(tokens, 1, "to")) {
      const nameIndex = tokenIs(tokens, 2, "savepoint") ? 3 : 2;
      return tokens.length === nameIndex + 1 && isName(nameIndex) ? "rollback-to" : "invalid";
    }
    return "invalid";
  }
  if (first === "savepoint") {
    return tokens.length === 2 && isName(1) ? "savepoint" : "invalid";
  }
  if (first === "release") {
    const nameIndex = tokenIs(tokens, 1, "savepoint") ? 2 : 1;
    return tokens.length === nameIndex + 1 && isName(nameIndex) ? "release-savepoint" : "invalid";
  }
  return "invalid";
}

function validateTransactionWrapper(statements) {
  const first = transactionControl(statements[0] ?? []);
  if (first !== "open") {
    if (first === "prepared") throw new Error("prepared transaction variants are not permitted");
    throw new Error("new migration must begin with BEGIN or START TRANSACTION;");
  }
  const last = transactionControl(statements.at(-1) ?? []);
  if (last === "prepared") throw new Error("prepared transaction variants are not permitted");
  if (last !== "close") throw new Error("new migration must end with COMMIT or END;");

  for (let index = 1; index < statements.length - 1; index++) {
    const control = transactionControl(statements[index]);
    if (control === "prepared") throw new Error("prepared transaction variants are not permitted");
    if (control === "invalid") throw new Error("incomplete transaction-control statement is not permitted");
    if (control === "open") throw new Error("nested transaction opening is not permitted");
    if (control === "close" || control === "rollback") {
      throw new Error("premature transaction termination is not permitted");
    }
    if (control === "rollback-to" || control === "savepoint" || control === "release-savepoint") continue;
  }
}

function routineStart(tokens, i = 0) {
  if (!tokenIs(tokens, i++, "create")) return false;
  if (tokenIs(tokens, i, "or") && tokenIs(tokens, i + 1, "replace")) i += 2;
  return tokenIs(tokens, i, "function") || tokenIs(tokens, i, "procedure");
}

// Reuse the lexer for executable bodies, not a regex over their raw text.
// Literals inside a body remain data unless EXECUTE consumes them. We do not
// infer procedural control flow or accept procedural rationale as proof of DDL;
// policy changes must remain top-level so their rationale is auditable.
function inspectExecutableBody(body, dynamic = false) {
  for (const tokens of sqlStatements(body)) {
    for (let i = 0; i < tokens.length; i++) {
      const is = (offset, word) => tokenIs(tokens, i + offset, word);
      if (((is(0, "create") || is(0, "alter")) && is(1, "policy"))
          || (is(0, "comment") && is(1, "on") && is(2, "policy"))) {
        throw new Error("policy DDL inside procedural/dynamic SQL is unsupported; move policy DDL and rationale to top-level statements");
      }
      if ((is(0, "do") && tokens[i + 1]?.kind === "literal")
          || (is(0, "do") && is(1, "language")) || routineStart(tokens, i)) {
        throw new Error("nested procedural/dollar bodies cannot be safely analyzed; move them to top-level statements");
      }
      if (is(0, "execute")) {
        // One narrowly bounded migration repair executes a function definition
        // read from pg_get_functiondef after replacing fixed, asserted fragments.
        // It cannot introduce policy DDL: the source is a known routine body and
        // the replacement is checked before execution. Keep all other dynamic
        // EXECUTE forms fail-closed.
        const knownFunctionRewrite = !dynamic
          && tokens[i + 1]?.kind === "word"
          && tokens[i + 1].value === "definition";
        const constantIntoAssignment = !dynamic
          && tokens[i + 1]?.kind === "literal"
          && tokens[i + 2]?.value === "into"
          && tokens[i + 3]?.kind === "word"
          && i + 4 === tokens.length;
        if (knownFunctionRewrite || constantIntoAssignment) continue;
        if (dynamic || tokens[i + 1]?.kind !== "literal" || i + 2 !== tokens.length) {
          throw new Error("dynamic EXECUTE cannot be safely analyzed; use one constant SQL literal without concatenation, format(), or other expressions");
        }
        inspectExecutableBody(tokens[i + 1].value, true);
      }
    }
  }
}

function inspectProceduralStatement(tokens) {
  if (tokenIs(tokens, 0, "do")) {
    const bodies = tokens.filter((token) => token.kind === "literal");
    if (bodies.length !== 1) throw new Error("DO requires one analyzable SQL body");
    inspectExecutableBody(bodies[0].value);
  } else if (routineStart(tokens)) {
    const as = tokens.findIndex((token) => token.kind === "word" && token.value === "as");
    if (as < 0 || tokens[as + 1]?.kind !== "literal" || tokens[as + 2]?.value === ",") {
      throw new Error("function/procedure requires one analyzable SQL body");
    }
    inspectExecutableBody(tokens[as + 1].value);
  } else if (tokenIs(tokens, 0, "execute")) {
    throw new Error("dynamic EXECUTE cannot be safely analyzed outside a supported procedural body");
  }
}

function policyStatement(tokens) {
  const is = (i, word) => tokens[i]?.kind === "word" && tokens[i].value === word;
  const comment = is(0, "comment") && is(1, "on") && is(2, "policy");
  const create = is(0, "create") && is(1, "policy");
  const alter = is(0, "alter") && is(1, "policy");
  if (!comment && !create && !alter) {
    inspectProceduralStatement(tokens);
    return null;
  }
  let i = comment ? 3 : 2;
  const identifier = () => {
    const token = tokens[i++];
    if (!["word", "identifier"].includes(token?.kind)) throw new Error("expected policy/table identifier");
    return /^[a-z_][a-z0-9_$]*$/.test(token.value) ? token.value : `"${token.value.replaceAll('"', '""')}"`;
  };
  const name = identifier();
  if (!is(i++, "on")) throw new Error("expected ON table");
  let table = identifier();
  if (tokens[i]?.value === ".") { i++; table += `.${identifier()}`; }
  const key = `${name} on ${table}`;
  if (comment) {
    if (!is(i++, "is") || tokens[i]?.kind !== "literal" || i + 1 !== tokens.length) {
      throw new Error("COMMENT ON POLICY requires one single-quoted or dollar-quoted literal");
    }
    return { key, body: tokens[i].value.trim() };
  }
  if (alter && is(i, "rename")) {
    i++;
    if (!is(i++, "to")) throw new Error("expected RENAME TO identifier");
    identifier();
    if (i !== tokens.length) throw new Error("unsupported RENAME POLICY tail");
    return null;
  }
  if (i < tokens.length && !(create ? ["as", "for", "to", "using", "with"] : ["to", "using", "with"]).some((word) => is(i, word))) {
    throw new Error("unsupported policy clause");
  }
  if (alter && i === tokens.length) throw new Error("missing ALTER POLICY clause");
  return { key, kind: create ? "new policy" : "materially altered policy" };
}

function checkPolicyComments(names, baseline) {
  const exempt = new Set(baseline?.policyCommentExempt ?? []);
  for (const name of exempt) {
    if (!names.includes(name)) fail(`config/migration-conventions-baseline.json exempts ${name}, which no longer exists`);
  }
  for (const name of names) {
    // Base migrations are historical evidence. If a later integration reveals
    // that a base file predates this convention, preserve its bytes and enforce
    // the rationale rule only on newly delivered migration files.
    if (comparisonBaseMigrationNames.has(name) || exempt.has(name) || !MIGRATION_NAME.test(name)) continue;
    const rationale = new Map(), required = new Map();
    try {
      for (const tokens of sqlStatements(readFileSync(join(migrationsDir, name), "utf8"))) {
        const policy = policyStatement(tokens);
        if (!policy) continue;
        const { key, body, kind } = policy;
        if (kind) { if (!required.has(key)) required.set(key, kind); continue; }
        rationale.set(key, body);
        // Inspect every write, even if a later comment overwrites it.
        for (const [pattern, described] of PROTECTED_IN_COMMENT) {
          if (pattern.test(body)) fail(`supabase/migrations/${name}: COMMENT ON POLICY ${key} contains ${described}; schema comments are readable by every role`);
        }
        if (body.length < 20) fail(`supabase/migrations/${name}: COMMENT ON POLICY ${key} must explain who the policy admits and why`);
      }
    } catch (error) {
      fail(`supabase/migrations/${name}: unsupported SQL/policy syntax: ${error.message}`);
    }
    for (const [key, kind] of required) {
      if (!rationale.has(key)) fail(`supabase/migrations/${name}: ${kind} ${key} has no COMMENT ON POLICY rationale`);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Supabase CLI pin
// ---------------------------------------------------------------------------
//
// `npm run verify:db:assurance` (scripts/run-database-assurance.mjs) runs
// `node_modules/.bin/supabase --version` and throws unless it equals
// `supabaseCliVersion` in config/database-assurance-baseline.json; the same
// binary is what `start-disposable-db-stack.mjs` and `run-required-db-proofs.mjs`
// drive. No CI job here runs that assurance, so without this check a Dependabot
// bump of the `supabase` devDependency would merge green and break the next
// person who runs it. Holding the pin here fails the bump in seconds until the
// reviewed baseline moves with it. (.)
function checkDatabaseAssuranceCliPin() {
  const manifest = readJson(join(root, "package.json"), "package.json");
  if (!manifest) return;
  const pinned = manifest.devDependencies?.supabase;
  if (typeof pinned !== "string") {
    fail("package.json devDependencies.supabase is missing; the database assurance CLI must stay pinned");
    return;
  }
  if (!/^\d+\.\d+\.\d+$/.test(pinned)) {
    fail(`package.json devDependencies.supabase must be an exact version, not ${JSON.stringify(pinned)}`);
    return;
  }
  const assuranceBaseline = readJson(
    join(root, "config", "database-assurance-baseline.json"),
    "config/database-assurance-baseline.json",
  );
  if (!assuranceBaseline) return;
  if (assuranceBaseline.supabaseCliVersion !== pinned) {
    fail(
      `package.json pins supabase ${pinned} but config/database-assurance-baseline.json reviewed `
      + `supabaseCliVersion ${JSON.stringify(assuranceBaseline.supabaseCliVersion)}; `
      + "update the baseline in the same change so the database lane replays the migrations against this CLI",
    );
    return;
  }
  // The manifest string is not what CI installs: `npm ci` installs exactly the
  // lockfile, and an `overrides` entry or a hand-edited lockfile can move the
  // binary while `devDependencies.supabase` stays put. The `supabase` package
  // only carries the `supabase` bin wrapper; the platform packages
  // `@supabase/cli-*` carry the executable it runs. Checking the locked
  // versions covers every route to a different binary without reasoning about
  // npm's override semantics. ( gate round 2.)
  const lock = readJson(join(root, "package-lock.json"), "package-lock.json");
  if (!lock) return;
  const locked = lock.packages ?? {};
  if (typeof locked["node_modules/supabase"]?.version !== "string") {
    fail("package-lock.json has no node_modules/supabase entry; the database assurance CLI must stay locked");
    return;
  }
  // Match nested copies too: npm may place a platform package under
  // node_modules/supabase/node_modules/, and Node's resolution prefers the
  // nested copy over the hoisted one. ( gate round 3, named both
  // this and the empty-set case below.)
  const cliPackages = ["node_modules/supabase", ...Object.keys(locked)
    .filter((name) => /(?:^|\/)node_modules\/@supabase\/cli-[a-z0-9-]+$/.test(name))].sort();
  for (const name of cliPackages) {
    const version = locked[name]?.version;
    if (version !== pinned) {
      fail(
        `package-lock.json locks ${name} at ${JSON.stringify(version)} but the reviewed database assurance `
        + `CLI version is ${pinned}; an override or lockfile edit that moves the installed CLI must update `
        + "config/database-assurance-baseline.json so the database lane replays against it",
      );
    }
  }
  // Checking only the entries that are present passes a lockfile with none of
  // them, which installs the bin wrapper and no executable for it to run. CI
  // runs on linux-x64, so that package must be there; the wrapper's own
  // optionalDependencies map is the declared set and must name the same version
  // it resolves.
  if (typeof locked["node_modules/@supabase/cli-linux-x64"]?.version !== "string") {
    fail(
      "package-lock.json has no node_modules/@supabase/cli-linux-x64 entry; that is the executable the "
      + "database lane's CLI wrapper runs on the runner, and without it the lane installs a wrapper with "
      + "nothing to execute",
    );
  }
  for (const [name, range] of Object.entries(locked["node_modules/supabase"].optionalDependencies ?? {})) {
    if (/^@supabase\/cli-[a-z0-9-]+$/.test(name) && range !== pinned) {
      fail(
        `package-lock.json has the supabase wrapper depending on ${name} at ${JSON.stringify(range)} rather `
        + `than the reviewed ${pinned}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Provenance
// ---------------------------------------------------------------------------

// A table whose name starts with catalog_, reference_, research_ or content_
// carries `provenance pg_catalog.jsonb not null` and the documented CHECK, so a
// row without its source cannot be stored. Earlier rounds listed the shapes to
// refuse, and each review found another. This rule fails closed instead: a
// statement may name a provenance table only in a shape known to leave the
// column and its CHECK intact. It binds migrations added after this repository
// adopted the rule; every migration up to the last one present at adoption
// (including tables such as reference_ulp_limitation_periods, imported before
// the column type had to be qualified) keeps the columns it was written with.
const PROVENANCE_TABLE = /^(?:catalog|reference|research|content)_/i;
const PROVENANCE_ADOPTED_AFTER_VERSION = "20261019224500";
// The same text as docs/conventions/provenance.md, matched token for token:
// naming a key is not requiring it ('url' = 'url', or an OR).
const PROVENANCE_CHECK_PREDICATE = `(
    jsonb_typeof(provenance) = 'object'
    and coalesce(provenance ->> 'provenance_id', '') ~ '^prov-[0-9a-f]{64}$'
    and pg_catalog.btrim(coalesce(provenance -> 'source' ->> 'url', '')) ~ '^https?://'
    and pg_catalog.btrim(coalesce(provenance -> 'source' ->> 'publisher', '')) <> ''
    and pg_catalog.btrim(coalesce(provenance ->> 'retrieved_at', '')) <> ''
    and coalesce(provenance ->> 'content_sha256', '') ~ '^[0-9a-f]{64}$'
    and pg_catalog.btrim(coalesce(provenance -> 'capture' ->> 'method', '')) <> ''
    and pg_catalog.btrim(coalesce(provenance ->> 'as_of', '')) <> ''
    and pg_catalog.btrim(coalesce(provenance -> 'review' ->> 'status', '')) <> ''
  )`;
// JSON keeps token boundaries: a literal cannot pose as several tokens.
const tokenText = (tokens) => JSON.stringify(tokens.map((token) => [token.kind, token.value]));
const PROVENANCE_CHECK_TOKENS = tokenText(sqlStatements(`select ${PROVENANCE_CHECK_PREDICATE}`)[0].slice(1));
const PROVENANCE_DOC = "docs/conventions/provenance.md";
const PROVENANCE_HIDDEN = "a provenance table is created only by a top-level CREATE TABLE, never inside CREATE SCHEMA, a DO block, a routine body or an EXECUTE string";
const PROVENANCE_ALLOWED = "a provenance table may be named only by the documented CREATE TABLE, DML, GRANT/REVOKE, COMMENT, DROP, CREATE INDEX, CREATE POLICY, a routine or view that reads it, or an ALTER that leaves its provenance column and CHECK alone";

const isName = (token) => token?.kind === "word" || token?.kind === "identifier";
const isScoped = (token) => isName(token) && PROVENANCE_TABLE.test(token.value);
const isSymbol = (token, value) => token?.kind === "symbol" && token.value === value;

// PostgreSQL truncates an identifier to 63 bytes (NAMEDATALEN - 1) without
// splitting a character, so names are compared the way it stores them: an
// overlong operand can otherwise name a protected constraint unseen.
function pgIdentifier(value) {
  let bytes = 0, stored = "";
  for (const char of String(value)) {
    bytes += Buffer.byteLength(char);
    if (bytes > 63) break;
    stored += char;
  }
  return stored;
}

// The relation is the last component of database.schema.table.
function qualifiedName(tokens, i) {
  let table = isName(tokens[i]) ? tokens[i++].value : null;
  while (table && isSymbol(tokens[i], ".")) table = isName(tokens[++i]) ? tokens[i++].value : null;
  return { table: table === null ? null : pgIdentifier(table), next: i };
}

// Split tokens at commas outside parentheses: CREATE TABLE elements, ALTER
// TABLE actions and CREATE SCHEMA has no commas, so it does its own split.
function splitTopLevel(tokens) {
  const parts = [[]];
  let depth = 0;
  for (const token of tokens) {
    if (isSymbol(token, "(")) depth++;
    if (isSymbol(token, ")")) depth--;
    if (depth === 0 && isSymbol(token, ",")) { parts.push([]); continue; }
    parts.at(-1).push(token);
  }
  return parts.filter((part) => part.length);
}

// The index of the parenthesis that closes the one at `start`, or -1.
function closingParen(tokens, start) {
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    if (isSymbol(tokens[i], "(")) depth++;
    if (isSymbol(tokens[i], ")") && --depth === 0) return i;
  }
  return -1;
}

// INSERT INTO and MERGE INTO write rows, which the CHECK then judges, but only
// when INSERT or MERGE is the verb: at the start, opening a WITH clause's
// data-modifying query, or after the WITH list. In `select 1 as insert into t`
// it is a column alias, and the INTO creates t.
function writesInto(tokens, k) {
  const verb = k - 1;
  if (!tokenIs(tokens, verb, "insert") && !tokenIs(tokens, verb, "merge")) return false;
  if (verb === 0 || isSymbol(tokens[verb - 1], "(")) return true;
  if (!tokenIs(tokens, 0, "with")) return false;
  let depth = 0;
  for (let i = 0; i < verb; i++) {
    if (isSymbol(tokens[i], "(")) depth++;
    else if (isSymbol(tokens[i], ")")) depth--;
    else if (depth === 0 && ["select", "values", "table", "insert", "update", "delete", "merge"].some((word) => tokenIs(tokens, i, word))) return false;
  }
  return depth === 0;
}

// SELECT ... INTO (top level, in a SQL routine, or as a prepared statement)
// creates a table with whatever columns the query yields.
function intoProvenanceTable(tokens) {
  for (let k = 0; k < tokens.length; k++) {
    if (!tokenIs(tokens, k, "into") || writesInto(tokens, k)) continue;
    let i = k + 1;
    while (["temp", "temporary", "unlogged", "table", "strict"].some((word) => tokenIs(tokens, i, word))) i++;
    const { table } = qualifiedName(tokens, i);
    if (table && PROVENANCE_TABLE.test(table)) return table;
  }
  return null;
}

// INHERITS (...) and PARTITION OF put rows in a child that the parent shows.
function inheritsOrPartitionsScoped(tokens, from) {
  for (let i = from; i < tokens.length; i++) {
    if (tokenIs(tokens, i, "partition") && tokenIs(tokens, i + 1, "of") && isScoped(tokens[qualifiedName(tokens, i + 2).next - 1])) return true;
    if (tokenIs(tokens, i, "inherits") && isSymbol(tokens[i + 1], "(")) {
      if (tokens.slice(i + 2, closingParen(tokens, i + 1)).some(isScoped)) return true;
    }
  }
  return false;
}

// The documented CREATE TABLE, and nothing looser: exactly `create table
// <name> (`, the column as exactly `provenance pg_catalog.jsonb not null`, the element
// `constraint <table>_provenance_complete check (<predicate>)` with nothing
// after the predicate (NO INHERIT, NOT VALID and NOT ENFORCED all weaken it),
// no LIKE element, and nothing after the element list.
function documentedTableFindings(tokens, table, body) {
  const close = isSymbol(tokens[body], "(") ? closingParen(tokens, body) : -1;
  if (close < 0) return ["must declare its columns inline, including provenance pg_catalog.jsonb not null"];
  if (close !== tokens.length - 1) return ["nothing may follow the column list (no INHERITS, PARTITION BY, WITH, TABLESPACE or AS)"];
  const elements = splitTopLevel(tokens.slice(body + 1, close));
  if (elements.some((element) => tokenIs(element, 0, "like"))) return ["a LIKE element may copy a second provenance column or default; declare every column"];
  const column = elements.find((element) => isName(element[0]) && element[0].value === "provenance");
  if (column?.some((_, i) => tokenIs(column, i, "default") || tokenIs(column, i, "generated"))) {
    return ["the provenance column must not have a default or be generated; a row without its record is refused, never filled"];
  }
  // Exactly these six tokens: a "not null" nested in a column CHECK would
  // leave the column nullable, and the named CHECK passes a NULL. The type is
  // qualified because pg_temp is searched for types before pg_catalog, so a
  // temporary domain or table named jsonb could otherwise take the column and
  // later drop it with CASCADE.
  if (column?.length !== 6 || !tokenIs(column, 1, "pg_catalog") || !isSymbol(column[2], ".") || !tokenIs(column, 3, "jsonb")
    || !tokenIs(column, 4, "not") || !tokenIs(column, 5, "null")) {
    return ["must declare the column as exactly provenance pg_catalog.jsonb not null"];
  }
  const constraintName = `${table.toLowerCase()}_provenance_complete`;
  // PostgreSQL truncates identifiers to 63 bytes, so a longer name would be
  // stored as something an ALTER guarding the full name never matches.
  if (Buffer.byteLength(constraintName) > 63) {
    return [`the constraint name ${constraintName} is longer than 63 bytes and PostgreSQL would truncate it; shorten the table name`];
  }
  const required = elements.some((element) => tokenIs(element, 0, "constraint")
    && isName(element[1]) && element[1].value === constraintName
    && tokenIs(element, 2, "check")
    && tokenText(element.slice(3)) === PROVENANCE_CHECK_TOKENS);
  if (!required) {
    return [`provenance needs the documented CHECK predicate verbatim as constraint ${constraintName}, with nothing after it; every required key must be required, not just named`];
  }
  return [];
}

// ALTER of any relation kind: ALTER INDEX, VIEW and SEQUENCE can rename a
// table too, so all of them are read as ALTER TABLE. On a provenance table
// each action must start with a known word (so OF, which ties the table to a
// composite type that ALTER TYPE ... CASCADE could then strip, is refused) and
// leave the provenance column and its constraint alone; only ADD CHECK, which
// can only restrict, may mention them. No relation is renamed to or from a
// provenance name, and none inherits or partitions one.
const SCOPED_ALTER_ACTIONS = new Set([
  "add", "alter", "drop", "rename", "enable", "disable", "force", "owner", "set", "reset", "replica", "cluster", "validate",
  "restart", "increment", "start", "minvalue", "maxvalue", "cache", "cycle", "owned",
]);
function alterRelationFindings(tokens, at) {
  let i = at;
  if (tokenIs(tokens, i, "if") && tokenIs(tokens, i + 1, "exists")) i += 2;
  if (tokenIs(tokens, i, "only")) i++;
  const { table, next } = qualifiedName(tokens, i);
  if (!table) return tokens.some(isScoped) ? ["ALTER of several relations at once may not name a provenance table"] : [];
  const scopedTarget = PROVENANCE_TABLE.test(table);
  const protectedName = `${table.toLowerCase()}_provenance_complete`;
  const findings = [];
  for (const action of splitTopLevel(tokens.slice(isSymbol(tokens[next], "*") ? next + 1 : next))) {
    const renameTo = tokenIs(action, 0, "rename") && tokenIs(action, 1, "to");
    if (renameTo && (scopedTarget || isScoped(action[2]))) {
      findings.push(`table ${table}: ALTER may not rename a provenance table, or any relation to a provenance name`);
    } else if ((tokenIs(action, 0, "inherit") || (tokenIs(action, 0, "no") && tokenIs(action, 1, "inherit"))
      || tokenIs(action, 0, "attach") || tokenIs(action, 0, "detach"))
      && (scopedTarget || action.some(isScoped))) {
      findings.push(`table ${table}: INHERIT and ATTACH or DETACH PARTITION may not involve a provenance table`);
    } else if (scopedTarget && !(SCOPED_ALTER_ACTIONS.has(action[0]?.value)
      || (tokenIs(action, 0, "no") && ["force", "minvalue", "maxvalue", "cycle"].some((word) => tokenIs(action, 1, word))))) {
      findings.push(`table ${table}: ALTER ${String(action[0]?.value).toUpperCase()} is not an action known to leave the provenance column and CHECK intact`);
    } else if (scopedTarget) {
      const addCheck = tokenIs(action, 0, "add") && (tokenIs(action, 1, "check")
        || (tokenIs(action, 1, "constraint") && pgIdentifier(action[2]?.value ?? "") !== protectedName && tokenIs(action, 3, "check")));
      const touches = action.some((token) => isName(token) && ["provenance", protectedName].includes(pgIdentifier(token.value)));
      if (touches && !addCheck) {
        findings.push(`table ${table}: ALTER may not change the provenance column or its ${protectedName} constraint`);
      }
    }
  }
  return findings;
}

// Read a DO body, a routine body or an EXECUTE operand as SQL. Procedural
// code puts statements after BEGIN, IF ... THEN and the like, so every CREATE,
// ALTER, IMPORT or DO is judged where it starts. EXECUTE must run one constant
// string: SQL assembled from format(), || or a variable names its table only
// at run time. In PL/pgSQL, SELECT ... INTO assigns a variable; in SQL (an
// EXECUTE string or a LANGUAGE sql routine) it creates a table.
function bodyFindings(body, depth, plpgsql) {
  if (depth > 3) return ["procedural bodies nest too deeply to check for provenance tables"];
  let statements;
  try {
    statements = sqlStatements(body);
  } catch (error) {
    return [`a DO, routine or EXECUTE body the checker cannot read: ${error.message}`];
  }
  const findings = [];
  for (const statement of statements) {
    const into = plpgsql ? null : intoProvenanceTable(statement);
    if (into) findings.push(`table ${into}: SELECT ... INTO may not create a provenance table`);
    const searchPath = searchPathFinding(statement);
    if (searchPath) findings.push(searchPath);
    for (let at = 0; at < statement.length; at++) {
      if (tokenIs(statement, at, "execute") && !tokenIs(statement, at - 1, "grant") && !tokenIs(statement, at - 1, "revoke")
        && !["on", "function", "procedure"].some((word) => tokenIs(statement, at + 1, word))) {
        const operand = statement[at + 1];
        const after = statement[at + 2];
        if (operand?.kind !== "literal" || (after && !tokenIs(statement, at + 2, "using") && !tokenIs(statement, at + 2, "into"))) {
          findings.push("EXECUTE in a DO or routine body must run one constant string; SQL assembled from format(), || or a variable cannot be checked for provenance tables");
        } else {
          findings.push(...bodyFindings(operand.value, depth + 1, false));
        }
      }
      const doBody = tokenIs(statement, at, "do") && (statement[at + 1]?.kind === "literal" || tokenIs(statement, at + 1, "language"));
      if (doBody || ["create", "alter", "import"].some((word) => tokenIs(statement, at, word))) {
        findings.push(...statementFindings(statement.slice(at), depth + 1));
      }
    }
  }
  return findings;
}

function routineLanguage(tokens, fallback) {
  const at = tokens.findIndex((_, k) => tokenIs(tokens, k, "language"));
  return at < 0 ? fallback : String(tokens[at + 1]?.value ?? "").toLowerCase();
}

// The CHECK's operators (=, ~, <>, ->, ->>) and jsonb_typeof resolve through
// search_path when the table is created. pg_catalog is searched first unless
// a search_path names it after another schema, which would let an operator
// there make the CHECK always true. Returns the failure text, or null.
// The schema names one search_path token gives, as PostgreSQL reads them, or
// null when the checker cannot be sure. In SET, every entry is one exact name:
// a word is already lowercased, a quoted identifier keeps its case and spaces,
// and a string is not split, trimmed or lowercased ('PG_CATALOG' and
// 'pg_catalog ' are other schemas, which PostgreSQL skips when missing), so a
// SET string must be '' or a plain lowercase name. A set_config value is
// parsed as a list: split on commas, each part trimmed of PostgreSQL's
// whitespace and ASCII-lowercased; one holding a double quote is refused,
// since quotes there change both splitting and case.
function searchPathEntries(token, inSet) {
  if (token.kind !== "literal") return [token.value];
  const value = String(token.value);
  if (inSet) return /^(?:[a-z_][a-z0-9_$]*)?$/.test(value) ? [value] : null;
  if (value.includes('"')) return null;
  return value.split(",").map((schema) => schema.replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/g, "").replace(/[A-Z]/g, (c) => c.toLowerCase()));
}

function searchPathFinding(tokens) {
  const refused = "search_path may not put another schema ahead of pg_catalog: an operator or function there could shadow the ones the provenance CHECK uses";
  for (let k = 0; k < tokens.length; k++) {
    let schemas = [];
    // A configuration name may be quoted: SET LOCAL "search_path" TO ...
    if (isName(tokens[k]) && tokens[k].value.toLowerCase() === "search_path") {
      let i = k + 1;
      if (isSymbol(tokens[i], "=") || tokenIs(tokens, i, "to")) i++;
      while (isName(tokens[i]) || tokens[i]?.kind === "literal") {
        const entries = searchPathEntries(tokens[i++], true);
        if (!entries) return refused;
        schemas.push(...entries);
        if (!isSymbol(tokens[i], ",")) break;
        i++;
      }
    } else if (isName(tokens[k]) && tokens[k].value === "set_config" && isSymbol(tokens[k + 1], "(")) {
      // Only a constant setting name and, for search_path, a constant value
      // can be judged: '' || 'private, pg_catalog' or format() cannot.
      if (tokens[k + 2]?.kind !== "literal" || !isSymbol(tokens[k + 3], ",")) {
        return "set_config must name its setting with one constant string, so the checker can tell whether it changes search_path";
      }
      if (tokens[k + 2].value.trim().toLowerCase() !== "search_path") continue;
      if (tokens[k + 4]?.kind !== "literal" || !isSymbol(tokens[k + 5], ",")) return refused;
      schemas = searchPathEntries(tokens[k + 4], false);
      if (!schemas) return refused;
    }
    if (schemas.indexOf("pg_catalog") > 0) return refused;
    // With standard_conforming_strings off, backslash escapes in a string
    // decode to SQL the checker never read, so the setting is not changed.
    const named = isName(tokens[k]) ? tokens[k].value.toLowerCase()
      : tokenIs(tokens, k - 2, "set_config") && tokens[k]?.kind === "literal" ? tokens[k].value.trim().toLowerCase() : "";
    if (named === "standard_conforming_strings") {
      return "standard_conforming_strings may not be changed: with it off, backslash escapes decode to SQL the checker cannot read";
    }
  }
  return null;
}

const HARMLESS_STATEMENTS = new Set([
  "select", "with", "values", "insert", "update", "delete", "merge", "copy", "truncate",
  "grant", "revoke", "comment", "drop", "analyze", "vacuum", "reindex", "cluster", "refresh", "notify", "set", "reset", "lock",
  ...TRANSACTION_CONTROL_WORDS,
]);
const HARMLESS_CREATE = new Set(["index", "unique", "policy", "type", "domain", "sequence", "extension"]);
const HARMLESS_ALTER = new Set(["function", "procedure", "routine", "policy", "default", "publication", "schema", "role", "type", "domain", "extension"]);

// One statement, top level (depth 0) or inside a body or schema element.
// Returns the failure texts. Statements of a kind not listed here may not name
// a provenance identifier at all: that is what makes the rule fail closed.
function statementFindings(tokens, depth = 0) {
  const scopedMention = tokens.find(isScoped);
  const refuse = () => (scopedMention
    ? [`${tokens.slice(0, 2).map((token) => token.value).join(" ").toUpperCase()} names ${scopedMention.value}: ${PROVENANCE_ALLOWED}`]
    : []);
  if (tokenIs(tokens, 0, "do")) {
    const body = tokenIs(tokens, 1, "language") ? tokens[3] : tokens[1];
    if (body?.kind !== "literal") return ["DO needs one readable body to check for provenance tables"];
    return bodyFindings(body.value, depth, routineLanguage(tokens, "plpgsql") === "plpgsql");
  }
  if (routineStart(tokens)) {
    const as = tokens.findIndex((_, k) => tokenIs(tokens, k, "as"));
    if (tokens[as + 1]?.kind !== "literal") return ["a function or procedure needs one readable AS body to check for provenance tables"];
    return bodyFindings(tokens[as + 1].value, depth, routineLanguage(tokens, "sql") === "plpgsql");
  }
  if (tokenIs(tokens, 0, "import") && tokenIs(tokens, 1, "foreign")) {
    return ["IMPORT FOREIGN SCHEMA is refused: it creates tables whose names and columns the migration does not state"];
  }
  if (tokenIs(tokens, 0, "alter")) {
    let i = 1;
    if (tokenIs(tokens, i, "foreign") || tokenIs(tokens, i, "materialized")) i++;
    if (["table", "view", "index", "sequence"].some((word) => tokenIs(tokens, i, word))) return alterRelationFindings(tokens, i + 1);
    return HARMLESS_ALTER.has(tokens[1]?.value) ? [] : refuse();
  }
  if (!tokenIs(tokens, 0, "create")) return HARMLESS_STATEMENTS.has(tokens[0]?.value) ? [] : refuse();

  let i = 1;
  if (tokenIs(tokens, i, "or") && tokenIs(tokens, i + 1, "replace")) i += 2;
  const modifiers = [];
  while (["global", "local", "temp", "temporary", "unlogged", "foreign", "materialized", "recursive", "constraint"].some((word) => tokenIs(tokens, i, word))) {
    modifiers.push(tokens[i++].value);
  }
  const kind = tokens[i++]?.value;
  if (kind === "schema") {
    // Schema elements start at each CREATE or GRANT after the header.
    const starts = tokens.map((_, k) => k).filter((k) => k > i && (tokenIs(tokens, k, "create") || tokenIs(tokens, k, "grant")));
    return starts.flatMap((start, n) => statementFindings(tokens.slice(start, starts[n + 1]), depth + 1));
  }
  if (kind === "view") {
    if (tokenIs(tokens, i, "if") && tokenIs(tokens, i + 1, "not") && tokenIs(tokens, i + 2, "exists")) i += 3;
    const { table } = qualifiedName(tokens, i);
    return table && PROVENANCE_TABLE.test(table) ? [`view ${table}: ${PROVENANCE_ALLOWED}; a provenance name is for the documented table only`] : [];
  }
  if (kind === "trigger") {
    const on = tokens.findIndex((_, k) => k > i && tokenIs(tokens, k, "on"));
    const { table } = qualifiedName(tokens, on + 1);
    return table && PROVENANCE_TABLE.test(table) ? [`table ${table}: a trigger could fill or rewrite provenance before the CHECK runs; ${PROVENANCE_ALLOWED}`] : [];
  }
  if (kind === "operator") return ["CREATE OPERATOR is refused: it could shadow an operator the provenance CHECK uses"];
  if (kind !== "table") return HARMLESS_CREATE.has(kind) ? [] : refuse();

  const ifNotExists = tokenIs(tokens, i, "if") && tokenIs(tokens, i + 1, "not") && tokenIs(tokens, i + 2, "exists");
  if (ifNotExists) i += 3;
  const { table, next } = qualifiedName(tokens, i);
  if (!table) return ["CREATE TABLE without a readable table name"];
  if (!PROVENANCE_TABLE.test(table)) {
    return inheritsOrPartitionsScoped(tokens, next) ? [`table ${table}: INHERITS and PARTITION OF may not involve a provenance table`] : [];
  }
  if (modifiers.includes("foreign")) return [`table ${table}: CREATE FOREIGN TABLE may not take a provenance name; its rows never pass the CHECK`];
  if (depth > 0) return [`table ${table}: ${PROVENANCE_HIDDEN}`];
  if (modifiers.length || ifNotExists) {
    return [`table ${table}: declare it as exactly create table <name> (...); IF NOT EXISTS would keep an older table that never had the CHECK`];
  }
  return documentedTableFindings(tokens, table, next).map((message) => `table ${table}: ${message}`);
}

function checkProvenanceMigrations(names) {
  let tables = 0;
  for (const name of names) {
    const stamp = MIGRATION_NAME.exec(name)?.[1];
    if (!stamp || stamp <= PROVENANCE_ADOPTED_AFTER_VERSION || comparisonBaseMigrationNames.has(name)) continue;
    const { findings, tables: created } = provenanceFindings(readFileSync(join(migrationsDir, name), "utf8"));
    tables += created;
    for (const message of findings) fail(`supabase/migrations/${name}: ${message} (${PROVENANCE_DOC})`);
  }
  return tables;
}

// The rule over one migration's text: the failure texts and the number of
// provenance tables it creates. Exported so the tests can run it over every
// migration in the tree, not only the ones after the adoption version.
export function provenanceFindings(sql) {
  let statements;
  try {
    statements = sqlStatements(sql);
  } catch (error) {
    return { findings: [`cannot read the SQL for the provenance rule: ${error.message}`], tables: 0 };
  }
  const findings = [];
  let tables = 0;
  for (const tokens of statements) {
    const into = intoProvenanceTable(tokens);
    if (into) findings.push(`table ${into}: SELECT ... INTO may not create a provenance table`);
    const searchPath = searchPathFinding(tokens);
    if (searchPath) findings.push(searchPath);
    const own = statementFindings(tokens);
    findings.push(...own);
    if (!own.length && tokenIs(tokens, 0, "create") && tokenIs(tokens, 1, "table") && PROVENANCE_TABLE.test(qualifiedName(tokens, 2).table ?? "")) tables++;
  }
  // A schema element or nested body can be reached twice; report it once.
  return { findings: [...new Set(findings)], tables };
}

// Reference data files under data/reference/ are provenance documents: every
// record in them validates against scripts/lib/provenance.mjs.
// Only real directories and regular files may sit under data/reference/: a
// symlink (or a FIFO, socket or device) is neither, so the walk would pass it
// by unvalidated. Refusing it keeps every document checked where it lives.
function referenceDataFiles(dir) {
  if (!existsSync(dir) && !lstatSync(dir, { throwIfNoEntry: false })) return [];
  if (!lstatSync(dir).isDirectory()) {
    fail(`${repoPath(dir)} must be a real directory, not a symlink or other special file`);
    return [];
  }
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return referenceDataFiles(path);
    if (!entry.isFile()) {
      fail(`${repoPath(path)} must be a regular file or directory; symlinks and other special files under data/reference/ are refused`);
      return [];
    }
    return entry.name.endsWith(".json") ? [path] : [];
  }).sort();
}

function checkReferenceData() {
  const files = referenceDataFiles(referenceDataDir);
  for (const path of files) {
    const label = repoPath(path);
    // Parse here rather than through readJson: a file holding JSON null is a
    // document (and an invalid one), not a read failure to skip.
    let document;
    try {
      document = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      fail(`${label} is not readable JSON: ${error.message}`);
      continue;
    }
    const { errors } = validateDocument(document);
    for (const message of errors) fail(`${label}: ${message}`);
  }
  return files.length;
}

function checkDocuments() {
  for (const path of [
    "docs/conventions/migration-naming.md",
    "docs/conventions/rls-policy-comments.md",
    "docs/conventions/provenance.md",
  ]) {
    if (!existsSync(join(root, path))) fail(`${path} is missing`);
  }
}

// ---------------------------------------------------------------------------
// 5. Repository hygiene
// ---------------------------------------------------------------------------

// Supabase retired the Management API's logs.all analytics endpoint. Tooling
// copied from the sibling repository is the likeliest way it comes back, so keep
// runnable examples and tooling on the supported path. Retained vendor schemas
// under are historical evidence and stay unchanged.
function checkSupabaseLogsEndpoint() {
  const retiredEndpoint = ["analytics", "endpoints", "logs.all"].join("/");
  let matches;
  try {
    matches = execFileSync("git", [
      "grep", "-I", "-l", "-z", "-F", retiredEndpoint,
      "--", ".", ":(exclude)docs/operations/evidence/**",
    ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (error.status === 1) return; // No matches, not a failed scan.
    fail("Supabase logs endpoint: cannot scan tracked files");
    return;
  }
  for (const path of matches.split("\0").filter(Boolean)) {
    fail(`${path}: retired Supabase logs endpoint; use analytics/endpoints/logs with ClickHouse SQL`);
  }
}

// Vercel's vercel.json schema refuses an includeFiles value longer than 256
// characters ("should NOT be longer than 256 characters") and fails the
// deployment before the build, so no other CI step sees it.
// Returns the longest pattern so the OK line shows the remaining headroom.
const VERCEL_INCLUDE_FILES_MAX = 256;

function checkVercelIncludeFiles() {
  const path = join(root, "vercel.json");
  if (!existsSync(path)) return null;
  const config = readJson(path, "vercel.json");
  let longest = null;
  for (const [name, settings] of Object.entries(config?.functions ?? {})) {
    const pattern = settings?.includeFiles;
    if (typeof pattern !== "string") continue;
    if (!longest || pattern.length > longest.length) longest = { name, length: pattern.length };
    if (pattern.length > VERCEL_INCLUDE_FILES_MAX) {
      fail(
        `vercel.json: functions["${name}"].includeFiles is ${pattern.length} characters;`
          + ` Vercel refuses more than ${VERCEL_INCLUDE_FILES_MAX}`,
      );
    }
  }
  return longest;
}

// Binary evidence and large files stay out of this repository. In the sibling
// repository 1,694 evidence files, 130 MB of them screenshots, landed in 2.4
// days before this guard existed. Screenshots, PDFs and dumps go on the
// issue or pull request as an attachment, and this repository keeps at most a
// hash line.
// Additions are judged, and so is a path whose bytes are replaced: new bytes at
// an existing evidence binary, or a file that crosses 1 MB or grows by more
// than 1 MB in one change. A byte-identical rename is not new bytes. Files
// already over 1 MB, such as scripts/db-contract.json, may still grow by less
// than 1 MB, and a deliberate exception is listed with its reason.
const EVIDENCE_BINARY = /^docs\/operations\/evidence\/.*\.(?:png|jpe?g|webp|gif|pdf|gz)$/i;
export const ADDED_FILE_MAX_BYTES = 1024 * 1024;
const ADDED_FILE_ALLOWLIST = "config/repository-added-file-allowlist.json";
const EVIDENCE_HOME = "attach it to the issue or pull request instead, and commit at most a hash line (sha256 and where it lives)";

// Each entry is { path, size } for an added file, plus replaced: true for a
// modified one and its previousSize whenever the verdict depends on it.
export function addedFileFindings(added, allowlist = []) {
  const allowed = (path) => allowlist.some((entry) => entry.path === path || (entry.path.endsWith("/") && path.startsWith(entry.path)));
  const findings = [];
  for (const { path, size, previousSize, replaced: modified } of added) {
    if (allowed(path)) continue;
    const replaced = modified === true || previousSize !== undefined;
    if (EVIDENCE_BINARY.test(path)) {
      findings.push(`${path}: ${replaced ? "replaced" : "new"} binary evidence is not committed to ${DEFAULT_BRANCH}; ${EVIDENCE_HOME}`);
    } else if (!replaced && size > ADDED_FILE_MAX_BYTES) {
      findings.push(`${path}: new file is ${size} bytes, over the 1 MB limit; ${EVIDENCE_HOME}`);
    } else if (replaced && size > ADDED_FILE_MAX_BYTES
      && (previousSize <= ADDED_FILE_MAX_BYTES || size - previousSize > ADDED_FILE_MAX_BYTES)) {
      findings.push(`${path}: replaced with ${size} bytes (was ${previousSize}), over the 1 MB limit; ${EVIDENCE_HOME}`);
    }
  }
  return findings;
}

function addedFileAllowlist() {
  const path = join(root, ADDED_FILE_ALLOWLIST);
  if (!existsSync(path)) return [];
  const entries = readJson(path, ADDED_FILE_ALLOWLIST)?.entries;
  if (!Array.isArray(entries)) {
    fail(`${ADDED_FILE_ALLOWLIST}: entries must be an array`);
    return [];
  }
  return entries.filter((entry, index) => {
    const ok = typeof entry?.path === "string" && entry.path && typeof entry.reason === "string" && entry.reason.trim()
      && typeof entry.record === "string" && entry.record.trim();
    if (!ok) fail(`${ADDED_FILE_ALLOWLIST}: entries[${index}] needs path, reason and record`);
    return ok;
  });
}

// The NUL-separated fields of git -z output, as bytes.
function splitNul(bytes) {
  const fields = [];
  for (let start = 0; start < bytes.length;) {
    const end = bytes.indexOf(0, start);
    const stop = end === -1 ? bytes.length : end;
    if (stop > start) fields.push(bytes.subarray(start, stop));
    start = stop + 1;
  }
  return fields;
}

function checkAddedFiles() {
  try {
    const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    // The size of rev:path from objects held here, or undefined; never a
    // promisor fetch. A tree holds no sizes, so a blob-filtered clone cannot
    // read one from `git ls-tree -l` either.
    const heldSize = (rev, path) => {
      try {
        return Number(execFileSync("git", ["cat-file", "-s", `${rev}:${path}`], {
          cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
        }).trim());
      } catch {
        return undefined;
      }
    };
    const ref = comparisonBaseRef();
    // The merge base, not the moving default-branch tip: a file the default
    // branch removed after this branch forked is not an addition of this branch.
    const base = ref || git("merge-base", "HEAD", DEFAULT_BASE_REF).trim();
    // The pull request's base (the default branch at run time). CI holds at least its
    // scripts/ blobs: the trusted impact step archives them while the token is
    // present, and on a blob-filtered clone that archive may fetch other default-branch
    // blobs too, so which base blobs are held is not a narrow, fixed set
    const mainline = process.env.CI_BASE_SHA || DEFAULT_BASE_REF;
    // -M100% pairs only byte-identical renames, which add no bytes; any other
    // move reads as a delete plus an add and is judged as an add. The list is
    // read as bytes and each file is measured by its exact name: a name that
    // is not valid UTF-8 decodes to a different string, which used to look
    // absent on disk and skip the policy.
    const fields = splitNul(execFileSync("git", ["diff", "-M100%", "--name-status", "--diff-filter=AM", "-z", base, "--"], {
      cwd: root, stdio: ["ignore", "pipe", "pipe"],
    }));
    const added = [];
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const status = fields[index].toString("utf8");
      const name = fields[index + 1];
      const path = name.toString("utf8");
      const exact = Buffer.from(path, "utf8").equals(name);
      const shown = exact ? path : `${JSON.stringify(path)} (a name that is not valid UTF-8)`;
      // A listed file that cannot be found is refused, never skipped.
      const stat = lstatSync(Buffer.concat([Buffer.from(`${root}/`), name]), { throwIfNoEntry: false });
      if (!stat) {
        fail(`${shown}: listed as added or changed but not found on disk, so the added-file policy cannot measure it`);
        continue;
      }
      const entry = { path: shown, size: stat.size };
      // A pull-request run behind the default branch has only tree data for the fork-point
      // versions the default branch changed since, and its token is gone, so read the base
      // size only when it decides the verdict: a non-evidence file now over
      // 1 MB (OPS-UG-CI-PR-COMPARISON-BASE-BLOBS-FOR-CONVENTIONS-20261110).
      // When the fork-point blob is not held, the same path on the pull
      // request's base stands in (the database contract file on every migration pull request behind the
      // default branch). That
      // measures the head against the default branch's size now, not at the fork, so when
      // the default branch also grew the file after the fork a growth of more than 1 MB can
      // pass here. This pull-request check is advisory for that case: the
      // merge-group run measures the combined result and is the binding check
      //. Neither blob held fails closed below, except
      // in a pull-request run, which says so and leaves the verdict to the
      // merge group. The tree is read with -z so a
      // non-ASCII path, which plain ls-tree output quotes, still matches.
      if (status === "M") {
        entry.replaced = true;
        if (entry.size > ADDED_FILE_MAX_BYTES && !EVIDENCE_BINARY.test(path)) {
          // Git is asked for the earlier size by name, which only a UTF-8
          // name can be passed as; any other name fails closed.
          if (!exact) {
            fail(`${shown}: replaced with ${entry.size} bytes, over the 1 MB limit, and its earlier size cannot be read`);
            continue;
          }
          let previousSize = heldSize(base, path);
          if (previousSize === undefined && git("ls-tree", "-z", "--name-only", base, "--", path) === `${path}\0`) {
            previousSize = heldSize(mainline, path);
          }
          // Neither blob held. Nothing here fetches
          // one: the runner's token is gone after checkout, so a promisor fetch
          // fails and used to surface as "cannot list added files". `git
          // ls-tree -l` is no way round it either: on a blob-filtered clone it
          // prints BAD for a blob it does not hold (git 2.53, lazy fetch off).
          // A pull-request run cannot measure the file, so it says so on
          // stdout and leaves the verdict to the merge-group run, which
          // measures the combined result and is the binding check. Every other run, the merge group's included,
          // fails closed.
          if (previousSize === undefined) {
            if (isPullRequestRun) {
              console.log(`REPOSITORY_CONVENTIONS_NOTICE: ${shown}: replaced with ${entry.size} bytes, over 1 MB; its earlier size is not held in this pull-request checkout, so the merge-group run measures it`);
            } else {
              fail(`${shown}: replaced with ${entry.size} bytes, over the 1 MB limit, and its earlier size is not held here; this check fetches no blob`);
            }
            continue;
          }
          entry.previousSize = previousSize;
        }
      }
      added.push(entry);
    }
    for (const finding of addedFileFindings(added, addedFileAllowlist())) fail(finding);
  } catch {
    fail("added-file policy: cannot list added files against the comparison base");
  }
}

// An npm override pins a transitive package past its parent's range and is
// never revisited on its own. Every top-level override names why it exists, the
// record or pull request that added it and when to look again; entries are
// removed as upgrades make them unnecessary. A past reviewBy is a warning, so
// an unrelated pull request never fails on the calendar.
const OVERRIDE_REGISTER = "config/dependency-overrides.json";
const OVERRIDE_MANIFESTS = ["package.json", "apps/mobile/package.json"];
const REVIEW_BY = /^\d{4}-\d{2}-\d{2}$/;

export function overrideRegisterFindings(manifests, register, today = new Date().toISOString().slice(0, 10)) {
  const failures = [];
  const notices = [];
  const listed = register?.manifests ?? {};
  for (const [manifest, overrides] of Object.entries(manifests)) {
    const entries = listed[manifest] ?? {};
    for (const name of Object.keys(overrides ?? {})) {
      const entry = entries[name];
      if (!entry) {
        failures.push(`${manifest}: override "${name}" has no entry in ${OVERRIDE_REGISTER}; add its reason, record and reviewBy`);
        continue;
      }
      for (const field of ["reason", "record"]) {
        if (typeof entry[field] !== "string" || !entry[field].trim()) failures.push(`${OVERRIDE_REGISTER}: ${manifest} "${name}" needs a ${field}`);
      }
      if (typeof entry.reviewBy !== "string" || !REVIEW_BY.test(entry.reviewBy)) {
        failures.push(`${OVERRIDE_REGISTER}: ${manifest} "${name}" needs reviewBy as YYYY-MM-DD`);
      } else if (entry.reviewBy < today) {
        notices.push(`${manifest} override "${name}" was due for review on ${entry.reviewBy}`);
      }
    }
    for (const name of Object.keys(entries)) {
      if (!Object.hasOwn(overrides ?? {}, name)) failures.push(`${OVERRIDE_REGISTER}: ${manifest} "${name}" is not an override any more; remove its entry`);
    }
  }
  for (const manifest of Object.keys(listed)) {
    if (!Object.hasOwn(manifests, manifest)) failures.push(`${OVERRIDE_REGISTER}: ${manifest} is not a checked manifest`);
  }
  return { failures, notices };
}

// Upstream OPS-UG-VERSION-SCOPED-OVERRIDE-GOES-DEAD-ON-PARENT-BUMP-20261118:
// an override keyed to one exact parent version ("miniflare@5.20261110.2-beta")
// stops applying once that parent moves, and npm then quietly installs the
// transitive the new parent asks for (upstream, undici fell back to 7.30.1).
//
// The check runs on every pull request, so it fails only when the lock proves
// the key inert, and skips every shape it cannot judge:
// - Only a parent-only key counts: an object of child overrides with no "."
//   entry. Such a key never changes the package's own version, so if the lock
//   installs that package, only at other versions, nothing matches it. A key
//   whose value is a string, or an object with ".", replaces the package
//   itself, and the lock rightly records the replacement version instead.
// - A package absent from the lock (an optional or platform dependency npm
//   left out) and a package recorded as a link or a workspace (no
//   node_modules version to compare) are skipped.
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
export function scopedOverrideFindings(manifests, locks) {
  const found = [];
  for (const [manifest, overrides] of Object.entries(manifests)) {
    const lockName = manifest.replace(/package\.json$/, "package-lock.json");
    const packages = locks[lockName]?.packages;
    if (!packages || typeof packages !== "object") continue; // A fixture/project may have no lock.
    const installed = new Map();
    const unjudgeable = new Set();
    for (const [path, entry] of Object.entries(packages)) {
      if (!path) continue; // The root project.
      if (!path.includes("node_modules/")) {
        if (typeof entry?.name === "string") unjudgeable.add(entry.name); // A workspace package.
        continue;
      }
      const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
      if (entry?.link || typeof entry?.version !== "string") {
        unjudgeable.add(name);
        continue;
      }
      if (!installed.has(name)) installed.set(name, new Set());
      installed.get(name).add(entry.version);
    }
    const walk = (node, trail) => {
      if (!node || typeof node !== "object" || Array.isArray(node)) return;
      for (const [key, value] of Object.entries(node)) {
        if (key === ".") continue;
        const at = key.lastIndexOf("@");
        const name = key.slice(0, at);
        const version = key.slice(at + 1);
        const parentOnly = value && typeof value === "object" && !Array.isArray(value) && !Object.hasOwn(value, ".");
        const now = installed.get(name);
        if (at > 0 && EXACT_VERSION.test(version) && parentOnly && now && !unjudgeable.has(name) && !now.has(version)) {
          found.push(`${manifest}: override "${[...trail, key].join(" > ")}" matches no ${name} ${version} in ${lockName}`
            + ` (it installs ${name} ${[...now].sort().join(", ")}), so npm ignores it;`
            + ` re-key it and its ${OVERRIDE_REGISTER} entry to the ${name} version the lock installs if the pin is still needed, or remove both`);
        }
        walk(value, [...trail, key]);
      }
    };
    walk(overrides, []);
  }
  return found;
}

function checkOverrideRegister() {
  const manifests = {};
  const locks = {};
  for (const manifest of OVERRIDE_MANIFESTS) {
    if (!existsSync(join(root, manifest))) continue;
    manifests[manifest] = readJson(join(root, manifest), manifest)?.overrides ?? {};
    const lockName = manifest.replace(/package\.json$/, "package-lock.json");
    if (existsSync(join(root, lockName))) locks[lockName] = readJson(join(root, lockName), lockName);
  }
  for (const message of scopedOverrideFindings(manifests, locks)) fail(message);
  const total = Object.values(manifests).reduce((sum, overrides) => sum + Object.keys(overrides).length, 0);
  const registered = existsSync(join(root, OVERRIDE_REGISTER));
  if (!total && !registered) return 0;
  const register = registered ? readJson(join(root, OVERRIDE_REGISTER), OVERRIDE_REGISTER) : {};
  const { failures: found, notices } = overrideRegisterFindings(manifests, register);
  for (const message of found) fail(message);
  for (const message of notices) warnings.push(message);
  return total;
}

// npm can drop optional binary libc selectors without changing
// versions or integrity. Retain reviewed selectors offline, independently of
// the mutable lockfiles and without fetching Git history or registry metadata.
export const LIBC_LOCKFILES = ["package-lock.json", "apps/mobile/package-lock.json"];
export function lockfileLibcFindings(locks, policy) {
  const found = [];
  if (policy?.schema !== 1 || !policy.manifests || typeof policy.manifests !== "object") {
    return [`${OVERRIDE_REGISTER}: lockfileLibc needs its reviewed schema-1 selector inventory`];
  }
  for (const name of Object.keys(policy.manifests)) {
    if (!LIBC_LOCKFILES.includes(name)) found.push(`${OVERRIDE_REGISTER}: lockfileLibc names an unchecked lockfile ${name}`);
  }
  for (const name of LIBC_LOCKFILES) {
    const selectors = policy.manifests[name];
    if (!selectors || typeof selectors !== "object" || Array.isArray(selectors)) {
      found.push(`${OVERRIDE_REGISTER}: lockfileLibc needs selectors for ${name}`);
      continue;
    }
    const valid = new Map();
    for (const [pkg, libc] of Object.entries(selectors)) {
      if (!/^(?:@[\w.-]+\/)?[\w.-]+$/.test(pkg) || !Array.isArray(libc) || !libc.length
        || libc.some(value => !["glibc", "musl"].includes(value)) || new Set(libc).size !== libc.length) {
        found.push(`${OVERRIDE_REGISTER}: invalid libc selector for ${name} ${pkg}`);
      } else valid.set(pkg, [...libc].sort());
    }
    if (!Object.hasOwn(locks, name)) continue; // A fixture/project may have no phone tree.
    const entries = locks[name]?.packages;
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
      found.push(`${name}: libc check needs a packages inventory`);
      continue;
    }
    for (const [path, entry] of Object.entries(entries)) {
      if (!path.includes("node_modules/")) continue;
      const pkg = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
      const expected = valid.get(pkg);
      // New packages may correctly introduce registry libc metadata. Only a
      // reviewed selector's loss or change is a failure of this retention rule.
      if (!expected) continue;
      if (!Array.isArray(entry?.libc) || entry.libc.length !== expected.length
        || [...entry.libc].sort().some((value, index) => value !== expected[index])) {
        found.push(`${name}: ${path} lost or changed its libc selector; expected ${JSON.stringify(expected)}`);
      }
    }
  }
  return found;
}

// Dependabot's npm drops the selectors on every lock update.
export const LIBC_REPAIR_HINT = "lost libc selectors: run node scripts/restore-lockfile-libc.mjs and commit the restored locks";

function checkLockfileLibc() {
  const register = readJson(join(root, OVERRIDE_REGISTER), OVERRIDE_REGISTER);
  const locks = {};
  for (const name of LIBC_LOCKFILES) {
    if (existsSync(join(root, name))) locks[name] = readJson(join(root, name), name);
  }
  const findings = lockfileLibcFindings(locks, register?.lockfileLibc);
  for (const finding of findings) fail(finding);
  if (findings.some(finding => finding.includes(" lost or changed its libc selector"))) {
    fail(LIBC_REPAIR_HINT);
  }
}

// The tests import provenanceFindings; the checks run only when this file is
// the program.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const names = migrationFiles();
  const baseline = readJson(baselinePath, repoPath(baselinePath));
  checkDocuments();
  const dbContractPath = join(root, 'scripts', 'db-contract.json');
  if (existsSync(dbContractPath)) {
    const dbContract = readJson(dbContractPath, 'scripts/db-contract.json');
    if (dbContract) {
      for (const issue of inventoryOrderIssues(dbContract)) fail(`scripts/db-contract.json: ${issue}`);
      try { readRlsTableInventory(dbContract, dbContractPath); } catch (error) { fail(`RLS table inventory: ${error.message}`); }
    }
  }
  checkSupabaseLogsEndpoint();
  checkEasternTime(root, fail);
  checkFixedZones(root, fail);
  checkSwallowedErrors(root, fail);
  checkAddedFiles();
  checkInlineOperationKeys(root, fail);
  const overrides = checkOverrideRegister();
  checkLockfileLibc();
  checkDatabaseAssuranceCliPin();
  const identifiers = checkMigrationIdentifiers(names, baseline);
  checkPolicyComments(names, baseline);
  const provenanceTables = checkProvenanceMigrations(names);
  const referenceFiles = checkReferenceData();
  const includeFiles = checkVercelIncludeFiles();

  for (const message of warnings) console.warn(`REPOSITORY_CONVENTIONS_WARN: ${message}`);
  if (failures.length) {
    for (const message of failures) console.error(`REPOSITORY_CONVENTIONS_FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(
      `REPOSITORY_CONVENTIONS_OK migrations=${identifiers.size}`
        + ` provenance_tables=${provenanceTables} reference_files=${referenceFiles} overrides=${overrides}`
        + (includeFiles ? ` longest_include_files=${includeFiles.length}(${includeFiles.name})` : ""),
    );
  }
}
