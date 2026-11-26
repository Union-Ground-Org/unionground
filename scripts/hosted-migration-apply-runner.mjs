#!/usr/bin/env node
// Audited hosted migration apply runner. Applies ONE
// migration (exact commit bytes, sha256 pinned) with a reviewed, hash-approved
// state delta, in one exact-history transaction per target. Copy this file into a
// per-migration run directory as runner.mjs beside lifecycle-cte.sql,
// state-select.sql, the migration file and env.json:
//   {merge, pin, file, pr, initial: {sample, production}, pre_latest}
// Phases, one per invocation: --preflight, --rehearse (same wrapper, ends in
// ROLLBACK, writes DELTA.json), --approve <DELTA.json sha256>, --apply (commits
// only if the pre-state hash equals the preflight and the post-state hash equals
// the rehearsal), --verify (independent read-only read-back, writes the receipt).
//
//   node runner.mjs <phase> <sample|production> [approve-sha256]
//     [--out-of-order-allowance sample:<14-digit stamp>]
//
// The history check requires exactly one appended row: count + 1, latest_version
// equal to the applied stamp, every earlier row unchanged. The only exception is
// --out-of-order-allowance (#6434, MAIN 119, October 28, 2026). It names ONE stamp
// and ONE environment, SAMPLE only, and it must equal this run's migration, which
// must be older than the target's latest_version. Under it the history gains one
// row at its sorted position, latest_version stays the same, and the attempt
// files, the PASS files and the receipt record that the allowance was used and
// for which stamp. It is never a general out-of-order mode: each invocation that
// reads or writes history must pass the same allowance again.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PHASES = ["--preflight", "--rehearse", "--approve", "--apply", "--verify"];
const TARGETS = ["sample", "production"];
export const ALLOWANCE_FLAG = "--out-of-order-allowance";
const STAMP = /^\d{14}$/u;

const canonical = x => JSON.stringify(x, (_, v) => (v && typeof v === "object" && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v));
const same = (a, b) => canonical(a) === canonical(b);
const need = (v, s) => { if (!v) throw Error(`${s}; STOP no retry`); };

// The per-invocation allowance: at most one flag, value sample:<stamp>, target
// sample, stamp equal to this run's migration. Anything else refuses the run.
export function parseOutOfOrderAllowance(args, { target, version }) {
  const at = args.flatMap((arg, index) => (arg === ALLOWANCE_FLAG || arg.startsWith(`${ALLOWANCE_FLAG}=`) ? [index] : []));
  if (!at.length) return null;
  need(at.length === 1, "One out-of-order allowance per invocation");
  const arg = args[at[0]];
  const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[at[0] + 1];
  const match = /^([a-z]+):(\d{14})$/u.exec(value ?? "");
  need(match, `${ALLOWANCE_FLAG} takes <environment>:<14-digit stamp>`);
  const [, environment, stamp] = match;
  need(environment === "sample" && target === "sample", "The out-of-order allowance is SAMPLE only");
  need(STAMP.test(version ?? "") && stamp === version, `The out-of-order allowance names this run's migration ${version}, not ${stamp}`);
  return { environment, stamp };
}

// Arguments that are neither the phase, the target, the approve hash nor the allowance.
export function unexpectedArguments(args) {
  const rest = [...args];
  const at = rest.findIndex(arg => arg === ALLOWANCE_FLAG || arg.startsWith(`${ALLOWANCE_FLAG}=`));
  if (at >= 0) rest.splice(at, rest[at].includes("=") ? 1 : 2);
  const [mode, , approveSha, ...extra] = rest;
  return mode === "--approve" ? extra : [approveSha, ...extra].filter(arg => arg !== undefined);
}

export function allowanceRecord(allowance, latestVersion) {
  return allowance
    ? { used: true, environment: allowance.environment, stamp: allowance.stamp, latest_version_kept: latestVersion }
    : { used: false };
}

// The pre-state baseline: the recorded count and latest version, and no row for
// this stamp yet. With the allowance the stamp must sort before the latest one.
export function checkPreHistory(state, { initialCount, preLatest, version, allowance }) {
  need(state.history_count === initialCount && state.latest_version === preLatest
    && !state.full_history.some(row => row.version === version), "History baseline");
  if (allowance) need(version < state.latest_version, `Out-of-order allowance for ${version} needs a later latest_version (have ${state.latest_version})`);
}

