// BUG-UG-WEB-STEWARD-CASE-DETAIL-CRAMPED-DIALOG-20261002 (the owner's
// September example 3: "Why does clicking on a case open such a small window,
// with small text"). A steward case, a form review and a private conversation
// all opened in the shared 620x760 "wide" box, the case facts sat in a chat
// bubble at 12px with bare <small> labels at about 10px, and the case
// tools stacked under them in the same small box. They now open in the
// Dialog's detail size: a page-sized surface over the content column on
// desktop and a full-height sheet on a phone, with the facts as a label/value
// list and nothing under the 13px base token. The modal contract (focus on
// open, Tab kept inside, Escape closes, focus back on the opener) is unchanged.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { chromium } from "@playwright/test";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { StewardView } from "../src/views/StewardView.jsx";

const read = (path) => readFile(resolve("src", path), "utf8");
const dialogCss = await read("components/Dialog.css");
const tokensCss = await read("sg-tokens.css");
const pageCss = (await Promise.all(["sg-tokens.css", "styles.css", "motion.css", "components/Dialog.css", "components/CaseHistoryTimeline.css", "components/SourceTaskAction.css"].map(read))).join("\n");

const caseRow = {
  id: "case-1", subjectUserId: "member-renata", memberName: "Renata Cole", memberInitials: "RC", reference: "GRV-2026-014",
  title: "Mandated overtime without notice", caseType: "Grievance", articles: "Art. 21 §3",
  step: "Step 2", status: "active", deadline: "2026-08-15", updatedAt: "2026-08-05T12:00:00Z",
  assignedAt: "2026-08-01T09:00:00Z", coordinatorName: "Dana Ortiz",
  review: { reviewerName: "Taylor Morgan", reviewedAt: "2026-08-06T15:00:00Z" },
  updates: [{ id: "u-1", body: "HR acknowledged the filing.", createdAt: "2026-08-04T10:00:00Z" }],
  updatesTotal: 1,
};

const desk = {
  caseload: [caseRow],
  caseloadUnavailable: false,
  caseloadTruncated: false,
  caseUpdatesUnavailable: false,
  queue: [],
  threads: [{
    id: "conv-1", memberName: "Renata Cole", memberInitials: "RC", preview: "They mandated me again last night.",
    updatedAt: "2026-07-21T09:00:00Z", awaitingReply: true,
    messages: [{ id: "m-1", sender_kind: "member", sender_name: "Renata Cole", body: "They mandated me again last night.", created_at: "2026-07-21T09:00:00Z" }],
  }],
  broadcasts: [],
  formsInbox: [{
    id: "form-1", userId: "member-jordan", memberInitials: "JM", memberName: "Jordan Mills", templateKey: "grievance", status: "submitted", submittedAt: "2026-07-21T16:40:00Z",
    answers: { summary: "Mandated overtime without the 48-hour notice", incident_date: "2026-07-18" },
  }],
  formTemplateVersions: [],
  kpis: { openRequests: 0, membersCovered: 12, awaitingReply: 1, broadcasts30d: 0 },
};

// The case tools render inside the case record too, so the type floor is
// measured with them on screen.
const caseworkCase = {
  scope: { id: "case-1", organization_id: "org-1", chapter_id: "ch-1", step: "Step 2", status: "active", is_restricted: false },
  strength: [{ id: "score-1", score: 72, band: "strong", created_at: "2026-08-28T12:00:00Z" }],
  deadlines: [{ id: "deadline-1", label: "File response", due_at: "2026-09-01T12:00:00Z", status: "open", extensions: [] }],
  checklists: [{ id: "list-1", title: "Filing checklist", step: "Step 2", items: [{ id: "item-1", label: "Confirm deadline", required: true, completed_at: null }] }],
  transitions: [],
  alerts: [{ id: "alert-1", severity: "critical", status: "open", message: "Filing deadline approaching" }],
  management: [],
  retaliation: [],
  links: [],
  reminders: [{ id: "reminder-1", title: "Call member", remind_at: "2026-09-01T12:00:00Z", recurrence: "weekly", status: "active" }],
  accessGrants: [],
};

function makeApi(overrides = {}) {
  return {
    loadDesk: vi.fn().mockResolvedValue(JSON.parse(JSON.stringify(desk))),
    triage: vi.fn(), reply: vi.fn(), publish: vi.fn(), retract: vi.fn(),
    startFormReview: vi.fn(), approveForm: vi.fn(), returnForm: vi.fn(), approveAndOpenCase: vi.fn(), scan: vi.fn(),
    ...overrides,
  };
}

function renderDesk(api = makeApi(), props = {}) {
  return render(<StewardView data={{ member: { id: "steward-1", initials: "SO" } }} api={api} onNotice={() => {}} {...props} />);
}

