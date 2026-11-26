// SEC-UG-NON-INTERFERENCE-PROOF-FOR-EVERY-EXPOSED-FUNCTION-AND-TABLE-20261111 (#8323).
//
// The leak guard's offline rules define what
// it calls, with which arguments, how two answers are compared, and how a run
// is judged against the reviewed lists in config/non-interference/. The proof
// calls every function and reads every table and view granted to the members'
// PostgREST role and to anon, as a fresh organization's personas, once with a
// neighbour (another organization, a second chapter, a second unit) and twice
// without it. An answer that changes only because the neighbour exists is a
// leak, unless it is reviewed as shared or listed under an open record.
// Answers are compared whole, refusals included. Nothing is masked from what
// the two runs without the neighbour show: a value may vary only where a
// reviewed contract (volatile.json) names the target, the field and the whole
// value's pattern; any other same-world difference, and anything else that
// cannot be compared, fails.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Every function in public the role may execute, read from the installed
// catalog at run time (never a hand-written list). Trigger functions and
// procedures are not callable through PostgREST.
export const FUNCTIONS_SQL = `
  select p.oid::int as oid, p.proname as name, pg_catalog.pg_get_function_identity_arguments(p.oid) as sig,
         p.pronargs as nargs, p.pronargdefaults as ndefaults, p.proargnames as argnames, p.proargmodes::text[] as modes,
         (select pg_catalog.array_agg(pg_catalog.format_type(t, null) order by ord)
            from pg_catalog.unnest(p.proargtypes) with ordinality as x(t, ord)) as argtypes,
         p.proretset as retset
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.prokind = 'f'
     and p.prorettype <> 'trigger'::pg_catalog.regtype
     and pg_catalog.has_function_privilege($1, p.oid, 'execute')
   order by p.proname, sig`;

// Every table, view and materialized view in public the role may read, with
// the columns it may read.
export const RELATIONS_SQL = `
  select c.relname as name, c.relkind as kind,
         (select pg_catalog.array_agg(a.attname::text order by a.attnum) from pg_catalog.pg_attribute a
           where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
             and pg_catalog.has_column_privilege($1, c.oid, a.attnum, 'select')) as cols
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm')
     and (pg_catalog.has_table_privilege($1, c.oid, 'select') or pg_catalog.has_any_column_privilege($1, c.oid, 'select'))
   order by c.relname`;

export const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;
export const literal = (value) => `'${String(value).replace(/'/g, "''")}'`;

// The input parameters of a catalog row: names and types, in call order.
export function inputParams(fn) {
  const types = fn.argtypes ?? [];
  const names = fn.argnames ?? [];
  const modes = fn.modes ?? null;
  const inputs = [];
  let typeIndex = 0;
  const count = modes ? modes.length : types.length;
  for (let i = 0; i < count; i += 1) {
    const mode = modes ? modes[i] : "i";
    if (!["i", "b", "v"].includes(mode)) continue;
    inputs.push({ name: names[i] || "", type: types[typeIndex] });
    typeIndex += 1;
  }
  return inputs;
}

const PERSON_PARAM = /user|member|steward|coordinator|recipient|assignee|reviewer|owner|author|actor|peer|person|subject|officer|invitee/;
const OBJECT_PARAM = /case|task|event|form|request|thread|message|conversation|invitation|claim|grant|handoff|ballot|survey|poll/;

// The object table a generic uuid parameter names: a table whose last word is
// the parameter's own noun in the plural (p_case_id and p_source_case_id name
// "..._cases", p_reply_id "..._replies"). Of several, the one whose other
// words the function's name or the parameter shares wins, then the shortest
// name. A table that only contains the noun ("casework_access_grants" for
// "case", "organization_survey_tasks" for "task" in a chapter task function)
// is never taken: the neighbour call would pass an id the function never
// looks up, so it could not fail (#8359, review of #8765, P2-1).
const GENERIC_TABLE_WORDS = new Set(["member", "chapter", "organization"]);
// Words of a parameter that say which of several objects it is (its role in
// the call), not what kind of object: they never narrow the table.
const ROLE_WORDS = new Set(["source", "target", "parent", "child", "expected", "new", "old", "other", "related", "linked", "original", "current",
  "previous", "next", "from", "to", "primary", "secondary"]);

