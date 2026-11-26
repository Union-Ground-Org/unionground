import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { LearningEditor } from "../src/features/learningContent/LearningEditor.jsx";
import { createLearningContentApi } from "../src/features/learningContent/api.js";
import { LearningHomeCard } from "../src/features/learningContent/LearningHomeCard.jsx";
import { expectHeldWriteFocus, expectOneWriteFromOneTick, expectReadyRetryAfterThrowAtOnce } from "./helpers/busyWriteFocus.js";
import { LearningLearnArea } from "../src/features/learningContent/LearningLearnArea.jsx";
import {
  learningDayKey, learningRotationSeed, learningRotationStorageKey, normalizeLearningItem, orderLearningItems, parseLearningRotationState,
} from "../src/features/learningContent/model.js";
import { createLearningPreviewApi, createLearningPreviewStore } from "./fixtures/retired-pre-bot/src/features/learningContent/preview.js";
import { learningSectionFromLocation, learningSectionPath } from "../src/features/learningContent/routes.js";
import { learningContentCatalogue } from "../src/lib/i18n/learningContent.js";
import { instantFromLocalInput } from "../src/features/learningContent/time.js";
import { explicitHatAllowsView } from "../src/App.jsx";
import { catalogue as appCatalogue, t as appT } from "../src/lib/i18n.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { RightsView } from "../src/views/RightsView.jsx";
import { SettingsView } from "../src/views/SettingsView.jsx";
import { TodayView } from "../src/views/TodayView.jsx";
// The shared rpc mock carries reads too (a reload that
// lands inside the tick); only writes count toward the one-write rule.
const isRpcWrite = (name) => !/^(get|list|load|search)_/.test(String(name));

const ORG = "org-1";
const CHAPTER = "chapter-1";
const SESSION = { user: { id: "user-1" } };
const T = (key, vars = {}) => learningContentCatalogue.en[`learningContent.${key}`].replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ""));
const ES = (key) => learningContentCatalogue.es[`learningContent.${key}`];

function policy(patch = {}) {
  return {
    organizationId: ORG, chapterId: CHAPTER, quotesEnabled: true, lessonsEnabled: true, homeHidden: false,
    canManage: false, isPlatformOwner: false, version: "1:0:0:false", ...patch,
  };
}

function row(patch = {}) {
  return {
    id: "item-1", scope: "chapter", organization_id: ORG, chapter_id: CHAPTER, kind: "quote", locale: "en",
    locale_state: "reviewed", audience: "all", status: "published", title: "A quote", body: "Quote body.",
    attribution: "", source: "", rights_note: "Written by staff.", review_note: "Checked on 09-28.", bullets: [], direction: "",
    topics: [], tone: "", learning_outcome: "", factual_claims: false, priority: 0, is_default: false,
    starts_at: new Date(Date.now() - 3600000).toISOString(), ends_at: null, revision: 2, provenance: {},
    ...patch,
  };
}

const page = (items, hasMore = false) => ({ items, hasMore });

// An unsigned JWT-shaped token: only its session_id claim (the auth session
// lineage) matters to the client.
const base64url = (value) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const tokenFor = (sessionId, issued = 1) => `${base64url({ alg: "none" })}.${base64url({ session_id: sessionId, iat: issued })}.signature`;
const LINEAGE_A = "11111111-1111-4111-8111-111111111111";
const LINEAGE_B = "22222222-2222-4222-8222-222222222222";

// A stand-in for the session client: records every RPC and answers from a
// route table. A route may return data, { data, error }, or a promise.
function createClient(routes) {
  const calls = [];
  return {
    calls,
    rpc(name, params) {
      calls.push({ name, params });
      const route = routes[name];
      const result = typeof route === "function" ? route(params, calls) : route;
      if (result === undefined) return Promise.resolve({ data: null, error: { code: "PGRST202", message: `no route for ${name}` } });
      return Promise.resolve(result).then((value) => (value && typeof value === "object" && ("data" in value || "error" in value) ? value : { data: value, error: null }));
    },
  };
}
const names = (client) => client.calls.map((call) => call.name);
const callsTo = (client, name) => client.calls.filter((call) => call.name === name);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const flush = () => act(async () => { await new Promise((done) => setTimeout(done, 0)); });

function card(client, props = {}) {
  return <LearningHomeCard client={client} session={SESSION} organizationId={ORG} chapterId={CHAPTER} locale="en" {...props} />;
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Home card", () => {
  it("reads the policy, then one bounded batch for both kinds, and shows one live item", async () => {
    const client = createClient({ get_learning_policy: policy(), list_learning_content: page([row({ title: "First quote" })]) });
    const view = render(card(client));
    expect(await screen.findByRole("heading", { name: "First quote" })).toBeInTheDocument();
    expect(client.calls).toEqual([
      { name: "get_learning_policy", params: { p_chapter_id: CHAPTER } },
      { name: "list_learning_content", params: { p_chapter_id: CHAPTER, p_locale: "en", p_kind: null, p_offset: 0, p_limit: 100 } },
    ]);
    expect(view.container.querySelectorAll(".lc-home")).toHaveLength(1);
    // A single live item offers no Next.
    expect(screen.queryByRole("button", { name: T("home.next") })).toBeNull();
  });

  it("rotates on Next without any request and keeps the day's position for this user, chapter and language", async () => {
    const rows = ["a", "b", "c"].map((id) => row({ id, title: `Quote ${id}` }));
    const client = createClient({ get_learning_policy: policy(), list_learning_content: page(rows) });
    const seed = learningRotationSeed({ day: learningDayKey(new Date()), userId: "user-1", organizationId: ORG, chapterId: CHAPTER, locale: "en" });
    const ordered = orderLearningItems(rows.map(normalizeLearningItem), seed);
    const view = render(card(client));
    expect(await screen.findByRole("heading", { name: ordered[0].title })).toBeInTheDocument();
    expect(screen.getByText(T("home.position", { position: 1, count: 3 }))).toBeInTheDocument();
    const before = client.calls.length;

    fireEvent.click(screen.getByRole("button", { name: T("home.next") }));
    expect(screen.getByRole("heading", { name: ordered[1].title })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: T("home.next") }));
    fireEvent.click(screen.getByRole("button", { name: T("home.next") }));
    expect(screen.getByRole("heading", { name: ordered[0].title })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: T("home.next") }));
    await flush();
    expect(client.calls).toHaveLength(before);

    const key = learningRotationStorageKey({ userId: "user-1", organizationId: ORG, chapterId: CHAPTER, locale: "en" });
    expect(parseLearningRotationState(window.localStorage.getItem(key), learningDayKey(new Date()))).toBe(1);
    view.unmount();
    render(card(createClient({ get_learning_policy: policy(), list_learning_content: page(rows) })));
    expect(await screen.findByRole("heading", { name: ordered[1].title })).toBeInTheDocument();
  });

  it("reads only the policy while the member has hidden it, and renders nothing", async () => {
    const client = createClient({ get_learning_policy: policy({ homeHidden: true }), list_learning_content: page([row()]) });
    const view = render(card(client));
    await waitFor(() => expect(names(client)).toEqual(["get_learning_policy"]));
    await flush();
    expect(names(client)).toEqual(["get_learning_policy"]);
    expect(view.container).toBeEmptyDOMElement();
  });

  it("loads no disabled kind: nothing when both are off, only the enabled kind otherwise", async () => {
    for (const [flags, kind] of [
      [{ quotesEnabled: false, lessonsEnabled: false }, undefined],
      [{ lessonsEnabled: false }, "quote"],
      [{ quotesEnabled: false }, "mini_lesson"],
    ]) {
      const client = createClient({ get_learning_policy: policy(flags), list_learning_content: page([]) });
      const view = render(card(client));
      await waitFor(() => expect(callsTo(client, "get_learning_policy")).toHaveLength(1));
      await flush();
      expect(callsTo(client, "list_learning_content").map((call) => call.params.p_kind), JSON.stringify(flags)).toEqual(kind ? [kind] : []);
      view.unmount();
    }
  });

  it("drops rows of a disabled kind even if the server sends them", async () => {
    const client = createClient({
      get_learning_policy: policy({ lessonsEnabled: false }),
      list_learning_content: page([row({ id: "lesson", kind: "mini_lesson", title: "A lesson" }), row({ id: "quote", title: "A quote" })]),
    });
    render(card(client));
    expect(await screen.findByRole("heading", { name: "A quote" })).toBeInTheDocument();
    expect(screen.queryByText("A lesson")).toBeNull();
  });

  it("fails closed on language: no English fallback in Spanish, and no request for an unsupported language", async () => {
    const client = createClient({
      get_learning_policy: policy(),
      list_learning_content: page([row({ id: "en", locale: "en", title: "English quote" }), row({ id: "es", locale: "es", title: "Cita de prueba" })]),
    });
    render(card(client, { locale: "es" }));
    expect(await screen.findByRole("heading", { name: "Cita de prueba" })).toBeInTheDocument();
    expect(screen.queryByText("English quote")).toBeNull();
    expect(callsTo(client, "list_learning_content")[0].params.p_locale).toBe("es");
    expect(screen.getByText(ES("kind.quote"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: ES("home.hide") })).toBeInTheDocument();

    const onlyEnglish = createClient({ get_learning_policy: policy(), list_learning_content: page([row({ locale: "en", title: "Only English" })]) });
    const view = render(card(onlyEnglish, { locale: "es" }));
    await waitFor(() => expect(callsTo(onlyEnglish, "list_learning_content")).toHaveLength(1));
    await flush();
    expect(view.container).toBeEmptyDOMElement();

    const unsupported = createClient({ get_learning_policy: policy() });
    const french = render(card(unsupported, { locale: "fr" }));
    await flush();
    expect(unsupported.calls).toEqual([]);
    expect(french.container).toBeEmptyDOMElement();
  });

  it("clears at once on a language switch and ignores the late answer for the old language", async () => {
    const lists = { en: deferred(), es: deferred() };
    const client = createClient({ get_learning_policy: policy(), list_learning_content: (params) => lists[params.p_locale].promise });
    const view = render(card(client));
    await waitFor(() => expect(callsTo(client, "list_learning_content")).toHaveLength(1));
    await act(async () => lists.en.resolve(page([row({ id: "en-1", title: "English quote" })])));
    expect(screen.getByRole("heading", { name: "English quote" })).toBeInTheDocument();

    const stale = deferred();
    lists.en = stale;
    view.rerender(card(client, { locale: "es" }));
    // Same render: the English card is gone before Spanish content arrives.
    expect(screen.queryByText("English quote")).toBeNull();
    await waitFor(() => expect(callsTo(client, "list_learning_content").map((call) => call.params.p_locale)).toEqual(["en", "es"]));
    await act(async () => lists.es.resolve(page([row({ id: "es-1", locale: "es", title: "Cita en español" })])));
    expect(screen.getByRole("heading", { name: "Cita en español" })).toBeInTheDocument();
  });

  it("clears at once on a chapter or user change and never shows the previous scope's late answer", async () => {
    const lists = { [CHAPTER]: deferred(), "chapter-2": deferred() };
    const client = createClient({
      get_learning_policy: (params) => policy({ chapterId: params.p_chapter_id }),
      list_learning_content: (params) => lists[params.p_chapter_id].promise,
    });
    const view = render(card(client));
    await waitFor(() => expect(callsTo(client, "list_learning_content")).toHaveLength(1));
    view.rerender(card(client, { chapterId: "chapter-2" }));
    await waitFor(() => expect(callsTo(client, "list_learning_content")).toHaveLength(2));
    await act(async () => lists[CHAPTER].resolve(page([row({ title: "Old chapter quote" })])));
    expect(screen.queryByText("Old chapter quote")).toBeNull();
    await act(async () => lists["chapter-2"].resolve(page([row({ id: "c2", chapter_id: "chapter-2", title: "Chapter two quote" })])));
    expect(screen.getByRole("heading", { name: "Chapter two quote" })).toBeInTheDocument();

    view.rerender(card(client, { chapterId: "chapter-2", session: { user: { id: "user-2" } } }));
    expect(screen.queryByText("Chapter two quote")).toBeNull();
  });

  it("refuses a policy for another chapter or organization", async () => {
    const client = createClient({ get_learning_policy: policy({ chapterId: "chapter-9" }), list_learning_content: page([row()]) });
    const view = render(card(client));
    await waitFor(() => expect(names(client)).toEqual(["get_learning_policy"]));
    await flush();
    expect(names(client)).toEqual(["get_learning_policy"]);
    expect(view.container).toBeEmptyDOMElement();
  });

  it("polls only the policy every 60 s, and a new version invalidates the cache before reloading", async () => {
    vi.useFakeTimers();
    let version = "1:0:0:false";
    const second = deferred();
    let lists = 0;
    const client = createClient({
      get_learning_policy: () => policy({ version }),
      list_learning_content: () => (++lists === 1 ? page([row({ title: "Old quote" })]) : second.promise),
    });
    await act(async () => { render(card(client)); });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole("heading", { name: "Old quote" })).toBeInTheDocument();

    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(names(client)).toEqual(["get_learning_policy", "list_learning_content", "get_learning_policy"]);
    expect(screen.getByRole("heading", { name: "Old quote" })).toBeInTheDocument();

    version = "2:0:0:false";
    await act(async () => vi.advanceTimersByTimeAsync(60000));
    expect(callsTo(client, "list_learning_content")).toHaveLength(2);
    expect(screen.queryByText("Old quote")).toBeNull();
    await act(async () => second.resolve(page([row({ id: "b", title: "New quote" })])));
    expect(screen.getByRole("heading", { name: "New quote" })).toBeInTheDocument();
  });

  it("clears content when a policy check fails, without reading content", async () => {
    vi.useFakeTimers();
    let fail = false;
    const client = createClient({
      get_learning_policy: () => (fail ? { data: null, error: { code: "42501", message: "chapter unavailable" } } : policy()),
      list_learning_content: page([row({ title: "Visible quote" })]),
    });
    await act(async () => { render(card(client)); });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByRole("heading", { name: "Visible quote" })).toBeInTheDocument();
    fail = true;
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(screen.queryByText("Visible quote")).toBeNull();
    expect(callsTo(client, "list_learning_content")).toHaveLength(1);
  });

  it("stops showing an item the moment it expires, with no request", async () => {
    const client = createClient({
      get_learning_policy: policy(),
      list_learning_content: page([row({ title: "Short-lived quote", ends_at: new Date(Date.now() + 150).toISOString() })]),
    });
    render(card(client));
    expect(await screen.findByRole("heading", { name: "Short-lived quote" })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("Short-lived quote")).toBeNull(), { timeout: 3000 });
    expect(names(client)).toEqual(["get_learning_policy", "list_learning_content"]);
  });

  it("hides durably from Home and can undo it right there", async () => {
    const client = createClient({
      get_learning_policy: policy(),
      list_learning_content: page([row({ title: "Hideable quote" })]),
      set_learning_home_hidden: (params) => ({ homeHidden: params.p_hidden }),
    });
    render(card(client));
    fireEvent.click(await screen.findByRole("button", { name: T("home.hide") }));
    expect(await screen.findByText(T("home.hidden"))).toBeInTheDocument();
    expect(callsTo(client, "set_learning_home_hidden").map((call) => call.params)).toEqual([{ p_chapter_id: CHAPTER, p_hidden: true }]);
    expect(screen.queryByText("Hideable quote")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: T("home.undo") }));
    await waitFor(() => expect(callsTo(client, "set_learning_home_hidden").map((call) => call.params.p_hidden)).toEqual([true, false]));
  });

  it("expands a lesson in place with an explicit control", async () => {
    const client = createClient({
      get_learning_policy: policy(),
      list_learning_content: page([row({ kind: "mini_lesson", title: "A lesson", body: "Lesson body.", bullets: ["First point"], learning_outcome: "An outcome" })]),
    });
    render(card(client));
    const more = await screen.findByRole("button", { name: T("home.readMore") });
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("First point")).toBeNull();
    fireEvent.click(more);
    expect(screen.getByText("First point")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: T("home.readLess") })).toHaveAttribute("aria-expanded", "true");
  });

  it("talks only through a client captured to the session's token, swaps it on refresh without clearing, and clears on a new sign-in", async () => {
    const made = [];
    const createSessionClient = vi.fn((captured) => {
      const client = createClient({ get_learning_policy: policy(), list_learning_content: page([row({ title: "Captured quote" })]) });
      client.token = captured.access_token;
      made.push(client);
      return client;
    });
    const props = { createSessionClient, organizationId: ORG, chapterId: CHAPTER, locale: "en" };
    const first = { user: { id: "user-1" }, access_token: tokenFor(LINEAGE_A, 1) };
    const view = render(<LearningHomeCard {...props} session={first} />);
    expect(await screen.findByRole("heading", { name: "Captured quote" })).toBeInTheDocument();
    expect(createSessionClient.mock.calls.map(([captured]) => captured)).toEqual([{ access_token: first.access_token }]);

    const refreshed = { ...first, access_token: tokenFor(LINEAGE_A, 2) };
    view.rerender(<LearningHomeCard {...props} session={refreshed} />);
    expect(screen.getByRole("heading", { name: "Captured quote" })).toBeInTheDocument();
    await waitFor(() => expect(made).toHaveLength(2));
    expect(made[1].token).toBe(refreshed.access_token);
    await waitFor(() => expect(names(made[1])).toContain("get_learning_policy"));

    view.rerender(<LearningHomeCard {...props} session={{ user: { id: "user-1" }, access_token: tokenFor(LINEAGE_B) }} />);
    expect(screen.queryByText("Captured quote")).toBeNull();

    const unsigned = render(<LearningHomeCard {...props} session={{ user: { id: "user-1" } }} />);
    expect(unsigned.container).toBeEmptyDOMElement();
  });

  it("asks nothing and shows nothing on Home without a selected organization and chapter", async () => {
    const client = createClient({ get_learning_policy: policy() });
    const view = render(card(client, { organizationId: null, chapterId: null }));
    await flush();
    expect(client.calls).toEqual([]);
    expect(view.container).toBeEmptyDOMElement();
  });

  it("appears once on Home in both layouts, and not at all without the App wiring", async () => {
    for (const desktop of [false, true]) {
      const client = createClient({ get_learning_policy: policy(), list_learning_content: page([row({ title: "Home quote" })]) });
      const view = render(<TodayView data={fallbackData} desktop={desktop} onPlanAction={() => {}} learningContent={{ client, session: SESSION, organizationId: ORG, chapterId: CHAPTER, locale: "en" }} />);
      expect(await screen.findByRole("heading", { name: "Home quote" })).toBeInTheDocument();
      expect(view.container.querySelectorAll(".lc-home")).toHaveLength(1);
      view.unmount();
    }
    const bare = render(<TodayView data={fallbackData} onPlanAction={() => {}} />);
    expect(bare.container.querySelector(".lc-home")).toBeNull();
  });
});

