import { expect } from "vitest";
import { POSTGREST_MAX_ROWS } from "../../src/lib/boundedPage.js";

// What PostgREST answers for a read with `limit`: never more than max_rows
// (supabase/config.toml), cut with no error. A fake client that ignores this
// lets a probe row past the ceiling look as if it arrived (#8144, Grok G7).
export function postgrestPage(rows, limit = Infinity) {
  return rows.slice(0, Math.min(limit, POSTGREST_MAX_ROWS));
}

// SILENT-TRUNCATION test kit (owner decision, Nov 10, 2026). Runs a capped list
// read against sources one short of the cap, at the cap, one past it and well
// past it, and fails when the read stops at the cap without saying more exists.
//
// `read(total)` builds a source holding `total` rows, runs the read under test
// against it and resolves to { shown, more }: how many rows it returned, and
// whether it reported that more exist (a flag, a cursor, a next-page token).
// `exactAtCap` (default true) also requires no more-exists signal when the
// source holds exactly `cap` rows; a read that only knows its page was full
// (it reports more on a full page) passes `false`.
export async function expectNoSilentTruncation({ cap, read, exactAtCap = true }) {
  const short = await read(cap - 1);
  expect(short, `${cap - 1} rows under a cap of ${cap}`).toEqual({ shown: cap - 1, more: false });

  const full = await read(cap);
  expect(full.shown, `${cap} rows under a cap of ${cap}`).toBe(cap);
  if (exactAtCap) expect(full.more, `${cap} rows under a cap of ${cap}: nothing more exists`).toBe(false);

  for (const total of [cap + 1, 2 * cap + 1]) {
    const over = await read(total);
    expect(over.shown, `${total} rows under a cap of ${cap}: at most the cap is shown`).toBeLessThanOrEqual(cap);
    expect(over.more, `${total} rows under a cap of ${cap}: the read must say more exist`).toBe(true);
  }
}
