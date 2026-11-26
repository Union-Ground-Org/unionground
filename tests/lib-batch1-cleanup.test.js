import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { FORM_TEMPLATES } from "../src/lib/formTemplates.js";
import { NOTIFICATION_TOPIC_KEYS, loadAdminDesk, loadCoordinatorDesk, loadMemberApp } from "../src/lib/memberApi.js";

// Same generic chainable fake the other memberApi tests use, plus a recorder
// for the filter columns: the self-scope assertions below are about the query
// the loader BUILDS, not about what a permissive fake happens to return.
function fakeClient({ tables = {}, rpcs = {} } = {}, eqCalls = []) {
  return {
    from: (table) => {
      const result = tables[table] ?? { data: [], error: null };
      const proxy = new Proxy(function () {}, {
        get(_target, prop) {
          if (prop === "then") return (...args) => Promise.resolve(result).then(...args);
          if (prop === "eq") {
            return (column, value) => {
              eqCalls.push(`${table}.${column}=${value}`);
              return proxy;
            };
          }
          return () => proxy;
        },
      });
      return proxy;
    },
    rpc: (name) => Promise.resolve(rpcs[name] ?? { data: null, error: { message: `no fake for rpc ${name}` } }),
  };
}

const PROFILE = {
  id: "user-1",
  first_name: "Darnell",
  full_name: "Darnell Foster",
  initials: "DF",
  role_line: "Member",
  member_since: 2023,
  language: "en",
  notification_prefs: { deadlines: true, cases: true, forms: true, votes: true, events: true },
  chapter_id: "wor",
};

const MEMBER_RPCS = {
  get_member_rewards_summary: { data: {}, error: null },
  get_workload_stats: { data: {}, error: null },
};

const user = { id: "user-1", email: "d@example.org" };

