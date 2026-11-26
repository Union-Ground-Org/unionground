import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { declaredFor, mediaRule, mountStylesheets } from "./helpers/appStylesheet.js";
import { AttentionBadge, AttentionPanel, NextActionsPanel, useAttentionVisit, useStewardAttention } from "../src/features/caseSignals/CaseSignals.jsx";
import {
  attentionShortcutsEnabled, attentionSnapshotKey, attentionTrend, normalizeAttention, normalizeNextActions,
  organizationSwitchOn, readAttentionSnapshot, writeAttentionSnapshot,
} from "../src/features/caseSignals/model.js";
import { caseSignalsCatalogue } from "../src/lib/i18n/caseSignals.js";
import { catalogue } from "../src/lib/i18n.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

const NEXT = {
  enabled: true,
  items: [
    { id: "deadline_risk:c1", kind: "deadline_risk", severity: "high", caseId: "c1", reference: "GR-1", step: "Step 1", memberId: "m1", memberName: "Ana Ruiz", dueDate: "2026-10-03", days: 2 },
    { id: "stale_contact:m2", kind: "stale_contact", severity: "medium", caseId: "c2", reference: "GR-2", memberId: "m2", memberName: "Ben Cho", openCases: 1, lastContactDays: null },
    { id: "weak_strength:c3", kind: "weak_strength", severity: "medium", caseId: "c3", reference: "GR-3", memberId: "m3", memberName: "Cy Dee", strength: 25 },
    { id: "made_up:c4", kind: "made_up", severity: "high" },
  ],
  summary: { total: 3, urgent: 1, missingOwner: 0 },
};
const ATTENTION = {
  enabled: true, count: 2, memberSurfaces: true, navigation: true, dominantReason: "deadline_risk",
  breakdown: { dueSoon: 1, openWithoutDeadlineRisk: 1 },
  members: [
    { memberId: "m1", memberName: "Ana Ruiz", openCases: 1, reasons: ["deadline_risk", "open_case"], urgency: 90, caseId: "c1", reference: "GR-1", step: "Step 1", days: -1 },
    { memberId: "m3", memberName: "Cy Dee", openCases: 2, reasons: ["open_case"], urgency: 60, caseId: "c3", reference: "GR-3", step: null, days: null },
  ],
};

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { getItem: (key) => (map.has(key) ? map.get(key) : null), setItem: (key, value) => map.set(key, value), map };
}

describe("issue signal model", () => {
  it("validates the next-action projection and drops unknown kinds", () => {
    const result = normalizeNextActions(NEXT);
    expect(result.items.map((item) => item.id)).toEqual(["deadline_risk:c1", "stale_contact:m2", "weak_strength:c3"]);
    expect(normalizeNextActions({ enabled: false })).toMatchObject({ enabled: false, items: [] });
  });

  it("restores the old since-your-last-visit trend", () => {
    expect(attentionTrend(null, 3, "deadline_risk")).toBeNull();
    expect(attentionTrend(3, 3, "deadline_risk")).toEqual({ direction: "same", magnitude: 0, reason: null });
    expect(attentionTrend(1, 4, "deadline_risk")).toEqual({ direction: "up", magnitude: 3, reason: "deadline_risk" });
    expect(attentionTrend(5, 2, "open_case")).toEqual({ direction: "down", magnitude: 3, reason: "open_case" });
  });

  it("keeps the visit snapshot per account, organization and hat on this device", () => {
    const storage = memoryStorage();
    expect(attentionSnapshotKey({ userId: "u", organizationId: "o", hat: "steward" })).toBe("ug.attention.visit.v1:u:o:steward");
    expect(attentionSnapshotKey({ userId: "u", organizationId: null, hat: "steward" })).toBeNull();
    writeAttentionSnapshot(storage, "k", 4, new Date("2026-10-01T12:00:00Z"));
    expect(readAttentionSnapshot(storage, "k")).toEqual({ count: 4, at: "2026-10-01T12:00:00.000Z" });
    expect(readAttentionSnapshot(memoryStorage({ k: "{bad" }), "k")).toBeNull();
    expect(readAttentionSnapshot(memoryStorage({ k: JSON.stringify({ count: -1 }) }), "k")).toBeNull();
  });

  it("offers palette shortcuts only on the committee worker hat with every attention switch on", () => {
    const on = { switches: { "features.attention.guided_portal": true, "features.attention.dashboard": true, "features.attention.navigation": true } };
    expect(attentionShortcutsEnabled(on, "steward")).toBe(true);
    expect(attentionShortcutsEnabled(on, "member")).toBe(false);
    expect(attentionShortcutsEnabled({ switches: { ...on.switches, "features.attention.navigation": false } }, "steward")).toBe(false);
    expect(attentionShortcutsEnabled(null, "steward")).toBe(false);
    expect(organizationSwitchOn({ switches: { x: "true" } }, "x")).toBe(false);
  });

  it("has every copy key in both languages and the switch labels for the settings page", () => {
    expect(Object.keys(caseSignalsCatalogue.es).sort()).toEqual(Object.keys(caseSignalsCatalogue.en).sort());
    for (const key of [
      "features.casework.next_action_queue", "limits.casework.stale_contact_days", "limits.casework.evidence_deadline_days",
      "limits.casework.weak_strength_threshold", "features.attention.guided_portal", "features.attention.dashboard",
      "features.attention.member_surfaces", "features.attention.navigation",
    ]) {
      for (const suffix of ["label", "description"]) {
        expect(catalogue.en[`settings.def.${key}.${suffix}`], key).toBeTruthy();
        expect(catalogue.es[`settings.def.${key}.${suffix}`], key).toBeTruthy();
      }
    }
  });
});

