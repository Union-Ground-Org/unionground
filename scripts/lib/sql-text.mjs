// One implementation of "what is executable SQL text, and what is commentary".
//
// This module exists because the repo had two answers. tests/helpers/migration.js
// carried a careful left-to-right scanner, written precisely because a `--`
// inside a quoted literal is DATA and a regex always eats it. Meanwhile
// scripts/verify-migration-history.mjs carried `.replace(/--[^\n]*/g, "")` —
// the exact naive form that helper's own header calls a false-negative
// generator. An adversarial review on 2026-07-26 found the divergence.
//
// The scanner now lives here and both consumers import it, so the two cannot
// drift apart again.

// Index one past the closing quote of the literal that starts at `start`.
function literalEnd(sql, start) {
  const escapeBackslashes = (sql[start - 1] === "e" || sql[start - 1] === "E")
    && (start < 2 || !/[A-Za-z0-9_$]/.test(sql[start - 2]));
  let end = start + 1;
  while (end < sql.length) {
    // PostgreSQL escape strings treat a backslash plus the following byte as
    // literal content, including \\' where the quote must not end the string.
    if (escapeBackslashes && sql[end] === "\\") {
      end = Math.min(end + 2, sql.length);
      continue;
    }
    if (sql[end] === "'") {
      // '' inside a literal is an escaped quote, not the end of it.
      if (sql[end + 1] === "'") {
        end += 2;
        continue;
      }
      return end + 1;
    }
    end += 1;
  }
  return end;
}

// Index one past the end of the comment that starts at `start`, or -1 if no
// comment starts there. Postgres nests block comments, so this tracks depth
// instead of stopping at the first `*/`.
function commentEnd(sql, start) {
  if (sql.startsWith("--", start)) {
    const newline = sql.indexOf("\n", start);
    // Stop AT the newline, never past it: line structure is what the
    // whole-line pins elsewhere in the suite are anchored to.
    return newline === -1 ? sql.length : newline;
  }
  if (!sql.startsWith("/*", start)) return -1;
  let depth = 1;
  let i = start + 2;
  while (i < sql.length && depth > 0) {
    if (sql.startsWith("/*", i)) {
      depth += 1;
      i += 2;
    } else if (sql.startsWith("*/", i)) {
      depth -= 1;
      i += 2;
    } else {
      i += 1;
    }
  }
  return i;
}

/**
 * Remove SQL comments and nothing else.
 *
 * A single left-to-right scan, because the three constructs interfere: a `--`
 * inside a block comment is not a line comment, a `/*` inside a quoted literal
 * is not a block comment, and a `--` inside a quoted literal is data.
 *
 * Deliberately NOT dollar-quote aware. `$$ ... $$` function bodies are SQL, and
 * roughly thirty negative pins in the suite depend on comments inside a body
 * being stripped like any other comment ("this function must not still grant").
 * Treating a body as one opaque literal would silently disarm every one of them.
 */
export function stripSqlComments(sql) {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const comment = commentEnd(sql, i);
    if (comment !== -1) {
      i = comment;
      continue;
    }
    if (sql[i] === "'") {
      out += sql.slice(i, (i = literalEnd(sql, i)));
      continue;
    }
    out += sql[i];
    i += 1;
  }
  return out;
}

/**
 * The same SQL with every comment and quoted literal blanked to spaces
 * (newlines kept), so each offset still points at the same place in the
 * original text. A scanner that must see only executable statements (a
 * `drop function` inside a comment or a string is not one) matches against
 * this. Like stripSqlComments it is not dollar-quote aware.
 */
export function maskSqlCommentsAndLiterals(sql) {
  const blank = (text) => text.replace(/[^\n]/g, " ");
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const comment = commentEnd(sql, i);
    if (comment !== -1) {
      out += blank(sql.slice(i, comment));
      i = comment;
      continue;
    }
    if (sql[i] === "'") {
      const end = literalEnd(sql, i);
      out += blank(sql.slice(i, end));
      i = end;
      continue;
    }
    out += sql[i];
    i += 1;
  }
  return out;
}

/**
 * Canonical form for comparing two spellings of the same migration.
 *
 * Comments, whitespace, semicolons and identifier case are all noise: the
 * platform and CLI apply paths disagree about trailing semicolons and line
 * wrapping, and a file reflowed by an editor is the same migration.
 *
 * String literals are the exception and are preserved BYTE FOR BYTE, because
 * inside quotes those same differences are meaning. The previous
 * implementation lowercased and space-stripped everything, so
 * `'Chapter steward'` and `'chaptersteward'` canonicalised identically — a
 * false PASS on a real content change.
 *
 * This is NOT a strict one-way tightening, and an earlier version of this
 * comment wrongly claimed it was. The regex it replaces stripped only `--`
 * comments, so it hashed BLOCK comments as content: two statements differing
 * only inside a slash-star comment used to differ and now match. (Spelling that
 * example out literally here would end this comment early — JS block comments
 * do not nest, which is exactly the difference from Postgres that commentEnd
 * tracks depth for.) That direction is
 * deliberate — a block comment is commentary in exactly the way a line comment
 * is, and treating one as content while ignoring the other was the
 * inconsistency, not the safety property. Comment-only edits to an
 * already-applied migration stay invisible either way, which is load-bearing:
 * it is how a correction can be added to a migration's header without
 * manufacturing content drift against the recorded statements.
 */
