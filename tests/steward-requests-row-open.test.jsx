// BUG-UG-WEB-STEWARD-REQUEST-ROW-DOES-NOT-OPEN-20261002 (the owner's
// September example 4: "Why can't I just click on name to see more info").
// A member request row was a <div> with the name in a plain span, so clicking
// the row or the name did nothing while the form and message rows beside it
// opened. The name is now the row's one opener: a native button whose hit area
// covers the row and opens the request detail. Acknowledge and Close stay
// sibling buttons with their own handlers; nothing interactive is nested
// inside another control.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { chromium } from "@playwright/test";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { StewardView } from "../src/views/StewardView.jsx";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";

const queue = [
  { id: "req-1", userId: "member-renata", memberName: "Renata Cole", memberInitials: "RC", lessonLabel: "Weingarten", status: "requested", createdAt: "2026-07-20T14:00:00Z" },
  { id: "req-2", userId: "member-devon", memberName: "Devon Pratt", memberInitials: "DP", lessonLabel: "", status: "acknowledged", createdAt: "2026-07-18T14:00:00Z" },
];
const caseload = [{
  id: "case-1", subjectUserId: "member-renata", memberName: "Renata Cole", memberInitials: "RC", reference: "GRV-2026-014",
  title: "Mandated overtime without notice", caseType: "Grievance", articles: "", step: "Step 2", status: "active",
  deadline: null, updatedAt: "2026-08-05T12:00:00Z", assignedAt: null, coordinatorName: null, updates: [], updatesTotal: 0,
}];
const desk = {
  caseload, caseloadUnavailable: false, caseloadTruncated: false, caseUpdatesUnavailable: false,
  queue, threads: [], broadcasts: [], formsInbox: [], formTemplateVersions: [],
  kpis: { openRequests: 2, membersCovered: 12, awaitingReply: 0, broadcasts30d: 0 },
};

function makeApi() {
  return {
    loadDesk: vi.fn().mockResolvedValue(JSON.parse(JSON.stringify(desk))),
    triage: vi.fn().mockResolvedValue({}), reply: vi.fn(), publish: vi.fn(), retract: vi.fn(),
    startFormReview: vi.fn(), approveForm: vi.fn(), returnForm: vi.fn(), approveAndOpenCase: vi.fn(), scan: vi.fn(),
  };
}

function renderDesk(api = makeApi(), lang = "en", props = {}) {
  const view = render(<LanguageProvider lang={lang}><StewardView data={{ member: { id: "steward-1", initials: "SO" } }} api={api} onNotice={() => {}} {...props} /></LanguageProvider>);
  return { api, view };
}

// The requests panel mounts once the desk read settles.
async function requests() {
  return within(await waitFor(() => {
    const section = document.getElementById("steward-requests");
    if (!section) throw new Error("requests panel not mounted yet");
    return section;
  }));
}