export function objectTableFor(paramName, objects = {}, fnName = "") {
  const name = (paramName || "").toLowerCase().replace(/^p_/, "");
  // Only an id parameter, or a bare object noun ("p_case"), names an object;
  // an idempotency key or another *_key is never an object id.
  if (!/_ids?$/.test(name) && !OBJECT_PARAM.test(name)) return null;
  const want = name.replace(/_ids?$/, "");
  const noun = want.split("_").pop();
  if (!noun) return null;
  const plurals = new Set([`${noun}s`, `${noun}es`, ...(noun.endsWith("y") ? [`${noun.slice(0, -1)}ies`] : [])]);
  const shared = new Set([...fnName.toLowerCase().split("_"), ...want.split("_")]);
  const prefix = (table) => table.split("_").slice(0, -1);
  const score = (table) => prefix(table).filter((word) => shared.has(word)).length;
  // A word the parameter adds to its noun names the kind ("scheduled",
  // "task", "private" in p_scheduled_message_id, p_task_message_ids,
  // p_private_message_ids): the table must carry it, or there is no object of
  // that kind and the id stays null for the untested check, never another
  // kind's id (review of #8805, P2-1).
  const kinds = want.split("_").slice(0, -1).filter((word) => !ROLE_WORDS.has(word));
  // Every other word of the table is generic or named by the function or the
  // parameter: "organization_knowledge_files" is not a chapter task's file.
  const candidates = Object.keys(objects).filter((table) => plurals.has(table.split("_").pop())
    && prefix(table).every((word) => GENERIC_TABLE_WORDS.has(word) || shared.has(word))
    && kinds.every((word) => prefix(table).includes(word)));
  candidates.sort((a, b) => score(b) - score(a) || a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  return candidates[0] ?? null;
}

// One argument for one parameter. `scope` names the ids the variant uses:
// { organizationId, chapterId, userId } of the persona ("own") or of the
// neighbour ("neighbour"); `objects` maps a table name to one of that scope's
// object ids. "min" passes null for every parameter.
export function argumentFor(param, variant, scope = {}, objects = {}, fnName = "") {
  const name = (param.name || "").toLowerCase();
  const type = param.type || "text";
  const array = type.endsWith("[]");
  const base = array ? type.slice(0, -2) : type;
  const wrap = (value, cast) => (value === null || value === undefined ? `null::${type}`
    : array ? `array[${literal(value)}]::${type}` : `${literal(value)}::${cast}`);
  if (variant === "min") return `null::${type}`;
  if (base === "uuid") {
    if (/organization|(^|_)org(_|$)/.test(name)) return wrap(scope.organizationId, "uuid");
    if (PERSON_PARAM.test(name) && !OBJECT_PARAM.test(name)) return wrap(scope.userId, "uuid");
    const match = objectTableFor(name, objects, fnName);
    return wrap(match ? objects[match] : null, "uuid");
  }
  if (["text", "character varying", "citext"].includes(base)) {
    if ((/chapter/.test(name) && !/name|title|label/.test(name))) return wrap(scope.chapterId, base);
    if (/query|search|needle|term|prefix|keyword|(^|_)q$/.test(name)) return wrap("an", base);
    if (/locale|lang/.test(name)) return wrap("en", base);
    if (/timezone|(^|_)tz$/.test(name)) return wrap("America/New_York", base);
    if (/hat/.test(name)) return wrap("admin", base);
    if (/role/.test(name)) return wrap("steward", base);
    return `null::${type}`;
  }
  if (/^(integer|bigint|smallint|numeric|double precision|real)$/.test(base)) {
    const value = /limit|size|count|max|top|per_page/.test(name) ? 50 : /page|offset|skip/.test(name) ? 0 : /year/.test(name) ? 2026 : 1;
    return array ? `array[${value}]::${type}` : `${value}::${base}`;
  }
  if (base === "boolean") return array ? `'{}'::${type}` : "false";
  if (base === "date") return "date '2026-11-01'";
  if (base === "jsonb" || base === "json") return `'{}'::${base}`;
  return `null::${type}`;
}


// One argument from a reviewed probe (config/non-interference/probes.json):
// "@<table>" is the variant's object of that table, "$organizationId",
// "$chapterId", "$userId" and "$unitId" its scope, "$callerId" the calling
// persona in every variant, a JSON array of literals an array parameter's
// elements, anything else a literal.
export function probeArgument(value, type, scope = {}, objects = {}) {
  if (typeof value === "string" && value.startsWith("@")) value = objects[value.slice(1)] ?? null;
  else if (typeof value === "string" && value.startsWith("$")) value = scope[value.slice(1)] ?? null;
  if (value === null || value === undefined) return `null::${type}`;
  if (Array.isArray(value) && type.endsWith("[]")) return `array[${value.map(literal).join(", ")}]::${type}`;
  return type.endsWith("[]") ? `array[${literal(value)}]::${type}` : `${literal(value)}::${type}`;
}

// Rows a function answer or a relation read is compared on. One more row is
// read than the bound, so an answer longer than the bound is reported as
// truncated (and fails) instead of being compared on its first rows.
export const FUNCTION_ROW_LIMIT = 1000;
export const RELATION_ROW_LIMIT = 5000;

// The SQL that calls a function with one variant's arguments and returns its
// answer as one jsonb array of rows. With a reviewed probe, the own and
// neighbour variants pass the probe's arguments instead of generic ones.
export function callSql(fn, variant, scope, objects, { limit = FUNCTION_ROW_LIMIT, probe = null } = {}) {
  const params = inputParams(fn);
  const required = fn.nargs - fn.ndefaults;
  const parts = [];
  params.forEach((param, index) => {
    if (probe && variant !== "min") {
      if (!Object.hasOwn(probe.arguments, param.name) && index >= required) return;
      const value = probeArgument(probe.arguments[param.name] ?? null, param.type, scope, objects);
      parts.push(`${quoteIdent(param.name)} := ${value}`);
      return;
    }
    if (variant === "min" && index >= required) return;
    const value = argumentFor(param, variant, scope, objects, fn.name);
    parts.push(param.name ? `${quoteIdent(param.name)} := ${value}` : value);
  });
  return `select coalesce(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(r)), '[]'::jsonb) as v from (select * from public.${quoteIdent(fn.name)}(${parts.join(", ")}) limit ${limit + 1}) r`;
}

// The SQL that reads a relation's granted columns: the row count and the rows
// (at most the bound plus one).
export function readSql(rel, limit = RELATION_ROW_LIMIT) {
  const cols = (rel.cols ?? []).map(quoteIdent).join(", ");
  return `select (select pg_catalog.count(*) from public.${quoteIdent(rel.name)})::int as n,
    coalesce((select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(t)) from (select ${cols} from public.${quoteIdent(rel.name)} limit ${limit + 1}) t), '[]'::jsonb) as v`;
}

// One observation per call, kept whole. A refusal is an answer like any
// other: its SQLSTATE, message, detail and hint are compared, so "no such
// case" without the neighbour and "case belongs to another organization" with
// it is a difference. A call still out of time after its retry proves
// nothing and is inconclusive (which fails).
export function observe(result, { limit = FUNCTION_ROW_LIMIT, count = null } = {}) {
  if (result.error) {
    const { code = "", message = "", detail = null, hint = null } = result.error;
    if (code === "57014") return { kind: "inconclusive", value: { error: { code, message } } };
    return { kind: "error", value: { error: { code, message, detail: detail ?? null, hint: hint ?? null } } };
  }
  const rows = Array.isArray(result.value) ? result.value : [result.value];
  const truncated = rows.length > limit || (count !== null && count > limit);
  const value = count === null ? rows.slice(0, limit) : { count, rows: rows.slice(0, limit) };
  return { kind: "ok", value, truncated };
}

const isPlain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// What a reviewed volatility contract (config/non-interference/volatile.json)
// lets vary for one target. `paths` maps a field path (array positions
// written "[]") to an anchored pattern the whole value must match; with
// capture groups, only the captured parts are replaced (the new row's id at
// the start of "Failing row contains (...)") and the rest is compared as it
// is; a value that does not match is compared as it is. The proof cannot
// show that a call generated an id (a call can return, or copy into a new
// row, an id that already existed), so a rule that masks an id is marked
// `notProven` with the record that lists its function as not proven (#8359):
// the judge fails unless the function is on that list, and the run reports
// it as not proven, never as proven. Only a value that is random by design
// and is not an id (a new secret, a recovery code) is masked with no such
// mark, by its pattern.
function matchRule(text, rule) {
  const match = new RegExp(rule.pattern, "d").exec(text);
  if (!match) return null;
  return match.length === 1 ? [[0, text.length]] : match.indices.slice(1).filter(Boolean);
}

function maskValue(text, rule, path) {
  const spans = matchRule(text, rule);
  if (!spans) return null;
  if (spans.length === 1 && spans[0][0] === 0 && spans[0][1] === text.length) return `<varies ${path}>`;
  let out = "";
  let at = 0;
  for (const [start, end] of spans) {
    out += `${text.slice(at, start)}<varies>`;
    at = end;
  }
  return out + text.slice(at);
}

export function mask(value, paths = {}, path = "$") {
  const rule = paths[path];
  if (rule && (typeof value === "string" || typeof value === "number")) {
    const masked = maskValue(String(value), rule, path);
    if (masked !== null) return masked;
  }
  if (Array.isArray(value)) return value.map((item) => mask(item, paths, `${path}[]`));
  if (isPlain(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = mask(value[key], paths, `${path}.${key}`);
    return out;
  }
  return value;
}

// The text an answer is compared on: the contract's fields masked and object
// keys sorted. A function's rows keep their order, which is part of what the
// caller sees; a relation read (its order is unspecified in SQL) and a
// function whose contract reviews its order as unspecified (`unordered`) are
// compared as row multisets.
export function comparable(observation, contract = {}, { sortRows = false } = {}) {
  const value = mask(observation.value, contract.paths ?? {});
  const rows = (list) => (sortRows ? list.map((row) => JSON.stringify(row)).sort() : list.map((row) => JSON.stringify(row)));
  if (Array.isArray(value)) return JSON.stringify(rows(value));
  if (isPlain(value) && Array.isArray(value.rows)) return JSON.stringify({ count: value.count, rows: rows(value.rows) });
  return JSON.stringify(value);
}

// For the report only: the field paths where two sorted answers differ, to
// help review a contract. Nothing is ever masked from what this finds.
export function varyingPaths(a, b, path = "$", out = new Set()) {
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    const order = (list) => [...list].sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1));
    const [left, right] = path === "$" || path === "$.rows" ? [order(a), order(b)] : [a, b];
    left.forEach((item, index) => varyingPaths(item, right[index], `${path}[]`, out));
  } else if (isPlain(a) && isPlain(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) varyingPaths(a[key], b[key], `${path}.${key}`, out);
  } else if (JSON.stringify(a) !== JSON.stringify(b)) {
    out.add(path);
  }
  return out;
}

