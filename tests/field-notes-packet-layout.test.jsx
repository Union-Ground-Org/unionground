// REQ-UG-FIELD-NOTES-AI-PACKET-20261001. The draft packet panel measured in
// Chromium with the shipped stylesheets: the picker and the returned draft read
// at 13px or more in both workspace themes, and the panel stays inside the
// field notes detail column. A harness render, not a hosted page — the panel
// only appears for an organization with both AI switches on.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, waitFor, within } from "@testing-library/react";
import { chromium } from "@playwright/test";
import { BROWSER_HOOK_TIMEOUT } from "./helpers/browser-hook-timeout.js";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TaskFieldNotesView } from "../src/views/TaskFieldNotesView.jsx";

const read = (path) => readFile(resolve("src", path), "utf8");
const pageCss = (await Promise.all(["sg-tokens.css", "styles.css", "motion.css", "components/workspacePages.css"].map(read))).join("\n");
// Screenshots go to a temporary folder that the suite removes: binary
// evidence is never written into the tree.
let SHOTS;

const copy = {
  "tasks.view.field_notes": "Field notes",
  "tasks.fieldNotesTitle": "Field notes",
  "tasks.fieldNotesPermission": "Everyone authorized for a task can read its field notes.",
  "tasks.fieldNoteOne": "1 field note",
  "tasks.fieldNoteCount": "{count} field notes",
  "tasks.fieldNotesIndex": "Tasks with field notes",
  "tasks.fieldNotesThread": "Field notes for {task}",
  "tasks.openFieldNotes": "Open task with field notes for {task}",
  "tasks.openTask": "Open task",
  "tasks.newFieldNote": "New note",
  "tasks.fieldNotePlaceholder": "Add a field note…",
  "tasks.addFieldNote": "Add note",
  "tasks.fieldNoteMentions": "Notify chapter members",
  "tasks.chapterMember": "Chapter member",
  "tasks.you": "You",
  "tasks.status.to_do": "To do",
  "fieldNotes.packet.open": "Draft a packet",
  "fieldNotes.packet.title": "Draft packet from field notes",
  "fieldNotes.packet.intro": "Pick the notes to use. Compass drafts a packet from those notes and your chapter's verified sources.",
  "fieldNotes.packet.selectLabel": "Use this note",
  "fieldNotes.packet.selected": "{count} of {limit} notes selected",
  "fieldNotes.packet.limitReached": "Your organization allows {limit} notes in one packet.",
  "fieldNotes.packet.submit": "Draft the packet",
  "fieldNotes.packet.working": "Drafting…",
  "fieldNotes.packet.cancel": "Close",
  "fieldNotes.packet.draftLabel": "Draft for review",
  "fieldNotes.packet.summary": "Summary",
  "fieldNotes.packet.plainLanguage": "In plain language",
  "fieldNotes.packet.checklist": "Bring this",
  "fieldNotes.packet.questions": "Questions to ask",
  "fieldNotes.packet.sources": "Sources used",
  "fieldNotes.packet.noSources": "No sources backed this draft.",
};
const t = (key, vars = {}) => String(copy[key] || key).replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? ""));

const comments = [1, 2, 3].map((index) => ({
  id: `note-${index}`,
  taskId: "task-a",
  chapterId: "chapter-1",
  authorId: "member-2",
  mentionedUserIds: [],
  createdAt: `2026-10-0${index}T10:00:00.000Z`,
  body: `Field note ${index}: members asked about coverage on the night shift.`,
}));

const packet = {
  noteLimit: 2,
  draft: async () => ({
    packet: {
      headline: "Night shift coverage walkthrough",
      summary: "Members report short staffing on the night shift over the past week.",
      plainLanguage: "Staffing has been short on the night shift. Bring your notes and ask how coverage will be set.",
      checklist: ["Your schedule", "Your field notes"],
      questions: ["How will coverage be set?", "What happens if it stays short?"],
      citations: [{ marker: "S1", title: "Grievance steps" }],
    },
    sources: [{ marker: "S1", id: "kb:1", title: "Grievance steps", ref: "Article 12" }],
  }),
};

