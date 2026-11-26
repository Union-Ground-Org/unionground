import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(process.cwd(), "supabase/migrations/20260812113000_compass_ai_governance.sql");
const sql = readFileSync(migrationPath, "utf8");

function functionBody(name) {
  const match = sql.match(new RegExp(`create(?: or replace)? function public\\.${name}\\([^]*?\\$\\$([^]*?)\\$\\$;`, "i"));
  expect(match, `missing ${name}`).toBeTruthy();
  return match[1];
}

describe("Compass AI governance migration", () => {
  it("seeds a singleton disabled exact policy and role limits but no attestation", () => {
    expect(sql).toContain("create table public.compass_ai_policy");
    expect(sql).toContain("id boolean primary key default true check (id)");
    expect(sql).toMatch(/enabled boolean not null default false/);
    expect(sql).toMatch(/gateway text not null default 'vercel-ai-gateway'/);
    expect(sql).toMatch(/model text not null default 'google\/gemini-3-flash'/);
    expect(sql).toMatch(/zero_data_retention boolean not null default true/);
    expect(sql).toMatch(/disallow_prompt_training boolean not null default true/);
    expect(sql).toMatch(/insert into public\.compass_ai_policy[^;]+values\s*\(true, false,/s);

    expect(sql).toContain("create table public.compass_ai_role_limits");
    for (const role of ["member", "steward", "coordinator", "advisor", "admin", "vp"]) {
      expect(sql).toContain(`('${role}', 20)`);
    }
    expect(sql).toContain("create table public.compass_ai_provider_attestations");
    expect(sql).toContain("sequence_no bigint generated always as identity");
    expect(sql).toContain("constraint compass_ai_provider_attestations_sequence_key unique (sequence_no)");
    const schemaSeed = sql.split("create function public.get_compass_ai_governance")[0];
    expect(schemaSeed).not.toMatch(/insert into public\.compass_ai_provider_attestations/i);
  });

  it("keeps governance tables behind forced RLS and RPC-only client access", () => {
    for (const table of ["compass_ai_policy", "compass_ai_role_limits", "compass_ai_provider_attestations"]) {
      expect(sql).toContain(`alter table public.${table} enable row level security;`);
      expect(sql).toContain(`alter table public.${table} force row level security;`);
      expect(sql).toMatch(new RegExp(`revoke all on (?:table )?public\\.${table} from public, anon, authenticated;`));
      expect(sql).not.toMatch(new RegExp(`grant (?:insert|update|delete|all)[^;]*public\\.${table}[^;]*authenticated`, "i"));
    }
    expect(sql).not.toMatch(/create policy[^;]+on public\.compass_ai_(?:policy|role_limits|provider_attestations)[^;]+as permissive/i);
  });

  it("makes every admin read/write MFA-enrolled, MFA-satisfied, role-gated, locked, and audited", () => {
    const read = functionBody("get_compass_ai_governance");
    for (const name of ["set_compass_ai_enabled", "set_compass_ai_role_limit", "attest_compass_ai_provider"]) {
      const body = functionBody(name);
      expect(body).toContain("public.member_has_role(array['admin'])");
      expect(body).toContain("private.has_second_factor(caller)");
      expect(body).toContain("private.mfa_satisfied()");
      expect(body).toContain("pg_advisory_xact_lock");
      expect(body).toContain("insert into public.member_admin_audit");
    }
    expect(read).toContain("public.member_has_role(array['admin'])");
    expect(read).toContain("private.has_second_factor(caller)");
    expect(read).toContain("private.mfa_satisfied()");
    expect(sql).toMatch(/check \(status in \('verified', 'revoked'\)\)/);
    expect(sql).toContain("'set_compass_ai_enabled'");
    expect(sql).toContain("'set_compass_ai_role_limit'");
    expect(sql).toContain("'attest_compass_ai_provider'");
  });

  it("requires exact, current provider capability before enablement or reservation", () => {
    const toggle = functionBody("set_compass_ai_enabled");
    const reserve = functionBody("reserve_compass_ai_request");
    const dispatch = functionBody("authorize_compass_ai_dispatch");

    for (const body of [toggle, reserve, dispatch]) {
      expect(body).toContain("status = 'verified'");
      expect(body).toContain("expires_at > now()");
      expect(body).toContain("zero_data_retention");
      expect(body).toContain("disallow_prompt_training");
      expect(body).toContain("order by sequence_no desc");
    }
    for (const body of [reserve, dispatch]) {
      expect(body).toContain("p_gateway");
      expect(body).toContain("p_model");
      expect(body).toContain("p_zero_data_retention is true");
      expect(body).toContain("p_disallow_prompt_training is true");
      expect(body).toContain("pg_advisory_xact_lock");
    }
  });

  it("derives role limits server-side, applies the strictest multi-role cap, and preserves the shared cap", () => {
    const reserve = functionBody("reserve_compass_ai_request");
    expect(reserve).toContain("from public.member_roles");
    expect(reserve).toContain("from public.compass_ai_role_limits");
    expect(reserve).toMatch(/order by[^;]+hourly_limit asc/s);
    expect(reserve).toContain("configured_role_count <> assigned_role_count");
    expect(reserve).toContain("recent_user_count >= effective_limit");
    expect(reserve).toContain("recent_global_count >= 200");
    expect(reserve).toContain("insert into public.member_ai_requests");
    expect(reserve).not.toMatch(/p_role/i);
  });

  it("serializes every policy mutation, reservation, and dispatch on one global lock before authorization reads", () => {
    const firstAuthorizationRead = {
      set_compass_ai_enabled: "from public.compass_ai_policy",
      set_compass_ai_role_limit: "from public.compass_ai_role_limits",
      attest_compass_ai_provider: "from public.compass_ai_policy",
      reserve_compass_ai_request: "from public.compass_ai_policy",
      authorize_compass_ai_dispatch: "from public.member_ai_requests",
    };
    for (const [name, firstRead] of Object.entries(firstAuthorizationRead)) {
      const body = functionBody(name);
      const lock = body.indexOf("pg_advisory_xact_lock");
      expect(lock, `${name} must take the lock`).toBeGreaterThan(-1);
      expect(body.slice(lock)).toContain("'member-ai-global', 509");
      expect(lock, `${name} must lock before its first authorization read`).toBeLessThan(body.indexOf(firstRead));
    }
    expect(functionBody("reserve_compass_ai_request")).toContain("recent_user_count >= effective_limit");
    expect(functionBody("reserve_compass_ai_request")).toContain("recent_global_count >= 200");
  });

  it("removes all authenticated access to service reservation/dispatch RPCs", () => {
    for (const signature of [
      "public.reserve_compass_ai_request(uuid, text, text, boolean, boolean)",
      "public.authorize_compass_ai_dispatch(uuid, uuid, text, text, boolean, boolean)",
    ]) {
      expect(sql).toContain(`revoke all on function ${signature} from public, anon, authenticated;`);
      expect(sql).toContain(`grant execute on function ${signature} to service_role;`);
    }
    expect(sql).not.toMatch(/grant execute on function public\.(?:reserve_compass_ai_request|authorize_compass_ai_dispatch)[^;]+authenticated/i);
  });
});