describe("Learn library", () => {
  function area(client, props = {}) {
    return <LearningLearnArea client={client} session={SESSION} organizationId={ORG} chapterId={CHAPTER} locale="en" {...props} />;
  }

  it("pages published mini-lessons 40 at a time", async () => {
    const first = Array.from({ length: 40 }, (_, index) => row({ id: `l${index}`, kind: "mini_lesson", title: `Lesson ${index}` }));
    const client = createClient({
      get_learning_policy: policy(),
      list_learning_content: (params) => (params.p_offset === 0 ? page(first, true) : page([row({ id: "l40", kind: "mini_lesson", title: "Lesson 40" })])),
    });
    render(area(client));
    expect(await screen.findByRole("button", { name: /Lesson 39/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: T("library.loadMore") }));
    expect(await screen.findByRole("button", { name: /Lesson 40/ })).toBeInTheDocument();
    expect(callsTo(client, "list_learning_content").map((call) => call.params)).toEqual([
      { p_chapter_id: CHAPTER, p_locale: "en", p_kind: "mini_lesson", p_offset: 0, p_limit: 40 },
      { p_chapter_id: CHAPTER, p_locale: "en", p_kind: "mini_lesson", p_offset: 40, p_limit: 40 },
    ]);
    expect(screen.queryByRole("button", { name: T("library.loadMore") })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Lesson 3$/ }));
    expect(screen.getByRole("button", { name: /Lesson 3$/ })).toHaveAttribute("aria-expanded", "true");
  });

  // BUG-UG-MINI-LESSONS-OFF-SECTION-IS-A-DEAD-END-THAT-BLAMES-THE-UNION-20261124
  // (#9839): the policy is platform AND organization AND chapter, so "off" can
  // come from a switch nobody in the chapter holds. A member who can never use
  // mini-lessons is not offered the section at all, and no content is read.
  it("offers a member no mini-lessons section while lessons are off, and reads no content", async () => {
    const off = createClient({ get_learning_policy: policy({ lessonsEnabled: false }), list_learning_content: page([]) });
    const view = render(area(off, { onSection: vi.fn() }));
    expect(screen.getByRole("heading", { name: T("library.title") })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("heading", { name: T("library.title") })).toBeNull());
    expect(view.container.querySelector(".lc-library")).toBeNull();
    expect(screen.queryByText(T("library.off"))).toBeNull();
    expect(screen.queryByRole("button", { name: T("library.offTurnOn") })).toBeNull();
    expect(names(off)).toEqual(["get_learning_policy"]);
    view.unmount();
    const empty = createClient({ get_learning_policy: policy(), list_learning_content: page([]) });
    render(area(empty));
    expect(await screen.findByText(T("library.empty"))).toBeInTheDocument();
    expect(screen.getByText(T("library.language", { language: T("locale.en") }))).toBeInTheDocument();
  });

  // A manager keeps the way into the editor (finding 117 of
  // REQ-UG-RIGHTS-CONTRACT-AND-LIBRARY-CONTENT-20261030), and the
  // sentence says only that mini-lessons are not available.
  it("gives a manager the way in while lessons are off, with a sentence that blames no one", async () => {
    const onSection = vi.fn();
    const manager = createClient({ get_learning_policy: policy({ lessonsEnabled: false, canManage: true }), list_learning_content: page([]) });
    render(area(manager, { onSection }));
    expect(await screen.findByText(T("library.off"))).toBeInTheDocument();
    // #9533 B-22: an off library does not also say it is showing lessons.
    expect(screen.queryByText(T("library.language", { language: T("locale.en") }))).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: T("library.offTurnOn") }));
    expect(onSection).toHaveBeenCalledWith("manage");
    expect(names(manager)).toEqual(["get_learning_policy"]);
  });

  it("says mini-lessons are not available without blaming the union or the chapter, in both languages", () => {
    expect(T("library.off")).toBe("Mini-lessons are not available.");
    expect(ES("library.off")).toBe("Las minilecciones no están disponibles.");
    for (const text of [T("library.off"), ES("library.off")]) expect(text).not.toMatch(/union|chapter|officer|turned|sindicato|cap[ií]tulo|desactiv/i);
    for (const locale of ["en", "es"]) expect(learningContentCatalogue[locale]["learningContent.library.offWho"]).toBeUndefined();
  });

  it("restores a hidden Home from Learn", async () => {
    const client = createClient({
      get_learning_policy: policy({ homeHidden: true }),
      list_learning_content: page([]),
      set_learning_home_hidden: (params) => ({ homeHidden: params.p_hidden }),
    });
    render(area(client));
    fireEvent.click(await screen.findByRole("button", { name: T("library.showOnHome") }));
    expect(await screen.findByText(T("library.restored"))).toBeInTheDocument();
    expect(callsTo(client, "set_learning_home_hidden")[0].params).toEqual({ p_chapter_id: CHAPTER, p_hidden: false });
    expect(screen.queryByRole("button", { name: T("library.showOnHome") })).toBeNull();
  });

  // Lifts LearningLearnArea to its coverage baseline (#9533 touched the file):
  // a restore the server refuses or that leaves Home hidden says it failed,
  // an older page that will not load says so, and a lesson lists its topics.
  it.each([
    ["the server refuses it", () => ({ data: null, error: { code: "XX000", message: "boom" } })],
    ["Home stays hidden", () => ({ homeHidden: true })],
  ])("says a restore of a hidden Home failed when %s", async (_label, route) => {
    const client = createClient({ get_learning_policy: policy({ homeHidden: true }), list_learning_content: page([]), set_learning_home_hidden: route });
    render(area(client));
    fireEvent.click(await screen.findByRole("button", { name: T("library.showOnHome") }));
    expect(await screen.findByText(T("library.restoreFailed"))).toBeInTheDocument();
  });

  it("says when older lessons fail to load, and lists a lesson's topics", async () => {
    const client = createClient({
      get_learning_policy: policy(),
      list_learning_content: (params) => (params.p_offset === 0
        ? page([row({ id: "l0", kind: "mini_lesson", title: "Lesson 0", topics: ["Overtime"] })], true)
        : { data: null, error: { code: "XX000", message: "boom" } }),
    });
    render(area(client));
    fireEvent.click(await screen.findByRole("button", { name: /Lesson 0/ }));
    expect(screen.getByText("Overtime")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: T("library.loadMore") }));
    expect(await screen.findByText(T("library.loadMoreFailed"))).toBeInTheDocument();
  });

  it("offers the editor only to a manager the server recognizes", async () => {
    const member = createClient({ get_learning_policy: policy(), list_learning_content: page([]) });
    const onSection = vi.fn();
    const view = render(area(member, { onSection }));
    await screen.findByText(T("library.empty"));
    expect(screen.queryByRole("button", { name: new RegExp(T("library.manage")) })).toBeNull();
    view.unmount();
    const manager = createClient({ get_learning_policy: policy({ canManage: true }), list_learning_content: page([]) });
    render(area(manager, { onSection }));
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(T("library.manage")) }));
    expect(onSection).toHaveBeenCalledWith("manage");
  });

  it("shows a retry when the policy cannot be read", async () => {
    let attempts = 0;
    const client = createClient({ get_learning_policy: () => (++attempts === 1 ? { data: null, error: { code: "XX000", message: "boom" } } : policy()), list_learning_content: page([]) });
    render(area(client));
    fireEvent.click(await screen.findByRole("button", { name: T("library.retry") }));
    expect(await screen.findByText(T("library.empty"))).toBeInTheDocument();
  });
});