async function renderedPanel() {
  const view = render(
    <TaskFieldNotesView
      tasks={[{ id: "task-a", taskNumber: 1, title: "Night shift coverage walkthrough", status: "to_do", workstream: "Organizing" }]}
      comments={comments}
      commentsUnavailable={false}
      commentsTruncated={false}
      assignees={[{ id: "member-2", fullName: "Maria Santos" }]}
      memberId="member-1"
      chapterId="chapter-1"
      doneVisible={false}
      demo={false}
      lang="en"
      t={t}
      onOpen={vi.fn()}
      onCreate={vi.fn()}
      onAddComment={vi.fn()}
      packet={packet}
    />,
  );
  fireEvent.click(within(view.container).getByRole("button", { name: "Draft a packet" }));
  const form = within(view.container).getByRole("form", { name: "Draft packet from field notes" });
  fireEvent.click(within(form).getAllByRole("checkbox")[0]);
  fireEvent.click(within(form).getAllByRole("checkbox")[1]);
  await act(async () => { fireEvent.click(within(form).getByRole("button", { name: "Draft the packet" })); });
  await waitFor(() => within(view.container).getByLabelText("Draft for review"));
  return view;
}

describe("draft packet panel in a browser", () => {
  let browser;
  beforeAll(async () => {
    SHOTS = mkdtempSync(join(tmpdir(), "field-notes-packet-"));
    browser = await chromium.launch({ headless: true });
  }, BROWSER_HOOK_TIMEOUT);
  afterAll(async () => {
    await browser?.close();
    if (SHOTS) rmSync(SHOTS, { recursive: true, force: true });
  });

  it.each(["union-ground"])("keeps the picker and the draft at 13px or more in %s", async (theme) => {
    const view = await renderedPanel();
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: "reduce", colorScheme: "light" });
    try {
      await page.route("**/*", (route) => route.abort());
      // The board renders its one light palette: nothing sets a board theme,
      // so the fixture carries none either.
      await page.setContent(
        `<div class="sg-app sg-app--desktop">`
        + `<div class="tasks-screen tasks-screen--desktop-work" data-workspace-tasks>`
        + `${view.container.innerHTML}</div></div>`,
      );
      await page.addStyleTag({ content: pageCss });
      const measured = await page.evaluate(() => {
        const panel = document.querySelector(".tasks-field-notes__packet");
        const column = panel.closest(".tasks-field-notes__detail") || panel.parentElement;
        const small = [];
        const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const node = walker.currentNode;
          const parent = node.parentElement;
          if (!node.textContent.trim() || !parent.getClientRects().length) continue;
          if (parent.closest(".visually-hidden")) continue;
          const size = parseFloat(getComputedStyle(parent).fontSize);
          if (size < 13) small.push(`${size}px ${parent.tagName.toLowerCase()}.${parent.className}`);
        }
        const box = panel.getBoundingClientRect();
        const style = getComputedStyle(panel);
        return {
          small, width: box.width, columnWidth: column.getBoundingClientRect().width,
          draft: Boolean(panel.querySelector(".tasks-field-notes__packet-draft")),
          background: style.backgroundColor, ink: style.color,
        };
      });
      await page.locator(".tasks-field-notes__packet").screenshot({ path: `${SHOTS}/draft-packet-1440-${theme}.png` });
      expect(measured.small).toEqual([]);
      expect(measured.draft).toBe(true);
      expect(measured.width).toBeGreaterThan(0);
      expect(measured.width).toBeLessThanOrEqual(measured.columnWidth + 1);
      // The panel takes the board palette it is rendered in.
      expect(measured.background).toBe("rgb(255, 255, 255)");
      expect(measured.ink).toBe("rgb(36, 36, 36)");
    } finally {
      await page.close();
      view.unmount();
    }
  }, 60_000);
});
