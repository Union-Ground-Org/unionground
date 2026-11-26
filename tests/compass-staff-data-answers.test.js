// REQ-UG-COMPASS-STAFF-DATA-ANSWERS-20261001
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/guide.js";
import { assertMinimizedCompassMessages, buildStaffDataMessages } from "../api/_lib/compassPrompts.js";
import { buildStaffDataFacts, restorePlaceholderNames } from "../api/_lib/compassStaffData.js";
import { classifyDataTopics, staffDataAnswersEnabled } from "../src/features/compass/dataTopics.js";
import { DEFAULT_SUGGESTED_QUESTIONS } from "../src/features/compass/suggestedQuestions.js";
import { requestGuideReply } from "../src/lib/guideApi.js";
// The handler reaches only an approved backend (api/_lib/providerBoundary.js).
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));

const ORG = "51002300-0000-4000-8000-000000000001";
const OTHER_ORG = "51002300-0000-4000-8000-000000000002";
const reservationId = "00000000-0000-4000-8000-000000000001";
// Union Ground has no approved AI mesh, so api/guide.js never dispatches to
// the sibling product's mesh hosts. Governed answers here run on a fictional
// agency connector; the mesh appears only in the case that proves it is
// refused.
const CONNECTOR_MODEL = "gpt-5-mini";
const AGENCY_KEY = "sk-agency-key-value-0123456789";
const CONNECTOR_URL = "https://api.openai.com/v1/chat/completions";
const EVIDENCE_REF = `sha256:${"b".repeat(64)} https://evidence.example.invalid`;
const CONNECTOR_PROVIDER = { gateway: "ai_connector_gpt", model: CONNECTOR_MODEL, api_key: AGENCY_KEY };
const MESH_PROVIDER = { gateway: "union-ground-mesh", model: "union-ground/compass-mesh:v1" };

function res(payload, { status = 200, ok = status < 400, headers = {} } = {}) {
  const body = JSON.stringify(payload);
  return { ok, status, headers: { get: (name) => headers[name.toLowerCase()] ?? null }, text: async () => body, json: async () => JSON.parse(body) };
}

function recorder() {
  return {
    statusCode: 0, headers: {}, body: "",
    status(code) { this.statusCode = code; return this; },
    setHeader(name, value) { this.headers[name] = value; },
    end(body) { this.body = body; },
  };
}

const context = {
  organization_id: ORG,
  topics: ["membership", "outcomes"],
  data: {
    membership: {
      privacyThreshold: 25,
      chapters: [
        { id: "riverside", label: "Riverside Hospital", memberCount: 140, memberCountSuppressed: false, stewardCount: 25, stewardCountSuppressed: false },
        { id: "annex", label: "North Annex", memberCount: null, memberCountSuppressed: true, stewardCount: null, stewardCountSuppressed: true },
      ],
      usageWindows: { dau: 30, wau: null, mau: 95, suppressed: { dau: false, wau: true, mau: false } },
    },
    outcomes: {
      openCases: 12, resolved: 8, resolutionRate: 40, inArbitration: 1,
      byStep: [{ step: "Step 2", count: 5 }, { step: "Jane Doe's meeting at 9:30 <b>", count: 1 }],
      byArticle: [{ articles: "Article 12", count: 3 }, { articles: "harassment by J. Smith", count: 2 }],
      byOutcome: { upheld: 3, settled: 2, denied: 2, other: 1, narrative: 9 },
    },
  },
};

describe("staff data topics", () => {
  it("routes the old figure suggestions to topics and leaves guidance questions alone", () => {
    expect(classifyDataTopics(DEFAULT_SUGGESTED_QUESTIONS.steward[0])).toEqual(["outcomes"]);
    expect(classifyDataTopics(DEFAULT_SUGGESTED_QUESTIONS.steward[1])).toEqual(["membership"]);
    expect(classifyDataTopics(DEFAULT_SUGGESTED_QUESTIONS.admin[0])).toEqual(["health"]);
    expect(classifyDataTopics("How many proposals are waiting on management?")).toEqual(["bargaining"]);
    expect(classifyDataTopics("¿Cuál es nuestra tasa de éxito en quejas formales?")).toEqual(["outcomes"]);
    expect(classifyDataTopics(DEFAULT_SUGGESTED_QUESTIONS.admin[4])).toEqual([]);
  });

  it("offers the mode only when both organization switches allow it", () => {
    expect(staffDataAnswersEnabled({ switches: {} })).toBe(false);
    expect(staffDataAnswersEnabled({ switches: { "features.ai_assistant.staff_data_answers": true } })).toBe(true);
    expect(staffDataAnswersEnabled({ switches: { "features.ai_assistant.staff_data_answers": true, "features.ai_assistant.enabled": false } })).toBe(false);
    expect(staffDataAnswersEnabled(null)).toBe(false);
  });
});

