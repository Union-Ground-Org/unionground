// @vitest-environment node
import { describe, expect, it } from "vitest";
import { loadMigrationSql, stripComments } from "./helpers/migration.js";

// Text pins are a tripwire, not a proof: they assert what THIS MIGRATION SAYS
// (the rewards grant/claim/revoke machinery), not what the database ENDS UP
// WITH. Current-state truth is scripts/db-contract.json via `npm run
// verify:db`, whose entries for these objects land in the same commit.
//
// The machinery, in one migration: a tier-gated catalog table, a grant
// ledger with one-live-grant-per-member+item, a member claim RPC behind the
// MFA step-up, three admin RPCs behind member_has_role(array['admin']) with
// required reasons, an admin queue reader, RLS select-own/select-active, and
// four new audited action kinds. Claiming spends nothing — a tier check,
// never a point price.

const sql = stripComments(loadMigrationSql("member_reward_grants"));

describe("rewards grant/claim/revoke migration", () => {
  it("gates the member claim behind the MFA step-up and a tier check", () => {
    expect(sql).toContain("create function public.claim_reward(p_item_key text, p_note text default null)");
    expect(sql).toContain("private.mfa_satisfied()");
    expect(sql).toContain("private.member_tier_of(caller) < item.min_tier");
    // No point price anywhere: the claim never touches the points ledger.
    expect(sql).not.toMatch(/insert into public\.member_point_events/);
    expect(sql).not.toMatch(/points\s*-\s*|deduct|spend/i);
  });

  it("gates every admin mutation behind the admin role with a required reason", () => {
    for (const fn of ["grant_reward", "revoke_reward", "fulfill_reward", "get_admin_reward_queue"]) {
      const body = sql.slice(sql.indexOf(`create function public.${fn}`));
      expect(body, `${fn} missing the admin gate`).toContain("member_has_role(array['admin'])");
    }
    expect([...sql.matchAll(/a reason is required/g)]).toHaveLength(2);
    expect(sql).toContain("char_length(clean_reason) not between 1 and 500");
  });

  it("holds one live grant per member and item, revoke freeing the slot", () => {
    expect(sql).toContain("create unique index member_reward_grants_live_uniq on public.member_reward_grants (user_id, item_key) where status <> 'revoked'");
  });

  it("audits all four mutations under the widened action vocabulary", () => {
    expect(sql).toContain("add constraint member_admin_audit_action_check");
    for (const action of ["'claim_reward'", "'grant_reward'", "'revoke_reward'", "'fulfill_reward'"]) {
      expect(sql).toContain(action);
    }
    expect([...sql.matchAll(/insert into public\.member_admin_audit/g)]).toHaveLength(4);
  });

  it("locks both tables down to RLS SELECT for clients", () => {
    expect(sql).toContain("alter table public.member_reward_items enable row level security");
    expect(sql).toContain("alter table public.member_reward_grants enable row level security");
    expect(sql).toContain("create policy member_reward_items_select_active");
    expect(sql).toContain("create policy member_reward_grants_select_own");
    expect(sql).toContain("(select auth.uid()) = user_id");
    expect(sql).toContain("revoke all on public.member_reward_items from anon, authenticated");
    expect(sql).toContain("revoke all on public.member_reward_grants from anon, authenticated");
    // grant select ONLY — a write privilege would bypass "no client can
    // write a redemption directly".
    expect(sql).not.toMatch(/grant\s+(insert|update|delete|all)[^;]*on public\.member_reward_/i);
  });

  it("pins the definer hygiene and the schema reload", () => {
    expect([...sql.matchAll(/security definer/g)].length).toBeGreaterThanOrEqual(6);
    expect([...sql.matchAll(/set search_path = ''/g)].length).toBeGreaterThanOrEqual(6);
    expect(sql).toContain("revoke all on function private.member_tier_of(uuid) from public, anon, authenticated");
    expect(sql).toContain("notify pgrst, 'reload schema'");
  });

  it("advances fulfillment along the honest ladder only", () => {
    expect(sql).toContain("when g.fulfillment = 'ship' and g.status in ('claimed', 'granted') then 'shipped'");
    expect(sql).toContain("when g.fulfillment = 'ship' and g.status = 'shipped' then 'delivered'");
    expect(sql).toContain("when g.fulfillment in ('instant', 'event') and g.status in ('claimed', 'granted') then 'delivered'");
    expect(sql).toContain("grant is not advanceable");
  });

  it("seeds only fulfillable items — no cosmetic skin/ai rows the app cannot apply", () => {
    const seed = sql.slice(sql.indexOf("insert into public.member_reward_items"));
    expect(seed).toContain("'sg-thermos'");
    expect(seed).toContain("'sg-hoodie'");
    expect(seed).not.toMatch(/'skin'|'ai'/);
  });
});
