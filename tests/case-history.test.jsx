import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { StewardView } from "../src/views/StewardView.jsx";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CaseHistoryTimeline } from "../src/components/CaseHistoryTimeline.jsx";
import { CaseworkOperationsPanel } from "../src/components/CaseworkOperationsPanel.jsx";
import { CasesView } from "../src/views/CasesView.jsx";
import { caseStepLabel, formatHistoryValue } from "../src/lib/caseHistoryValue.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { t as translate } from "../src/lib/i18n.js";
import { loadCaseHistory } from "../src/lib/caseworkApi.js";
import { relativeDateLabel } from "../src/lib/memberApi.js";

const at = "2026-09-17T01:00:00.123456+00:00";
const actorId = "5f2b9d0c-1c7a-4a5e-9b8e-0f1c2d3e4a5b";
const note = { event_id: "note:1", kind: "note", at, actor_user_id: actorId, actor_name: "Dana Ruiz", actor_role: "member", details: { body: "Member-visible note" } };
const staff = { event_id: "audit:1", kind: "audit", at, actor_user_id: actorId, actor_name: "Sam Okafor", actor_role: "steward", details: { action: "access_granted" } };
const fields = { event_id: "version:1", kind: "fields", at, actor_user_id: actorId, actor_name: null, actor_role: "coordinator", details: { table: "member_cases", changes: { deadline: { old: null, new: "2026-09-22" }, restriction_reason: { old: null, new: "Private restriction" } } } };
function apiFor(rows = [note, staff, fields]) { return { loadCaseHistory: vi.fn().mockResolvedValue({ rows, nextBefore: null }) }; }
function historyValue(item, key, lang = "en") {
  return formatHistoryValue(item, { key, lang, t: (keyName, vars) => translate(lang, keyName, vars) });
}
function wrap(node, lang = "en") { return render(<LanguageProvider lang={lang}>{node}</LanguageProvider>); }
const scope = { id: "case-1", step: "Intake" };
const caseData = { scope, strength: [], deadlines: [], checklists: [], transitions: [], alerts: [], management: [], retaliation: [], links: [], reminders: [] };

describe("case history API", () => {
  it("uses the RPC, clamps the limit, and retains sub-millisecond cursors", async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: [note], error: null }) };
    expect(await loadCaseHistory(client, "case-1", { limit: 1, before: at })).toEqual({ rows: [note], nextBefore: at });
    expect(client.rpc).toHaveBeenCalledWith("casework_case_history", { p_case_id: "case-1", p_limit: 1, p_before: at });
    await loadCaseHistory(client, "case-1", { limit: 500 });
    expect(client.rpc).toHaveBeenLastCalledWith("casework_case_history", { p_case_id: "case-1", p_limit: 100, p_before: null });
    await expect(loadCaseHistory(client, "")).rejects.toThrow("Case id required");
    client.rpc.mockResolvedValue({ error: { message: "permission denied" } });
    await expect(loadCaseHistory(client, "case-1")).rejects.toThrow();
  });
  // An undefined custom property is not a silent fallback: var() substitution
  // fails, the whole declaration computes to unset, and the border or colour
  // disappears in both themes.
  it("styles the timeline only from custom properties the theme defines", () => {
    const sheet = readFileSync("src/components/CaseHistoryTimeline.css", "utf8");
    const theme = readFileSync("src/styles.css", "utf8");
    const used = [...new Set([...sheet.matchAll(/var\((--[a-z0-9-]+)\)/g)].map((m) => m[1]))];
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((token) => !theme.includes(`${token}:`))).toEqual([]);
  });

  it("formats relative dates in the selected language", () => {
    const now = new Date(at).getTime() + 3600000;
    expect(relativeDateLabel(at, "en", now)).toBe("1 hour ago");
    expect(relativeDateLabel(at, "es", now)).toBe("hace 1 hora");
    expect(relativeDateLabel("invalid", "en", now)).toBe("");
  });
});