describe("platform owner before any tenant", () => {
  const ownerPolicy = { organizationId: null, chapterId: null, quotesEnabled: false, lessonsEnabled: false, homeHidden: false, canManage: false, isPlatformOwner: true, version: "1:0:0:false" };

  it("reads the policy once with no chapter and offers only the way into the platform editor", async () => {
    vi.useFakeTimers();
    const client = createClient({ get_learning_policy: ownerPolicy });
    const onSection = vi.fn();
    await act(async () => { render(<LearningLearnArea client={client} session={SESSION} locale="en" onSection={onSection} />); });
    await act(async () => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(T("library.manage")) }));
    expect(onSection).toHaveBeenCalledWith("manage");
    await act(async () => vi.advanceTimersByTimeAsync(180000));
    expect(client.calls).toEqual([{ name: "get_learning_policy", params: { p_chapter_id: null } }]);
    expect(screen.queryByText(T("library.title"))).toBeNull();
  });

  it("shows nothing to anyone else without a tenant", async () => {
    const client = createClient({ get_learning_policy: { data: null, error: { code: "42501", message: "chapter unavailable" } } });
    const view = render(<LearningLearnArea client={client} session={SESSION} locale="en" onSection={() => {}} />);
    await waitFor(() => expect(names(client)).toEqual(["get_learning_policy"]));
    await flush();
    expect(view.container).toBeEmptyDOMElement();
  });

  it("opens the platform scope only, with no chapter in any request", async () => {
    const client = createClient({
      get_learning_policy: ownerPolicy,
      get_learning_workspace: { items: [row({ id: "p1", scope: "platform", organization_id: null, chapter_id: null, title: "Platform draft", status: "draft", starts_at: null })], hasMore: false, policy: { quotes_enabled: false, lessons_enabled: false, selected_ids: null, revision: 1 }, canManage: true, isPlatformOwner: true },
    });
    render(<LearningLearnArea client={client} session={SESSION} locale="en" section="manage" onSection={() => {}} />);
    expect(await screen.findByText("Platform draft")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: T("scope.platform") })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: T("scope.chapter") })).toBeNull();
    expect(callsTo(client, "get_learning_workspace")[0].params).toEqual({ p_chapter_id: null, p_scope: "platform", p_offset: 0 });
  });
});

