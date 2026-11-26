// @vitest-environment node
//
// UB-DESK-01 steward desk paging: text pins over the six list/KPI RPCs and
// five keyset indexes in 20260809040000_steward_desk_paging.sql, plus the
// matching scripts/db-contract.json pins. Text pins are a tripwire, not a
// proof (see staff-planes.test.js): they assert what THIS MIGRATION SAYS;
// current-state truth lives in the contract, checked by `npm run verify:db`.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fnBody, loadMigrationSql } from "./helpers/migration.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sql = loadMigrationSql("steward_desk_paging");
const contract = JSON.parse(readFileSync(join(repoRoot, "scripts/db-contract.json"), "utf8"));

// name → the argument list its grant/revoke statements are written with.
const FN_SIGS = {
  list_steward_requests: "text, text, text, timestamptz, uuid, integer",
  list_steward_conversations: "text, text, timestamptz, uuid, integer",
  list_steward_thread_messages: "uuid, timestamptz, uuid, integer",
  list_steward_forms: "text, text, text, timestamptz, uuid, integer",
  list_steward_broadcasts: "text, text, timestamptz, text, integer",
  get_steward_desk_kpis: "",
};

describe("steward desk paging RPC security shape", () => {
  for (const [name, args] of Object.entries(FN_SIGS)) {
    it(`${name} is a steward-gated invoker with an empty search_path`, () => {
      const body = fnBody(sql, name);
      // Invoker on purpose: RLS stays the single visibility authority; the
      // explicit role gate turns a non-steward into 42501, never an empty
      // page indistinguishable from a quiet chapter.
      expect(body).toContain("security invoker");
      expect(body).toContain("set search_path = ''");
      expect(body).toContain("not public.member_has_role(array['steward'])");
      expect(body).toContain("errcode = '42501'");
    });

    it(`${name} is revoked from public/anon and granted to authenticated + service_role`, () => {
      expect(sql).toContain(`revoke all on function public.${name}(${args}) from public, anon;`);
      expect(sql).toContain(`grant execute on function public.${name}(${args}) to authenticated, service_role;`);
    });
  }
});

describe("closed-set validations raise 22023 — a typo'd filter never degrades to 'all'", () => {
  it("requests validate the status set and both sort directions", () => {
    const body = fnBody(sql, "list_steward_requests");
    expect(body).toContain("if p_status not in ('all', 'open', 'requested', 'acknowledged', 'closed') then");
    expect(body).toContain("if p_sort not in ('newest', 'oldest') then");
    expect(body).toContain("errcode = '22023'");
  });

  it("conversations validate the awaiting filter", () => {
    const body = fnBody(sql, "list_steward_conversations");
    expect(body).toContain("if p_filter not in ('all', 'awaiting') then");
    expect(body).toContain("errcode = '22023'");
  });

  it("forms validate the reviewable status pair and the oldest-first sort set", () => {
    const body = fnBody(sql, "list_steward_forms");
    expect(body).toContain("if p_status not in ('all', 'submitted', 'in_review') then");
    expect(body).toContain("if p_sort not in ('oldest', 'newest') then");
    expect(body).toContain("errcode = '22023'");
  });

  it("broadcasts validate the active/retracted filter", () => {
    const body = fnBody(sql, "list_steward_broadcasts");
    expect(body).toContain("if p_filter not in ('all', 'active', 'retracted') then");
    expect(body).toContain("errcode = '22023'");
  });

  it("a half-supplied cursor raises 'incomplete cursor' in every pager with a NOT NULL key", () => {
    // Forms is deliberately absent: submitted_at is nullable there, so a
    // cursor with a null timestamp is a REAL position (the nulls-last
    // region), not a malformed one.
    for (const name of ["list_steward_requests", "list_steward_conversations", "list_steward_thread_messages", "list_steward_broadcasts"]) {
      expect(fnBody(sql, name), `${name} must guard the half cursor`).toContain("raise exception 'incomplete cursor' using errcode = '22023';");
    }
    expect(sql.split("incomplete cursor").length - 1).toBe(4);
  });

  it("the thread pager refuses a null conversation id", () => {
    expect(fnBody(sql, "list_steward_thread_messages")).toContain("raise exception 'conversation required' using errcode = '22023';");
  });
});

describe("page-size clamps mirror the JS callers so a full page can never look short", () => {
  const clamps = {
    list_steward_requests: "least(greatest(coalesce(p_limit, 100), 1), 100)",
    list_steward_conversations: "least(greatest(coalesce(p_limit, 50), 1), 100)",
    list_steward_thread_messages: "least(greatest(coalesce(p_limit, 50), 1), 200)",
    list_steward_forms: "least(greatest(coalesce(p_limit, 50), 1), 100)",
    list_steward_broadcasts: "least(greatest(coalesce(p_limit, 20), 1), 100)",
  };
  for (const [name, clamp] of Object.entries(clamps)) {
    it(`${name} clamps to ${clamp}`, () => {
      expect(fnBody(sql, name)).toContain(clamp);
    });
  }
});