describe("next actions panel", () => {
  it("ranks the server's items with severity, reason and an open-case action", async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: NEXT, error: null }) };
    const onOpenCase = vi.fn();
    render(<NextActionsPanel caseSignals={{ client, scopeKey: "k" }} hat="steward" onOpenCase={onOpenCase} />);
    expect(await screen.findByText("Issue GR-1: deadline in 2 days (Oct 3)")).toBeInTheDocument();
    expect(client.rpc).toHaveBeenCalledWith("get_case_queue_next_actions", { p_selected_hat: "steward", p_limit: 25 });
    expect(screen.getByText("Ben Cho needs a contact update")).toBeInTheDocument();
    expect(screen.getByText("No contact recorded across 1 active issue. Log contact or plan the next outreach.")).toBeInTheDocument();
    expect(screen.getByText("Issue GR-3 strength is 25/100")).toBeInTheDocument();
    expect(screen.getByText("3 next actions · 1 urgent")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open issue GR-1" }));
    expect(onOpenCase).toHaveBeenCalledWith("c1");
  });

  it.each([
    ["en", 1, "No contact recorded across 1 active issue.", "Last contact 16 days ago across 1 active issue."],
    ["en", 3, "No contact recorded across 3 active issues.", "Last contact 16 days ago across 3 active issues."],
    ["es", 1, "No hay contacto registrado en 1 asunto activo.", "Último contacto hace 16 días en 1 asunto activo."],
    ["es", 3, "No hay contacto registrado en 3 asuntos activos.", "Último contacto hace 16 días en 3 asuntos activos."],
  ])("uses the right active-case wording in %s for %i", async (lang, openCases, never, previous) => {
    const contact = { ...NEXT.items[1], openCases };
    const items = [contact, { ...contact, id: "stale_contact:m3", memberId: "m3", lastContactDays: 16 }];
    const client = { rpc: vi.fn().mockResolvedValue({ data: { enabled: true, items }, error: null }) };
    render(<LanguageProvider lang={lang}><NextActionsPanel caseSignals={{ client, scopeKey: lang }} hat="steward" /></LanguageProvider>);

    const [neverRow, previousRow] = await screen.findAllByRole("listitem");
    expect.soft(neverRow).toHaveTextContent(never);
    expect.soft(previousRow).toHaveTextContent(previous);
  });

  it.each([
    ["en", 1, 1, 1, "1 next action · 1 urgent"],
    ["en", 1, 3, 1, "Top 1 of 3 next actions · 1 urgent"],
    ["es", 1, 1, 1, "1 próxima acción · 1 urgente"],
    ["es", 2, 2, 1, "2 próximas acciones · 1 urgente"],
    ["es", 1, 3, 2, "La principal de 3 próximas acciones · 2 urgentes"],
    ["es", 2, 3, 2, "Las 2 principales de 3 próximas acciones · 2 urgentes"],
  ])("renders summary agreement in %s for %i shown, %i total, %i urgent", async (lang, shown, total, urgent, summary) => {
    const items = NEXT.items.slice(0, shown);
    const client = { rpc: vi.fn().mockResolvedValue({ data: { enabled: true, items, summary: { total, urgent } }, error: null }) };
    render(<LanguageProvider lang={lang}><NextActionsPanel caseSignals={{ client, scopeKey: lang }} hat="coordinator" /></LanguageProvider>);

    expect(await screen.findByText(summary)).toBeInTheDocument();
  });

  it("is silent when switched off and honest when empty or failing", async () => {
    const off = { rpc: vi.fn().mockResolvedValue({ data: { enabled: false, items: [] }, error: null }) };
    const first = render(<NextActionsPanel caseSignals={{ client: off, scopeKey: "a" }} hat="steward" />);
    await waitFor(() => expect(off.rpc).toHaveBeenCalled());
    await Promise.resolve();
    expect(first.container).toBeEmptyDOMElement();
    first.unmount();
    const empty = { rpc: vi.fn().mockResolvedValue({ data: { enabled: true, items: [], summary: { total: 0, urgent: 0 } }, error: null }) };
    const second = render(<NextActionsPanel caseSignals={{ client: empty, scopeKey: "b" }} hat="coordinator" />);
    expect(await screen.findByText("Nothing needs action right now.")).toBeInTheDocument();
    second.unmount();
    const failing = { rpc: vi.fn().mockResolvedValueOnce({ data: null, error: { code: "42501" } }).mockResolvedValueOnce({ data: NEXT, error: null }) };
    render(<NextActionsPanel caseSignals={{ client: failing, scopeKey: "c" }} hat="steward" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Next actions could not be loaded.");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Issue GR-1: deadline in 2 days (Oct 3)")).toBeInTheDocument();
  });
});

