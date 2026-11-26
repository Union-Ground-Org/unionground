// @vitest-environment node
// REQ-UG-INTAKE-QUEUE-EMAIL-THE-OPT-IN-LIST-20261118: offline pins on
// what the topic update migration says. The live proof is
// tests/intake-topic-send-db.test.js; the live catalog is scripts/db-contract.json.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(new URL("../supabase/migrations/20261119120000_intake_topic_update_email.sql", import.meta.url), "utf8");

function body(name) {
  const start = SQL.indexOf(`create function ${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const ends = ["\n$$;", "\n$function$;"].map((tag) => SQL.indexOf(tag, start)).filter((at) => at > 0);
  return SQL.slice(start, Math.min(...ends));
}

const OPERATOR = [
  "public.intake_topic_send_overview",
  "public.begin_intake_topic_test_send",
  "public.finish_intake_topic_test_send",
  "public.queue_intake_topic_send",
];
const DRAIN = ["public.claim_intake_topic_send_batch", "public.finish_intake_topic_send_delivery", "public.release_intake_topic_send_deliveries"];
const SERVICE_ONLY = [...OPERATOR, ...DRAIN, "public.confirm_public_interest_unsubscribe"];
const HELPERS = [
  "private.intake_topic_recipients",
  "private.intake_topic_update_content",
  "private.intake_topic_send_row",
  "private.intake_topic_send_settle",
];

// Gate round 1, r1s1/r2s3: one read of the recipient set per list send.
function functionBody(name) {
  const start = SQL.indexOf(`create function ${name}(`);
  return SQL.slice(start, SQL.indexOf("\n$$;", start));
}

describe("topic update email migration", () => {
  it("runs in one transaction and replaces only the shared limiter, to admit the unsubscribe operation", () => {
    expect(SQL).toMatch(/^begin;$/m);
    expect(SQL.trimEnd().endsWith("commit;")).toBe(true);
    expect([...SQL.matchAll(/create or replace function ([a-z_.]+)/gi)].map((match) => match[1]))
      .toEqual(["private.consume_public_interest_submission_limit"]);
    // Its own two new tables (row level security) and the limiter's operation check; the one drop is that check.
    expect(SQL).not.toMatch(/alter table (?!private\.intake_topic_send(s|_recipients) |private\.public_interest_submission_limits\n)/i);
    expect([...SQL.matchAll(/\bdrop\s+[^\n]*/gi)].map((match) => match[0]))
      .toEqual(["drop constraint public_interest_submission_limits_operation_check;"]);
  });

  it("keeps the shared limiter's body and adds exactly one operation to it and to its check", () => {
    const previous = readFileSync(new URL("../supabase/migrations/20260930040000_union_catalog_claims_verification.sql", import.meta.url), "utf8");
    const slice = (text) => {
      const start = text.indexOf("create or replace function private.consume_public_interest_submission_limit(");
      return text.slice(start, text.indexOf("\n$$;", start));
    };
    const before = slice(previous);
    const after = slice(SQL);
    expect(after).toBe(before.replace("       'claim-confirm-network-15m'\n", "       'claim-confirm-network-15m',\n       'unsubscribe-network-15m'\n"));
    const check = SQL.slice(SQL.indexOf("add constraint public_interest_submission_limits_operation_check"));
    const operations = [...check.slice(0, check.indexOf(");")).matchAll(/'([a-z0-9-]+)'/g)].map((match) => match[1]);
    expect(operations).toEqual([
      "network-15m", "email-interest-day", "stop-network-15m", "stop-email-day",
      "claim-network-hour", "claim-email-day", "claim-org-day", "claim-confirm-network-15m", "unsubscribe-network-15m",
    ]);
    expect(SQL).toMatch(/revoke all on function private\.consume_public_interest_submission_limit\(text, text, integer, interval\)\s+from public, anon, authenticated, service_role;/);
  });

  it("checks the service role first in every public function, and an intake_review operator in every operator function", () => {
    for (const name of SERVICE_ONLY) {
      const text = body(name);
      expect(text, name).toContain("auth.jwt() ->> 'role'), '') <> 'service_role'");
      expect(text, name).toMatch(/security definer\s+set search_path = ''/);
    }
    for (const name of OPERATOR) {
      const text = body(name);
      expect(text.indexOf("perform private.intake_review_require_operator(p_operator_user_id, p_operator_session_id);"), name)
        .toBeGreaterThan(text.indexOf("service_role"));
    }
  });

  it("chooses Union Ground's own landing opt-ins for the topic, one per address, never a suppressed one", () => {
    const text = body("private.intake_topic_recipients");
    for (const needle of [
      "s.organization_id is null", "s.source = 'public-landing'", "s.interest = p_topic", "distinct on (s.email)",
      "private.public_interest_suppressions", "private.public_interest_suppression_scope(r.email)",
    ]) expect(text).toContain(needle);
    const claim = body("public.claim_intake_topic_send_batch");
    for (const needle of ["s.organization_id is null", "private.public_interest_suppression_scope(candidate.email)", "set state = 'skipped', email = null"]) {
      expect(claim).toContain(needle);
    }
  });

  it("needs the same operator's delivered test of the same content within 24 hours, and one list send per topic per Eastern day", () => {
    const text = body("public.queue_intake_topic_send");
    for (const needle of [
      "test_send.kind <> 'test'", "test_send.operator_user_id <> p_operator_user_id",
      "test_send.content_sha256 <> content.content_sha256", "test_send.sent_count <> 1",
      "test_send.created_at <= moment - interval '24 hours'", "'refusal', 'test-required'", "'refusal', 'already-sent-today'",
    ]) expect(text).toContain(needle);
    expect(SQL).toMatch(/create unique index intake_topic_sends_one_list_per_topic_day\s+on private\.intake_topic_sends \(topic, eastern_day\)\s+where kind = 'list';/);
    expect(SQL).toContain("today date := (pg_catalog.now() at time zone 'America/New_York')::date;");
    expect(body("public.begin_intake_topic_test_send")).toContain(">= 10 then");
  });

  it("drains in bounded batches, never retries an unknown outcome and stops after three attempts", () => {
    const claim = body("public.claim_intake_topic_send_batch");
    expect(claim).toContain("wanted not between 1 and 50");
    expect(claim).toContain("for update of r skip locked");
    expect(claim).toContain("where r.state = 'sending' and r.leased_until < moment");
    expect(claim).toContain("set state = 'failed', email = null");
    expect(claim).toContain("moment + interval '60 days'");
    const finish = body("public.finish_intake_topic_send_delivery");
    expect(finish).toContain("p_outcome = 'retry' and current_row.attempts < 3");
    expect(finish).toContain("delete from private.public_interest_stop_confirmations");
    expect(SQL).toContain("attempts integer not null default 0 check (attempts between 0 and 3)");
  });

  it("keeps an address in the queue only while a delivery is open, and never in the audit", () => {
    expect(SQL).toContain("(state in ('sent', 'failed', 'skipped') and email is null");
    const audit = SQL.slice(SQL.indexOf("create table private.intake_topic_sends"), SQL.indexOf("create unique index intake_topic_sends_one_list_per_topic_day"));
    expect(audit).not.toMatch(/email/);
    expect(body("private.intake_topic_send_row")).not.toMatch(/email/);
    expect(body("public.intake_topic_send_overview")).not.toMatch(/'email'/);
  });

  it("unsubscribes through the existing stop, with its own network limit and no write for an unknown token", () => {
    const text = body("public.confirm_public_interest_unsubscribe");
    // Its own operation: the stop form's stop-network-15m row is never charged by an unsubscribe post.
    expect(text).not.toContain("'stop-network-15m'");
    const limit = text.indexOf("'unsubscribe-network-15m', 300, interval '15 minutes'");
    const lookup = text.indexOf("from private.public_interest_stop_confirmations as pending");
    const stop = text.indexOf("return public.confirm_public_interest_stop(");
    expect(limit).toBeGreaterThan(0);
    expect(lookup).toBeGreaterThan(limit);
    expect(stop).toBeGreaterThan(lookup);
  });

  it("grants every public function to the service role only and keeps both tables and helpers closed", () => {
    for (const name of SERVICE_ONLY) {
      expect(SQL, name).toMatch(new RegExp(`revoke all on function ${name.replace(".", "\\.")}\\([^)]*\\) from public, anon, authenticated, service_role;`));
      expect(SQL, name).toMatch(new RegExp(`grant execute on function ${name.replace(".", "\\.")}\\([^)]*\\) to service_role;`));
    }
    for (const name of HELPERS) {
      expect(SQL, name).toMatch(new RegExp(`revoke all on function ${name.replace(".", "\\.")}\\([^)]*\\) from public, anon, authenticated, service_role;`));
      expect(SQL, name).not.toMatch(new RegExp(`grant execute on function ${name.replace(".", "\\.")}\\(`));
    }
    expect(SQL).not.toMatch(/grant [^;]* to (anon|authenticated)/);
    for (const table of ["private.intake_topic_sends", "private.intake_topic_send_recipients"]) {
      expect(SQL).toContain(`revoke all on ${table} from public, anon, authenticated, service_role;`);
      expect(SQL).toContain(`alter table ${table} force row level security;`);
    }
  });

  it("reads the recipient set once for a list send's count and its queue rows", () => {
    const text = functionBody("public.queue_intake_topic_send");
    expect(text.match(/private\.intake_topic_recipients\(/g)).toHaveLength(1);
    expect(text).toContain("queued := pg_catalog.cardinality(recipient_emails);");
    expect(text).toContain("from unnest(recipient_emails, recipient_locales) as r(email, locale);");
  });

  it("deletes a delivery's stop confirmation only when it was definitely not delivered", () => {
    const text = functionBody("public.finish_intake_topic_send_delivery");
    expect(text).toContain("p_outcome not in ('sent', 'failed', 'retry', 'unknown')");
    expect(text).toContain("if p_outcome in ('failed', 'retry') then");
  });

  // The final, r3s1/r4s1: one release call per lease for the untried tail.
  it("releases a lease's untried deliveries in one statement, giving each attempt back", () => {
    const text = functionBody("public.release_intake_topic_send_deliveries");
    expect(text).toMatch(/security definer\s+set search_path = ''/);
    expect(text).toContain("r.id = any (p_delivery_ids) and r.state = 'sending' and r.lease_token = p_lease_token");
    expect(text).toContain("attempts = r.attempts - 1");
    expect(text).toContain("not between 1 and 50");
    expect(SQL).toContain("grant execute on function public.release_intake_topic_send_deliveries(uuid, bigint[]) to service_role;");
  });

  // The final, r3s2: the send row is locked in its own statement before counting.
  it("locks the send row before it counts the send's deliveries", () => {
    const text = SQL.slice(SQL.indexOf("create function private.intake_topic_send_settle("));
    const lock = text.indexOf("perform 1 from private.intake_topic_sends as locked where locked.id = p_send_id for update;");
    expect(lock).toBeGreaterThan(0);
    expect(lock).toBeLessThan(text.indexOf("pg_catalog.count(*) filter (where r.state in ('queued', 'sending'))"));
  });
});