// The history a successful apply must leave: one appended row, or, under the
// allowance, the same row at its sorted position with latest_version unchanged.
export function expectedHistory(before, rows, version, allowance) {
  if (!allowance) return { history_count: before.history_count + rows.length, latest_version: version, full_history: [...before.full_history, ...rows] };
  const full = [...before.full_history];
  const at = full.findIndex(row => row.version > version);
  need(at >= 0, "Out-of-order allowance needs a later history row");
  full.splice(at, 0, ...rows);
  return { history_count: before.history_count + rows.length, latest_version: before.latest_version, full_history: full };
}

export function checkHistoryAppend(state, before, rows, version, allowance) {
  const expected = expectedHistory(before, rows, version, allowance);
  need(state.history_count === expected.history_count && state.latest_version === expected.latest_version
    && same(state.full_history, expected.full_history),
  allowance ? "Exact one-row history insertion at the allowed stamp's sorted position" : "Exact one-row history append");
}

// SQL lexing for the transaction guard. It follows PostgreSQL's own scanner,
// src/backend/parser/scan.l (REL_17_STABLE), rule by rule, and refuses whatever
// it cannot place, so a source it accepts tokenises as the server would:
//   newline [\n\r]; comment ("--"{non_newline}*)          (scan.l 224-227)
//   xcstart \/\*  (yyless(2): op chars after it are not part of it), nested,
//   xcstop \*+\/                                            (scan.l 229-231)
//   xqstart {quote}; xqdouble {quote}{quote}; standard_conforming_strings is
//   on (scan.l 70), so a backslash in an ordinary string is literal
//   xestart [eE]{quote}; xeescape [\\][^0-7] etc.           (scan.l 275-282)
//   xusstart [uU]&{quote}; xuistart [uU]&{dquote}; xnstart [nN]{quote};
//   xbstart [bB]{quote}; xhstart [xX]{quote}
//   quotecontinue {whitespace_with_newline}{quote}, where
//   whitespace_with_newline ({horiz_whitespace}*{newline}{special_whitespace}*),
//   horiz_whitespace ({horiz_space}|{comment}), special_whitespace
//   ({space}+|{comment}{newline}): a string followed by such a gap and another
//   quote continues in the same mode (state_before_str_stop), so an E-string
//   stays an E-string across the gap                         (scan.l 231-244, 587-606)
//   xdstart {dquote}; xddouble {dquote}{dquote}
//   dolqdelim \$({dolq_start}{dolq_cont}*)?\$ with dolq_start
//   [A-Za-z\200-\377_], dolq_cont [A-Za-z\200-\377_0-9]     (scan.l 262-268)
//   ident_start [A-Za-z\200-\377_]; ident_cont [A-Za-z\200-\377_0-9\$]
//   (scan.l 346-347): every non-ASCII character is an identifier character,
//   and an identifier is matched whole (flex longest match) before any
//   prefix letter can start a string, so "ée'..'" is the identifier ée
//   followed by an ordinary string, and "é$$" is one identifier.
// Stricter than the server on purpose: a carriage return, a form feed, a
// vertical tab or any other control character except tab and newline is
// refused anywhere outside string and dollar-quoted bodies (comments and
// quoted identifiers included), and so is any mention of the settings that
// change string lexing (standard_conforming_strings, backslash_quote).
// The server parses the whole query string before running any statement
// (exec_simple_query, pg_parse_query), so input it cannot lex runs nothing.
const isIdentStart = (c) => c !== undefined && (/[A-Za-z_]/u.test(c) || c.charCodeAt(0) >= 0x80);
const isIdentCont = (c) => isIdentStart(c) || (c !== undefined && /[0-9$]/u.test(c));
// scan.l quotecontinue up to and including the next opening quote. A comment
// runs to the end of its line, so {horiz_whitespace}*{newline} is the same
// language as horizontal spaces, at most one comment, then the newline; written
// that way, and with each later part one character or one whole comment line,
// the pattern has a single way to match and cannot backtrack exponentially.
const QUOTE_CONTINUE = /^[ \t\f]*(?:--[^\n\r]*)?[\n\r](?:[ \t\n\r\f\v]|--[^\n\r]*[\n\r])*'/u;
// dolq_start/dolq_cont take every byte 0x80-0xFF, so every non-ASCII code point
// (astral ones included, which /u matches as one code point) is a tag character.
const DOLLAR_DELIMITER = /^\$(?:[A-Za-z_\u{80}-\u{10FFFF}][A-Za-z0-9_\u{80}-\u{10FFFF}]*)?\$/u;
// Control characters other than tab and newline (code units 0-8, 11-31, 127).
const isControl = (c) => { const code = c.charCodeAt(0); return (code < 0x20 && code !== 0x09 && code !== 0x0a) || code === 0x7f; };
const hasControl = (text) => [...text].some(isControl);