describe("staff data facts", () => {
  it("keeps numbers and bounded labels, pseudonymizes chapters and enforces the cohort floor", () => {
    const facts = buildStaffDataFacts(context);
    const serialized = JSON.stringify(facts.figures);
    expect(serialized).not.toMatch(/Riverside|North Annex|Jane Doe|J\. Smith|narrative|<b>/);
    expect(facts.figures.membership.chapters).toEqual([
      { chapter: "Campaign 1", members: 140, stewards: 25 },
      { chapter: "Campaign 2", members: null, stewards: null },
    ]);
    expect(facts.figures.membership.activePeople).toEqual({ lastDay: 30, last7Days: null, last30Days: 95 });
    // Union Ground has no grievance steps, arbitration or contract articles:
    // none of them reaches the Guide even when the snapshot still carries them.
    expect(serialized).not.toMatch(/Step 2|Article 12|harassment/);
    for (const removed of ["openCasesByStep", "mostCitedArticlesInOpenCases", "inArbitration", "casesInArbitration", "byStep", "byArticle"]) {
      expect(facts.figures.outcomes).not.toHaveProperty(removed);
    }
    expect(facts.figures.outcomes).toEqual({
      openCases: 12,
      resolvedCases: 8,
      resolvedShareOfAllCasesPercent: 40,
      recordedOutcomes: { upheld: 3, settled: 2, denied: 2, withdrawn: 0, other: 1 },
      recordedOutcomeTotal: 8,
      upheldPercentOfRecordedOutcomes: 37.5,
      upheldOrSettledPercentOfRecordedOutcomes: 62.5,
    });
    expect(restorePlaceholderNames("Campaign 1 has 140 members; Campaign 9 is unknown.", facts.legend))
      .toBe("Riverside Hospital has 140 members; Campaign 9 is unknown.");
  });

  it("refuses a snapshot published under another floor and drops small health cohorts", () => {
    const facts = buildStaffDataFacts({
      organization_id: ORG,
      topics: ["membership", "health"],
      data: {
        membership: { ...context.data.membership, privacyThreshold: 5 },
        health: {
          privacyThreshold: 25,
          chapterLabels: [{ id: "small", label: "Small Shop" }],
          chapters: [
            { chapterId: "small", label: "Small Shop", memberCount: 12, score: 71, drivers: { participation: 60 }, trend: [] },
            { chapterId: "big", label: "Big Shop", memberCount: 60, score: 64, drivers: { participation: 55, bogus: 1 }, trend: [{ measuredOn: "2026-09-01", score: 60 }] },
          ],
          series: [{ chapterId: "small", attendanceRate: null, engagementMean: 41.25, usageViews: 10 }],
          engagementCounts: [{ chapterId: "big", eventType: "poll_vote", count: 30 }, { chapterId: "big", eventType: "page_view", count: 300 }],
        },
      },
    });
    expect(facts.figures.membership).toEqual({ unavailable: true });
    expect(facts.figures.health.chapterHealthScores).toEqual([
      { chapter: "Campaign 2", score: 64, drivers: { participation: 55 }, trend: [{ measuredOn: "2026-09-01", score: 60 }] },
    ]);
    expect(facts.figures.health.chapterActivity).toEqual([{ chapter: "Campaign 1", attendanceRatePercent: null, engagementMean: 41.3, activePeople30Days: null }]);
    expect(facts.figures.health.peopleByActivity180Days).toEqual([{ chapter: "Campaign 2", activity: "poll_vote", people: 30 }]);
    expect(restorePlaceholderNames("Campaign 1 and Campaign 2", facts.legend)).toBe("Small Shop and Big Shop");
  });

  it("seals the figures message and replaces a withheld question with a canonical one", () => {
    const facts = buildStaffDataFacts(context);
    const messages = buildStaffDataMessages("What did Jane Doe win in her case?", facts);
    expect(() => assertMinimizedCompassMessages(messages)).not.toThrow();
    expect(messages[1].content).toBe("Summarize the figures for: membership totals, case outcomes.");
    expect(messages[0].content).not.toMatch(/Riverside|Jane/);
    expect(buildStaffDataMessages("Show me member stats by unit", facts)[1].content).toBe("Show me member stats by unit");
    expect(() => buildStaffDataMessages("x", { topics: ["payroll"], figures: {} })).toThrow(/minimization/);
  });
});

