import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { altRecordPagesCatalogue } from "../src/lib/i18n/altRecordPages.js";
import { ChapterMembershipSwitch } from "../src/components/ChapterMembershipSwitch.jsx";
import { createMemoryPayCatalog } from "../src/features/pay/index.js";
import { buildPayActor } from "../src/lib/mi1PayWiring.js";
import { PayToolsView } from "../src/views/PayToolsView.jsx";
import { ProductHubView } from "../src/views/ProductHubView.jsx";
import { expectHeldWriteFocus } from "./helpers/busyWriteFocus.js";
import { siblingIdentityIn } from "../scripts/lib/sibling-deny-list.mjs";

// REQ-UG-ALT-PORT-MEMBER-PAGES-20261030 (E2): under the alternate
// shell My chapter and Pay tools draw the prototype's
// Chapters, Bargaining and Sources pages on the views' own live data and
// handlers; surfaces with no backend say so; alt=false is the classic page.

const ORG = "11111111-1111-4111-8111-111111111111";
const DAY = 86_400_000;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString();
const wrap = (node, lang = "en") => render(<LanguageProvider lang={lang}>{node}</LanguageProvider>);
const h1s = () => document.querySelectorAll("h1");

beforeEach(() => {
  window.history.replaceState({}, "", "/m");
});
afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
});

