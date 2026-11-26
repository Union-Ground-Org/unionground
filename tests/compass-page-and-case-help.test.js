// REQ-UG-COMPASS-PAGE-AND-CASE-AWARE-HELP-20261001
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "../api/guide.js";
import { buildCompassGatewayRequest } from "../api/_lib/compassAiGovernance.js";
import { buildCaseFacts } from "../api/_lib/compassCaseHelp.js";
import {
  CASE_HELP_QUESTIONS,
  COMPASS_PAGE_LABELS,
  assertMinimizedCompassMessages,
  buildCaseHelpMessages,
  buildGuideMessages,
} from "../api/_lib/compassPrompts.js";
import { CASE_HELP_KEYS, COMPASS_PAGE_KEYS, caseHelpEnabled, caseHelpIncludesNarrative, pageAwareHelpEnabled } from "../src/features/compass/pageHelp.js";
import { requestCaseHelp, requestGuideReply } from "../src/lib/guideApi.js";
import { t as translate } from "../src/lib/i18n.js";
// The handler reaches only an approved backend (api/_lib/providerBoundary.js).
vi.mock("../src/lib/trustedBackends.js", async () => (await import("./helpers/fictional-provider.js")).trustedBackendsModule("https://project.supabase.co"));

const ORG = "51002400-0000-4000-8000-000000000001";
const OTHER_ORG = "51002400-0000-4000-8000-000000000002";
const CASE = "51002400-0000-4000-8000-000000000301";
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
const source = { source_id: "kb:1", kind: "kb", title: "Discipline rights", ref: "Section 7", snippet: "The employer shall not discipline or discharge an employee without just cause." };
const connectorReply = (content) => res({ model: CONNECTOR_MODEL, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });

function res(payload, { status = 200, ok = status < 400, headers = {} } = {}) {
  const body = JSON.stringify(payload);
  return { ok, status, headers: { get: (name) => headers[name.toLowerCase()] ?? null }, text: async () => body, json: async () => JSON.parse(body) };
}

const caseEnvelope = (overrides = {}) => ({
  organization_id: ORG,
  includesNarrative: false,
  data: {
    status: "active", step: "Step 2", openedDaysAgo: 30, lastChangeDaysAgo: 2, caseDeadlineInDays: 5,
    deadlines: [{ kind: "response", status: "active", dueInDays: 5 }, { kind: "bogus", status: "active", dueInDays: 1 }],
    timeline: [{ type: "step_advanced", daysAgo: 10 }, { type: "case_note", daysAgo: 2 }, { type: "secret", daysAgo: 1 }],
    title: "Jane Doe disciplined by Mark Smith",
    notes: ["Mark Smith yelled at Jane on Tuesday."],
  },
  ...overrides,
});

