// Shared plumbing for the migration text-pin tests.
//
// Roughly thirty test files were carrying their own copy of "find the
// migration, strip its comments, cut out one function body", and the copies had
// drifted in two ways that matter:
//
//   * The path. Most files resolved supabase/migrations/ against
//     process.cwd(), a few against `new URL("../supabase/migrations/",
//     import.meta.url)`. Both are traps. process.cwd() agrees with the repo
//     root only while vitest happens to be invoked from it; and the URL form
//     works ONLY in files carrying `@vitest-environment node`, because under
//     jsdom the global URL constructor resolves the relative path against
//     http://localhost:3000 instead of the module and node:fs then rejects it
//     ("The URL must be of scheme file"). This module therefore anchors to its
//     own location through node:url's fileURLToPath, which is neither
//     cwd-dependent nor at the mercy of whichever URL the environment installs.
//   * The comment stripper. Every negative pin in the suite ("the migration
//     must NOT still grant insert here") is only sound when it runs against
//     executable SQL, and the copies disagreed about what a comment is: some
//     stripped whole `--` lines only and so read a trailing comment as live
//     SQL, some stripped every `--` in the file and so ate the hyphens inside
//     quoted literals. Both are false-negative generators, in opposite
//     directions, which is why the stripper below scans rather than regexes.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../supabase/migrations");

let cached = null;

// [{ name, sql }] for every migration, sorted by filename — the order Postgres
// applies them in, so callers can reason about "a later file supersedes this".
export function migrationFiles() {
  if (!cached) {
    cached = readdirSync(migrationsDir)
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map((name) => ({ name, sql: readFileSync(join(migrationsDir, name), "utf8") }));
  }
  return cached;
}

export function migrationNames() {
  return migrationFiles().map((entry) => entry.name);
}

// Locate one migration by any fragment of its filename. Ambiguity is an error
// rather than a silent first match: a fragment that starts matching two files
// once a later migration lands would otherwise quietly keep pinning the older
// one, and the pin would stay green while the live definition moved on.
function findMigration(fragment) {
  const matches = migrationFiles().filter((entry) => entry.name.includes(fragment));
  if (matches.length !== 1) {
    throw new Error(`expected exactly one migration matching "${fragment}", found ${matches.length}`);
  }
  return matches[0];
}

// The filename, for the pins that compare apply ORDER between two migrations.
export function findMigrationName(fragment) {
  return findMigration(fragment).name;
}

export function loadMigrationSql(fragment) {
  return findMigration(fragment).sql;
}

// Re-exported, not reimplemented. The scanner moved to scripts/lib/sql-text.mjs
// on 2026-07-26 after an adversarial review found that verify-migration-history
// .mjs had been stripping comments with the naive `/--[^\n]*/g` regex this
// helper's header was written to warn against — two answers to the same
// question, in the same repo, disagreeing about quoted literals. Callers keep
// importing `stripComments` from here; there is now only one implementation
// behind it.
import { stripSqlComments } from "../../scripts/lib/sql-text.mjs";
export { stripSqlComments as stripComments };

