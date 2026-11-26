// @vitest-environment node
// Events wave — UB-EVT-05 (scan confirmation + stable refusal tokens) and
// UB-EVT-06 (five-hat authoring, cancel/restore/delete). Pins the security and
// behaviour shape of 20260809080000_events_wave.sql.
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql, stripComments } from "./helpers/migration.js";

// Text pins are a tripwire, not a proof: they assert what THIS MIGRATION SAYS,
// not what the database ENDS UP WITH. A later create-or-replace can supersede
// every guard below and this file stays green. Current-state truth lives in
// scripts/db-contract.json, checked by `npm run verify:db`.
//
// Superseded BY this migration (so the older files' pins are historical, not
// current): create_member_event / update_member_event / get_admin_events from
// 20260723182000_admin_event_management.sql and its notifications-wave
// re-emission, rsvp_to_event / check_in_to_event / request_event_checkin_token
// from the 20260725170000 generation, and scan_event_checkin from
// 20260723140000_member_event_scan_checkin.sql.

const sql = loadMigrationSql("20260809080000_events_wave.sql");
// Every NEGATIVE pin runs against executable SQL only: this migration's header
// spells out, in prose, several of the strings the negatives forbid ("no
// 'president' string appears", "the admin hat alone"), so a raw-text negative
// would fail for a comment or, worse, be satisfied by one.
const live = stripComments(sql);

// The five staff hats that may author an event. The President hat rides the
// 'vp' key (STAFF_TOOL_ROLES in src/lib/staffPlanes.js), which is why
// 'president' is not among them and must never be added here.
const MANAGE_ROLES = ["steward", "coordinator", "advisor", "vp", "admin"];

// The six authoring entry points that moved from the admin-only gate to the
// shared predicate. Missing one is exactly the drift that PR #715 shipped.
const AUTHORING_FUNCTIONS = [
  "public.create_member_event(",
  "public.update_member_event(",
  "public.get_admin_events(",
  "public.cancel_member_event(",
  "public.restore_member_event(",
  "public.delete_member_event(",
];

// Every function this migration defines, in file order.
const DEFINED_FUNCTIONS = [
  "private.member_can_manage_events(",
  "public.create_member_event(",
  "public.update_member_event(",
  "public.cancel_member_event(",
  "public.restore_member_event(",
  "public.delete_member_event(",
  "public.get_admin_events(",
  "public.rsvp_to_event(",
  "public.check_in_to_event(",
  "public.request_event_checkin_token(",
  "public.scan_event_checkin(",
];

