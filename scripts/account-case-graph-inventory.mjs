import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { stripSqlComments } from './lib/sql-text.mjs';

// Count top-level arguments, including defaults containing nested expressions.
function argumentCount(sql, start) {
  let depth = 1; let quote = false; let count = 0; let content = false;
  for (let i = start; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === "'") {
      if (quote && sql[i + 1] === "'") { i += 1; continue; }
      quote = !quote;
    }
    if (quote) { content = true; continue; }
    if (ch === '(' || ch === '[') depth += 1;
    if (ch === ')' || ch === ']') {
      depth -= 1;
      if (depth === 0) return content ? count + 1 : 0;
    }
    if (depth === 1 && ch === ',') count += 1;
    if (/\S/.test(ch)) content = true;
  }
  throw new Error('Unterminated function argument list');
}

// Dollar-delimited bodies are consumed as units so nested SQL and comments do
// not become independent declarations. Historical definitions remain available
// to authenticate the installation wrapper's exact source hash.
export function parseFunctions(sql, file = '', { strictExecute = false } = {}) {
  const functions = [];
  const declarations = topLevelSql(sql, { declarations: true, strictExecute });
  const declaration = /^\s*create\s+(?:or\s+replace\s+)?function\s+([\w]+\.[\w]+)\s*\(/gim;
  let match;
  while ((match = declaration.exec(sql))) {
    const keyword = match.index + match[0].search(/\bcreate\b/i);
    if (declarations.slice(keyword, keyword + 6).toLowerCase() !== 'create') continue;
    const tail = sql.slice(declaration.lastIndex);
    const opening = /\bas\s+(\$[\w]*\$)/i.exec(tail);
    if (!opening) throw new Error(`Missing function body: ${file}:${match[1]}`);
    const start = declaration.lastIndex + opening.index + opening[0].length;
    const end = sql.indexOf(opening[1], start);
    if (end < 0) throw new Error(`Unterminated function: ${file}:${match[1]}`);
    const source = sql.slice(start, end);
    functions.push({ name: match[1].toLowerCase(), arity: argumentCount(declarations, declaration.lastIndex), source, file, offset: match.index, sourceSha256: createHash('sha256').update(source).digest('hex') });
    declaration.lastIndex = end + opening[1].length;
  }
  return functions;
}

// Upstream choice (b) on #5400, record BUG-UG-FUNCTION-INVENTORY-DYNAMIC-DDL-
// FAIL-CLOSED-20261021: reassembling EXECUTE-built DDL is a heuristic every
// review defeated, so the migration inventory fails closed instead. In a DO
// block EXECUTE takes one plain literal, with data passed through USING.
// Concatenation, concat(), format() (whose %L can still close a quote the
// template opened) and variables are an unknown shape, except the historical DO
// bodies pinned by exact SHA-256 in the reviewed file, which keep the
// heuristic below. A new or edited block is never pinned implicitly.
const reviewedDynamicExecute = JSON.parse(readFileSync(new URL('./account-case-graph-dynamic-execute-review.json', import.meta.url), 'utf8'));
const reviewedDynamicExecuteBodies = new Set(reviewedDynamicExecute.blocks.map(block => block.body_sha256));
const dollarDelimiter = /\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/y;

function plainLiteral(sql, start) {
  if (sql[start] === "'") {
    for (let end = start + 1; end < sql.length; end += 1) {
      if (sql[end] !== "'") continue;
      if (sql[end + 1] === "'") { end += 1; continue; }
      return { end: end + 1, text: sql.slice(start + 1, end).replace(/''/g, "'") };
    }
    return null;
  }
  dollarDelimiter.lastIndex = start;
  const delimiter = dollarDelimiter.exec(sql)?.[0];
  if (!delimiter) return null;
  const closing = sql.indexOf(delimiter, start + delimiter.length);
  return closing < 0 ? null : { end: closing + delimiter.length, text: sql.slice(start + delimiter.length, closing) };
}

// PostgreSQL's whitespace. JavaScript's \s also matches non-ASCII spaces,
// which PostgreSQL reads as identifier characters.
const SQL_SPACE = /[ \t\n\r\f\v]/;

// Skip PostgreSQL whitespace and comments: -- lines and nested /* */ blocks.
function skipSqlSpace(sql, index) {
  for (;;) {
    if (SQL_SPACE.test(sql[index] ?? '')) index += 1;
    else if (sql.startsWith('--', index)) {
      const newline = sql.slice(index).search(/[\n\r]/);
      index = newline < 0 ? sql.length : index + newline + 1;
    } else if (sql.startsWith('/*', index)) {
      let depth = 0;
      while (index < sql.length) {
        if (sql.startsWith('/*', index)) { depth += 1; index += 2; }
        else if (sql.startsWith('*/', index)) { depth -= 1; index += 2; if (depth === 0) break; }
        else index += 1;
      }
    } else return index;
  }
}

// The next SQL token after whitespace and comments (#5710 6332873056): a
// word (lower-cased), a double-quoted identifier, or one punctuation character.
// null at the end of the text or in an unterminated quoted identifier.
function nextSqlToken(sql, index) {
  index = skipSqlSpace(sql, index);
  if (index >= sql.length) return null;
  if (sql[index] === '"') {
    for (let end = index + 1; end < sql.length; end += 1) {
      if (sql[end] !== '"') continue;
      if (sql[end + 1] === '"') { end += 1; continue; }
      return { kind: 'quoted', text: sql.slice(index + 1, end).replace(/""/g, '"'), end: end + 1 };
    }
    return null;
  }
  if (/[A-Za-z_\u0080-\uffff]/.test(sql[index])) {
    let end = index + 1;
    while (end < sql.length && /[A-Za-z0-9_$\u0080-\uffff]/.test(sql[end])) end += 1;
    return { kind: 'word', text: sql.slice(index, end).toLowerCase(), end };
  }
  return { kind: 'punct', text: sql[index], end: index + 1 };
}

// After a GRANT or REVOKE EXECUTE: ON, then a routine object class or ALL.
function routineObjectFollows(sql, index) {
  const on = nextSqlToken(sql, index);
  if (on?.kind !== 'word' || on.text !== 'on') return false;
  const object = nextSqlToken(sql, on.end);
  return object?.kind === 'word' && /^(?:(?:function|procedure|routine)s?|all)$/.test(object.text);
}

// After a trigger's EXECUTE: FUNCTION or PROCEDURE, a name whose parts may be
// quoted and spaced around their dots, then the opening parenthesis.
function triggerFunctionFollows(sql, index) {
  const kind = nextSqlToken(sql, index);
  if (kind?.kind !== 'word' || !['function', 'procedure'].includes(kind.text)) return false;
  let token = nextSqlToken(sql, kind.end);
  for (;;) {
    if (token?.kind !== 'word' && token?.kind !== 'quoted') return false;
    token = nextSqlToken(sql, token.end);
    if (token?.kind !== 'punct' || token.text !== '.') break;
    token = nextSqlToken(sql, token.end);
  }
  return token?.kind === 'punct' && token.text === '(';
}

// A PL/pgSQL statement that is itself CREATE [OR REPLACE] [CONSTRAINT |
// EVENT] TRIGGER, after only block keywords: an EXECUTE inside it is the
// trigger's clause, never the dynamic command, whatever word precedes it
// (#5710 6334778667: ON table EXECUTE FUNCTION with FOR EACH omitted).
const CREATE_TRIGGER_STATEMENT = /^[ \t\n\r\f\v]*(?:(?:begin|then|else|loop)[ \t\n\r\f\v]+)*create[ \t\n\r\f\v]+(?:or[ \t\n\r\f\v]+replace[ \t\n\r\f\v]+)?(?:(?:constraint|event)[ \t\n\r\f\v]+)?trigger(?![A-Za-z0-9_$\u0080-\uffff])/i;

// The prefix is already masked, so comments and quoted text cannot introduce
// a control delimiter. Only walk headers from a statement start: CREATE and
// TRIGGER mentioned in a condition never identify its following statement.
function startsTriggerStatement(prefix) {
  let index = 0;
  for (;;) {
    index = skipSqlSpace(prefix, index);
    const token = nextSqlToken(prefix, index);
    if (token?.kind !== 'word') return false;
    if (['begin', 'then', 'else', 'loop'].includes(token.text)) {
      index = token.end;
      continue;
    }
    if (!['if', 'elsif', 'while', 'for', 'foreach', 'exception'].includes(token.text)) {
      return CREATE_TRIGGER_STATEMENT.test(prefix.slice(index));
    }
    const delimiter = ['while', 'for', 'foreach'].includes(token.text) ? 'loop' : 'then';
    let cursor = token.end;
    if (token.text === 'exception') {
      const when = nextSqlToken(prefix, cursor);
      if (when?.kind !== 'word' || when.text !== 'when') return false;
      cursor = when.end;
    }
    let parentheses = 0; let cases = 0; let complete = false;
    for (let part = nextSqlToken(prefix, cursor); part; part = nextSqlToken(prefix, part.end)) {
      if (part.kind === 'punct') {
        if (part.text === '(') parentheses += 1;
        else if (part.text === ')') { if (parentheses === 0) return false; parentheses -= 1; }
        else if (part.text === ';') return false;
      } else if (part.kind === 'word') {
        if (part.text === 'case') cases += 1;
        else if (part.text === 'end') { if (cases === 0) return false; cases -= 1; }
        else if (part.text === delimiter && parentheses === 0 && cases === 0) {
          index = part.end; complete = true; break;
        }
      }
    }
    if (!complete) return false;
  }
}

function assertLiteralExecute(sql, start) {
  const refuse = () => { throw new Error('Unsupported non-literal DO/EXECUTE command that may assemble function DDL in function inventory'); };
  let index = start;
  while (SQL_SPACE.test(sql[index] ?? '')) index += 1;
  if (/^(?:[eE]'|[uU]&')/.test(sql.slice(index, index + 3))) {
    throw new Error('Unsupported encoded DO/EXECUTE body may contain a function DROP');
  }
  const literal = plainLiteral(sql, index);
  if (!literal) refuse();
  index = literal.end;
  while (SQL_SPACE.test(sql[index] ?? '')) index += 1;
  // The end of the scanned text is no terminator: a DO body split into
  // adjacent literals ends one fragment right after an EXECUTE literal.
  if (sql[index] !== ';' && !/^(?:using|into|loop)\b/i.test(sql.slice(index))) refuse();
}

// Mask comments and quoted spans without shifting offsets. A quoted token
// retains one placeholder so a quoted argument type still counts as an argument.
// Anonymous DO drops need execution knowledge; refuse those instead of silently
// treating executable code as an inert stored function body.
function topLevelSql(sql, { declarations = false, procedural = false, strictExecute = false, strict = false } = {}) {
  const chunks = [];
  const dollarQuote = /\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/y;
  const identifierCharacter = /[A-Za-z0-9_$\u0080-\uffff]/;
  let index = 0; let retained = 0; let statementStart = 0; let statementKeyword = null; let execute = null;
  let indirectExecute = false; let unscannedFunctionDdl = false;
  const unscannedLiterals = [];
  const functionDdl = /\b(?:create\s+(?:or\s+replace\s+)?|drop\s+)function\b/i;
  while (index < sql.length) {
    let end; let quoted = false; let body; let bodyStart; let dollarBody = false; let literal; let encoded = false;
    const commandLiteral = execute && !execute.data && !execute.literalSeen && execute.literalCommand;
    // In DO, LANGUAGE takes exactly one argument, a name or a literal; any
    // other literal is the code (#5710 6332873056: DO LANGUAGE 'plpgsql' $$...$$).
    // LANGUAGE is not reserved, so in DO LANGUAGE language $$...$$ the second
    // word is the argument and the literal is the code (#5823 round 1, Sol).
    const doLanguage = () => {
      if (statementKeyword !== 'do') return false;
      const masked = (chunks.join('') + sql.slice(retained, index)).slice(statementStart);
      const tokens = masked.match(/[A-Za-z_\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff]*|[^ \t\n\r\f\v]/g) ?? [];
      let argumentPending = false;
      for (const token of tokens.slice(tokens.findIndex(word => word.toLowerCase() === 'do') + 1)) {
        argumentPending = !argumentPending && token.toLowerCase() === 'language';
      }
      return argumentPending;
    };
    if (sql.startsWith('--', index)) {
      end = index + 2;
      while (end < sql.length && sql[end] !== '\n' && sql[end] !== '\r') end += 1;
    } else if (sql.startsWith('/*', index)) {
      let depth = 1;
      end = index + 2;
      while (end < sql.length && depth > 0) {
        if (sql.startsWith('/*', end)) { depth += 1; end += 2; }
        else if (sql.startsWith('*/', end)) { depth -= 1; end += 2; }
        else end += 1;
      }
      if (depth) throw new Error('Unterminated SQL comment in function inventory');
    } else if (sql[index] === "'" || sql[index] === '"') {
      quoted = true;
      const quote = sql[index];
      const escapes = quote === "'" && /[eE]/.test(sql[index - 1] ?? '')
        && (index < 2 || !identifierCharacter.test(sql[index - 2]));
      const unicode = quote === "'" && sql[index - 1] === '&' && /[uU]/.test(sql[index - 2] ?? '')
        && (index < 3 || !identifierCharacter.test(sql[index - 3]));
      let closed = false;
      end = index + 1;
      while (end < sql.length) {
        if (escapes && sql[end] === '\\') { end += 2; continue; }
        if (sql[end] === quote) {
          if (sql[end + 1] === quote) { end += 2; continue; }
          end += 1; closed = true; break;
        }
        end += 1;
      }
      if (!closed) throw new Error('Unterminated SQL quote in function inventory');
      if (quote === "'") {
        literal = sql.slice(index + 1, end - 1).replace(/''/g, "'");
        encoded = escapes || unicode;
        if ((statementKeyword === 'do' && !doLanguage()) || commandLiteral) {
          if (encoded) throw new Error('Unsupported encoded DO/EXECUTE body may contain a function DROP');
          body = literal;
        }
      } else if (commandLiteral) {
        execute.literalCommand = false; indirectExecute = true;
      }
    } else if (sql[index] === '$' && (index === 0 || !identifierCharacter.test(sql[index - 1]))) {
      dollarQuote.lastIndex = index;
      const delimiter = dollarQuote.exec(sql)?.[0];
      if (delimiter) {
        quoted = true;
        const closing = sql.indexOf(delimiter, index + delimiter.length);
        if (closing < 0) throw new Error('Unterminated SQL dollar quote in function inventory');
        end = closing + delimiter.length;
        literal = sql.slice(index + delimiter.length, closing);
        if ((statementKeyword === 'do' && !doLanguage()) || commandLiteral) {
          bodyStart = index + delimiter.length;
          body = literal; dollarBody = true;
        }
      }
    }
    if (end === undefined) {
      if (sql[index] === ';') { statementStart = index + 1; statementKeyword = null; execute = null; }
      else if (execute && sql[index] === '(') {
        execute.depth += 1;
        if (execute.format && execute.formatDepth === null) execute.formatDepth = execute.depth;
      } else if (execute && sql[index] === ')') {
        execute.depth -= 1;
        if (execute.formatDepth !== null && execute.depth < execute.formatDepth) execute.format = false;
      } else if (/[A-Za-z_\u0080-\uffff]/.test(sql[index]) && (index === 0 || !identifierCharacter.test(sql[index - 1]))) {
        let wordEnd = index + 1;
        while (wordEnd < sql.length && identifierCharacter.test(sql[wordEnd])) wordEnd += 1;
        const word = sql.slice(index, wordEnd).toLowerCase();
        if (statementKeyword === null) statementKeyword = word;
        if (procedural && word === 'execute' && sql[index - 1] !== '.') {
          const prefix = (chunks.join('') + sql.slice(retained, index)).slice(statementStart);
          // Strict mode needs both sides of the keyword. GRANT or REVOKE
          // EXECUTE ON is static only when the word before EXECUTE is GRANT,
          // REVOKE or FOR (REVOKE GRANT OPTION FOR) and a routine object follows;
          // ON is unreserved, so a variable may be named on. A trigger's EXECUTE
          // FUNCTION|PROCEDURE name( is static only inside CREATE ... TRIGGER,
          // after ROW, STATEMENT, an event name or WHEN's ), since a variable
          // named function can be followed by OPERATOR(...). A GRANT or REVOKE
          // token elsewhere (SELECT 1 AS grant) proves nothing.
          // The words after EXECUTE are read past comments, and a routine name
          // may be quoted or spaced (#5710 6332873056); the prefix is masked.
          const before = /(\w+|\))[ \t\n\r\f\v]*$/.exec(prefix)?.[1].toLowerCase();
          const staticExecute = strict
            ? (['grant', 'revoke', 'for'].includes(before) && routineObjectFollows(sql, wordEnd))
              || ((startsTriggerStatement(prefix)
                || (/\bcreate\s+(?:or\s+replace\s+)?(?:constraint\s+|event\s+)?trigger\b/i.test(prefix)
                  && /^(?:row|statement|ddl_command_start|ddl_command_end|table_rewrite|sql_drop|login|\))$/.test(before ?? '')))
                && triggerFunctionFollows(sql, wordEnd))
            : /\b(?:grant|revoke)\b/i.test(prefix)
              || /\bcreate\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\b/i.test(prefix);
          if (!staticExecute && strict) assertLiteralExecute(sql, wordEnd);
          if (!staticExecute) execute = { literalSeen: false, literalCommand: true, format: false, formatDepth: null, depth: 0, unsafeFormat: false, data: false };
        } else if (execute) {
          if (word === 'using' || word === 'into') execute.data = true;
          else if (!execute.data && !execute.literalSeen) {
            if (word === 'format' && /^\s*\(/.test(sql.slice(wordEnd))) execute.format = true;
            else if (!(word === 'pg_catalog' && /^\s*\.\s*format\s*\(/i.test(sql.slice(wordEnd)))
              && !(word === 'e' && sql[wordEnd] === "'") && !(word === 'u' && sql.slice(wordEnd, wordEnd + 2) === "&'")) {
              execute.literalCommand = false; indirectExecute = true;
            }
          } else if (!execute.data && !execute.format) indirectExecute = true;
        }
      }
      index += 1; continue;
    }
    if (procedural && literal !== undefined) {
      // Data can be copied into a later EXECUTE variable. Keep its literal
      // fragments as refusal evidence without recursively executing that data.
      if (body === undefined) unscannedLiterals.push(literal);
      if (encoded || (/\b(?:create|drop)\b/i.test(literal) && /\bfunction\b/i.test(literal))) unscannedFunctionDdl = true;
      if (commandLiteral) {
        execute.literalSeen = true;
        if (execute.format) {
          execute.unsafeFormat = /%(?:\d+\$)?[-\d*]*s/.test(literal.replace(/%%/g, ''));
          if (execute.unsafeFormat) indirectExecute = true;
          // Raw substitutions can complete any part of a DDL keyword. Refuse
          // unknown command shapes, retaining fixed non-function commands.
          const command = literal.trim().replace(/;$/, '');
          const fixedCommand = !command.includes(';') && /^\s*(?:(?:select|with|insert|update|delete|merge|grant|revoke|alter|comment|truncate|refresh)\b|(?:create\s+(?:or\s+replace\s+)?(?:unique\s+)?|drop\s+)(?:table|index|trigger|policy|schema|sequence|view|type|extension)\b)/i.test(command);
          if (execute.unsafeFormat && !fixedCommand) unscannedFunctionDdl = true;
          if (functionDdl.test(literal)) throw new Error('Unsupported formatted DO/EXECUTE function DDL (DROP/CREATE) in function inventory');
        }
      } else if (execute && !execute.data && !execute.format) indirectExecute = true;
    }
    if (body !== undefined) {
      // PostgreSQL joins newline-separated string constants into one DO body,
      // even across -- comment lines, and no per-fragment scan sees it whole.
      // Refuse the split instead.
      if (strictExecute && statementKeyword === 'do' && /['$]/.test(sql[skipSqlSpace(sql, end)] ?? '')) {
        throw new Error('Unsupported split DO body may assemble function DDL in function inventory');
      }
      const doBody = statementKeyword === 'do';
      const code = topLevelSql(body, {
        declarations, procedural: doBody, strictExecute,
        strict: strictExecute && doBody
          && !reviewedDynamicExecuteBodies.has(createHash('sha256').update(body).digest('hex')),
      });
      if (!declarations && /\bdrop\s+function\b/i.test(code)) {
        throw new Error('Unsupported executable DO function DROP in function inventory');
      }
      if (declarations && !dollarBody && /\bcreate\s+(?:or\s+replace\s+)?function\b/i.test(code)) {
        throw new Error('Unsupported quoted executable function declaration in function inventory');
      }
      if (declarations && dollarBody) {
        chunks.push(sql.slice(retained, index), ' '.repeat(bodyStart - index), code, ' '.repeat(end - bodyStart - body.length));
        index = end; retained = end; continue;
      }
    }
    const masked = sql.slice(index, end).replace(/[^\r\n]/g, ' ');
    chunks.push(sql.slice(retained, index), quoted ? '?' + masked.slice(1) : masked);
    index = end; retained = end;
  }
  // Join fragments for split keywords and adjacent/concatenated strings. An
  // unscanned function reference is conservatively unsupported when it can
  // reach indirect execution, including through USING or format data.
  const unscannedFunctionReference = /\bfunction\b/i.test(unscannedLiterals.join(''))
    || /\bfunction\b/i.test(unscannedLiterals.join(' '));
  if (procedural && indirectExecute && (unscannedFunctionDdl || unscannedFunctionReference)) {
    throw new Error('Unsupported indirect DO/EXECUTE function DDL in function inventory');
  }
  return chunks.join('') + sql.slice(retained);
}

export function readMigrationFunctions(directory) {
  const files = readdirSync(directory).filter(f => f.endsWith('.sql')).sort();
  const functions = []; const lastDrop = new Map();
  for (const file of files) {
    const sql = readFileSync(`${directory}/${file}`, 'utf8');
    functions.push(...parseFunctions(sql, file, { strictExecute: true }));
    const executable = topLevelSql(sql, { strictExecute: true });
    for (const m of executable.matchAll(/^\s*drop\s+function\s+(?:if\s+exists\s+)?([\w.]+)\s*\(/gim)) lastDrop.set(`${m[1].toLowerCase()}/${argumentCount(executable, m.index + m[0].length)}`, { file, offset: m.index });
  }
  const latest = new Map();
  for (const f of functions) {
    const key = `${f.name}/${f.arity}`;
    const previous = latest.get(key);
    if (!previous || f.file > previous.file || (f.file === previous.file && f.offset > previous.offset)) latest.set(key, f);
  }
  const active = [...latest.values()].filter(f => {
    const drop = lastDrop.get(`${f.name}/${f.arity}`);
    return !drop || f.file > drop.file || (f.file === drop.file && f.offset > drop.offset);
  });
  active.historical = functions;
  return active;
}

export function codeOnly(source) {
  return stripSqlComments(source).toLowerCase();
}
export const reviewedGraph = JSON.parse(readFileSync(new URL('./account-case-graph-review.json', import.meta.url), 'utf8'));
export const reviewedReadAdmission = JSON.parse(readFileSync(new URL('./lifecycle-read-admission-review.json', import.meta.url), 'utf8'));
// These bounded read/audit paths use the same global gates in shared mode.
// A new or changed body cannot inherit this exception by calling the helper.
export function sharedReadEntry(fn) {
  const review = reviewedReadAdmission[fn?.name];
  return Boolean(review?.reason?.trim() && typeof fn.source === 'string'
    && createHash('sha256').update(fn.source).digest('hex') === review.source_sha256);
}
// A reviewed writer that only reads before its first graph gate. The exact
// installed source is pinned, so any edit fails closed.
export function reviewedPreGateRead(fn) {
  const review = reviewedGraph.pre_gate_reads?.[fn?.name];
  return Boolean(review?.reason?.trim() && typeof fn.source === 'string'
    && createHash('sha256').update(fn.source).digest('hex') === review.source_sha256);
}
export const reviewedForeignKeys = JSON.parse(readFileSync(new URL('./account-case-graph-fks.json', import.meta.url), 'utf8'));
export const authBookkeepingExemptions = reviewedGraph.auth_bookkeeping_exemptions;
export const authBookkeepingChildTables = authBookkeepingExemptions.child_tables.map(entry => entry.table);
export const authUserCoveredColumns = authBookkeepingExemptions.covered_user_columns;
const authBookkeepingChildTableSet = new Set(authBookkeepingChildTables);
const authBookkeepingRelation = 'auth\\.(?:users|sessions|refresh_tokens|one_time_tokens|mfa_amr_claims|mfa_challenges|identities|oauth_clients)';
const authBookkeepingDml = new RegExp(`\\b(?:insert\\s+into|update|delete\\s+from|merge\\s+into)\\s+(${authBookkeepingRelation})\\b`, 'g');
const authBookkeepingFrom = new RegExp(`\\bfrom\\s+(${authBookkeepingRelation})\\b`, 'g');
function sqlParenthesisDepth(source, end) {
  let depth = 0; let quote = false;
  for (let index = 0; index < end; index += 1) {
    if (source[index] === "'") {
      if (quote && source[index + 1] === "'") { index += 1; continue; }
      quote = !quote;
    } else if (!quote && source[index] === '(') depth += 1;
    else if (!quote && source[index] === ')') depth -= 1;
  }
  return depth;
}
export function authBookkeepingWriterTargets(source) {
  return [...new Set([...codeOnly(source).matchAll(authBookkeepingDml)].map(match => match[1]))].sort();
}
// Every Auth access that can hold a tuple, in source order: the writes, and the
// reads that take a row lock. A locked read owns the tuple exactly as a write
// does, so it must not be allowed to precede the covered users statement that
// establishes gate-then-exclusive order for the transaction.
export function authBookkeepingAccessSequence(source) {
  const code = codeOnly(source);
  const accesses = [...code.matchAll(authBookkeepingDml)]
    .map(match => ({ index: match.index, table: match[1], text: match[0], locked: false }));
  for (const from of code.matchAll(authBookkeepingFrom)) {
    const statementEnd = code.indexOf(';', from.index);
    const tail = code.slice(from.index + from[0].length, statementEnd < 0 ? code.length : statementEnd);
    const lock = /\bfor\s+(?:no\s+key\s+update|key\s+share|update|share)\b/.exec(tail);
    if (lock && sqlParenthesisDepth(code, from.index) === sqlParenthesisDepth(code, from.index + from[0].length + lock.index)
      // `delete from auth.x` also matches the FROM form; the DML entry above
      // already represents that statement at its own earlier offset.
      && !accesses.some(access => access.index <= from.index && from.index < access.index + access.text.length)) {
      accesses.push({ index: from.index, table: from[1], text: from[0], locked: true });
    }
  }
  return accesses.sort((first, second) => first.index - second.index);
}
export function authBookkeepingAccessTargets(source) {
  return [...new Set(authBookkeepingAccessSequence(source).map(access => access.table))].sort();
}
export function authBookkeepingExclusiveAfterGate(source) {
  const code = codeOnly(source);
  return /^\s*(?:#[^\n]+\n\s*)?begin\s+perform\s+private\.lock_case_graph\(array\[auth\.uid\(\)\],\s*array\[\]::uuid\[\]\);\s+perform\s+pg_catalog\.pg_advisory_xact_lock\(509,\s*701\);/i.test(code);
}
// The FIRST Auth access that can hold a tuple — not merely the first Auth DML —
// must be the covered auth.users INSERT/DELETE whose a00 statement trigger takes
// the graph gate and then the exclusive bookkeeping lock. A `select ... from
// auth.identities for update` placed ahead of the users insert would otherwise
// hold an Auth tuple without (509, 701).
export function authBookkeepingCoveredUsersFirst(source) {
  const first = authBookkeepingAccessSequence(source)[0];
  return first?.table === 'auth.users' && !first.locked
    && /^(?:insert\s+into|delete\s+from)\s+auth\.users\b/.test(first.text);
}
export function authBookkeepingFunctionIssues(functions, reviews = authBookkeepingExemptions.reviewed_gated_auth_functions) {
  const issues = [];
  const participating = functions.filter(fn => authBookkeepingAccessTargets(fn.source).length > 0);
  for (const fn of participating) {
    const review = reviews[fn.name];
    if (!review) { issues.push(`unreviewed gated Auth bookkeeping function: ${fn.name}`); continue; }
    if (JSON.stringify(authBookkeepingAccessTargets(fn.source)) !== JSON.stringify([...review.tables].sort())) {
      issues.push(`gated Auth bookkeeping targets changed: ${fn.name}`);
    }
    if (!helperFirst(fn.source)) issues.push(`gated Auth bookkeeping function lacks graph gate: ${fn.name}`);
    if (review.mode === 'explicit-exclusive' && !authBookkeepingExclusiveAfterGate(fn.source)) {
      issues.push(`gated Auth bookkeeping function lacks immediate exclusive lock: ${fn.name}`);
    } else if (review.mode === 'covered-users-first' && !authBookkeepingCoveredUsersFirst(fn.source)) {
      issues.push(`gated Auth bookkeeping function no longer enters covered auth.users first: ${fn.name}`);
    } else if (!['explicit-exclusive', 'covered-users-first'].includes(review.mode)) {
      issues.push(`unknown gated Auth bookkeeping mode: ${fn.name}`);
    }
  }
  for (const name of Object.keys(reviews)) {
    if (!participating.some(fn => fn.name === name)) issues.push(`unused gated Auth bookkeeping review: ${name}`);
  }
  return issues;
}
export function expectedAuthUsersTriggerDefinition(name, functionName, each) {
  const argumentsSql = functionName === 'private.lock_case_graph_row_keys' ? "('id', '')" : '()';
  return `CREATE TRIGGER ${name} BEFORE INSERT OR DELETE OR UPDATE OF ${authUserCoveredColumns.join(', ')} ON auth.users FOR EACH ${each} EXECUTE FUNCTION ${functionName}${argumentsSql}`;
}
export function deriveRelations(foreignKeys, seeds = reviewedGraph.seeds) {
  const tables = new Set(seeds);
  for (let previous = -1; previous !== tables.size;) {
    previous = tables.size;
    for (const fk of foreignKeys) if (tables.has(fk.parent)) tables.add(fk.child);
  }
  return [...tables].sort();
}
export function migrationDigest(directory) {
  const hash = createHash('sha256');
  for (const file of readdirSync(directory).filter(f => f.endsWith('.sql')).sort()) {
    hash.update(file + '\0'); hash.update(readFileSync(`${directory}/${file}`));
  }
  return hash.digest('hex');
}
// Which migrations can change the foreign-key catalogue captured in
// account-case-graph-fks.json. The file used to pin migrationDigest() over
// EVERY migration, so every migration PR in the repository had to re-capture
// and rewrite the same line and every one of them conflicted with every other.
// The pin now covers only migrations whose executable SQL can add, remove,
// rename or retype a foreign key or the tables and columns it joins:
//   - REFERENCES / FOREIGN KEY, PARTITION OF / INHERITS, SET SCHEMA, RENAME,
//     ALTER COLUMN ... TYPE, DROP COLUMN, DROP SCHEMA  (always)
//   - DROP CONSTRAINT <name>  when <name> is a captured foreign key
//   - DROP TABLE <name>       when <name> is a child or parent of one
// A migration outside this set cannot change the catalogue, so it no longer
// touches the inventory. The live twin is proveCaseGraphInventory(), which
// the required DB proof lane runs against the fully migrated disposable
// database and which compares the whole catalogue exactly.
const fkAlways = /\breferences\b|\bforeign\s+key\b|\bpartition\s+of\b|\binherits\b|\bset\s+schema\b|\brename\b|\balter\s+column\b[^;]*?\btype\b|\bdrop\s+column\b|\bdrop\s+schema\b/;
const fkIdent = '(?:[a-z_][a-z0-9_$]*\\.)?([a-z_][a-z0-9_$]*)';
const fkDropConstraint = new RegExp(`\\bdrop\\s+constraint\\s+(?:if\\s+exists\\s+)?${fkIdent}`, 'g');
const fkDropTable = new RegExp(`\\bdrop\\s+table\\s+(?:if\\s+exists\\s+)?((?:${fkIdent}\\s*,\\s*)*${fkIdent})`, 'g');
export function foreignKeyRelevance(sql, foreignKeys = reviewedForeignKeys.foreign_keys) {
  const code = stripSqlComments(sql).toLowerCase().replace(/"/g, '');
  const always = code.match(fkAlways);
  if (always) return always[0].replace(/\s+/g, ' ');
  const names = new Set(foreignKeys.map(fk => fk.name.toLowerCase()));
  for (const match of code.matchAll(fkDropConstraint)) if (names.has(match[1])) return `drop constraint ${match[1]}`;
  const tables = new Set(foreignKeys.flatMap(fk => [fk.child, fk.parent]).map(name => name.toLowerCase().split('.').pop()));
  for (const match of code.matchAll(fkDropTable)) {
    for (const table of match[1].split(',').map(part => part.trim().split('.').pop())) if (tables.has(table)) return `drop table ${table}`;
  }
  return null;
}
export function foreignKeyRelevantMigrations(directory, foreignKeys = reviewedForeignKeys.foreign_keys) {
  return readdirSync(directory).filter(f => f.endsWith('.sql')).sort()
    .map(file => ({ file, reason: foreignKeyRelevance(readFileSync(`${directory}/${file}`, 'utf8'), foreignKeys) }))
    .filter(entry => entry.reason);
}
export function foreignKeyMigrationDigest(directory, foreignKeys = reviewedForeignKeys.foreign_keys) {
  const hash = createHash('sha256');
  for (const { file } of foreignKeyRelevantMigrations(directory, foreignKeys)) {
    hash.update(file + '\0'); hash.update(readFileSync(`${directory}/${file}`));
  }
  return hash.digest('hex');
}
const derivedTables = new Set(deriveRelations(reviewedForeignKeys.foreign_keys));
export const graphRelation = { test: name => derivedTables.has(name) };
// columns/parent_columns are Postgres `name[]` (OID 1003). node-postgres has
// no parser for that type and returns the raw array text ("{user_id}"), which
// is what account-case-graph-fks.json stores and what referenceColumns()
// treats as one atomic key. Every captured row goes through
// normalizeForeignKeyRow(), so a text[] cast or a parsed array (["user_id"])
// yields the same stable text instead of a spurious catalogue change.
export const foreignKeyCatalogueSql = `select distinct ns.nspname||'.'||t.relname child, pn.nspname||'.'||pt.relname parent,
 c.conname name, array(select a.attname from unnest(c.conkey) with ordinality k(id,ord) join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.id order by ord) columns,
 array(select a.attname from unnest(c.confkey) with ordinality k(id,ord) join pg_attribute a on a.attrelid=c.confrelid and a.attnum=k.id order by ord) parent_columns,
 rc.delete_rule, rc.update_rule from information_schema.referential_constraints rc
 join pg_namespace ns on ns.nspname=rc.constraint_schema join pg_constraint c on c.connamespace=ns.oid and c.conname=rc.constraint_name and c.contype='f'
 join pg_class t on t.oid=c.conrelid join pg_class pt on pt.oid=c.confrelid join pg_namespace pn on pn.oid=pt.relnamespace
 order by child,name,parent`;
const pgArrayElement = value => (value === '' || /^null$/i.test(value) || /[{}",\\\s]/.test(value)
  ? `"${value.replace(/["\\]/g, '\\$&')}"` : value);
export function normalizeForeignKeyRow(row) {
  const text = value => Array.isArray(value) ? `{${value.map(v => pgArrayElement(String(v))).join(',')}}` : value;
  return { ...row, columns: text(row.columns), parent_columns: text(row.parent_columns) };
}
export function referenceColumns(foreignKeys, table, parent) {
  return [...new Set(foreignKeys.filter(f => f.child === table && f.parent === parent)
    .flatMap(f => f.columns).concat(table === parent ? ['id'] : []))].sort().join(',');
}
// A reviewed membership-bound column carries an Auth identity through a
// composite FK whose parent column itself references auth.users(id), so the
// row-key gate must lock it with the direct Auth columns. Each entry is pinned
// to its FK and fails closed when that FK no longer resolves to an Auth column.
export function rowKeyAuthColumns(foreignKeys, table) {
  const direct = referenceColumns(foreignKeys, table, 'auth.users');
  const reviewed = reviewedGraph.membership_identity_row_keys?.[table];
  if (!reviewed) return direct;
  const list = value => Array.isArray(value) ? value : String(value).replace(/^\{|\}$/g, '').split(',');
  const fk = foreignKeys.find(f => f.child === table && f.name === reviewed.foreign_key);
  const bound = fk && reviewed.reason?.trim() && reviewed.columns.length > 0 && reviewed.columns.every(column => {
    const parentColumn = list(fk.parent_columns)[list(fk.columns).indexOf(column)];
    return parentColumn !== undefined && foreignKeys.some(g => g.child === fk.parent && g.parent === 'auth.users'
      && list(g.columns).join() === parentColumn && list(g.parent_columns).join() === 'id');
  });
  if (!bound) throw new Error(`Reviewed membership identity row key unbound: ${table}`);
  const keys = foreignKeys.filter(f => f.child === table && f.parent === 'auth.users').map(f => f.columns);
  return [...new Set([...keys, ...reviewed.columns.map(column => `{${column}}`)])].sort().join(',');
}
// These relations were repaired to bare column names (#6155) and must keep
// them; the others carry the catalogue's brace-wrapped column lists.
export const plainRowKeyTables = ['auth.mfa_recovery_code_sets', 'auth.scim_users'];
export function rowKeyArguments(foreignKeys, table) {
  const auth = rowKeyAuthColumns(foreignKeys, table);
  const cases = referenceColumns(foreignKeys, table, 'public.member_cases');
  const plain = columns => columns.replace(/[{}]/g, '');
  return plainRowKeyTables.includes(table) ? [plain(auth), plain(cases)] : [auth, cases];
}
// The columns private.lock_case_graph_row_keys locks for one trigger argument
// since #6356: a bare name, or the first column of each braced foreign-key list
// (the column that references the parent's id). Mirrors the helper's regexp.
export function rowKeyColumns(argument) {
  return [...String(argument).matchAll(/\{([^,{}]+)[^{}]*\}|([^,{}]+)/g)].map(match => match[1] ?? match[2]);
}
// A row-key gate is credited only when every decoded column holds the parent's
// id: a direct auth.users(id) or member_cases(id) foreign-key column, or a
// reviewed membership-bound Auth column. A brace-wrapped argument the helper
// cannot resolve to such a column locks nothing and fails here (#6356).
export function rowKeyArgumentIssues(foreignKeys, table) {
  const list = value => String(value).replace(/^\{|\}$/g, '').split(',');
  const idColumns = parent => foreignKeys.filter(f => f.child === table && f.parent === parent)
    .map(f => list(f.columns)[list(f.parent_columns).indexOf('id')]).filter(Boolean)
    .concat(table === parent ? ['id'] : []);
  const reviewed = reviewedGraph.membership_identity_row_keys?.[table]?.columns ?? [];
  const [auth, cases] = rowKeyArguments(foreignKeys, table);
  const issues = [];
  for (const [argument, allowed] of [[auth, [...idColumns('auth.users'), ...reviewed]], [cases, idColumns('public.member_cases')]]) {
    const columns = rowKeyColumns(argument);
    if (argument !== '' && columns.length === 0) issues.push(`row-key argument resolves to no column: ${table} '${argument}'`);
    for (const column of columns) {
      if (!allowed.includes(column)) issues.push(`row-key argument column is not a parent id column: ${table}.${column}`);
    }
  }
  return issues;
}
export const acquisition = /\bfor\s+(?:no\s+key\s+update|key\s+share|update|share)\b|\block\s+(?:table\s+)?|\bpg_(?:try_)?advisory_\w+\s*\(/;
export function graphWriter(source, relations = derivedTables) {
  const code = codeOnly(source);
  return [...code.matchAll(/\b(?:insert\s+into|update|delete\s+from|merge\s+into)\s+([\w.]+)/g)].some(m => relations.has(m[1]));
}
function withoutReviewedPureInitializer(source) {
  const review = reviewedGraph.pure_initializers?.['public.grant_free_cosmetic'];
  if (!review?.reason?.trim() || createHash('sha256').update(source).digest('hex') !== review.source_sha256) return source;
  // Admit this exact input-only expression, never a general class of calls.
  // The full body pin and declaration shape both fail closed on any change.
  return source.replace(/^(\s*declare org uuid; award uuid; reason text) := btrim\(coalesce\(p_reason,''\)\);(?=\s*begin\b)/,
    '$1;');
}

export function helperFirst(source) {
  let code = codeOnly(withoutReviewedPureInitializer(source));
  // Body assignments before a nested BEGIN are not declaration initializers.
  // Bound this check to the first block entry, as the static inventory does.
  const declarations = /^\s*declare\b([\s\S]*?)\bbegin\b/.exec(code);
  if (declarations && !/(?::=|\bdefault\b)/.test(declarations[1])) {
    code = 'begin' + code.slice(declarations[0].length);
  }
  return /^\s*(?:#[^\n]+\n\s*)?begin\s+perform\s+private\.lock_case_graph\(/i.test(code);
}

export function inventoryIssues(functions, wrapperSql, exceptions, foreignKeys = reviewedForeignKeys.foreign_keys, sourceTransformations = []) {
  const relations = new Set(deriveRelations(foreignKeys));
  const graphRelation = { test: name => relations.has(name) };
  const writes = source => graphWriter(source, relations);
  const wrapped = new Map([...wrapperSql.matchAll(/\('([\w.]+)\([^'\n]*\)', '([a-f0-9]{64})'\)/g)].map(m => [m[1], m[2]]));
  const authenticatedSources = new Map((functions.historical || functions).map(f => [`${f.name}/${f.sourceSha256}`, f.source]));
  for (const source of [...(reviewedGraph.transformed_sources || []), ...(reviewedGraph.historical_transformed_sources || [])]) {
    if (typeof source.source !== 'string') continue;
    const digest = createHash('sha256').update(source.source).digest('hex');
    if (digest === source.source_sha256) authenticatedSources.set(`${source.name}/${digest}`, source.source);
  }
  for (const transform of sourceTransformations) {
    const sourceEntry = [...authenticatedSources.entries()].find(([key]) => key.startsWith(`${transform.name}/`)
      && (!transform.sourceSha256 || key === `${transform.name}/${transform.sourceSha256}`));
    if (sourceEntry) {
      const result = transform.resultSource(sourceEntry[1]);
      authenticatedSources.set(`${transform.name}/${createHash('sha256').update(result).digest('hex')}`, result);
    }
  }
  const issues = [];
  if (!/wrapped := directive \|\| \$\w*\$\s*begin\s+perform private\.lock_case_graph\(array\[auth\.uid\(\)\], array\[\]::uuid\[\]\);/m.test(wrapperSql)) issues.push('wrapper must acquire before original declarations');
  for (const [name, hash] of wrapped) {
    const sourceNames = [name, reviewedGraph.aliases[name]].filter(Boolean);
    if (!sourceNames.some(sourceName => authenticatedSources.has(`${sourceName}/${hash}`))) issues.push(`unmatched wrapper source: ${name}`);
  }
  for (const table of reviewedGraph.tables) {
    if (table !== 'private.mi1_w2_operation_receipts' && !authBookkeepingChildTableSet.has(table)) {
      issues.push(...rowKeyArgumentIssues(foreignKeys, table));
    }
  }
  const latest = new Map(functions.map(f => [f.name, f]));
  for (const name of Object.keys(reviewedReadAdmission)) {
    if (!sharedReadEntry(latest.get(name))) issues.push(`shared read admission changed: ${name}`);
  }
  const scope = [...latest.values()].filter(f => /casework|account_lifecycle_manifest|account_deletion_finalization|20260826151000|civic_privacy_export_deletion/.test(f.file)
    // A reviewed exception stays pinned to its latest definition wherever it is re-emitted.
    || Object.hasOwn(exceptions, f.name) || wrapped.has(f.name) || writes(f.source)
    || (acquisition.test(codeOnly(f.source)) && [...codeOnly(f.source).matchAll(/\b(?:public|private|auth)\.[\w]+/g)].some(m => graphRelation.test(m[0]))));
  const participating = new Set(scope.filter(f => wrapped.has(f.name) || writes(f.source)).map(f => f.name));
  for (let previous = -1; previous !== participating.size;) {
    previous = participating.size;
    for (const f of latest.values()) if ([...codeOnly(f.source).matchAll(/\b([\w]+\.[\w]+)\s*\(/g)].some(m => participating.has(m[1]))) {
      participating.add(f.name);
      if (!scope.includes(f)) scope.push(f);
    }
  }
  for (const f of scope) {
    if (f.name === 'private.lock_case_graph') continue;
    if (sharedReadEntry(f) || reviewedPreGateRead(f)) continue;
    const reason = exceptions[f.name];
    if (reason) {
      if (reason.source_sha256 !== f.sourceSha256 || !reason.reason?.trim()) issues.push(`reviewed exception changed: ${f.name}`);
      if (participating.has(f.name)) issues.push(`writer cannot be excluded: ${f.name}`);
      continue;
    }
    const code = codeOnly(withoutReviewedPureInitializer(f.source));
    if (wrapped.has(f.name) && !authenticatedSources.has(`${f.name}/${wrapped.get(f.name)}`) && !reviewedGraph.aliases[f.name]) issues.push(`wrapper source superseded: ${f.name}`);
    if (!wrapped.has(f.name)) {
      // In-place functions have declarations without evaluated initializers;
      // calls must still precede every row acquisition, DML and permission read.
      const body = code.replace(/^\s*declare\b[\s\S]*?\bbegin\b/, 'begin');
      if (!helperFirst(body)) issues.push(`missing first helper: ${f.name}`);
      const declarations = /^\s*declare\b([\s\S]*?)\bbegin\b/.exec(code)?.[1] ?? '';
      if (/(?::=|\bdefault\b)/.test(declarations)) issues.push(`initializer precedes helper: ${f.name}`);
    }
  }
  for (const name of Object.keys(exceptions)) if (!scope.some(f => f.name === name)) issues.push(`unused reviewed exception: ${name}`);
  return issues;
}

export function caseGraphWrappedSource(source) {
  const directive = source.match(/^\s*#[^\n]+\n/)?.[0] || '';
  const inner = source.slice(directive.length).replace(/[\n\r\t ]+$/, '');
  return `${directive}\nbegin\n  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);\n${inner}${inner.endsWith(';') ? '' : ';'}\nend;\n`;
}

export async function deriveTransformedSources(client) {
  const sources = [];
  for (const entry of reviewedGraph.transformed_sources || []) {
    const { rows } = await client.query(`select p.prosrc source from pg_proc p
      join pg_namespace n on n.oid=p.pronamespace where n.nspname||'.'||p.proname=$1`, [entry.name]);
    if (rows.length !== 1) throw new Error(`Ambiguous transformed source: ${entry.name}`);
    const installed = rows[0].source;
    const prefix = '\nbegin\n  perform private.lock_case_graph(array[auth.uid()], array[]::uuid[]);\n';
    const directive = installed.match(/^\s*#[^\n]+\n/)?.[0] || '';
    const body = installed.slice(directive.length);
    if (!body.startsWith(prefix) || !body.endsWith('\nend;\n')) throw new Error(`Transformed wrapper changed: ${entry.name}`);
    const inner = body.slice(prefix.length, -'\nend;\n'.length);
    // The wrapper trims trailing whitespace and may add a semicolon.
    const candidates = [inner, inner.replace(/;$/, '')].flatMap(source =>
      ['', '\n', '\n\n', ' ', '\r\n'].map(tail => directive + source + tail));
    const source = candidates.find(candidate => createHash('sha256').update(candidate).digest('hex') === entry.source_sha256
      && caseGraphWrappedSource(candidate) === installed);
    if (source === undefined) throw new Error(`Installed transformed source drift: ${entry.name}`);
    sources.push({ ...entry, source, source_sha256: createHash('sha256').update(source).digest('hex') });
  }
  return sources;
}

export async function proveCaseGraphInventory(client) {
  const derived = await deriveTransformedSources(client);
  if (JSON.stringify(derived) !== JSON.stringify(reviewedGraph.transformed_sources)) throw new Error('Replay-derived transformed source catalogue changed');
  const foreignKeys = (await client.query(foreignKeyCatalogueSql)).rows.map(normalizeForeignKeyRow);
  if (JSON.stringify(foreignKeys) !== JSON.stringify(reviewedForeignKeys.foreign_keys)) throw new Error('Implicit FK acquisition catalogue changed');
  if (JSON.stringify(deriveRelations(foreignKeys)) !== JSON.stringify(reviewedGraph.tables)) throw new Error('Implicit FK relation closure changed');
  const functions = (await client.query(`select n.nspname || '.' || p.proname name, p.prosrc source,
    pg_catalog.encode(extensions.digest(pg_catalog.convert_to(p.prosrc, 'UTF8'), 'sha256'), 'hex') source_sha256
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','private') and p.prokind='f'
    and not exists(select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')`)).rows;
  const authFunctionIssues = authBookkeepingFunctionIssues(functions);
  if (authFunctionIssues.length) throw new Error(authFunctionIssues.join('; '));
  for (const name of Object.keys(reviewedReadAdmission)) {
    if (!sharedReadEntry(functions.find(fn => fn.name === name))) throw new Error(`Installed shared read admission changed: ${name}`);
  }
  for (const review of Object.values(authBookkeepingExemptions.reviewed_gated_auth_functions)) {
    if (!review.reason?.trim()) throw new Error('Gated Auth bookkeeping function reason is empty');
  }
  const lockFunctions = (await client.query(`select p.oid::regprocedure::text signature,
      p.prosecdef security_definer, p.proconfig,
      pg_catalog.regexp_replace(pg_catalog.lower(p.prosrc), '\\s+', ' ', 'g') body,
      pg_catalog.has_function_privilege('public', p.oid, 'execute') public_execute,
      pg_catalog.has_function_privilege('anon', p.oid, 'execute') anon_execute,
      pg_catalog.has_function_privilege('authenticated', p.oid, 'execute') authenticated_execute,
      pg_catalog.has_function_privilege('service_role', p.oid, 'execute') service_execute
    from pg_proc p where p.oid=any($1::regprocedure[]) order by 1`, [[
      'private.lock_auth_bookkeeping_exclusive()',
      'private.lock_auth_bookkeeping_shared()',
      'private.lock_case_graph_statement_auth()',
    ]])).rows;
  const expectedLockBodies = new Map([
    ['private.lock_auth_bookkeeping_exclusive()', 'begin perform pg_catalog.pg_advisory_xact_lock(509, 701); return null; end;'],
    ['private.lock_auth_bookkeeping_shared()', 'begin perform pg_catalog.pg_advisory_xact_lock_shared(509, 701); return null; end;'],
    ['private.lock_case_graph_statement_auth()', 'begin perform private.lock_case_graph(array[]::uuid[], array[]::uuid[]); perform pg_catalog.pg_advisory_xact_lock(509, 701); return null; end;'],
  ]);
  if (lockFunctions.length !== expectedLockBodies.size || lockFunctions.some(fn =>
    !fn.security_definer || JSON.stringify(fn.proconfig) !== JSON.stringify(['search_path=""'])
    || fn.public_execute || fn.anon_execute || fn.authenticated_execute || fn.service_execute
    || fn.body.trim() !== expectedLockBodies.get(fn.signature))) {
    throw new Error('Auth bookkeeping lock function changed');
  }
  const writers = new Set(functions.filter(f => graphWriter(f.source) || (!reviewedGraph.exceptions[f.name] && acquisition.test(codeOnly(f.source)) && [...codeOnly(f.source).matchAll(/\b(?:public|private|auth)\.[\w]+/g)].some(m => graphRelation.test(m[0])))).map(f => f.name));
  for (let previous = -1; previous !== writers.size;) {
    previous = writers.size;
    for (const f of functions) if ([...codeOnly(f.source).matchAll(/\b([\w]+\.[\w]+)\s*\(/g)].some(m => writers.has(m[1]))) writers.add(f.name);
  }
  for (const f of functions) {
    const exception = reviewedGraph.exceptions[f.name];
    if (exception && (exception.source_sha256 !== f.source_sha256 || graphWriter(f.source))) throw new Error(`Installed reviewed exception changed: ${f.name}`);
  }
  const missing = functions.filter(f => writers.has(f.name) && !helperFirst(f.source) && !sharedReadEntry(f) && !reviewedPreGateRead(f));
  if (missing.length) throw new Error(`Installed case graph writer lacks first gate: ${missing.map(f => f.name).join(', ')}`);
  const tables = (await client.query(`with recursive graph(oid) as (
      select unnest($1::regclass[])::oid union
      select conrelid from pg_constraint join graph on confrelid=graph.oid where contype='f'
    ) select n.nspname || '.' || c.relname name,
      exists(select 1 from pg_trigger t where t.tgrelid=c.oid and t.tgname='a00_case_graph_lock'
        and (t.tgfoid='private.lock_case_graph_statement()'::regprocedure
          or (n.nspname='auth' and c.relname='users'
            and t.tgfoid='private.lock_case_graph_statement_auth()'::regprocedure))
        and t.tgtype=30 and t.tgenabled='O') coordinated,
      (select pg_get_triggerdef(t.oid, true) from pg_trigger t
        where t.tgrelid=c.oid and t.tgname='a00_case_graph_lock' and not t.tgisinternal) definition
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where c.relkind in ('r','v') and ((n.nspname='public' and c.relname like 'casework_%')
      or c.oid in(select oid from graph) or (n.nspname='private' and c.relname in('account_lifecycle_case_scope','account_lifecycle_history_scope'))
      or (n.nspname='auth' and c.relname='users') or (n.nspname='public' and c.relname='member_profiles')
      or exists(select 1 from pg_trigger root join pg_proc fn on fn.oid=root.tgfoid
        where root.tgrelid=c.oid and not root.tgisinternal and root.tgname <> 'a00_case_graph_lock'
        and fn.prosrc like '%perform private.lock_case_graph(%'))
    order by 1`, [reviewedGraph.seeds])).rows;
  if (JSON.stringify(tables.map(t => t.name)) !== JSON.stringify(reviewedGraph.tables)
    || tables.some(table => authBookkeepingChildTableSet.has(table.name)
      ? table.coordinated || table.definition !== null
      : !table.coordinated)) {
    throw new Error('Case graph relation closure or BEFORE STATEMENT gate changed');
  }
  // Diagnosed separately from the closure: the column-scoped auth.users gate is
  // the narrowing this protocol installs, so a lost covered column must name
  // auth.users instead of sharing the generic closure message.
  if (tables.find(table => table.name === 'auth.users')?.definition !== expectedAuthUsersTriggerDefinition(
    'a00_case_graph_lock', 'private.lock_case_graph_statement_auth', 'STATEMENT')) {
    throw new Error('Case graph BEFORE STATEMENT gate changed: auth.users covered columns or function');
  }
  const keyGates = (await client.query(`select n.nspname||'.'||c.relname name, t.tgtype, t.tgenabled,
    t.tgfoid='private.lock_case_graph_row_keys()'::regprocedure correct_function,
    encode(t.tgargs,'escape') arguments,
    pg_get_triggerdef(t.oid, true) definition,
    array(select a.attname::text from pg_attribute a where a.attrelid=c.oid and a.attnum>0
      and not a.attisdropped and a.atttypid='uuid'::regtype) uuid_columns,
    exists(select 1 from pg_trigger later where later.tgrelid=c.oid and not later.tgisinternal
      and (later.tgtype & 3)=3 and later.tgenabled in ('O','A') and later.tgname > 'z99_case_graph_keys') later_row_trigger
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    left join pg_trigger t on t.tgrelid=c.oid and t.tgname='z99_case_graph_keys'
    where c.oid=any($1::regclass[]) and c.relkind='r' order by 1`, [reviewedGraph.tables])).rows;
  for (const gate of keyGates) {
    if (authBookkeepingChildTableSet.has(gate.name)) {
      if (gate.tgtype !== null || gate.definition !== null) throw new Error(`Exempt Auth bookkeeping row-key gate changed: ${gate.name}`);
      continue;
    }
    const expected = rowKeyArguments(foreignKeys, gate.name).map(columns => columns + '\\000').join('');
    if (gate.later_row_trigger || gate.tgtype !== 31 || gate.tgenabled !== 'O' || !gate.correct_function || gate.arguments !== expected) {
      throw new Error(`Implicit FK row-key gate changed: ${gate.name}`);
    }
    // Every column the helper decodes from the installed arguments must be a
    // uuid column of the relation; otherwise the gate locks nothing (#6356).
    const decoded = gate.arguments.split('\\000').slice(0, 2).flatMap(rowKeyColumns);
    if (decoded.some(column => gate.uuid_columns?.includes(column) !== true)) {
      throw new Error(`Implicit FK row-key gate argument resolves to no uuid column: ${gate.name}`);
    }
    if (gate.name === 'auth.users' && gate.definition !== expectedAuthUsersTriggerDefinition(
      'z99_case_graph_keys', 'private.lock_case_graph_row_keys', 'ROW')) {
      throw new Error('Implicit FK row-key gate changed: auth.users');
    }
  }
  const childTriggers = (await client.query(`select n.nspname||'.'||c.relname table_name, t.tgname,
      t.tgtype, t.tgenabled, t.tgfoid='private.lock_auth_bookkeeping_shared()'::regprocedure correct_function,
      t.tgattr::text attributes, pg_catalog.encode(t.tgargs,'escape') arguments
    from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
    where c.oid=any($1::regclass[]) and not t.tgisinternal order by 1,2`, [authBookkeepingChildTables])).rows;
  if (childTriggers.length !== authBookkeepingChildTables.length
    || childTriggers.some(row => row.tgname !== 'a01_auth_bookkeeping_shared' || row.tgtype !== 30
      || row.tgenabled !== 'O' || !row.correct_function || row.attributes !== '' || row.arguments !== '')) {
    throw new Error(`Auth bookkeeping shared trigger changed: ${childTriggers.map(row => `${row.table_name}.${row.tgname}`).join(', ')}`);
  }
  const bookkeepingTriggers = (await client.query(`select n.nspname||'.'||c.relname table_name, t.tgname,
      t.tgtype, t.tgenabled, p.pronamespace::regnamespace::text||'.'||p.proname function_name,
      t.tgattr::text attributes, pg_catalog.encode(t.tgargs,'escape') arguments
    from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
    join pg_proc p on p.oid=t.tgfoid
    where not t.tgisinternal and (c.oid in ('auth.oauth_clients'::regclass, 'auth.sso_providers'::regclass)
      or (c.oid='auth.users'::regclass and t.tgname like 'a01_auth_bookkeeping_%')) order by 1,2`)).rows;
  // Auth client/provider parents are pinned exhaustively, not just for a01:
  // their DELETE cascades reach graph relations (OAuth authorizations/consents
  // and SCIM users),
  // which keep a00_case_graph_lock, so the graph gate must be taken in a00
  // before the exclusive bookkeeping lock in a01. The reverse order lets the
  // deleter own (509, 701) while waiting for a gate a covered auth.users
  // statement already holds, and the two transactions cycle.
  if (JSON.stringify(bookkeepingTriggers) !== JSON.stringify([
    { table_name: 'auth.oauth_clients', tgname: 'a00_case_graph_lock', tgtype: 10,
      tgenabled: 'O', function_name: 'private.lock_case_graph_statement', attributes: '', arguments: '' },
    { table_name: 'auth.oauth_clients', tgname: 'a01_auth_bookkeeping_exclusive', tgtype: 10,
      tgenabled: 'O', function_name: 'private.lock_auth_bookkeeping_exclusive', attributes: '', arguments: '' },
    { table_name: 'auth.sso_providers', tgname: 'a00_case_graph_lock', tgtype: 10,
      tgenabled: 'O', function_name: 'private.lock_case_graph_statement', attributes: '', arguments: '' },
    { table_name: 'auth.sso_providers', tgname: 'a01_auth_bookkeeping_exclusive', tgtype: 10,
      tgenabled: 'O', function_name: 'private.lock_auth_bookkeeping_exclusive', attributes: '', arguments: '' },
    { table_name: 'auth.users', tgname: 'a01_auth_bookkeeping_shared', tgtype: 30,
      tgenabled: 'O', function_name: 'private.lock_auth_bookkeeping_shared', attributes: '', arguments: '' },
  ])) throw new Error('Auth bookkeeping users/client trigger changed');
  const messageLifecycle = (await client.query(`select pg_get_triggerdef(t.oid, true) definition
    from pg_trigger t where t.tgrelid='auth.users'::regclass
      and t.tgname='message_lifecycle_statement' and not t.tgisinternal`)).rows;
  if (messageLifecycle.length !== 1 || messageLifecycle[0].definition !== expectedAuthUsersTriggerDefinition(
    'message_lifecycle_statement', 'private.lock_message_lifecycle_statement', 'STATEMENT')) {
    throw new Error('Auth users message-lifecycle statement gate changed');
  }
  console.log(`PASS: ${foreignKeys.length} catalogue FKs and ${keyGates.length} Auth/case row-key gates are complete`);
  console.log(`PASS: installed case-graph writer closure and ${tables.length} statement gates are complete`);
}

// Negative controls for the Auth bookkeeping surface. Each entry is
// [mutation, expectedVerifierMessage, label]. Detection means the VERIFIER
// rejected the mutated catalogue with its expected message: a mutation that
// could not be applied, or a role change the connection may not make, is a
// broken control and must not be reported as detected drift.
export async function runAuthBookkeepingDriftControls(client, drifts, prove = proveCaseGraphInventory) {
  const failures = [];
  for (const [mutation, expected, label] of drifts) {
    await client.query('begin');
    let stage = 'mutation';
    let detected = false;
    let actual = 'no verifier error';
    try {
      await client.query(mutation);
      stage = 'role';
      await client.query('set local role postgres');
      stage = 'verifier';
      await prove(client);
    } catch (error) {
      actual = error.message;
      detected = stage === 'verifier' && error.message.includes(expected);
    } finally {
      await client.query('rollback');
    }
    if (!detected) {
      failures.push(stage === 'verifier'
        ? `${label}: verifier did not report ${JSON.stringify(expected)}; got ${actual}`
        : `${label}: control never reached the verifier, ${stage} step failed with ${actual}`);
    }
  }
  return failures;
}