// The one outer pair the runner removes, as whole lines: "begin;" and
// "commit;" with only spaces or tabs after them. The guard and the runner both
// use this, so the guard checks exactly the body the runner executes.
const OUTER_BEGIN = /^begin;[ \t]*$/gimu, OUTER_COMMIT = /^commit;[ \t]*$/gimu;
export function outerTransactionLines(source) {
  return { begins: (source.match(OUTER_BEGIN) ?? []).length, commits: (source.match(OUTER_COMMIT) ?? []).length };
}
export function stripOuterTransaction(source) {
  return source.replace(new RegExp(OUTER_BEGIN.source, "imu"), "").replace(new RegExp(OUTER_COMMIT.source, "imu"), "");
}

// Tokens of a SQL source: { type: "word", text } for identifiers and keywords
// (comments, strings, quoted identifiers and dollar-quoted bodies yield no word
// tokens), { type: ";" } and { type: "other" }. Throws when it cannot lex.
export function lexSql(source) {
  const fail = (what) => { throw Error(`Cannot tokenise the migration: ${what}`); };
  if (/standard_conforming_strings|backslash_quote/iu.test(source)) fail("it names a setting that changes string lexing");
  const tokens = [];
  const outside = (text, where) => { if (hasControl(text)) fail(`a control character (such as a carriage return) in ${where}`); };
  const quoted = (start, quote, backslash) => {
    let i = start + 1;
    for (;;) {
      if (i >= source.length) fail(quote === "'" ? "unterminated string literal" : "unterminated quoted identifier");
      if (backslash && source[i] === "\\") { i += 2; continue; }
      if (source[i] === quote) {
        if (source[i + 1] === quote) { i += 2; continue; }
        // A string (not a quoted identifier) continues across a newline gap in
        // the same mode; the gap lies outside the string, so its control
        // characters are refused like any other.
        const gap = quote === "'" ? QUOTE_CONTINUE.exec(source.slice(i + 1))?.[0] : undefined;
        if (gap) { outside(gap, "the gap between continued string parts"); i += 1 + gap.length; continue; }
        return i + 1;
      }
      i += 1;
    }
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i], next = source[i + 1];
    if (isControl(c)) fail("a control character (such as a carriage return) outside a string");
    if (c === "-" && next === "-") {
      const end = source.indexOf("\n", i);
      const stop = end < 0 ? source.length : end;
      outside(source.slice(i, stop), "a comment");
      i = stop;
    } else if (c === "/" && next === "*") {
      let depth = 1, j = i + 2;
      while (depth) {
        if (j >= source.length) fail("unterminated block comment");
        if (source[j] === "/" && source[j + 1] === "*") { depth += 1; j += 2; } else if (source[j] === "*" && source[j + 1] === "/") { depth -= 1; j += 2; } else j += 1;
      }
      outside(source.slice(i, j), "a comment");
      i = j;
    } else if (c === "'") {
      i = quoted(i, "'", false); tokens.push({ type: "other" });
    } else if (c === '"') {
      const end = quoted(i, '"', false);
      outside(source.slice(i, end), "a quoted identifier");
      i = end; tokens.push({ type: "other" });
    } else if (c === "$") {
      const delimiter = DOLLAR_DELIMITER.exec(source.slice(i))?.[0];
      if (delimiter) {
        const end = source.indexOf(delimiter, i + delimiter.length);
        if (end < 0) fail(`unterminated dollar-quoted body ${delimiter}`);
        i = end + delimiter.length; tokens.push({ type: "other" });
      } else { const param = /^\$[0-9]+/u.exec(source.slice(i)); i += param ? param[0].length : 1; tokens.push({ type: "other" }); }
    } else if (isIdentStart(c)) {
      // String prefixes are taken only at the start of an identifier token.
      if (/[eE]/u.test(c) && next === "'") { i = quoted(i + 1, "'", true); tokens.push({ type: "other" }); continue; }
      if (/[bBxXnN]/u.test(c) && next === "'") { i = quoted(i + 1, "'", false); tokens.push({ type: "other" }); continue; }
      if (/[uU]/u.test(c) && next === "&" && (source[i + 2] === "'" || source[i + 2] === '"')) {
        const end = quoted(i + 2, source[i + 2], false);
        if (source[i + 2] === '"') outside(source.slice(i, end), "a quoted identifier");
        i = end; tokens.push({ type: "other" }); continue;
      }
      let j = i + 1;
      while (isIdentCont(source[j])) j += 1;
      tokens.push({ type: "word", text: source.slice(i, j) });
      i = j;
    } else if (/[0-9]/u.test(c)) {
      // A number directly followed by an identifier character is "trailing
      // junk" (scan.l integer_junk, numeric_junk, real_junk): a server error.
      const number = /^(?:0[xX][0-9A-Fa-f_]+|0[oO][0-7_]+|0[bB][01_]+|[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][+-]?[0-9_]+)?)/u.exec(source.slice(i))[0];
      i += number.length; tokens.push({ type: "other" });
    } else if (c === ";") {
      tokens.push({ type: ";" }); i += 1;
    } else {
      if (!/\s/u.test(c)) tokens.push({ type: "other" });
      i += 1;
    }
  }
  return tokens;
}