describe("memberApi self-scoped reads (L16)", () => {
  // RLS is self-only on all seven today, but member-table SELECT policies have
  // been widened for staff roles twice already, and each of these feeds a keyed
  // Map or Set that would silently absorb another member's row (a ballot the
  // viewer never voted on rendering as "Voted"; an action the viewer never
  // took rendering as done on the weekly ring).
  it("filters every self-scoped read by the signed-in user, as the file header promises", async () => {
    const eqCalls = [];
    const client = fakeClient({ tables: { member_profiles: { data: PROFILE, error: null } }, rpcs: MEMBER_RPCS }, eqCalls);
    await loadMemberApp(client, user);
    // member_ballot_votes left this list on 2026-08-08: the boot read is gone
    // entirely (unlinkable choice storage, UB-VOTE-04) — voted state now rides
    // the member_ballot_receipts self-read below.
    for (const table of [
      "member_survey_responses",
      "member_rights_progress",
      "member_guide_threads",
      "member_guide_messages",
      "member_ballot_receipts",
      // Union Ground's own recognition events replace the points ring's
      // member_action_log feed; they credit one worker, so they stay self-scoped.
      "member_recognition_events",
    ]) {
      expect(eqCalls, `${table} is not self-scoped`).toContain(`${table}.user_id=user-1`);
    }
  });

  // The assertion above can only prove the tables it already NAMES are
  // filtered; it is blind to a new unscoped read added tomorrow. This one
  // reads the loader's own source and inverts the burden: every read in the
  // block must either carry a self filter or be named as unscoped on purpose.
  // member_action_log was exactly the read that slipped through six rounds of
  // the list-based check.
  const LOADER_SRC = (() => {
    // process.cwd(), not import.meta.url: this suite runs in jsdom, where
    // import.meta.url is not a file: URL. Same reason tests/steward-award-on-
    // ack.test.js resolves its source reads this way.
    const src = readFileSync(resolve(process.cwd(), "src/lib/memberApi.js"), "utf8");
    const start = src.indexOf("export async function loadMemberApp(");
    const end = src.indexOf('const profile = requireRow(requests[0], "Profile");', start);
    expect(start, "loadMemberApp has moved or been renamed").toBeGreaterThan(-1);
    expect(end, "the loader's Promise.all block no longer ends where expected").toBeGreaterThan(start);
    return src.slice(start, end);
  })();

  // Global catalogues and chapter-wide feeds, plus the one table whose RLS
  // predicate is two-sided (form owner OR invited cosigner) and so cannot be
  // expressed as a single equality — that is WL-05, tracked separately.
  // Adding a name here is a deliberate act; forgetting a filter is not.
  const UNSCOPED_BY_DESIGN = new Set([
    "member_broadcasts",
    "member_ballots",
    "member_surveys",
    "member_rights_lessons",
    // member_events left this list on 2026-09-02: loadMemberApp now delegates
    // to fetchMemberEventsForChapter, whose current-chapter and explicitly
    // organization-wide archives plus bounded regional discovery shapes are
    // pinned independently in member-event-scope.test.js.
    "member_form_cosigners",
    // member_form_files left this list with #8702: the loader reads it only
    // through fetchFormFilesFor, by the ids of the forms it loaded.
    "chapters",
    // form_templates left this list on 2026-08-09 (sol PR #734 F8): the
    // loader block no longer reads it directly — the whole-registry walk
    // lives in fetchAllFormTemplates above the loader, still a global
    // catalogue read by design.
    // The points catalogues (member_point_rules, member_reward_tiers,
    // member_reward_items) left this list with the points economy. The
    // recognition rules that replace them are a chapter-shared catalogue of
    // active capacity-building kinds, not a per-member feed.
    "member_recognition_rules",
    "member_kb_articles",
    // Shared chapter work is intentionally chapter-scoped by RLS rather than
    // self-scoped to one creator; the four coordination views need the same rows.
    "chapter_tasks",
    // Device-file registrations inherit the same board boundary: every
    // chapter member sees the task's file list, writes go through guarded RPCs.
    "chapter_task_files",
    // Participant RLS, not user_id, protects each private task thread.
    "chapter_task_messages",
    // Product-completion reads are chapter catalogues protected by explicit
    // chapter/participant RLS, not private rows keyed to user_id.
    "chapter_spaces",
    "chapter_threads",
    "chapter_documents",
    "chapter_records",
    "chapter_handshakes",
    // Partner targets are verified chapter bindings. The nested union_orgs
    // projection is reachable only through this RLS-scoped binding catalogue.
    "chapter_union_org_bindings",
    // These two feeds intentionally combine the member's own rows with
    // role-gated chapter/admin rows, which cannot be expressed as user_id=.
    "member_intake_reports",
    "chapter_governance_requests",
    // The chapter's workstream vocabulary is a chapter catalogue (select to
    // every chapter member under chapter RLS), like chapter_tasks above.
    "chapter_workstreams",
    // Dependency edges moved behind list_chapter_task_dependencies: the RPC
    // spends its cap only on renderable task endpoints, so no direct loader
    // table read belongs in this allowlist any more.
    // Authorized-record links and audit rows inherit the chapter board
    // boundary; neither is a private per-member feed. Task comments are loaded
    // by the separately chapter-scoped keyset reader above loadMemberApp.
    "chapter_task_attachments",
    "chapter_task_activity",
    // Ordered assignees are shared board state protected by the same
    // chapter/MFA boundary as chapter_tasks, not a private self feed.
    "chapter_task_assignments",
    // Specialized template details are shared task metadata protected by the
    // same live-task, same-chapter and MFA RLS boundary as chapter_tasks. They
    // are not a private user_id-keyed feed and expose no member identity.
    "chapter_task_template_details",
    // Full-task parent-child edges are chapter-shared like dependencies.
    "chapter_task_subtasks",
    // The watcher feed is self-private, but user_id is deliberately excluded
    // from the SELECT grant. Its own-row RLS policy is the scope boundary;
    // the client can read task_id only and therefore cannot add a user_id
    // equality filter without widening identity exposure.
    "chapter_task_watchers",
    // Resource links are message metadata, not per-user preferences. Source
    // RLS and the resource renderer's document join preserve both boundaries.
    "member_message_resources",
  ]);

  it("leaves no read in the loader block both per-user and unfiltered", () => {
    const reads = [...LOADER_SRC.matchAll(/client\.from\("([a-z_]+)"\)([^\n]*)/g)];
    // A regex that matches nothing must not pass vacuously.
    expect(reads.length).toBeGreaterThan(25);
    const offenders = reads
      .filter(([, table]) => !UNSCOPED_BY_DESIGN.has(table))
      .filter(([, table, rest]) => {
        // member_profiles is keyed by the member's own uuid as its PK, so its
        // self filter is spelled .eq("id", …) rather than user_id.
        const selfField = table === "member_profiles" ? "id"
          : ["member_saved_messages", "member_message_reminders"].includes(table) ? "owner_id"
            : table === "member_scheduled_messages" ? "actor_id"
              : "user_id";
        const selfFilter = `eq("${selfField}", user.id)`;
        return !rest.includes(selfFilter);
      })
      .map(([, table]) => table);
    expect(offenders, "per-user read without a self filter — add the filter, or name it in UNSCOPED_BY_DESIGN with a reason").toEqual([]);
  });

  it("reads no points-economy table: Union Ground has no points ring, tiers or perks", () => {
    // member_action_log fed the points ring's actionDone -> actionKeys; the
    // others are the point rules, tier ladder, perk catalogue and grants.
    for (const table of ["member_action_log", "member_point_rules", "member_reward_tiers", "member_reward_items", "member_reward_grants", "member_points_ledger"]) {
      expect(LOADER_SRC, table).not.toContain(`client.from("${table}")`);
    }
    expect(LOADER_SRC).toContain('client.rpc("get_member_recognition_summary")');
  });

  it("names no table in UNSCOPED_BY_DESIGN that the loader no longer reads", () => {
    // Keeps the allowlist from silently outliving its entries and quietly
    // excusing a future read that reuses one of these names.
    const readTables = new Set([...LOADER_SRC.matchAll(/client\.from\("([a-z_]+)"\)/g)].map((m) => m[1]));
    expect([...UNSCOPED_BY_DESIGN].filter((table) => !readTables.has(table))).toEqual([]);
  });
});

