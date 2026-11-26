import { describe, expect, it } from "vitest";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { DEMO_SEED_PROFILE, seedDemoData } from "./fixtures/retired-pre-bot/src/data/demoSeed.js";

// The busy-org tour contract: 20 chapters, 12,000 workers, 480 committee members, four
// years of history, and communication volumes that read as a large active
// local — while every hand-authored row the guided tour points at stays
// pinned exactly where fallback.js put it.

const seeded = seedDemoData(fallbackData);
const anchorMs = Date.parse(DEMO_SEED_PROFILE.anchorDate);
const yearMs = 365 * 24 * 60 * 60 * 1000;

describe("demo seed scale contract", () => {
  it("builds exactly 20 chapters whose member counts sum to 12,000", () => {
    expect(seeded.chapters).toHaveLength(DEMO_SEED_PROFILE.chapters);
    expect(seeded.chapters.reduce((sum, chapter) => sum + chapter.memberCount, 0)).toBe(DEMO_SEED_PROFILE.members);
    expect(new Set(seeded.chapters.map((chapter) => chapter.id)).size).toBe(DEMO_SEED_PROFILE.chapters);
    // The tour's home chapter and the pinned admin chapters keep their ids.
    for (const id of ["wor", "ma-dcf", "ma-dmh", "ma-dta"]) {
      expect(seeded.chapters.some((chapter) => chapter.id === id), id).toBe(true);
    }
  });

  it("fully seeds every chapter landing and organization-shared surface", () => {
    for (const chapter of seeded.chapters) {
      expect(chapter.landing.summary, chapter.id).toContain(chapter.name);
      expect(chapter.landing.activity, chapter.id).toHaveLength(24);
      expect(chapter.landing.sharedResources, chapter.id).toHaveLength(6);
      expect(chapter.landing.activitySummary.openCases, chapter.id).toBeGreaterThan(0);
      expect(chapter.landing.activitySummary.turnoutPercent, chapter.id).toBeGreaterThanOrEqual(61);
    }
    expect(seeded.adminDesk.organization.chapters.every((chapter) => chapter.landing?.activity.length === 24)).toBe(true);
    expect(seeded.sharedChapterResources).toHaveLength(DEMO_SEED_PROFILE.chapters * 6);
    const sharedSpaces = seeded.product.spaces.filter((space) => space.visibility === "organization");
    expect(sharedSpaces).toHaveLength(4);
    expect(sharedSpaces.every((space) => space.threads.length === 12)).toBe(true);
  });

  it("contains no sample labels, identifiers, or data flags", () => {
    expect(JSON.stringify(seeded).toLowerCase()).not.toContain("sample");
  });

  it("seeds exactly 480 stewards, consistently between chapters and the roster", () => {
    expect(seeded.chapters.reduce((sum, chapter) => sum + chapter.roleCounts.steward, 0)).toBe(DEMO_SEED_PROFILE.stewards);
    const rosterStewards = seeded.memberRoster.filter((person) => person.roles.includes("steward"));
    expect(rosterStewards).toHaveLength(DEMO_SEED_PROFILE.stewards);
  });

  it("generates a genuine 12,000-person roster the admin search filters over", () => {
    expect(seeded.memberRoster).toHaveLength(DEMO_SEED_PROFILE.members);
    // Per-chapter roster totals match the chapter table exactly.
    const byChapter = new Map(seeded.chapters.map((chapter) => [chapter.id, 0]));
    for (const person of seeded.memberRoster) byChapter.set(person.chapterId, byChapter.get(person.chapterId) + 1);
    for (const chapter of seeded.chapters) expect(byChapter.get(chapter.id), chapter.id).toBe(chapter.memberCount);
    // The search pool keeps the pinned demo people first, then everyone.
    expect(seeded.adminSearchPool.length).toBe(fallbackData.adminSearchPool.length + DEMO_SEED_PROFILE.members);
    expect(seeded.adminSearchPool.slice(0, fallbackData.adminSearchPool.length)).toEqual(fallbackData.adminSearchPool);
    // The 30k roster must NOT sit inside adminDesk — the demo hats deep-clone
    // adminDesk on entry, and cloning 12,000 rows per hat switch is the bug
    // this layout exists to prevent.
    expect(seeded.adminDesk.memberDirectory.items.length).toBeLessThan(100);
    expect(seeded.adminDesk.organization.chapters).toHaveLength(DEMO_SEED_PROFILE.chapters);
  });

  it("covers four full years of history on every dated surface", () => {
    const spans = {
      broadcasts: seeded.broadcasts.map((row) => row.publishedAt),
      stewardBroadcasts: seeded.stewardDesk.broadcasts.map((row) => row.publishedAt),
      events: seeded.events.filter((row) => row.isPast).map((row) => row.startsAt),
      conversations: seeded.conversations.flatMap((thread) => thread.messages.map((message) => message.created_at)),
      coordinatorCases: seeded.coordinatorDesk.cases.map((row) => row.updates[0]?.createdAtValue).filter(Boolean),
    };
    for (const [surface, dates] of Object.entries(spans)) {
      if (!dates.length) continue;
      const oldest = Math.min(...dates.map((value) => Date.parse(value)));
      expect(anchorMs - oldest, surface).toBeGreaterThan((DEMO_SEED_PROFILE.historyYears - 0.25) * yearMs);
    }
  });

  it("reads as very active communication and operations", () => {
    expect(seeded.broadcasts.length).toBeGreaterThan(200);
    expect(seeded.stewardDesk.broadcasts.length).toBeGreaterThan(200);
    expect(seeded.conversations.length).toBeGreaterThanOrEqual(30);
    expect(seeded.conversations.flatMap((thread) => thread.messages).length).toBeGreaterThan(150);
    expect(seeded.stewardDesk.threads.length).toBeGreaterThanOrEqual(35);
    expect(seeded.stewardDesk.formsInbox.length).toBeGreaterThanOrEqual(20);
    expect(seeded.notifications.length).toBeGreaterThanOrEqual(20);
    expect(seeded.events.length).toBeGreaterThan(100);
    expect(seeded.tasks.length).toBeGreaterThan(100);
    expect(seeded.coordinatorDesk.cases.length).toBeGreaterThan(300);
    expect(seeded.workload.entries.length).toBeGreaterThan(190);
    expect(seeded.planItems.filter((item) => item.kind === "ballot").length).toBeGreaterThanOrEqual(15);
    expect(seeded.adminDesk.audit.length).toBeGreaterThan(100);
    expect(seeded.adminDesk.events.length).toBeGreaterThan(40);
    expect(seeded.stewardDesk.kpis.membersCovered).toBe(
      seeded.chapters.find((chapter) => chapter.id === "wor").memberCount,
    );
  });

  it("keeps every hand-authored tour row pinned first and unchanged", () => {
    expect(seeded.member).toEqual(fallbackData.member);
    expect(seeded.tasks.slice(0, fallbackData.tasks.length).map((task) => task.id)).toEqual(fallbackData.tasks.map((task) => task.id));
    expect(seeded.broadcasts.slice(0, fallbackData.broadcasts.length).map((row) => row.id)).toEqual(fallbackData.broadcasts.map((row) => row.id));
    expect(seeded.conversations.slice(0, fallbackData.conversations.length).map((row) => row.id)).toEqual(fallbackData.conversations.map((row) => row.id));
    expect(seeded.planItems.slice(0, fallbackData.planItems.length).map((row) => row.id)).toEqual(fallbackData.planItems.map((row) => row.id));
    expect(seeded.cases[0]).toEqual(fallbackData.cases[0]);
    expect(seeded.stewardDesk.threads.slice(0, 3).map((row) => row.id)).toEqual(fallbackData.stewardDesk.threads.map((row) => row.id));
  });

  it("keeps generated rows internally consistent with the board invariants", () => {
    const assigneeIds = new Set(seeded.taskAssignees.map((person) => person.id));
    const taskNumbers = new Set();
    for (const task of seeded.tasks) {
      expect(assigneeIds.has(task.assigneeId), task.id).toBe(true);
      expect(taskNumbers.has(task.taskNumber), task.id).toBe(false);
      taskNumbers.add(task.taskNumber);
      if (task.startDate && task.dueDate) expect(task.dueDate >= task.startDate, task.id).toBe(true);
      if (task.status === "done") expect(task.progress, task.id).toBe(100);
    }
    for (const ballot of seeded.planItems.filter((item) => item.id.startsWith("seed-ballot-"))) {
      const tallied = ballot.results.reduce((sum, row) => sum + row.votes, 0);
      expect(tallied, ballot.id).toBe(ballot.quorum.totalVotes);
      for (const row of ballot.results) expect(row.votes, ballot.id).toBeGreaterThanOrEqual(0);
    }
    const openCases = seeded.coordinatorDesk.cases.filter((row) => row.status === "active").length;
    expect(seeded.coordinatorDesk.kpis.openCases).toBe(openCases);
    expect(seeded.advisorDesk.overview.stewardCount).toBe(
      seeded.chapters.find((chapter) => chapter.id === "wor").roleCounts.steward,
    );
  });

  it("is deterministic and never mutates the hand-authored core", () => {
    const before = JSON.stringify(fallbackData);
    const again = seedDemoData(fallbackData);
    expect(JSON.stringify(fallbackData)).toBe(before);
    expect(JSON.stringify(again)).toBe(JSON.stringify(seeded));
  });
});