describe("page and case help contracts", () => {
  it("keeps the client page and question keys identical to the server's closed sets", () => {
    expect([...COMPASS_PAGE_KEYS].sort()).toEqual(Object.keys(COMPASS_PAGE_LABELS).sort());
    expect([...CASE_HELP_KEYS]).toEqual(Object.keys(CASE_HELP_QUESTIONS));
    // The web control renders every fixed question from the catalogue.
    for (const lang of ["en", "es"]) {
      for (const key of CASE_HELP_KEYS) {
        const label = translate(lang, `compass.caseHelp.q.${key}`);
        expect(label, `${lang} ${key}`).not.toBe(`compass.caseHelp.q.${key}`);
        expect(label.trim().length, `${lang} ${key}`).toBeGreaterThan(0);
      }
    }
  });

  it("offers the controls only while the organization switches are on", () => {
    expect(pageAwareHelpEnabled({ switches: {} })).toBe(false);
    expect(pageAwareHelpEnabled({ switches: { "features.ai_assistant.page_aware_help": true } })).toBe(true);
    expect(caseHelpEnabled({ switches: { "features.ai_assistant.case_help": true, "features.ai_assistant.enabled": false } })).toBe(false);
    expect(caseHelpEnabled(null)).toBe(false);
    expect(caseHelpIncludesNarrative({ switches: { "features.ai_assistant.case_context_includes_narrative": true } })).toBe(true);
    expect(caseHelpIncludesNarrative({ switches: {} })).toBe(false);
  });

  it("names the page in portal facts only for a known page key", () => {
    const withPage = buildGuideMessages("How do I file a grievance?", { page: "rights" }, [], [source]);
    expect(withPage[0].content).toContain(`from the ${COMPASS_PAGE_LABELS.rights} page`);
    const unknown = buildGuideMessages("How do I file a grievance?", { page: "<script>" }, [], [source]);
    expect(unknown[0].content).not.toContain("page of the portal");
  });

  it("keeps case facts minimal and withholds the narrative unless the organization opted in", () => {
    const facts = buildCaseFacts(caseEnvelope());
    expect(facts).toMatchObject({
      status: "active", openedDaysAgo: 30, lastChangeDaysAgo: 2, caseDeadlineInDays: 5,
      deadlines: [{ kind: "response", status: "active", dueInDays: 5 }],
    });
    expect(facts.timeline).toContainEqual({ type: "case_note", daysAgo: 2 });
    expect(facts.timeline.map((row) => row.type)).not.toContain("secret");
    expect(facts).not.toHaveProperty("title");
    expect(facts).not.toHaveProperty("recentNotes");
    const narrative = buildCaseFacts(caseEnvelope({ includesNarrative: true }));
    expect(JSON.stringify(narrative)).not.toMatch(/Jane|Mark|Smith|Tuesday/);
    expect(JSON.stringify(buildCaseFacts(caseEnvelope({ data: { ...caseEnvelope().data, step: "Meeting with Mark Smith at 9:30!" } })))).not.toMatch(/Mark|Smith|9:30/);
    expect(() => buildCaseFacts({ data: { status: "deleted" } })).toThrow();
  });

  // Union Ground issues have no grievance step and no legal filing,
  // hearing or appeal clock (owner decision, 2026-10-13), so none of them may
  // reach the Guide even when the inert case context still carries them.
  it("sends no grievance step, step history or legal-filing deadline kind to the Guide", () => {
    const facts = buildCaseFacts(caseEnvelope({
      data: {
        ...caseEnvelope().data,
        deadlines: [
          { kind: "response", status: "active", dueInDays: 5 },
          { kind: "follow_up", status: "active", dueInDays: 9 },
          { kind: "filing", status: "active", dueInDays: 3 },
          { kind: "hearing", status: "active", dueInDays: 4 },
          { kind: "appeal", status: "active", dueInDays: 6 },
        ],
      },
    }));
    expect(facts).not.toHaveProperty("step");
    expect(facts.timeline.map((row) => row.type)).not.toContain("step_advanced");
    expect(facts.deadlines.map((row) => row.kind)).toEqual(["response", "follow_up"]);
    expect(JSON.stringify(buildCaseHelpMessages("next", facts, []))).not.toMatch(/Step 2|"step"/);
  });

  // Union Ground's SEC-UG-AI-PROMPT-CASE-STEPS-20261013: a character
  // pattern is not anonymization ("Alice Carter medical review" passes one),
  // so only closed stage names may cross. Union Ground has no
  // grievance steps, so no stored step crosses at all: free text, closed stage
  // names, the starter procedure's keys and malformed values alike, with the
  // narrative off or opted in.
  it("sends no stored step to the Guide, free text or stage name, with narrative off or on", () => {
    const steps = [
      "Alice Carter medical review", "Bob Jones suspension", "Informal meeting with Ms Lee",
      "step_3", " Arbitration ", "level two", "INTAKE",
      "filing", "step_1", "step_2_appeal", "step_2", "step_3_appeal", "arbitration_demand", "arbitration",
      "filing for Alice Carter", "step_2_appeal Bob Jones", "appeal step 2", "arbitration demand medical",
      null, 7, "", "Step 10",
    ];
    for (const includesNarrative of [false, true]) {
      for (const step of steps) {
        const facts = buildCaseFacts(caseEnvelope({ includesNarrative, data: { ...caseEnvelope().data, step } }));
        expect(facts, JSON.stringify(step)).not.toHaveProperty("step");
        const sent = buildCaseHelpMessages("next", facts, []).map((message) => message.content).join("\n");
        expect(sent, JSON.stringify(step)).not.toMatch(/\b(?:Alice|Carter|Bob|Jones|Lee)\b|medical review|suspension|"step"|arbitration|step_?\s?\d|level two|intake/i);
      }
    }
    expect(() => buildCaseFacts(caseEnvelope({ data: { ...caseEnvelope().data, status: "leaked" } }))).toThrow("case-context-invalid");
    expect(() => buildCaseFacts({ includesNarrative: false, data: [] })).toThrow("case-context-invalid");
    // Opted-in narrative still crosses only as the minimizer returns it.
    const narrative = buildCaseFacts(caseEnvelope({ includesNarrative: true, data: { ...caseEnvelope().data, step: "Alice Carter medical review",
      title: "Schedule review.", notes: ["The committee can request the schedule.", "Mark Smith yelled at Jane on Tuesday."] } }));
    expect(narrative).toMatchObject({ title: "Schedule review.", recentNotes: ["The committee can request the schedule."] });
    expect(narrative).not.toHaveProperty("step");
  });

  it("seals the case question as one of the three fixed constants", () => {
    const messages = buildCaseHelpMessages("next", buildCaseFacts(caseEnvelope()), [source]);
    expect(() => assertMinimizedCompassMessages(messages)).not.toThrow();
    expect(messages[1].content).toBe(CASE_HELP_QUESTIONS.next);
    expect(messages[1].content).toBe("What happens next?");
    expect(messages[0].content).toContain('"deadlines":[{"kind":"response","status":"active","dueInDays":5}]');
    expect(() => buildCaseHelpMessages("anything", {}, [])).toThrow(/minimization/);
  });

  it("gives a case-carrying failover request a one-time cache namespace", () => {
    const access = {
      surface: "saas",
      provider: { gateway: "union-ground-fireworks", model: "accounts/fireworks/models/gpt-oss-120b", isolationScope: ORG,
        connector: { endpoint: "https://api.fireworks.ai/inference/v1/chat/completions", shape: "chat_completions", apiKey: "k".repeat(32), modelPattern: /.*/ } },
    };
    const messages = buildCaseHelpMessages("next", buildCaseFacts(caseEnvelope()), []);
    const key = (extra) => buildCompassGatewayRequest(messages, { ...access, ...extra }).options.headers["x-prompt-cache-isolation-key"];
    expect(key({})).toBe(key({}));
    expect(key({ cacheIsolation: "request" })).not.toBe(key({ cacheIsolation: "request" }));
    expect(key({ cacheIsolation: "request" })).not.toBe(key({}));
  });
});