describe("the five-hat authoring predicate", () => {
  it("exists exactly once, as a stable definer with a pinned empty search_path", () => {
    // One predicate, six call sites: a second definition (or a create-or-
    // replace bolted on later in the same file) would reintroduce the drift
    // the single function exists to prevent.
    expect(live.match(/create (or replace )?function private\.member_can_manage_events/g)).toHaveLength(1);
    const body = fnBody(sql, "private.member_can_manage_events(");
    expect(body).toContain("returns boolean");
    expect(body).toContain("stable");
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = ''");
  });

  it("names exactly the five staff hats and never 'president'", () => {
    const body = fnBody(sql, "private.member_can_manage_events(");
    expect(body).toContain("public.member_has_role(array['steward', 'coordinator', 'advisor', 'vp', 'admin'])");
    const roles = [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(roles).toEqual(MANAGE_ROLES);
    // The President hat IS the vp key. A 'president' literal would be a role
    // slug member_roles cannot hold, so the gate would silently never match it.
    expect(live.toLowerCase(), "'president' is not a role slug — the vp key carries that hat").not.toContain("president");
  });

  it("is revoked from public, anon, authenticated AND service_role", () => {
    // authenticated matters most (PostgREST would otherwise expose a private-
    // schema probe of the caller's hats), but service_role is pinned too so a
    // future edit cannot leave the predicate directly callable by anyone.
    expect(sql).toContain(
      "revoke all on function private.member_can_manage_events() from public, anon, authenticated, service_role;",
    );
  });
});

describe("the six authoring entry points", () => {
  for (const fn of AUTHORING_FUNCTIONS) {
    it(`${fn.replace("public.", "").replace("(", "")} gates on the shared predicate`, () => {
      const body = fnBody(sql, fn);
      expect(body).toContain("not private.member_can_manage_events()");
      expect(body).toContain("errcode = '42501'");
    });
  }

  it("leaves no admin-only event gate anywhere in the executable SQL", () => {
    expect(live, "the admin-only gate must be gone from every authoring path").not.toMatch(
      /member_has_role\(\s*array\[\s*'admin'\s*\]\s*\)/,
    );
  });
});

describe("the scan surface keeps its steward-only gate", () => {
  it("still refuses anyone who is not a steward", () => {
    const scan = fnBody(sql, "public.scan_event_checkin(");
    // Widening who may SCAN is deliberately not part of this wave: the scanner
    // mints points for two people at once.
    expect(scan).toContain("not public.member_has_role(array['steward'])");
    expect(scan, "the authoring predicate must not leak into the scan gate").not.toContain(
      "member_can_manage_events",
    );
  });

  it("stamps every refusal with its stable DETAIL token, and only those seven", () => {
    const scan = fnBody(sql, "public.scan_event_checkin(");
    const tokens = [
      "scan_not_steward",
      "scan_code_missing",
      "scan_event_cancelled",
      "scan_code_invalid",
      "scan_code_used",
      "scan_code_expired",
      "scan_code_self",
    ];
    for (const token of tokens) {
      // Paired with the raise, not merely present: a token in a returned
      // payload or a comment would not reach the client as `details`.
      expect(scan, `${token} must be raised, not just mentioned`).toMatch(
        new RegExp(`raise exception[^;]*detail = '${token}'`),
      );
    }
    // Exactly these — the client lookup table has no entry for a new spelling,
    // so a renamed or extra token degrades to the English fallback silently.
    const found = [...stripComments(scan).matchAll(/detail = '([a-z_]+)'/g)].map((m) => m[1]);
    expect(found.slice().sort()).toEqual(tokens.slice().sort());
  });

  it("returns the SCANNED member's name, resolved from member_profiles", () => {
    const scan = fnBody(sql, "public.scan_event_checkin(");
    expect(scan).toContain("select p.full_name into scanned_name");
    expect(scan).toContain("from public.member_profiles p where p.id = tok.user_id");
    expect(scan).toContain("'memberName', scanned_name");
    // The steward's own name on the confirmation card would defeat the point:
    // it must identify the person whose code was just redeemed.
    expect(scan, "the name must not be looked up for the caller").not.toMatch(
      /member_profiles p where p\.id = caller/,
    );
  });
});

describe("cancellation is a soft state", () => {
  it("adds both columns and joins them to the member column grant", () => {
    expect(live).toContain("add column cancelled_at timestamptz");
    expect(live).toContain("add column cancelled_reason text");
    expect(sql).toContain(
      "grant select (cancelled_at, cancelled_reason) on public.member_events to authenticated;",
    );
  });

  it("keeps reminder_notice_sent_at and check_in_code out of every grant", () => {
    // The reminder stamp is scheduler bookkeeping; the SG- code awards points
    // on self-check-in. Neither belongs in a member-reachable column list.
    expect(live).not.toMatch(/grant select \([^)]*reminder_notice_sent_at[^)]*\)/);
    expect(live).not.toMatch(/grant select \([^)]*check_in_code[^)]*\)/);
  });

  it("refuses a member-facing write against a cancelled event, with a stable token", () => {
    for (const fn of ["public.rsvp_to_event(", "public.check_in_to_event(", "public.request_event_checkin_token("]) {
      const body = fnBody(sql, fn);
      expect(body, `${fn} must read the cancelled flag`).toContain("cancelled_at");
      expect(body, `${fn} must refuse a cancelled event`).toContain("if ev.cancelled_at is not null then");
      expect(body, `${fn} must carry the event_cancelled token`).toMatch(
        /raise exception[^;]*detail = 'event_cancelled'/,
      );
    }
  });

  it("refuses to edit a cancelled event rather than silently restranding its RSVPs", () => {
    const body = fnBody(sql, "public.update_member_event(");
    expect(body).toContain("if ev.cancelled_at is not null then");
    expect(body).toContain("restore it before editing");
  });
});

