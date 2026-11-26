// @vitest-environment node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  assessGrantParity,
  finalFunctionGrantees,
  functionGrantEvents,
  readMigrations,
  signatureKey,
} from "../scripts/verify-db-contract-grant-parity.mjs";

// #7091: an EXECUTE grantee the contract claims must be one the migrations
// leave in force. #7071 was the contract listing service_role on the nine
// argument public.update_member_event while migration 20261104110000 granted
// only authenticated; the disposable profile's service_role normalization hid
// it from PR CI.
const scriptPath = fileURLToPath(new URL("../scripts/verify-db-contract-grant-parity.mjs", import.meta.url));
const contractPath = fileURLToPath(new URL("../scripts/db-contract.json", import.meta.url));
const migrationsPath = fileURLToPath(new URL("../supabase/migrations", import.meta.url));

const NINE_ARG_SIG = "public.update_member_event(p_id text, p_title text, p_starts_at timestamp with time zone, p_location text, p_summary text, p_check_in_code text, p_is_public boolean, p_is_public_across_agencies boolean, p_expected_version integer)";

// The statements migration 20261104110000 leaves for the nine-argument function.
const UPDATE_MEMBER_EVENT_MIGRATION = `
create or replace function public.update_member_event(p_id text, p_title text default NULL::text, p_starts_at timestamp with time zone default NULL::timestamp with time zone, p_location text default NULL::text, p_summary text default NULL::text, p_check_in_code text default NULL::text, p_is_public boolean default NULL::boolean, p_is_public_across_agencies boolean default NULL::boolean, p_expected_version integer default NULL::integer)
returns jsonb language plpgsql security definer set search_path = '' as $$ begin return '{}'::jsonb; end; $$;
revoke all on function public.update_member_event(text, text, timestamptz, text, text, text, boolean, boolean, integer) from public, anon, authenticated, service_role;
grant execute on function public.update_member_event(text, text, timestamptz, text, text, text, boolean, boolean, integer) to authenticated;
`;

const entry = (sig, exec) => ({ sig, secdef: true, exec });
const grantees = (...migrations) => finalFunctionGrantees(migrations.map((sql, index) => ({ name: `${index}.sql`, sql })));
const assess = (contractFunctions, ...migrations) => assessGrantParity(contractFunctions, grantees(...migrations));

describe("grant parity: the #7071 over-claim", () => {
  it("flags service_role on the nine-argument update_member_event when only authenticated is granted", () => {
    const result = assess([entry(NINE_ARG_SIG, "authenticated,service_role")], UPDATE_MEMBER_EVENT_MIGRATION);
    expect(result.overClaims).toEqual([
      expect.objectContaining({ sig: NINE_ARG_SIG, missing: ["service_role"], granted: ["authenticated"] }),
    ]);
  });

  it("passes the corrected entry", () => {
    expect(assess([entry(NINE_ARG_SIG, "authenticated")], UPDATE_MEMBER_EVENT_MIGRATION).overClaims).toEqual([]);
  });

  it("does not flag service_role when a migration really grants it beside authenticated", () => {
    const sql = `${UPDATE_MEMBER_EVENT_MIGRATION}
grant execute on function public.update_member_event(text, text, timestamptz, text, text, text, boolean, boolean, integer) to service_role;`;
    expect(assess([entry(NINE_ARG_SIG, "authenticated,service_role")], sql).overClaims).toEqual([]);
  });

  it("flags a role a later migration revoked", () => {
    const later = "revoke execute on function public.update_member_event(text, text, timestamptz, text, text, text, boolean, boolean, integer) from authenticated;";
    const result = assess([entry(NINE_ARG_SIG, "authenticated")], UPDATE_MEMBER_EVENT_MIGRATION, later);
    expect(result.overClaims[0].missing).toEqual(["authenticated"]);
  });
});