// Every field path a value holds (array positions written "[]"); an empty
// array or object counts as its own path.
function leafPaths(value, path, out) {
  if (Array.isArray(value)) {
    if (!value.length) out.add(path);
    for (const item of value) leafPaths(item, `${path}[]`, out);
  } else if (isPlain(value)) {
    const keys = Object.keys(value);
    if (!keys.length) out.add(path);
    for (const key of keys) leafPaths(value[key], `${path}.${key}`, out);
  } else {
    out.add(path);
  }
  return out;
}

// The field paths a difference touches, as a sorted list, so a reviewed
// shared or listed difference can pin what it may change (#8359, ledger
// 292). Rows are matched as multisets, never by position, so the answer does
// not depend on the order of ids made fresh in each run: every field of a row
// one side has and the other lacks counts. A list of one row on each side is
// compared field by field, as an object is; a key one side lacks counts with
// every field under it.
export function differingFields(a, b, path = "$", out = new Set()) {
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length === 1 && b.length === 1) return differingFields(a[0], b[0], `${path}[]`, out);
    const unmatched = (left, right) => {
      const counts = new Map();
      for (const item of right) counts.set(JSON.stringify(item), (counts.get(JSON.stringify(item)) ?? 0) + 1);
      return left.filter((item) => {
        const text = JSON.stringify(item);
        if (!counts.get(text)) return true;
        counts.set(text, counts.get(text) - 1);
        return false;
      });
    };
    for (const item of [...unmatched(a, b), ...unmatched(b, a)]) leafPaths(item, `${path}[]`, out);
  } else if (isPlain(a) && isPlain(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!Object.hasOwn(a, key)) leafPaths(b[key], `${path}.${key}`, out);
      else if (!Object.hasOwn(b, key)) leafPaths(a[key], `${path}.${key}`, out);
      else differingFields(a[key], b[key], `${path}.${key}`, out);
    }
  } else if (JSON.stringify(a) !== JSON.stringify(b)) {
    if (Array.isArray(a) || isPlain(a) || Array.isArray(b) || isPlain(b)) {
      leafPaths(a, path, out);
      leafPaths(b, path, out);
    } else {
      out.add(path);
    }
  }
  return [...out].sort();
}