// Top-level statements as their words (lowercased) joined by spaces, empty
// statements dropped.
export function topLevelStatements(source) {
  const statements = [[]];
  for (const token of lexSql(source)) {
    if (token.type === ";") statements.push([]);
    else statements.at(-1).push(token.type === "word" ? token.text.toLowerCase() : "?");
  }
  return statements.filter((words) => words.length).map((words) => words.join(" "));
}

// The transaction-control statement a top-level statement is, or null. BEGIN
// ATOMIC function bodies split at their inner semicolons, so they are refused
// rather than guessed at.
export function transactionControl(statement) {
  const words = statement.toLowerCase().split(/\s+/u).filter((word) => word !== "?");
  const [first, second] = words;
  if (words.some((word, index) => word === "begin" && words[index + 1] === "atomic")) return "BEGIN ATOMIC body";
  if (["begin", "commit", "end", "rollback", "abort", "savepoint", "release"].includes(first)) return words.slice(0, 2).join(" ").toUpperCase();
  if ((first === "start" || first === "prepare") && second === "transaction") return `${first} transaction`.toUpperCase();
  if (first === "set" && (second === "transaction" || (second === "session" && words.slice(2, 5).join(" ") === "characteristics as transaction"))) return words.slice(0, second === "transaction" ? 2 : 5).join(" ").toUpperCase();
  return null;
}

// The second, statement-independent check: transaction words that appear as
// bare keywords anywhere in the lexed body. "end" may only close a CASE,
// "start" may only open START WITH (sequence and identity options), and
// "commit" may only follow ON directly (CREATE TEMPORARY TABLE ... ON COMMIT
// DROP; ON never starts a statement, and a semicolon between them counts as a
// token, so "on; commit" is still refused). The other words have no use in a
// migration body outside quoted text.
export function bareTransactionWords(source) {
  const tokens = lexSql(source).map((token) => (token.type === "word" ? token.text.toLowerCase() : token.type));
  const found = new Set();
  let caseDepth = 0;
  tokens.forEach((word, index) => {
    if (word === "case") caseDepth += 1;
    else if (word === "end") { if (caseDepth > 0) caseDepth -= 1; else found.add("end"); }
    else if (word === "start") { if (tokens[index + 1] !== "with") found.add("start"); }
    else if (word === "commit") { if (tokens[index - 1] !== "on") found.add("commit"); }
    else if (["begin", "rollback", "abort", "savepoint", "release", "prepare"].includes(word)) found.add(word);
  });
  return [...found];
}

// Calls that act outside the runner's transaction, so its ROLLBACK cannot undo
// them: dblink (another session that commits on its own), pg_background (a
// background worker) and COPY ... PROGRAM (a server-side program). No
// migration uses them; they are refused rather than reasoned about.
export function externalEffectWords(source) {
  const statements = [[]];
  for (const token of lexSql(source)) {
    if (token.type === ";") statements.push([]);
    else if (token.type === "word") statements.at(-1).push(token.text.toLowerCase());
  }
  const found = new Set();
  for (const words of statements) {
    for (const word of words) if (/^(?:dblink|pg_background)/u.test(word)) found.add(word);
    if (words[0] === "copy" && words.includes("program")) found.add("copy ... program");
  }
  return [...found];
}