// The end of a dollar-quoted body starting at `start` ($$...$$ or $tag$...$tag$),
// or -1 when no dollar quote starts there.
function dollarQuoteEnd(sql, start) {
  if (sql[start] !== "$" || /[A-Za-z0-9_$]/.test(sql[start - 1] ?? "")) return -1;
  const opener = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(start, start + 64));
  if (!opener) return -1;
  const close = sql.indexOf(opener[0], start + opener[0].length);
  return close === -1 ? sql.length : close + opener[0].length;
}

// With { dollarQuotes: true } a dollar-quoted body is kept byte for byte, so a
// quote or `--` inside it (JSON fixtures, function bodies) cannot change how
// the text after it is read. The default keeps the historical behaviour that
// the database contract's stored canonical forms were computed with.
export function canonicaliseSql(sql, { dollarQuotes = false } = {}) {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const comment = commentEnd(sql, i);
    if (comment !== -1) {
      i = comment;
      continue;
    }
    const dollar = dollarQuotes ? dollarQuoteEnd(sql, i) : -1;
    if (dollar !== -1) {
      out += sql.slice(i, (i = dollar));
      continue;
    }
    if (sql[i] === "'") {
      out += sql.slice(i, (i = literalEnd(sql, i)));
      continue;
    }
    const char = sql[i];
    i += 1;
    if (char === ";" || /\s/.test(char)) continue;
    out += char.toLowerCase();
  }
  return out;
}

/**
 * Canonical form for catalog expressions such as pg_policy.qual.
 *
 * PostgreSQL folds unquoted identifiers, but quoted identifiers are
 * byte-sensitive: "UserID" and "userid" can name different columns. Preserve
 * both single-quoted strings and double-quoted identifiers, including doubled
 * quote escapes, while folding only unquoted spelling noise.
 */
export function canonicaliseCatalogSql(sql) {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const comment = commentEnd(sql, i);
    if (comment !== -1) {
      i = comment;
      continue;
    }
    if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i];
      let end = i + 1;
      while (end < sql.length) {
        if (sql[end] === quote) {
          if (sql[end + 1] === quote) {
            end += 2;
            continue;
          }
          end += 1;
          break;
        }
        end += 1;
      }
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    const char = sql[i];
    i += 1;
    if (char === ";" || /\s/.test(char)) continue;
    out += char.toLowerCase();
  }
  return out;
}

// Splits SQL text into top-level statements, ending each at a semicolon that
// is not inside a comment, a quoted literal or identifier, or a dollar-quoted
// body. Fails on an unclosed construct instead of guessing.
export function sqlStatements(sql) {
  const fail = (message) => { throw new Error(message); };
  const result = []; let start = 0; let i = 0;
  while (i < sql.length) {
    if (sql.startsWith("--", i)) { const end = sql.indexOf("\n", i); i = end < 0 ? sql.length : end + 1; continue; }
    if (sql.startsWith("/*", i)) {
      let depth = 1; i += 2;
      while (depth && i < sql.length) { if (sql.startsWith("/*", i)) { depth++; i += 2; } else if (sql.startsWith("*/", i)) { depth--; i += 2; } else i++; }
      if (depth !== 0) fail("Unclosed SQL comment");
      continue;
    }
    const dollar = sql.slice(i).match(/^\$(?:[a-zA-Z_][a-zA-Z_0-9]*)?\$/)?.[0];
    if (dollar) { const end = sql.indexOf(dollar, i + dollar.length); if (end < 0) fail("Unclosed SQL body"); i = end + dollar.length; continue; }
    if (sql[i] === "'" || sql[i] === '"') {
      const quote = sql[i++]; let closed = false;
      while (i < sql.length) { if (sql[i] === "\\" && quote === "'") { i += 2; continue; } if (sql[i++] === quote) { if (sql[i] === quote) i++; else { closed = true; break; } } }
      if (!closed) fail("Unclosed SQL literal");
      continue;
    }
    if (sql[i++] === ";") { result.push(sql.slice(start, i)); start = i; }
  }
  if (sql.slice(start).trim()) result.push(sql.slice(start));
  return result;
}
