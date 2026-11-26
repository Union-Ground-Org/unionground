// Explicit Data API grants for new public tables, checked in the catalog
// (SYS-UG-REQUIRE-EXPLICIT-GRANTS-IN-MIGRATIONS-CREATING-PUBLIC-TABLES-20261022;
// docs/conventions/public-table-grants.md).
//
// From October 30, 2026 Supabase stops granting anon, authenticated and
// service_role on new tables in the public schema. The disposable CI stack
// keeps Supabase's stock default privileges, so a migration that forgets its
// grants still works there. To reproduce the hosted behaviour for the tables a
// change adds, without altering a single migration byte (the assurance
// digests and statement-history checks compare them):
//   1. the stack starts with the change's added migrations held back;
//   2. postgres's default table privileges in public are revoked for the three
//      Data API roles and the highest pg_class OID is recorded in the database
//      comment (the migration role owns the database but may not set a custom
//      parameter on it);
//   3. the held-back migrations are applied unchanged with
//      `supabase migration up --local`;
//   4. the saved defaults are restored, so every later proof sees the stock
//      privileges.
// An edited existing migration cannot be replayed apart from its history; it is
// reported and fails the proof unless documented as an exemption.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

export const DATA_API_ROLES = Object.freeze(["anon", "authenticated", "service_role"]);
// MAIN 99 ruling, October 22, 2026, 3:42 PM ET: a new public table must grant
// authenticated and service_role; anon is optional, and a table that grants
// neither (or has no ACL at all) fails unless documented as an exemption.
export const REQUIRED_ROLES = Object.freeze(["authenticated", "service_role"]);
export const BOUNDARY_MARKER = "ci-public-table-grant-probe boundary=";
const MIGRATION_NAME = /^(\d{14})_[a-z0-9_]+\.sql$/u;
export const HELD_BACK_DIRECTORY = "grant-probe-held-back";
const PRIVILEGE_LETTERS = Object.freeze({ a: "insert", r: "select", w: "update", d: "delete", D: "truncate", x: "references", t: "trigger", m: "maintain" });

// Migration files a change adds and edits since `base`, each in version order.
// Null when the base cannot be resolved, so the caller fails closed.
export function changedMigrations(root, base) {
  if (!base) return null;
  const names = (filter) => execFileSync("git", ["diff", "--no-renames", "--name-only", `--diff-filter=${filter}`, base, "--", "supabase/migrations"],
    { cwd: root, encoding: "utf8" }).split("\n").map((path) => path.split("/").at(-1)).filter((name) => MIGRATION_NAME.test(name ?? "")).sort();
  try {
    execFileSync("git", ["cat-file", "-e", `${base}^{commit}`], { cwd: root, stdio: "ignore" });
    return { added: names("A"), edited: names("M") };
  } catch {
    return null;
  }
}

// Move the named migrations out of the disposable workdir copy (never the
// repository) so the stack starts without them; release puts them back.
export function holdBackMigrations(workdir, names) {
  const held = join(workdir, HELD_BACK_DIRECTORY);
  mkdirSync(held, { recursive: true });
  for (const name of names) {
    const from = join(workdir, "supabase", "migrations", name);
    if (!existsSync(from)) throw new Error(`grant probe: ${name} is not in the disposable workdir`);
    renameSync(from, join(held, name));
  }
}

export function releaseMigrations(workdir, names) {
  for (const name of names) renameSync(join(workdir, HELD_BACK_DIRECTORY, name), join(workdir, "supabase", "migrations", name));
}

// postgres's default table privileges in public for the three roles, as
// [{ role, privileges }], from pg_default_acl.
export async function readDefaultTableGrants(client) {
  const { rows } = await client.query(`
    select r.rolname as role, a.privilege_type as privilege
    from pg_default_acl d
    join pg_namespace n on n.oid = d.defaclnamespace
    cross join lateral aclexplode(d.defaclacl) a
    join pg_roles r on r.oid = a.grantee
    where n.nspname = 'public' and d.defaclobjtype = 'r' and pg_get_userbyid(d.defaclrole) = 'postgres'
      and r.rolname = any($1::text[])
    order by 1, 2`, [DATA_API_ROLES]);
  const byRole = new Map();
  for (const { role, privilege } of rows) byRole.set(role, [...(byRole.get(role) ?? []), privilege.toLowerCase()]);
  return [...byRole].map(([role, privileges]) => ({ role, privileges }));
}

// Step 2: revoke the defaults and record the boundary. Returns the saved
// defaults for restoreDefaultTableGrants.
export async function revokeDefaultTableGrants(client) {
  const saved = await readDefaultTableGrants(client);
  await client.query("alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated, service_role");
  await client.query(`do $ci_probe$
    declare previous text := (select shobj_description(d.oid, 'pg_database') from pg_catalog.pg_database d where d.datname = current_database());
    begin
      execute format('comment on database %I is %L', current_database(),
        '${BOUNDARY_MARKER}' || (select max(oid)::bigint::text from pg_catalog.pg_class) || coalesce('; ' || previous, ''));
    end $ci_probe$`);
  return saved;
}

// Step 4: put the saved defaults back exactly.
export async function restoreDefaultTableGrants(client, saved) {
  for (const { role, privileges } of saved) {
    if (!DATA_API_ROLES.includes(role)) throw new Error(`grant probe: unexpected role ${role}`);
    const known = privileges.filter((privilege) => Object.values(PRIVILEGE_LETTERS).includes(privilege));
    if (known.length !== privileges.length) throw new Error(`grant probe: unknown default privilege for ${role}: ${privileges.join(", ")}`);
    await client.query(`alter default privileges for role postgres in schema public grant ${known.join(", ")} on tables to ${role}`);
  }
}

// The OID boundary the probe recorded, or null when it never ran.
export async function readGrantProbeBoundary(client) {
  const { rows } = await client.query("select shobj_description(d.oid, 'pg_database') as note from pg_database d where d.datname = current_database()");
  const match = new RegExp(`${BOUNDARY_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d+)`).exec(rows[0]?.note ?? "");
  return match ? match[1] : null;
}

// Public tables created after `boundary` (an OID) whose ACL does not grant
// every required role, minus the documented exemptions.
export async function tablesMissingGrants(client, { boundary, roles = REQUIRED_ROLES, exempt = [] }) {
  const { rows } = await client.query(`
    select c.relname as table,
      coalesce(array(select distinct r.rolname from aclexplode(c.relacl) a join pg_roles r on r.oid = a.grantee
        where r.rolname = any($2::text[]) order by 1), '{}') as granted
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and c.oid > $1::bigint
    order by c.relname`, [String(boundary), roles]);
  const skip = new Set(exempt.map((entry) => entry.table));
  return rows.filter((row) => !skip.has(row.table))
    .map((row) => ({ table: row.table, missing: roles.filter((role) => !row.granted.includes(role)) }))
    .filter((row) => row.missing.length);
}
