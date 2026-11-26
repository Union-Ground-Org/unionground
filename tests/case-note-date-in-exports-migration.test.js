// BUG-UG-CASE-NOTE-DATE-MISSING-FROM-EXPORTS-20261102 (#6746): the
// migration re-emits the export and the Home bootstrap with occurred_on and
// nothing else; the client read and its bootstrap shape agree.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadMigrationSql } from "./helpers/migration.js";

const name = "20261102173500_case_note_date_in_exports.sql";
const sql = readFileSync(`supabase/migrations/${name}`, "utf8");
const exportSource = (text) => {
  const match = text.match(/create or replace function private\.member_data_export_without_peer_contact\(\)[\s\S]*?\bas\s+(\$\w*\$)([\s\S]*?)\1;/i);
  if (!match) throw new Error("member export definition missing");
  return match[2];
};
const bootstrapSource = (text) => {
  const start = text.search(/create (or replace )?function public\.get_member_home_bootstrap\(/);
  return text.slice(text.indexOf("as $function$", start), text.indexOf("$function$;", start));
};

describe("case note dates in the member's exports", () => {
  it("sorts after the column it exports and applies under an empty search_path", () => {
    const files = readdirSync("supabase/migrations").filter((file) => file.endsWith(".sql")).sort();
    expect(files.indexOf(name)).toBeGreaterThan(files.indexOf("20261031010000_steward_case_notes_and_deadline_list.sql"));
    expect(sql).toMatch(/^begin;\nset local search_path = pg_catalog;$/m);
  });

  it("changes the account export only by occurredOn on each case update", () => {
    const before = exportSource(readFileSync("supabase/migrations/20260924170200_member_steward_roster_and_contact.sql", "utf8"));
    const after = exportSource(sql);
    expect(after).toContain("'id', u.id, 'body', u.body, 'occurredOn', u.occurred_on, 'createdAt', u.created_at) order by u.created_at)");
    expect(after.replace("'occurredOn', u.occurred_on, ", "")).toBe(before);
    expect(after).toMatch(/^\ndeclare\n[\s\S]*?\nbegin\n  perform private\.lock_case_graph\(array\[\(select auth\.uid\(\)\)\], array\[\]::uuid\[\]\);/);
    const review = JSON.parse(readFileSync("scripts/account-case-graph-review.json", "utf8"));
    const entry = Object.values(review).map((group) => group?.["private.member_data_export_without_peer_contact"]).find(Boolean);
    // REQ-UG-LEARNING-PERIOD-CASE-RECORDS-20261103 (20261104075000)
    // re-emits it to leave out an undone case and an undone note, and
    // nothing else.
    const learning = exportSource(readFileSync("supabase/migrations/20261104075000_learning_period_case_records.sql", "utf8"));
    expect(learning.replace(" and u.learning_undone_at is null)", ")").replace(" and c.learning_undone_at is null)", ")")).toBe(after);
    // 20261104111500 (REQ-UG-LEARNING-PERIOD-MESSAGES-NOTICES-INVITES-EXPORTS-20261103)
    // re-emits it once more, adding only the held-removal predicate; the
    // reviewed hash follows that live body.
    const newest = exportSource(readFileSync("supabase/migrations/20261104111500_learning_period_messages_notices_invites_exports.sql", "utf8"));
    expect(newest.replace(" and m.learning_removal_held_at is null", "")).toBe(learning);
    // #9263 changes only the aggregate ordering; the live review follows
    // that newest projection and keeps its case-note fields intact.
    const ordered = exportSource(loadMigrationSql("member_export_arrays_deterministic_order"));
    expect(ordered).toContain("'occurredOn', u.occurred_on");
    expect(entry.source_sha256).toBe(createHash("sha256").update(ordered).digest("hex"));
    expect(sql).toContain("revoke all on function private.member_data_export_without_peer_contact() from public, anon, authenticated, service_role;");
  });

  it("changes the Home bootstrap only by occurred_on on case updates, with the same grants", () => {
    const before = bootstrapSource(readFileSync("supabase/migrations/20261028150000_member_home_bootstrap.sql", "utf8"));
    const after = bootstrapSource(sql);
    expect(after).toContain("from (select id, case_id, user_id, body, occurred_on, created_at from public.member_case_updates where user_id = caller order by created_at limit 1000) t) end,");
    expect(after.replace(", occurred_on, created_at from public.member_case_updates", ", created_at from public.member_case_updates")
      .replace("-- select id,case_id,user_id,body,occurred_on,created_at", "-- select id,case_id,user_id,body,created_at")).toBe(before);
    expect(sql).toMatch(/function public\.get_member_home_bootstrap\(p_action_log_since timestamptz, p_resources text\[\]\)\nreturns jsonb\nlanguage plpgsql\nstable\nsecurity invoker\n/);
    expect(sql).toContain("revoke all on function public.get_member_home_bootstrap(timestamptz, text[]) from public, anon, authenticated, service_role;");
    expect(sql).toContain("grant execute on function public.get_member_home_bootstrap(timestamptz, text[]) to authenticated;");
  });

  it("reads occurred_on in the member's case-update query, which the cold Home batch leaves to the loader", () => {
    expect(readFileSync("src/lib/memberApi.js", "utf8")).toContain('const MEMBER_CASE_UPDATE_COLUMNS = ["id", "case_id", "user_id", "body", "occurred_on", "created_at"].join(",");');
    // This edition's loader reads the newest 1000 case updates itself (the
    // batch function returns the oldest 1000), so the client batch does not
    // request them; the loader's query above carries occurred_on.
    expect(readFileSync("src/lib/memberHomeBootstrap.js", "utf8")).not.toContain('"table:member_case_updates": [["select"');
  });
});