// Exact values at the differing paths, as multisets. A missing path is [],
// distinct from [null], [false], [0] and [[]]. The values are already masked
// by the target's reviewed volatility contract, never by a learned pattern.
function valuesAtFields(value, fields) {
  const out = Object.fromEntries(fields.map((field) => [field, []]));
  const walk = (item, path) => {
    if (Object.hasOwn(out, path)) out[path].push(item);
    if (Array.isArray(item)) for (const child of item) walk(child, `${path}[]`);
    else if (isPlain(item)) for (const [key, child] of Object.entries(item)) walk(child, `${path}.${key}`);
  };
  walk(value, "$");
  for (const items of Object.values(out)) items.sort((a, b) => {
    const left = JSON.stringify(a), right = JSON.stringify(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return out;
}

// The first place two texts differ, with a little context, for the report.
export function firstDifference(before = "", after = "") {
  let index = 0;
  while (index < before.length && index < after.length && before[index] === after[index]) index += 1;
  const from = Math.max(0, index - 80);
  return { at: index, before: before.slice(from, index + 160), after: after.slice(from, index + 160) };
}

const describeKey = (key) => {
  const [pair, persona, target, variant] = key.split("|");
  const [kind, signature] = target.split(/:(.*)/s);
  return { key, pair, persona, kind, signature, name: signature.replace(/\(.*$/s, ""), variant };
};

// Compares one pair's three sweeps, all maps of key -> observation, where a
// key is "<pair>|<persona>|<function|table>:<name or signature>|<variant>":
// `withNeighbour`, then `base` and `control` (the same world swept twice).
// Nothing is learned from the two runs: each answer is masked only by its
// target's reviewed contract, and an answer that still differs between base
// and control is unproven (unstable, which fails). A difference only in the
// order of a function's rows is a difference unless the contract reviews the
// order as unspecified. `volatile` maps "function:<signature>" or
// "table:<name>" to a contract ({ paths, unordered }).
export function compareWorlds({ withNeighbour, base, control, volatile = {} }) {
  const out = { diffs: [], unstable: [], inconclusive: [], truncated: [], contracted: [], notProven: [] };
  for (const [key, before] of base) {
    const after = withNeighbour.get(key);
    const again = control.get(key);
    if (!after || !again) continue;
    const at = describeKey(key);
    if ([before, after, again].some((item) => item.kind === "inconclusive")) { out.inconclusive.push(at); continue; }
    if ([before, after, again].some((item) => item.truncated)) out.truncated.push(at);
    const target = `${at.kind}:${at.signature}`;
    const contract = volatile[target] ?? {};
    const sortRows = at.kind === "table" || Boolean(contract.unordered);
    const text = (item, rules = contract, sorted = sortRows) => comparable(item, rules, { sortRows: sorted });
    // The contract counts as used when it settles a difference the answers
    // would show without it.
    const raw = [before, again, after].map((item) => text(item, {}, at.kind === "table"));
    const masked = [before, again, after].map((item) => text(item));
    if ((raw[0] !== raw[1] && masked[0] === masked[1]) || (raw[0] !== raw[2] && masked[0] === masked[2])) {
      out.contracted.push(target);
      if (Object.values(contract.paths ?? {}).some((rule) => rule.notProven)) out.notProven.push(at);
    }
    const [left, twice, right] = masked;
    if (left !== twice) {
      out.unstable.push({ ...at, paths: [...varyingPaths(before.value, again.value)].sort(), order: text(before, contract, true) === text(again, contract, true), ...firstDifference(left, twice) });
      continue;
    }
    if (left !== right) {
      const beforeValue = mask(before.value, contract.paths ?? {});
      const afterValue = mask(after.value, contract.paths ?? {});
      const fields = differingFields(beforeValue, afterValue);
      out.diffs.push({ ...at, before: before.kind, after: after.kind, order: text(before, contract, true) === text(after, contract, true),
        fields, values: { base: valuesAtFields(beforeValue, fields), withNeighbour: valuesAtFields(afterValue, fields) }, ...firstDifference(left, right) });
    }
  }
  return out;
}

// The refusal text a waiver pins: SQLSTATE and message, with ids and times
// that differ from run to run replaced.
export function refusalText(observation) {
  const { code, message } = observation.value.error;
  return `${code} ${message}`.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\d{4}-\d{2}-\d{2}[T ][\d:.]+([+-]\d{2}(:?\d{2})?|Z)?/g, "<ts>").slice(0, 200);
}

// Per exact signature and role, the functions no call reached: every call by
// every persona of that role, in every variant and world, was refused. The
// value is the sorted set of refusals the role got.
export function unreachedFunctions(sweeps, catalog) {
  const answered = new Map();
  for (const sweep of sweeps) {
    for (const [key, observation] of sweep) {
      const { persona, kind, signature } = describeKey(key);
      if (kind !== "function") continue;
      const role = persona === "anon" ? "anon" : "authenticated";
      const entry = answered.get(`${signature}|${role}`) ?? { reached: false, refusals: new Set() };
      if (observation.kind === "ok") entry.reached = true;
      else if (observation.kind === "error") entry.refusals.add(refusalText(observation));
      answered.set(`${signature}|${role}`, entry);
    }
  }
  const out = {};
  for (const role of Object.keys(catalog)) {
    for (const fn of catalog[role].functions) {
      const signature = `${fn.name}(${fn.sig})`;
      const entry = answered.get(`${signature}|${role}`);
      if (!entry || entry.reached) continue;
      (out[signature] ??= {})[role] = [...entry.refusals].sort();
    }
  }
  return out;
}

// Functions reached on generic arguments with an object parameter that no
// neighbour call ever filled: the call passes null in every world, so it can
// never show another world's row, and the function is not proven. They must
// be listed in unreachable.json "untested" with a reason (#8359, review of
// #8765, P2-1). Cursor ids (p_after_id, p_before_id ...), organization and
// person parameters are not objects. `neighbourObjects` holds each pair's
// neighbour objects; a function with a probe is judged by its probe instead.
// Maps a signature to its untested parameters.
const CURSOR_PARAM = /^p_(after|before|cursor|last|since|next|prev|previous|anchor|page|offset|start|end)(_[a-z]+)?(_id)?$/;
const TEXT_TYPES = new Set(["text", "character varying", "citext"]);

export function untestedFunctions(catalog, probes, neighbourObjects) {
  const out = {};
  for (const role of Object.keys(catalog)) {
    for (const fn of catalog[role].functions) {
      const signature = `${fn.name}(${fn.sig})`;
      if (probes[signature]) continue;
      for (const param of inputParams(fn)) {
        const name = (param.name || "").toLowerCase();
        const type = (param.type || "").replace(/\[\]$/, "");
        // Every uuid input, whatever its name ends in (p_target, p_unit), and
        // every text id (p_event_id text), which generic arguments never fill
        // (review of #8805, P1-1 and P3-2); not organization, person, cursor,
        // chapter or key (idempotency key) parameters.
        const textId = TEXT_TYPES.has(type) && /_ids?$/.test(name) && !/chapter/.test(name);
        if ((type !== "uuid" && !textId) || CURSOR_PARAM.test(name) || /(^p_|_)key$/.test(name)
          || /organization|(^|_)org(_|$)/.test(name) || (PERSON_PARAM.test(name) && !OBJECT_PARAM.test(name))) continue;
        if (type === "uuid" && neighbourObjects.some((objects) => objectTableFor(name, objects, fn.name))) continue;
        const list = (out[signature] ??= []);
        if (!list.includes(param.name)) list.push(param.name);
      }
    }
  }
  return out;
}

// C326 (additive step): probes may also live in one shard per batch or
// record under probes.d/ beside probes.json, so a probe batch and an
// isolation fix add different files instead of appending to the same tail
// of probes.json and conflicting. The merged map is exactly what
// probes.json alone held before shards existed; judge() sees no
// difference. A signature in two files is a hard error here, never a
// silent override (JSON.parse alone would keep only the last copy).
export function mergeProbeLists(shards) {
  const merged = {};
  const owner = new Map();
  for (const { name, functions } of shards) {
    for (const [signature, probe] of Object.entries(functions ?? {})) {
      if (owner.has(signature)) {
        throw new Error(`probe defined twice: ${signature} in ${owner.get(signature)} and ${name}`);
      }
      owner.set(signature, name);
      merged[signature] = probe;
    }
  }
  return merged;
}

// A shard must be an object holding a functions object; anything else
// (an array, a bare signature map, null) is rejected rather than read
// as zero probes.
export function parseProbeShard(name, text) {
  const parsed = JSON.parse(text);
  const plainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
  if (!plainObject(parsed) || !plainObject(parsed.functions)) {
    throw new Error(`probe shard ${name} must be an object with a functions object`);
  }
  return parsed.functions;
}

// Every probes.d/*.json shard beside a probes.json URL, in name order, or
// none when the directory does not exist yet (the first shard's pull
// request creates it).
function probeShardsBeside(probesUrl) {
  const directory = new URL("probes.d/", new URL("./", probesUrl));
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((name) => name.endsWith(".json")).sort()
    .map((name) => ({ name, functions: parseProbeShard(name, readFileSync(new URL(name, directory), "utf8")) }));
}

export function readList(path) {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!String(path).endsWith("probes.json")) return parsed;
  const url = path instanceof URL ? path : pathToFileURL(String(path));
  const shards = [{ name: "probes.json", functions: parsed.functions ?? {} }, ...probeShardsBeside(url)];
  return { ...parsed, functions: mergeProbeLists(shards) };
}

// Diagnostic function/type identifiers only, never arbitrary argument text.
// PostgreSQL's quoted SQL context can contain interpolated text and forged
// frames on later lines. Once it starts, the rest is ambiguous and omitted.
// Only JSON data lines may contain quotes before a genuine frame. Compilation
// contexts print raw names, so even an exact-looking line may begin a forged
// multiline name. COPY names are also raw.
// Genuine bounded frames still support quoted function/type identifiers.
const FRAME_IDENT = String.raw`(?:[A-Za-z_][A-Za-z_0-9$]*|"[A-Za-z_][A-Za-z_0-9$]*")`;
const FRAME_NAME = `${FRAME_IDENT}(?:\\.${FRAME_IDENT})?`;
const FRAME_TYPE = `(?:timestamp(?: with(?:out)? time zone)?|time(?: with(?:out)? time zone)?|double precision|character varying|bit varying|${FRAME_NAME})(?:\\[\\])*`;
const FUNCTION_FRAME = new RegExp(`^(?:PL/pgSQL function ${FRAME_NAME}\\((?:${FRAME_TYPE}(?:, ?${FRAME_TYPE})*)?\\) line [0-9]+ at [A-Za-z ]+|SQL function "[A-Za-z_][A-Za-z_0-9$]*" (?:statement [0-9]+|during [A-Za-z_]+))$`);

export function safeFunctionFrames(context) {
  const frames = [];
  for (const line of String(context ?? "").split("\n")) {
    if (line.startsWith("COPY ")) break;
    if (line.length <= 240 && FUNCTION_FRAME.test(line)) {
      frames.push(line);
      // SQL-function frames also print the raw name: it may contain the next
      // line, so this is the last frame we can trust. PL/pgSQL quotes names.
      if (line.startsWith('SQL function "')) break;
    } else if (line.includes('"') && !/^JSON data, line \d+: /.test(line)) break;
  }
  return frames.join(" | ").slice(0, 240);
}

// A controller-approved producer defect is excluded from execution, never
// normalized into a passing observation. The full installed catalog remains
// available to report the excluded signature as NOT PROVEN.
export function proofCatalog(catalog, blocked = {}) {
  const signatures = new Set(Object.values(catalog).flatMap((role) => role.functions.map((fn) => `${fn.name}(${fn.sig})`)));
  for (const [signature, entry] of Object.entries(blocked)) {
    if (!signatures.has(signature)) throw new Error(`Stale blocked function: ${signature}`);
    if (!Number.isSafeInteger(entry?.record) || entry.record <= 0
      || typeof entry.reason !== "string" || !entry.reason.includes(`#${entry.record}`) || !entry.reason.includes("NOT PROVEN")) {
      throw new Error(`Blocked function needs its record and NOT PROVEN reason: ${signature}`);
    }
  }
  return Object.fromEntries(Object.entries(catalog).map(([role, value]) => [role, { ...value,
    functions: value.functions.filter((fn) => !Object.hasOwn(blocked, `${fn.name}(${fn.sig})`)),
  }]));
}

// Judges one run against the reviewed lists, failing closed:
//   unexpected    a difference whose function or table is neither shared for
//                 that pair nor listed under an open record, or that an entry
//                 pins and no pin matches;
//   stale         a listed difference that no longer appears;
//   unusedShared  a shared entry, or one of its pins, that no difference
//                 used;
//   unpinnedShared, unpinnedRecords
//                 a shared or record entry that does not pin its
//                 differences;
//   unlisted      an unreached signature and role with no waiver;
//   changed       a waiver whose roles or exact refusals no longer match;
//   reachable     a waiver for a signature that is now reached or gone;
//   unusedContracts
//                 a volatility contract whose target never varied;
//   provenAnyway  a function a not-proven rule settled that is not on the
//                 not-proven list;
//   staleNotProven
//                 a reached-but-not-proven entry no rule settles any more;
//   unstable, inconclusive, truncated
//                 a call that could not be compared (two same-world answers
//                 that still differ once the reviewed contract is applied,
//                 out of time, longer than the bound), for every target,
//                 shared and listed ones included.
// A pin ({ pair, personas, variants, fields }, in an entry's "differences")
// names some personas' calls on one pair and the exact field paths
// (differingFields) the difference may touch; "name" limits it to one
// function or table of a record that lists several. A wider leak through the
// same function (another field, another persona or variant) matches no pin
// and is unexpected (#8359, a review note). Optional values[variant] pins both
// worlds' exact field-value multisets as well. expectedValues is
// a supplemental file for active records, so frozen fix heads can remove
// their original entries without also editing this file. A retired record's
// supplemental pins are inert; they never authorize a difference themselves.
export function judge({ compared, unreached, shared, expected, unreachable, expectedValues = { records: {} }, volatile = { targets: {} }, untested = {} }) {
  const listName = (at) => (at.kind === "function" ? "functions" : "tables");
  const pinUse = new Set();
  const pinned = (label, entry, at, requireValues = false) => {
    if (!entry.differences) return true;
    const fields = JSON.stringify(at.fields ?? []);
    const valuesMatch = (pin) => (!requireValues && !Object.hasOwn(pin, "values")) || (isPlain(pin.values)
      && Object.hasOwn(pin.values, at.variant) && isPlain(at.values)
      && JSON.stringify(mask(pin.values[at.variant])) === JSON.stringify(mask(at.values)));
    const index = entry.differences.findIndex((pin) => (!pin.name || pin.name === at.name) && pin.pair === at.pair
      && (pin.personas ?? []).includes(at.persona) && (pin.variants ?? []).includes(at.variant) && JSON.stringify([...(pin.fields ?? [])].sort()) === fields
      && valuesMatch(pin));
    if (index < 0) return false;
    pinUse.add(`${label}|${index}|${at.persona}|${at.variant}`);
    return true;
  };
  const sharedFor = (at) => {
    const entry = shared[listName(at)]?.[at.name];
    return Boolean(entry) && (!entry.pairs || entry.pairs.includes(at.pair));
  };
  const expectedFor = (at) => Object.entries(expected.records ?? {}).find(([, record]) =>
    (record[listName(at)] ?? []).includes(at.name) && (!record.pairs || record.pairs.includes(at.pair)))?.[0] ?? null;
  const unexpected = [];
  const seenExpected = new Map();
  const seenShared = new Set();
  for (const diff of compared.diffs) {
    if (sharedFor(diff)) {
      const label = `shared ${listName(diff)} ${diff.name}`;
      if (!pinned(label, shared[listName(diff)][diff.name], diff)) { unexpected.push(diff); continue; }
      seenShared.add(`${label}|${diff.pair}`);
      continue;
    }
    const record = expectedFor(diff);
    const values = expectedValues.records?.[record];
    if (!record || !pinned(`#${record}`, expected.records[record], diff)
      || (values && (!values.differences?.length || !pinned(`#${record} values`, values, diff, true)))) { unexpected.push(diff); continue; }
    const names = seenExpected.get(record) ?? new Set();
    names.add(`${diff.kind}:${diff.name}`);
    seenExpected.set(record, names);
  }
  const unusedPins = (label, entry) => (entry.differences ?? []).flatMap((pin, index) => (pin.personas ?? [])
    .flatMap((persona) => (pin.variants ?? []).map((variant) => [persona, variant]))
    .filter(([persona, variant]) => !pinUse.has(`${label}|${index}|${persona}|${variant}`))
    .map(([persona, variant]) => `${label} pin ${pin.pair} ${persona} ${variant}${pin.name ? ` ${pin.name}` : ""}`));
  const stale = [];
  const unpinnedRecords = [];
  for (const [record, entry] of Object.entries(expected.records ?? {})) {
    if (!entry.differences?.length) unpinnedRecords.push(`#${record}`);
    const seen = seenExpected.get(record) ?? new Set();
    for (const name of entry.functions ?? []) if (!seen.has(`function:${name}`)) stale.push(`#${record} function ${name}`);
    for (const name of entry.tables ?? []) if (!seen.has(`table:${name}`)) stale.push(`#${record} table ${name}`);
    stale.push(...unusedPins(`#${record}`, entry));
    if (expectedValues.records?.[record]) stale.push(...unusedPins(`#${record} values`, expectedValues.records[record]));
  }
  // A shared entry is used on every pair it names (or on some pair, when it
  // names none), and each of its pins by every persona and variant it names; a
  // shared difference that stops appearing fails like a stale record entry.
  const unusedShared = [];
  const unpinnedShared = [];
  for (const list of ["functions", "tables"]) {
    for (const [name, entry] of Object.entries(shared[list] ?? {})) {
      if (name.startsWith("_")) continue;
      const label = `shared ${list} ${name}`;
      const pairs = entry.pairs ?? [];
      const missing = pairs.length ? pairs.filter((pair) => !seenShared.has(`${label}|${pair}`))
        : [...seenShared].some((key) => key.startsWith(`${label}|`)) ? [] : ["any pair"];
      unusedShared.push(...missing.map((pair) => `${label} on ${pair}`), ...unusedPins(label, entry));
      if (!entry.differences?.length) unpinnedShared.push(label);
    }
  }
  const waivers = unreachable.functions ?? {};
  const unlisted = [];
  const changed = [];
  for (const [signature, roles] of Object.entries(unreached)) {
    const waiver = waivers[signature];
    if (!waiver) { unlisted.push(signature); continue; }
    const want = Object.fromEntries(Object.entries(waiver).filter(([role]) => role !== "reason"));
    if (JSON.stringify(Object.keys(want).sort()) !== JSON.stringify(Object.keys(roles).sort())
      || Object.entries(roles).some(([role, refusals]) => JSON.stringify(refusals) !== JSON.stringify([...(want[role] ?? [])].sort()))) {
      changed.push({ signature, listed: want, observed: roles });
    }
  }
  const reachable = Object.keys(waivers).filter((signature) => !unreached[signature]);
  // A contract whose target never varied between two runs of the same world
  // is no longer needed, and fails like any stale entry.
  const used = new Set(compared.contracted ?? []);
  const unusedContracts = Object.keys(volatile.targets ?? {}).filter((target) => !used.has(target));
  // A function whose answers were settled by a not-proven rule is reported
  // as not proven: it must be on the not-proven list under #8359 (as
  // unreached, or in unreachable.json's reached-but-not-proven list), or the
  // run fails; a listed reached function no rule settled any more fails too.
  const notProven = [...new Set((compared.notProven ?? []).map((at) => at.signature))].sort();
  const reachedNotProven = unreachable.notProven ?? {};
  const provenAnyway = notProven.filter((signature) => !waivers[signature] && !reachedNotProven[signature]);
  const staleNotProven = Object.keys(reachedNotProven).filter((signature) => !notProven.includes(signature));
  // A reached function no neighbour call could fail is listed as untested
  // with its reason; one missing from the list, or listed and no longer
  // untested (or no longer reached), fails.
  const listedUntested = unreachable.untested ?? {};
  const untestedSignatures = Object.keys(untested).filter((signature) => !unreached[signature]).sort();
  const untestedUnlisted = untestedSignatures.filter((signature) => !listedUntested[signature]);
  const staleUntested = Object.keys(listedUntested).filter((signature) => !untestedSignatures.includes(signature));
  return {
    notProven, untested: untestedSignatures,
    unexpected, stale, unusedShared, unpinnedShared, unpinnedRecords, unlisted, changed, reachable, unusedContracts, provenAnyway, staleNotProven, untestedUnlisted, staleUntested,
    unstable: compared.unstable.map((at) => at.key), inconclusive: compared.inconclusive.map((at) => at.key), truncated: compared.truncated.map((at) => at.key),
  };
}

// The state controls of a probe batch (foreignRowStateControls in the
// database proof) record one outcome per call: { signature, pair, persona,
// variant: "own" | "neighbour", answered, changed, answer }. `changed` says
// whether the call changed a row on the caller's own side (read before the
// call and after it, before its rollback); `answer` is what it returned.
// A refused call proves nothing about rows (one statement, rolled back to
// its savepoint), and a count pooled over a batch let one answered writer,
// or one pair, cover another (a review note and the deciding read of
// batch 40). So, per signature and per pair, an own-argument call must
// answer, unless the shard's stateControls[signature].refusedPairs names
// that pair with its reason (the pair has no persona allowed to call it);
// a declared pair that answers is stale, and one with no recorded
// own-argument call at all proves no refusal, nor does
// one where any persona of the pair has none: `pairs` is either
// the pair names, where a pair's personas are those with any outcome for the
// signature there, or { pair: [personas] }, naming them. A neighbour-argument call may
// refuse: across organizations that is the isolation answer. A signature
// declared { effect: "writes" } must change an own row on every answered
// own call and never answer in a refusal shape; { effect: "reads" } must
// change nothing and answer something that is not refusal-shaped. Returns
// one line per gap, in signature then pair order.
export function stateControlGaps(shard, outcomes, pairs) {
  const pairNames = Array.isArray(pairs) ? pairs : Object.keys(pairs);
  const declared = shard.stateControls ?? {};
  const gaps = [];
  for (const signature of Object.keys(declared)) {
    if (!Object.hasOwn(shard.functions, signature)) gaps.push(`${signature}: state control declared for a signature the shard does not probe`);
  }
  for (const signature of Object.keys(shard.functions)) {
    const control = declared[signature] ?? {};
    const refused = control.refusedPairs ?? {};
    if (control.effect !== undefined && control.effect !== "writes" && control.effect !== "reads") {
      gaps.push(`${signature}: unknown effect ${JSON.stringify(control.effect)}`);
    }
    for (const pair of Object.keys(refused)) {
      if (!pairNames.includes(pair)) gaps.push(`${signature} ${pair}: refusal declared for an unknown pair`);
    }
    for (const pair of pairNames) {
      const ownCalls = outcomes.filter((outcome) => outcome.signature === signature && outcome.pair === pair
        && outcome.variant === "own");
      const answered = ownCalls.filter((outcome) => outcome.answered);
      if (Object.hasOwn(refused, pair)) {
        if (typeof refused[pair] !== "string" || refused[pair].trim().length < 20) gaps.push(`${signature} ${pair}: a declared refusal needs its reason`);
        if (ownCalls.length === 0) gaps.push(`${signature} ${pair}: declared refused, but no own-argument call was recorded`);
        else {
          const personas = Array.isArray(pairs) ? [...new Set(outcomes.filter((outcome) => outcome.signature === signature
            && outcome.pair === pair).map((outcome) => outcome.persona))] : pairs[pair];
          for (const persona of personas.filter((name) => !ownCalls.some((outcome) => outcome.persona === name))) {
            gaps.push(`${signature} ${pair}: declared refused, but ${persona} has no recorded own-argument call`);
          }
        }
        if (answered.length > 0) gaps.push(`${signature} ${pair}: declared refused, but ${answered.map((outcome) => outcome.persona).join(", ")} answered with own arguments`);
        continue;
      }
      if (answered.length === 0) {
        gaps.push(`${signature} ${pair}: no answered own-argument call`);
        continue;
      }
      for (const outcome of answered) {
        const at = `${signature} ${pair} ${outcome.persona}`;
        if (control.effect === "writes" && outcome.changed !== true) gaps.push(`${at}: the own answer changed no own row (a no-op)`);
        if (control.effect === "reads" && outcome.changed !== false) gaps.push(`${at}: a reader changed an own row, or none was read`);
        if (control.effect !== undefined && refusalShaped(outcome.answer, control.effect)) gaps.push(`${at}: the own answer is refusal-shaped`);
      }
    }
  }
  return gaps;
}

// An answer that reports success but says nothing happened: a status such
// as already_undone, accepted or eligible false, or figures held back by a
// privacy floor. A reader's null is one too; a writer's void or null is
// not (its own-row change is checked instead).
export function refusalShaped(answer, effect) {
  if (answer === null || answer === undefined) return effect === "reads";
  if (typeof answer !== "object" || Array.isArray(answer)) return false;
  if (answer.accepted === false || answer.eligible === false || answer.locked === true || answer.figures?.locked === true) return true;
  return typeof answer.status === "string" && /^(already_|not_|blocked|denied|unavailable)/.test(answer.status);
}