// Closing a request opens a confirmation first (Lovable audit APP-STEWARD-14).
async function confirmClose() {
  const dialog = await screen.findByTestId("confirm-action");
  fireEvent.click(within(dialog).getByRole("button", { name: "Close request" }));
}
describe("steward request rows open the request", () => {
  it("cancels closing a request without changing its status or removing its row", async () => {
    const { api } = renderDesk();
    const row = (await (await requests()).findByRole("button", { name: "Devon Pratt" })).closest(".cwk-request");
    fireEvent.click(within(row).getByRole("button", { name: "Close" }));
    const confirmation = await screen.findByTestId("confirm-action");
    fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByTestId("confirm-action")).not.toBeInTheDocument());
    expect(api.triage).not.toHaveBeenCalled();
    expect((await requests()).getByRole("button", { name: "Devon Pratt" })).toBeInTheDocument();
  });

  it("makes the member's name the row's button, with no control nested inside another", async () => {
    renderDesk();
    const opener = await (await requests()).findByRole("button", { name: "Renata Cole" });
    expect(opener.tagName).toBe("BUTTON");
    expect(opener).toHaveAttribute("type", "button");
    expect(opener).toHaveAttribute("aria-haspopup", "dialog");
    expect(opener.querySelector("button, a, input, select, textarea")).toBeNull();
    expect(opener.parentElement.closest("button, a")).toBeNull();
    const row = opener.closest(".cwk-request");
    const acknowledge = within(row).getByRole("button", { name: "Acknowledge" });
    expect(opener.contains(acknowledge)).toBe(false);
    expect(acknowledge.parentElement.closest("button, a")).toBeNull();
  });

  it("opens the detail with the member and request fields, and Escape returns focus to the name", async () => {
    renderDesk();
    const opener = await (await requests()).findByRole("button", { name: "Renata Cole" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = await screen.findByRole("dialog", { name: "Renata Cole" });
    expect(dialog).toHaveClass("app-dialog--detail");
    expect(within(dialog).getByText("Worker request")).toBeInTheDocument();
    const facts = Object.fromEntries([...dialog.querySelectorAll(".detail-facts dt")].map((term) => [term.textContent, term.nextElementSibling.textContent]));
    expect(facts).toEqual({
      Worker: "Renata Cole",
      Topic: "Weingarten",
      Status: "Requested",
      "Requested on": new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date("2026-07-20T14:00:00Z")),
    });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(document.querySelector(".app-dialog")).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("keeps Acknowledge and Close on the row working without opening the detail", async () => {
    const { api } = renderDesk();
    const row = (await (await requests()).findByRole("button", { name: "Renata Cole" })).closest(".cwk-request");
    fireEvent.click(within(row).getByRole("button", { name: "Acknowledge" }));
    await waitFor(() => expect(api.triage).toHaveBeenCalledWith("req-1", "acknowledge"));
    fireEvent.click(within(row).getByRole("button", { name: "Close" }));
    expect(api.triage).not.toHaveBeenCalledWith("req-1", "close");
    await confirmClose();
    await waitFor(() => expect(api.triage).toHaveBeenCalledWith("req-1", "close"));
    await waitFor(() => expect(document.querySelector(".app-dialog")).toBeNull());
  });

  it("offers the same triage in the detail and the member's open case", async () => {
    const { api } = renderDesk();
    fireEvent.click(await (await requests()).findByRole("button", { name: "Renata Cole" }));
    const dialog = await screen.findByRole("dialog", { name: "Renata Cole" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Acknowledge" }));
    await waitFor(() => expect(api.triage).toHaveBeenCalledWith("req-1", "acknowledge"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Open issue GRV-2026-014" }));
    expect(await screen.findByRole("dialog", { name: "GRV-2026-014 — Mandated overtime without notice" })).toBeInTheDocument();
  });

  it("shows a dash for a request with no lesson, only the triage its status allows, and no case link without a case", async () => {
    renderDesk();
    fireEvent.click(await (await requests()).findByRole("button", { name: "Devon Pratt" }));
    const dialog = await screen.findByRole("dialog", { name: "Devon Pratt" });
    expect(within(dialog).getByText("Topic").nextElementSibling).toHaveTextContent("—");
    expect(within(dialog).queryByRole("button", { name: "Acknowledge" })).toBeNull();
    // Named for the request: the dialog's own close button is "Close".
    expect(within(dialog).getByRole("button", { name: "Close request" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /^Open issue/ })).toBeNull();
  });

  it("dismisses a successfully closed request when the Open filter excludes it on reload", async () => {
    let serverRow = { ...queue[0] };
    const api = makeApi();
    const onNotice = vi.fn();
    api.loadDesk.mockImplementation(async () => ({ ...desk, queue: [{ ...serverRow }] }));
    api.loadRequests = vi.fn(async ({ status }) => {
      const rows = status === "open" && serverRow.status === "closed" ? [] : [{ ...serverRow }];
      return { rows, total: rows.length, nextCursor: null };
    });
    api.triage.mockImplementation(async (id, action) => {
      serverRow = { ...serverRow, status: action === "close" ? "closed" : "acknowledged" };
      return { id, status: serverRow.status };
    });
    renderDesk(api, "en", { onNotice });
    const panel = await requests();
    fireEvent.click(panel.getByRole("button", { name: "Open", exact: true }));
    await waitFor(() => expect(api.loadRequests).toHaveBeenCalledWith(expect.objectContaining({ status: "open" })));
    fireEvent.click(await panel.findByRole("button", { name: "Renata Cole" }));
    const dialog = await screen.findByRole("dialog", { name: "Renata Cole" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Acknowledge" }));
    await waitFor(() => expect(within(dialog).getByText("Status").nextElementSibling).toHaveTextContent("Acknowledged"));
    expect(within(dialog).queryByRole("button", { name: "Acknowledge" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close request" }));
    await confirmClose();
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Request closed"));
    await waitFor(() => expect(panel.queryByRole("button", { name: "Renata Cole" })).toBeNull());
    expect(screen.queryByRole("dialog", { name: "Renata Cole" })).toBeNull();
    expect(api.triage.mock.calls).toEqual([["req-1", "acknowledge"], ["req-1", "close"]]);
  });

  it("keeps the request detail and its state when closing is refused", async () => {
    const api = makeApi();
    const onNotice = vi.fn();
    api.triage.mockRejectedValue(new Error("Request close refused"));
    renderDesk(api, "en", { onNotice });
    fireEvent.click(await (await requests()).findByRole("button", { name: "Renata Cole" }));
    const dialog = await screen.findByRole("dialog", { name: "Renata Cole" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close request" }));
    await confirmClose();
    await waitFor(() => expect(onNotice).toHaveBeenCalledWith("Request close refused"));
    expect(screen.getByRole("dialog", { name: "Renata Cole" })).toBe(dialog);
    expect(within(dialog).getByText("Status").nextElementSibling).toHaveTextContent("Requested");
    expect(within(dialog).getByRole("button", { name: "Acknowledge" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "Close request" })).toBeEnabled();
    expect(api.loadDesk).toHaveBeenCalledTimes(1);
  });

  it("labels the detail in Spanish", async () => {
    renderDesk(makeApi(), "es");
    fireEvent.click(await (await requests()).findByRole("button", { name: "Renata Cole" }));
    const dialog = await screen.findByRole("dialog", { name: "Renata Cole" });
    expect(within(dialog).getByText("Solicitud de trabajador")).toBeInTheDocument();
    expect([...dialog.querySelectorAll(".detail-facts dt")].map((term) => term.textContent)).toEqual(["Trabajador", "Tema", "Estado", "Fecha de solicitud"]);
  });
});

// Hit testing and keyboard activation in Chromium with the shipped styles: a
// point on the row's empty width lands on the name's button, a point on
// Acknowledge lands on Acknowledge, Enter and Space on the focused name click
// it, and the row stays a 48px-plus target at 390 and 1440 CSS px.
describe("request row in a browser", () => {
  let browser;
  beforeAll(async () => { browser = await chromium.launch({ headless: true }); }, BROWSER_HOOK_TIMEOUT);
  afterAll(async () => { await browser?.close(); });
  const read = (path) => readFile(resolve("src", path), "utf8");

  it.each([1440, 390, 320].flatMap((width) => [false, true].map((componentFirst) => [width, componentFirst])))("routes clicks and keys to the right control at %i px (component CSS first: %s)", async (width, componentFirst) => {
    const sheets = componentFirst ? ["sg-tokens.css", "views/stewardRequests.css", "styles.css"] : ["sg-tokens.css", "styles.css", "views/stewardRequests.css"];
    const css = (await Promise.all(sheets.map(read))).join("\n");
    const { view } = renderDesk();
    await (await requests()).findByRole("button", { name: "Renata Cole" });
    const markup = document.getElementById("steward-requests").outerHTML;
    view.unmount();
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    try {
      await page.route("**/*", (route) => route.abort());
      await page.setContent(`<div class="sg-app" style="width:${width}px">${markup}</div>`);
      await page.addStyleTag({ content: css });
      const result = await page.evaluate(() => {
        const row = document.querySelector(".cwk-request");
        const opener = row.querySelector(".cwk-request__open");
        const acknowledge = [...row.querySelectorAll("button")].find((button) => button.textContent === "Acknowledge");
        const close = [...row.querySelectorAll("button")].find((button) => button.textContent === "Close");
        const rowBox = row.getBoundingClientRect();
        const ackBox = acknowledge.getBoundingClientRect();
        const closeBox = close.getBoundingClientRect();
        const chipBox = row.querySelector(".cwk-chip").getBoundingClientRect();
        const actionsBox = row.querySelector(".cwk-actions").getBoundingClientRect();
        const at = (x, y) => document.elementFromPoint(x, y)?.closest("button");
        return {
          rowHeight: rowBox.height,
          rowWidth: rowBox.width,
          viewport: document.documentElement.clientWidth,
          emptyWidth: at(rowBox.right - 12, rowBox.top + rowBox.height / 2) === opener,
          avatar: at(rowBox.left + 30, rowBox.top + 30) === opener,
          ack: at(ackBox.left + ackBox.width / 2, ackBox.top + ackBox.height / 2) === acknowledge,
          close: at(closeBox.left + closeBox.width / 2, closeBox.top + closeBox.height / 2) === close,
          chip: at(chipBox.left + chipBox.width / 2, chipBox.top + chipBox.height / 2) === opener,
          blankActions: at(actionsBox.right - 4, actionsBox.top + actionsBox.height / 2) === opener,
          rowTargets: [
            { x: chipBox.left + chipBox.width / 2, y: chipBox.top + chipBox.height / 2 },
            { x: actionsBox.right - 4, y: actionsBox.top + actionsBox.height / 2 },
          ],
          actionTargets: [
            { x: ackBox.left + ackBox.width / 2, y: ackBox.top + ackBox.height / 2 },
            { x: closeBox.left + closeBox.width / 2, y: closeBox.top + closeBox.height / 2 },
          ],
        };
      });
      expect(result.rowHeight).toBeGreaterThanOrEqual(48);
      expect(result.rowWidth).toBeLessThanOrEqual(result.viewport);
      expect(result.emptyWidth).toBe(true);
      expect(result.avatar).toBe(true);
      expect(result.ack).toBe(true);
      expect(result.close).toBe(true);
      expect(result.chip).toBe(true);
      expect(result.blankActions).toBe(true);
      await page.evaluate(() => {
        window.openerClicks = 0;
        window.actionClicks = 0;
        document.querySelector(".cwk-request__open").addEventListener("click", () => { window.openerClicks += 1; });
        for (const button of document.querySelectorAll(".cwk-request .cwk-actions button")) {
          button.addEventListener("click", () => { window.actionClicks += 1; });
        }
      });
      for (const { x, y } of result.rowTargets) await page.mouse.click(x, y);
      expect(await page.evaluate(() => window.openerClicks)).toBe(2);
      for (const { x, y } of result.actionTargets) await page.mouse.click(x, y);
      expect(await page.evaluate(() => window.openerClicks)).toBe(2);
      expect(await page.evaluate(() => window.actionClicks)).toBe(2);
      await page.focus(".cwk-request__open");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Space");
      expect(await page.evaluate(() => window.openerClicks)).toBe(4);
    } finally { await page.close(); }
  });
});