describe("staff_data mode on /api/guide", () => {
  let calls;

  function install(routes) {
    calls = [];
    global.fetch = vi.fn(async (url, init) => {
      const name = String(url).split("/").pop();
      calls.push({ name, url: String(url), body: init?.body ? JSON.parse(init.body) : null });
      const route = routes[name] ?? routes[String(url)];
      if (typeof route === "function") return route(init);
      if (route) return route;
      throw new Error(`unexpected fetch ${url}`);
    });
  }

  async function ask(body) {
    const response = recorder();
    await handler({ method: "POST", headers: { authorization: "Bearer staff-token" }, body }, response);
    return { status: response.statusCode, payload: JSON.parse(response.body) };
  }

  const auth = { user: res({ id: "staff-1" }) };

  beforeEach(() => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://project.supabase.co");
    // Union Ground serves only the Supabase project its contract names.
    vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "project");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "publishable-test-key");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key");
    vi.stubEnv("MESH_AI_API_KEY", "mesh-test-key");
    vi.stubEnv("MESH_AI_ACCESS_CLIENT_ID", "mesh-access-id");
    vi.stubEnv("MESH_AI_ACCESS_CLIENT_SECRET", "mesh-access-secret");
    vi.stubEnv("SAMPLE_SUPABASE_URL", "");
    vi.stubEnv("VITE_SAMPLE_SUPABASE_URL", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("refuses members and a switched-off organization before any reservation", async () => {
    install({ ...auth, get_compass_staff_data_context: res({ code: "42501", message: "staff role required" }, { status: 403 }) });
    expect(await ask({ mode: "staff_data", question: "What's our grievance win rate?" })).toMatchObject({ status: 403, payload: { code: "staff_required" } });
    install({ ...auth, get_compass_staff_data_context: res({ code: "55000", message: "off" }, { status: 400 }) });
    expect(await ask({ mode: "staff_data", question: "What's our grievance win rate?" })).toMatchObject({ status: 403, payload: { code: "feature_disabled" } });
    expect(calls.map((call) => call.name)).not.toContain("reserve_compass_ai_request");
  });

  it("asks for a figure topic and never reads data without one", async () => {
    install({ ...auth });
    expect(await ask({ mode: "staff_data", question: "What does the constitution say about elections?" })).toMatchObject({ status: 400, payload: { code: "no_data_topic" } });
    expect(calls.map((call) => call.name)).not.toContain("get_compass_staff_data_context");
  });

  it("answers without a provider call when no figure is available", async () => {
    install({ ...auth, get_compass_staff_data_context: res({ organization_id: ORG, topics: ["bargaining"], data: { bargaining: { unavailable: true } } }) });
    const { status, payload } = await ask({ mode: "staff_data", question: "How many proposals are open?" });
    expect(status).toBe(200);
    expect(payload).toMatchObject({ code: "no_figures", sources: [], meta: { model: "data-gate" } });
    expect(calls.map((call) => call.name)).not.toContain("reserve_compass_ai_request");
  });

  it("dispatches only placeholders and closed figures, binds the organization, and restores names", async () => {
    let meshBody = null;
    install({
      ...auth,
      get_compass_staff_data_context: res(context),
      resolve_compass_ai_provider: res(CONNECTOR_PROVIDER),
      reserve_compass_ai_request: res({ id: reservationId, cause: null, role: "steward", limit: 20 }),
      authorize_compass_ai_dispatch: res({ authorized: true, cause: null, evidence_ref: EVIDENCE_REF, organization_id: ORG }),
      record_compass_ai_request_outcome: res(null),
      [CONNECTOR_URL]: (init) => {
        meshBody = JSON.parse(init.body);
        return res({ model: CONNECTOR_MODEL, choices: [{ index: 0, message: { role: "assistant", content: "Campaign 1 has 140 members and 62.5% of recorded outcomes were upheld or settled." }, finish_reason: "stop" }] });
      },
    });
    const { status, payload } = await ask({ mode: "staff_data", question: "Show me member stats by unit", topics: ["outcomes", "payroll"] });
    expect(status).toBe(200);
    expect(payload.answer).toBe("Riverside Hospital has 140 members and 62.5% of recorded outcomes were upheld or settled.");
    expect(payload.figures).toEqual({ topics: ["membership", "outcomes"] });
    const contextCall = calls.find((call) => call.name === "get_compass_staff_data_context");
    expect(contextCall.body).toEqual({ p_topics: ["membership", "outcomes"] });
    expect(calls.find((call) => call.name === "record_compass_ai_request_outcome").body)
      .toEqual({ p_request_id: reservationId, p_user_id: "staff-1", p_outcome: "answered" });
    const sent = JSON.stringify(meshBody.messages);
    expect(sent).not.toMatch(/Riverside|North Annex|Jane Doe|J\. Smith/);
    // No arbitration, step or article figure is dispatched.
    expect(sent).not.toMatch(/Arbitration|ByStep|CitedArticles|Step 2|Article 12/i);
    expect(sent).toContain("Campaign 1");
    expect(sent).not.toMatch(/\bChapter \d/);
  });

  // Union Ground's SEC-UG-AI-PROMPT-CASE-STEPS-20261013: a plain
  // alphabetic stored step passed the old 40-character regex into the
  // provider body. Union Ground now sends it as an "Other step N" placeholder;
  // Union Ground has no grievance steps and sends no step bucket at all,
  // while the issue counts still cross and the answer comes back unchanged.
  it("keeps free-text case steps out of the connector body and still answers from the counts", async () => {
    const bodies = [];
    const stepContext = {
      organization_id: ORG,
      topics: ["caseload", "outcomes"],
      data: {
        caseload: {
          openByStep: [{ step: "Step 2", cases: 5 }, { step: "Alice Carter medical review", cases: 2 }],
          overdue: [], dueSoon: [],
          medianDaysPerStep: [{ step: "Alice Carter medical review", medianDays: 14.5, transitions: 4 }, { step: "arbitration", medianDays: 60, transitions: 2 }],
        },
        outcomes: {
          openCases: 7, resolved: 3, resolutionRate: 30, inArbitration: 1,
          byStep: [{ step: "Alice Carter medical review", count: 2 }, { step: "Bob Jones suspension", count: 1 }],
          byArticle: [], byOutcome: { upheld: 1, settled: 1, denied: 1, other: 0 },
        },
      },
    };
    install({
      ...auth,
      get_compass_staff_data_context: res(stepContext),
      resolve_compass_ai_provider: res(CONNECTOR_PROVIDER),
      reserve_compass_ai_request: res({ id: reservationId, cause: null, role: "steward", limit: 20 }),
      authorize_compass_ai_dispatch: res({ authorized: true, cause: null, evidence_ref: EVIDENCE_REF, organization_id: ORG }),
      record_compass_ai_request_outcome: res(null),
      [CONNECTOR_URL]: (init) => {
        bodies.push(JSON.parse(init.body));
        return res({ model: CONNECTOR_MODEL, choices: [{ index: 0, message: { role: "assistant", content: "There are 7 open issues and 3 resolved ones." }, finish_reason: "stop" }] });
      },
    });
    const { status, payload } = await ask({ mode: "staff_data", question: "Show me the issue counts", topics: ["caseload", "outcomes"] });
    expect(status).toBe(200);
    expect(bodies).toHaveLength(1);
    const sent = bodies[0].messages.map((message) => message.content).join("\n");
    expect(sent).not.toMatch(/Alice|Carter|medical review|Bob|Jones|suspension|Other step|"step"|Step 2|arbitration|14\.5|"transitions"/i);
    expect(sent).toContain('"openCases":7');
    expect(sent).toContain('"resolvedCases":3');
    expect(payload.answer).toBe("There are 7 open issues and 3 resolved ones.");
  });

  it("refuses when the dispatch organization differs from the figures' organization", async () => {
    install({
      ...auth,
      get_compass_staff_data_context: res(context),
      resolve_compass_ai_provider: res(CONNECTOR_PROVIDER),
      reserve_compass_ai_request: res({ id: reservationId, cause: null, role: "steward", limit: 20 }),
      authorize_compass_ai_dispatch: res({ authorized: true, cause: null, evidence_ref: EVIDENCE_REF, organization_id: OTHER_ORG }),
      release_member_ai_request: res(true),
    });
    const { status, payload } = await ask({ mode: "staff_data", question: "Show me member stats by unit" });
    expect(status).toBe(502);
    expect(payload.code).toBe("gateway_unavailable");
    expect(calls.some((call) => call.url === CONNECTOR_URL)).toBe(false);
    expect(calls.map((call) => call.name)).toContain("release_member_ai_request");
  });
});