async function openCase() {
  const trigger = await screen.findByRole("button", { name: /GRV-2026-014/ });
  // A real click focuses the button before the dialog captures its opener.
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "GRV-2026-014 — Mandated overtime without notice" });
  return { trigger, dialog };
}

describe("steward detail records open full size", () => {
  it("opens a case from the caseload as the detail record, not the 620px wide box", async () => {
    renderDesk();
    const { dialog } = await openCase();
    expect(dialog).toHaveClass("app-dialog--detail");
    expect(dialog).not.toHaveClass("app-dialog--wide");
    expect(dialog.closest(".dialog-backdrop")).toHaveClass("dialog-backdrop--detail");
    // Facts are a label/value list, not paragraphs inside a chat bubble.
    expect(dialog.querySelector(".thread-message")).toBeNull();
    const facts = within(dialog).getByText("Type").closest("dl");
    expect(facts).toHaveClass("detail-facts");
    for (const [label, value] of [["Type", "Grievance"], ["Campaign lead", "Dana Ortiz"]]) {
      const term = within(facts).getByText(label);
      expect(term.tagName).toBe("DT");
      expect(term.nextElementSibling.tagName).toBe("DD");
      expect(term.nextElementSibling).toHaveTextContent(value);
    }
    // Union Ground issues have no grievance step and no contract articles:
    // neither is a fact, even when the row still carries them.
    const terms = [...facts.querySelectorAll("dt")].map((term) => term.textContent);
    expect(terms).not.toContain("Step");
    expect(terms).not.toContain("Articles");
    expect(within(dialog).queryByText("Step 2")).toBeNull();
    expect(within(dialog).queryByText("Art. 21 §3")).toBeNull();
    expect(within(dialog).getByRole("heading", { level: 3, name: "Issue updates" })).toBeInTheDocument();
    expect(within(dialog).getByText("HR acknowledged the filing.")).toBeInTheDocument();
  });

  it("opens a form review and a private conversation in the same detail size", async () => {
    renderDesk();
    fireEvent.click(await screen.findByRole("button", { name: /Jordan Mills/ }));
    const review = await screen.findByRole("dialog", { name: /Jordan Mills/ });
    expect(review).toHaveClass("app-dialog--detail");
    expect(review).not.toHaveClass("app-dialog--wide");
    expect(within(review).getAllByRole("definition").length).toBeGreaterThan(0);
    fireEvent.keyDown(review, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(".app-dialog")).toBeNull());

    fireEvent.click(within(document.getElementById("steward-messages")).getByRole("button", { name: /Renata Cole/ }));
    const thread = await screen.findByRole("dialog", { name: "Renata Cole" });
    expect(thread).toHaveClass("app-dialog--detail");
    expect(thread).not.toHaveClass("app-dialog--wide");
  });

  it("keeps the modal contract: close-button focus, Tab stays inside, Escape closes and returns focus", async () => {
    renderDesk();
    const { trigger, dialog } = await openCase();
    // The prototype modal opens on its close button.
    const close = within(dialog).getByRole("button", { name: "Close" });
    await waitFor(() => expect(close).toHaveFocus());
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    const focusables = [...dialog.querySelectorAll("button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled])")];
    expect(focusables.at(-1)).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(".app-dialog")).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});

// The stylesheet half of the contract: the detail size is full height on a
// phone and wider than the old 620px box from 720px up, and every type size
// the sheet declares is a token of 13px or more.
describe("detail dialog stylesheet contract", () => {
  const flat = dialogCss.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
  const tokenPx = (name) => Number(tokensCss.match(new RegExp(`--sg-font-size-${name}: ([\\d.]+)px`))[1]);

  it("fills the phone height and opens wider than 620px on desktop", () => {
    expect(flat).toMatch(/\.app-dialog\.app-dialog--detail \{[^}]*height: 100%;[^}]*max-height: none;/);
    const desktop = flat.slice(flat.indexOf("@media (min-width: 720px)"));
    const width = desktop.match(/\.app-dialog\.app-dialog--detail \{[^}]*width: min\(100%, (\d+)px\)/);
    expect(Number(width[1])).toBeGreaterThan(620);
    expect(desktop).toMatch(/\.dialog-backdrop\.dialog-backdrop--detail \{[^}]*align-items: stretch;/);
    // Only the desktop shell offsets the record past its rails; a tablet keeps the full width.
    expect(flat).toMatch(/\.sg-app--desktop \.dialog-backdrop\.dialog-backdrop--detail \{ padding-left: calc\(var\(--shell-rail-width, 0px\) \+ 28px\); \}/);
  });

  it("declares every font size as a 13px-or-larger token", () => {
    const sizes = [...flat.matchAll(/font-size: ([^;}]+)/g)].map((match) => match[1].trim());
    expect(sizes.length).toBeGreaterThan(5);
    for (const size of sizes) {
      const token = size.match(/^var\(--sg-font-size-([a-z]+)\)$/);
      expect(token, size).not.toBeNull();
      expect(tokenPx(token[1]), size).toBeGreaterThanOrEqual(13);
    }
    // The small-text rules these records reuse from styles.css each get a
    // detail-scoped floor.
    const floor = flat.match(/\.app-dialog--detail :is\(([^)]*)\) \{ font-size: var\(--sg-font-size-base\); \}/)[1];
    for (const selector of ["small", "time", ".thread-message strong", ".stack-form label", ".cwk-btn", ".inbox-msg-actions button", ".form-filing__hint"]) {
      expect(floor.split(", ")).toContain(selector);
    }
  });
});

