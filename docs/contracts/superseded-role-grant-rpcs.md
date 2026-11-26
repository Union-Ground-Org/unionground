# Superseded role-grant RPCs disposition

`docs/contracts/README.md` lists every area contract.

## Superseded role-grant RPCs disposition

Binding disposition, recorded with the migration that
records it (`20260917050000_retire_superseded_role_grant_rpcs.sql`). Both
legacy RPCs below are **retired**, not deferred, and
`tests/retired-capabilities-sweep.test.js` fails if a migration or runnable
application/tooling source reintroduces either one:

- `public.grant_member_role(uuid, text, text)`
- `public.revoke_member_role(uuid, text)`

Role changes use the selected-tenant scope-aware commands
`public.set_member_organization_role` and `public.set_member_chapter_role`.
Bringing either retired RPC back requires a new reviewed product decision that
names its caller, shows why those commands are inadequate, defines the tenant
and authorization boundary, and adds regression coverage. Recreating a
`SECURITY DEFINER` function with an EXECUTE grant is not that decision.