describe("the record pages' strings", () => {
  it("declares every key in English and Spanish under the altRecordPages prefix", () => {
    const en = Object.keys(altRecordPagesCatalogue.en).sort();
    const es = Object.keys(altRecordPagesCatalogue.es).sort();
    expect(en).toEqual(es);
    expect(en.length).toBeGreaterThan(80);
    for (const key of en) {
      expect(key.startsWith("altRecordPages.")).toBe(true);
      expect(altRecordPagesCatalogue.en[key]).not.toBe("");
      expect(altRecordPagesCatalogue.es[key]).not.toBe("");
    }
    // Informal register, no invented people or affiliations.
    const spanish = Object.values(altRecordPagesCatalogue.es).join(" ");
    expect(spanish).not.toMatch(/\busted(es)?\b/i);
    expect(siblingIdentityIn(JSON.stringify(altRecordPagesCatalogue))).toEqual([]);
  });

  it("scopes every stylesheet rule under the alternate shell", () => {
    const css = readFileSync(resolve(process.cwd(), "src/alt/styles/pages-record.css"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const selectors = css.match(/[^{}]+(?=\{)/g).map((selector) => selector.trim()).filter((selector) => !selector.startsWith("@media"));
    expect(selectors.length).toBeGreaterThan(40);
    for (const selector of selectors) {
      for (const part of selector.replace(/\([^)]*\)/g, "()").split(",")) expect(part.trim().startsWith(".ugalt ")).toBe(true);
    }
  });
});

// ── Chapters (My chapter) ───────────────────────────────────────────────────

const issue = { id: "thread-issue", space_id: "space-1", title: "Overtime scheduling", kind: "issue", status: "open", posts: [{ id: "p1", body: "Shifts posted late again.", created_at: iso(-2) }] };
const topic = { id: "thread-topic", space_id: "space-1", title: "Picnic planning", kind: "topic", status: "open", posts: [{ id: "p2", body: "Bring chairs.", created_at: iso(-1) }, { id: "p3", body: "Noted.", created_at: iso(-1) }] };
const settled = { id: "thread-done", space_id: "space-1", title: "Break room fix", kind: "issue", status: "resolved", posts: [], created_at: iso(-40) };
const task = { id: "thread-task", space_id: "space-1", title: "Phone tree", kind: "task", status: "closed", posts: [] };

const hubProduct = {
  spaces: [{ id: "space-1", name: "Workplace issues", description: "", visibility: "campaign", threads: [issue, topic, settled, task] }],
  documents: [
    { id: "doc-contract", title: "Master agreement", document_type: "contract", summary: "The current contract.", body: "Article 1.", version: 2 },
    { id: "doc-minutes", title: "May minutes", document_type: "minutes", summary: "", body: "Minutes.", version: 1 },
  ],
  records: [
    { id: "rec-1", title: "Vote to file", record_type: "decision", occurred_at: iso(-10) },
    { id: "rec-2", title: "June minutes", record_type: "minutes", occurred_at: iso(-30) },
    { id: "rec-old", title: "Old milestone", record_type: "milestone", occurred_at: iso(-200) },
  ],
  intake: [],
  handshakes: [],
  governance: [],
  partnerOrgs: [],
};

const memberships = [
  { id: "ch-1", name: "Riverside Campaign", abbreviation: "RC" },
  { id: "ch-2", name: "Harbor Campaign", abbreviation: "HC" },
];

const hubData = {
  member: {
    id: "user-1",
    organizationId: ORG,
    chapterId: "ch-1",
    chapterName: "Riverside Campaign",
    sinceYear: 2019,
    chapterMemberships: [{ chapterId: "ch-1", name: "Riverside Campaign" }, { chapterId: "ch-2", name: "Harbor Campaign" }],
  },
  roles: ["committee worker"],
  events: [
    { id: "ev-1", title: "General meeting", startsAt: iso(3), eventKind: "meeting" },
    { id: "ev-2", title: "Rally", startsAt: iso(4), eventKind: "action" },
    { id: "ev-3", title: "Cancelled meeting", startsAt: iso(5), eventKind: "meeting", cancelledAt: iso(-1) },
    { id: "ev-4", title: "Past meeting", startsAt: iso(-3), eventKind: "meeting", isPast: true },
  ],
  chapterStewards: [
    { id: "s-1", name: "Dana Ruiz", roleLabel: "committee worker" },
    { id: "s-2", name: null, roleLabel: "advisor" },
  ],
  conversations: [],
  broadcasts: [],
  product: hubProduct,
};

function hub(props = {}, lang = "en") {
  const handlers = { onOpenHome: vi.fn(), onSelect: vi.fn(), onAssistant: vi.fn(), onCreateSpace: vi.fn(), onSendPost: vi.fn(), onCreateThread: vi.fn(), ...props };
  wrap(<ProductHubView
    alt
    data={hubData}
    onOpenHome={handlers.onOpenHome}
    onAssistant={handlers.onAssistant}
    onCreateSpace={handlers.onCreateSpace}
    onCreateThread={handlers.onCreateThread}
    onSendPost={handlers.onSendPost}
    chapterSwitch={<ChapterMembershipSwitch chapters={memberships} selectedId="ch-1" onSelect={handlers.onSelect} />}
    {...props}
  />, lang);
  return handlers;
}

describe("the alternate shell's My campaign (prototype Campaigns)", () => {
  // A chapter card keeps keyboard focus while the switch it
  // started runs (App passes the switch's busy state), and refuses a press.
  it("keeps the pressed campaign card focused and pending while the campaign switch runs", async () => {
    const onSelect = vi.fn(async () => undefined);
    function Host() {
      const [busy, setBusy] = useState(false);
      const select = async (row) => {
        setBusy(true);
        try { await onSelect(row); } finally { setBusy(false); }
      };
      return <ProductHubView alt data={hubData} onOpenHome={vi.fn()} onAssistant={vi.fn()} onCreateSpace={vi.fn()} onCreateThread={vi.fn()} onSendPost={vi.fn()}
        chapterSwitch={<ChapterMembershipSwitch chapters={memberships} selectedId="ch-1" onSelect={select} busy={busy} />} />;
    }
    wrap(<Host />);
    const directory = screen.getByRole("region", { name: "Your campaigns" });
    const harbor = within(directory).getByRole("button", { name: "Open Harbor Campaign" });
    await expectHeldWriteFocus(onSelect, harbor, () => {
      fireEvent.click(harbor);
      const riverside = within(directory).getByRole("button", { name: "Open Riverside Campaign" });
      expect(riverside).toBeEnabled();
      expect(riverside).toHaveAttribute("aria-disabled", "true");
    });
    expect(onSelect).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith(memberships[1]);
  });

  it("draws the campaign page hero, figures and the worker's campaigns from live data", () => {
    const { onOpenHome, onSelect, onAssistant } = hub();
    expect(h1s()).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1, name: "Riverside Campaign" })).toBeInTheDocument();
    expect(document.querySelector(".ug-page-hero .ug-av.ug-av-xl")).toHaveTextContent("RC");
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumbs).getByText("My campaign")).toHaveAttribute("aria-current", "page");
    fireEvent.click(within(crumbs).getByRole("link", { name: "Now" }));
    expect(onOpenHome).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /Ask Union Ground Guide/ }));
    expect(onAssistant).toHaveBeenCalledTimes(1);

    const figures = screen.getByRole("region", { name: "At a glance" });
    expect(within(figures).getByText("Your campaigns").closest(".ug-kpi")).toHaveTextContent("2");
    expect(within(figures).getByText("Worker since").closest(".ug-kpi")).toHaveTextContent("2019");

    const directory = screen.getByRole("region", { name: "Your campaigns" });
    const current = within(directory).getByRole("button", { name: "Open Riverside Campaign" });
    expect(current).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(directory).getByRole("button", { name: "Open Harbor Campaign" }));
    expect(onSelect).toHaveBeenCalledWith(memberships[1]);
    // No directory in the snapshot: the other-chapters card says it could
    // not be loaded rather than "none".
    const others = screen.getByRole("region", { name: "Other campaigns" });
    expect(within(others).getByText(/could not be loaded/)).toBeInTheDocument();
  });



  it("opens an issue thread in the hub's own thread dialog", () => {
    hub();
    fireEvent.click(screen.getByRole("heading", { name: "Issues on the floor" }).closest(".ug-panel").querySelector("button"));
    expect(screen.getByRole("dialog", { name: /Overtime scheduling/ })).toBeInTheDocument();
  });


  it("says when the worker is in no campaign", () => {
    wrap(<ProductHubView alt data={{ member: { id: "user-1" }, roles: [], product: {} }} />);
    expect(screen.getByRole("heading", { level: 1, name: "My campaign" })).toBeInTheDocument();
    expect(document.querySelector("h1 .ug-accent")).toHaveTextContent("campaign");
    expect(screen.getByText("No campaign yet")).toBeInTheDocument();
    expect(screen.getByText("Latest from your campaign")).toBeInTheDocument();
  });

  it("keeps the classic hub when alt is off", () => {
    wrap(<ProductHubView data={hubData} onCreateSpace={vi.fn()} />);
    expect(document.querySelector(".ug-page-hero")).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "My campaign" })).toHaveClass("hub2-ph__title");
    expect(document.querySelector(".screen.hub2 > .hub2-tabs")).not.toBeNull();
  });
});

