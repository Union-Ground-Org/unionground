import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(resolve("supabase/migrations/20260810150000_reward_shipping_evidence.sql"), "utf8").toLowerCase();

describe("reward shipping evidence migration", () => {
  it("stores bounded address, carrier, tracking, and fulfillment timestamps", () => {
    for (const column of ["shipping_address", "shipping_carrier", "tracking_number", "shipped_at", "delivered_at"]) {
      expect(sql).toContain(`add column ${column}`);
    }
    expect(sql).toContain("char_length(shipping_address) between 10 and 1000");
    expect(sql).toContain("char_length(shipping_carrier) between 1 and 100");
    expect(sql).toContain("char_length(tracking_number) between 3 and 200");
  });

  it("requires address for physical claims and carrier/tracking before shipped", () => {
    expect(sql).toContain("reward shipping address is required");
    expect(sql).toContain("carrier and tracking are required");
    expect(sql).toContain("claim_reward_without_shipping_legacy");
    expect(sql).toContain("fulfill_reward_without_evidence_legacy");
    expect(sql).toContain("g.status in ('shipped', 'delivered')");
    expect(sql).toContain("when g.source = 'admin_grant' then 'granted' else 'claimed'");
  });

  it("supports an own-grant address update and enriches both scoped readers", () => {
    expect(sql).toContain("create function public.set_reward_shipping_address");
    expect(sql).toContain("g.user_id = caller");
    expect(sql).toContain("get_admin_reward_queue_without_shipping_legacy");
    expect(sql).toContain("jsonb_build_object('shippingaddress'");
  });
});
