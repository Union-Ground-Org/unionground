import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createDemoChapterAppointmentSupervisionApi } from "../src/App.jsx";
import { fallbackData } from "./fixtures/retired-pre-bot/src/data/fallback.js";
import { LanguageProvider } from "../src/lib/LanguageContext.jsx";
import { AdminView } from "../src/views/AdminView.jsx";
import { AdvisorView } from "../src/views/AdvisorView.jsx";
import { CoordinatorView } from "../src/views/CoordinatorView.jsx";
import { VpView } from "../src/views/VpView.jsx";

const clone = (value) => JSON.parse(JSON.stringify(value));

function supervisionApi() {
  return {
    loadChapterAppointments: vi.fn().mockResolvedValue({
      rows: [clone(fallbackData.chapterAppointmentSupervision.rows[0])],
      nextCursor: null,
      total: 1,
    }),
    loadChapterAppointmentCandidates: vi.fn().mockResolvedValue([]),
    reassignChapterAppointment: vi.fn(),
  };
}

function wrap(node) {
  return render(<LanguageProvider lang="en">{node}</LanguageProvider>);
}

describe("chapter appointment supervision desk wiring", () => {
  it("mounts after the coordinator desk succeeds", async () => {
    const api = {
      ...supervisionApi(),
      loadDesk: vi.fn().mockResolvedValue(clone(fallbackData.coordinatorDesk)),
      loadCases: vi.fn().mockResolvedValue({ cases: clone(fallbackData.coordinatorDesk.cases), nextCursor: null }),
    };
    wrap(<CoordinatorView data={{ member: { initials: "JP" } }} api={api} onNotice={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Campaign one-on-ones" })).toBeInTheDocument();
  });

  it("mounts after the advisor desk succeeds", async () => {
    const api = { ...supervisionApi(), loadDesk: vi.fn().mockResolvedValue(clone(fallbackData.advisorDesk)) };
    wrap(<AdvisorView data={{ member: { initials: "AN" } }} api={api} onNotice={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Campaign one-on-ones" })).toBeInTheDocument();
  });

  it("mounts after the admin desk succeeds", async () => {
    const api = {
      ...supervisionApi(),
      loadDesk: vi.fn().mockResolvedValue(clone(fallbackData.adminDesk)),
      loadFormTemplates: vi.fn().mockResolvedValue([]),
      loadRewardEconomy: vi.fn().mockResolvedValue({ rules: [], tiers: [], items: [], revisions: [], formTemplatePoints: [] }),
    };
    wrap(<AdminView data={{ member: { initials: "AR" } }} api={api} onNotice={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Campaign one-on-ones" })).toBeInTheDocument();
  });

  it("does not mount in the VP desk", async () => {
    const api = {
      loadDesk: vi.fn().mockResolvedValue(clone(fallbackData.vpOverview)),
      markReviewed: vi.fn(),
    };
    wrap(<VpView data={{ member: { initials: "TM" } }} api={api} />);
    expect(await screen.findByRole("heading", { name: "Participation trend" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Campaign one-on-ones" })).not.toBeInTheDocument();
  });
});

describe("shared appointment supervision demo twin", () => {
  it("defers a cold-demo seed until the fixture chunk becomes available", async () => {
    const stateRef = { current: null };
    let fixtures = null;
    const shared = createDemoChapterAppointmentSupervisionApi(
      stateRef,
      () => fixtures?.chapterAppointmentSupervision,
    );

    fixtures = fallbackData;
    await expect(shared.loadChapterAppointments()).resolves.toMatchObject({
      total: 3,
      rows: expect.any(Array),
    });
  });

  it("keyset-pages a single store and makes reassignment visible across hats", async () => {
    const stateRef = { current: null };
    const seed = clone(fallbackData.chapterAppointmentSupervision);
    const now = Date.now();
    seed.rows.filter((row) => row.status === "confirmed").forEach((row, index) => {
      const start = new Date(now + (index + 2) * 86400000).toISOString();
      const end = new Date(Date.parse(start) + row.durationMinutes * 60000).toISOString();
      row.startsAt = start;
      row.endsAt = end;
    });
    const shared = createDemoChapterAppointmentSupervisionApi(stateRef, seed);
    const coordinator = { ...shared };
    const advisor = { ...shared };

    const first = await coordinator.loadChapterAppointments({ cursor: null });
    expect(first.rows).toHaveLength(2);
    expect(first.total).toBe(3);
    expect(first.nextCursor).toEqual({
      startsAt: first.rows[1].startsAt,
      id: first.rows[1].id,
    });
    const second = await coordinator.loadChapterAppointments({ cursor: first.nextCursor });
    expect(second.rows).toHaveLength(1);
    expect(second.nextCursor).toBeNull();

    const appointment = first.rows.find((row) => row.status === "confirmed");
    expect(Date.parse(appointment.startsAt)).toBeGreaterThan(Date.now());
    const candidates = await coordinator.loadChapterAppointmentCandidates(appointment.id);
    const target = candidates.find((candidate) => candidate.id !== appointment.stewardId);
    await coordinator.reassignChapterAppointment(appointment.id, target.id);

    const fromAdvisor = await advisor.loadChapterAppointments({ cursor: null });
    expect(fromAdvisor.rows.find((row) => row.id === appointment.id)).toMatchObject({
      stewardId: target.id,
      stewardName: target.name,
    });
    expect(fromAdvisor.rows.find((row) => row.id === appointment.id)).not.toHaveProperty("reasonCategory");
  });
});
