// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { DENIED_PRODUCTION_REF } from "./helpers/denied-identity-fixtures.js";

// DB-free pins over the verify:task-comment:no-fiction lane, the replacement
// for the quarantined synthetic-identity verify:rpc lane. The probe itself
// needs a live database; these pins keep its wiring and its read-only/
// no-fiction discipline from rotting in the DB-free CI path. The donor
// repository's ci.yml step that ran this probe is not part of Union Ground,
// whose required workflow is its own ci.yml.
// REQ-UNION-GROUND-DESKTOP-GREEN-PARITY-20260814 /
// TEST-UG-RPC-BEHAVIOUR-NO-FICTION-20260816.

function tryRead(relativePath) {
  try {
    return readFileSync(new URL(relativePath, import.meta.url), "utf8");
  } catch {
    return "";
  }
}

const script = tryRead("../scripts/verify-task-comment-no-fiction.mjs");
// Pins match COMMENT-STRIPPED source (house discipline): a comment must not
// be able to satisfy a pin about what the code does.
const code = script.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const legacy = readFileSync(new URL("../scripts/verify-rpc-behaviour.mjs", import.meta.url), "utf8");
const legacyCode = legacy.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

// Every SQL string handed to client.query(...) in the comment-stripped new
// script. The no-write-verb ban applies to these extracted arguments, not to
// raw source lines, so `await client.query("insert ...")` cannot hide behind
// its leading `await` and quoted privilege literals stay legal.
function extractQueryArguments(strippedSource) {
  const args = [];
  const pattern = /client\.query\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/g;
  for (const match of strippedSource.matchAll(pattern)) {
    args.push(match[1] ?? match[2] ?? match[3]);
  }
  return args;
}

describe("verify:task-comment:no-fiction wiring", () => {
  it("exists as source", () => {
    expect(script.length, "scripts/verify-task-comment-no-fiction.mjs must exist").toBeGreaterThan(0);
  });

  it("is an npm script pointing at the probe file, beside the retained legacy command", () => {
    expect(pkg.scripts["verify:task-comment:no-fiction"]).toBe(
      "node --env-file-if-exists=.env.local scripts/verify-task-comment-no-fiction.mjs",
    );
    // The legacy command stays available outside workflows; deleting it would
    // hide the quarantined suite instead of governing it.
    expect(pkg.scripts["verify:rpc"]).toBe("node --env-file-if-exists=.env.local scripts/verify-rpc-behaviour.mjs");
  });

  it("is NOT part of npm run check — that chain must stay DB-free for fork PRs", () => {
    expect(pkg.scripts.check).not.toContain("verify:task-comment:no-fiction");
  });
});