describe("cancel / restore are idempotent", () => {
  it("cancel no-ops on an already-cancelled event and reports changed:false", () => {
    const body = fnBody(sql, "public.cancel_member_event(");
    expect(body).toContain("if ev.cancelled_at is not null then");
    // A second cancel must not fire a second notification burst at the same
    // RSVPs, so the early return has to precede the update AND the fan-out.
    expect(body).toContain("return pg_catalog.jsonb_build_object('id', p_id, 'cancelled', true, 'changed', false);");
    expect(body.indexOf("'changed', false")).toBeLessThan(body.indexOf("update public.member_events"));
    expect(body.indexOf("'changed', false")).toBeLessThan(body.indexOf("notify_member"));
    expect(body).toContain("'changed', true");
  });

  it("restore no-ops on a live event and reports changed:false before notifying", () => {
    const body = fnBody(sql, "public.restore_member_event(");
    expect(body).toContain("if ev.cancelled_at is null then");
    expect(body).toContain("return pg_catalog.jsonb_build_object('id', p_id, 'cancelled', false, 'changed', false);");
    expect(body).toContain("set cancelled_at = null, cancelled_reason = null");
    // The no-op return must precede the fan-out, so restoring an already-live
    // event cannot tell anybody anything.
    expect(body.indexOf("'changed', false")).toBeLessThan(body.indexOf("notify_member"));
  });

  it("restore tells the people the cancellation reached", () => {
    // Silence was the original design and it was wrong: the cancellation
    // notice has already gone out, so a silent restore leaves every 'going'
    // member believing the event is off while the database says it is on.
    const body = fnBody(sql, "public.restore_member_event(");
    expect(body).toContain("perform private.notify_member(m.user_id, 'event.restored', '{}'::jsonb, 'events')");
    expect(body).toContain("where rv.event_id = p_id and rv.status = 'going' and rv.user_id <> caller");
    // Exception-fenced for the same reason cancel's is: outbound plumbing must
    // never fail the restore itself.
    expect(body).toContain("raise warning 'event.restored notify failed");
    expect(sql).toContain("('event.restored', 'en',");
    expect(sql).toContain("('event.restored', 'es',");
  });

  it("the cancel fan-out is exception-fenced", () => {
    const body = fnBody(sql, "public.cancel_member_event(");
    expect(body).toContain("perform private.notify_member(m.user_id, 'event.cancelled', '{}'::jsonb, 'events')");
    expect(body).toContain("where rv.event_id = p_id and rv.status = 'going' and rv.user_id <> caller");
    // Outbound plumbing must never fail the cancellation itself — a
    // half-cancelled event is worse than a silent one.
    expect(body).toContain("when others then");
    expect(body).toContain("raise warning 'event.cancelled notify failed");
  });

  it("seeds the event.cancelled copy in both shipped languages", () => {
    expect(live).toContain("('event.cancelled', 'en',");
    expect(live).toContain("('event.cancelled', 'es',");
    expect(live).toContain("on conflict (key, lang) do update");
  });
});

describe("hard delete is refused once anyone attended", () => {
  it("counts check-ins and raises event_has_attendance BEFORE any delete", () => {
    const body = fnBody(sql, "public.delete_member_event(");
    expect(body).toContain("from public.member_event_checkins where event_id = p_id");
    expect(body).toContain("if attended > 0 then");
    expect(body).toMatch(/raise exception[^;]*detail = 'event_has_attendance'/);
    // Textual order is the guarantee: a guard that ran after the delete would
    // destroy the one artefact that cannot be reconstructed.
    const guard = body.indexOf("public.member_event_checkins");
    const refusal = body.indexOf("event_has_attendance");
    const removal = body.indexOf("delete from public.member_events");
    expect(guard).toBeGreaterThan(-1);
    expect(removal).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(removal);
    expect(refusal).toBeLessThan(removal);
  });

  it("locks the row and audits the delete before removing it", () => {
    const body = fnBody(sql, "public.delete_member_event(");
    expect(body).toContain("for update;");
    expect(body).toContain("'delete_event'");
    expect(body.indexOf("'delete_event'")).toBeLessThan(body.indexOf("delete from public.member_events"));
  });
});