// Why a migration source may not run inside the runner's own transaction, or
// null. The source must be one outer BEGIN ... COMMIT pair (the whole lines the
// runner strips) with no other transaction control anywhere in the body, by
// both the statement check and the independent bare-word check, since an inner
// COMMIT would make the rehearsal's statements durable before its ROLLBACK.
// Anything the lexer cannot read is refused.
export function sourceTransactionProblem(source) {
  let all, body, bare, external;
  try {
    all = topLevelStatements(source);
    const stripped = stripOuterTransaction(source);
    body = topLevelStatements(stripped);
    bare = bareTransactionWords(stripped);
    external = externalEffectWords(stripped);
  } catch (error) { return error.message; }
  const outer = outerTransactionLines(source);
  if (outer.begins !== 1 || outer.commits !== 1) return "The migration needs exactly one whole-line begin; and one whole-line commit;";
  if (transactionControl(all[0] ?? "") !== "BEGIN" || transactionControl(all.at(-1) ?? "") !== "COMMIT") return "The migration must open with its begin; and close with its commit;";
  const inner = body.map(transactionControl).filter(Boolean);
  if (inner.length) return `The migration body holds transaction control the runner cannot wrap: ${[...new Set(inner)].join(", ")}`;
  if (bare.length) return `The migration body holds transaction words outside quoted text: ${bare.map((word) => word.toUpperCase()).join(", ")}`;
  if (external.length) return `The migration body calls something the runner's rollback cannot undo: ${external.join(", ")}`;
  return null;
}