describe("task-comment disposable target guard", () => {
  it.each([
    ["postgresql://postgres:postgres@127.0.0.1:59992/postgres", "", "requires DB_VERIFY_DISPOSABLE_CONFIRM"],
    ["postgresql://postgres:postgres@127.0.0.1:59992/postgres", "yes", "requires DB_VERIFY_DISPOSABLE_CONFIRM"],
    ["postgresql://postgres:postgres@127.0.0.1:54322/postgres", "pr-ci-disposable", "Refusing shared local"],
    ["postgresql://postgres:postgres@127.0.0.1:54422/postgres", "pr-ci-disposable", "Refusing shared local"],
    // No Union Ground database is provisioned, so every hosted target is refused.
    ["postgresql://postgres:postgres@db.wrong-project.supabase.co:5432/postgres", "pr-ci-disposable", "No Union Ground database target is provisioned"],
    [`postgresql://postgres:postgres@db.${DENIED_PRODUCTION_REF}.supabase.co:5432/postgres`, "pr-ci-disposable", "Forbidden legacy Supabase project"],
  ])("refuses %s with token %s before connecting", (url, token, refusal) => {
    const result = spawnSync(process.execPath, ["scripts/verify-task-comment-no-fiction.mjs"], {
      cwd: new URL("../", import.meta.url),
      env: { PATH: process.env.PATH, SUPABASE_DB_URL: url, REQUIRE_DB_VERIFY: "1", DB_VERIFY_DISPOSABLE_CONFIRM: token },
      encoding: "utf8", timeout: 10000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(refusal);
  });
});

describe("legacy verify:rpc quarantine", () => {
  // Discovered dynamically so a workflow added tomorrow is swept the day it
  // lands, not when someone remembers to extend a hardcoded list.
  const workflowFiles = readdirSync(new URL("../.github/workflows/", import.meta.url))
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .map((name) => `../.github/workflows/${name}`);

  it("sweeps a non-empty, current workflow inventory", () => {
    expect(workflowFiles.length).toBeGreaterThan(0);
    expect(workflowFiles).toContain("../.github/workflows/ci.yml");
  });

  it("no workflow invokes the synthetic-identity lane or imports its script", () => {
    for (const path of workflowFiles) {
      const workflow = tryRead(path);
      expect(workflow, `${path} must not run npm run verify:rpc`).not.toMatch(/^\s*run:\s*npm run verify:rpc\s*$/m);
      expect(workflow, `${path} must not reference verify-rpc-behaviour.mjs`).not.toContain("verify-rpc-behaviour.mjs");
    }
  });

  it("the legacy verifier fails closed without explicit owner authorization", () => {
    // The exact guard condition, not just the variable name: refusal is the
    // default and only the literal "1" opens it.
    const guardCondition = '(process.env.ALLOW_ROLLBACK_SYNTHETIC_IDENTITIES ?? "").trim() !== "1"';
    expect(legacyCode).toContain(`if (${guardCondition}) {`);
    // Ordering: the guard sits after the missing-secret SKIP branch and before
    // the exact-target validation that precedes any connection — and its block
    // hard-exits nonzero before that validation can run.
    const skipBranch = legacyCode.indexOf("if (!connectionString) {");
    const guard = legacyCode.indexOf(`if (${guardCondition}) {`);
    const target = legacyCode.indexOf("assertExactTarget(contract.target, connectionString");
    expect(skipBranch).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(skipBranch);
    expect(target).toBeGreaterThan(guard);
    expect(legacyCode.slice(guard, target)).toContain("process.exit(1)");
    expect(legacyCode).toContain("TEST-UG-RPC-BEHAVIOUR-NO-FICTION-20260816");
  });

  it("nothing in this repository arms the owner-exception variable", () => {
    expect(JSON.stringify(pkg)).not.toContain("ALLOW_ROLLBACK_SYNTHETIC_IDENTITIES");
    for (const path of workflowFiles) {
      expect(tryRead(path), `${path} must not set ALLOW_ROLLBACK_SYNTHETIC_IDENTITIES`)
        .not.toContain("ALLOW_ROLLBACK_SYNTHETIC_IDENTITIES");
    }
    // The legacy verifier may only READ the variable; an assignment or a
    // committed env default would arm it silently.
    expect(legacyCode).toMatch(/process\.env\.ALLOW_ROLLBACK_SYNTHETIC_IDENTITIES/);
    expect(legacyCode).not.toMatch(/process\.env\.ALLOW_ROLLBACK_SYNTHETIC_IDENTITIES\s*=[^=]/);
    expect(tryRead("../.env.example")).not.toContain("ALLOW_ROLLBACK_SYNTHETIC_IDENTITIES");
  });
});

describe("verify:task-comment:no-fiction read-only discipline", () => {
  it("skips cleanly without the secret and arms into a hard fail", () => {
    expect(code).toContain("if (!connectionString) {");
    expect(code).toContain("REQUIRE_DB_VERIFY");
    expect(code).toContain("::warning title=verify:task-comment:no-fiction skipped::");
    expect(code).toContain("process.exit(0);");
    // The arming rule lives in one shared helper, so it cannot drift per script.
    expect(code).toContain('from "./lib/require-db-verify.mjs"');
    expect(code).toContain("if (requireDbVerify()) {");
  });

  it("guards the exact target project before connecting", () => {
    expect(code).toContain("assertExactTarget(contract.target, connectionString, {");
    expect(code).toContain("disposableConfirm: process.env.DB_VERIFY_DISPOSABLE_CONFIRM");
    expect(code).toContain('from "./lib/assert-exact-target.mjs"');
    expect(code).toContain('new URL("./db-contract.json", import.meta.url)');
  });

  it("runs one read-only transaction as a null authenticated caller", () => {
    expect(code).toContain('client.query("begin transaction read only")');
    expect(code).toContain('client.query("set local role authenticated")');
    expect(code).toContain("request.jwt.claims");
    expect(code).toContain("'{}'");
    expect(code).toContain('client.query("savepoint probe")');
    expect(code).toContain('client.query("rollback to savepoint probe")');
    expect(code).toContain('await client.query("rollback")');
    expect(code).toContain("finally");
    expect(code).toContain("client.end()");
  });

  it("proves catalog grants: authenticated SELECT + RPC EXECUTE, no table write privilege", () => {
    expect(code).toContain("has_table_privilege");
    expect(code).toContain("'select'");
    expect(code).toContain("'insert'");
    expect(code).toContain("'update'");
    expect(code).toContain("'delete'");
    expect(code).toContain("'truncate'");
    expect(code).toContain("'references'");
    expect(code).toContain("'trigger'");
    // Column-level grants evade has_table_privilege, and effective privilege
    // via anon would evade an authenticated-only sweep — both are probed.
    expect(code).toContain("has_any_column_privilege");
    expect(code).toContain("has_function_privilege");
    expect(code).toContain("public.add_chapter_task_comment(uuid, text, uuid[])");
    expect(code).toContain("'anon'");
  });

  it("proves RLS is enabled with both named policies, so the zero-row read is not the only RLS evidence", () => {
    expect(code).toContain("relrowsecurity");
    expect(code).toContain("pg_policies");
    expect(code).toContain("chapter_task_comments_select_board");
    expect(code).toContain("mfa_assurance");
  });

  it("proves the null caller sees zero rows and is refused with the exact refusal", () => {
    expect(code).toContain("select count(*) from public.chapter_task_comments");
    expect(code).toContain("add_chapter_task_comment");
    expect(code).toContain("no-fiction-boundary-probe");
    expect(code).toContain("'{}'::uuid[]");
    expect(code).toContain("42501");
    expect(code).toContain("authentication required");
    // READ ONLY is defense in depth: 25006 means the authorization guard
    // regressed far enough to attempt a write. It is a lane failure, never
    // the expected refusal.
    expect(code).toContain("25006");
  });

  it("issues exactly the allowlisted statements, in order — nothing more, nothing hidden", () => {
    const queryArguments = extractQueryArguments(code);
    // The complete ORDERED statement inventory. Any new, reordered, or
    // reworded query is RED here first. The two catalog reads are pinned at
    // both ends; the bans below govern their interiors. Order matters: the
    // claims/role setup must precede the RLS read and the RPC refusal or the
    // null-authenticated-caller emulation silently stops emulating.
    const allowedStatements = [
      {
        start: /^select has_table_privilege\('authenticated', 'public\.chapter_task_comments', 'select'\) as can_select,/,
        end: /has_function_privilege\('anon', 'public\.add_chapter_task_comment\(uuid, text, uuid\[\]\)', 'execute'\) as anon_execute$/,
      },
      {
        start: /^select c\.relrowsecurity as rls_enabled,/,
        end: /where c\.oid = 'public\.chapter_task_comments'::regclass$/,
      },
      { start: /^begin transaction read only$/, end: /^begin transaction read only$/ },
      { start: /^select set_config\('request\.jwt\.claims', '\{\}', true\)$/, end: /true\)$/ },
      { start: /^set local role authenticated$/, end: /authenticated$/ },
      { start: /^select count\(\*\) from public\.chapter_task_comments$/, end: /chapter_task_comments$/ },
      { start: /^savepoint probe$/, end: /probe$/ },
      {
        start: /^select public\.add_chapter_task_comment\(null::uuid, 'no-fiction-boundary-probe', '\{\}'::uuid\[\]\)$/,
        end: /uuid\[\]\)$/,
      },
      { start: /^rollback to savepoint probe$/, end: /probe$/ },
      { start: /^rollback$/, end: /^rollback$/ },
    ];
    expect(queryArguments.length).toBe(allowedStatements.length);
    allowedStatements.forEach((allowed, index) => {
      const sql = queryArguments[index];
      expect(sql, `statement ${index} out of order or unexpected: ${sql}`).toMatch(allowed.start);
      expect(sql, `statement ${index} has an unexpected tail: ${sql}`).toMatch(allowed.end);
      // No second statement, no data-modifying CTE, no SELECT INTO, no
      // interpolation, no escape obfuscation anywhere in any statement.
      expect(sql).not.toContain(";");
      expect(sql).not.toContain("${");
      expect(sql).not.toMatch(/\binto\b/i);
      expect(sql).not.toMatch(/(^|;|\()\s*(insert|update|delete|create|alter|drop|truncate|merge|copy|grant|revoke|call|do)\b/i);
      expect(sql).not.toMatch(/\)\s*(insert|update|delete|merge)\b/i);
    });
    // "begin transaction read only" must be the only transaction-control
    // start — a read-write begin or a stray end/commit cannot hide as a decoy.
    expect(queryArguments.filter((sql) => /^begin\b/i.test(sql))).toEqual(["begin transaction read only"]);
    expect(code).not.toMatch(/read write/i);
    // No unicode/hex escape obfuscation anywhere in the executable source:
    // "\\u0069nsert" or "client.\\u0071uery" would defeat every text pin.
    expect(code).not.toContain("\\u");
    expect(code).not.toContain("\\x");
  });

  it("issues every query as a single literal on the one client — nothing the extractor cannot see", () => {
    // Each .query( receiver must be the one `client`; a second alias or a
    // computed client["query"] access would dodge the argument extractor.
    const receivers = [...code.matchAll(/(\w+)\.query\(/g)].map((m) => m[1]);
    expect(receivers.length).toBeGreaterThan(0);
    for (const receiver of receivers) expect(receiver).toBe("client");
    expect(code).not.toContain("client[");
    // The first argument must be an inline string/template literal — never an
    // identifier, property access, array, or concatenated expression.
    const nonLiteralFirstArgument = /client\.query\(\s*[^"'`\s)]/;
    expect(code).not.toMatch(nonLiteralFirstArgument);
    // After the literal, only a parameter list or the closing paren may
    // follow — this bans `+`, `.concat(…)`, tagged continuation, or any other
    // expression tail that would extend the SQL past what the extractor saw.
    const literalWithExpressionTail = /client\.query\(\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)\s*[^,)\s]/;
    expect(code).not.toMatch(literalWithExpressionTail);
    // Every occurrence of the token "query" must be an immediate client.query(
    // call — no destructured { query }, no client.query.call/apply, no alias.
    const queryTokens = [...code.matchAll(/query/gi)].length;
    const directCalls = [...code.matchAll(/client\.query\(/g)].length;
    expect(queryTokens).toBe(directCalls);
    expect(code).not.toContain(".concat(");
    // One client only, constructed once.
    expect([...code.matchAll(/new pg\.Client\(/g)].length).toBe(1);
  });

  it("never touches identity rows or comment bodies, and reads the table only as count(*)", () => {
    expect(code).not.toContain("auth.users");
    for (const sql of extractQueryArguments(code)) {
      if (/from\s+public\.chapter_task_comments/i.test(sql)) {
        expect(sql).toContain("count(*)");
      }
    }
  });

  it("never persists, in any spelling, anywhere in the file", () => {
    expect(script).not.toMatch(/commit/i);
  });
});