describe("keyset walks are (timestamp, id) row comparisons", () => {
  it("requests page both directions over (created_at, id)", () => {
    const body = fnBody(sql, "list_steward_requests");
    expect(body).toContain("(r.created_at, r.id) < (p_after_created, p_after_id)");
    expect(body).toContain("(r.created_at, r.id) > (p_after_created, p_after_id)");
    expect(body).toContain("order by r.created_at desc, r.id desc");
    expect(body).toContain("order by r.created_at asc, r.id asc");
  });

  it("conversations walk (updated_at, id) by recency", () => {
    const body = fnBody(sql, "list_steward_conversations");
    expect(body).toContain("(c.updated_at, c.id) < (p_after_updated, p_after_id)");
    expect(body).toContain("order by c.updated_at desc, c.id desc");
  });

  it("thread messages walk backward through (created_at, id)", () => {
    const body = fnBody(sql, "list_steward_thread_messages");
    expect(body).toContain("(m.created_at, m.id) < (p_before_created, p_before_id)");
    expect(body).toContain("order by m.created_at desc, m.id desc");
  });

  it("broadcasts walk (published_at, id)", () => {
    const body = fnBody(sql, "list_steward_broadcasts");
    expect(body).toContain("(b.published_at, b.id) < (p_after_published, p_after_id)");
    expect(body).toContain("order by b.published_at desc, b.id desc");
  });

  it("forms keep explicit nulls-last branches — submitted_at is the one nullable key", () => {
    const body = fnBody(sql, "list_steward_forms");
    // A plain row comparison would silently drop a null-keyed row mid-walk.
    expect(body).toContain("or f.submitted_at is null");
    expect(body).toContain("order by f.submitted_at asc nulls last, f.id asc");
    expect(body).toContain("order by f.submitted_at desc nulls last, f.id desc");
  });
});

describe("search semantics", () => {
  it("escapes every LIKE wildcard in the needle — '%' is never an operator a steward can type", () => {
    const escapePin = "replace(replace(replace(needle, '\\', '\\\\'), '%', '\\%'), '_', '\\_')";
    // Requests, conversations, forms, broadcasts. The thread pager takes no
    // search — a thread window is already one conversation.
    expect(sql.split(escapePin).length - 1).toBe(4);
  });

  it("member search goes through the RLS-checked member_profiles full_name", () => {
    for (const name of ["list_steward_requests", "list_steward_conversations", "list_steward_forms"]) {
      expect(fnBody(sql, name), `${name} must match on the profile name`).toContain("pr.full_name ilike pattern");
    }
  });

  it("broadcast search matches title or body", () => {
    expect(fnBody(sql, "list_steward_broadcasts")).toContain("b.title ilike pattern or b.body ilike pattern");
  });

  it("the forms base predicate agrees with the RLS inbox pair", () => {
    expect(fnBody(sql, "list_steward_forms")).toContain("f.status in ('submitted', 'in_review')");
  });
});

describe("keyset indexes", () => {
  it("ships all five composite (timestamp, id) indexes replayably", () => {
    expect(sql).toContain("create index if not exists member_steward_requests_created_id_idx");
    expect(sql).toContain("on public.member_steward_requests (created_at, id);");
    expect(sql).toContain("create index if not exists member_conversations_updated_id_idx");
    expect(sql).toContain("on public.member_conversations (updated_at, id);");
    expect(sql).toContain("create index if not exists member_messages_convo_created_id_idx");
    expect(sql).toContain("on public.member_messages (conversation_id, created_at, id);");
    expect(sql).toContain("create index if not exists member_broadcasts_published_id_idx");
    expect(sql).toContain("on public.member_broadcasts (published_at, id);");
    expect(sql).toContain("create index if not exists member_forms_inbox_submitted_id_idx");
  });

  it("keeps the forms index partial over the reviewable pair the pager reads", () => {
    expect(sql).toContain("on public.member_forms (submitted_at, id) where status in ('submitted', 'in_review');");
  });
});