describe("the re-emitted functions keep their inherited behaviour", () => {
  it("create_member_event still fans out event.created, exception-fenced", () => {
    const body = fnBody(sql, "public.create_member_event(");
    expect(body).toContain("perform private.notify_member(m.id, 'event.created', '{}'::jsonb, 'events')");
    expect(body).toContain("where p.id <> caller");
    expect(body).toContain("when others then");
    expect(body).toContain("raise warning 'event.created notify failed");
    // The rest of the 20260809020000 generation must survive the re-emission.
    expect(body).toContain("pg_advisory_xact_lock");
    expect(body).toContain("'create_event'");
  });

  it("update_member_event still resets the reminder and announces a reschedule", () => {
    const body = fnBody(sql, "public.update_member_event(");
    expect(body).toContain("if 'starts_at' = any(changed) then");
    // A moved event owes its RSVPs a fresh 24h reminder; dropping this reset
    // would silently suppress it for exactly the changed events.
    expect(body).toContain("update public.member_events set reminder_notice_sent_at = null where id = p_id;");
    expect(body).toContain("perform private.notify_member(m.user_id, 'event.rescheduled', '{}'::jsonb, 'events')");
    expect(body).toContain("raise warning 'event.rescheduled notify failed");
    expect(body).toContain("'update_event'");
  });

  it("get_admin_events still returns the code and now the cancellation state", () => {
    const body = fnBody(sql, "public.get_admin_events(");
    expect(body).toContain("'checkInCode', e.check_in_code");
    expect(body).toContain("'cancelledAt', e.cancelled_at");
    expect(body).toContain("'cancelledReason', e.cancelled_reason");
    expect(body).toContain("stable");
  });
});

describe("audit kinds and grants", () => {
  it("widens the action CHECK to a strict superset of the nine prior kinds", () => {
    expect(live).toContain("drop constraint if exists member_admin_audit_action_check");
    const constraint = live.slice(
      live.indexOf("add constraint member_admin_audit_action_check"),
      live.indexOf(";", live.indexOf("add constraint member_admin_audit_action_check")),
    );
    const prior = [
      "grant_role",
      "revoke_role",
      "create_event",
      "update_event",
      "reset_mfa",
      "claim_reward",
      "grant_reward",
      "revoke_reward",
      "fulfill_reward",
    ];
    const added = ["cancel_event", "restore_event", "delete_event"];
    const values = [...constraint.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    // A DROP-then-ADD rewrites the whole allow-list: any prior kind omitted
    // here would make its existing audit rows unwritable from that point on.
    for (const action of prior) expect(values, `${action} must survive the rewrite`).toContain(action);
    for (const action of added) expect(values, `${action} must be added`).toContain(action);
    expect(values.slice().sort()).toEqual([...prior, ...added].sort());
  });

  it("revokes the three new RPCs from public/anon and grants them to authenticated", () => {
    for (const signature of [
      "public.cancel_member_event(text, text)",
      "public.restore_member_event(text)",
      "public.delete_member_event(text)",
    ]) {
      expect(sql).toContain(`revoke all on function ${signature} from public, anon;`);
      expect(sql).toContain(`grant execute on function ${signature} to authenticated;`);
    }
  });
});

describe("every function this migration defines", () => {
  it("declares exactly the eleven expected functions", () => {
    const declared = [...live.matchAll(/create\s+(?:or\s+replace\s+)?function\s+([a-z_]+\.[a-z_]+)\s*\(/g)].map(
      (m) => `${m[1]}(`,
    );
    expect(declared).toEqual(DEFINED_FUNCTIONS);
  });

  for (const fn of DEFINED_FUNCTIONS) {
    it(`${fn.replace("(", "")} is security definer with a pinned empty search_path`, () => {
      const body = fnBody(sql, fn);
      const header = body.slice(0, body.indexOf("as $$"));
      expect(header).toContain("security definer");
      // An unpinned search_path on a definer is the schema-shadowing hole the
      // whole repo pins against; it must be set in the HEADER, not the body.
      expect(header).toContain("set search_path = ''");
    });
  }
});
