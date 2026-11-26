// BUG-UG-BOUNDED-CLEANUPS-CAN-TOUCH-EVERY-ROW-IN-ONE-CALL-20261113 (#8605).
//
// A bounded cleanup used to read
//   delete from T where k in (select e from T ... limit n for update skip locked);
// and the planner could re-run that subquery for every outer row, so the LIMIT
// bounded nothing. The replacement picks the keys once:
//   with picked as materialized (select e as row_key from T ... limit n ...)
//   delete from T where k in (select picked.row_key from picked);
//
// A WITH query that locks rows is never inlined, so the existing
// `with x as (... limit n for update ...)` batches already ran once and are
// not this shape.
//
// withoutRowsPickedOnce maps both spellings to one whitespace-collapsed text,
// so a pin can say "this generation is the previous one, with only the row
// pick materialized" without restating either body.
export function withoutRowsPickedOnce(sql) {
  return sql
    .replace(/\s+/g, " ")
    .replace(/\( /g, "(")
    .replace(/ \)/g, ")")
    .replace(/ picked as materialized \(/g, " picked as (")
    .replace(
      /with picked as \(select (.+?) as row_key (from .+?)\) ((?:delete from|update) .+?) in \(select picked\.row_key from picked\)/g,
      "$3 in (select $1 $2)",
    );
}

// Every `in (select ... limit ... for update ...)` left in a body: the shape
// that lets one call run past its limit.
export function unboundedLockingSubqueries(sql) {
  const text = sql.replace(/--[^\n]*/g, "").replace(/\s+/g, " ");
  const found = [];
  const open = /\bin \(\s?select\b/gi;
  for (const match of text.matchAll(open)) {
    const start = text.indexOf("(", match.index);
    let depth = 0;
    let end = start;
    for (; end < text.length; end += 1) {
      if (text[end] === "(") depth += 1;
      else if (text[end] === ")" && --depth === 0) break;
    }
    const inner = text.slice(start + 1, end);
    if (!/\blimit\b/i.test(inner) || !/\bfor (?:no key )?update\b/i.test(inner)) continue;
    // A lock inside a nested subquery of this one belongs to that subquery.
    const ownTail = inner.replace(/\((?:[^()]|\([^()]*\))*\)/g, "()");
    if (!/\blimit\b/i.test(ownTail) || !/\bfor (?:no key )?update\b/i.test(ownTail)) continue;
    found.push(inner.slice(0, 160));
  }
  return found;
}