// Where the declaration of `name` starts. `name` is whatever identifies it
// uniquely — a bare name, a schema-qualified one, or a signature prefix — and
// a leading `create [or replace] function` is tolerated so callers can paste
// the statement as written. A bare name is also tried schema-qualified.
//
// When the caller's needle carries no argument list of its own the match must
// be followed by the opening paren; without that a hypothetical `<name>_v2`
// declared earlier in the same file is silently matched instead.
function declarationStart(sql, name) {
  const wanted = name.replace(/^create\s+(or\s+replace\s+)?/i, "").replace(/^function\s+/i, "").toLowerCase();
  const haystack = sql.toLowerCase();
  for (const needle of [`function ${wanted}`, `function public.${wanted}`]) {
    for (let at = haystack.indexOf(needle); at > -1; at = haystack.indexOf(needle, at + 1)) {
      if (!needle.includes("(") && !/^\s*\(/.test(haystack.slice(at + needle.length, at + needle.length + 8))) continue;
      // Include the `create [or replace] ` that introduces the declaration when
      // there is one, so the returned text is the whole statement.
      const lead = sql.slice(Math.max(0, at - 24), at).match(/create\s+(or\s+replace\s+)?$/i);
      return lead ? at - lead[0].length : at;
    }
  }
  return -1;
}

// One function's declaration, from `create ... function <name>(` through the
// dollar quote that closes its body.
export function fnBody(sql, name) {
  const start = declarationStart(sql, name);
  if (start === -1) throw new Error(`function ${name} is not declared in this migration`);
  return bodyFrom(sql, name, start);
}

// The declaration that starts at `start`, through the dollar quote closing it.
// Bodies are quoted with either $$ or the $function$ tag that
// pg_get_functiondef emits; the declaration ends at whichever comes first.
function bodyFrom(sql, name, start) {
  // pg_get_functiondef can put the statement semicolon on the next line.
  // Stopping only at a contiguous "$function$;" swallowed the next function.
  const end = /(?:\$\$|\$function\$)\s*;/g;
  end.lastIndex = start;
  const closing = end.exec(sql);
  if (!closing) throw new Error(`function ${name} does not terminate in this migration`);
  return sql.slice(start, closing.index + closing[0].length);
}

// Last create-or-replace body still live after every later migration. Walk
// apply order, keep the last file whose executable SQL creates the function,
// and refuse a catalogue whose last action is a drop with no recreation.
// Classification runs on stripComments output, so a commented drop cannot
// retire a live definition and a commented create cannot revive it — and the
// body is cut from that same executable text at the offset the scan selected,
// not re-found from the top of the file. Re-finding was wrong when one
// migration replaces its own earlier signature (20260826155000 declares
// create_integration_webhook twice); the first declaration is dead by the end
// of the file, and the pin has to inspect the one that survives it.
export function latestFnBody(name) {
  let lastSql = null;
  let lastStart = -1;
  let lastKind = null;
  let lastFile = null;
  for (const file of migrationFiles()) {
    const executable = stripSqlComments(file.sql);
    const decisive = lastDecisiveFunctionSite(executable, name);
    if (!decisive) continue;
    lastKind = decisive.kind;
    lastFile = file.name;
    lastSql = decisive.kind === "create" ? executable : null;
    lastStart = decisive.start;
  }
  if (lastKind === "drop") {
    throw new Error(`function ${name} is dropped without recreation in ${lastFile}`);
  }
  if (!lastSql) {
    throw new Error(`function ${name} is not declared in any migration`);
  }
  return bodyFrom(lastSql, name, lastStart);
}

// The last statement in `sql` that creates or drops `name`, as
// { at, start, kind } — `start` is the offset of the leading keyword, so the
// caller can cut the statement rather than search for it again.
//
// Both keyword forms are matched behind the name rather than in front of it,
// because `drop function if exists public.<name>(...)` — the form 47 of this
// repo's migrations use — puts two tokens between `function` and the name. An
// earlier version anchored on the literal `function <name>` and so saw those
// drops as ordinary references, which silently reported dropped RPCs as live.
const KEYWORD_LEAD = 48;

function lastDecisiveFunctionSite(sql, name) {
  const wanted = name.replace(/^create\s+(or\s+replace\s+)?/i, "").replace(/^function\s+/i, "").toLowerCase();
  const haystack = sql.toLowerCase();
  let last = null;
  for (const needle of [wanted, `public.${wanted}`]) {
    for (let at = haystack.indexOf(needle); at > -1; at = haystack.indexOf(needle, at + 1)) {
      if (!needle.includes("(") && !/^\s*\(/.test(haystack.slice(at + needle.length, at + needle.length + 8))) continue;
      const lead = sql.slice(Math.max(0, at - KEYWORD_LEAD), at);
      const create = lead.match(/create\s+(or\s+replace\s+)?function\s+$/i);
      const drop = create ? null : lead.match(/drop\s+function\s+(if\s+exists\s+)?$/i);
      if (!create && !drop) continue;
      if (!last || at >= last.at) {
        last = { at, start: at - (create ?? drop)[0].length, kind: create ? "create" : "drop" };
      }
    }
  }
  return last;
}

// The derived form of the exhaustive-tail pin.
//
// The provenance pins used to list, by hand, every migration that sorted after
// the pinned one, each with a reviewer note saying "touches no knowledge,
// revision or retirement object". That list was the only thing standing
// between a later migration and a pin that silently describes a superseded
// definition, but it also meant every migration PR in the repository edited
// the same three arrays, so every open migration PR conflicted with every
// other one.
//
// The question the list answered is mechanical: does a later migration's
// EXECUTABLE SQL name any object the pinning file describes? That is what the
// helpers below compute. A later migration that names none of the objects
// needs no review and no edit here; one that names any of them (or runs a
// schema-wide statement that could re-grant or drop them without naming
// them) is reported, and the pinning file must list it in its reviewed set.

const IDENT = "[a-z_][a-z0-9_$]*";

// Every object a migration declares or alters, schema-qualified and
// lowercase: functions it creates, tables it creates or alters, and tables it
// attaches a policy, trigger, index, grant or comment to (`on <schema>.<table>`,
// schema-qualified so a join alias is never mistaken for a table).
// Unqualified names are read as public.
export function migrationObjects(fragment) {
  const code = stripSqlComments(loadMigrationSql(fragment)).toLowerCase().replace(/"/g, "");
  const found = new Set();
  const qualify = (name) => (name.includes(".") ? name : `public.${name}`);
  const patterns = [
    new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+(${IDENT}(?:\\.${IDENT})?)`, "g"),
    new RegExp(`(?:alter|create)\\s+table\\s+(?:if\\s+(?:not\\s+)?exists\\s+)?(?:only\\s+)?(${IDENT}(?:\\.${IDENT})?)`, "g"),
    new RegExp(`\\bon\\s+(?:table\\s+)?((?:public|private|auth|storage)\\.${IDENT})`, "g"),
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) found.add(qualify(match[1]));
  }
  return [...found].sort();
}

// Statements that can change an object's grants, ownership or existence
// without naming it.
const SCHEMA_WIDE = /\bon\s+all\s+(?:tables|functions|routines|procedures|sequences)\s+in\s+schema\b|\balter\s+default\s+privileges\b|\bdrop\s+schema\b|\balter\s+schema\b|\bdrop\s+owned\b|\breassign\s+owned\b/;

// Which of `objects` the executable part of `sql` names. A qualified object
// matches either qualified (quoted or not) or bare, because search_path makes
// a bare reference to a public or private routine resolve to it. Comments are
// ignored: a migration may DISCUSS an object freely.
export function sqlObjectsNamed(sql, objects) {
  const code = stripSqlComments(sql).toLowerCase().replace(/"/g, "");
  const hits = objects.filter((object) => {
    const bare = object.split(".").pop();
    return new RegExp(`(?<![a-z0-9_$.])(?:${IDENT}\\.)?${bare.replace(/\$/g, "\\$")}(?![a-z0-9_$])`).test(code);
  });
  if (SCHEMA_WIDE.test(code)) hits.push("<schema-wide statement>");
  return hits;
}

// [{ name, hits }] for every migration AFTER `name` whose executable SQL names
// any of `objects`, in apply order.
export function laterMigrationsNaming(name, objects) {
  const files = migrationFiles();
  const at = files.findIndex((entry) => entry.name === name);
  if (at === -1) throw new Error(`migration ${name} is not present`);
  return files.slice(at + 1)
    .map((entry) => ({ name: entry.name, hits: sqlObjectsNamed(entry.sql, objects) }))
    .filter((entry) => entry.hits.length > 0);
}
