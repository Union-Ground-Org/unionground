# COMMENT ON POLICY rationale

**Enforced by:** `npm run verify:conventions` (`scripts/verify-repository-conventions.mjs`, the "Repository conventions" step of the `conventions-and-lint` job in `.github/workflows/ci.yml`)
**Baseline:** [`config/migration-conventions-baseline.json`](../../config/migration-conventions-baseline.json)
**Adopted:** November 11, 2026, with the checker.

## The rule

Row Level Security is this repository's authorization boundary (`docs/contracts/README.md`).
Every `create policy` **and every material `alter policy`** in a migration
added after the baseline must be accompanied, **in the same migration**, by a
`comment on policy` that says who the policy admits and why that is correct.

A change is *material* when it changes who is admitted or what they see: a
replaced `using` predicate, a replaced `with check` predicate, or a different
role list. `alter policy … rename to` is the one exception — it moves the
identifier and leaves the same rows visible to the same roles, so there is no
new decision to explain and no rationale is demanded.

Widening an existing policy is the change most worth explaining and the one
least visible in review: `alter policy staff_read on public.things using (true)`
is shorter than the predicate it replaces and removes every tenancy bound the
original had. It fails this check without a rationale.

An example already in the tree
(`20260907110000_knowledge_conversion_provenance.sql`):

```sql
create policy mfa_assurance on public.organization_knowledge_conversions
  as restrictive for all to authenticated
  using ((select private.mfa_satisfied())) with check ((select private.mfa_satisfied()));

comment on policy mfa_assurance on public.organization_knowledge_conversions is
  'Repository-wide restrictive overlay: a session that has not satisfied its MFA assurance level reads no row of this table regardless of role, matching every other tenant table.';
```

The comment answers the question a reviewer, an incident responder and a future
migration author all ask first: *why is this row visible to this role?* A policy
predicate says what happens. It does not say what was intended, so it cannot be
compared against intent when the two drift.

## What the check enforces

- Each policy a new migration **creates** has a matching
  `comment on policy <name> on <table> is '…'` in that file.
- Each policy a new migration **materially alters** has one too, under the
  same key. A rename-only alter is exempt, by the definition above.
- The rationale is at least twenty characters — a placeholder is not rationale.
- **Every** `comment on policy` a new migration writes contains **no protected
  data** — not only the ones paired with a create. Schema comments are readable
  by every role that can read the catalog, so an email address, a UUID or a
  phone number in a policy comment is a disclosure, including in a comment
  added to a policy an earlier migration created. The check rejects all three
  by pattern.
- The SQL is read with a lexer, not a pattern: strings, dollar-quoted bodies and
  nested block comments are opaque, so a commented-out policy is not a live
  one, and a rationale hidden in a string is not a rationale. Policy DDL inside a
  `DO` block, a function body or an `EXECUTE` string is refused, as is an
  `EXECUTE` of anything but one constant string, an `E''` string or a `U&`
  identifier. Write policy DDL and its rationale as top-level statements.

## The baseline

When this repository adopted the check, 125 of its 652 migrations created or
altered a policy without a rationale, or used SQL the rule cannot read. Most of
them were written before the rule existed.
`config/migration-conventions-baseline.json` lists them under
`policyCommentExempt`, so the rule binds new work without demanding a rewrite of
applied history nobody would review honestly.

The baseline is a record, not a waiver mechanism. Adding a filename to it is a
conspicuous one-line diff that has to be argued for in the pull request, and the
check fails if it names a migration that no longer exists. Retro-commenting the
historical policies is follow-up work, done by adding new `comment on policy`
statements in a new migration — never by editing an applied one.

## Related

- [`migration-naming.md`](migration-naming.md) — identifiers, ordering and repair.