describe("manage editor", () => {
  const workspace = (items = [], patch = {}) => ({
    items, hasMore: false, policy: { scope_key: `chapter:${CHAPTER}`, scope: "chapter", quotes_enabled: true, lessons_enabled: true, selected_ids: null, revision: 1 },
    canManage: true, isPlatformOwner: false, ...patch,
  });
  function manage(client, props = {}) {
    return <LearningLearnArea client={client} session={SESSION} organizationId={ORG} chapterId={CHAPTER} locale="en" section="manage" onSection={() => {}} {...props} />;
  }

  it("refuses a caller the server does not recognize as a manager, without reading the workspace", async () => {
    const client = createClient({ get_learning_policy: policy() });
    render(manage(client));
    expect(await screen.findByText(T("manage.notAllowed"))).toBeInTheDocument();
    expect(names(client)).toEqual(["get_learning_policy"]);
  });

  it("lists the chapter workspace, offers the platform library only to its owner, and reports a refused scope", async () => {
    const client = createClient({
      get_learning_policy: policy({ canManage: true }),
      get_learning_workspace: (params) => (params.p_scope === "organization"
        ? { data: null, error: { code: "42501", message: "content administration unavailable" } }
        : workspace([row({ id: "d1", status: "draft", starts_at: null, title: "Draft quote" })])),
    });
    render(manage(client));
    expect(await screen.findByText("Draft quote")).toBeInTheDocument();
    expect(callsTo(client, "get_learning_workspace")[0].params).toEqual({ p_chapter_id: CHAPTER, p_scope: "chapter", p_offset: 0 });
    expect(screen.queryByRole("button", { name: T("scope.platform") })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: T("scope.organization") }));
    expect(await screen.findByText(T("error.forbidden"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: T("scope.organization") })).toHaveAttribute("aria-pressed", "true");
  });

  it("saves a new quote as a draft with exactly the editable fields, and blocks over-limit input without a request", async () => {
    const client = createClient({
      get_learning_policy: policy({ canManage: true }),
      get_learning_workspace: workspace(),
      save_learning_content: (params) => row({ ...params.p_item, id: "new-1", status: "draft", starts_at: null, revision: 1 }),
    });
    render(manage(client));
    fireEvent.click(await screen.findByRole("button", { name: T("items.newQuote") }));
    fireEvent.click(screen.getByRole("button", { name: T("editor.save") }));
    expect(await screen.findByText(T("editor.fixErrors"))).toBeInTheDocument();
    expect(screen.getAllByText(T("issue.required")).length).toBeGreaterThanOrEqual(2);
    expect(callsTo(client, "save_learning_content")).toHaveLength(0);

    fireEvent.change(screen.getByLabelText(T("editor.title")), { target: { value: "x".repeat(101) } });
    fireEvent.change(screen.getByLabelText(T("editor.bodyQuote")), { target: { value: "  Stand together.  " } });
    expect(screen.getByText(T("issue.too_long", { limit: 100 }))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: T("editor.save") }));
    expect(callsTo(client, "save_learning_content")).toHaveLength(0);

    fireEvent.change(screen.getByLabelText(T("editor.title")), { target: { value: "On standing together" } });
    fireEvent.click(screen.getByRole("button", { name: T("editor.save") }));
    expect(await screen.findByText(T("editor.saved", { revision: 1 }))).toBeInTheDocument();
    const [save] = callsTo(client, "save_learning_content");
    expect(save.params).toMatchObject({ p_chapter_id: CHAPTER, p_scope: "chapter", p_expected_revision: null });
    expect(Object.keys(save.params.p_item).sort()).toEqual([
      "attribution", "audience", "body", "bullets", "direction", "factual_claims", "is_default", "kind", "learning_outcome", "locale",
      "locale_state", "priority", "review_note", "rights_note", "source", "title", "tone", "topics",
    ]);
    expect(save.params.p_item).toMatchObject({ kind: "quote", locale: "en", locale_state: "draft", title: "On standing together", body: "Stand together.", priority: 0, is_default: false });
  });

  it("keeps publication closed until the saved item is reviewed, then publishes at its exact revision", async () => {
    const draftRow = row({ id: "d1", status: "draft", starts_at: null, title: "Needs review", locale_state: "draft", rights_note: "", review_note: "", revision: 4 });
    const client = createClient({
      get_learning_policy: policy({ canManage: true }),
      get_learning_workspace: workspace([draftRow, row({ id: "r1", status: "draft", starts_at: null, title: "Ready quote", revision: 6 })]),
      transition_learning_content: (params) => row({ id: params.p_id, title: "Ready quote", status: "published", revision: params.p_expected_revision + 1 }),
    });
    render(manage(client));
    fireEvent.click(await screen.findByRole("button", { name: `${T("items.edit")} Needs review` }));
    expect(screen.getByRole("button", { name: T("publish.publishNow") })).toBeDisabled();
    expect(screen.getByText(T("publish.checkRights")).closest("li")).toHaveClass("lc-checks__missing");
    fireEvent.click(screen.getByRole("button", { name: T("editor.backToList") }));

    fireEvent.click(await screen.findByRole("button", { name: `${T("items.edit")} Ready quote` }));
    fireEvent.click(screen.getByRole("button", { name: T("publish.publishNow") }));
    expect(await screen.findByText(T("publish.done_publish"))).toBeInTheDocument();
    expect(callsTo(client, "transition_learning_content")[0].params).toEqual({
      p_chapter_id: CHAPTER, p_id: "r1", p_action: "publish", p_expected_revision: 6, p_starts_at: null, p_ends_at: null,
    });
    expect(screen.getByText(T("items.revision", { revision: 7 }))).toBeInTheDocument();
  });

  it("refuses a schedule that does not start in the future, without a request", async () => {
    const client = createClient({
      get_learning_policy: policy({ canManage: true }),
      get_learning_workspace: workspace([row({ id: "r1", status: "draft", starts_at: null, title: "Ready quote" })]),
      transition_learning_content: () => row(),
    });
    render(manage(client));
    fireEvent.click(await screen.findByRole("button", { name: `${T("items.edit")} Ready quote` }));
    fireEvent.click(screen.getByRole("button", { name: T("publish.schedule") }));
    expect(screen.getByText(T("issue.required"))).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(T("publish.startsAt")), { target: { value: "2020-01-01T09:00" } });
    fireEvent.click(screen.getByRole("button", { name: T("publish.schedule") }));
    expect(screen.getByText(T("issue.not_future"))).toBeInTheDocument();
    expect(callsTo(client, "transition_learning_content")).toHaveLength(0);
  });

  it("explains a revision conflict and reloads the current server copy", async () => {
    let listed = row({ id: "r1", status: "draft", starts_at: null, title: "Shared quote", revision: 2 });
    const client = createClient({
      get_learning_policy: policy({ canManage: true }),
      get_learning_workspace: () => workspace([listed]),
      save_learning_content: { data: null, error: { code: "PT409", message: "revision conflict" } },
    });
    render(manage(client));
    fireEvent.click(await screen.findByRole("button", { name: `${T("items.edit")} Shared quote` }));
    fireEvent.change(screen.getByLabelText(T("editor.title")), { target: { value: "My edit" } });
    fireEvent.click(screen.getByRole("button", { name: T("editor.save") }));
    expect(await screen.findByText(T("error.conflict"))).toBeInTheDocument();
    expect(callsTo(client, "save_learning_content")[0].params.p_expected_revision).toBe(2);

    listed = row({ id: "r1", status: "draft", starts_at: null, title: "Their edit", revision: 3 });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: T("error.reload") }));
    await waitFor(() => expect(screen.getByLabelText(T("editor.title"))).toHaveValue("Their edit"));
    expect(screen.getByText(T("items.revision", { revision: 3 }))).toBeInTheDocument();
  });

  it("shows audited history 40 at a time and copies a version back into the editor", async () => {
    const entries = Array.from({ length: 40 }, (_, index) => ({ revision: 41 - index, action: index === 0 ? "publish" : "save_draft", changed_at: new Date(Date.now() - index * 60000).toISOString(), changed_by: index === 0 ? "user-1" : "user-2", snapshot: { title: `Version ${41 - index}`, body: "Body", kind: "quote", status: "draft" } }));
    const client = createClient({
      get_learning_policy: policy({ canManage: true }),
      get_learning_workspace: workspace([row({ id: "r1", title: "Current title", revision: 41 })]),
      get_learning_history: (params) => (params.p_offset === 0 ? page(entries, true) : page([{ revision: 1, action: "save_draft", changed_at: new Date(0).toISOString(), changed_by: null, snapshot: { title: "Version 1" } }])),
    });
    render(manage(client));
    fireEvent.click(await screen.findByRole("button", { name: `${T("items.edit")} Current title` }));
    fireEvent.click(screen.getByRole("button", { name: T("history.show") }));
    expect(await screen.findByText(T("history.entry", { revision: 41, action: T("history.action_publish") }))).toBeInTheDocument();
    expect(screen.getAllByText(T("history.byYou"))).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: T("history.loadMore") }));
    expect(await screen.findByText(T("history.byRemoved"))).toBeInTheDocument();
    expect(callsTo(client, "get_learning_history").map((call) => call.params)).toEqual([
      { p_chapter_id: CHAPTER, p_id: "r1", p_offset: 0 },
      { p_chapter_id: CHAPTER, p_id: "r1", p_offset: 40 },
    ]);
    const second = screen.getAllByRole("listitem").find((node) => node.textContent.includes(T("history.entry", { revision: 40, action: T("history.action_save_draft") })));
    fireEvent.click(within(second).getByText(T("history.view")));
    fireEvent.click(within(second).getByRole("button", { name: T("history.copy") }));
    expect(screen.getByLabelText(T("editor.title"))).toHaveValue("Version 40");
    expect(screen.getByText(T("history.copied"))).toBeInTheDocument();
  });

  // UX-UG-LEARNING-CONTENT-HISTORY-POLISH-BATCH-20261115: the platform
  // explainers' public-source revision has its own label; an unknown action
  // reads as the generic one, never as its raw name.
  it("labels a public source details revision and shows an unknown action as the generic change", async () => {
    const at = new Date().toISOString();
    const client = createClient({
      get_learning_policy: policy({ canManage: true }),
      get_learning_workspace: workspace([row({ id: "r1", title: "Current title", revision: 3 })]),
      get_learning_history: () => page([
        { revision: 3, action: "public_provenance", changed_at: at, changed_by: null, snapshot: { title: "Current title" } },
        { revision: 2, action: "future_action", changed_at: at, changed_by: null, snapshot: { title: "Current title" } },
      ]),
    });
    render(manage(client));
    fireEvent.click(await screen.findByRole("button", { name: `${T("items.edit")} Current title` }));
    fireEvent.click(screen.getByRole("button", { name: T("history.show") }));
    expect(await screen.findByText(T("history.entry", { revision: 3, action: "Public source details updated" }))).toBeInTheDocument();
    expect(screen.getByText(T("history.entry", { revision: 2, action: T("history.action_other") }))).toBeInTheDocument();
    expect(screen.queryByText(/public_provenance|future_action/)).toBeNull();
    expect(appT("es", "learningContent.history.action_public_provenance")).toBe("Detalles de la fuente pública actualizados");
  });

  it("saves module switches and a selection picked from reviewed choices, including platform items; the platform scope has no selection", async () => {
    const platformChoice = row({ id: "platform-extra", scope: "platform", organization_id: null, chapter_id: null, title: "Platform library quote", is_default: false });
    const client = createClient({
      get_learning_policy: policy({ canManage: true, isPlatformOwner: true }),
      get_learning_workspace: (params) => workspace([row({ id: `${params.p_scope}-1`, title: `${params.p_scope} item` })], {
        policy: { quotes_enabled: params.p_scope !== "platform", lessons_enabled: params.p_scope !== "platform", selected_ids: params.p_scope === "chapter" ? ["gone-elsewhere"] : null, revision: 1 },
      }),
      list_learning_choices: (params) => (params.p_offset === 0
        ? page([platformChoice, row({ id: "chapter-1", title: "chapter item" })], true)
        : page([row({ id: "org-choice", scope: "organization", chapter_id: null, title: "Organization choice" })])),
      save_learning_policy: (params) => ({ quotes_enabled: params.p_quotes_enabled, lessons_enabled: params.p_lessons_enabled, selected_ids: params.p_selected_ids, revision: 2 }),
    });
    render(manage(client));
    await screen.findByText("chapter item");
    // A saved selection opens in "only checked" mode; nothing is read until then.
    expect(screen.getByLabelText(T("settings.selectionSome"))).toBeChecked();
    expect(await screen.findByLabelText(/Platform library quote/)).not.toBeChecked();
    expect(callsTo(client, "list_learning_choices")[0].params).toEqual({ p_chapter_id: CHAPTER, p_scope: "chapter", p_offset: 0 });
    expect(screen.getByText(T("settings.selectedElsewhere", { count: 1 }))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: T("settings.choicesMore") }));
    expect(await screen.findByLabelText(/Organization choice/)).toBeInTheDocument();
    expect(callsTo(client, "list_learning_choices")[1].params.p_offset).toBe(40);

    fireEvent.click(screen.getByLabelText(T("settings.quotes")));
    fireEvent.click(screen.getByLabelText(/Platform library quote/));
    fireEvent.click(screen.getByRole("button", { name: T("settings.save") }));
    expect(await screen.findByText(T("settings.saved"))).toBeInTheDocument();
    expect(callsTo(client, "save_learning_policy")[0].params).toEqual({
      p_chapter_id: CHAPTER, p_scope: "chapter", p_quotes_enabled: false, p_lessons_enabled: true, p_selected_ids: ["gone-elsewhere", "platform-extra"], p_expected_revision: 1,
    });

    fireEvent.click(screen.getByLabelText(T("settings.selectionAll")));
    fireEvent.click(screen.getByRole("button", { name: T("settings.save") }));
    await waitFor(() => expect(callsTo(client, "save_learning_policy")).toHaveLength(2));
    expect(callsTo(client, "save_learning_policy")[1].params.p_selected_ids).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: T("scope.platform") }));
    await screen.findByText("platform item");
    expect(screen.queryByLabelText(T("settings.selectionSome"))).toBeNull();
    expect(screen.getByText(T("settings.platformSelection"))).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(T("settings.lessons")));
    fireEvent.click(screen.getByRole("button", { name: T("settings.save") }));
    await waitFor(() => expect(callsTo(client, "save_learning_policy")).toHaveLength(3));
    expect(callsTo(client, "save_learning_policy")[2].params).toEqual({
      p_chapter_id: CHAPTER, p_scope: "platform", p_quotes_enabled: false, p_lessons_enabled: true, p_selected_ids: null, p_expected_revision: 1,
    });
    expect(callsTo(client, "list_learning_choices").every((call) => call.params.p_scope === "chapter")).toBe(true);
  });

  it("shows a recovered item's original and origin to editors only", async () => {
    const recovered = row({
      id: "rec-1", scope: "chapter", status: "draft", starts_at: null, locale_state: "draft", title: "Recovered motto",
      provenance: { donor_path: "lib/knowledge/knowledge-engine-seed.ts", raw_source_call: "Q(200, 'Original words.', 'Someone')", recovery_note: "Unverified historical material." },
    });
    const client = createClient({ get_learning_policy: policy({ canManage: true }), get_learning_workspace: workspace([recovered]) });
    render(manage(client));
    expect(await screen.findByText(T("items.recovered"))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: `${T("items.edit")} Recovered motto` }));
    expect(screen.getByText(T("editor.recovered"))).toBeInTheDocument();
    fireEvent.click(screen.getByText(T("editor.provenance")));
    expect(screen.getByText("Q(200, 'Original words.', 'Someone')")).toBeInTheDocument();
    expect(screen.getByText("raw_source_call")).toBeInTheDocument();
  });

  it("previews the unsaved draft as members would see it, interactively and without any request", async () => {
    const client = createClient({ get_learning_policy: policy({ canManage: true }), get_learning_workspace: workspace() });
    render(manage(client));
    fireEvent.click(await screen.findByRole("button", { name: T("items.newLesson") }));
    const preview = screen.getByRole("region", { name: T("preview.title") });
    expect(within(preview).getByText(T("preview.empty"))).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(T("editor.title")), { target: { value: "Draft lesson" } });
    fireEvent.change(screen.getByLabelText(T("editor.bodyLesson")), { target: { value: "Draft body." } });
    const before = client.calls.length;
    expect(within(preview).getByRole("heading", { name: "Draft lesson" })).toBeInTheDocument();
    fireEvent.click(within(preview).getByRole("button", { name: T("home.next") }));
    expect(within(preview).getByRole("heading", { name: T("preview.sampleTitle") })).toBeInTheDocument();
    fireEvent.click(within(preview).getByRole("button", { name: T("home.hide") }));
    fireEvent.click(within(preview).getByRole("button", { name: T("preview.showAgain") }));
    fireEvent.click(within(preview).getByRole("button", { name: T("preview.learn") }));
    expect(within(preview).getByRole("heading", { name: "Draft lesson" })).toBeInTheDocument();
    await flush();
    expect(client.calls).toHaveLength(before);
  });

  it("asks before navigation discards unsaved edits", async () => {
    const client = createClient({ get_learning_policy: policy({ canManage: true }), get_learning_workspace: workspace() });
    render(manage(client));
    fireEvent.click(await screen.findByRole("button", { name: T("items.newQuote") }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const quiet = new CustomEvent("sg:before-navigate", { cancelable: true });
    expect(window.dispatchEvent(quiet)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(T("editor.title")), { target: { value: "Unsaved" } });
    const blocked = new CustomEvent("sg:before-navigate", { cancelable: true });
    expect(window.dispatchEvent(blocked)).toBe(false);
    expect(confirm).toHaveBeenCalledWith(T("editor.leaveConfirm"));
  });
});

