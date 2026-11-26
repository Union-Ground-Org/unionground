// SEC-UG-FMLA-FORM-ANSWERS-ENCRYPTION-PARITY-20261022 (#5747): the web
// client saves FMLA drafts through /api/sensitive-content, opens sealed answers
// through it, keeps them out of the search index, and never edits a sealed
// form whose answers could not be opened.
import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FormsView } from "../src/views/FormsView.jsx";
import { createMemberSessionLoader } from "../src/lib/memberSessionLoader.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { hydrateSealedFormAnswers, saveFormDraft, SEALED_FORM_TEMPLATE_KEYS } from "../src/lib/memberApi.js";
import { SEALED_FORM_TEMPLATES } from "../api/_lib/sensitiveContent.js";
import { endFormDraftSession, memberDraftSaves } from "../src/lib/formDraftSessions.js";

const session = { auth: { getSession: vi.fn(async () => ({ data: { session: { access_token: "synthetic-token", user: { id: "member-a" } } } })) } };
const marker = { sealed: true, filled: ["reason"], dataVersion: "00000000-0000-4000-8000-000000000000" };
// Each case is its own authentication session, as the shell makes it.
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); endFormDraftSession(); });

function stubApi(reply) {
  const fetcher = vi.fn(async (_url, init) => {
    const body = JSON.parse(init.body);
    const data = reply(body);
    return { ok: data !== undefined, json: async () => (data === undefined ? { error: "x" } : { data }) };
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

describe("sealed FMLA client transport", () => {
  it("lists the same templates as the API", () => {
    expect([...SEALED_FORM_TEMPLATE_KEYS].sort()).toEqual([...SEALED_FORM_TEMPLATES].sort());
  });

  it("saves an FMLA draft through the sensitive API and never through the plaintext RPC", async () => {
    const stored = { formId: "form-1", dataVersion: "11111111-1111-4111-8111-111111111111" };
    const fetcher = stubApi(() => stored);
    const client = { ...session, rpc: vi.fn() };
    // The save names its baseline version (#6233) and reports the stored one.
    expect(await saveFormDraft(client, { templateKey: "fmla_self", answers: { reason: "private" }, step: 1,
      expectedDataVersion: marker.dataVersion })).toEqual(stored);
    expect(client.rpc).not.toHaveBeenCalled();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("/api/sensitive-content");
    expect(JSON.parse(init.body)).toEqual({ operation: "save_sealed_form_draft",
      args: { templateKey: "fmla_self", answers: { reason: "private" }, step: 1, expectedDataVersion: marker.dataVersion } });
  });

  // #6363 round 2: a caller without a draft id prepares the draft first and
  // learns its id before any answers are sent.
  it("prepares an unbound FMLA draft and reports its id before sending answers", async () => {
    const order = [];
    const fetcher = stubApi(({ operation }) => {
      order.push(operation);
      return operation === "prepare_sealed_form" ? { formId: "form-7" } : { formId: "form-7", dataVersion: marker.dataVersion };
    });
    const onFormId = vi.fn((id) => order.push(`bound ${id}`));
    await saveFormDraft({ ...session, rpc: vi.fn() }, { templateKey: "fmla_self", answers: { reason: "private" }, step: 0, expectedDataVersion: null, onFormId });
    expect(order).toEqual(["prepare_sealed_form", "bound form-7", "save_sealed_form_draft"]);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ operation: "prepare_sealed_form", args: { templateKey: "fmla_self" } });
    expect(JSON.parse(fetcher.mock.calls[1][1].body).args).not.toHaveProperty("onFormId");
    // The save names the prepared draft, so the API can refuse a retarget (#6363 r3s2).
    expect(JSON.parse(fetcher.mock.calls[1][1].body).args.formId).toBe("form-7");
  });

  // #6395: a lane that already knows its form names it on every save and
  // retry and never prepares again, so the API can refuse a save whose form
  // was submitted meanwhile instead of writing into a fresh draft.
  it("names the lane's known form on every save without preparing again", async () => {
    const fetcher = stubApi(({ operation }) => (operation === "prepare_sealed_form" ? { formId: "form-other" } : { formId: "form-7", dataVersion: marker.dataVersion }));
    const onFormId = vi.fn();
    for (const extra of [{}, { onFormId }]) {
      fetcher.mockClear();
      await saveFormDraft({ ...session, rpc: vi.fn() }, { templateKey: "fmla_self", answers: { reason: "private" }, step: 0,
        expectedDataVersion: null, formId: "form-7", ...extra });
      expect(fetcher.mock.calls.map(([, init]) => JSON.parse(init.body).operation)).toEqual(["save_sealed_form_draft"]);
      expect(JSON.parse(fetcher.mock.calls[0][1].body).args).toEqual({ templateKey: "fmla_self", answers: { reason: "private" }, step: 0,
        expectedDataVersion: null, formId: "form-7" });
    }
    expect(onFormId).not.toHaveBeenCalled();
  });

  // #6363 round 3 (P0): member A's save is in flight when another tab signs A
  // out and member B in. A's answers must never be sent under B's session.
  describe("an account switch during a sealed save", () => {
    const signedIn = (id) => ({ data: { session: { access_token: `token-${id}`, user: { id } } } });
    function twoSessions() {
      let current = signedIn("member-a");
      return { switchTo: (id) => { current = signedIn(id); }, client: { rpc: vi.fn(), auth: { getSession: vi.fn(async () => current) } } };
    }
    const sent = (fetcher) => fetcher.mock.calls.map(([, init]) => ({ ...JSON.parse(init.body), auth: init.headers.Authorization }));

    it("drops A's answers when B signs in while the draft is prepared", async () => {
      const { switchTo, client } = twoSessions();
      const fetcher = stubApi(({ operation }) => {
        if (operation === "prepare_sealed_form") { switchTo("member-b"); return { formId: "form-a" }; }
        return { formId: "form-b", dataVersion: marker.dataVersion };
      });
      const onFormId = vi.fn();
      await expect(saveFormDraft(client, { templateKey: "fmla_self", answers: { reason: "A's diagnosis" }, step: 0, expectedDataVersion: null, onFormId }))
        .rejects.toMatchObject({ code: "SESSION_CHANGED" });
      expect(sent(fetcher)).toEqual([{ operation: "prepare_sealed_form", args: { templateKey: "fmla_self" }, auth: "Bearer token-member-a" }]);
      expect(JSON.stringify(sent(fetcher))).not.toContain("A's diagnosis");
      expect(onFormId).not.toHaveBeenCalled();
    });

    it("sends A's answers only under A's token and refuses the result when B signs in during the save", async () => {
      const { switchTo, client } = twoSessions();
      const fetcher = stubApi(({ operation }) => {
        if (operation === "save_sealed_form_draft") { switchTo("member-b"); return { formId: "form-a", dataVersion: marker.dataVersion }; }
        return { formId: "form-a" };
      });
      await expect(saveFormDraft(client, { templateKey: "fmla_self", answers: { reason: "A's diagnosis" }, step: 0, expectedDataVersion: null, onFormId: vi.fn() }))
        .rejects.toMatchObject({ code: "SESSION_CHANGED" });
      const requests = sent(fetcher);
      expect(requests.map((request) => request.auth)).toEqual(["Bearer token-member-a", "Bearer token-member-a"]);
      expect(requests[1].args).toMatchObject({ formId: "form-a", answers: { reason: "A's diagnosis" } });
      // Nothing more goes out after the switch, and nothing under B's token.
      expect(JSON.stringify(requests)).not.toContain("token-member-b");
    });

    it("sends nothing without a signed-in member", async () => {
      const fetcher = stubApi(() => ({ formId: "form-a" }));
      const client = { rpc: vi.fn(), auth: { getSession: vi.fn(async () => ({ data: { session: null } })) } };
      await expect(saveFormDraft(client, { templateKey: "fmla_self", answers: { reason: "x" }, step: 0, expectedDataVersion: null }))
        .rejects.toMatchObject({ code: "SESSION_CHANGED" });
      expect(fetcher).not.toHaveBeenCalled();
    });
  });

  it("keeps other templates on save_form_draft", async () => {
    const fetcher = stubApi(() => "unused");
    const client = { ...session, rpc: vi.fn(async () => ({ data: "form-2", error: null })) };
    expect(await saveFormDraft(client, { templateKey: "grievance", answers: { summary: "x" }, step: 0 })).toBe("form-2");
    expect(client.rpc).toHaveBeenCalledWith("save_form_draft", { p_template_key: "grievance", p_answers: { summary: "x" }, p_step: 0 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("opens sealed rows in pages of 100 and marks unopened ones unavailable, never empty and editable", async () => {
    const rows = Array.from({ length: 101 }, (_, index) => ({ id: `form-${index}`, template_key: "fmla_self", answers: marker }));
    rows.push({ id: "plain", answers: { summary: "grievance text" } });
    const fetcher = stubApi(({ args }) => args.formIds.filter((id) => id !== "form-3")
      .map((id) => (id === "form-4" ? { id, answers: {}, contentError: "sensitive-content-unavailable" }
        : { id, answers: { reason: `opened ${id}` }, dataVersion: marker.dataVersion })));
    const shape = await hydrateSealedFormAnswers(session, rows);
    expect(fetcher.mock.calls.map(([, init]) => JSON.parse(init.body).args.formIds.length)).toEqual([100, 1]);
    expect(shape(rows[0])).toEqual({ answers: { reason: "opened form-0" }, sealed: true, dataVersion: marker.dataVersion });
    expect(shape(rows[3])).toEqual({ answers: {}, sealed: true, answersUnavailable: true });
    expect(shape(rows[4])).toEqual({ answers: {}, sealed: true, answersUnavailable: true });
    expect(shape(rows.at(-1))).toEqual({ answers: { summary: "grievance text" } });
  });

  it("marks every sealed row unavailable when the API refuses", async () => {
    stubApi(() => undefined);
    const row = { id: "form-1", template_key: "fmla_family", answers: marker };
    const shape = await hydrateSealedFormAnswers(session, [row]);
    expect(shape(row)).toEqual({ answers: {}, sealed: true, answersUnavailable: true });
  });

  it("shows an FMLA row still holding plaintext before the backfill as unavailable, never its answers", async () => {
    const fetcher = stubApi(() => []);
    const legacy = { id: "legacy", template_key: "fmla_self", answers: { reason: "legacy plaintext" } };
    const seed = { id: "seed", template_key: "fmla_family", answers: { seedSequence: 2 } };
    const shape = await hydrateSealedFormAnswers(session, [legacy, seed]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(shape(legacy)).toEqual({ answers: {}, sealed: true, answersUnavailable: true });
    expect(shape(seed)).toEqual({ answers: { seedSequence: 2 } });
  });

  // #5827 final (Sol 6.1) P1: the session loader hands loadMemberApp a scoped
  // client; the sealed transport needs the member's own session token from it,
  // or every sealed form is marked unavailable without a decryption request.
  it("opens a sealed draft through the member session loader's forms route", async () => {
    const user = { id: "member-1", email: "member@example.test" };
    const rows = {
      "table:member_profiles": { id: user.id, first_name: "Mira", full_name: "Mira Vale", initials: "MV", role_line: "Worker", member_since: 2023, language: "en", chapter_id: "chapter-1" },
      "table:member_forms": [{ id: "sealed-1", user_id: user.id, template_key: "fmla_self", template_version: 1, status: "draft", step: 0, answers: marker }],
      "rpc:get_member_rewards_summary": {},
    };
    const execute = (resource) => Promise.resolve({ data: structuredClone(Object.hasOwn(rows, resource) ? rows[resource] : resource.startsWith("rpc:") ? null : []), error: null });
    const chain = (resource) => {
      let proxy;
      proxy = new Proxy(function query() {}, { get(_target, property) {
        if (property === "then") { const promise = execute(resource); return promise.then.bind(promise); }
        return () => proxy;
      } });
      return proxy;
    };
    const getSession = vi.fn(async () => ({ data: { session: { access_token: "loader-token" } } }));
    const client = { from: (table) => chain(`table:${table}`), rpc: (name) => execute(`rpc:${name}`), auth: { getSession } };
    const fetcher = stubApi((body) => (body.operation === "get_sealed_forms" && body.args.formIds.includes("sealed-1")
      ? [{ id: "sealed-1", answers: { reason: "Opened through the loader" } }] : undefined));
    const projection = await createMemberSessionLoader(client, user).loadRoute("forms");
    const form = projection.forms.find((row) => row.id === "sealed-1");
    expect(form).toMatchObject({ sealed: true, answers: { reason: "Opened through the loader" } });
    expect(form.answersUnavailable).toBeFalsy();
    expect(getSession).toHaveBeenCalled();
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe("Bearer loader-token");
  });

  // #6329 (#6289 round 2 P2): answers.sealed is encryption metadata only on a
  // sealed template; an ordinary checkbox named "sealed" is a plain answer.
  it("hydrates an ordinary template whose answers include a field named sealed as plain answers", async () => {
    const fetcher = stubApi(() => []);
    const grievance = { id: "grievance-1", template_key: "grievance", answers: { sealed: true, summary: "Plain grievance text" } };
    const shape = await hydrateSealedFormAnswers(session, [grievance]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(shape(grievance)).toEqual({ answers: { sealed: true, summary: "Plain grievance text" } });
  });

  it("makes no API call when no row is sealed", async () => {
    const fetcher = stubApi(() => []);
    const shape = await hydrateSealedFormAnswers(session, [{ id: "plain", answers: {} }]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(shape({ id: "plain", answers: {} })).toEqual({ answers: {} });
  });
});

describe("sealed FMLA editor guard", () => {
  function renderDraft(onSaveDraft, answers = { reason: "Original reason", condition_type: "continuous" }) {
    return render(
      <LanguageProvider lang="en">
        <FormsView data={{ member: { id: "fmla-member", initials: "MV" }, forms: [{ id: "open-fmla", templateKey: "fmla_self", status: "draft",
          step: 0, sealed: true, cosigners: [], answers }] }}
          focus={{ templateKey: "fmla_self", formId: "open-fmla" }} onSaveDraft={onSaveDraft} onSubmit={vi.fn()} />
      </LanguageProvider>,
    );
  }

  it("serializes overlapping FMLA autosaves and flushes the latest edit on Close after Next clears the timer", async () => {
    vi.useFakeTimers();
    let releaseCommit;
    const commitBarrier = new Promise((resolve) => { releaseCommit = resolve; });
    let version = 0;
    let storedAnswers;
    const preparedVersions = [];
    const conflicts = [];
    // Model the API's prepare/commit boundary: concurrent preparations see
    // V0, but only one may commit it. Exercise the real client transport too.
    const fetcher = vi.fn(async (_url, init) => {
      const { args } = JSON.parse(init.body);
      const prepared = version;
      preparedVersions.push(prepared);
      await commitBarrier;
      if (prepared !== version) {
        conflicts.push(args.answers);
        return { ok: false, status: 409, json: async () => ({ error: "sealed-form-version-conflict" }) };
      }
      version += 1;
      storedAnswers = args.answers;
      return { ok: true, json: async () => ({ data: "open-fmla" }) };
    });
    vi.stubGlobal("fetch", fetcher);
    renderDraft((draft) => saveFormDraft(session, draft));
    fireEvent.change(screen.getByDisplayValue("Original reason"), { target: { value: "Autosave A" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    fireEvent.change(screen.getByDisplayValue("Autosave A"), { target: { value: "Latest edit B" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: /Close form/ }));
    await act(async () => { releaseCommit(); });
    await waitFor(() => expect(screen.queryByRole("button", { name: /Close form/ })).toBeNull());
    expect(storedAnswers.reason).toBe("Latest edit B");
    expect(preparedVersions).toEqual([0, 1]);
    expect(conflicts).toEqual([]);
  });

  it("clears a drained edit's debounce timer so it never re-saves the old answers", async () => {
    vi.useFakeTimers();
    const resolvers = [];
    const saved = [];
    const onSaveDraft = vi.fn((draft) => new Promise((resolve) => { resolvers.push(() => { saved.push(draft.answers.reason); resolve("open-fmla"); }); }));
    renderDraft(onSaveDraft);
    fireEvent.change(screen.getByDisplayValue("Original reason"), { target: { value: "Autosave A" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    expect(onSaveDraft).toHaveBeenCalledTimes(1);
    // B arrives while A is still in flight: queued, with its own timer.
    fireEvent.change(screen.getByDisplayValue("Autosave A"), { target: { value: "Edit B" } });
    await act(async () => { resolvers.shift()(); });
    await act(async () => { resolvers.shift()(); });
    expect(saved).toEqual(["Autosave A", "Edit B"]);
    // The loop committed B before B's timer fired; the timer must not save again.
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(onSaveDraft).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it.each(["success", "lost response"])("orders an unmounted editor's queued save before a reopened edit after A's %s", async (outcome) => {
    vi.useFakeTimers();
    let release;
    const response = new Promise((resolve) => { release = resolve; });
    const writes = [];
    const send = vi.fn(async (draft) => {
      // A has committed, but its reply remains in flight while the member
      // leaves, reopens this form and queues C through a new callback.
      writes.push(draft.answers.reason);
      if (draft.answers.reason === "A") {
        await response;
        if (outcome === "lost response") throw new Error("reply unavailable");
      }
      return "open-fmla";
    });
    const view = renderDraft((draft) => send(draft));
    fireEvent.change(screen.getByDisplayValue("Original reason"), { target: { value: "A" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    fireEvent.change(screen.getByDisplayValue("A"), { target: { value: "B" } });
    fireEvent.click(screen.getByRole("radio", { name: /intermittent/i }));
    view.unmount();
    vi.useRealTimers();
    renderDraft((draft) => send(draft));
    expect(screen.getByRole("radio", { name: /intermittent/i })).toHaveAttribute("aria-checked", "true");
    fireEvent.change(screen.getByDisplayValue("B"), { target: { value: "C" } });
    fireEvent.click(screen.getByRole("button", { name: /Close form/ }));
    await act(async () => { release(); });
    await waitFor(() => expect(screen.queryByRole("button", { name: /Close form/ })).toBeNull());
    expect(writes).toEqual(["A", "B", "C"]);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.at(-1)[0].answers.condition_type).toBe("intermittent");
  });

  it("does not replay a failed older pane's version after a second pane commits and closes", async () => {
    const writes = [];
    const send = vi.fn(async (draft) => {
      writes.push(draft.answers.start_date ? "C" : "B");
      if (writes.length === 1) throw new Error("temporarily unavailable");
      return "open-fmla";
    });
    const first = renderDraft((draft) => send(draft));
    fireEvent.change(within(first.container).getByDisplayValue("Original reason"), { target: { value: "B" } });
    fireEvent.click(within(first.container).getByRole("button", { name: "Next" }));
    await waitFor(() => expect(within(first.container).getByRole("alert")).toHaveTextContent(/could not be saved/));
    const second = renderDraft((draft) => send(draft));
    fireEvent.change(within(second.container).getByLabelText(/start date/i), { target: { value: "2026-11-11" } });
    fireEvent.click(within(second.container).getByRole("button", { name: /Close form/ }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Close form/ })).toBeNull());
    // Closing the shared editor also unmounts the failed pane. Its older B
    // version must not be admitted behind C, even though it is retryable.
    expect(writes).toEqual(["B", "C"]);
  });

  // #5827 final (Sol 6.1) P2: StrictMode replays the unmount cleanup once on
  // mount; the debounce guard must be reset by the effect setup or no
  // autosave ever fires in development.
  it("still autosaves after a debounce under StrictMode's effect replay", async () => {
    vi.useFakeTimers();
    const onSaveDraft = vi.fn(async () => "open-fmla");
    render(
      <StrictMode>
        <LanguageProvider lang="en">
          <FormsView data={{ member: { initials: "MV" }, forms: [{ id: "open-fmla", templateKey: "fmla_self", status: "draft",
            step: 0, sealed: true, cosigners: [], answers: { reason: "Original reason", condition_type: "continuous" } }] }}
            focus={{ templateKey: "fmla_self", formId: "open-fmla" }} onSaveDraft={onSaveDraft} onSubmit={vi.fn()} />
        </LanguageProvider>
      </StrictMode>,
    );
    fireEvent.change(screen.getByDisplayValue("Original reason"), { target: { value: "Autosave A" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    expect(onSaveDraft).toHaveBeenCalledTimes(1);
    expect(onSaveDraft.mock.calls[0][0].answers.reason).toBe("Autosave A");
    vi.useRealTimers();
  });

  it("cancels a leftover debounce timer on unmount after the queue drained", async () => {
    vi.useFakeTimers();
    const resolvers = [];
    const onSaveDraft = vi.fn(() => new Promise((resolve) => { resolvers.push(() => resolve("open-fmla")); }));
    const view = renderDraft(onSaveDraft);
    fireEvent.change(screen.getByDisplayValue("Original reason"), { target: { value: "Autosave A" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    fireEvent.change(screen.getByDisplayValue("Autosave A"), { target: { value: "Edit B" } });
    await act(async () => { resolvers.shift()(); });
    await act(async () => { resolvers.shift()(); });
    expect(onSaveDraft).toHaveBeenCalledTimes(2);
    // Leave the editor with nothing pending; a surviving timer would later write B again.
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(onSaveDraft).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("retains a rejected FMLA edit after Next and retries it on Close without a debounce timer", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 409, json: async () => ({ error: "sealed-form-version-conflict" }) })
      .mockResolvedValue({ ok: true, json: async () => ({ data: "open-fmla" }) });
    vi.stubGlobal("fetch", fetcher);
    renderDraft((draft) => saveFormDraft(session, draft));
    fireEvent.change(screen.getByDisplayValue("Original reason"), { target: { value: "Retained edit" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/could not be saved/));
    fireEvent.click(screen.getByRole("button", { name: /Close form/ }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Close form/ })).toBeNull());
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetcher.mock.calls[1][1].body).args.answers.reason).toBe("Retained edit");
  });

  // #5827 round 7 (Sol 6.1) r7s2: a remounted editor shows answers transferred
  // from the shared queue; when their save fails with 503, Close must retry
  // them rather than close over the persisted older answers.
  it("keeps transferred answers after a 503 and retries them when the reopened editor closes", async () => {
    vi.useFakeTimers();
    let releaseA;
    const replyA = new Promise((resolve) => { releaseA = resolve; });
    const sent = [];
    const fetcher = vi.fn(async (_url, init) => {
      const reason = JSON.parse(init.body).args.answers.reason;
      sent.push(reason);
      if (sent.length === 1) { await replyA; return { ok: true, json: async () => ({ data: "open-fmla" }) }; }
      if (sent.length <= 3) return { ok: false, status: 503, json: async () => ({ error: "temporarily unavailable" }) };
      return { ok: true, json: async () => ({ data: "open-fmla" }) };
    });
    vi.stubGlobal("fetch", fetcher);
    const first = renderDraft((draft) => saveFormDraft(session, draft));
    fireEvent.change(screen.getByDisplayValue("Original reason"), { target: { value: "Autosave A" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    fireEvent.change(screen.getByDisplayValue("Autosave A"), { target: { value: "Transferred B" } });
    first.unmount(); // navigate away while A's reply is delayed; B moves to the shared queue
    vi.useRealTimers();
    renderDraft((draft) => saveFormDraft(session, draft));
    expect(screen.getByDisplayValue("Transferred B")).toBeVisible();
    await act(async () => { releaseA(); });
    await waitFor(() => expect(sent).toEqual(["Autosave A", "Transferred B"]));
    // B was rejected; Close retries it, fails again and keeps the answers on the page.
    fireEvent.click(screen.getByRole("button", { name: /Close form/ }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/could not be saved/));
    expect(screen.getByDisplayValue("Transferred B")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Close form/ }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Close form/ })).toBeNull());
    expect(sent).toEqual(["Autosave A", "Transferred B", "Transferred B", "Transferred B"]);
  });

  // BUG-UG-FORM-DRAFT-SNAPSHOT-SESSION-SCOPE-20261027 (#6205, #5827
  // round 8 r8s1): a rejected snapshot belongs to one authentication session
  // and never overrides answers the server got from elsewhere.
  function rejectingTransport(rejections) {
    const sent = [];
    const fetcher = vi.fn(async (_url, init) => {
      sent.push(JSON.parse(init.body).args.answers.reason);
      if (sent.length <= rejections) return { ok: false, status: 503, json: async () => ({ error: "temporarily unavailable" }) };
      return { ok: true, json: async () => ({ data: "open-fmla" }) };
    });
    vi.stubGlobal("fetch", fetcher);
    return sent;
  }
  async function rejectThenLeave(sent) {
    const view = renderDraft((draft) => saveFormDraft(session, draft));
    fireEvent.change(screen.getByDisplayValue("Original reason"), { target: { value: "Rejected B" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/could not be saved/));
    view.unmount(); // navigate away: the unmount retry is rejected too
    await waitFor(() => expect(sent).toEqual(["Rejected B", "Rejected B"]));
  }

  it("shows newer server answers after sign-out and same-member sign-in, and Next never replays the stale snapshot", async () => {
    const sent = rejectingTransport(2);
    await rejectThenLeave(sent);
    endFormDraftSession(); // sign-out; the shell ends the session on every identity change
    expect(memberDraftSaves.size).toBe(0);
    // C was saved from another device; the same member signs in again in this tab.
    renderDraft((draft) => saveFormDraft(session, draft), { reason: "Saved elsewhere C", condition_type: "continuous" });
    expect(screen.getByDisplayValue("Saved elsewhere C")).toBeVisible();
    expect(screen.queryByDisplayValue("Rejected B")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(sent).toHaveLength(3));
    expect(sent[2]).toBe("Saved elsewhere C");
  });

  it("lets answers saved elsewhere win over a rejected snapshot within one session", async () => {
    const sent = rejectingTransport(2);
    await rejectThenLeave(sent);
    renderDraft((draft) => saveFormDraft(session, draft), { reason: "Saved elsewhere C", condition_type: "continuous" });
    expect(screen.getByDisplayValue("Saved elsewhere C")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(sent).toHaveLength(3));
    expect(sent[2]).toBe("Saved elsewhere C");
  });

  it("still resumes and retries a rejected snapshot across a remount within one session", async () => {
    const sent = rejectingTransport(2);
    await rejectThenLeave(sent);
    renderDraft((draft) => saveFormDraft(session, draft));
    // The snapshot resumes on the step Next reached; its answers are one step back.
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByDisplayValue("Rejected B")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Close form/ }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Close form/ })).toBeNull());
    expect(sent.at(-1)).toBe("Rejected B");
    expect(sent).not.toContain("Original reason");
  });

  // #5827 round 9 (Sol 6.1) r9s1: the fresh-load reconciliation also covers a
  // snapshot whose retry is still pending, and a failed retry never replays it.
  it("keeps newer server answers when a reopened editor loads them while the rejected snapshot's retry is pending", async () => {
    let failRetry;
    const retryReply = new Promise((resolve) => { failRetry = resolve; });
    const sent = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      sent.push(JSON.parse(init.body).args.answers.reason);
      if (sent.length === 2) await retryReply; // the unmount retry's failure arrives late
      if (sent.length <= 2) return { ok: false, status: 503, json: async () => ({ error: "temporarily unavailable" }) };
      return { ok: true, json: async () => ({ data: "open-fmla" }) };
    }));
    const view = renderDraft((draft) => saveFormDraft(session, draft));
    fireEvent.change(screen.getByDisplayValue("Original reason"), { target: { value: "Rejected B" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/could not be saved/));
    view.unmount();
    await waitFor(() => expect(sent).toEqual(["Rejected B", "Rejected B"]));
    // Another device saved C; reopening this tab loads it while B's retry is pending.
    renderDraft((draft) => saveFormDraft(session, draft), { reason: "Saved elsewhere C", condition_type: "continuous" });
    expect(screen.getByDisplayValue("Saved elsewhere C")).toBeVisible();
    await act(async () => { failRetry(); });
    fireEvent.click(screen.getByRole("button", { name: /Close form/ }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Close form/ })).toBeNull());
    expect(sent).toEqual(["Rejected B", "Rejected B"]);
  });

  it("withdraws a snapshot still queued behind a pending save once a reopened editor loads newer server answers", async () => {
    vi.useFakeTimers();
    let releaseA;
    const replyA = new Promise((resolve) => { releaseA = resolve; });
    const sent = [];
    const send = vi.fn(async (draft) => {
      sent.push(draft.answers.reason);
      if (draft.answers.reason === "Autosave A") await replyA;
      return "open-fmla";
    });
    const view = renderDraft((draft) => send(draft));
    fireEvent.change(screen.getByDisplayValue("Original reason"), { target: { value: "Autosave A" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    fireEvent.change(screen.getByDisplayValue("Autosave A"), { target: { value: "Queued B" } });
    view.unmount(); // B moves to the shared lane behind A
    vi.useRealTimers();
    renderDraft((draft) => send(draft), { reason: "Saved elsewhere C", condition_type: "continuous" });
    expect(screen.getByDisplayValue("Saved elsewhere C")).toBeVisible();
    await act(async () => { releaseA(); });
    fireEvent.click(screen.getByRole("button", { name: /Close form/ }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Close form/ })).toBeNull());
    expect(sent).toEqual(["Autosave A"]);
  });

  // SEC-UG-FORM-DRAFT-BASELINE-LIFECYCLE-AND-HYDRATION-VERSION-20261027
  // (#6281, #5827 round 11): the lane's baseline follows the server's
  // answers/version pair across submissions, lost save responses and
  // hydration. The fake below keeps the locked compare's contract: one open
  // draft per template, a save naming any other version is refused with 409,
  // and only changed answers get a new version.
  function sealedServer(open = null) {
    const forms = open ? [{ status: "draft", ...open }] : [];
    let versions = 0;
    const sent = [];
    const server = {
      forms, sent, loseNextReply: false,
      current: () => forms.find((form) => form.status === "draft"),
      writeElsewhere(answers) { const form = server.current(); form.answers = answers; form.dataVersion = `v${++versions}`; },
      afterPrepare: null, named: [],
      async save(draft) {
        const prepare = () => {
          let form = server.current();
          if (!form) { form = { id: `form-${forms.length + 1}`, status: "draft", answers: {}, dataVersion: null }; forms.push(form); }
          return form;
        };
        // prepare_sealed_form: an unbound lane learns the draft's id before its answers are sent.
        let named = draft.formId;
        if (!named && draft.onFormId) { named = prepare().id; draft.onFormId(named); await server.afterPrepare?.(named); }
        // save_sealed_form_draft prepares again and refuses a save naming any other draft (#6363 r3s2).
        const form = prepare();
        sent.push({ reason: draft.answers.reason, expected: draft.expectedDataVersion });
        server.named.push(named ?? null);
        if (named && named !== form.id) throw Object.assign(new Error("sensitive-data-conflict"), { status: 409 });
        if (draft.expectedDataVersion !== form.dataVersion) throw Object.assign(new Error("sensitive-data-conflict"), { status: 409 });
        if (JSON.stringify(draft.answers) !== JSON.stringify(form.answers)) { form.answers = draft.answers; form.dataVersion = `v${++versions}`; }
        if (server.loseNextReply) { server.loseNextReply = false; throw new Error("network response lost"); }
        return { formId: form.id, dataVersion: form.dataVersion };
      },
      async submit(id) { forms.find((form) => form.id === id).status = "submitted"; return { awardedPoints: 15 }; },
    };
    return server;
  }
  const reasonTemplate = { key: "fmla_self", icon: "F", titleKey: "Leave test", blurbKey: "Leave test", version: 1,
    steps: [{ titleKey: "Reason", fields: [{ key: "reason", type: "text", labelKey: "Reason", required: true, maxLength: 200 }] }] };
  function renderSealed(server, form = null, template = reasonTemplate) {
    return render(
      <LanguageProvider lang="en">
        <FormsView data={{ member: { id: "fmla-member", initials: "MV" }, forms: form ? [{ templateKey: "fmla_self", templateVersion: 1,
          status: "draft", step: 0, sealed: true, cosigners: [], ...form }] : [], formTemplates: [template], formTemplateVersions: [template] }}
          focus={{ templateKey: "fmla_self", formId: form?.id }} onSaveDraft={(draft) => server.save(draft)}
          onSubmit={(id) => server.submit(id)} onSignForm={vi.fn(async () => ({ signedAt: "now" }))} />
      </LanguageProvider>,
    );
  }
  function signForm() {
    const canvas = screen.getByLabelText("Draw your signature");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({ left: 0, top: 0, width: 100, height: 50, right: 100, bottom: 50, x: 0, y: 0, toJSON: () => ({}) });
    fireEvent.pointerDown(canvas, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 90, clientY: 40, pointerId: 1 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });
    fireEvent.click(screen.getByRole("checkbox", { name: /intend this drawing/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save signature" }));
  }

  it("starts the next form of a template from a null baseline after the previous one is submitted", async () => {
    const server = sealedServer();
    const first = renderSealed(server);
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "First leave" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(server.forms[0]?.dataVersion).toBe("v1"));
    signForm();
    const submit = await screen.findByRole("button", { name: "Submit for committee review" });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);
    await waitFor(() => expect(server.forms[0].status).toBe("submitted"));
    first.unmount();
    // Same authentication session: start another fmla_self form.
    renderSealed(server);
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "Second leave" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(server.forms[1]?.dataVersion).toBe("v2"));
    expect(server.sent.at(-1)).toEqual({ reason: "Second leave", expected: null });
    expect(server.forms[1].answers).toEqual({ reason: "Second leave" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("adopts the committed version of a save whose response was lost once a fresh load shows those answers", async () => {
    const server = sealedServer({ id: "open-fmla", answers: { reason: "Original A" }, dataVersion: "v0" });
    server.loseNextReply = true; // B commits as v1, but its reply never arrives
    const first = renderSealed(server, server.current());
    fireEvent.change(screen.getByDisplayValue("Original A"), { target: { value: "Saved B" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/could not be saved/));
    first.unmount(); // the unmount retry still names v0 and is refused
    await waitFor(() => expect(server.sent).toHaveLength(2));
    expect(server.sent).toEqual([{ reason: "Saved B", expected: "v0" }, { reason: "Saved B", expected: "v0" }]);
    expect(server.current()).toMatchObject({ answers: { reason: "Saved B" }, dataVersion: "v1" });
    // Reopen with the freshly loaded B/v1: Close now saves against v1.
    const second = renderSealed(server, { ...server.current() });
    fireEvent.click(screen.getByRole("button", { name: /Close form/ }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Close form/ })).toBeNull());
    expect(server.sent.at(-1)).toEqual({ reason: "Saved B", expected: "v1" });
    second.unmount();
    // A genuinely stale write is still refused: another device saves C, and
    // an edit built on B/v1 names v1, not the server's newer version.
    renderSealed(server, { ...server.current() });
    server.writeElsewhere({ reason: "Saved elsewhere C" });
    fireEvent.change(screen.getByDisplayValue("Saved B"), { target: { value: "Stale D" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/could not be saved/));
    expect(server.sent.at(-1)).toEqual({ reason: "Stale D", expected: "v1" });
    expect(server.current()).toMatchObject({ answers: { reason: "Saved elsewhere C" }, dataVersion: "v2" });
  });

  it("keeps its confirmed baseline when a fresh load only lags this session's own save", async () => {
    const server = sealedServer({ id: "open-fmla", answers: { reason: "Original A" }, dataVersion: "v0" });
    const first = renderSealed(server, server.current());
    fireEvent.change(screen.getByDisplayValue("Original A"), { target: { value: "Saved B" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(server.current().dataVersion).toBe("v1"));
    first.unmount();
    // A lagging list still shows A/v0; the next save names v1, the version this session confirmed.
    renderSealed(server, { id: "open-fmla", answers: { reason: "Original A" }, dataVersion: "v0" });
    fireEvent.change(screen.getByDisplayValue("Saved B"), { target: { value: "Edited C" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(server.current().answers).toEqual({ reason: "Edited C" }));
    expect(server.sent.at(-1)).toEqual({ reason: "Edited C", expected: "v1" });
  });

  it("withdraws rejected B when another device restores historical A at a new version (r1s1)", async () => {
    const server = sealedServer({ id: "open-fmla", answers: { reason: "Original A" }, dataVersion: "v0" });
    const first = renderSealed(server, { ...server.current() });
    server.writeElsewhere({ reason: "Elsewhere C" });
    fireEvent.change(screen.getByDisplayValue("Original A"), { target: { value: "Rejected B" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/could not be saved/));
    first.unmount();
    await waitFor(() => expect(server.sent).toHaveLength(2));
    server.writeElsewhere({ reason: "Original A" });
    renderSealed(server, { ...server.current() });
    expect(screen.getByDisplayValue("Original A")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Close form/ }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Close form/ })).toBeNull());
    expect(server.current()).toMatchObject({ answers: { reason: "Original A" }, dataVersion: "v2" });
    expect(server.sent).toHaveLength(2); // an untouched reopen never replays rejected B
  });

  it("initializes from the confirmed answers/version pair when a projection lags (r1s2)", async () => {
    const server = sealedServer({ id: "open-fmla", answers: { reason: "Original A", start_date: "2026-11-01" }, dataVersion: "v0" });
    const stale = structuredClone(server.current());
    const template = { ...reasonTemplate, steps: [{ ...reasonTemplate.steps[0], fields: [
      ...reasonTemplate.steps[0].fields, { key: "start_date", type: "date", labelKey: "Start date" },
    ] }] };
    const first = renderSealed(server, stale, template);
    fireEvent.change(screen.getByLabelText("Start date"), { target: { value: "2026-11-15" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(server.current().dataVersion).toBe("v1"));
    first.unmount();
    renderSealed(server, stale, template);
    expect(screen.getByLabelText("Start date")).toHaveValue("2026-11-15");
    fireEvent.change(screen.getByDisplayValue("Original A"), { target: { value: "Edited C" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(server.current().answers.reason).toBe("Edited C"));
    expect(server.current().answers.start_date).toBe("2026-11-15");
    expect(server.sent.at(-1).expected).toBe("v1");
  });

  it("fences an old acknowledgement after a newer load reconciles the lane (r1s3)", async () => {
    const server = sealedServer({ id: "open-fmla", answers: { reason: "Original A" }, dataVersion: "v0" });
    let release;
    const reply = new Promise((resolve) => { release = resolve; });
    const originalSave = server.save;
    server.save = async (draft) => {
      const result = await originalSave(draft);
      if (draft.answers.reason === "Saved B") await reply;
      return result;
    };
    const first = renderSealed(server, { ...server.current() });
    fireEvent.change(screen.getByDisplayValue("Original A"), { target: { value: "Saved B" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(server.current().dataVersion).toBe("v1"));
    first.unmount();
    server.writeElsewhere({ reason: "Elsewhere C" });
    renderSealed(server, { ...server.current() });
    expect(screen.getByDisplayValue("Elsewhere C")).toBeVisible();
    await act(async () => { release(); });
    fireEvent.change(screen.getByDisplayValue("Elsewhere C"), { target: { value: "Edited D" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(server.current().answers.reason).toBe("Edited D"));
    expect(server.sent.at(-1)).toEqual({ reason: "Edited D", expected: "v2" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("hydrates sealed answers with the version read alongside them and saves against it", async () => {
    const server = sealedServer({ id: "open-fmla", answers: { reason: "Original A" }, dataVersion: "v0" });
    const listed = { id: "open-fmla", template_key: "fmla_self", answers: { ...marker, dataVersion: "v0" } };
    server.writeElsewhere({ reason: "Saved elsewhere B" }); // another device commits v1 after the list query
    stubApi(({ operation, args }) => (operation === "get_sealed_forms"
      ? args.formIds.map((id) => ({ id, answers: server.current().answers, dataVersion: server.current().dataVersion })) : undefined));
    const shape = await hydrateSealedFormAnswers(session, [listed]);
    expect(shape(listed)).toEqual({ answers: { reason: "Saved elsewhere B" }, sealed: true, dataVersion: "v1" });
    renderSealed(server, { id: "open-fmla", ...shape(listed) });
    fireEvent.change(screen.getByDisplayValue("Saved elsewhere B"), { target: { value: "Edited C" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(server.current().answers).toEqual({ reason: "Edited C" }));
    expect(server.sent).toEqual([{ reason: "Edited C", expected: "v1" }]);
  });

  // SEC-UG-FORM-DRAFT-LANE-RETIRE-ELSEWHERE-AND-LEGACY-SEALED-SAVE-20261028
  // (#6329, #6289 round 2 P1): the lane belongs to one form, and a projection
  // showing that form submitted elsewhere starts it again.
  function renderProjection(server, focus) {
    const forms = server.forms.map((form) => ({ templateKey: "fmla_self", templateVersion: 1, step: 0, sealed: true, cosigners: [], ...form }));
    return render(
      <LanguageProvider lang="en">
        <FormsView data={{ member: { id: "fmla-member", initials: "MV" }, forms, formTemplates: [reasonTemplate], formTemplateVersions: [reasonTemplate] }}
          focus={focus} onSaveDraft={(draft) => server.save(draft)} onSubmit={(id) => server.submit(id)} />
      </LanguageProvider>,
    );
  }

  it("starts a new form from a null baseline after the previous one was submitted on another device", async () => {
    const server = sealedServer();
    const first = renderSealed(server);
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "First leave" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(server.forms[0]?.dataVersion).toBe("v1"));
    fireEvent.click(screen.getByRole("button", { name: /Close form/ }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Close form/ })).toBeNull());
    first.unmount();
    server.forms[0].status = "submitted"; // another device submits form-1
    // This tab refreshes its list and starts another fmla_self.
    const second = renderProjection(server, { templateKey: "fmla_self" });
    expect(screen.getByLabelText(/Reason/)).toHaveValue("");
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "Second leave" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(server.forms[1]?.dataVersion).toBe("v2"));
    expect(server.sent.at(-1)).toEqual({ reason: "Second leave", expected: null });
    expect(screen.queryByRole("alert")).toBeNull();
    second.unmount();
    // Reopening that new draft saves against its own version.
    renderProjection(server, { templateKey: "fmla_self", formId: "form-2" });
    fireEvent.change(screen.getByDisplayValue("Second leave"), { target: { value: "Second edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(server.forms[1].dataVersion).toBe("v3"));
    expect(server.sent.at(-1)).toEqual({ reason: "Second edited", expected: "v2" });
    expect(server.forms[0]).toMatchObject({ status: "submitted", answers: { reason: "First leave" } });
  });

  // #6363 round 1: a lost first-save reply leaves the lane without a form id;
  // the closed form's answers still identify it, so they never resume into a
  // new draft.
  it("does not resume a submitted form's answers into a new draft when the first save reply was lost", async () => {
    const server = sealedServer();
    server.loseNextReply = true; // form-1 commits "Submitted B" as v1; the reply is lost
    const first = renderSealed(server);
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "Submitted B" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/could not be saved/));
    first.unmount(); // the unmount retry names null and is refused
    await waitFor(() => expect(server.sent).toHaveLength(2));
    expect(server.forms[0]).toMatchObject({ answers: { reason: "Submitted B" }, dataVersion: "v1" });
    server.forms[0].status = "submitted"; // another device submits form-1
    renderProjection(server, { templateKey: "fmla_self" });
    expect(screen.getByLabelText(/Reason/)).toHaveValue("");
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "New C" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(server.forms[1]?.answers).toEqual({ reason: "New C" }));
    expect(server.sent.at(-1)).toEqual({ reason: "New C", expected: null });
    expect(server.sent.map((entry) => entry.reason)).not.toContain(undefined);
  });

  // #6363 round 2: the other device edits B to C before submitting, so the
  // answers no longer match; the lane still retires because it learned the
  // form's id before the lost save was sent.
  it("retires a lost-reply lane by form identity after the other device edits and submits", async () => {
    const server = sealedServer();
    server.loseNextReply = true; // form-1 commits "Saved B" as v1; the reply is lost
    const first = renderSealed(server);
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "Saved B" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/could not be saved/));
    first.unmount();
    await waitFor(() => expect(server.sent).toHaveLength(2));
    server.writeElsewhere({ reason: "Edited elsewhere C" }); // the other device edits B to C
    server.forms[0].status = "submitted"; // and submits form-1
    renderProjection(server, { templateKey: "fmla_self" });
    expect(screen.getByLabelText(/Reason/)).toHaveValue("");
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "New D" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(server.forms[1]?.answers).toEqual({ reason: "New D" }));
    expect(server.sent.at(-1)).toEqual({ reason: "New D", expected: null });
    expect(server.forms[0]).toMatchObject({ status: "submitted", answers: { reason: "Edited elsewhere C" } });
  });

  // #6395, the reviewer's sequence: F1 is prepared for answers B, then another
  // device fills and submits F1 before B is sent; the answer request finds an
  // empty F2 and is refused, and the unmount retry names F1, so it is refused
  // too and B never lands in F2.
  it("never writes a retried save into a fresh draft after its form was submitted elsewhere", async () => {
    const server = sealedServer();
    server.afterPrepare = (id) => {
      server.afterPrepare = null;
      server.writeElsewhere({ reason: "Filled elsewhere" });
      server.forms.find((form) => form.id === id).status = "submitted";
    };
    const view = renderSealed(server);
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: "Answers B" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/could not be saved/));
    expect(server.sent).toEqual([{ reason: "Answers B", expected: null }]);
    expect(server.named).toEqual(["form-1"]);
    view.unmount(); // the unmount retry
    await waitFor(() => expect(server.sent).toHaveLength(2));
    expect(server.sent[1]).toEqual({ reason: "Answers B", expected: null });
    expect(server.named).toEqual(["form-1", "form-1"]);
    expect(server.forms).toEqual([
      expect.objectContaining({ id: "form-1", status: "submitted", answers: { reason: "Filled elsewhere" } }),
      expect.objectContaining({ id: "form-2", status: "draft", answers: {}, dataVersion: null }),
    ]);
  });

  it("refuses an editor's unmount save after its session ended and keeps nothing for the next session", async () => {
    vi.useFakeTimers();
    const onSaveDraft = vi.fn(async () => "open-fmla");
    const view = renderDraft(onSaveDraft);
    fireEvent.change(screen.getByDisplayValue("Original reason"), { target: { value: "Typed before sign-out" } });
    endFormDraftSession(); // identity changes before the editor unmounts, as in the shell
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(onSaveDraft).not.toHaveBeenCalled();
    expect(memberDraftSaves.size).toBe(0);
    vi.useRealTimers();
    renderDraft(onSaveDraft);
    expect(screen.getByDisplayValue("Original reason")).toBeVisible();
  });

  it.each(["rejected", "queued offline"])("keeps Close open with a visible failure when the save is %s, then retries", async (failure) => {
    const onSaveDraft = vi.fn();
    if (failure === "rejected") onSaveDraft.mockRejectedValueOnce(new Error("unavailable"));
    else onSaveDraft.mockResolvedValueOnce(null);
    onSaveDraft.mockResolvedValue("open-fmla");
    renderDraft(onSaveDraft);
    fireEvent.change(screen.getByDisplayValue("Original reason"), { target: { value: "Unsaved edit" } });
    fireEvent.click(screen.getByRole("button", { name: /Close form/ }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(/could not be saved/));
    expect(screen.getByDisplayValue("Unsaved edit")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Close form/ }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /Close form/ })).toBeNull());
    expect(onSaveDraft).toHaveBeenCalledTimes(2);
    expect(onSaveDraft.mock.calls[1][0].answers.reason).toBe("Unsaved edit");
  });

  it("resumes a successfully opened FMLA draft, preserves its answers and saves changed leave dates", async () => {
    const onSaveDraft = vi.fn(async () => "open-fmla");
    render(
      <LanguageProvider lang="en">
        <FormsView data={{ member: { initials: "MV" }, forms: [{ id: "open-fmla", templateKey: "fmla_self", status: "draft",
          step: 0, sealed: true, cosigners: [], answers: { reason: "Opened leave reason", condition_type: "continuous" } }] }}
          focus={{ templateKey: "fmla_self", formId: "open-fmla" }} onSaveDraft={onSaveDraft} onSubmit={vi.fn()} />
      </LanguageProvider>,
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByDisplayValue("Opened leave reason")).toBeVisible();
    expect(screen.getByRole("radio", { name: /continuous/i })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("radio", { name: /intermittent/i }));
    expect(screen.getByRole("radio", { name: /intermittent/i })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.change(screen.getByLabelText(/start date/i), { target: { value: "2026-11-02" } });
    fireEvent.change(screen.getByLabelText(/end date/i), { target: { value: "2026-11-20" } });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(onSaveDraft).toHaveBeenLastCalledWith(expect.objectContaining({
      answers: { reason: "Opened leave reason", condition_type: "intermittent", start_date: "2026-11-02", end_date: "2026-11-20" },
    })));
  });

  it("shows a notice instead of an editor for a draft whose answers could not be opened", () => {
    const onSaveDraft = vi.fn();
    render(
      <LanguageProvider lang="en">
        <FormsView
          data={{ member: { initials: "MV" }, forms: [{ id: "fmla-draft", templateKey: "fmla_self", status: "draft", step: 0,
            answers: {}, sealed: true, answersUnavailable: true, cosigners: [] }] }}
          onSaveDraft={onSaveDraft}
          onSubmit={vi.fn()}
        />
      </LanguageProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: /FMLA — my own health/ }));
    expect(screen.getByRole("alert").textContent).toMatch(/can’t be opened right now/);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(onSaveDraft).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: /FMLA — my own health/ })).toBeVisible();
    expect(onSaveDraft).not.toHaveBeenCalled();
  });

  it.each(["submitted", "in_review", "approved"])("withholds unreadable %s answers from the submission reader", (status) => {
    const onSaveDraft = vi.fn();
    const view = render(
      <LanguageProvider lang="en">
        <FormsView data={{ member: { initials: "MV" }, forms: [{ id: "unavailable-submission", templateKey: "fmla_family",
          status, answers: { reason: "Private medical tripwire" }, sealed: true, answersUnavailable: true, cosigners: [] }] }}
          onSaveDraft={onSaveDraft} onSubmit={vi.fn()} />
      </LanguageProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent(/can’t be opened right now/);
    expect(view.container.querySelector(".mforms-submission-review")).toBeNull();
    expect(screen.queryByText(/Private medical tripwire/)).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(onSaveDraft).not.toHaveBeenCalled();
  });
});