// The demo shows a campaign that is
// still forming. It keeps its shape and size, but none of its threads or
// records may carry union casework such a campaign does not have: Weingarten
// rights, grievances under contract articles, steps, hearings, contract
// remedies, ratification or dues.
describe("demo content is organizing, not union casework", () => {
  const TEXT_KEYS = new Set([
    "title", "title_es", "body", "body_es", "summary", "description", "preview", "label",
    "meta", "details", "reference", "location", "lessonLabel", "sender", "sender_name", "name",
  ]);
  const CASEWORK = /Weingarten|Loudermill|grievance|\bArticle \d|\bStep [1-4]\b|arbitrat|\bhearing\b|\bdues\b|\bremed(y|ies)\b|union representation|ratif|labor[- ]management|\bGR-\d|\bG-\d|the contract\b|contract (notice|article|remedy|clause)/i;

  function visibleText(value, path = "data", out = []) {
    if (Array.isArray(value)) value.forEach((item, index) => visibleText(item, `${path}[${index}]`, out));
    else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (typeof item === "string" && TEXT_KEYS.has(key)) out.push([`${path}.${key}`, item]);
        else visibleText(item, `${path}.${key}`, out);
      }
    }
    return out;
  }

  it("keeps every seeded thread, record and label free of union casework", () => {
    const hits = visibleText(seeded).filter(([, text]) => CASEWORK.test(text));
    expect(hits.slice(0, 10)).toEqual([]);
  });

  it("tells the disciplinary-meeting story the way the D4 checklist does", () => {
    const bodies = seeded.conversations.flatMap((thread) => thread.messages.map((message) => message.body));
    expect(bodies).toContain("First, ask whether the meeting could lead to discipline. Then ask for a coworker to be present. They may say no, but asking is still worth it.");
    expect(bodies.join(" ")).not.toMatch(/representation|steward come|until I'm in the room/i);
  });

  it("keeps every seeded meeting private, since public events are left out", () => {
    const events = [...seeded.events, ...(seeded.admin?.events || [])];
    expect(events.length).toBeGreaterThan(0);
    expect(events.filter((event) => event.isPublic || event.isPublicAcrossAgencies)).toEqual([]);
  });

  it("shows the organizing situations the owner named", () => {
    const text = visibleText(seeded).map(([, value]) => value).join("\n");
    for (const topic of [/group issue/i, /petition/i, /captive-audience meeting/i, /after (I|we) talked with coworkers about the union/i, /safety complaint/i, /sign a union card/i]) {
      expect(text).toMatch(topic);
    }
  });
});