describe("preview fiction", () => {
  it("runs Home, Learn and the editor on in-tab fiction with no client at all", async () => {
    const api = createLearningPreviewApi(createLearningPreviewStore({ organizationId: "preview-org", chapterId: "preview-chapter" }));
    const props = { session: SESSION, organizationId: "preview-org", chapterId: "preview-chapter", locale: "en", preview: true, api };
    render(<LearningHomeCard {...props} />);
    // The highest-priority live English fixture leads the rotation.
    expect(await screen.findByRole("heading", { name: "Sample lesson: keep a simple work log" })).toBeInTheDocument();
    const onSection = vi.fn();
    render(<LearningLearnArea {...props} section="manage" onSection={onSection} />);
    expect(await screen.findByText(T("manage.previewMode"))).toBeInTheDocument();
    expect(await screen.findByText("Sample draft: still in review")).toBeInTheDocument();
  });

  it("applies the same rules as the server: publication needs review, windows are checked", async () => {
    const api = createLearningPreviewApi(createLearningPreviewStore({ organizationId: "o", chapterId: "c" }));
    const { items } = await api.getWorkspace({ chapterId: "c", scope: "chapter" });
    const draftItem = items.find((entry) => entry.status === "draft");
    await expect(api.transition({ chapterId: "c", id: draftItem.id, action: "publish", expectedRevision: draftItem.revision })).rejects.toMatchObject({ code: "22023" });
    await expect(api.transition({ chapterId: "c", id: draftItem.id, action: "publish", expectedRevision: draftItem.revision + 1 })).rejects.toMatchObject({ code: "PT409" });
    const saved = await api.saveContent({ chapterId: "c", scope: "chapter", draft: { ...draftItem, locale_state: "reviewed", rights_note: "Fiction", review_note: "Fiction", source: "Fiction" }, expectedRevision: draftItem.revision });
    expect(saved).toMatchObject({ status: "draft", revision: draftItem.revision + 1 });
    const published = await api.transition({ chapterId: "c", id: saved.id, action: "publish", expectedRevision: saved.revision });
    expect(published.status).toBe("published");
    const history = await api.getHistory({ chapterId: "c", id: saved.id });
    expect(history.items.map((entry) => entry.action).slice(0, 2)).toEqual(["publish", "save_draft"]);
    const listed = await api.listContent({ chapterId: "c", locale: "en", kind: "quote", offset: 0, limit: 100 });
    expect(listed.items.map((entry) => entry.id)).toContain(saved.id);
    expect(listed.items.every((entry) => entry.locale === "en" && entry.kind === "quote" && entry.rights_note === "")).toBe(true);
  });
});

describe("Learn routing and view wiring", () => {
  it("addresses the manage section with a query and nothing else", () => {
    expect(learningSectionFromLocation("/m/rights?learning=manage")).toBe("manage");
    expect(learningSectionFromLocation("/m/rights?demo=1&learning=manage#top")).toBe("manage");
    expect(learningSectionFromLocation("/m/rights?learning=admin")).toBeNull();
    expect(learningSectionFromLocation("/m/rights")).toBeNull();
    expect(learningSectionPath("manage")).toBe("/m/rights?learning=manage");
    expect(learningSectionPath(null)).toBe("/m/rights");
  });

  it("mounts only the manage page in Learn when that section is addressed, and the library otherwise", async () => {
    const client = createClient({ get_learning_policy: policy({ canManage: true }), get_learning_workspace: { items: [], hasMore: false, policy: { quotes_enabled: true, lessons_enabled: true, selected_ids: null }, canManage: true, isPlatformOwner: false }, list_learning_content: page([]) });
    const learningContent = { client, session: SESSION, organizationId: ORG, chapterId: CHAPTER, locale: "en", memberHat: false };
    const managing = render(<RightsView data={fallbackData} onSaveProgress={() => {}} onRequestSteward={() => Promise.resolve()} learningContent={learningContent} learningSection="manage" onLearningSection={() => {}} />);
    expect(await screen.findByRole("heading", { level: 1, name: T("manage.title") })).toBeInTheDocument();
    expect(screen.queryByText(fallbackData.rights.lessonRecords[0].title)).toBeNull();
    managing.unmount();
    render(<RightsView data={fallbackData} onSaveProgress={() => {}} onRequestSteward={() => Promise.resolve()} learningContent={learningContent} onLearningSection={() => {}} />);
    expect(await screen.findByRole("heading", { name: T("library.title") })).toBeInTheDocument();
    const row = await screen.findByRole("button", { name: new RegExp(T("library.manage")) });
    expect(row).not.toHaveTextContent("Staff tool");
    expect(screen.getAllByText(fallbackData.rights.lessonRecords[0].title).length).toBeGreaterThan(0);
  });

  it.each([
    ["en", false, "Staff tool"],
    ["es", true, "Herramienta del personal"],
  ])("labels the Rights management entry for the Member hat in %s", async (lang, alt, label) => {
    const client = createClient({ get_learning_policy: policy({ canManage: true }), list_learning_content: page([]) });
    const onSection = vi.fn();
    render(
      <LanguageProvider lang={lang}>
        <RightsView alt={alt} data={fallbackData} onSaveProgress={vi.fn()} onRequestSteward={vi.fn()}
          learningContent={{ client, session: SESSION, organizationId: ORG, chapterId: CHAPTER, locale: lang, memberHat: true }}
          onLearningSection={onSection} />
      </LanguageProvider>,
    );
    const row = await screen.findByRole("button", { name: new RegExp(appT(lang, "learningContent.library.manage")) });
    expect(row).toHaveTextContent(label);
    fireEvent.click(row);
    expect(onSection).toHaveBeenCalledWith("manage");
  });

  it("keeps the Rights management entry hidden when the server denies it", async () => {
    const client = createClient({ get_learning_policy: policy(), list_learning_content: page([]) });
    render(<RightsView data={fallbackData} onSaveProgress={vi.fn()} onRequestSteward={vi.fn()}
      learningContent={{ client, session: SESSION, organizationId: ORG, chapterId: CHAPTER, memberHat: true }}
      onLearningSection={vi.fn()} />);
    await waitFor(() => expect(names(client)).toContain("get_learning_policy"));
    await screen.findByText(T("library.empty"));
    expect(screen.queryByRole("button", { name: new RegExp(T("library.manage")) })).toBeNull();
  });
});

describe("Settings entrance for every hat", () => {
  const STAFF_HATS = ["steward", "coordinator", "advisor", "admin", "vp"];
  const managerWorkspace = { items: [], hasMore: false, policy: { quotes_enabled: true, lessons_enabled: true, selected_ids: null }, canManage: true, isPlatformOwner: false };

  function settings(client, { lang = "en", alt = false, learningSection = null, onSection = vi.fn(), learningContent = {} } = {}) {
    const view = render(
      <LanguageProvider lang={lang}>
        <SettingsView alt={alt} data={{ member: { initials: "AV" }, roles: ["admin"] }} lang={lang} onNavigate={vi.fn()} onAssistant={vi.fn()} onProfile={vi.fn()}
          learningContent={{ client, session: SESSION, organizationId: ORG, chapterId: CHAPTER, locale: lang, ...learningContent }}
          learningSection={learningSection} onLearningSection={onSection} />
      </LanguageProvider>,
    );
    return { ...view, onSection };
  }

  it("keeps the hat guards unchanged: Settings is already open to every hat, Learn is not", () => {
    for (const hat of STAFF_HATS) {
      expect(explicitHatAllowsView(hat, "settings", false, [hat], true, "/m/settings"), hat).toBe(true);
      expect(explicitHatAllowsView(hat, "rights", false, [hat], true, "/m/rights"), hat).toBe(false);
    }
  });

  it("offers the editor in the Settings overview to a manager after one policy read and no content read", async () => {
    const client = createClient({ get_learning_policy: policy({ canManage: true }) });
    const { onSection } = settings(client);
    const row = await screen.findByRole("button", { name: new RegExp(T("library.manage")) });
    expect(row).not.toHaveTextContent("Staff tool");
    fireEvent.click(row);
    expect(onSection).toHaveBeenCalledWith("manage");
    await flush();
    expect(client.calls).toEqual([{ name: "get_learning_policy", params: { p_chapter_id: CHAPTER } }]);
  });

  it.each([
    ["en", false, "Staff tool"],
    ["es", true, "Herramienta del personal"],
  ])("labels the Settings management entry for the Member hat in %s", async (lang, alt, label) => {
    const client = createClient({ get_learning_policy: policy({ canManage: true }) });
    const { onSection } = settings(client, { lang, alt, learningContent: { memberHat: true } });
    const row = await screen.findByRole("button", { name: new RegExp(appT(lang, "learningContent.library.manage")) });
    expect(row).toHaveTextContent(label);
    fireEvent.click(row);
    expect(onSection).toHaveBeenCalledWith("manage");
  });

  it("shows no entry to anyone the server does not recognize, and still reads nothing but the policy", async () => {
    const client = createClient({ get_learning_policy: policy({ canManage: false, isPlatformOwner: false }) });
    settings(client, { learningContent: { memberHat: true } });
    await waitFor(() => expect(names(client)).toEqual(["get_learning_policy"]));
    await flush();
    expect(screen.queryByRole("button", { name: new RegExp(T("library.manage")) })).toBeNull();
    expect(names(client)).toEqual(["get_learning_policy"]);
  });

  it("offers the entry to a platform owner with no tenant, in the member's language from the app catalogue", async () => {
    const client = createClient({ get_learning_policy: { organizationId: null, chapterId: null, quotesEnabled: false, lessonsEnabled: false, homeHidden: false, canManage: false, isPlatformOwner: true, version: "1" } });
    settings(client, { lang: "es", learningContent: { organizationId: null, chapterId: null } });
    expect(await screen.findByRole("button", { name: new RegExp(ES("library.manage")) })).toBeInTheDocument();
    expect(client.calls).toEqual([{ name: "get_learning_policy", params: { p_chapter_id: null } }]);
  });

  it("mounts only the editor at /m/settings?learning=manage and returns to Settings", async () => {
    const client = createClient({ get_learning_policy: policy({ canManage: true }), get_learning_workspace: managerWorkspace });
    const { container, onSection } = settings(client, { learningSection: "manage" });
    expect(await screen.findByRole("heading", { level: 1, name: T("manage.title") })).toBeInTheDocument();
    expect(await screen.findByText(T("items.empty"))).toBeInTheDocument();
    expect(container.querySelector(".morehub-profile")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^.?${T("manage.backSettings")}$`) }));
    expect(onSection).toHaveBeenCalledWith(null);
  });

  it("refuses a direct entry by a non-manager, and a signed-out one, with a way back to Settings", async () => {
    const member = createClient({ get_learning_policy: policy() });
    const view = settings(member, { learningSection: "manage" });
    expect(await screen.findByText(T("manage.notAllowed"))).toBeInTheDocument();
    expect(names(member)).toEqual(["get_learning_policy"]);
    view.unmount();
    const signedOut = settings(createClient({}), { learningSection: "manage", learningContent: { session: null } });
    expect(screen.getByText(T("manage.notAllowed"))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: new RegExp(T("manage.backSettings")) }));
    expect(signedOut.onSection).toHaveBeenCalledWith(null);
  });

  it("keeps Learn's editor returning to Learn", async () => {
    const client = createClient({ get_learning_policy: policy({ canManage: true }), get_learning_workspace: managerWorkspace });
    const onSection = vi.fn();
    render(<LearningLearnArea client={client} session={SESSION} organizationId={ORG} chapterId={CHAPTER} locale="en" section="manage" onSection={onSection} />);
    await screen.findByText(T("items.empty"));
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^.?${T("manage.back")}$`) }));
    expect(onSection).toHaveBeenCalledWith(null);
    expect(screen.queryByText(T("manage.backSettings"))).toBeNull();
  });

  it("addresses each editor page exactly, never a Settings subpage", () => {
    expect(learningSectionFromLocation("/m/settings?learning=manage", "settings")).toBe("manage");
    expect(learningSectionFromLocation("/m/settings/?demo=1&learning=manage", "settings")).toBe("manage");
    expect(learningSectionFromLocation("/m/settings/profile?learning=manage", "settings")).toBeNull();
    expect(learningSectionFromLocation("/m/rights?learning=manage", "settings")).toBeNull();
    expect(learningSectionFromLocation("/m/rights?learning=manage", "rights")).toBe("manage");
    expect(learningSectionPath("manage", "settings")).toBe("/m/settings?learning=manage");
    expect(learningSectionPath(null, "settings")).toBe("/m/settings");
    expect(learningSectionPath("manage", "rights")).toBe("/m/rights?learning=manage");
  });
});