describe("grant parity: replaying migrations", () => {
  const create = "create function public.f(p_a uuid, b text default 'x') returns void language sql as $$ select 1 $$;";

  it("starts a new function with the default ACL, so a revoke that leaves a role alone keeps it", () => {
    const sql = `${create} revoke all on function public.f(uuid, text) from public, anon; grant execute on function public.f(uuid, text) to authenticated;`;
    expect([...grantees(sql).get("public.f(uuid, text)")].sort()).toEqual(["authenticated", "service_role"]);
  });

  it("forgets a dropped function and gives its replacement the default ACL again", () => {
    const sql = `${create} revoke all on function public.f(uuid, text) from public, anon, authenticated, service_role;
      drop function public.f(uuid, text);`;
    expect(grantees(sql).has("public.f(uuid, text)")).toBe(false);
    expect([...grantees(`${sql} ${create}`).get("public.f(uuid, text)")].sort()).toEqual(["anon", "authenticated", "public", "service_role"]);
  });

  it("keeps grants across create or replace", () => {
    const sql = `${create} revoke all on function public.f(uuid, text) from public, anon, authenticated, service_role;
      grant execute on function public.f(uuid, text) to authenticated;`;
    const replaced = `${sql} ${create.replace("create function", "create or replace function")}`;
    expect([...grantees(replaced).get("public.f(uuid, text)")]).toEqual(["authenticated"]);
  });

  it("reads multi-function statements and ignores comments and string literals", () => {
    const sql = `${create}
      -- grant execute on function public.f(uuid, text) to anon;
      select 'grant execute on function public.f(uuid, text) to public;';
      revoke all on function public.f(uuid, text), public.g() from public, anon, authenticated, service_role;
      grant all on function public.f(uuid, text) to authenticated;`;
    expect([...grantees(sql).get("public.f(uuid, text)")]).toEqual(["authenticated"]);
    expect([...grantees(sql).get("public.g()")]).toEqual([]);
  });

  it("does not treat REVOKE GRANT OPTION FOR as removing the privilege", () => {
    const sql = `${create} revoke grant option for execute on function public.f(uuid, text) from authenticated;`;
    expect(grantees(sql).get("public.f(uuid, text)").has("authenticated")).toBe(true);
  });

  it("reduces named, defaulted and parameterised arguments to type-only keys", () => {
    expect(signatureKey("public.f(p_id text, amount numeric(10, 2) default 0, VARIADIC ids uuid[])", { named: true }))
      .toBe("public.f(text, numeric(10,2), uuid[])");
    expect(signatureKey("public.f(timestamptz, double precision)")).toBe("public.f(timestamp with time zone, double precision)");
    expect(signatureKey("public.f(row_alias public.member_events)", { named: true })).toBe("public.f(member_events)");
    expect(functionGrantEvents("create function public.g(evidence timestamptz) returns void as $$ $$;")[0].key)
      .toBe("public.g(timestamp with time zone)");
  });

  it("reports a contract entry no migration statement mentions as unresolved, not as an over-claim", () => {
    const result = assess([entry("public.ghost(p_a uuid)", "authenticated")], create);
    expect(result).toMatchObject({ compared: 0, overClaims: [], unresolved: ["public.ghost(p_a uuid)"] });
  });
});

describe("grant parity: command line", () => {
  const scratch = [];
  afterEach(() => {
    while (scratch.length) rmSync(scratch.pop(), { recursive: true, force: true });
  });

  const run = (exec) => {
    const dir = mkdtempSync(join(tmpdir(), "grant-parity-"));
    scratch.push(dir);
    mkdirSync(join(dir, "migrations"));
    writeFileSync(join(dir, "migrations", "20261104110000_update_member_event.sql"), UPDATE_MEMBER_EVENT_MIGRATION);
    writeFileSync(join(dir, "contract.json"), JSON.stringify({ functions: [entry(NINE_ARG_SIG, exec)] }));
    return spawnSync(process.execPath, [scriptPath, "--contract", join(dir, "contract.json"), "--migrations", join(dir, "migrations")], { encoding: "utf8" });
  };

  it("exits 1 and names the function and the role on the #7071 contract", () => {
    const result = run("authenticated,service_role");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("update_member_event");
    expect(result.stderr).toContain("not granted: service_role");
  });

  it("exits 0 on the corrected contract", () => {
    const result = run("authenticated");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("grant parity OK");
  });
});

describe("grant parity: the committed contract and migrations", () => {
  const contract = JSON.parse(readFileSync(contractPath, "utf8"));
  const final = finalFunctionGrantees(readMigrations(migrationsPath));

  it("agree on every function entry", () => {
    const result = assessGrantParity(contract.functions, final);
    expect(result.overClaims).toEqual([]);
    expect(result.compared, "the replay found almost no functions; the statement scan has rotted").toBeGreaterThan(2000);
  });

  it("would have failed on the pre-#7071 contract state", () => {
    const current = contract.functions.find((candidate) => candidate.sig === NINE_ARG_SIG);
    expect(current.exec).toBe("authenticated");
    const overClaimed = contract.functions.map((candidate) => (candidate === current ? { ...current, exec: "authenticated,service_role" } : candidate));
    expect(assessGrantParity(overClaimed, final).overClaims.map((claim) => claim.sig)).toEqual([NINE_ARG_SIG]);
  });
});
