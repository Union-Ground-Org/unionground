import { describe, expect, it } from 'vitest';

import {
  PREVIEW_HATS,
  PREVIEW_ORGANIZATION_ID,
  PREVIEW_STEWARD_ROSTER,
  isPreviewHatKey,
  previewCaseDetail,
  previewCompassHistoryFor,
  previewCompassReply,
  previewConversationThread,
  previewDashboardFor,
  previewDeskFor,
  previewHat,
} from './preview';

const CAMPAIGN = 'Harborview Care United';

describe('seeded preview hats', () => {
  it('exposes every demo hat testers can switch', () => {
    expect(PREVIEW_HATS.map((item) => item.key)).toEqual([
      'member', 'organizer', 'steward', 'coordinator', 'advisor', 'admin', 'vp',
    ]);
    expect(isPreviewHatKey('member')).toBe(true);
    expect(isPreviewHatKey('organizer')).toBe(true);
    expect(isPreviewHatKey('president')).toBe(false);
    expect(previewHat('vp').label).toBe('Campaign chair');
    expect(previewHat('steward').label).toBe('Committee');
  });

  it('names each hat with one role noun everywhere it appears (b03a-3)', () => {
    // The pill, the switch sheet and the profile line under the greeting all
    // named the same hat differently, so a worker reading both saw two roles.
    // Desk titles keep their work noun; only the hat is named here.
    for (const hat of PREVIEW_HATS) {
      expect(previewDashboardFor(hat.key).member.roleLine, hat.key)
        .toBe(`${hat.label} · ${CAMPAIGN}`);
    }
    expect(PREVIEW_HATS.map((item) => item.label)).toEqual([
      'Worker', 'Organizer', 'Committee', 'Campaign lead', 'Advisor', 'Admin', 'Campaign chair',
    ]);
    expect(PREVIEW_HATS.map((hat) => previewDashboardFor(hat.key).member.fullName)).toEqual([
      'Darnell Foster', 'Elena Cruz', 'Maya Thompson', 'Andre Lewis', 'Priya Shah', 'Rosa Martinez', 'Jordan Kim',
    ]);
  });

  it('keeps the personal metric fixtures agreeing with the records they count (b04b-1)', () => {
    // My reports draws these from the worker's own records; a typed KPI that
    // disagrees put two different numbers for one metric on one screen.
    const dashboard = previewDashboardFor('member');
    const kpis = new Map(previewDeskFor('member').kpis.map((item) => [item.label, item.value]));
    expect(kpis.get('Unread updates'))
      .toBe(String(dashboard.notifications.filter((item) => !item.readAt).length));
    expect(kpis.get('Open issues'))
      .toBe(String(dashboard.cases.filter((item) => item.status === 'active').length));
    expect(kpis.get('Unread messages'))
      .toBe(String(dashboard.conversations.reduce((sum, item) => sum + item.unreadCount, 0)));
  });

  it('gives the campaign chair support fractions the desk defines, and no vote it cannot hold (b03b-11)', () => {
    // A fraction beside another count read as a share of the wrong whole. Both
    // fractions name the 184 eligible estimate the summary sentence uses, and
    // a card majority is never shown as a recognition or ratification vote.
    const desk = previewDeskFor('vp');
    expect(desk.kpis.some((item) => item.label === 'Cards signed' && item.value === '119/184')).toBe(true);
    expect(desk.kpis.some((item) => item.label === 'Coworkers reached' && item.value === '151/184')).toBe(true);
    expect(desk.kpis.some((item) => item.label === 'Committee' && item.value === '14')).toBe(true);
    expect(desk.kpis.some((item) => /ratif|quorum|member/i.test(item.label))).toBe(false);
    expect(desk.summary).toContain('119 of 184');
    expect(desk.summary).toContain('Bargaining starts only after recognition');
  });

  it('gives the organizer a desk of conversations, card drive, coverage by shift and one-on-ones', () => {
    const desk = previewDeskFor('organizer');
    const kpis = new Map(desk.kpis.map((item) => [item.label, item.value]));
    expect(kpis.get('Conversations to have')).toBe('12');
    expect(kpis.get('Cards signed')).toBe('119/184');
    expect(kpis.get('One-on-ones this week')).toBe('5');
    // Coverage by shift adds up to the campaign snapshot's 14 committee members.
    const coverage = kpis.get('Committee by shift') ?? '';
    expect([...coverage.matchAll(/\d+/g)].reduce((sum, match) => sum + Number(match[0]), 0)).toBe(14);
    expect(desk.appointments.some((item) => item.type === 'One-on-one')).toBe(true);
    expect(desk.chapterWork).not.toBeNull();
    // The organizer has its own records, not a borrowed Committee desk.
    expect(desk.summary).not.toBe(previewDeskFor('steward').summary);
    expect(previewDashboardFor('organizer').member.fullName).toBe('Elena Cruz');
  });

  it('seeds a complete Harborview Care United workspace on every hat', () => {
    for (const hat of PREVIEW_HATS) {
      const dashboard = previewDashboardFor(hat.key);
      const desk = previewDeskFor(hat.key);
      expect(dashboard.member.roleLine).toContain(CAMPAIGN);
      expect(dashboard.member.chapterID).toBe('hbv');
      expect(dashboard.member.fullName.length).toBeGreaterThan(6);
      expect(dashboard.notifications.length).toBeGreaterThan(1);
      expect(desk.kpis.length).toBeGreaterThan(0);
      expect(desk.events.length + desk.queue.length + dashboard.cases.length).toBeGreaterThan(1);
      expect(desk.chapterName).toBe(CAMPAIGN);
    }
    expect(PREVIEW_ORGANIZATION_ID).toBe('preview-harborview-care-united');
    expect(previewDashboardFor('member').cases.some((item) => item.reference === 'HCU-104')).toBe(true);
    expect(previewDashboardFor('member').notifications.every((item) => item.href)).toBe(true);
    expect(previewDashboardFor('coordinator').cases.some((item) => item.reference === 'HCU-121')).toBe(true);
  });

  it('names issues with organizing references and steps, never grievance machinery', () => {
    const steps = new Set(['Listening', 'Committee review', 'Action planned', 'Delegation scheduled', 'Resolved', 'Paused']);
    for (const hat of PREVIEW_HATS) {
      for (const item of previewDashboardFor(hat.key).cases) {
        expect(item.reference, `${hat.key} / ${item.id}`).toMatch(/^HCU-\d{3}$/);
        expect(steps.has(item.step), `${hat.key} / ${item.step}`).toBe(true);
      }
    }
  });

  it('keeps votes to committee votes and polls, never a recognition, certification or ratification vote', () => {
    for (const hat of PREVIEW_HATS) {
      for (const ballot of previewDeskFor(hat.key).ballots) {
        expect(ballot.title, `${hat.key} / ${ballot.id}`).not.toMatch(/recogni|certif|ratif|contract|tentative/i);
      }
    }
  });

  it('carries no grievance, contract, or real-agency language in any hat fixture', () => {
    for (const hat of PREVIEW_HATS) {
      const text = JSON.stringify([
        previewDashboardFor(hat.key),
        previewDeskFor(hat.key),
        previewCompassHistoryFor(hat.key),
      ]);
      expect(text, hat.key).not.toMatch(/Worcester|Okafor|Weingarten|GR-20|grievance|arbitration|\bULP\b|Art\. ?\d|\bdues\b|\b(DDS|DCF|DMH|DTA)\b|MassAbility|President|ratif|\b509\b|SEIU/i);
    }
  });

  it('carries a coherent rolling three-year history through every hat and backed surface', () => {
    for (const hat of PREVIEW_HATS) {
      const dashboard = previewDashboardFor(hat.key);
      const desk = previewDeskFor(hat.key);
      const activityYears = new Set([
        ...dashboard.notifications.map((item) => new Date(item.createdAt).getUTCFullYear()),
        ...dashboard.cases.map((item) => new Date(item.updatedAt).getUTCFullYear()),
        ...dashboard.conversations.map((item) => new Date(item.updatedAt).getUTCFullYear()),
      ]);
      expect([...activityYears].sort(), hat.key).toEqual([2023, 2024, 2025, 2026]);
      expect(dashboard.weeklyActions.every((item) => new Date(item.occurredAt).getUTCFullYear() === 2026), `${hat.key} weekly actions`).toBe(true);
      for (const year of [2023, 2024, 2025]) {
        const compass = previewCompassHistoryFor(hat.key);
        expect(compass.threads.some((thread) => thread.title.startsWith(String(year))), `${hat.key} Guide ${year}`).toBe(true);
        expect(compass.threads.flatMap((thread) => thread.messages).every((message) => !message.body.includes('SAMPLE transcript')), `${hat.key} transcript copy`).toBe(true);
        expect(desk.events.some((item) => item.when.includes(String(year))), `${hat.key} meetings ${year}`).toBe(true);
        expect(desk.appointments.some((item) => item.when.includes(String(year))), `${hat.key} one-on-ones ${year}`).toBe(true);
        expect(desk.forms.some((item) => item.updated.includes(String(year))), `${hat.key} forms ${year}`).toBe(true);
        expect(desk.ballots.some((item) => item.meta.includes(String(year))), `${hat.key} votes ${year}`).toBe(true);
        expect(desk.workload.some((item) => item.dateLabel.includes(String(year))), `${hat.key} workload ${year}`).toBe(true);
        if (hat.key !== 'member') {
          expect(desk.chapterWork?.tasks.some((item) => item.doneAt?.startsWith(String(year))), `${hat.key} campaign work ${year}`).toBe(true);
        }
      }
    }
  });

  it('keeps hat fixtures isolated so switching cannot leak records', () => {
    const member = previewDashboardFor('member');
    const committee = previewDashboardFor('steward');
    const organizer = previewDashboardFor('organizer');
    member.notifications[0]!.title = 'mutated';
    expect(previewDashboardFor('member').notifications[0]!.title).not.toBe('mutated');
    expect(committee.member.fullName).toBe('Maya Thompson');
    expect(member.cases.some((item) => committee.cases.some((other) => other.id === item.id))).toBe(false);
    expect(member.cases.some((item) => organizer.cases.some((other) => other.id === item.id))).toBe(false);
  });

  it('resolves seeded issue and conversation records across hats', () => {
    const memberCase = previewDashboardFor('member').cases[0]!;
    const committeeCase = previewDashboardFor('steward').cases[0]!;
    const committeeThread = previewDashboardFor('steward').conversations[0]!;
    const organizerThread = previewDashboardFor('organizer').conversations[0]!;
    expect(previewCaseDetail(memberCase.id, 'member')?.item.title).toBe(memberCase.title);
    expect(previewConversationThread(committeeThread.id, 'steward')?.conversation.title).toBe(committeeThread.title);
    expect(previewConversationThread(organizerThread.id, 'organizer')?.conversation.title).toBe(organizerThread.title);
    expect(previewCaseDetail(committeeCase.id, 'member')).toBeNull();
    expect(previewCaseDetail(memberCase.id, 'steward')).toBeNull();
    expect(previewCaseDetail('00000000-0000-4000-8000-000000000000', 'member')).toBeNull();
  });

  it('fills the contact roster with an organizer and a committee member in one campaign', () => {
    expect(PREVIEW_STEWARD_ROSTER.map((item) => [item.name, item.roleLabel])).toEqual([
      ['Elena Cruz', 'organizer'],
      ['Maya Thompson', 'committee'],
    ]);
    expect(PREVIEW_STEWARD_ROSTER.every((item) => item.chapterID === 'hbv' && item.chapterLabel === CAMPAIGN)).toBe(true);
    // The worker's organizer thread is bound to the organizer card, so the
    // finder can open it and never the committee member's.
    const bound = previewDashboardFor('member').conversations.find((item) => item.stewardUserId);
    expect(bound?.stewardUserId).toBe(PREVIEW_STEWARD_ROSTER[0]!.id);
    expect(bound?.title).toBe('Elena Cruz');
  });

  it('answers the Guide from seeded organizing-rights sources with a pointer to qualified help', () => {
    const talk = previewCompassReply('Can I talk with coworkers about the campaign on my break?');
    expect(talk.answer).toMatch(/non-work time/i);
    expect(talk.answer).toMatch(/qualified labor lawyer/i);
    expect(talk.sources[0]?.title).toMatch(/Talking with coworkers/i);
    const notes = previewCompassReply('My supervisor changed my schedule after the meeting. What do I do?');
    expect(notes.sources[0]?.title).toBe('Write down what you saw');
    expect(notes.answer).toMatch(/not a conclusion about the law/i);
    const cards = previewCompassReply('Does a card majority mean we won recognition?');
    expect(cards.answer).toMatch(/not certification/i);
    expect(cards.answer).toMatch(/only after the union is recognized or certified/i);
    for (const reply of [talk, notes, cards]) {
      expect(reply.answer).not.toMatch(/\bULP\b|unfair labor practice|you are protected|the law requires|illegal/i);
    }
  });

  it('fails closed when the Guide has no approved source', () => {
    const reply = previewCompassReply('What is the weather forecast for Friday?');
    expect(reply.answer).toMatch(/cannot answer/i);
    expect(reply.answer).toMatch(/qualified labor lawyer/i);
    expect(reply.answer).not.toMatch(/non-work time|certification/i);
    expect(reply.sources).toEqual([]);
  });
});