describe("demo fixture notification prefs (L08 follow-on)", () => {
  // The fixture literal had drifted off NOTIFICATION_TOPIC_KEYS — it predated
  // 'forms'. Benign at runtime only because SettingsView spreads its own
  // all-true default first, which means the drift was invisible in the UI and
  // would have stayed invisible for the next added topic too.
  it("mirrors the canonical topic list exactly", () => {
    expect(Object.keys(fallbackData.member.notificationPrefs).sort()).toEqual([...NOTIFICATION_TOPIC_KEYS].sort());
    expect(Object.values(fallbackData.member.notificationPrefs).every((value) => value === true)).toBe(true);
  });

  it("carries no restated prefs literal that could drift again", () => {
    const src = readFileSync(resolve(process.cwd(), "tests/fixtures/retired-pre-bot/src/data/fallback.js"), "utf8");
    expect(src).toContain("NOTIFICATION_TOPIC_KEYS");
    expect(src, "notificationPrefs must be derived, not restated").not.toMatch(/notificationPrefs:\s*\{/);
  });
});

describe("memberApi notification preference default (L08)", () => {
  it("derives the absent-column default from the canonical topic list", async () => {
    const { notification_prefs: _dropped, ...withoutPrefs } = PROFILE;
    const client = fakeClient({ tables: { member_profiles: { data: withoutPrefs, error: null } }, rpcs: MEMBER_RPCS });
    const out = await loadMemberApp(client, user);
    expect(Object.keys(out.member.notificationPrefs).sort()).toEqual([...NOTIFICATION_TOPIC_KEYS].sort());
    expect(Object.values(out.member.notificationPrefs).every(Boolean)).toBe(true);
  });
});

describe("memberApi overdue rule (L09)", () => {
  const cases = [
    { id: "c1", user_id: "user-1", status: "active", deadline: "2020-01-01", title: "Past", reference: "G-1" },
    { id: "c2", user_id: "user-1", status: "active", deadline: "2999-01-01", title: "Future", reference: "G-2" },
    { id: "c3", user_id: "user-1", status: "active", deadline: "", title: "No deadline", reference: "G-3" },
    { id: "c4", user_id: "user-1", status: "active", deadline: null, title: "Null deadline", reference: "G-4" },
    { id: "c5", user_id: "user-1", status: "resolved", deadline: "2020-01-01", title: "Resolved", reference: "G-5" },
  ];

  it("is a boolean on the member loader for every deadline shape", async () => {
    const client = fakeClient({
      tables: { member_profiles: { data: PROFILE, error: null }, member_cases: { data: cases, error: null } },
      rpcs: MEMBER_RPCS,
    });
    const out = await loadMemberApp(client, user);
    expect(out.cases.map((item) => item.overdue)).toEqual([true, false, false, false, false]);
  });

  it("agrees with the coordinator loader row for row", async () => {
    const client = fakeClient({
      rpcs: {
        get_coordinator_kpis: { data: {}, error: null },
        list_coordinator_cases: { data: cases.filter((item) => item.status === "active"), error: null },
        list_case_latest_updates: { data: [], error: null },
      },
    });
    const desk = await loadCoordinatorDesk(client);
    expect(desk.cases.map((item) => item.overdue)).toEqual([true, false, false, false]);
  });
});

describe("memberApi date formatters (WL-31)", () => {
  // Hoisting the Intl.DateTimeFormat construction out of the per-row helpers
  // must not change a single rendered character, and must never hand one
  // language's formatter to the other.
  const caseRow = { id: "c1", user_id: "user-1", status: "active", deadline: "2026-07-24", title: "T", reference: "G-1" };

  const coordinatorDesk = (lang) => loadCoordinatorDesk(
    fakeClient({
      rpcs: {
        get_coordinator_kpis: { data: {}, error: null },
        list_coordinator_cases: { data: [caseRow], error: null },
        list_case_latest_updates: { data: [], error: null },
      },
    }),
    lang,
  );

  it("renders the pinned en-US labels byte for byte", async () => {
    const desk = await coordinatorDesk("en");
    expect(desk.cases[0].deadlineLabel).toBe("Jul 24");
  });

  it("does not leak a cached formatter across languages", async () => {
    const en = await coordinatorDesk("en");
    const es = await coordinatorDesk("es");
    const enAgain = await coordinatorDesk("en");
    expect(es.cases[0].deadlineLabel).toBe(new Intl.DateTimeFormat("es", { month: "short", day: "numeric" }).format(new Date("2026-07-24T12:00:00")));
    expect(es.cases[0].deadlineLabel).not.toBe(en.cases[0].deadlineLabel);
    expect(enAgain.cases[0].deadlineLabel).toBe(en.cases[0].deadlineLabel);
  });

  it("renders Eastern-labelled event dates and times exactly as freshly built formatters would", async () => {
    const startsAt = "2026-07-30T18:00:00Z";
    const client = fakeClient({
      rpcs: {
        get_staff_roster: { data: [], error: null },
        get_admin_events: { data: [{ id: "e1", title: "Meeting", startsAt }], error: null },
        get_admin_audit: { data: [], error: null },
        get_admin_mfa_status: { data: null, error: null },
      },
    });
    const desk = await loadAdminDesk(client, "en");
    const date = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric" }).format(new Date(startsAt));
    const time = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h12", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(startsAt));
    expect(desk.events[0].startsLabel).toBe(`${date} · ${time}`);
  });
});

describe("formTemplates hoisted FMLA fragments (N03)", () => {
  const byKey = (key) => FORM_TEMPLATES.find((template) => template.key === key);
  const CONDITION_TYPE_FIELD = {
    key: "condition_type",
    type: "radio",
    labelKey: "forms.f.conditionType",
    required: true,
    options: [
      { value: "continuous", labelKey: "forms.opt.continuous" },
      { value: "intermittent", labelKey: "forms.opt.intermittent" },
    ],
  };
  const LEAVE_DATES_STEP = {
    titleKey: "forms.step.dates",
    fields: [
      { key: "start_date", type: "date", labelKey: "forms.f.startDate", required: true },
      { key: "end_date", type: "date", labelKey: "forms.f.endDate", required: true },
    ],
  };

  // Pin the serialized structure to the current FMLA seed. The GINA notice
  // delivery replaces the old reason label with a leave-pattern prompt;
  // the hoisted condition and date fragments still retain their exact shape.
  it("serialises the current FMLA seed with the hoisted fragments intact", () => {
    expect(JSON.stringify(byKey("fmla_self"))).toBe(
      JSON.stringify({
        key: "fmla_self",
        icon: "🏥",
        titleKey: "forms.tpl.fmla_self",
        blurbKey: "forms.blurb.fmla_self",
        steps: [
          {
            titleKey: "forms.step.reason",
            fields: [
              { key: "reason", type: "textarea", labelKey: "forms.f.leaveNeed", required: true, maxLength: 2000 },
              CONDITION_TYPE_FIELD,
            ],
          },
          LEAVE_DATES_STEP,
          {
            titleKey: "forms.step.provider",
            fields: [
              { key: "provider", type: "text", labelKey: "forms.f.provider", required: false, maxLength: 200 },
              { key: "notes", type: "textarea", labelKey: "forms.f.notes", required: false, maxLength: 1000 },
            ],
          },
        ],
      }),
    );
    expect(JSON.stringify(byKey("fmla_family").steps[1])).toBe(
      JSON.stringify({
        titleKey: "forms.step.reason",
        fields: [
          { key: "reason", type: "textarea", labelKey: "forms.f.leaveNeed", required: true, maxLength: 2000 },
          CONDITION_TYPE_FIELD,
        ],
      }),
    );
    expect(JSON.stringify(byKey("fmla_family").steps[2])).toBe(JSON.stringify(LEAVE_DATES_STEP));
  });

  it("gives each template its own objects, never a shared mutable reference", () => {
    const self = byKey("fmla_self");
    const family = byKey("fmla_family");
    const selfDates = self.steps.find((step) => step.titleKey === "forms.step.dates");
    const familyDates = family.steps.find((step) => step.titleKey === "forms.step.dates");
    expect(selfDates).not.toBe(familyDates);
    expect(selfDates.fields).not.toBe(familyDates.fields);
    expect(selfDates.fields[0]).not.toBe(familyDates.fields[0]);

    const selfCondition = self.steps.flatMap((step) => step.fields).find((field) => field.key === "condition_type");
    const familyCondition = family.steps.flatMap((step) => step.fields).find((field) => field.key === "condition_type");
    expect(selfCondition).not.toBe(familyCondition);
    expect(selfCondition.options).not.toBe(familyCondition.options);
    expect(selfCondition.options[0]).not.toBe(familyCondition.options[0]);
  });
});
