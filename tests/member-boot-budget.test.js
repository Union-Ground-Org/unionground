import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MEMBER_BOOT_THROUGH_SUBSCRIBED_REQUEST_CEILING,
  MEMBER_COLD_HOME_REQUEST_CEILING,
  MEMBER_REQUEST_CONCURRENCY,
  createMemberSessionLoader,
  memberResourcesForRoute,
} from "../src/lib/memberSessionLoader.js";
import { buildSearchIndex } from "../src/lib/searchIndex.js";
import { loadMemberApp } from "../src/lib/memberApi.js";
import { MEMBER_HOME_BOOTSTRAP_RESOURCE, memberHomeBootstrapRequested } from "../src/lib/memberHomeBootstrap.js";
import { composeMemberHomeBootstrap } from "./helpers/member-home-bootstrap-fixture.js";

// The retired points economy. Union Ground acknowledges
// contributions through safe recognition instead, so none of these reads may
// reappear in a route plan or in the eager snapshot.
const RETIRED_POINTS_RESOURCES = [
  "table:member_point_rules",
  "table:member_reward_tiers",
  "table:member_reward_items",
  "table:member_reward_grants",
  "table:member_point_events",
  "table:member_action_log",
  "rpc:get_member_reward_effects",
  "rpc:get_reward_cross_chapter_cards",
  "rpc:list_reward_experimental_content",
  "rpc:get_admin_reward_queue",
];

const PROFILE = {
  id: "member-1",
  first_name: "Darnell",
  full_name: "Darnell Foster",
  initials: "DF",
  role_line: "Member",
  member_since: 2023,
  language: "en",
  chapter_id: "chapter-1",
};

function deterministicClient({ fail = null, latency = 1, responses = {} } = {}) {
  const operations = [];
  let active = 0;
  let maximumActive = 0;

  const responseFor = (resource, args) => {
    if (resource === fail) return { data: null, error: { message: `${resource} unavailable` } };
    // The merged loader batches the plain cold Home reads into one
    // get_member_home_bootstrap call; it answers like the SQL function.
    if (resource === MEMBER_HOME_BOOTSTRAP_RESOURCE) return composeMemberHomeBootstrap(responseFor, "member-1", memberHomeBootstrapRequested(args));
    if (Object.hasOwn(responses, resource)) {
      const value = typeof responses[resource] === "function" ? responses[resource]() : responses[resource];
      return { data: structuredClone(value), error: null };
    }
    if (resource === "table:member_profiles") return { data: PROFILE, error: null };
    if (resource === "rpc:get_member_rewards_summary") return { data: {}, error: null };
    if (resource === "rpc:get_staff_mfa_standing") return { data: null, error: null };
    if (resource === "rpc:get_member_organization_configuration") return { data: null, error: null };
    return { data: [], error: null };
  };

  const execute = (resource, args) => new Promise((resolveRequest) => {
    operations.push(resource);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    setTimeout(() => {
      active -= 1;
      resolveRequest(responseFor(resource, args));
    }, latency);
  });

  const chain = (resource) => {
    let proxy;
    proxy = new Proxy(function query() {}, {
      get(_target, property) {
        if (property === "then") {
          const promise = execute(resource);
          return promise.then.bind(promise);
        }
        return () => proxy;
      },
    });
    return proxy;
  };

  return {
    operations,
    get maximumActive() { return maximumActive; },
    from(table) { return chain(`table:${table}`); },
    rpc(name, args) { return execute(`rpc:${name}`, args); },
  };
}