function AttentionHarness({ client, storage, scope }) {
  const attention = useStewardAttention({ client, scopeKey: scope.organizationId }, "steward");
  const visit = useAttentionVisit(attention, scope, storage);
  return (
    <>
      <AttentionPanel attention={attention} snapshot={visit} onOpenCase={() => {}} />
      <ul>
        <li>Ana <AttentionBadge attention={attention} memberId="m1" /></li>
        <li>Ben <AttentionBadge attention={attention} memberId="m2" /></li>
      </ul>
    </>
  );
}

describe("attention panel", () => {
  it("reads the new organization's prior visit when a mounted panel changes scope", async () => {
    const first = { userId: "u1", organizationId: "o1", hat: "steward" };
    const second = { ...first, organizationId: "o2" };
    const storage = memoryStorage({
      [attentionSnapshotKey(first)]: JSON.stringify({ count: 1, at: "2026-09-30T12:00:00Z" }),
      [attentionSnapshotKey(second)]: JSON.stringify({ count: 5, at: "2026-09-30T12:00:00Z" }),
    });
    let finishSecond;
    const client = { rpc: vi.fn()
      .mockResolvedValueOnce({ data: ATTENTION, error: null })
      .mockImplementationOnce(() => new Promise((resolve) => { finishSecond = resolve; })) };
    const view = (scope) => <AttentionHarness client={client} storage={storage} scope={scope} />;
    const ui = render(view(first));
    expect(await screen.findByText(/Up 1 since your last visit/)).toBeInTheDocument();
    ui.rerender(view(second));
    expect(JSON.parse(storage.map.get(attentionSnapshotKey(second))).count).toBe(5);
    expect(screen.queryByText(/Up 1 since your last visit/)).toBeNull();
    await act(async () => { finishSecond({ data: ATTENTION, error: null }); });
    expect(await screen.findByText(/Down 3 since your last visit/)).toBeInTheDocument();
  });
  it("shows the rollup, the trend since the previous visit and directory badges, then records this visit", async () => {
    const scope = { userId: "u1", organizationId: "o1", hat: "steward" };
    const key = attentionSnapshotKey(scope);
    const storage = memoryStorage({ [key]: JSON.stringify({ count: 1, at: "2026-09-30T12:00:00Z" }) });
    const client = { rpc: vi.fn().mockResolvedValue({ data: ATTENTION, error: null }) };
    render(<AttentionHarness client={client} storage={storage} scope={scope} />);
    expect(await screen.findByText("2 workers need attention")).toBeInTheDocument();
    expect(screen.getByText("Up 1 since your last visit. Deadline risk is driving the biggest change.")).toBeInTheDocument();
    expect(screen.getByText("Deadline 1 day overdue on issue GR-1.")).toBeInTheDocument();
    expect(screen.getByText("2 open issues still need follow-up.")).toBeInTheDocument();
    expect(screen.getAllByTestId("attention-badge")).toHaveLength(1);
    await waitFor(() => expect(JSON.parse(storage.map.get(key)).count).toBe(2));
  });

  it("renders in Spanish and hides badges when worker surfaces are off", async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: { ...ATTENTION, memberSurfaces: false }, error: null }) };
    render(<LanguageProvider lang="es"><AttentionHarness client={client} storage={memoryStorage()} scope={{ userId: "u", organizationId: "o", hat: "steward" }} /></LanguageProvider>);
    expect(await screen.findByText("2 trabajadores necesitan atención")).toBeInTheDocument();
    expect(screen.queryByText(/desde tu última visita/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("attention-badge")).not.toBeInTheDocument();
  });

  it("renders nothing while the attention switches are off", async () => {
    const client = { rpc: vi.fn().mockResolvedValue({ data: { enabled: false, members: [], count: 0 }, error: null }) };
    const { container } = render(<AttentionHarness client={client} storage={memoryStorage()} scope={{ userId: "u", organizationId: "o", hat: "steward" }} />);
    await waitFor(() => expect(client.rpc).toHaveBeenCalled());
    await Promise.resolve();
    expect(container.querySelector("[data-testid='attention-panel']")).toBeNull();
    expect(normalizeAttention(null).enabled).toBe(false);
  });
});

// UB-UG-STEWARD-WHAT-TO-DO-NEXT-CARD-TEXT-FLUSH-LEFT-20261106: both
// panels are cwk-panel cards with no inner padding of their own, so the
// heading, count, intro and rows sat against the card's left border.
describe("issue signal panel inset", () => {
  it("insets the heading, intro and rows inside the card on desktop and phones", () => {
    const unmount = mountStylesheets("src/features/caseSignals/caseSignals.css");
    try {
      expect(declaredFor(".cs-panel")).toMatch(/padding: 16px 20px 20px/);
      expect(mediaRule("(max-width: 520px)", ".cs-panel")?.padding).toBe("14px 16px 16px");
    } finally {
      unmount();
    }
  });
});
