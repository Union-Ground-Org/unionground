import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { expectMi1OrganizationRlsContract } from "./helpers/mi1Contract.js";

const read = (path) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = read("supabase/migrations/20260727211853_full_product_completion.sql");
const contract = JSON.parse(read("scripts/db-contract.json"));

describe("full product completion", () => {
  it("ships all durable organizing and governance stores behind RLS", () => {
    for (const table of [
      "chapter_spaces", "chapter_space_members", "chapter_threads",
      "chapter_thread_posts", "member_intake_reports", "chapter_documents",
      "chapter_records", "chapter_handshakes", "chapter_governance_requests",
    ]) {
      expect(migration).toContain(`create table public.${table}`);
      expect(migration).toContain(`alter table public.${table} enable row level security`);
    }
    expect(migration).toContain("as restrictive for all to authenticated");
    expect(migration).toContain("stamp_product_identity");
  });

  it("enforces focus settings at the outbound queue", () => {
    expect(migration).toContain("apply_member_focus_to_delivery");
    expect(migration).toContain("validate_member_focus_timezone");
    expect(migration).toContain("pg_catalog.pg_timezone_names");
    expect(migration).toMatch(/grant update \(\s*dnd_enabled,\s*quiet_hours_start,\s*quiet_hours_end,\s*quiet_hours_timezone,\s*urgent_notifications_enabled\s*\) on public\.member_profiles/s);
    expect(migration).toContain("suppressed: do not disturb");
    expect(migration).toContain("suppressed: quiet hours");
    expect(migration).toContain("notification_kind in ('deadlines', 'cases')");
  });

  it("exposes topics in Messages and public legal routes", () => {
    const messages = read("src/views/MessagesView.jsx");
    const api = read("src/lib/memberApi.js");
    const legal = read("src/views/LegalView.jsx");
    const css = read("src/styles.css");
    const app = read("src/AppRouter.jsx");
    // Wave 2b: the segment tabs are gone — topics render as the always-visible
    // Channels section of the single sectioned inbox list, still sourced from
    // the threads nested under each space (never a stale top-level collection),
    // and each row opens its exact thread through onOpenTopics.
    expect(messages).toContain("data.product?.spaces");
    expect(messages).toContain(".flatMap((space) => space.threads || [])");
    expect(messages).toContain('t("inbox.channels")');
    expect(messages).toContain('item.sourceType === "channel"');
    expect(messages).toContain("onOpenTopics(item.source.id)");
    expect(messages).not.toContain("data.product?.threads");
    // The newest 1,000 posts, newest first, read one past the window so a full
    // window says where earlier posts start (#8078, channelHistory.js).
    expect(api).toContain("Promise.resolve(channelWindowRead(client)).then(channelWindow)");
    expect(read("src/features/messaging/channelHistory.js")).toContain('.order("created_at", { ascending: false }).order("id", { ascending: false })\n    .limit(cappedLimit(CHANNEL_WINDOW))');
    expect(api).toContain("threadPostRows.filter((post) => post.thread_id === thread.id).reverse()");
    expect(legal).toContain('t("legal.publicInformation")');
    expect(css).toMatch(/\.legal-page\s*\{[\s\S]*color: var\(--foreground\);[\s\S]*background: var\(--card\);/);
    for (const route of ["/about", "/privacy", "/terms", "/accessibility"]) expect(app).toContain(`"${route}"`);
  });

  it("keeps private spaces usable and lifecycle updates creator-safe", () => {
    expect(migration).toContain("or p_space.created_by = (select auth.uid())");
    for (const table of ["chapter_spaces", "chapter_documents", "chapter_records", "chapter_handshakes"]) {
      expect(migration).toContain(`create policy ${table}_staff_create`);
      expect(migration).toMatch(new RegExp(`create policy ${table}_staff_write on public\\.${table} for update`));
    }
    expect(migration).toMatch(/chapter_governance_read[\s\S]*chapter_id = private\.current_member_chapter\(\)[\s\S]*member_has_role\(array\['admin'\]\)/);
  });

  it("keeps product tables out of realtime and pins complete database metadata", () => {
    expect(migration).not.toContain("alter publication supabase_realtime add table");
    // 60 when this migration landed; 61 since 20260728221223 created
    // chapter_workstreams (RLS-enabled at birth, mfa_assurance written by its
    // own file); 70 since 20260801120000 created the seven steward-appointment
    // tables (all RLS-enabled at birth with explicit mfa_assurance policies).
    // This pin moves ONLY when a migration deliberately adds or drops an RLS
    // table and records it in the contract in the same commit.
    // Current truth includes org security, Compass, public-site, rewards,
    // invitations, unified messaging, signed email intake, and four
    // chapter-channel read/poll tables and the four explicit MI1 organization-
    // boundary tables.
    expectMi1OrganizationRlsContract(contract);
    for (const table of [
      "public.chapter_spaces", "public.chapter_space_members", "public.chapter_threads",
      "public.chapter_thread_posts", "public.member_intake_reports", "public.chapter_documents",
      "public.chapter_records", "public.chapter_handshakes", "public.chapter_governance_requests",
    ]) {
      expect(contract.tableGrants.some((entry) => entry.table === table && entry.role === "authenticated"), table).toBe(true);
    }
    expect(contract.functions.some((entry) => entry.sig === "private.validate_member_focus_timezone()")).toBe(true);
    expect(contract.triggers.some((entry) => entry.name === "chapter_thread_posts_bump_thread")).toBe(true);
  });

  it("makes audit timestamps trigger-owned and column-denied", () => {
    for (const table of [
      "chapter_spaces", "chapter_threads", "member_intake_reports",
      "chapter_documents", "chapter_handshakes", "chapter_governance_requests",
    ]) {
      expect(migration).toContain(`create trigger ${table}_touch_updated_at`);
      const updateGrant = contract.columnGrants.find((entry) => entry.table === `public.${table}` && entry.privilege === "UPDATE");
      expect(updateGrant?.denied).toContain("updated_at");
    }
  });
});