async function main() {
  const R = dirname(fileURLToPath(import.meta.url));
  const argv = process.argv.slice(2);
  const [mode, target] = argv;
  const read = n => readFileSync(`${R}/${n}`, "utf8"), json = n => JSON.parse(read(n)), sha = b => createHash("sha256").update(b).digest("hex");
  const now = () => new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", dateStyle: "long", timeStyle: "long" }).format(new Date()).replace(/EDT|EST/, "ET");
  const save = (n, v) => writeFileSync(`${R}/${n}`, `${JSON.stringify(v, null, 2)}\n`, { flag: "wx" });
  const log = s => appendFileSync(`${R}/RESULT.md`, `${now()}: ${target} ${s}\n`);
  need(TARGETS.includes(target) && PHASES.includes(mode), "Explicit phase and target");
  need(!unexpectedArguments(argv).length, `Unexpected arguments: ${unexpectedArguments(argv).join(" ")}`);
  // Every phase writes <run dir>/<target>/; the workstation kits' run-phase.sh
  // created it, the db-migrate-apply workflow did not (run 42801152118, ENOENT).
  mkdirSync(`${R}/${target}`, { recursive: true });
  const ENV = JSON.parse(readFileSync(`${R}/env.json`, "utf8")), MAIN = ENV.merge;
  need(/^[0-9a-f]{40}$/.test(MAIN), "env.json merge sha required");
  const PIN = ENV.pin;
  const VERSION = ENV.file.slice(0, 14);
  // Refuse a wrong allowance before reading any credential or migration byte.
  const allowance = parseOutOfOrderAllowance(argv, { target, version: VERSION });
  // Read-only git show from the checkout HOSTED_APPLY_GIT_DIR names (this file
  // runs from a copy in its run directory, so it cannot find one itself).
  need(process.env.HOSTED_APPLY_GIT_DIR, "HOSTED_APPLY_GIT_DIR must name a checkout that holds the merge commit");
  const CLONE = process.env.HOSTED_APPLY_GIT_DIR;
  const refs = { sample: "sampledemoprojectref", production: "productionprojectref" };
  const systems = { sample: "7666007964130682852", production: "7662742571317219726" };
  const { initial } = ENV;
  const files = [ENV.file];
  const migrations = files.map(f => {
    const source = read(f);
    need(execFileSync("git", ["show", `${MAIN}:supabase/migrations/${f}`], { cwd: CLONE, encoding: "utf8" }) === source && sha(source) === PIN, `Merged bytes equal the pinned review ${f}`);
    const transactionProblem = sourceTransactionProblem(source);
    need(!transactionProblem && !source.includes("$src_late2d$"), `Exact source transaction bounds ${f}${transactionProblem ? `: ${transactionProblem}` : ""}`);
    return { file: f, version: f.slice(0, 14), name: f.slice(15, -4), source, sha256: sha(source), body: stripOuterTransaction(source) };
  });
  const historyRows = migrations.map(m => ({ version: m.version, name: m.name, statements_count: 1, statements_sha256: m.sha256 }));
  const cte = read("lifecycle-cte.sql").trimEnd(), stateSel = read("state-select.sql").trim();
  const stateCte = `${cte},\nst as materialized (${stateSel} state)\n`;
  const readQ = `begin isolation level repeatable read read only;\nset local search_path='';set local statement_timeout='60s';\n${stateCte}select st.state,encode(sha256(convert_to(st.state::text,'UTF8')),'hex') state_sha256,current_setting('transaction_read_only') ro from st;\nrollback;\n`;
  const hashExpr = `(${stateCte}select encode(sha256(convert_to(st.state::text,'UTF8')),'hex') from st)`;
  let token;
  async function request(phase, q, write = false, backup = false) {
    const dir = `${R}/${target}`;
    need(!existsSync(`${dir}/${phase}.attempt.json`), `Phase already attempted: ${phase}`);
    save(`${target}/${phase}.attempt.json`, { at_et: now(), target, project_ref: refs[target], main: MAIN, write_requested: write, query_sha256: q ? sha(q) : null, out_of_order_allowance: allowanceRecord(allowance, null) });
    log(`${phase} START ${write ? "write transaction" : "read-only"}${allowance ? ` (out-of-order allowance ${allowance.stamp})` : ""}`);
    // The workflow passes the production-db environment's token; the workstation reads its keyring.
    if (!token && process.env.SUPABASE_ACCESS_TOKEN) token = process.env.SUPABASE_ACCESS_TOKEN.trim();
    if (!token) token = execFileSync("secret-tool", ["lookup", "service", "Supabase CLI", "username", "supabase"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    need(token, "Credential unavailable");
    const res = await fetch(`https://api.supabase.com/v1/projects/${refs[target]}/database/${backup ? "backups" : "query"}`, {
      method: backup ? "GET" : "POST", redirect: "error",
      headers: { Authorization: `Bearer ${token}`, ...(!backup ? { "Content-Type": "application/json" } : {}) },
      ...(!backup ? { body: JSON.stringify({ query: q, read_only: !write }) } : {}), signal: AbortSignal.timeout(95000),
    });
    let body = await res.json();
    if (backup && res.ok) body = { completed: (body.backups ?? []).filter(b => b.status === "COMPLETED").map(({ id, inserted_at, status, is_physical_backup }) => ({ id, inserted_at, status, is_physical_backup })) };
    if (!res.ok) body = { message: typeof body?.message === "string" ? body.message.split(/\n(?:DETAIL|CONTEXT|QUERY|HINT):/)[0] : "Refused" };
    save(`${target}/${phase}.response.json`, { at_et: now(), http_status: res.status, body });
    log(`${phase} HTTP${res.status}${res.ok ? "" : ` ${body.message}`}`);
    need(res.ok, `${phase} refused; unknown writes require independent inspection, never replay`);
    return backup ? body : body[0];
  }
  const base = s => need(s.system_identifier === systems[target] && s.trigger_review_issues === 0 && s.login_status.roles === 0, "Target pin / lifecycle issues / temporary logins");
  const checkPre = s => { base(s); checkPreHistory(s, { initialCount: initial[target], preLatest: ENV.pre_latest, version: VERSION, allowance }); };
  const checkHistory = (s, b) => { base(s); checkHistoryAppend(s, b, historyRows, VERSION, allowance); };
  // A later phase must run under exactly the allowance the earlier phases recorded.
  const sameAllowance = (file, label) => need(same(json(file).out_of_order_allowance ?? { used: false }, allowanceRecord(allowance, json(file).out_of_order_allowance?.latest_version_kept ?? null)), `${label} ran under a different out-of-order allowance`);
  const keyOf = x => (x && typeof x === "object" ? (x.s ?? x.n ?? (x.kind ? [x.kind, x.schema_name, x.table_name, x.object_name].join("|") : null)) : null);
  function delta(s, b) {
    const out = {};
    for (const k of new Set([...Object.keys(s), ...Object.keys(b)])) {
      if (["full_history", "history_count", "latest_version"].includes(k)) continue;
      const A = s[k], B = b[k];
      if (same(A, B)) continue;
      if (Array.isArray(A) && Array.isArray(B) && A.every(x => keyOf(x) !== null) && B.every(x => keyOf(x) !== null)) {
        const ma = new Map(A.map(x => [keyOf(x), x])), mb = new Map(B.map(x => [keyOf(x), x]));
        out[k] = { added: [...ma.keys()].filter(x => !mb.has(x)).sort(), removed: [...mb.keys()].filter(x => !ma.has(x)).sort(), changed: [...ma.keys()].filter(x => mb.has(x) && !same(ma.get(x), mb.get(x))).sort() };
      } else out[k] = { before: B, after: A };
    }
    return out;
  }
  async function preflight() {
    const r = await request("preflight", readQ);
    need(r.ro === "on", "Read-only");
    checkPre(r.state);
    const backups = (await request("backups", null, false, true)).completed.sort((a, b) => Date.parse(b.inserted_at) - Date.parse(a.inserted_at));
    need(backups.length && Date.now() - Date.parse(backups[0].inserted_at) < 36 * 3600e3, "Completed backup within 36 h");
    save(`${target}/PREFLIGHT-PASS.json`, { passed: true, at_et: now(), completed_at: Date.now(), state_sha256: r.state_sha256, history_before: r.state.history_count, backup: backups[0], out_of_order_allowance: allowanceRecord(allowance, r.state.latest_version) });
    console.log(JSON.stringify({ target, preflight: "PASS", history: r.state.history_count, backup: backups[0], out_of_order_allowance: allowance?.stamp ?? null }));
  }
  function wrapper(commit) {
    const p = json(`${target}/PREFLIGHT-PASS.json`);
    need(p.passed && Date.now() - p.completed_at < 900000, "Fresh preflight (15 min)");
    let q = `begin isolation level read committed;\nset local search_path='';set local lock_timeout='5s';set local statement_timeout='60s';\nlock table supabase_migrations.schema_migrations in share row exclusive mode;\n`;
    q += `do $pre$ begin if current_setting('transaction_read_only')<>'off' or ${hashExpr}<>'${p.state_sha256}' then raise exception 'Exact preflight state drift'; end if; end; $pre$;\n`;
    for (const m of migrations) q += `-- ${m.file} sha256 ${m.sha256}\n${m.body}\ninsert into supabase_migrations.schema_migrations(version,name,statements) values ('${m.version}','${m.name}',array[$src_late2d$${m.source}$src_late2d$]::text[]);\n`;
    q += `set local search_path='';set local statement_timeout='60s';\n`;
    if (commit) {
      const h = json(`${target}/REHEARSAL-PASS.json`).post_state_sha256;
      q += `do $post$ begin if ${hashExpr}<>'${h}' then raise exception 'Post state differs from the validated rehearsal'; end if; end; $post$;\ncommit;\n`;
    } else q += `${stateCte}select st.state,encode(sha256(convert_to(st.state::text,'UTF8')),'hex') state_sha256 from st;\nrollback;\n`;
    return q;
  }
  async function rehearse() {
    sameAllowance(`${target}/PREFLIGHT-PASS.json`, "Preflight");
    const q = wrapper(false);
    writeFileSync(`${R}/${target}/rehearsal.sql`, q, { flag: "wx" });
    const r = await request("rehearsal", q, true);
    const b = json(`${target}/preflight.response.json`).body[0].state;
    checkHistory(r.state, b);
    const again = await request("rehearsal-readback", readQ);
    need(again.state_sha256 === json(`${target}/PREFLIGHT-PASS.json`).state_sha256, "Rollback left state unchanged");
    const d = delta(r.state, b), text = `${JSON.stringify(d, null, 2)}\n`;
    writeFileSync(`${R}/${target}/DELTA.json`, text, { flag: "wx" });
    log(`rehearsal delta written (sha256 ${sha(text)}); approve after review`);
    console.log(JSON.stringify({ target, rehearsal: "ROLLED BACK, delta written", post_history: r.state.history_count, rollback_clean: true, delta_sha256: sha(text), keys: Object.keys(d) }));
  }
  async function approve() {
    const shaArg = argv[2], text = read(`${target}/DELTA.json`);
    need(/^[0-9a-f]{64}$/.test(shaArg ?? "") && sha(text) === shaArg, "Approve with the exact DELTA.json sha256");
    sameAllowance(`${target}/PREFLIGHT-PASS.json`, "Preflight");
    const r = json(`${target}/rehearsal.response.json`).body[0];
    save(`${target}/REHEARSAL-PASS.json`, { passed: true, at_et: now(), post_state_sha256: r.state_sha256, rollback_readback_equals_preflight: true, rehearsal_sql_sha256: sha(read(`${target}/rehearsal.sql`)), delta_sha256: shaArg, approved_by: "the operator lane after reviewing DELTA.json against the migration content", out_of_order_allowance: json(`${target}/PREFLIGHT-PASS.json`).out_of_order_allowance ?? { used: false } });
    log(`delta ${shaArg} approved; REHEARSAL-PASS written`);
    console.log(JSON.stringify({ target, approved: shaArg }));
  }
  async function apply() {
    need(json(`${target}/REHEARSAL-PASS.json`).passed, "Rehearsal PASS first");
    sameAllowance(`${target}/REHEARSAL-PASS.json`, "Rehearsal");
    const q = wrapper(true);
    writeFileSync(`${R}/${target}/apply.sql`, q, { flag: "wx" });
    save(`${target}/apply-manifest.json`, { target, main: MAIN, wrapper_sha256: sha(q), migrations: migrations.map(({ file, version, sha256 }) => ({ file, version, sha256 })), backup: json(`${target}/PREFLIGHT-PASS.json`).backup, out_of_order_allowance: json(`${target}/REHEARSAL-PASS.json`).out_of_order_allowance });
    await request("apply", q, true);
    console.log(JSON.stringify({ target, committed_http_success: true }));
  }
  async function verify() {
    need(json(`${target}/apply.response.json`).http_status === 201, "Successful apply required");
    sameAllowance(`${target}/REHEARSAL-PASS.json`, "Rehearsal");
    const r = await request("verify", readQ), b = json(`${target}/preflight.response.json`).body[0].state;
    need(r.ro === "on", "Read-only");
    checkHistory(r.state, b);
    need(r.state_sha256 === json(`${target}/REHEARSAL-PASS.json`).post_state_sha256, "Read-back equals the validated rehearsal");
    const outOfOrder = allowanceRecord(allowance, b.latest_version);
    const proof = { passed: true, target, project_ref: refs[target], at_et: now(), main: MAIN, history_before: b.history_count, history_after: r.state.history_count, latest_version: r.state.latest_version, state_sha256: r.state_sha256, delta_sha256: json(`${target}/REHEARSAL-PASS.json`).delta_sha256, backup: json(`${target}/PREFLIGHT-PASS.json`).backup, out_of_order_allowance: outOfOrder, smoke: "not run; catalog/history proof with reviewed delta" };
    save(`${target}/VERIFY-PASS.json`, proof);
    const caps = [...["preflight", "backups", "rehearsal", "rehearsal-readback", "apply", "verify", ...["smoke", "smoke2"].filter(n => existsSync(`${R}/${target}/${n}.attempt.json`))].flatMap(n => [`${target}/${n}.attempt.json`, `${target}/${n}.response.json`]), ...["PREFLIGHT-PASS.json", "REHEARSAL-PASS.json", "VERIFY-PASS.json", "rehearsal.sql", "apply.sql", "apply-manifest.json"].map(n => `${target}/${n}`), ...files, "runner.mjs", "lifecycle-cte.sql", "state-select.sql", "env.json", `${target}/DELTA.json`].map(path => { const x = readFileSync(`${R}/${path}`); return { path, bytes: x.length, sha256: sha(x) }; });
    const receipt = { schema: 1, kind: "hosted-migration-apply-verification-evidence", integration_pr: ENV.pr, integration_merge: MAIN, target, project_ref: refs[target], system_identifier: systems[target], migrations: migrations.map(({ file, version, sha256 }) => ({ path: `supabase/migrations/${file}`, version, sha256 })), application: { outcome: "APPLIED", observed_et: json(`${target}/apply.response.json`).at_et, wrapper_sha256: json(`${target}/apply-manifest.json`).wrapper_sha256, one_transaction: true }, out_of_order_allowance: outOfOrder, verification: { outcome: "PASS", ...proof }, captures: caps, limits: "Catalog, grants, cron and exact history only; no end-to-end acceptance and no issue closure claimed.", worklist_records_closed: [] };
    mkdirSync(`${R}/receipts`, { recursive: true });
    const out = `${R}/receipts/${target}-${VERSION}.json`;
    writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
    log(`VERIFY PASS history ${b.history_count} -> ${r.state.history_count}${allowance ? ` (out-of-order allowance ${allowance.stamp}, latest_version kept ${b.latest_version})` : ""}; receipt ${out}`);
    console.log(JSON.stringify({ target, result: "PASS", history: r.state.history_count, receipt: out }));
  }
  if (mode === "--approve") await approve();
  else if (mode === "--preflight") await preflight();
  else if (mode === "--rehearse") await rehearse();
  else if (mode === "--apply") await apply();
  else await verify();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