describe("shared staff and member case history", () => {
  it("ships the timeline inside the operations panel used by the coordinator detail", async () => {
    // The adapter still carries the step, procedure and ULP-flag routines; the
    // panel must offer none of them (Union Ground issues have no grievance
    // procedure and no legal filing deadline,).
    const api = {
      ...apiFor(),
      loadCaseworkCase: vi.fn().mockResolvedValue(caseData),
      advanceCaseStep: vi.fn(),
      getCaseProcedure: vi.fn(),
      setChecklistItem: vi.fn(),
      listCaseRetaliationFlags: vi.fn().mockResolvedValue([]),
    };
    const view = wrap(<CaseworkOperationsPanel caseId="case-1" api={api} />);
    expect(await screen.findByRole("heading", { name: "Issue history" })).toBeInTheDocument();
    expect(await screen.findByText("Private restriction")).toBeInTheDocument();
    expect(screen.getByText("Access granted")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(api.loadCaseHistory).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("heading", { name: /step progression|stage checklists|unfair labor|ULP/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /advance step|change step/i })).toBeNull();
    expect(view.container.querySelector("input[name='nextStep'], textarea[name='outcome']")).toBeNull();
    // The deadline center offers response and follow-up deadlines only.
    const kinds = within(screen.getByLabelText("Deadline type")).getAllByRole("option").map((option) => option.value);
    expect(kinds).toEqual(["response", "follow_up"]);
    expect(api.getCaseProcedure).not.toHaveBeenCalled();
    expect(api.listCaseRetaliationFlags).not.toHaveBeenCalled();
  });
  it("opens history through the real steward case detail", async () => {
    const row = { id: "case-1", reference: "GRV-1", title: "Schedule case", memberName: "Proof member", memberInitials: "PM", status: "active", step: "Intake", updates: [], updatesTotal: 0 };
    const desk = { caseload: [row], queue: [], threads: [], broadcasts: [], formsInbox: [], formTemplateVersions: [], kpis: {} };
    const api = { ...apiFor(), loadDesk: vi.fn().mockResolvedValue(desk), loadCaseworkCase: vi.fn().mockResolvedValue(caseData) };
    wrap(<StewardView data={{ member: { initials: "SO" } }} api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: /GRV-1/ }));
    const history = await within(screen.getByRole("dialog")).findByRole("region", { name: "Issue history" });
    expect(await within(history).findByText("Private restriction")).toBeInTheDocument();
  });
  it("wires every live staff and member adapter to the timeline RPC", () => {
    const app = readFileSync("src/App.jsx", "utf8");
    const rpc = "loadCaseHistory: (caseId, options) => loadCaseHistory(supabase, caseId, options)";
    for (const name of ["stewardApi", "memberCaseworkApi"]) {
      const adapter = app.split(`const ${name} = {`)[1].split("\n};")[0];
      expect(adapter, `${name} must reach the history RPC`).toContain(rpc);
    }
    // The coordinator case detail mounts the same operations panel the steward
    // does, and that panel shows the feed only when the adapter carries the
    // loader — so the coordinator plane needs it too, or the panel silently
    // drops the history for the one role that reviews it.
    const coordinator = app.slice(app.indexOf("const coordinatorApi ="), app.indexOf("const demoCoordinatorApi ="));
    expect(coordinator, "coordinatorApi must reach the history RPC").toContain(rpc);
  });
  // An adapter key no component on the coordinator plane reads is dead wiring
  // that reads like a feature. loadCaseworkHistory was one: only the steward's
  // CaseworkHubPanel reads it, and the query is bounded to steward_user_id, so a
  // coordinator could never have used it. Walk the relative imports reachable
  // from CoordinatorView (adapter modules excluded, since they define the same
  // names) and require every coordinatorApi key to be read there.
  it("carries only coordinatorApi keys the coordinator plane reads", () => {
    const app = readFileSync("src/App.jsx", "utf8");
    const adapter = app.slice(app.indexOf("const coordinatorApi ="), app.indexOf("const demoCoordinatorApi ="));
    const keys = [...adapter.matchAll(/^ {4}(\w+):/gm)].map((match) => match[1]);
    expect(keys.length, "could not read the coordinatorApi keys").toBeGreaterThan(20);
    const seen = new Set();
    const pending = [resolve("src/views/CoordinatorView.jsx")];
    while (pending.length) {
      const file = pending.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      for (const [, spec] of readFileSync(file, "utf8").matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/g)) {
        const base = resolve(dirname(file), spec);
        const next = [base, `${base}.jsx`, `${base}.js`].find((path) => /\.jsx?$/.test(path) && existsSync(path));
        if (next) pending.push(next);
      }
    }
    const readers = [...seen].filter((file) => !/Api\.js$/.test(file)).map((file) => readFileSync(file, "utf8")).join("\n");
    // Pre-existing unread keys owned by other work; shrink this list, never grow it.
    const knownUnread = new Set(["acknowledgeAlert", "loadCaseworkHub", "createBargainingWorkspace", "createChecklistTemplate", "addBargainingProposal", "transitionBargainingProposal", "addBargainingEvent", "setBargainingStatus", "saveIntakeDraft", "scanRetaliationPatterns", "reviewRetaliationPattern"]);
    const unread = keys.filter((key) => !knownUnread.has(key) && !new RegExp(`\\b${key}\\b`).test(readers));
    expect(unread, "coordinatorApi keys no component reachable from CoordinatorView reads").toEqual([]);
    expect(keys, "the steward-scoped history loader has no coordinator reader").not.toContain("loadCaseworkHistory");
  });
  // The session-only demo twin has no database behind the member planes, so a
  // history panel there could only ever report its own failure. Assert that
  // property, not one spelling of it: the same `caseworkApi` prop carries the
  // coordinator procedure work, so a neighbouring change may hand the demo arm
  // nothing at all or hand it a fixture adapter. Either is honest as long as
  // the arm is never the live `memberCaseworkApi` and never reaches the
  // supabase-bound loader.
  it("never hands the demo member plane the live history loader", () => {
    const app = readFileSync("src/App.jsx", "utf8");
    const wiring = app.match(/<CasesView\b[^\n]*?\scaseworkApi=\{([^{}]+)\}/)?.[1]?.trim();
    expect(wiring, "src/App.jsx must hand <CasesView> a casework adapter").toBeTruthy();
    const [, guard, onDemo, otherwise] = wiring.match(/^(\w+)\s*\?\s*([\w.]+)\s*:\s*([\w.]+)$/) ?? [];
    expect(guard, `unreadable caseworkApi wiring: ${wiring}`).toBeTruthy();
    expect(["demo", "demoActive", "fixtureDemo"]).toContain(guard);
    expect(otherwise, `the live arm of ${wiring} is not the live member adapter`).toBe("memberCaseworkApi");
    expect(onDemo, "the demo arm must not be the live member adapter").not.toBe("memberCaseworkApi");
    // `null` hands the demo plane nothing, which CasesView reads as "no feed".
    // A named adapter has to be declared here and stay off the live loader.
    if (onDemo !== "null") {
      const start = app.indexOf(`const ${onDemo} =`);
      expect(start, `${onDemo} is not declared in src/App.jsx`).toBeGreaterThan(-1);
      const twin = app.slice(start).split("\n  const ")[0];
      expect(twin, `the ${onDemo} twin adapter reaches the live history loader`).not.toContain("loadCaseHistory(supabase");
    }
  });
  // The guard that actually keeps a database-less plane away from the feed is
  // the one the views apply when they render: no loader on the adapter they
  // are handed, no timeline. Prove that by rendering, so no rewiring of the
  // App wiring above can satisfy the invariant on source text alone.
  it("shows the feed only to a plane whose adapter carries the loader", async () => {
    const row = { id: "case-1", reference: "GRV-1", title: "Schedule case", type: "Scheduling", articles: "", status: "active", step: "Intake", deadlineValue: null, files: [], updates: [{ id: "update-1", body: "Stored note", created_at: at }] };
    async function openDetail(caseworkApi) {
      const view = wrap(<CasesView data={{ cases: [row] }} caseworkApi={caseworkApi} />);
      const plane = within(view.container);
      fireEvent.click(plane.getByRole("button", { name: /Schedule case/ }));
      return { view, detail: within(await plane.findByRole("dialog")) };
    }
    // Nothing at all, and a fixture-shaped adapter without the loader: both
    // keep the stored-notes timeline and never mount the feed.
    for (const caseworkApi of [null, { loadRetaliationReports: vi.fn().mockResolvedValue([]) }]) {
      const { view, detail } = await openDetail(caseworkApi);
      expect(await detail.findByText("Stored note")).toBeInTheDocument();
      expect(detail.queryByRole("region", { name: "Issue history" })).toBeNull();
      view.unmount();
    }
    // The staff panel applies the same rule for the coordinator and steward
    // desks, so an adapter missing the loader silently drops the feed there.
    const panel = wrap(<CaseworkOperationsPanel caseId="case-1" api={{ loadCaseworkCase: vi.fn().mockResolvedValue(caseData) }} />);
    const staff = within(panel.container);
    expect(await staff.findByRole("heading", { name: "Issue tools" })).toBeInTheDocument();
    expect(staff.queryByRole("region", { name: "Issue history" })).toBeNull();
    panel.unmount();
    const live = { ...apiFor(), loadRetaliationReports: vi.fn().mockResolvedValue([]) };
    const { view, detail } = await openDetail(live);
    expect(await detail.findByRole("region", { name: "Issue history" })).toBeInTheDocument();
    expect(detail.queryByText("Stored note")).toBeNull();
    expect(live.loadCaseHistory).toHaveBeenCalledWith("case-1", { before: null });
    view.unmount();
  });
  it("renders the member dialog with only notes, transitions and deadline changes", async () => {
    const row = { id: "case-1", reference: "GRV-1", title: "Schedule case", type: "Scheduling", articles: "", status: "active", step: "Intake", deadlineValue: null, updates: [], files: [] };
    const api = { ...apiFor(), loadRetaliationReports: vi.fn().mockResolvedValue([]) };
    wrap(<CasesView data={{ cases: [row] }} caseworkApi={api} />);
    fireEvent.click(screen.getByRole("button", { name: /Schedule case/ }));
    const history = await screen.findByRole("region", { name: "Issue history" });
    expect(await within(history).findByText("Member-visible note")).toBeInTheDocument();
    expect(within(history).getByText(historyValue("2026-09-22", "deadline"))).toBeInTheDocument();
    expect(within(history).queryByText("2026-09-22")).not.toBeInTheDocument();
    expect(within(history).queryByText("Private restriction")).not.toBeInTheDocument();
    expect(within(history).queryByText("Access granted")).not.toBeInTheDocument();
  });
  // A bare arrow on a named span puts the relation on an element whose generic
  // role cannot hold a name, and reads the glyph aloud. The relation belongs in
  // hidden localized text beside a decorative arrow.
  it("states the old-to-new relation as hidden localized text beside a decorative arrow", async () => {
    const view = wrap(<CaseHistoryTimeline caseId="case-1" api={apiFor([fields])} />);
    const change = await waitFor(() => {
      const node = view.container.querySelector(".case-history__changes dd");
      expect(node).not.toBeNull();
      return node;
    });
    expect(change.querySelector(".visually-hidden")).toHaveTextContent("changed to");
    expect(change.querySelector("[aria-hidden=\"true\"]").textContent).toBe(" \u2192 ");
    expect(change.querySelector("[aria-label]")).toBeNull();
    expect(change.textContent).toBe(`${historyValue(null, "deadline")}changed to \u2192 ${historyValue("2026-09-22", "deadline")}`);

    const spanish = wrap(<CaseHistoryTimeline caseId="case-1" api={apiFor([fields])} />, "es");
    await waitFor(() => expect(spanish.container.querySelector(".case-history__changes .visually-hidden")).toHaveTextContent("cambió a"));
  });

  // The record's question is "who changed this case's deadline and when". The
  // RPC answers "who" only as far as the caller may already see, so the
  // timeline shows a name when there is one, the actor's role on this case
  // when there is not, and never the raw uuid it was given.
  it("names the actor on every plane, falls back to the role label and never shows a uuid", async () => {
    const detached = { event_id: "audit:2", kind: "audit", at, actor_user_id: null, actor_name: null, actor_role: null, details: { action: "case_updated" } };
    const view = wrap(<CaseHistoryTimeline caseId="case-1" api={apiFor([note, staff, fields, detached])} />);
    expect(await screen.findByText("by Dana Ruiz")).toBeInTheDocument();
    expect(screen.getByText("by Sam Okafor")).toBeInTheDocument();
    expect(screen.getByText("by Campaign lead")).toBeInTheDocument();
    expect(view.container.textContent).not.toContain(actorId);
    expect(view.container.querySelectorAll(".case-history__actor")).toHaveLength(3);
    const spanish = wrap(<CaseHistoryTimeline caseId="case-1" api={apiFor([{ ...fields, actor_role: "steward" }])} />, "es");
    await waitFor(() => expect(spanish.container.textContent).toContain("por Comité"));
  });
  it("carries attribution through the member projection and the staff panel", async () => {
    const row = { id: "case-1", reference: "GRV-1", title: "Schedule case", type: "Scheduling", articles: "", status: "active", step: "Intake", deadlineValue: null, updates: [], files: [] };
    const api = { ...apiFor(), loadRetaliationReports: vi.fn().mockResolvedValue([]) };
    wrap(<CasesView data={{ cases: [row] }} caseworkApi={api} />);
    fireEvent.click(screen.getByRole("button", { name: /Schedule case/ }));
    const history = await screen.findByRole("region", { name: "Issue history" });
    expect(await within(history).findByText("by Dana Ruiz")).toBeInTheDocument();
    expect(within(history).getByText("by Campaign lead")).toBeInTheDocument();
    expect(within(history).queryByText("by Sam Okafor")).not.toBeInTheDocument();
    const panel = { ...apiFor(), loadCaseworkCase: vi.fn().mockResolvedValue(caseData) };
    const staffView = wrap(<CaseworkOperationsPanel caseId="case-1" api={panel} />);
    await waitFor(() => expect(staffView.container.textContent).toContain("by Sam Okafor"));
  });
  it("supports loading, failure, retry, empty and Spanish states", async () => {
    const api = apiFor();
    api.loadCaseHistory.mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ rows: [], nextBefore: null });
    wrap(<CaseHistoryTimeline caseId="case-1" api={api} />, "es");
    expect(screen.getByRole("status")).toHaveTextContent("Cargando historial");
    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo cargar");
    fireEvent.click(screen.getByRole("button", { name: "Intentar de nuevo" }));
    expect(await screen.findByText("Aún no hay historial.")).toBeInTheDocument();
  });
  it("appends earlier activity, preserves rows on failure and retries the same cursor", async () => {
    const api = apiFor();
    api.loadCaseHistory.mockResolvedValueOnce({ rows: [note], nextBefore: at }).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ rows: [staff], nextBefore: null });
    wrap(<CaseHistoryTimeline caseId="case-1" api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Load earlier activity" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("Member-visible note")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Access granted")).toBeInTheDocument();
    expect(api.loadCaseHistory).toHaveBeenLastCalledWith("case-1", { before: at });
  });
  it("discards late responses from a previous case", async () => {
    let finish;
    const api = apiFor();
    api.loadCaseHistory.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockResolvedValue({ rows: [{ ...note, details: { body: "Second case" } }], nextBefore: null });
    const view = wrap(<CaseHistoryTimeline caseId="case-1" api={api} />);
    view.rerender(<LanguageProvider lang="en"><CaseHistoryTimeline caseId="case-2" api={api} /></LanguageProvider>);
    expect(await screen.findByText("Second case")).toBeInTheDocument();
    finish({ rows: [note], nextBefore: null });
    await waitFor(() => expect(screen.queryByText("Member-visible note")).not.toBeInTheDocument());
  });

  it("renders Spanish steps, deadlines, extensions, member changes and assessments as readable copy", async () => {
    const due = "2026-09-22T15:00:00.000Z";
    const later = "2026-10-01T18:30:00.000Z";
    const decided = "2026-09-23T14:00:00.000Z";
    const transition = { event_id: "transition:1", kind: "transition", at, actor_name: "Dana Ruiz", actor_role: "steward", details: { from_step: "Intake", to_step: "Step 2", outcome: "Filed for review" } };
    const custom = { event_id: "transition:2", kind: "transition", at, actor_name: "Dana Ruiz", actor_role: "steward", details: { from_step: "Arbitration", to_step: "Step 4", outcome: "board_move" } };
    const deadline = { event_id: "version:deadline", kind: "fields", at, actor_role: "coordinator", details: { table: "casework_deadlines", op: "UPDATE", changes: { label: { old: "Filing window", new: "Hearing window" }, kind: { old: "filing", new: "hearing" }, due_at: { old: due, new: later }, status: { old: "active", new: "extended" } } } };
    const extension = { event_id: "version:extension", kind: "fields", at, actor_role: "coordinator", details: { table: "casework_deadline_extensions", op: "UPDATE", changes: { previous_due_at: { old: due, new: due }, requested_due_at: { old: later, new: later }, decided_at: { old: null, new: decided }, status: { old: "requested", new: "approved" }, reason: { old: null, new: "Waiting on the employer" } } } };
    const member = { event_id: "version:member", kind: "fields", at, actor_role: "coordinator", details: { table: "member_cases", op: "UPDATE", changes: { deadline: { old: null, new: "2026-09-22" }, step: { old: "Intake", new: "Step 3" }, status: { old: "active", new: "resolved" }, is_restricted: { old: false, new: true }, restriction_reason: { old: null, new: "Private restriction" } } } };
    const analysis = { event_id: "version:analysis", kind: "fields", at, actor_role: "steward", details: { table: "casework_strength_analyses", op: "INSERT", changes: { score: { old: null, new: 48 }, band: { old: null, new: "needs_evidence" }, inputs: { old: null, new: { facts: 4, documentation: 2, timeliness: 5, contract_support: 3, witnesses: 1 } }, recommendations: { old: [], new: ["strengthen_documentation", "review_deadlines", "confirm_contract_support"] } } } };
    const view = wrap(<CaseHistoryTimeline caseId="case-1" api={apiFor([transition, custom, deadline, extension, member, analysis])} />, "es");
    expect(await screen.findByText("Filed for review")).toBeInTheDocument();
    const text = view.container.textContent;
    expect(text).toContain("Admisión");
    expect(text).toContain("Paso 2");
    expect(text).toContain("Paso 3");
    expect(text).toContain("Paso 4");
    //: Arbitration is an app-known stage, named in Spanish.
    expect(text).toContain("Arbitraje");
    expect(text).toContain(translate("es", "caseworkOutcome.board_move"));
    expect(text).toContain("Presentación");
    expect(text).toContain("Audiencia");
    expect(text).toContain("Prorrogado");
    expect(text).toContain("Solicitado");
    expect(text).toContain("Aprobado");
    expect(text).toContain("Resuelto");
    expect(text).toContain("Sí");
    expect(text).toContain("Hechos claros: 4");
    expect(text).toContain("Refuerza la documentación");
    expect(text).toContain("Revisa los plazos");
    // The stored id stays
    // contract_support, but before a first contract the label names a policy
    // or a law, not a contract.
    expect(text).toContain("Respaldo en política o ley: 3");
    expect(text).toContain("Confirma el respaldo en política o ley");
    expect(text).not.toMatch(/apoyo contractual/i);
    expect(text).toContain("Necesita evidencia");
    expect(text).toContain("Ninguno");
    expect(text).toContain(historyValue(due, "due_at", "es"));
    expect(text).toContain(historyValue("2026-09-22", "deadline", "es"));
    expect(text).toContain("Private restriction");
    expect(text).toContain("Filing window");
    expect(text).toContain("Hearing window");
    expect(text).toContain("Waiting on the employer");
    expect(text).not.toContain("strengthen_documentation");
    expect(text).not.toContain("needs_evidence");
    expect(text).not.toContain("2026-09-22T15:00:00");
    expect(text).not.toContain("2026-09-22");
    expect(text).not.toContain("{");
    expect(text).not.toContain("[");
    expect(text).not.toMatch(/Step\s+\d/);
    expect(text).not.toContain("Intake");
  });

  it("names deadline and alert creation audit events instead of the generic fallback", async () => {
    // SEC-UG-CASEWORK-DEADLINES-ALERTS-INSERT-MISSING-EVENT-ROW-20260920
    const created = [
      { event_id: "audit:deadline", kind: "audit", at, actor_name: "Sam Okafor", actor_role: "steward", details: { action: "deadline_created" } },
      { event_id: "audit:alert", kind: "audit", at, actor_name: "Sam Okafor", actor_role: "steward", details: { action: "alert_created" } },
    ];
    for (const [lang, deadline, alert] of [["en", "Deadline added", "Alert added"], ["es", "Plazo añadido", "Alerta añadida"]]) {
      const view = wrap(<CaseHistoryTimeline caseId="case-1" api={apiFor(created)} />, lang);
      expect(await screen.findByText(deadline)).toBeInTheDocument();
      expect(screen.getByText(alert)).toBeInTheDocument();
      expect(view.container.textContent).not.toContain(translate(lang, "caseHistory.recordUpdated"));
      view.unmount();
    }
  });
});