describe("case_help and page context on /api/guide", () => {
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
    const response = { statusCode: 0, headers: {}, body: "", status(code) { this.statusCode = code; return this; }, setHeader(n, v) { this.headers[n] = v; }, end(b) { this.body = b; } };
    await handler({ method: "POST", headers: { authorization: "Bearer member-token" }, body }, response);
    return { status: response.statusCode, payload: JSON.parse(response.body) };
  }

  const governed = (dispatchOrg = ORG) => ({
    resolve_compass_ai_provider: res(CONNECTOR_PROVIDER),
    reserve_compass_ai_request: res({ id: reservationId, cause: null, role: "member", limit: 20 }),
    authorize_compass_ai_dispatch: res({ authorized: true, cause: null, evidence_ref: EVIDENCE_REF, organization_id: dispatchOrg }),
    record_compass_ai_request_outcome: res(null),
    release_member_ai_request: res(true),
  });

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

  it("accepts only a case id and a fixed question key", async () => {
    install({ user: res({ id: "member-1" }) });
    expect(await ask({ mode: "case_help", caseId: CASE, question: "Tell me everything" })).toMatchObject({ status: 400 });
    expect(await ask({ mode: "case_help", caseId: "not-a-uuid", questionKey: "next" })).toMatchObject({ status: 400 });
    expect(calls.map((call) => call.name)).not.toContain("get_compass_case_context");
  });

  it("maps a switched-off organization and an unreadable case before any reservation", async () => {
    install({ user: res({ id: "member-1" }), get_compass_case_context: res({ code: "55000" }, { status: 400 }) });
    expect(await ask({ mode: "case_help", caseId: CASE, questionKey: "next" })).toMatchObject({ status: 403, payload: { code: "feature_disabled" } });
    install({ user: res({ id: "member-1" }), get_compass_case_context: res({ code: "P0002" }, { status: 400 }) });
    expect(await ask({ mode: "case_help", caseId: CASE, questionKey: "next" })).toMatchObject({ status: 404, payload: { code: "case_unavailable" } });
    expect(calls.map((call) => call.name)).not.toContain("reserve_compass_ai_request");
  });

  it("answers from minimized facts, binds the organization and never sends the narrative", async () => {
    let meshBody = null;
    install({
      user: res({ id: "member-1" }),
      get_compass_case_context: res(caseEnvelope({ includesNarrative: true })),
      get_compass_ai_context: res({ organization_id: ORG, data: [source] }),
      ...governed(),
      [CONNECTOR_URL]: (init) => {
        meshBody = JSON.parse(init.body);
        return connectorReply("Your issue has a response due in 5 days. Talk to your committee.");
      },
    });
    const { status, payload } = await ask({ mode: "case_help", caseId: CASE, questionKey: "next" });
    expect(status).toBe(200);
    expect(payload).toMatchObject({ answer: expect.stringContaining("response due in 5 days"), sources: [{ id: "kb:1", title: "Discipline rights", ref: "Section 7" }] });
    expect(calls.find((call) => call.name === "get_compass_case_context").body).toEqual({ p_case_id: CASE });
    expect(calls.find((call) => call.name === "record_compass_ai_request_outcome").body)
      .toEqual({ p_request_id: reservationId, p_user_id: "member-1", p_outcome: "answered" });
    expect(JSON.stringify(meshBody.messages)).not.toMatch(/\b(Jane|Mark|Smith)\b/);
    expect(calls.map((call) => call.name)).not.toContain("save_guide_exchange");
  });

  // Union Ground's SEC-UG-AI-PROMPT-CASE-STEPS-20261013: with narrative
  // off, a stored free-text step passed the old 40-character alphabetic regex
  // into the provider body. Union Ground's only provider path is the agency
  // connector (no mesh, so no mesh-to-platform failover body), and it carries
  // no step at all.
  it("keeps a free-text step out of the connector body with narrative off", async () => {
    const bodies = [];
    install({
      user: res({ id: "member-1" }),
      get_compass_case_context: res(caseEnvelope({ data: { ...caseEnvelope().data, step: "Alice Carter medical review" } })),
      get_compass_ai_context: res({ organization_id: ORG, data: [source] }),
      ...governed(),
      [CONNECTOR_URL]: (init) => {
        bodies.push(JSON.parse(init.body));
        return connectorReply("Your issue has a response due in 5 days.");
      },
    });
    const { status, payload } = await ask({ mode: "case_help", caseId: CASE, questionKey: "next" });
    expect(status).toBe(200);
    expect(payload.answer).toBe("Your issue has a response due in 5 days.");
    expect(bodies).toHaveLength(1);
    const sent = bodies[0].messages.map((message) => message.content).join("\n");
    expect(sent).not.toMatch(/\b(?:Alice|Carter|Jane|Mark|Smith)\b|medical review|"step"/);
    expect(sent).toContain('"deadlines":[{"kind":"response","status":"active","dueInDays":5}]');
  });

  it("refuses retrieval from another organization and releases the reservation", async () => {
    install({
      user: res({ id: "member-1" }),
      get_compass_case_context: res(caseEnvelope()),
      get_compass_ai_context: res({ organization_id: OTHER_ORG, data: [source] }),
      ...governed(),
    });
    expect(await ask({ mode: "case_help", caseId: CASE, questionKey: "rights" })).toMatchObject({ status: 503 });
    expect(calls.map((call) => call.name)).toContain("release_member_ai_request");
    expect(calls.some((call) => call.url === CONNECTOR_URL)).toBe(false);
  });

  it("maps other case-context refusals and outages", async () => {
    install({ user: res({ id: "member-1" }), get_compass_case_context: res({ code: "42501" }, { status: 403 }) });
    expect(await ask({ mode: "case_help", caseId: CASE, questionKey: "next" })).toMatchObject({ status: 403, payload: { code: "case_unavailable" } });
    install({ user: res({ id: "member-1" }), get_compass_case_context: res({ message: "boom" }, { status: 500 }) });
    expect(await ask({ mode: "case_help", caseId: CASE, questionKey: "next" })).toMatchObject({ status: 503, payload: { code: "governance_unavailable" } });
    install({ user: res({ id: "member-1" }), get_compass_case_context: res({ organization_id: "nope", data: { status: "active" } }) });
    expect(await ask({ mode: "case_help", caseId: CASE, questionKey: "next" })).toMatchObject({ status: 503 });
    install({ user: res({ id: "member-1" }), get_compass_case_context: res({ organization_id: ORG, data: { status: "unknown" } }) });
    expect(await ask({ mode: "case_help", caseId: CASE, questionKey: "next" })).toMatchObject({ status: 503 });
  });

  it("maps reservation refusals and a mesh resolution, which is never configured, before retrieval", async () => {
    const routes = { user: res({ id: "member-1" }), get_compass_case_context: res(caseEnvelope()), resolve_compass_ai_provider: res(CONNECTOR_PROVIDER) };
    install({ ...routes, reserve_compass_ai_request: res({ id: null, cause: "shared" }) });
    expect(await ask({ mode: "case_help", caseId: CASE, questionKey: "next" })).toMatchObject({ status: 429, payload: { code: "shared_rate_limit" } });
    install({ ...routes, resolve_compass_ai_provider: res({ message: "down" }, { status: 500 }) });
    expect(await ask({ mode: "case_help", caseId: CASE, questionKey: "next" })).toMatchObject({ status: 503 });
    // Even with every mesh credential set, a mesh resolution is refused as not
    // configured: no reservation, no retrieval, no mesh call.
    install({ ...routes, resolve_compass_ai_provider: res(MESH_PROVIDER) });
    expect(await ask({ mode: "case_help", caseId: CASE, questionKey: "next" }))
      .toMatchObject({ status: 503, payload: { error: "Union Ground Guide is not configured." } });
    expect(calls.map((call) => call.name)).not.toContain("reserve_compass_ai_request");
    expect(calls.map((call) => call.name)).not.toContain("get_compass_ai_context");
    expect(calls.some((call) => /mesh/.test(call.url))).toBe(false);
  });

  it("answers from case facts alone when retrieval fails, and reports a paused or failed dispatch", async () => {
    let meshBody = null;
    install({
      user: res({ id: "member-1" }),
      get_compass_case_context: res(caseEnvelope()),
      get_compass_ai_context: res({ message: "down" }, { status: 500 }),
      ...governed(),
      [CONNECTOR_URL]: (init) => {
        meshBody = JSON.parse(init.body);
        return connectorReply("Your issue has a response due in 5 days.");
      },
    });
    expect(await ask({ mode: "case_help", caseId: CASE, questionKey: "next" })).toMatchObject({ status: 200, payload: { sources: [] } });
    expect(meshBody.messages[0].content).toContain("No matching sources were found");
    install({
      user: res({ id: "member-1" }),
      get_compass_case_context: res(caseEnvelope()),
      get_compass_ai_context: res({ organization_id: ORG, data: [] }),
      ...governed(),
      authorize_compass_ai_dispatch: res({ authorized: false, cause: "disabled", organization_id: ORG }),
    });
    expect(await ask({ mode: "case_help", caseId: CASE, questionKey: "next" })).toMatchObject({ status: 503, payload: { code: "compass_paused" } });
    install({
      user: res({ id: "member-1" }),
      get_compass_case_context: res(caseEnvelope()),
      get_compass_ai_context: res({ organization_id: ORG, data: [] }),
      ...governed(),
      authorize_compass_ai_failover: res({ authorized: false, cause: "fallback_unconfigured" }),
      [CONNECTOR_URL]: res({ error: "down" }, { status: 503 }),
    });
    expect(await ask({ mode: "case_help", caseId: CASE, questionKey: "next" })).toMatchObject({ status: 502, payload: { code: "gateway_unavailable" } });
  });

  it("sends no page when the setting cannot be read or the page is unknown", async () => {
    const run = async (body, settings) => {
      let meshBody = null;
      install({
        user: res({ id: "member-1" }),
        get_compass_ai_context: (init) => {
          const kind = JSON.parse(init.body).p_kind;
          return res({ organization_id: ORG, data: kind === "portal" ? { activePlanKinds: [] } : [source] });
        },
        get_organization_settings_for_service: settings,
        ...governed(),
        [CONNECTOR_URL]: (init) => {
          meshBody = JSON.parse(init.body);
          return connectorReply("Section 7 covers it.");
        },
      });
      expect((await ask(body)).status).toBe(200);
      return meshBody.messages[0].content;
    };
    expect(await run({ question: "How do I file a grievance?", page: "rights" }, res({ message: "down" }, { status: 500 }))).not.toContain("page of the portal");
    expect(await run({ question: "How do I file a grievance?", page: "secret-admin" }, res({ "features.ai_assistant.page_aware_help": true }))).not.toContain("page of the portal");
    expect(calls.map((call) => call.name)).not.toContain("get_organization_settings_for_service");
  });

  it("sends the page name only when the organization switch is on", async () => {
    const run = async (enabled) => {
      let meshBody = null;
      install({
        user: res({ id: "member-1" }),
        get_compass_ai_context: (init) => {
          const kind = JSON.parse(init.body).p_kind;
          return res({ organization_id: ORG, data: kind === "portal" ? { activePlanKinds: [] } : [source] });
        },
        get_organization_settings_for_service: res({ "features.ai_assistant.page_aware_help": enabled }),
        ...governed(),
        [CONNECTOR_URL]: (init) => {
          meshBody = JSON.parse(init.body);
          return connectorReply("Section 7 covers it.");
        },
      });
      const { status } = await ask({ question: "How do I file a grievance?", page: "rights" });
      expect(status).toBe(200);
      return meshBody.messages[0].content;
    };
    expect(await run(true)).toContain(`${COMPASS_PAGE_LABELS.rights} page`);
    expect(await run(false)).not.toContain("page of the portal");
    expect(calls.find((call) => call.name === "get_organization_settings_for_service").body)
      .toEqual({ p_organization_id: ORG, p_keys: ["features.ai_assistant.page_aware_help"] });
  });
});

describe("client requests", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sends the page key only for a known page and case help with only id and key", async () => {
    global.fetch = vi.fn(async () => res({ answer: "ok", sources: [] }));
    await requestGuideReply({ access_token: "t" }, "Help", { page: "rights" });
    await requestGuideReply({ access_token: "t" }, "Help", { page: "javascript:" });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({ question: "Help", page: "rights" });
    expect(JSON.parse(global.fetch.mock.calls[1][1].body)).toEqual({ question: "Help" });
    await expect(requestCaseHelp({ access_token: "t" }, CASE, "next")).resolves.toEqual({ answer: "ok", sources: [] });
    expect(JSON.parse(global.fetch.mock.calls[2][1].body)).toEqual({ mode: "case_help", caseId: CASE, questionKey: "next" });
    global.fetch = vi.fn(async () => res({ code: "feature_disabled", error: "off" }, { status: 403 }));
    await expect(requestCaseHelp({ access_token: "t" }, CASE, "prepare")).rejects.toMatchObject({ code: "feature_disabled" });
    await expect(requestCaseHelp({ access_token: "t" }, CASE, "other")).rejects.toThrow();
  });
});