describe("member cold Home request budget", () => {
  it("PERF-UG-MEMBER-BOOT-FANOUT-20260831 coalesces concurrent shell and Home reads within the cold budget", async () => {
    const user = { id: "member-1", email: "member@example.test" };
    const sequentialClient = deterministicClient({ latency: 2 });
    const sequential = createMemberSessionLoader(sequentialClient, user, {
      nowMs: Date.UTC(2026, 8, 6, 18),
    });
    await sequential.loadShell();
    await sequential.loadRoute("today");

    const concurrentClient = deterministicClient({ latency: 2 });
    const concurrent = createMemberSessionLoader(concurrentClient, user, {
      nowMs: Date.UTC(2026, 8, 6, 18),
    });
    const [shell, home] = await Promise.all([
      concurrent.loadShell(),
      concurrent.loadRoute("today"),
    ]);

    expect(shell.member.id).toBe("member-1");
    expect(home.member.id).toBe("member-1");
    expect(concurrentClient.operations).toHaveLength(sequentialClient.operations.length);
    expect(concurrentClient.operations.length).toBeLessThanOrEqual(MEMBER_COLD_HOME_REQUEST_CEILING);
    expect(concurrentClient.maximumActive).toBeLessThanOrEqual(MEMBER_REQUEST_CONCURRENCY);
  });

  it("loads shell, Home, and first-subscription reconciliation within the end-to-end ceiling", async () => {
    const client = deterministicClient();
    const loader = createMemberSessionLoader(client, { id: "member-1", email: "member@example.test" }, {
      nowMs: Date.UTC(2026, 8, 6, 18),
    });

    const shell = await loader.loadShell();
    expect(shell.member.fullName).toBe("Darnell Foster");
    const home = await loader.loadRoute("today");
    expect(home.member.fullName).toBe("Darnell Foster");
    expect(home.planItems).toEqual([]);
    expect(client.operations.length).toBeLessThanOrEqual(MEMBER_COLD_HOME_REQUEST_CEILING);
    expect(client.maximumActive).toBeLessThanOrEqual(MEMBER_REQUEST_CONCURRENCY);
    expect(client.operations).not.toContain("table:member_conversations");
    expect(client.operations).not.toContain("table:chapter_documents");
    // The member's cases arrive in the one cold Home batch, never as a
    // second direct read.
    expect(client.operations.filter((resource) => resource === MEMBER_HOME_BOOTSTRAP_RESOURCE)).toHaveLength(1);
    expect(client.operations).not.toContain("table:member_cases");
    expect(client.operations).toContain("table:member_forms");
    expect(client.operations).toContain("rpc:list_chapter_task_assignees");

    const coldCount = client.operations.length;
    await loader.loadRoute("today");
    expect(client.operations).toHaveLength(coldCount);

    await loader.reconcileRealtime();
    expect(client.operations).toHaveLength(coldCount + 2);
    expect(client.operations.length).toBeLessThanOrEqual(MEMBER_BOOT_THROUGH_SUBSCRIBED_REQUEST_CEILING);
    expect(client.operations.slice(coldCount).toSorted()).toEqual([
      "table:chapter_task_messages",
      "table:member_notifications",
    ]);
  });

  it("keeps the route plans aligned with the data properties their actual view consumers read", () => {
    const contracts = {
      today: {
        file: "TodayView.jsx",
        properties: ["cases", "chapterStewards", "metrics", "organizationSurveys", "roles", "staffMfa", "tasks", "voted"],
        resources: ["table:member_cases", "table:member_participation_events", "table:chapter_tasks", "rpc:list_chapter_task_assignees", "rpc:get_member_rewards_summary", "rpc:get_member_chapter_stewards"],
      },
      messages: {
        file: "MessagesView.jsx",
        staff: true,
        properties: ["broadcasts", "channelReminders", "conversations", "member", "messageReminders", "peerContact", "product", "savedMessages", "taskMessages", "tasks"],
        resources: ["table:member_conversations", "table:member_broadcasts", "table:member_message_reminders", "table:member_saved_messages", "table:chapter_task_messages", "table:chapter_tasks", "table:chapter_documents", "rpc:list_reward_peer_contact", "rpc:list_channel_here_reminders"],
      },
      numbers: {
        file: "NumbersView.jsx",
        properties: ["member", "metrics", "organizationConfiguration", "planItems", "reportCard", "reportPreferences", "reportPreferencesUnavailable", "rewards", "rights", "weekDays", "weekly", "workload"],
        // `rewards` carries only the actions-this-year count My Reports shows.
        resources: ["table:member_ballots", "table:member_rights_lessons", "table:member_rights_progress", "table:member_participation_events", "rpc:get_member_rewards_summary", "table:member_workload_logs", "rpc:get_my_analytics_report_card"],
      },
      voting: {
        file: "VotingView.jsx",
        // The member row says whether there is a campaign; it is shell data.
        properties: ["member", "planItems"],
        resources: ["table:member_profiles", "table:member_ballots", "table:member_surveys", "table:member_survey_responses", "table:member_ballot_receipts", "rpc:get_ballot_tally"],
      },
      voice: {
        file: "VoiceView.jsx",
        properties: ["guideThreads"],
        resources: ["table:member_guide_threads", "table:member_guide_messages"],
      },
      cases: {
        file: "CasesView.jsx",
        properties: ["cases", "member"],
        resources: ["table:member_cases", "table:member_case_updates", "table:member_case_files", "table:member_profiles", "rpc:get_my_chapter_memberships"],
      },
      rights: {
        file: "RightsView.jsx",
        // A Guide citation shows the article the shell already loaded.
        properties: ["kbArticles", "organizationConfiguration", "rights", "stewardRequests"],
        resources: ["table:member_rights_lessons", "table:member_rights_progress", "table:member_steward_requests"],
      },
      events: {
        file: "EventsView.jsx",
        properties: ["events"],
        resources: ["table:member_events", "table:member_event_rsvps", "table:member_event_checkins"],
      },
      appointments: {
        file: "AppointmentsView.jsx",
        properties: ["appointments"],
        resources: ["rpc:get_my_appointments"],
      },
      settings: {
        file: "SettingsView.jsx",
        properties: ["events", "forms", "member", "organizationConfiguration", "rewards", "roles", "staffMfa"],
        resources: ["table:member_events", "table:member_forms", "table:form_template_registry", "rpc:get_workload_reminder_preferences"],
      },
      workload: {
        file: "WorkloadView.jsx",
        properties: ["member", "workload"],
        resources: ["table:member_workload_logs", "rpc:get_workload_stats", "rpc:get_workload_reminder_preferences"],
      },
      forms: {
        file: "FormsView.jsx",
        properties: ["cosignRequests", "formTemplateVersions", "formTemplates", "forms", "formsTruncated", "member"],
        resources: ["table:member_forms", "table:member_form_cosigners", "table:form_template_registry", "table:member_form_files", "rpc:cosign_invite_preview"],
      },
      rewards: {
        file: "RewardsView.jsx",
        // Contributions are acknowledged from safe recognition, never points.
        properties: ["member", "recognition", "recognitionCatalog"],
        resources: ["rpc:get_member_recognition_summary", "table:member_recognition_rules", "table:member_recognition_events"],
      },
      search: {
        file: "SearchView.jsx",
        transitiveConsumers: ["../lib/searchIndex.js"],
        // Member identity and the Site Guide switch come from the shell; the
        // steward roster is the Home card's. memberOrgStructure is an
        // optional snapshot; SearchView separately loads the member-safe
        // projection (covered by search-view.test.jsx). chapterLeadership is
        // likewise optional: SearchView loads get_chapter_leadership itself,
        // never at boot (covered by who-runs-this-chapter.test.jsx).
        properties: ["appointments", "broadcasts", "cases", "chapterLeadership", "chapterStewards", "conversations", "events", "formTemplateVersions", "formTemplates", "forms", "guideThreads", "kbArticles", "member", "memberOrgStructure", "notifications", "organizationConfiguration", "planItems", "recognitionCatalog", "rights", "roles"],
        resources: ["table:member_profiles", "rpc:get_member_organization_configuration", "rpc:get_member_chapter_stewards", "table:member_kb_articles", "table:member_guide_threads", "table:member_guide_messages", "table:member_forms", "table:form_template_registry", "table:member_recognition_rules", "rpc:get_my_appointments"],
      },
      hub: {
        file: "ProductHubView.jsx",
        properties: ["intakeOwners", "member", "organizationConfiguration", "product", "roles", "workstreams"],
        resources: ["table:chapter_spaces", "table:chapter_documents", "table:chapter_workstreams", "rpc:list_intake_triage_owners"],
      },
      tasks: {
        file: "TasksView.jsx",
        properties: ["member", "product", "roles", "taskActivity", "taskAssignees", "taskAttachments", "taskComments", "taskCommentsTruncated", "taskCommentsUnavailable", "taskDependencies", "taskFiles", "taskMessages", "taskSubtasks", "taskTemplateDetails", "taskTemplateReviewers", "taskTemplates", "taskWatches", "tasks", "workstreams"],
        resources: ["table:chapter_tasks", "table:chapter_task_messages", "table:chapter_task_subtasks", "table:chapter_task_watchers", "table:chapter_task_comments", "table:chapter_task_attachments", "table:chapter_task_activity", "table:chapter_task_files", "table:chapter_task_template_details", "table:chapter_workstreams", "rpc:list_chapter_task_assignees", "rpc:list_chapter_task_dependencies", "rpc:list_chapter_task_templates", "rpc:list_chapter_task_template_reviewers"],
      },
      steward: {
        file: "StewardView.jsx",
        properties: ["events", "member", "organizationConfiguration", "product", "roles", "workload"],
        resources: ["table:member_events", "table:member_event_rsvps", "table:member_event_checkins", "table:chapter_spaces", "rpc:get_steward_badge_counts"],
      },
      admin: {
        file: "AdminView.jsx",
        properties: ["member"],
        resources: ["rpc:get_steward_badge_counts"],
      },
      coordinator: {
        file: "CoordinatorView.jsx",
        properties: ["member", "organizationConfiguration"],
        resources: ["table:member_profiles"],
      },
      advisor: {
        file: "AdvisorView.jsx",
        properties: ["member", "workload"],
        resources: ["table:member_profiles"],
      },
      vp: {
        file: "VpView.jsx",
        properties: ["member", "organizationSurveys"],
        resources: ["table:member_profiles"],
      },
    };
    for (const [route, contract] of Object.entries(contracts)) {
      const files = [contract.file, ...(contract.transitiveConsumers ?? [])];
      const source = files.map((file) => readFileSync(resolve(process.cwd(), "src/views", file), "utf8")).join("\n");
      const consumed = [...source.matchAll(/\bdata\??\.([A-Za-z_][A-Za-z0-9_]*)/g)]
        .map((match) => match[1]).toSorted();
      expect([...new Set(consumed)], `${contract.file} added or removed a data consumer`).toEqual(contract.properties);
      const plan = memberResourcesForRoute(route, { staff: contract.staff === true });
      for (const resource of contract.resources) expect(plan, `${route} omits ${resource}`).toContain(resource);
      // Union Ground has no points economy: no route may plan a points,
      // tier, perk, ledger, reward-effect, chapter-card or Labs read.
      for (const resource of RETIRED_POINTS_RESOURCES) expect(plan, `${route} plans retired ${resource}`).not.toContain(resource);
    }
  });

  it.each(["cases", "today"])("supplies shared case-scope identity on cold %s entry without refetching it", async (route) => {
    const user = { id: "member-1", email: "member@example.test" };
    const client = deterministicClient({ responses: {
      "rpc:get_my_chapter_memberships": [{
        chapterId: "chapter-1",
        organizationId: "organization-1",
        selected: true,
        roles: ["member"],
        organizationRoles: [],
        chapterRoles: [],
      }],
    } });
    const loader = createMemberSessionLoader(client, user);
    const identity = {
      id: user.id,
      chapterId: "chapter-1",
      organizationId: "organization-1",
      membershipStatus: "active",
    };

    // Direct Cases entry and Home -> Cases both need the complete scope before
    // history renders; identity belongs to the shared bootstrap in either path.
    expect((await loader.loadRoute(route)).member).toMatchObject(identity);
    expect((await loader.loadRoute("cases")).member).toMatchObject(identity);
    for (const resource of ["table:member_profiles", "rpc:get_my_chapter_memberships"]) {
      expect(client.operations.filter((operation) => operation === resource)).toHaveLength(1);
    }
    expect(client.maximumActive).toBeLessThanOrEqual(MEMBER_REQUEST_CONCURRENCY);
  });

  it("preserves populated cold-entry content for Reports, Steward, Admin, and Home", async () => {
    const populated = {
      "table:member_cases": [{ id: "case-1", reference: "GR-1", title: "Schedule", deadline: null, case_type: "Scheduling", articles: [], step: "Filed", status: "active", updated_at: "2026-09-06T12:00:00Z" }],
      "table:member_ballots": [{ id: "ballot-1", title: "Ratification", body: "Vote", closes_at: "2026-09-08T12:00:00Z", active: true, order_index: 1, member_ballot_options: [] }],
      "table:member_rights_lessons": [{ id: "weingarten", label: "Weingarten", title: "Your rights", description: "Description", steps: [], script: "Script", order_index: 1 }],
      "table:member_rights_progress": [{ lesson_id: "weingarten", completed_steps: [0] }],
      "table:member_recognition_rules": [{ recognition_kind: "training_complete", label_en: "Completed training", label_es: "Capacitación completada", description_en: "Verified", description_es: "Verificada", weekly_cap: 2 }],
      "table:member_recognition_events": [{ id: "recognition-1", recognition_kind: "training_complete", source_label: "Training", occurred_at: "2026-09-05T12:00:00Z", verified_at: "2026-09-05T13:00:00Z" }],
      "rpc:get_member_recognition_summary": { totalVerified: 1, recentVerified: 1, currentRung: "organize", retiredPointsHidden: true },
      "table:member_events": [{ id: "event-1", title: "Meeting", starts_at: "2026-09-07T12:00:00Z", location: "Hall", summary: "Agenda", chapter_id: "chapter-1" }],
      "table:member_roles": [{ role: "steward" }, { role: "admin" }],
      // A Union Ground-shaped summary: only the action count may cross over.
      "rpc:get_member_rewards_summary": { totalPoints: 120, tierNumber: 2, tierName: "Builder", actionsYtd: 12 },
      "rpc:get_staff_mfa_standing": { assured: true, blocked: false },
      "rpc:get_steward_badge_counts": { requests: 3, conversations: 4, forms: 2 },
      "rpc:get_ballot_tally": { ballotId: "ballot-1", totalVotes: 4, quorumTarget: 10 },
    };
    const user = { id: "member-1", email: "member@example.test" };
    const reports = await createMemberSessionLoader(deterministicClient({ responses: populated }), user, { now: () => Date.UTC(2026, 8, 6, 18) }).loadRoute("numbers");
    expect(reports.planItems.some((item) => item.id === "ballot-1")).toBe(true);
    expect(reports.rights.lessonRecords).toHaveLength(1);
    expect(reports.rewards).toEqual({ actionsYtd: 12 });
    expect(reports).not.toHaveProperty("rewardsCatalog");
    expect(reports).not.toHaveProperty("pointsLedger");

    const steward = await createMemberSessionLoader(deterministicClient({ responses: populated }), user, { now: () => Date.UTC(2026, 8, 6, 18) }).loadRoute("steward");
    expect(steward.events.map((item) => item.id)).toEqual(["event-1"]);
    expect(steward.stewardBadges).toEqual(populated["rpc:get_steward_badge_counts"]);

    const admin = await createMemberSessionLoader(deterministicClient({ responses: populated }), user, { now: () => Date.UTC(2026, 8, 6, 18) }).loadRoute("admin");
    expect(admin).not.toHaveProperty("rewardItems");
    expect(admin.stewardBadges).toEqual(populated["rpc:get_steward_badge_counts"]);

    const home = await createMemberSessionLoader(deterministicClient({ responses: populated }), user, { now: () => Date.UTC(2026, 8, 6, 18) }).loadRoute("today");
    expect(home.cases.map((item) => item.id)).toEqual(["case-1"]);
    expect(home.planItems.some((item) => item.id === "ballot-1")).toBe(true);

    const contributionsClient = deterministicClient({ responses: populated });
    const contributions = await createMemberSessionLoader(contributionsClient, user, { now: () => Date.UTC(2026, 8, 6, 18) }).loadRoute("rewards");
    expect(contributions.recognition).toEqual({ totalVerified: 1, recentVerified: 1, currentRung: "organize", retiredPointsHidden: true });
    expect(contributions.recognitionCatalog.rules.map((rule) => rule.recognitionKind)).toEqual(["training_complete"]);
    expect(contributions.recognitionCatalog.events.map((event) => event.id)).toEqual(["recognition-1"]);
    for (const retired of ["rewardsCatalog", "rewardItems", "rewardGrants", "rewardEffects", "rewardChapterCards", "pointsLedger", "experimentalContent", "experimentalContentUnavailable"]) {
      expect(contributions).not.toHaveProperty(retired);
    }
    for (const resource of RETIRED_POINTS_RESOURCES) expect(contributionsClient.operations).not.toContain(resource);
  });

  it.each([true, false])("keeps populated cold Search parity with the eager index when Site Guide enabled=%s", async (guideEnabled) => {
    const nowMs = Date.UTC(2026, 8, 6, 18);
    const user = { id: "member-1", email: "member@example.test" };
    const populated = {
      "rpc:get_member_organization_configuration": { switches: { "features.guidance_onboarding.site_guide": guideEnabled } },
      "table:member_notifications": [{ id: "notice-1", title: "Notice title", body: "Notice body", created_at: "2026-09-06T17:00:00Z", read_at: null }],
      "table:member_conversations": [{ id: "conversation-1", user_id: user.id, sender_kind: "steward", sender_name: "Search Steward", updated_at: "2026-09-06T16:00:00Z" }],
      "table:member_messages": [{ id: "message-1", conversation_id: "conversation-1", user_id: user.id, sender_kind: "steward", sender_name: "Search Steward", body: "Conversation body", created_at: "2026-09-06T16:00:00Z" }],
      "table:member_broadcasts": [{ id: "broadcast-1", sender: "Chapter", title: "Broadcast title", body: "Broadcast body", published_at: "2026-09-06T15:00:00Z" }],
      "table:member_cases": [{ id: "case-1", user_id: user.id, reference: "GR-1", title: "Case title", case_type: "Scheduling", articles: [], step: "Filed", status: "active", updated_at: "2026-09-06T12:00:00Z" }],
      "table:member_events": [{ id: "event-1", title: "Event title", starts_at: "2026-09-07T12:00:00Z", location: "Hall", summary: "Event summary", chapter_id: "chapter-1" }],
      "rpc:get_my_appointments": [{ id: "appointment-1", type: "meeting", startsAt: "2026-09-07T13:00:00Z", endsAt: "2026-09-07T13:30:00Z", stewardName: "Appointment Steward", status: "booked" }],
      "table:member_ballots": [{ id: "ballot-1", title: "Ballot title", body: "Ballot body", closes_at: "2026-09-08T12:00:00Z", active: true, order_index: 1, member_ballot_options: [] }],
      "table:member_surveys": [{ id: "survey-1", title: "Pulse title", body: "Pulse body", closes_at: "2026-09-08T12:00:00Z", active: true, order_index: 1, member_survey_options: [] }],
      "table:member_rights_lessons": [{ id: "lesson-1", label: "Weingarten", title: "Lesson title", description: "Lesson body", steps: [], script: "Lesson script", order_index: 1 }],
      "table:member_forms": [{ id: "form-1", user_id: user.id, template_key: "search_form", template_version: 1, status: "draft", answers: { summary: "Form answer" }, step: 0 }],
      "table:form_template_registry": [{ key: "search_form", version: 1, label_en: "Database template", label_es: "Plantilla", blurb_en: "Template body", blurb_es: "Cuerpo", icon: "file", points: 1, active: true, sort: 1, field_schema: [] }],
      "table:member_kb_articles": [{ id: "kb-1", slug: "search-kb", chapter_id: "chapter-1", kind: "contract", title: "Knowledge title", article_ref: "A1", body: "Knowledge body", keywords: ["knowledge"], status: "published", verified_by: "reviewer", verified_at: "2026-09-05T12:00:00Z" }],
      "table:member_guide_threads": [{ id: "guide-1", title: "Saved Compass question", created_at: "2026-09-05T12:00:00Z", updated_at: "2026-09-06T12:00:00Z" }],
      "table:member_guide_messages": [{ id: "guide-message-1", thread_id: "guide-1", role: "assistant", body: "Saved Compass answer", created_at: "2026-09-06T12:00:00Z" }],
      "table:member_recognition_rules": [{ recognition_kind: "orientation_complete", label_en: "Completed orientation", label_es: "Orientación completada", description_en: "Verified orientation", description_es: "Orientación verificada", weekly_cap: 1 }],
      "rpc:get_member_rewards_summary": { actionsYtd: 5 },
    };

    const eager = await loadMemberApp(deterministicClient({ responses: populated }), user, { nowMs, queryNowMs: nowMs });
    const coldClient = deterministicClient({ responses: populated });
    const loader = createMemberSessionLoader(coldClient, user, { nowMs });
    const cold = await loader.loadRoute("search");
    const eagerIndex = buildSearchIndex(eager);
    const coldIndex = buildSearchIndex(cold);
    expect(coldIndex).toEqual(eagerIndex);
    expect(new Set(coldIndex.map((entry) => entry.type))).toEqual(new Set([
      "case", "conversation", "broadcast", "event", "appointment", "ballot", "pulse",
      "lesson", "form", "template", "kb", "notification", "guide", "reward", "page",
    ]));
    expect(cold.member.id).toBe(user.id);
    expect(cold.organizationConfiguration).toEqual(populated["rpc:get_member_organization_configuration"]);
    expect(coldIndex).toContainEqual(expect.objectContaining({ type: "page", focus: { view: "rights", path: "/m/rights" } }));
    expect(coldIndex).toContainEqual(expect.objectContaining({ type: "reward", focus: { view: "rewards", path: "/m/rewards" } }));
    // Contract clauses are left out of Union Ground: no catalogue page.
    expect(coldIndex.some((entry) => entry.focus?.view === "clauses")).toBe(false);
    expect(coldIndex.some((entry) => entry.type === "page" && entry.focus.view === "siteGuide")).toBe(guideEnabled);
    expect(coldClient.operations.filter((resource) => resource === "rpc:get_member_organization_configuration")).toHaveLength(1);
    expect(coldClient.operations).not.toContain("rpc:get_member_organization_structure");
    expect(coldClient.maximumActive).toBeLessThanOrEqual(MEMBER_REQUEST_CONCURRENCY);
    const coldCount = coldClient.operations.length;
    await loader.loadRoute("search");
    expect(coldClient.operations).toHaveLength(coldCount);
  });

  it("invalidates shared aggregates across routes and reconciles precise realtime invalidations", async () => {
    let actions = 100;
    const client = deterministicClient({ responses: {
      "rpc:get_member_rewards_summary": () => ({ actionsYtd: actions }),
    } });
    const loader = createMemberSessionLoader(client, { id: "member-1", email: "member@example.test" });
    expect((await loader.loadRoute("today")).rewards.actionsYtd).toBe(100);
    actions = 120;
    await loader.loadRoute("rights", { force: true });
    expect((await loader.loadRoute("today")).rewards.actionsYtd).toBe(120);
    actions = 140;
    loader.invalidateResources(["rpc:get_member_rewards_summary"]);
    expect((await loader.loadRoute("today")).rewards).toEqual({ actionsYtd: 140 });
  });

  it("preserves populated Home data across Rights navigation and a moving projection clock", async () => {
    let nowMs = Date.UTC(2026, 8, 6, 12);
    const client = deterministicClient({ responses: {
      "table:chapter_tasks": [{
        id: "task-clock",
        title: "Keep this task",
        status: "in_progress",
        assignee_id: "member-1",
        created_at: new Date(nowMs).toISOString(),
      }],
    } });
    const loader = createMemberSessionLoader(client, { id: "member-1", email: "member@example.test" }, { now: () => nowMs });

    expect((await loader.loadRoute("today")).tasks.map((task) => task.id)).toContain("task-clock");
    nowMs += 1_000;
    const beforeWarmHome = client.operations.length;
    expect((await loader.loadRoute("today")).tasks.map((task) => task.id)).toContain("task-clock");
    expect(client.operations).toHaveLength(beforeWarmHome);

    const rights = await loader.loadRoute("rights");
    expect(rights.tasks.map((task) => task.id)).toContain("task-clock");
    const afterRights = client.operations.length;
    expect((await loader.loadRoute("today")).tasks.map((task) => task.id)).toContain("task-clock");
    expect(client.operations).toHaveLength(afterRights);
  });

  it("preserves overlay-owned Compass history across an unrelated forced route refresh", async () => {
    const client = deterministicClient({ responses: {
      "table:member_guide_threads": [{ id: "guide-1", title: "Saved question", created_at: "2026-09-05T12:00:00Z", updated_at: "2026-09-06T12:00:00Z" }],
      "table:member_guide_messages": [{ id: "guide-message-1", thread_id: "guide-1", role: "assistant", body: "Saved answer", created_at: "2026-09-06T12:00:00Z" }],
    } });
    const loader = createMemberSessionLoader(client, { id: "member-1", email: "member@example.test" });
    expect((await loader.loadRoute("voice")).guideThreads.map((thread) => thread.id)).toEqual(["guide-1"]);

    const refreshedHome = await loader.loadRoute("today", { force: true });
    expect(refreshedHome.guideThreads.map((thread) => thread.id)).toEqual(["guide-1"]);
    expect(client.operations.filter((resource) => resource === "table:member_guide_threads")).toHaveLength(1);
  });

  it("uses the current injected clock for every load and forced refresh", async () => {
    let nowMs = Date.UTC(2026, 8, 6, 12);
    const closesAt = new Date(nowMs + 60_000).toISOString();
    const client = deterministicClient({ responses: {
      "table:member_ballots": [{ id: "ballot-clock", title: "Clock ballot", closes_at: closesAt, active: true, order_index: 1, member_ballot_options: [] }],
      "rpc:get_ballot_tally": { ballotId: "ballot-clock", totalVotes: 0, quorumTarget: 1 },
    } });
    const loader = createMemberSessionLoader(client, { id: "member-1", email: "member@example.test" }, { now: () => nowMs });
    expect((await loader.loadRoute("voting")).planItems.find((item) => item.id === "ballot-clock").closed).toBe(false);
    nowMs += 120_000;
    expect((await loader.loadRoute("voting", { force: true })).planItems.find((item) => item.id === "ballot-clock").closed).toBe(true);
  });

  it("keeps an unrelated feature failure outside Home and exposes it only when that route loads", async () => {
    const client = deterministicClient({ fail: "table:member_conversations" });
    const loader = createMemberSessionLoader(client, { id: "member-1", email: "member@example.test" }, {
      nowMs: Date.UTC(2026, 8, 6, 18),
    });

    const shell = await loader.loadShell();
    const home = await loader.loadRoute("today");
    expect(shell.member.id).toBe("member-1");
    expect(home.member.id).toBe("member-1");
    expect(client.operations).not.toContain("table:member_conversations");

    await expect(loader.loadRoute("messages")).rejects.toThrow("Conversations: table:member_conversations unavailable");
    expect(client.operations).toContain("table:member_conversations");
  });

  it("commits the shell before route work and renders route failures inside the existing shell boundary", () => {
    const app = readFileSync(resolve(process.cwd(), "src/App.jsx"), "utf8");
    expect(app).toContain("commitMemberData(ticket, nextData);");
    expect(app).toContain('memberLoaderRef.current?.stateForRoute(view)');
    expect(app).toContain('routeLoad.status === "error"');
    expect(app).toContain('<div className="view-error" role="alert">');
  });
});