describe("staff_data mode failure paths", () => {
  let calls;

  function install(routes) {
    calls = [];
    global.fetch = vi.fn(async (url, init) => {
      const name = String(url).split("/").pop();
      calls.push({ name });
      const route = routes[name] ?? routes[String(url)];
      if (typeof route === "function") return route(init);
      if (route) return route;
      throw new Error(`unexpected fetch ${url}`);
    });
  }

  async function ask(body) {
    const response = recorder();
    await handler({ method: "POST", headers: { authorization: "Bearer staff-token" }, body }, response);
    return { status: response.statusCode, payload: JSON.parse(response.body) };
  }

  const base = {
    user: res({ id: "staff-1" }),
    get_compass_staff_data_context: res(context),
    resolve_compass_ai_provider: res(CONNECTOR_PROVIDER),
    release_member_ai_request: res(true),
  };

  beforeEach(() => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://project.supabase.co");
    // Union Ground serves only the Supabase project its contract names.
    vi.stubEnv("UNIONGROUND_SUPABASE_PROJECT_REF", "project");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "publishable-test-key");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key");
    vi.stubEnv("MESH_AI_API_KEY", "mesh-test-key");
    vi.stubEnv("MESH_AI_ACCESS_CLIENT_ID", "mesh-access-id");
    vi.stubEnv("MESH_AI_ACCESS_CLIENT_SECRET", "mesh-access-secret");
    vi.stubEnv("SAMPLE_SUPABASE_URL", "");
    vi.stubEnv("VITE_SAMPLE_SUPABASE_URL", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("rejects an empty or oversized question before any read", async () => {
    install({ user: res({ id: "staff-1" }) });
    expect(await ask({ mode: "staff_data", question: " " })).toMatchObject({ status: 400 });
    expect(await ask({ mode: "staff_data", question: "x".repeat(1201) })).toMatchObject({ status: 400 });
    expect(calls.map((call) => call.name)).not.toContain("get_compass_staff_data_context");
  });

  it("treats an unreadable or malformed context as an outage", async () => {
    install({ ...base, get_compass_staff_data_context: res({ message: "boom" }, { status: 500 }) });
    expect(await ask({ mode: "staff_data", question: "Show me member stats by unit" })).toMatchObject({ status: 503, payload: { code: "governance_unavailable" } });
    install({ ...base, get_compass_staff_data_context: res({ organization_id: "not-a-uuid", topics: ["membership"], data: {} }) });
    expect(await ask({ mode: "staff_data", question: "Show me member stats by unit" })).toMatchObject({ status: 503 });
    install({ ...base, get_compass_staff_data_context: res({ organization_id: ORG, topics: [], data: null }) });
    expect(await ask({ mode: "staff_data", question: "Show me member stats by unit" })).toMatchObject({ status: 503 });
    expect(calls.map((call) => call.name)).not.toContain("reserve_compass_ai_request");
  });

  it("maps reservation refusals, an unreachable governance read and a mesh resolution, which is never configured", async () => {
    install({ ...base, reserve_compass_ai_request: res({ id: null, cause: "role", role: "steward", limit: 20 }) });
    expect(await ask({ mode: "staff_data", question: "Show me member stats by unit" })).toMatchObject({ status: 429, payload: { code: "role_rate_limit" } });
    install({ ...base, reserve_compass_ai_request: res({ id: null, cause: "disabled" }) });
    expect(await ask({ mode: "staff_data", question: "Show me member stats by unit" })).toMatchObject({ status: 503, payload: { code: "compass_paused" } });
    install({ ...base, resolve_compass_ai_provider: res({ message: "down" }, { status: 500 }) });
    expect(await ask({ mode: "staff_data", question: "Show me member stats by unit" })).toMatchObject({ status: 503, payload: { code: "governance_unavailable" } });
    // Even with every mesh credential set, a mesh resolution is refused as not
    // configured before any reservation or mesh call.
    install({ ...base, resolve_compass_ai_provider: res(MESH_PROVIDER), reserve_compass_ai_request: res({ id: reservationId, cause: null }) });
    expect(await ask({ mode: "staff_data", question: "Show me member stats by unit" }))
      .toMatchObject({ status: 503, payload: { error: "Union Ground Guide is not configured." } });
    expect(calls.map((call) => call.name)).not.toContain("reserve_compass_ai_request");
  });

  it("reports a paused dispatch and a provider outage without saving anything", async () => {
    install({
      ...base,
      reserve_compass_ai_request: res({ id: reservationId, cause: null, role: "steward", limit: 20 }),
      authorize_compass_ai_dispatch: res({ authorized: false, cause: "disabled", organization_id: ORG }),
    });
    expect(await ask({ mode: "staff_data", question: "Show me member stats by unit" })).toMatchObject({ status: 503, payload: { code: "compass_paused" } });
    install({
      ...base,
      reserve_compass_ai_request: res({ id: reservationId, cause: null, role: "steward", limit: 20 }),
      authorize_compass_ai_dispatch: res({ authorized: true, cause: null, evidence_ref: EVIDENCE_REF, organization_id: ORG }),
      authorize_compass_ai_failover: res({ authorized: false, cause: "fallback_unconfigured" }),
      [CONNECTOR_URL]: res({ error: "down" }, { status: 503 }),
    });
    expect(await ask({ mode: "staff_data", question: "Show me member stats by unit" })).toMatchObject({ status: 502, payload: { code: "gateway_unavailable" } });
    expect(calls.map((call) => call.name)).not.toContain("record_compass_ai_request_outcome");
  });
});

describe("staff data facts for every topic", () => {
  it("keeps caseload, outcome, health and bargaining figures in their closed shapes", () => {
    const facts = buildStaffDataFacts({
      organization_id: ORG,
      topics: ["caseload", "outcomes", "health", "bargaining", "payroll"],
      data: {
        caseload: {
          openByStep: [{ step: "Intake", cases: "4" }, { step: 7, cases: 1 }],
          overdue: [
            { kind: "response", deadlines: 2, cases: 2, oldestDaysOverdue: 9 },
            { kind: "follow_up", deadlines: 1, cases: 1, oldestDaysOverdue: 3 },
            { kind: "secret", deadlines: 1, cases: 1, oldestDaysOverdue: 1 },
            // Grievance-procedure and legal-filing kinds are left out.
            { kind: "filing", deadlines: 4, cases: 4, oldestDaysOverdue: 2 },
            { kind: "procedure", deadlines: 5, cases: 5, oldestDaysOverdue: 2 },
            { kind: "hearing", deadlines: 6, cases: 6, oldestDaysOverdue: 2 },
            { kind: "ulp", deadlines: 7, cases: 7, oldestDaysOverdue: 2 },
          ],
          dueSoon: [{ daysOut: 0, deadlines: 1, cases: 1 }],
          medianDaysPerStep: [{ step: "Step 1", medianDays: "12.345", transitions: 3 }],
        },
        outcomes: { unavailable: true },
        health: { unavailable: true },
        bargaining: {
          workspacesByStatus: { live: 1, hacked: 9 },
          proposalsBySideAndStatus: [{ side: "union", status: "proposed", proposals: 2 }, { side: "union", status: "leaked", proposals: 1 }],
          responsesDueWithin7Days: 1,
          responsesOverdue: "x",
        },
      },
    });
    expect(facts.topics).toEqual(["caseload", "outcomes", "health", "bargaining"]);
    // No cases-by-step or median-days-per-step figure, and only the response
    // and follow-up deadline kinds.
    expect(facts.figures.caseload).toEqual({
      overdueDeadlines: [
        { kind: "response", deadlines: 2, cases: 2, oldestDaysOverdue: 9 },
        { kind: "follow_up", deadlines: 1, cases: 1, oldestDaysOverdue: 3 },
      ],
      deadlinesDueSoon: [{ daysOut: 0, deadlines: 1, cases: 1 }],
    });
    expect(facts.figures.outcomes).toEqual({ unavailable: true });
    expect(facts.figures.health).toEqual({ unavailable: true });
    expect(facts.figures.bargaining).toEqual({
      tablesByStatus: { live: 1 },
      proposals: [{ side: "union", status: "proposed", proposals: 2 }],
      responsesDueWithin7Days: 1,
      responsesOverdue: null,
    });
    expect(facts.available).toBe(true);
    expect(restorePlaceholderNames(42, facts.legend)).toBe(42);
    expect(() => buildStaffDataFacts({ topics: ["caseload"], data: null })).toThrow();
  });
});

// Union Ground's review G4-4 of #4477 and gate round 1 on #4496 keep its step
// labels one-to-one ("Step 1" against "step-one", "Step 1" against "Step  1",
// aliases in either order). Union Ground issues no step label of any kind,
// so every one of those stored keys stays out of the figures and the legend,
// and no step placeholder can be restored.
describe("staff figures carry no case step", () => {
  const snapshots = [
    {
      caseload: {
        openByStep: [{ step: "Step 1", cases: 2 }, { step: "step-one", cases: 9 }],
        overdue: [], dueSoon: [],
        medianDaysPerStep: [{ step: "step-one", medianDays: 75.2, transitions: 8 }, { step: "Step 1", medianDays: 4.1, transitions: 3 }],
      },
      outcomes: { openCases: 11, byStep: [{ step: "step-one", count: 9 }, { step: "Step 1", count: 2 }], byArticle: [], byOutcome: {} },
    },
    {
      caseload: {
        openByStep: [{ step: "step-one", cases: 9 }, { step: "Step 1", cases: 2 }],
        overdue: [], dueSoon: [],
        medianDaysPerStep: [{ step: "step-one", medianDays: 75.2, transitions: 8 }],
      },
      outcomes: { openCases: 11, byStep: [{ step: "Step 1", count: 2 }, { step: "step-one", count: 9 }], byArticle: [], byOutcome: {} },
    },
    { caseload: { openByStep: [{ step: "step_3", cases: 4 }, { step: "step-three", cases: 1 }, { step: "level_two", cases: 3 }], overdue: [], dueSoon: [], medianDaysPerStep: [] } },
    {
      caseload: {
        openByStep: [{ step: "Step 1", cases: 2 }, { step: "Step  1", cases: 9 }],
        overdue: [], dueSoon: [],
        medianDaysPerStep: [{ step: "Step  1", medianDays: 75.2, transitions: 8 }, { step: "Step 1", medianDays: 4.1, transitions: 3 }],
      },
    },
  ];

  it.each(snapshots.map((data, index) => [index + 1, data]))("drops every stored step key from snapshot %i", (_, data) => {
    const topics = Object.keys(data);
    const facts = buildStaffDataFacts({ organization_id: ORG, topics, data });
    const serialized = JSON.stringify(facts);
    expect(serialized).not.toMatch(/step|level_two|Other step|medianDays|transitions/i);
    expect(facts.figures.caseload).toEqual({ overdueDeadlines: [], deadlinesDueSoon: [] });
    if (data.outcomes) expect(facts.figures.outcomes).toMatchObject({ openCases: 11 });
    expect(facts.legend).toEqual([]);
    expect(restorePlaceholderNames("Other step 1 has 9 issues; Step 1 has 2.", facts.legend))
      .toBe("Other step 1 has 9 issues; Step 1 has 2.");
  });
});

describe("requestGuideReply staff mode", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends the mode with only known topics and surfaces refusal codes", async () => {
    global.fetch = vi.fn(async () => res({ code: "feature_disabled", error: "off" }, { status: 403 }));
    await expect(requestGuideReply({ access_token: "t" }, "Win rate?", { mode: "staff_data", topics: ["outcomes", "payroll"] }))
      .rejects.toMatchObject({ code: "feature_disabled" });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({ question: "Win rate?", mode: "staff_data", topics: ["outcomes"] });
    global.fetch = vi.fn(async () => res({ answer: "ok", sources: [] }));
    await requestGuideReply({ access_token: "t" }, "Help", [{ role: "user", body: "old" }]);
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({ question: "Help" });
  });
});
