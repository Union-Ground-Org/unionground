# Explicit Data API grants for new public tables

Record: `SYS-UG-REQUIRE-EXPLICIT-GRANTS-IN-MIGRATIONS-CREATING-PUBLIC-TABLES-20261022`.

From October 30, 2026, Supabase stops granting `anon`, `authenticated` and
`service_role` on new tables in the `public` schema of existing projects
([changelog](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically)).
Until an explicit `GRANT` runs, supabase-js, PostgREST and GraphQL return
permission denied. Migrations that recreate the schema (a new project, a
preview branch, a local reset) behave the same way. Existing tables keep the
grants they have.

## The rule

Every table in `public` that a change adds must grant `authenticated` and
`service_role` explicitly. `anon` is optional, so a table that deliberately
leaves anonymous access out passes. A table with no ACL at all, or one that
grants neither role, fails unless it is a documented exemption (MAIN 99
ruling, October 22, 2026, 3:42 PM ET). This is checked in the catalog of the
disposable CI stack, not by reading migration text, so savepoints, branches
that never run, renames, routine bodies and dynamic SQL cannot fool it.

- `scripts/prepare-ci-disposable-db.mjs` finds the migrations a change adds and
  edits since the comparison base (`CI_BASE_SHA`, else `WORKLIST_BASE_REF`,
  else `origin/Main`; `scripts/lib/public-table-grant-probe.mjs`). It exports
  `CI_DB_GRANT_PROBE` (`applied`, `none` or `unresolved`),
  `CI_DB_GRANT_PROBE_ADDED` and `CI_DB_GRANT_PROBE_EDITED`.
- The stack start applies the change in two phases, and never changes a
  migration byte, because the assurance digests and the statement-history
  checks compare them:
  1. The added migrations are held out of the disposable workdir copy, and the
     stack replays the history with Supabase's stock default privileges.
  2. `scripts/grant-probe-step.mjs revoke` saves `postgres`'s default table
     privileges in `public` for the three roles, revokes them and records the
     highest `pg_class` OID in the database comment.
  3. The held-back migrations are applied unchanged with
     `supabase migration up --local`.
  4. `scripts/grant-probe-step.mjs restore` puts the saved defaults back, so
     every later proof sees the stock privileges.

  The cold path is `scripts/start-disposable-db-stack.mjs`. The warm path is
  `scripts/physical-db-baseline.mjs`, after the baseline restore and Main's
  suffix. A failed step fails the start.
- `tests/public-table-grants-db.test.js` (a required DB proof) fails for every
  `public` table above the boundary whose `relacl` does not grant both
  `authenticated` and `service_role`. It also fails for an unresolved base, for
  a probe that applied migrations without recording a boundary, and for an
  edited existing migration that is not exempted. An edited migration replays
  inside the history, before the revoke, so its tables cannot be probed. The
  same file proves the four shapes that defeated SQL parsing in #5802: a grant
  rolled back to a savepoint, a grant in a branch that never runs, a renamed
  table whose name is reused, and a routine with `SET search_path` before its
  body.

All 338 public tables on SAMPLE are owned by `postgres` (read on October 22,
2026), so migrations run as `postgres` and its default privileges are the
ones to revoke.

Exemptions live in `config/migration-conventions-baseline.json`:

- `publicTableGrantExempt`: a new table that may stay ungranted, as
  `{ "migration": "<file>.sql", "table": "<name>", "reason": "<why>" }`.
- `publicTableGrantEditedExempt`: an edited existing migration whose tables a
  reviewer has checked by hand, as
  `{ "migration": "<file>.sql", "reason": "<at least 20 characters>" }`.
  Without an entry, an edited migration fails the proof.

## Review of the two October migrations (October 22, 2026)

The record named two migrations that create tables without a grant
statement. Both create tables in the `private` schema, not `public`, and both
revoke everything from the Data API roles explicitly:

- `20261012010001_production_residue_seed_lanes_unlock.sql`: creates
  `private.production_residue_root_ownership`, enables RLS, and runs
  `revoke all on table ... from public, anon, authenticated, service_role`.
- `20261013200000_rights_law_ulp_jurisdiction_windows.sql`: creates
  `private.reference_ulp_limitation_periods`, enables RLS, and runs
  `revoke all on table ... from public, anon, authenticated, service_role`.

Both tables are intentionally unexposed and never relied on the hosted
default privileges, so no follow-up grant migration is needed.

## The CI disposable stack

The stack keeps Supabase's stock default privileges for the history, so
existing tables and the database contract see exactly what they did before.
Only the tables a change adds are created with those privileges revoked, and
the defaults are restored right after. The pinned CLI (2.109.1) has no
`config.toml` switch for the new behaviour, so the probe does it directly.