it.each(["table:member_events", "rpc:get_member_rewards_summary", "table:member_roles"])("keeps eager soft-failure parity for %s", async resource => {
  const user = { id: "member-1", email: "member@example.test" };
  const options = { nowMs: Date.UTC(2026, 8, 6, 18) };
  const eager = await loadMemberApp(deterministicClient({ fail: resource }), user, options);
  const loader = createMemberSessionLoader(deterministicClient({ fail: resource }), user, options);
  const result = await loader.loadRoute("today");
  expect(result.events).toEqual(eager.events);
  expect(result.rewards).toEqual(eager.rewards);
  expect(result.rolesUnknown).toEqual(eager.rolesUnknown);
  expect(loader.stateForRoute("today").status).toBe("loaded");
  expect(loader.inspect().get(resource).status).toBe("error");
});

it.each(memberResourcesForRoute("today"))("preserves the eager blocking/fallback policy for Home resource %s", async resource => {
  const user = { id: "member-1", email: "member@example.test" };
  const options = { nowMs: Date.UTC(2026, 8, 6, 18) };
  let eagerFailure = null;
  try { await loadMemberApp(deterministicClient({ fail: resource }), user, options); }
  catch (error) { eagerFailure = error; }
  const loader = createMemberSessionLoader(deterministicClient({ fail: resource }), user, options);
  let lazyFailure = null;
  try { await loader.loadRoute("today"); }
  catch (error) { lazyFailure = error; }
  expect(Boolean(lazyFailure)).toBe(Boolean(eagerFailure));
  expect(loader.stateForRoute("today").status).toBe(eagerFailure ? "error" : "loaded");
});