describe("recovered revisions, local times and the shared catalogue", () => {
  it("labels the recovered first revision in history", async () => {
    const client = createClient({
      get_learning_policy: policy({ canManage: true }),
      get_learning_workspace: { items: [row({ id: "rec", status: "draft", starts_at: null, locale_state: "draft", title: "Recovered motto", revision: 1, provenance: { donor_path: "lib/knowledge/knowledge-engine-seed.ts" } })], hasMore: false, policy: { quotes_enabled: false, lessons_enabled: false, selected_ids: null }, canManage: true, isPlatformOwner: false },
      get_learning_history: page([{ revision: 1, action: "recover_draft", changed_at: new Date(0).toISOString(), changed_by: null, snapshot: { title: "Recovered motto", body: "Body", kind: "quote", status: "draft" } }]),
    });
    render(<LearningLearnArea client={client} session={SESSION} organizationId={ORG} chapterId={CHAPTER} locale="en" section="manage" onSection={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: `${T("items.edit")} Recovered motto` }));
    fireEvent.click(screen.getByRole("button", { name: T("history.show") }));
    expect(await screen.findByText(T("history.entry", { revision: 1, action: T("history.action_recover_draft") }))).toBeInTheDocument();
  });

  it("refuses local times that would silently move instead of converting them", () => {
    expect(instantFromLocalInput("")).toBeNull();
    expect(instantFromLocalInput("2026-10-01T09:30")).toBe(new Date(2026, 9, 1, 9, 30).toISOString());
    for (const text of ["2026-10-01T12:75", "2026-10-01T24:00", "2026-02-30T10:00", "2026-10-01T09:30:61", "0099-10-01T09:30", "tomorrow"]) {
      expect(instantFromLocalInput(text), text).toBe("invalid");
    }
    // A wall time the device's zone skips at a daylight-saving change, if it has one.
    const pad = (value) => String(value).padStart(2, "0");
    let skipped = null;
    for (let day = 0; day < 366 && !skipped; day += 1) {
      const date = new Date(2026, 0, 1 + day);
      for (let hour = 0; hour < 24 && !skipped; hour += 1) {
        const text = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(hour)}:30`;
        if (new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, 30).getHours() !== hour) skipped = text;
      }
    }
    if (skipped) expect(instantFromLocalInput(skipped)).toBe("invalid");
  });

  it("registers the chunk in the app catalogue so every key resolves through t()", () => {
    for (const locale of ["en", "es"]) {
      for (const [key, value] of Object.entries(learningContentCatalogue[locale])) {
        expect(appCatalogue[locale][key], `${locale} ${key}`).toBe(value);
      }
    }
    expect(appT("es", "learningContent.history.action_recover_draft")).toBe("Recuperado como borrador");
  });
});

describe("review regressions and complete authoring", () => {
  it("retries a failed Home batch on the next unchanged policy refresh, then caches success", async () => {
    let attempts = 0;
    const client = createClient({ get_learning_policy: policy(), list_learning_content: () => ++attempts === 1 ? { error: { code: '503' }, data: null } : page([row()]) });
    render(card(client));
    await waitFor(() => expect(attempts).toBe(1)); await flush();
    fireEvent(window, new Event('focus'));
    expect(await screen.findByText('Quote body.')).toBeInTheDocument();
    fireEvent(window, new Event('focus')); await flush();
    expect(attempts).toBe(2);
  });
  it("retries the failed lesson list even when policy did not change", async () => {
    let attempts=0;
    const client=createClient({get_learning_policy:policy(),list_learning_content:()=>++attempts===1?{error:{code:'503'},data:null}:page([row({kind:'mini_lesson',title:'Recovered lesson'})])});
    render(<LearningLearnArea client={client} session={SESSION} organizationId={ORG} chapterId={CHAPTER} locale="en" />);
    fireEvent.click(await screen.findByRole('button',{name:T('library.retry')}));
    expect(await screen.findByRole('button',{name:'Recovered lesson'})).toBeInTheDocument();expect(attempts).toBe(2);
  });
  it("preserves unsaved edits by disabling withdrawal", () => {
    const api={getHistory:vi.fn().mockResolvedValue({items:[],hasMore:false}),transition:vi.fn()};
    render(<LearningEditor api={api} scope={{chapterId:CHAPTER,locale:'en'}} workspaceScope="chapter" item={row()} onSaved={()=>{}} onBack={()=>{}} />);
    fireEvent.change(screen.getByLabelText(T('editor.title')),{target:{value:'Unsaved title'}});
    const withdraw=screen.getByRole('button',{name:T('publish.withdraw')});expect(withdraw).toBeDisabled();fireEvent.click(withdraw);
    expect(api.transition).not.toHaveBeenCalled();expect(screen.getByLabelText(T('editor.title'))).toHaveValue('Unsaved title');
  });
  it("authors all direction and review fields, validates lists and previews a lesson without requests", async () => {
    const api={saveContent:vi.fn(async ({draft})=>row({...draft,id:'new-reviewed-draft',status:'draft',starts_at:null,revision:1})),getHistory:vi.fn().mockResolvedValue({items:[],hasMore:false})};
    render(<LearningEditor api={api} scope={{chapterId:CHAPTER,locale:'en'}} workspaceScope="platform" item={null} onSaved={()=>{}} onBack={()=>{}} />);
    fireEvent.click(screen.getByRole('button',{name:T('editor.save')}));
    expect(await screen.findByRole('alert')).toHaveTextContent(T('editor.fixErrors'));
    fireEvent.change(screen.getByLabelText(T('editor.kind')),{target:{value:'mini_lesson'}});
    for(const [key,value] of [['title','Authored lesson'],['bodyLesson','A useful lesson.'],['attribution','Named writer'],['learningOutcome','Identify a next step'],['tone','Calm'],['priority','45'],['source','Source document'],['rightsNote','Permission recorded'],['reviewNote','Reviewed today'],['direction','Help new members prepare']])fireEvent.change(screen.getByLabelText(T(`editor.${key}`)),{target:{value}});
    fireEvent.change(screen.getByLabelText(T('editor.locale')),{target:{value:'es'}});
    fireEvent.change(screen.getByLabelText(T('editor.audience')),{target:{value:'staff'}});
    fireEvent.click(screen.getByLabelText(T('editor.localeReviewed')));
    fireEvent.click(screen.getByLabelText(T('editor.isDefault')));
    fireEvent.click(screen.getByLabelText(T('editor.factualClaims')));
    for(const type of ['Bullet','Topic']){
      fireEvent.click(screen.getByRole('button',{name:T(`editor.add${type}`)}));
      const label=T(`editor.${type.toLowerCase()}`,{number:1});
      fireEvent.change(screen.getByLabelText(label),{target:{value:'x'.repeat(type==='Bullet'?201:81)}});
      expect(screen.getByLabelText(label)).toHaveAttribute('aria-invalid','true');
      fireEvent.change(screen.getByLabelText(label),{target:{value:'One useful point'}});
      fireEvent.click(screen.getByRole('button',{name:T(`editor.add${type}`)}));
      fireEvent.click(screen.getByRole('button',{name:T(`editor.remove${type}`,{number:2})}));
    }
    const preview=within(screen.getByRole('region',{name:T('preview.title')}));
    fireEvent.click(preview.getByRole('button',{name:T('home.readMore')}));
    fireEvent.click(preview.getByRole('button',{name:T('home.readLess')}));
    fireEvent.click(preview.getByRole('button',{name:T('preview.learn')}));
    fireEvent.click(preview.getByRole('button',{name:T('preview.home')}));
    const leave=new Event('beforeunload',{cancelable:true});window.dispatchEvent(leave);expect(leave.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole('button',{name:T('editor.save')}));
    await waitFor(()=>expect(api.saveContent).toHaveBeenCalledTimes(1));
    expect(api.saveContent.mock.calls[0][0].draft).toMatchObject({locale:'es',audience:'staff',topics:['One useful point'],bullets:['One useful point'],direction:'Help new members prepare',is_default:true});
  });
  it("keeps a stale policy form from overriding a concurrent disable, and offers an explicit reload", async()=>{
    let revision=1;let enabled=true;
    const client=createClient({get_learning_policy:policy({canManage:true}),get_learning_workspace:()=>({items:[],hasMore:false,policy:{quotes_enabled:enabled,lessons_enabled:true,selected_ids:null,revision},canManage:true,isPlatformOwner:false}),save_learning_policy:()=>({data:null,error:{code:'PT409',message:'revision conflict'}})});
    render(<LearningLearnArea client={client} session={SESSION} organizationId={ORG} chapterId={CHAPTER} locale="en" section="manage" />);
    const toggle=await screen.findByLabelText(T('settings.lessons'));fireEvent.click(toggle);revision=2;enabled=false;
    fireEvent.click(screen.getByRole('button',{name:T('settings.save')}));
    fireEvent.click(await screen.findByRole('button',{name:T('settings.reload')}));
    await waitFor(()=>expect(screen.getByLabelText(T('settings.quotes'))).not.toBeChecked());
    expect(callsTo(client,'save_learning_policy')[0].params.p_expected_revision).toBe(1);
    expect(callsTo(client,'save_learning_policy')).toHaveLength(1);
  });
  it("pages the editorial workspace and recovers a failed next page without losing existing items",async()=>{
    let attempts=0;
    const client=createClient({get_learning_policy:policy({canManage:true}),get_learning_workspace:({p_offset})=>p_offset&&++attempts===1?{data:null,error:{code:'503'}}:({items:[row({id:p_offset?'second':'first',title:p_offset?'Second item':'First item'})],hasMore:!p_offset,policy:{quotes_enabled:true,lessons_enabled:true,selected_ids:null,revision:1},canManage:true,isPlatformOwner:false})});
    render(<LearningLearnArea client={client} session={SESSION} organizationId={ORG} chapterId={CHAPTER} locale="en" section="manage" />);
    await screen.findByText('First item');
    fireEvent.click(screen.getByRole('button',{name:T('items.loadMore')}));
    await waitFor(()=>expect(attempts).toBe(1));await flush();
    expect(screen.getByText('First item')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:T('items.loadMore')}));
    expect(await screen.findByText('Second item')).toBeInTheDocument();
  });
});

describe('preview governance contract',()=>{
  const setup=()=>{const store=createLearningPreviewStore({organizationId:ORG,chapterId:CHAPTER});return {store,api:createLearningPreviewApi(store)};};
  it('applies selection intersection, module disable, personal hiding and policy revision conflicts',async()=>{
    const {store,api}=setup();const choices=await api.listChoices({scope:'chapter'});expect(choices.items.length).toBeGreaterThan(0);
    expect((await api.listChoices({scope:'platform'})).items.every(x=>x.scope==='platform')).toBe(true);
    expect((await api.listChoices({scope:'organization'})).items.every(x=>x.scope!=='chapter')).toBe(true);
    const selected=choices.items.find(x=>x.locale==='en'&&x.status==='published');
    const before=await api.getWorkspace({scope:'chapter'});
    const changed=await api.savePolicy({scope:'chapter',quotesEnabled:true,lessonsEnabled:true,selectedIds:[selected.id],expectedRevision:before.policy.revision});
    expect((await api.listContent({locale:'en'})).items.map(x=>x.id)).toEqual([selected.id]);
    await expect(api.savePolicy({scope:'chapter',quotesEnabled:false,lessonsEnabled:false,selectedIds:null,expectedRevision:before.policy.revision})).rejects.toMatchObject({code:'PT409'});
    await api.savePolicy({scope:'chapter',quotesEnabled:false,lessonsEnabled:false,selectedIds:null,expectedRevision:changed.revision});expect((await api.listContent({locale:'en'})).items).toEqual([]);
    await api.setHomeHidden({hidden:true});expect((await api.getPolicy()).homeHidden).toBe(true);await api.setHomeHidden({hidden:false});expect((await api.getPolicy()).homeHidden).toBe(false);
    await expect(api.savePolicy({scope:'platform',quotesEnabled:true,lessonsEnabled:true,selectedIds:[],expectedRevision:store.policies.platform.revision})).rejects.toMatchObject({code:'22023'});
    await expect(api.savePolicy({scope:'chapter',quotesEnabled:null,lessonsEnabled:true,selectedIds:null,expectedRevision:store.policies.chapter.revision})).rejects.toMatchObject({code:'22023'});
  });
  it('keeps draft, scheduled, withdrawn and stale revisions separate',async()=>{
    const {api}=setup();const draft={...row(),id:null,status:undefined,starts_at:null};
    await expect(api.saveContent({scope:'chapter',draft:{...draft,title:''}})).rejects.toMatchObject({code:'22023'});
    await expect(api.saveContent({scope:'chapter',draft,expectedRevision:1})).rejects.toMatchObject({code:'PT409'});
    let saved=await api.saveContent({scope:'platform',draft:{...draft,is_default:true}});
    await expect(api.saveContent({scope:'chapter',draft:{...saved,title:'Wrong scope',is_default:false},expectedRevision:saved.revision})).rejects.toMatchObject({code:'42501'});
    await expect(api.saveContent({scope:'platform',draft:saved,expectedRevision:0})).rejects.toMatchObject({code:'PT409'});
    await expect(api.transition({id:saved.id,action:'publish',expectedRevision:0})).rejects.toMatchObject({code:'PT409'});
    await expect(api.transition({id:'absent',action:'publish',expectedRevision:1})).rejects.toMatchObject({code:'42501'});
    await expect(api.transition({id:saved.id,action:'unknown',expectedRevision:saved.revision})).rejects.toMatchObject({code:'22023'});
    saved=await api.transition({id:saved.id,action:'schedule',expectedRevision:saved.revision,startsAt:new Date(Date.now()+86400000).toISOString()});
    expect((await api.listContent({locale:'en'})).items.some(x=>x.id===saved.id)).toBe(false);
    saved=await api.transition({id:saved.id,action:'publish',expectedRevision:saved.revision});
    expect((await api.listContent({locale:'en',kind:'quote'})).items.some(x=>x.id===saved.id)).toBe(true);
    saved=await api.transition({id:saved.id,action:'withdraw',expectedRevision:saved.revision});
    expect((await api.listContent({locale:'en'})).items.some(x=>x.id===saved.id)).toBe(false);
    expect((await api.getHistory({id:saved.id})).items.map(x=>x.action)).toEqual(['withdraw','publish','schedule','save_draft']);
    await expect(api.getHistory({id:'absent'})).rejects.toMatchObject({code:'42501'});
    const tenant=await api.saveContent({scope:'organization',draft});expect(tenant.chapter_id).toBeNull();
  });
});

// Hide from Home and Publish now keep focus while their write
// runs, and a second activation in the same tick sends nothing more.
describe("learning content writes while one runs", () => {
  const spied = (client) => { client.rpc = vi.fn(client.rpc); return client; };
  const homeClient = () => spied(createClient({
    get_learning_policy: policy(),
    list_learning_content: page([row({ title: "Hideable quote" })]),
    set_learning_home_hidden: (params) => ({ homeHidden: params.p_hidden }),
  }));

  it("keeps Hide focused while the quote is hidden, and hides once", async () => {
    const client = homeClient();
    render(card(client));
    await expectHeldWriteFocus(client.rpc, await screen.findByRole("button", { name: T("home.hide") }));
    expect(callsTo(client, "set_learning_home_hidden")).toHaveLength(1);
  });

  it("hides once when Hide is activated twice in one tick", async () => {
    const client = homeClient();
    render(card(client));
    const hide = await screen.findByRole("button", { name: T("home.hide") });
    await expectOneWriteFromOneTick(client.rpc, [() => fireEvent.click(hide), () => fireEvent.click(hide)], { isWrite: isRpcWrite });
  });

  // The manage editor's helpers, as in "manage editor" above.
  const workspace = (items = []) => ({
    items, hasMore: false, policy: { scope_key: `chapter:${CHAPTER}`, scope: "chapter", quotes_enabled: true, lessons_enabled: true, selected_ids: null, revision: 1 },
    canManage: true, isPlatformOwner: false,
  });
  const manage = (client) => <LearningLearnArea client={client} session={SESSION} organizationId={ORG} chapterId={CHAPTER} locale="en" section="manage" onSection={() => {}} />;
  const manageClient = () => spied(createClient({
    get_learning_policy: policy({ canManage: true }),
    get_learning_workspace: workspace([row({ id: "r1", status: "draft", starts_at: null, title: "Ready quote", revision: 6 })]),
    transition_learning_content: (params) => row({ id: params.p_id, title: "Ready quote", status: "published", revision: params.p_expected_revision + 1 }),
  }));
  const publishButton = async () => {
    fireEvent.click(await screen.findByRole("button", { name: `${T("items.edit")} Ready quote` }));
    return screen.getByRole("button", { name: T("publish.publishNow") });
  };

  it("keeps Publish now focused while it publishes, and publishes once", async () => {
    const client = manageClient();
    render(manage(client));
    await expectHeldWriteFocus(client.rpc, await publishButton());
    expect(callsTo(client, "transition_learning_content")).toHaveLength(1);
  });

  it("publishes once when Publish now is activated twice in one tick", async () => {
    const client = manageClient();
    render(manage(client));
    const publish = await publishButton();
    await expectOneWriteFromOneTick(client.rpc, [() => fireEvent.click(publish), () => fireEvent.click(publish)], { isWrite: isRpcWrite });
  });
});

// The editor's Save and the module settings' Save keep focus
// while their own save runs, refuse a second activation in the same tick, and
// keep their own pending state when something else resets the status line.
describe("learning content saves while they run", () => {
  const workspaceFor = (scope, patch = {}) => ({
    items: [], hasMore: false, policy: { scope_key: `${scope}:${CHAPTER}`, scope, quotes_enabled: true, lessons_enabled: true, selected_ids: null, revision: 1 },
    canManage: true, isPlatformOwner: false, ...patch,
  });
  const area = (client) => <LearningLearnArea client={client} session={SESSION} organizationId={ORG} chapterId={CHAPTER} locale="en" section="manage" onSection={() => {}} />;
  const policySaved = (params) => ({ quotes_enabled: params.p_quotes_enabled, lessons_enabled: params.p_lessons_enabled, selected_ids: params.p_selected_ids, revision: 2 });
  async function openNewQuote(save) {
    const client = createClient({ get_learning_policy: policy({ canManage: true }), get_learning_workspace: workspaceFor("chapter"), save_learning_content: save });
    render(area(client));
    fireEvent.click(await screen.findByRole("button", { name: T("items.newQuote") }));
    fireEvent.change(screen.getByLabelText(T("editor.title")), { target: { value: "On standing together" } });
    fireEvent.change(screen.getByLabelText(T("editor.bodyQuote")), { target: { value: "Stand together." } });
    return screen.getByRole("button", { name: T("editor.save") });
  }
  const savedQuote = (params) => row({ ...params.p_item, id: "new-1", status: "draft", starts_at: null, revision: 1 });

  it("keeps the editor's Save focused and pending while the item saves", async () => {
    const save = vi.fn(savedQuote);
    await expectHeldWriteFocus(save, await openNewQuote(save));
    expect(save).toHaveBeenCalledOnce();
  });

  it("saves one item when the editor's Save is activated twice in one tick", async () => {
    const save = vi.fn(savedQuote);
    const button = await openNewQuote(save);
    await expectOneWriteFromOneTick(save, [() => fireEvent.click(button), () => fireEvent.click(button)]);
  });

  it("saves the item again from an immediate press after a save that throws at once", async () => {
    const save = vi.fn(savedQuote);
    await expectReadyRetryAfterThrowAtOnce(save, await openNewQuote(save));
  });

  async function openSettings(save, extra = {}) {
    const client = createClient({
      get_learning_policy: policy({ canManage: true }),
      get_learning_workspace: (params) => workspaceFor(params.p_scope),
      save_learning_policy: save,
      ...extra,
    });
    render(area(client));
    fireEvent.click(await screen.findByLabelText(T("settings.quotes")));
    return client;
  }

  it("keeps the settings Save focused, pending and refusing while a field edited during the save resets the status", async () => {
    let answer;
    const save = vi.fn(() => new Promise((resolve) => { answer = resolve; }));
    await openSettings(save);
    const button = screen.getByRole("button", { name: T("settings.save") });
    button.focus();
    fireEvent.click(button);
    expect(save).toHaveBeenCalledOnce();
    // Editing a field sets the status line back to idle while the save runs.
    fireEvent.click(screen.getByLabelText(T("settings.lessons")));
    expect(button).toBeEnabled();
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveFocus();
    fireEvent.click(button);
    expect(save).toHaveBeenCalledOnce();
    await act(async () => { answer(policySaved(save.mock.calls[0][0])); });
    expect(button).not.toHaveAttribute("aria-busy");
  });

  it("offers another scope's settings Save at once while the earlier scope's save still runs", async () => {
    let answer;
    const save = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; })).mockImplementation(policySaved);
    await openSettings(save);
    fireEvent.click(screen.getByRole("button", { name: T("settings.save") }));
    expect(save).toHaveBeenCalledOnce();
    // The unsaved edit asks before the scope changes; the member confirms.
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: T("scope.organization") }));
    confirm.mockRestore();
    const organizationSave = await screen.findByRole("button", { name: T("settings.save") });
    fireEvent.click(screen.getByLabelText(T("settings.quotes")));
    expect(organizationSave).not.toHaveAttribute("aria-disabled");
    fireEvent.click(organizationSave);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0].p_scope).toBe("organization");
    await act(async () => { answer(policySaved(save.mock.calls[0][0])); });
  });

  it("keeps the editor's Save pending through a withdrawal that answers while the save runs", async () => {
    let answerWithdraw;
    let answerSave;
    const api = {
      getHistory: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
      transition: vi.fn(() => new Promise((resolve) => { answerWithdraw = resolve; })),
      saveContent: vi.fn(() => new Promise((resolve) => { answerSave = resolve; })),
    };
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<LearningEditor api={api} scope={{ chapterId: CHAPTER, locale: "en" }} workspaceScope="chapter" item={row()} onSaved={() => {}} onBack={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: T("publish.withdraw") }));
    expect(api.transition).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByLabelText(T("editor.title")), { target: { value: "Edited while withdrawing" } });
    const save = screen.getByRole("button", { name: T("editor.save") });
    save.focus();
    fireEvent.click(save);
    expect(api.saveContent).toHaveBeenCalledOnce();
    // The withdrawal's answer resets the editor's status line to idle.
    // The withdrawal answers with the item's next revision, as the server's
    // transition increments it (row() is at revision 2).
    await act(async () => { answerWithdraw(row({ status: "draft", revision: 3 })); });
    expect(save).toBeEnabled();
    expect(save).toHaveAttribute("aria-disabled", "true");
    expect(save).toHaveFocus();
    fireEvent.click(save);
    expect(api.saveContent).toHaveBeenCalledOnce();
    // The withdrawal already moved the revision, so the save sent at revision 2
    // is refused as a conflict; the edit stays on screen and Save is ready.
    await act(async () => { answerSave(Promise.reject(Object.assign(new Error("revision conflict"), { code: "PT409" }))); });
    expect(screen.getByLabelText(T("editor.title"))).toHaveValue("Edited while withdrawing");
    expect(save).not.toHaveAttribute("aria-disabled");
    confirm.mockRestore();
  });

  // An edit made while a save runs is not what that save
  // sent; it stays, reads unsaved, and the next ready press of Save sends it.
  it.each(["edit then press", "press then edit"])("keeps an editor edit made while the save ran, unsaved, and sends it next (%s)", async (order) => {
    let answer;
    const api = {
      getHistory: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
      saveContent: vi.fn().mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; })).mockImplementation(async ({ draft }) => row({ title: draft.title, revision: 3 })),
    };
    render(<LearningEditor api={api} scope={{ chapterId: CHAPTER, locale: "en" }} workspaceScope="chapter" item={row({ revision: 1 })} onSaved={() => {}} onBack={() => {}} />);
    const title = screen.getByLabelText(T("editor.title"));
    fireEvent.change(title, { target: { value: "First edit" } });
    const save = screen.getByRole("button", { name: T("editor.save") });
    fireEvent.click(save);
    expect(api.saveContent).toHaveBeenCalledOnce();
    const edit = () => fireEvent.change(screen.getByLabelText(T("editor.title")), { target: { value: "Second edit" } });
    if (order === "edit then press") { edit(); fireEvent.click(save); } else { fireEvent.click(save); edit(); }
    expect(api.saveContent).toHaveBeenCalledOnce();
    await act(async () => { answer(row({ title: "First edit", revision: 2 })); });
    expect(screen.getByLabelText(T("editor.title"))).toHaveValue("Second edit");
    expect(screen.queryByText(T("editor.saved", { revision: 2 }))).toBeNull();
    expect(screen.getByText(T("editor.unsaved"))).toBeInTheDocument();
    expect(save).toBeEnabled();
    expect(save).not.toHaveAttribute("aria-disabled");
    fireEvent.click(save);
    await waitFor(() => expect(api.saveContent).toHaveBeenCalledTimes(2));
    expect(api.saveContent.mock.calls[1][0]).toMatchObject({ expectedRevision: 2, draft: expect.objectContaining({ title: "Second edit" }) });
  });

  // A stand-in for save_learning_content that keeps the server's revision
  // rules (20260929060000_learning_revision_http_conflicts.sql lines 37-47):
  // a write without an id creates the item and may carry no expected
  // revision; a write with an id must carry the stored revision and raises it.
  // The write commits when it is called; `hold` keeps its answer back.
  function contentServer() {
    const stored = new Map();
    const held = [];
    let next = 0;
    let holding = false;
    const conflict = { data: null, error: { code: "PT409", message: "revision conflict" } };
    const client = createClient({
      save_learning_content: ({ p_item, p_expected_revision }) => {
        const { id, ...payload } = p_item;
        let result;
        if (!id) {
          if (p_expected_revision != null) result = conflict;
          else {
            next += 1;
            result = row({ ...payload, id: `new-${next}`, status: "draft", starts_at: null, revision: 1 });
          }
        } else if (!stored.has(id) || stored.get(id).revision !== p_expected_revision) {
          result = conflict;
        } else {
          result = row({ ...payload, id, status: "draft", starts_at: null, revision: stored.get(id).revision + 1 });
        }
        if (result !== conflict) stored.set(result.id, result);
        if (!holding) return result;
        const answer = deferred();
        held.push(() => answer.resolve(result));
        return answer.promise;
      },
    });
    return {
      client, stored, api: { ...createLearningContentApi(client), getHistory: vi.fn().mockResolvedValue({ items: [], hasMore: false }) },
      hold: () => { holding = true; },
      release: () => { holding = false; },
      answerNext: () => held.shift()(),
    };
  }

  // Create "Submitted A", edit to "Newer B" while the create runs, the create
  // answers with the assigned id, edit to "Final C" and press Save. The kept
  // draft must carry the assigned id: without it the next save sends no id
  // with expected revision 1, which the server refuses on every press.
  it("carries a new item's assigned id into the draft kept while its create ran, so the next Save updates it", async () => {
    const server = contentServer();
    const onSaved = vi.fn();
    render(<LearningEditor api={server.api} scope={{ chapterId: CHAPTER, locale: "en" }} workspaceScope="chapter" item={null} onSaved={onSaved} onBack={() => {}} />);
    const title = () => screen.getByLabelText(T("editor.title"));
    fireEvent.change(title(), { target: { value: "Submitted A" } });
    fireEvent.change(screen.getByLabelText(T("editor.bodyQuote")), { target: { value: "Stand together." } });
    const save = screen.getByRole("button", { name: T("editor.save") });
    server.hold();
    fireEvent.click(save);
    expect(callsTo(server.client, "save_learning_content")).toHaveLength(1);
    fireEvent.change(title(), { target: { value: "Newer B" } });
    server.release();
    await act(async () => { server.answerNext(); });
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: "new-1", revision: 1, title: "Submitted A" }));
    expect(title()).toHaveValue("Newer B");
    expect(save).not.toHaveAttribute("aria-disabled");
    fireEvent.change(title(), { target: { value: "Final C" } });
    fireEvent.click(save);
    await waitFor(() => expect(callsTo(server.client, "save_learning_content")).toHaveLength(2));
    const [first, second] = callsTo(server.client, "save_learning_content");
    expect(first.params.p_item).not.toHaveProperty("id");
    expect(first.params).toMatchObject({ p_expected_revision: null, p_item: { title: "Submitted A" } });
    expect(second.params).toMatchObject({ p_expected_revision: 1, p_item: { id: "new-1", title: "Final C", body: "Stand together." } });
    // The second save succeeds: C is saved on the server and on screen.
    expect(await screen.findByText(T("editor.saved", { revision: 2 }))).toBeInTheDocument();
    expect(screen.queryByText(T("error.conflict"))).toBeNull();
    expect(title()).toHaveValue("Final C");
    expect(server.stored.get("new-1")).toMatchObject({ title: "Final C", revision: 2 });
    expect(server.stored.size).toBe(1);
    expect(onSaved).toHaveBeenLastCalledWith(expect.objectContaining({ id: "new-1", revision: 2, title: "Final C" }));
    // Nothing is left unsent or unanswered, and a further press sends nothing.
    expect(screen.queryByText(T("editor.unsaved"))).toBeNull();
    fireEvent.click(save);
    await flush();
    expect(callsTo(server.client, "save_learning_content")).toHaveLength(2);
  });

  it("shows a new item's draft kept while its create ran as unsaved, then clean once the next Save answers", async () => {
    const server = contentServer();
    render(<LearningEditor api={server.api} scope={{ chapterId: CHAPTER, locale: "en" }} workspaceScope="chapter" item={null} onSaved={() => {}} onBack={() => {}} />);
    const title = () => screen.getByLabelText(T("editor.title"));
    fireEvent.change(title(), { target: { value: "Submitted A" } });
    fireEvent.change(screen.getByLabelText(T("editor.bodyQuote")), { target: { value: "Stand together." } });
    const save = screen.getByRole("button", { name: T("editor.save") });
    server.hold();
    fireEvent.click(save);
    fireEvent.change(title(), { target: { value: "Newer B" } });
    // A press of the pending Save sends nothing.
    fireEvent.click(save);
    expect(callsTo(server.client, "save_learning_content")).toHaveLength(1);
    server.release();
    await act(async () => { server.answerNext(); });
    // The kept draft is unsaved against the created item, with no saved notice.
    expect(title()).toHaveValue("Newer B");
    expect(screen.getByText(T("editor.unsaved"))).toBeInTheDocument();
    expect(screen.queryByText(T("editor.saved", { revision: 1 }))).toBeNull();
    expect(save).toBeEnabled();
    expect(save).not.toHaveAttribute("aria-disabled");
    fireEvent.click(save);
    await waitFor(() => expect(callsTo(server.client, "save_learning_content")).toHaveLength(2));
    expect(callsTo(server.client, "save_learning_content")[1].params).toMatchObject({ p_expected_revision: 1, p_item: { id: "new-1", title: "Newer B" } });
    expect(await screen.findByText(T("editor.saved", { revision: 2 }))).toBeInTheDocument();
    expect(screen.queryByText(T("editor.unsaved"))).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(title()).toHaveValue("Newer B");
    expect(server.stored.get("new-1")).toMatchObject({ title: "Newer B", revision: 2 });
  });

  // The Sol ruling's regression (G7-8435S13-SOL-RULING.md): a settings edit
  // made while the save runs, then a refused press of the visibly pending Save.
  it("preserves the newer settings draft when the visibly pending second Save is refused", async () => {
    let answer;
    const save = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; })).mockImplementation(policySaved);
    await openSettings(save);
    const button = screen.getByRole("button", { name: T("settings.save") });
    fireEvent.click(button);
    fireEvent.click(screen.getByLabelText(T("settings.lessons")));
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(save).toHaveBeenCalledOnce();
    await act(async () => { answer(policySaved(save.mock.calls[0][0])); });
    expect(screen.getByLabelText(T("settings.lessons"))).not.toBeChecked();
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("aria-disabled");
    expect(screen.queryByText(T("settings.saved"))).toBeNull();
    fireEvent.click(button);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1][0]).toMatchObject({ p_quotes_enabled: false, p_lessons_enabled: false, p_expected_revision: 2 });
  });

  it("keeps a settings edit made while the save ran, unsaved, and sends it next (press then edit)", async () => {
    let answer;
    const save = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; })).mockImplementation(policySaved);
    await openSettings(save);
    const button = screen.getByRole("button", { name: T("settings.save") });
    fireEvent.click(button);
    expect(save).toHaveBeenCalledOnce();
    const edit = () => fireEvent.click(screen.getByLabelText(T("settings.lessons")));
    fireEvent.click(button); edit();
    expect(save).toHaveBeenCalledOnce();
    await act(async () => { answer(policySaved(save.mock.calls[0][0])); });
    expect(screen.getByLabelText(T("settings.lessons"))).not.toBeChecked();
    expect(screen.queryByText(T("settings.saved"))).toBeNull();
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("aria-disabled");
    fireEvent.click(button);
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    expect(save.mock.calls[1][0]).toMatchObject({ p_quotes_enabled: false, p_lessons_enabled: false, p_expected_revision: 2 });
  });

  it("leaves the settings clean, with Save off, after a choice is checked and then unchecked again", async () => {
    const client = createClient({
      get_learning_policy: policy({ canManage: true }),
      get_learning_workspace: workspaceFor("chapter", { policy: { scope_key: `chapter:${CHAPTER}`, scope: "chapter", quotes_enabled: true, lessons_enabled: true, selected_ids: ["kept"], revision: 1 } }),
      list_learning_choices: page([row({ id: "kept", title: "Kept quote" }), row({ id: "extra", title: "Extra quote" })]),
      save_learning_policy: vi.fn(policySaved),
    });
    render(area(client));
    const extra = await screen.findByLabelText(/Extra quote/);
    const save = screen.getByRole("button", { name: T("settings.save") });
    expect(save).toBeDisabled();
    fireEvent.click(extra);
    expect(save).toBeEnabled();
    expect(save).not.toHaveAttribute("aria-disabled");
    fireEvent.click(extra);
    expect(extra).not.toBeChecked();
    expect(save).toBeDisabled();
    expect(screen.queryByText(T("editor.unsaved"))).toBeNull();
  });

  it("saves the settings once from one tick, and again from an immediate press after a save that throws at once", async () => {
    const save = vi.fn(policySaved);
    await openSettings(save);
    const button = screen.getByRole("button", { name: T("settings.save") });
    await expectOneWriteFromOneTick(save, [() => fireEvent.click(button), () => fireEvent.click(button)]);
    await screen.findByText(T("settings.saved"));
    fireEvent.click(screen.getByLabelText(T("settings.lessons")));
    await expectReadyRetryAfterThrowAtOnce(save, screen.getByRole("button", { name: T("settings.save") }));
  });
});