// ── Bargaining (Pay tools) ──────────────────────────────────────────────────

const payMember = (extra = {}) => buildPayActor({ userId: "user-a", organizationId: ORG, membershipStatus: "active", ...extra });
const payCatalog = () => createMemoryPayCatalog([
  { kind: "grade", organizationId: ORG, grade: "A", title: "Grade A", stepCount: 2 },
  { kind: "grade", organizationId: ORG, grade: "B", title: "Grade B", stepCount: 1 },
  { kind: "step", organizationId: ORG, grade: "A", effectiveOn: "2026-01-04", stepNumber: 1, hourlyRateCents: 3000 },
  { kind: "step", organizationId: ORG, grade: "A", effectiveOn: "2026-08-25", stepNumber: 2, hourlyRateCents: 3200 },
  { kind: "step", organizationId: ORG, grade: "B", effectiveOn: "2026-03-01", stepNumber: 1, hourlyRateCents: 3500 },
]);

describe("the alternate shell's Pay tools (prototype Bargaining)", () => {
  it("draws the prototype's hero and figures from the published pay scale", async () => {
    const onOpenHome = vi.fn();
    wrap(<PayToolsView alt onOpenHome={onOpenHome} actor={payMember()} api={{ loadCatalog: async () => ({ ok: true, catalog: payCatalog() }) }} />);
    expect(h1s()).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Your pay and the table");
    expect(document.querySelector("h1 .ug-accent")).toHaveTextContent("table");
    expect(screen.getByText("No session posted")).toHaveClass("ug-eyebrow-pill");
    fireEvent.click(screen.getByRole("link", { name: "Now" }));
    expect(onOpenHome).toHaveBeenCalledTimes(1);
    const figures = screen.getByRole("region", { name: "At a glance" });
    await waitFor(() => expect(within(figures).getByText("Pay grades").closest(".ug-kpi")).toHaveTextContent("2"));
    expect(within(figures).getByText("Step rates").closest(".ug-kpi")).toHaveTextContent("3");
    expect(within(figures).getByText("Newest rate").closest(".ug-kpi")).toHaveTextContent("August 25, 2026");
    expect(within(figures).getByText("Proposals").closest(".ug-kpi")).toHaveTextContent("—");
  });


  it("keeps the live table's surfaces with honest empty states", () => {
    wrap(<PayToolsView alt actor={payMember()} />);
    expect(screen.getByRole("heading", { name: "Proposals" })).toBeInTheDocument();
    expect(screen.getByText("No proposals posted")).toBeInTheDocument();
    expect(screen.getByText("No sessions posted")).toBeInTheDocument();
    expect(screen.getByText("No session notes have been posted here.").closest(".ug-script")).not.toBeNull();
    expect(screen.getByText(/you cast it on the Votes page/)).toBeInTheDocument();
  });

  it("shows a dash while the scale cannot be read, and the leaders' tab to leaders, in Spanish", async () => {
    wrap(<PayToolsView alt actor={payMember({ roles: ["admin"], selectedHat: "admin" })} api={{ loadCatalog: async () => ({ ok: false }) }} />, "es");
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Tu salario y la mesa");
    const figures = screen.getByRole("region", { name: "De un vistazo" });
    await waitFor(() => expect(within(figures).getByText("Grados salariales").closest(".ug-kpi")).toHaveTextContent("—"));
    expect(screen.getByText("No hay propuestas publicadas")).toBeInTheDocument();
    // This edition has no Contract or Bargaining tab (src/views/PayToolsView.jsx),
    // so a leader sees the same three tools as everyone.
    expect(screen.getByRole("group", { name: "Herramientas de pago" }).querySelectorAll("button")).toHaveLength(3);
  });

  it("keeps the classic page when alt is off", () => {
    wrap(<PayToolsView actor={payMember()} />);
    expect(document.querySelector(".ug-page-hero")).toBeNull();
    expect(screen.getByRole("heading", { level: 1, name: "Pay tools" })).toHaveClass("phead__title");
    expect(screen.getByRole("group", { name: "Pay tools" })).toHaveClass("mwl-tabs");
  });
});

// The Sources page (Contract clauses) is left out of Union Ground.
