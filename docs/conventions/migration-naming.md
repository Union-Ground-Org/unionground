# Migration naming, ordering, collision and repair

**Enforced by:** `npm run verify:conventions` (`scripts/verify-repository-conventions.mjs`, the "Repository conventions" step of the `conventions-and-lint` job in `.github/workflows/ci.yml`)
**Baseline:** [`config/migration-conventions-baseline.json`](../../config/migration-conventions-baseline.json)
**Adopted:** November 11, 2026, with the checker.

## The rule in force

Every file in `supabase/migrations/` is named:

```
<14-digit UTC timestamp>_<snake_case_slug>.sql
YYYYMMDDHHMMSS_short_description_of_the_change.sql
```

Every migration in the tree follows it, and `npm run verify:conventions` refuses
any that does not.

> **This inverts the donor convention on purpose.** The donor repository's
> `docs/conventions/migration-version-naming.md` *banned* timestamp prefixes and
> `scripts/lint-migrations.mjs` enforced that ban. Restoring that rule would
> condemn every migration this repository has. The timestamp prefix is not an
> accident here: `supabase migration new` generates it, and Supabase's remote
> `supabase_migrations.schema_migrations` table is keyed on the fourteen-digit
> version, so the name on disk *is* the applied identity.

### Identifier rules

- Exactly fourteen digits. The first eight are a **real calendar date**
  (`20260931_…` is rejected, not rounded).
- The last six are a **sequence position, not a clock reading.** Several
  migrations in the tree use values that are not valid times, such as
  `…026000`, `…156000` or `…240000`, because a repair reserves ordering space
  between two existing migrations rather than pretending to know what time it
  was. The check validates the date half as a date and the ordering half as an
  ordering. Do not "fix" those names.
- The slug is lowercase `a-z`, `0-9` and single underscores, and says what the
  migration does, not which ticket asked for it.
- Identifiers are **unique**. Two files sharing a fourteen-digit prefix is a hard
  failure: the remote history table cannot hold both.
- Slugs are unique too. A repaired migration gets a *new* slug
  (`..._retry`, `..._repair`, `..._followup`), because a duplicated slug makes
  the remote history unreadable at exactly the moment someone is reading it to
  recover. Four historical files repeat a slug; they are listed under
  `duplicateSlugExempt` in the baseline and are not renamed.

### Ordering

Fixed-width timestamps mean lexicographic order **is** applied order, and
`npm run verify:conventions` reads the comparison base's migration inventory
from exact Git objects. It uses an ancestor `CONVENTIONS_BASE_REF` or `CI_BASE_SHA`
when supplied (CI passes the pull request's base commit in `CI_BASE_SHA`),
otherwise the merge base of HEAD with `origin/main`. Missing or unresolvable
history fails closed; fetch `origin/main` before running the check. The
verifier never fetches or moves a ref itself.

Every added filename must have a version strictly greater than the base maximum.
Duplicate versions and reuse of a base version (even after removing or renaming
its old file) fail. On a push to `main`, an out-of-order version that two
merged pull requests produced is printed as a warning instead, because it is
already history; re-use of a version still fails there.

Generate a migration with `npx supabase migration new <slug>` rather than by
hand, so the timestamp comes from the clock instead of from a copied filename.

### Collisions

Two branches that each add a migration can produce timestamps that interleave.
The number is a *sequence position*, not a claim about wall-clock authorship, so:

1. The branch that merges second **renames its file** to a timestamp after the
   new tip of `main`. Keep the same slug.
2. If the migration was already applied to a local or disposable database under
   the old name, reset that database (`npm run supabase:reset`) rather than
   editing history in the schema-migrations table.
3. Never renumber a migration that has been applied to a hosted database. See
   the repair rules below instead.

`npm run verify:migrations` is the companion check: it compares the on-disk
sequence against the recorded history.

### Repair rules

Migrations are **forward-only** once applied anywhere that is not disposable.

- **Not yet applied anywhere** — edit the file in place.
- **Applied to a local or disposable database only** — edit the file, then
  `npm run supabase:reset` and replay from zero. A partial replay is not
  evidence.
- **Applied to a hosted database** — never edit, never renumber, never delete.
  Add a new migration with a later timestamp that corrects the state, and say in
  its header comment which migration it repairs and what the old one left behind.

### Atomic migrations

Every migration added after the baseline begins with `begin;` (or
`start transaction;`) and ends with `commit;` (or `end;`), so a failed
statement leaves the database exactly as it was. The check reads the SQL with a
lexer, not a pattern, so a `commit;` inside a comment or a string does not
count, and it refuses an interior `COMMIT`, `END`, `ROLLBACK` or `ABORT`, a
nested `BEGIN`, and every prepared-transaction form. `SAVEPOINT`,
`ROLLBACK TO SAVEPOINT` and `RELEASE SAVEPOINT` are allowed inside the one
outer transaction. Older migrations keep the shape they were applied with.

### Hosted search path

Hosted runners can execute migrations with `search_path = ''`. Qualify
application objects in predecessor checks, including the strings passed to
`to_regprocedure`, `to_regclass`, and `regclass` casts. For example, use
`pg_catalog.to_regprocedure('public.some_function(uuid)')` and
`'public.some_table'::pg_catalog.regclass`. An unqualified application name can
resolve to NULL or fail even when the object exists. Compare predecessor hashes
with `IS DISTINCT FROM` so missing objects still refuse the migration.

## The baseline

`config/migration-conventions-baseline.json` freezes what `supabase/migrations`
held when this repository adopted the check: 652 files, the last
`20261019224500`. Most of them were written before these rules existed.
Everything already on `main` is historical to the
check anyway; the baseline records which files predate each rule, so a reader
can see the debt without running anything.

The baseline is a record, not a waiver mechanism. Adding a filename to it is a
conspicuous one-line diff that has to be argued for in the pull request, and the
check fails if it names a migration that no longer exists.

### Hosted search path

Hosted runners can execute migrations with `search_path = ''`. Qualify
application objects in predecessor checks, including the strings passed to
`to_regprocedure`, `to_regclass`, and `regclass` casts. For example, use
`pg_catalog.to_regprocedure('public.some_function(uuid)')` and
`'public.some_table'::pg_catalog.regclass`. An unqualified application name can
resolve to NULL or fail even when the object exists. Compare predecessor hashes
with `IS DISTINCT FROM` so missing objects still refuse the migration.

`npx vitest run tests/hosted-migration-empty-search-path.test.js` runs the
lifecycle migration's predecessor guard in disposable PostgreSQL, substituting
only expected digests for small catalog fixtures. It covers the empty path,
each missing or changed predecessor, function overloads, and qualified/unqualified relation
resolution. The catalog fixtures never execute application bodies or contact a
hosted database.

## Related

- [`rls-policy-comments.md`](rls-policy-comments.md) — the rationale a new
  security-relevant policy must carry.
- [`provenance.md`](provenance.md) — the shape a new reference or content table
  must have.