// Measured in Chromium with the shipped stylesheets: the surface size at 1440
// and 390 CSS px, and no visible text under 13px with the case tools open.
describe("detail record in a browser", () => {
  let browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, BROWSER_HOOK_TIMEOUT);
  afterAll(async () => { await browser?.close(); });

  async function measure(markup, width, desktop, theme = "union-ground") {
    const height = width === 390 ? 844 : width === 768 ? 1024 : 900;
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce", colorScheme: "light" });
    try {
      await page.route("**/*", (route) => route.abort());
      await page.setContent(`<div class="sg-app${desktop ? " sg-app--desktop" : ""}" data-workspace-theme="${theme}">${markup}</div>`);
      await page.addStyleTag({ content: pageCss });
      return await page.evaluate(() => {
        const surface = document.querySelector(".app-dialog--detail");
        const box = surface.getBoundingClientRect();
        const small = [];
        const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (!node.textContent.trim() || !node.parentElement.getClientRects().length) continue;
          const size = parseFloat(getComputedStyle(node.parentElement).fontSize);
          if (size < 13) small.push(`${size}px ${node.parentElement.tagName.toLowerCase()}.${node.parentElement.className} "${node.textContent.trim().slice(0, 30)}"`);
        }
        return { width: box.width, height: box.height, small };
      });
    } finally { await page.close(); }
  }

  it.each([[1440, true], [768, false], [390, false]])("sizes the case record at %i px with no text under 13px", async (width, desktop) => {
    const api = makeApi({ loadCaseworkCase: vi.fn().mockResolvedValue(caseworkCase), scoreCase: vi.fn(), createCaseDeadline: vi.fn(), createCaseAlert: vi.fn(), createCaseReminder: vi.fn(), setChecklistItem: vi.fn() });
    const view = renderDesk(api);
    const { dialog } = await openCase();
    await within(dialog).findByText("File response");
    // Stage checklists are gone with the grievance procedure; the stored row
    // in the payload never renders.
    expect(within(dialog).queryByText("Filing checklist")).toBeNull();
    await waitFor(() => expect(dialog.closest(".dialog-backdrop").dataset.state).toBe("open"));
    const result = await measure(view.container.innerHTML, width, desktop);
    if (width >= 720) {
      expect(result.width).toBeGreaterThan(620);
      expect(result.height).toBeGreaterThan(760);
    } else {
      expect(result.width).toBe(390);
      expect(result.height).toBeGreaterThanOrEqual(844 - 12 - 1);
    }
    expect(result.small).toEqual([]);
    view.unmount();
  });

  it.each(["union-ground"].flatMap((theme) => ["created", "denied", "error"].map((outcome) => [outcome, theme])))("keeps private-thread task %s outcomes at 13px or more in %s", async (outcome, theme) => {
    const onCreateTaskFromSource = vi.fn();
    if (outcome === "created") onCreateTaskFromSource.mockResolvedValue({ task: { id: "task-1" }, created: true });
    else onCreateTaskFromSource.mockRejectedValue(Object.assign(new Error("Task creation failed"), outcome === "denied" ? { code: "42501" } : {}));
    const view = renderDesk(makeApi(), { onCreateTaskFromSource });
    await waitFor(() => expect(document.getElementById("steward-messages")).not.toBeNull());
    fireEvent.click(within(document.getElementById("steward-messages")).getByRole("button", { name: /Renata Cole/ }));
    const dialog = await screen.findByRole("dialog", { name: "Renata Cole" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create task", exact: true }));
    const message = outcome === "created" ? "Task created" : outcome === "denied" ? "You no longer have access to create tasks from this source." : "This source could not be converted";
    expect(await within(dialog).findByRole(outcome === "created" ? "status" : "alert")).toHaveTextContent(message);
    expect(onCreateTaskFromSource).toHaveBeenCalledWith("message", "m-1");
    await waitFor(() => expect(dialog.closest(".dialog-backdrop").dataset.state).toBe("open"));
    expect((await measure(view.container.innerHTML, 1440, true, theme)).small).toEqual([]);
    view.unmount();
  });
});