describe("db-contract pins", () => {
  const fnBySig = new Map(contract.functions.map((entry) => [entry.sig, entry]));
  const idxByName = new Map(contract.indexes.map((entry) => [entry.name, entry]));

  const CONTRACT_SIGS = [
    "public.list_steward_requests(p_status text, p_search text, p_sort text, p_after_created timestamp with time zone, p_after_id uuid, p_limit integer)",
    "public.list_steward_conversations(p_filter text, p_search text, p_after_updated timestamp with time zone, p_after_id uuid, p_limit integer)",
    "public.list_steward_thread_messages(p_conversation_id uuid, p_before_created timestamp with time zone, p_before_id uuid, p_limit integer)",
    "public.list_steward_forms(p_status text, p_search text, p_sort text, p_after_submitted timestamp with time zone, p_after_id uuid, p_limit integer)",
    "public.list_steward_broadcasts(p_filter text, p_search text, p_after_published timestamp with time zone, p_after_id text, p_limit integer)",
    "public.get_steward_desk_kpis()",
  ];

  for (const sig of CONTRACT_SIGS) {
    it(`pins ${sig.slice("public.".length, sig.indexOf("("))} as a role-gated invoker with the exec pair`, () => {
      const entry = fnBySig.get(sig);
      expect(entry, `contract must pin ${sig}`).toBeDefined();
      // Invoker, not definer: RLS remains the visibility authority. The one
      // exception is the broadcast pager (#7664, ruling at gate stage
      // 155): it must list a publisher's own notices outside its member
      // audience, so it is a definer that restates both member_broadcasts
      // read policies for every other row (pinned below).
      expect(entry.secdef).toBe(sig.startsWith("public.list_steward_broadcasts("));
      expect(entry.exec).toBe("authenticated,service_role");
    });
  }

  it("keeps the definer broadcast pager to the member read policies plus the caller's own notices", () => {
    const entry = fnBySig.get("public.list_steward_broadcasts(p_filter text, p_search text, p_after_published timestamp with time zone, p_after_id text, p_limit integer)");
    const policies = new Map(contract.policies.filter((row) => row.table === "member_broadcasts" && row.cmd === "r").map((row) => [row.name, row]));
    expect([...policies.keys()].sort()).toEqual(["chapter_notice_container_scope", "member_broadcasts_read_authenticated"]);
    expect(policies.get("member_broadcasts_read_authenticated").qual).toContain("private.visible_member_broadcast_ids()");
    expect(policies.get("chapter_notice_container_scope").qual).toContain("private.chapter_scope_member_allowed(chapter_id, access_unit_id, access_committee_id,");
    expect(entry.bodyContains).toEqual(expect.arrayContaining([
      "b.organization_id = desk_org",
      "b.created_by is not null and b.created_by = caller",
      "b.id in (select private.visible_member_broadcast_ids())",
      "private.chapter_scope_member_allowed(b.chapter_id, b.access_unit_id, b.access_committee_id, caller)",
    ]));
  });

  it("pins all five keyset indexes with their live catalog definitions", () => {
    const expected = {
      member_steward_requests_created_id_idx: ["USING btree (created_at, id)"],
      member_conversations_updated_id_idx: ["USING btree (updated_at, id)"],
      member_messages_convo_created_id_idx: ["USING btree (conversation_id, created_at, id)"],
      member_broadcasts_published_id_idx: ["USING btree (published_at, id)"],
      member_forms_inbox_submitted_id_idx: [
        "USING btree (submitted_at, id)",
        "WHERE (status = ANY (ARRAY['submitted'::text, 'in_review'::text]))",
      ],
    };
    for (const [name, needles] of Object.entries(expected)) {
      const entry = idxByName.get(name);
      expect(entry, `contract must pin index ${name}`).toBeDefined();
      for (const needle of needles) {
        expect(entry.defContains, `${name} must pin "${needle}"`).toContain(needle);
      }
    }
  });
});

// sol F7 follow-up (20260809050000): page-scoped broadcast read counts — the
// newest-20 aggregate silently dropped counts for paged/searched broadcasts.
describe("broadcast read counts follow-up (sol F7)", () => {
  const followUp = loadMigrationSql("broadcast_read_counts_for");

  it("is a steward-gated definer scoped to the page's own ids", () => {
    // Definer on purpose: member_broadcast_receipts is self-scoped RLS, so an
    // invoker aggregate would count at most the caller's own receipt.
    expect(followUp).toContain("security definer");
    expect(followUp).toContain("set search_path = ''");
    expect(followUp).toContain("not public.member_has_role(array['steward'])");
    expect(followUp).toContain("errcode = '42501'");
    expect(followUp).toContain("between 1 and 100 broadcast ids");
    expect(followUp).toContain("errcode = '22023'");
    expect(followUp).toContain("b.id = any(p_broadcast_ids)");
    expect(followUp).toContain("order by b.published_at desc");
    expect(followUp).toContain("revoke all on function public.get_broadcast_read_counts_for(text[]) from public, anon");
    expect(followUp).toContain("grant execute on function public.get_broadcast_read_counts_for(text[]) to authenticated, service_role");
  });

  it("carries its db-contract entry as a definer with the steward-gate needle", () => {
    const entry = contract.functions.find((fn) => fn.sig === "public.get_broadcast_read_counts_for(p_broadcast_ids text[])");
    expect(entry).toBeDefined();
    expect(entry.secdef).toBe(true);
    expect(entry.exec).toBe("authenticated,service_role");
    expect(entry.bodyContains).toContain(
      // REQ-UG-OFFICER-NOTICES-WITH-READ-RECEIPTS-20261030 widened
      // the gate to the roles that may publish notices.
      "private.member_has_chapter_role(private.current_member_chapter(), array['steward', 'admin', 'vp'])",
    );
  });
});