describe("case history value formatting", () => {
  const ctx = (lang = "en") => ({ lang, t: (keyName, vars) => translate(lang, keyName, vars) });
  const value = (item, key, lang = "en") => formatHistoryValue(item, { ...ctx(lang), key });

  it("keeps staff prose, localizes known tokens, and never prints JSON", () => {
    expect(readFileSync("src/components/CaseHistoryTimeline.jsx", "utf8")).not.toContain("JSON.stringify");
    expect(readFileSync("src/lib/caseHistoryValue.js", "utf8")).not.toContain("JSON.stringify");
    expect(caseStepLabel("Step 2", ctx().t)).toBe("Step 2");
    expect(caseStepLabel("intake", ctx("es").t)).toBe("Admisión");
    expect(caseStepLabel("Arbitration", ctx().t)).toBe("Arbitration");
    expect(caseStepLabel("", ctx().t)).toBe("");
    expect(caseStepLabel(null, ctx().t)).toBe(null);
    expect(value(null, "label")).toBe("Not set");
    expect(value("", "outcome")).toBe("");
    expect(value("  keep both sides  ", "reason")).toBe("  keep both sides  ");
    expect(value("board_move", "outcome", "es")).toBe("Movido en el tablero de asuntos.");
    expect(value("Filed for review", "outcome")).toBe("Filed for review");
    expect(value("not-a-date", "due_at")).toBe("not-a-date");
    expect(value("2026-13-40", "deadline")).toBe("2026-13-40");
    expect(value("2026-09-22T15:00:00.000Z", "deadline", "en")).toBe(historyValue("2026-09-22T15:00:00.000Z", "due_at", "en"));
    expect(value(new Date("2026-09-22T15:00:00.000Z"), "due_at", "en")).toBe(historyValue("2026-09-22T15:00:00.000Z", "due_at", "en"));
    expect(value(false, "is_restricted", "es")).toBe("No");
    expect(value(true, "is_restricted")).toBe("Yes");
    expect(value(0, "score")).toBe("0");
    expect(value(Number.NaN, "score")).toBe("Not set");
    expect(value("custom_status", "status")).toBe("custom_status");
    expect(value("call_the_member", "kind")).toBe("call_the_member");
    expect(value([], "recommendations")).toBe("None");
    expect(value({}, "inputs")).toBe("None");
    expect(value({ summary: "Kept verbatim" }, "payload", "es")).toContain("Resumen: Kept verbatim");
    expect(value({ facts: 1, extra_factor: 2 }, "inputs")).toContain("Clear facts: 1");
    expect(value({ facts: 1, extra_factor: 2 }, "inputs")).toContain("extra factor: 2");
    expect(value(["strengthen_documentation", "call_the_member"], "recommendations", "es")).toContain("Refuerza la documentación");
    expect(value(["strengthen_documentation", "call_the_member"], "recommendations", "es")).toContain("call_the_member");
    expect(value(["one", "two"], "articles")).toBe("one and two");
    expect(value(["one"], "articles")).toBe("one");
    expect(value([""], "recommendations")).toBe("None");
    expect(value({ a: { b: { c: { d: 1 } } } }, "payload")).toContain("Recorded details");
    expect(value({ a: { b: { c: { d: 1 } } } }, "payload")).not.toContain(": 1");
    const deep = value({ a: { b: { c: ["hidden-token"] } } }, "payload");
    expect(deep).toContain("Recorded details");
    expect(deep).not.toContain("hidden-token");
    expect(deep).not.toContain("{");
  });
});
