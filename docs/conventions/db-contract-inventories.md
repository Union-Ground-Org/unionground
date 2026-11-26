# Database contract inventories

`scripts/db-contract.json` selects `policyCoverage.rlsTableFormat: "table-files-v1"`.
Each reviewed public RLS table has one regular file beside it at
`scripts/db-contract-tables/public.<table>.json`, containing only
`{"table":"public.<table>"}`. Add or remove that file with the migration.
The live checker compares identities in both directions and still checks RLS
on every public table and the restrictive policy on every RLS table. A missing,
empty or malformed folder fails. Only a contract without a format marker uses
the legacy positive count; deployed exports read the contract and files from
the same verified Git source, relative to the exported `DB_CONTRACT_PATH`.

`scripts/lib/db-contract-inventories.mjs` defines the complete identity keys:
functions by canonical named signature with normalized whitespace; policies and
constraints/indexes by qualified table plus name (forbidden policies by name
pattern); grants by qualified table plus role and, for column grants, privilege;
triggers by schema/table/name; schema usage by schema/role; publication entries
by schema/table; role settings by role; cron by job name. String inventories use
their exact identity (unqualified public relation names receive `public.`).
The comparator uses `<`/`>` on these ASCII identities, independent of locale.
`verify-repository-conventions.mjs` prints an unsorted entry's insertion point.
The sorting helper preserves entry property order and every narrative/SQL
needle array, including `_readme` and `knownGaps._readme`.

Feature checks require their own named tables in the non-empty inventory.
Grant checks inspect every privilege string; FK checks retain their migration
digest, derived graph equality and live identity comparisons. The renumber
helper reports totals from these inventories and edits no shared numeric pin.
Adding a required DB proof needs no floor edit: proofs are discovered, and
retirement floors stay fixed.

## Reproducible conflict comparison

Exact base and independent before/after fixtures are in
`tests/fixtures/db-contract-merge/comparison.json`. Each scenario starts a new
Git repository at its documented base, creates A and B from that same commit,
applies only that branch's fixture, commits it, then runs
`git merge-tree --write-tree <A> <B>`. Replay from the checkout:

```sh
npx vitest run tests/db-contract-merge-comparison.test.js --maxWorkers=2
```

The old layout merges cleanly with a total of three while the combined catalog
has four tables. The table-file layout merges cleanly with four exact identities
and no shared-total edit. Two sorted function entries inserted between the same
neighbours still conflict in `scripts/db-contract.json`; the third scenario
retains and verifies that conflict. This comparison makes no pairwise fleet
conflict-rate claim.
