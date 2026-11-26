import { stubSessionWriter } from '../testing/stubSessionWriter';
vi.mock('../services/supabase', () => ({ getSupabaseClient: () => null, captureSessionWriter: () => stubSessionWriter(() => null) }));
// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StewardFormReviewRow, StewardRequestRow } from '../services/stewardDeskSections';

const runtime = vi.hoisted(() => ({
  userID: 'steward-1',
  role: 'steward' as string | null,
  chapterID: 'chapter-a',
  loadCases: vi.fn(),
  loadRequests: vi.fn(),
  loadForms: vi.fn(),
  loadBroadcasts: vi.fn(),
  triage: vi.fn(),
  review: vi.fn(),
  send: vi.fn(),
  detail: vi.fn(),
  push: vi.fn(),
}));

vi.mock('../state/AppProvider', () => ({
  useApp: () => ({
    dashboard: { member: { id: runtime.userID } },
    chosenStaffRole: runtime.role,
    chapterMemberships: [{ chapterID: runtime.chapterID, selected: true }],
  }),
}));
vi.mock('../theme/ThemeProvider', () => ({
  useTheme: () => ({
    primary: '#4c1d4e', mutedForeground: '#5c4a3a', foreground: '#24160f', input: '#fffaf3',
    border: '#c4b2a1', destructive: '#8f1d1d', appearance: 'light',
  }),
}));
vi.mock('../services/haptics', () => ({ haptics: { select: async () => {}, success: async () => {} } }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: runtime.push }) }));
vi.mock('../services/stewardDeskSections', () => ({
  loadStewardCaseload: runtime.loadCases,
  loadStewardRequests: runtime.loadRequests,
  loadStewardFormsForReview: runtime.loadForms,
  loadStewardBroadcasts: runtime.loadBroadcasts,
  triageStewardRequest: runtime.triage,
  reviewStewardForm: runtime.review,
  sendChapterBroadcast: runtime.send,
}));
vi.mock('../services/stewardFormReview', () => ({
  loadStewardFormReviewDetail: runtime.detail,
  formatFormSubmittedAt: (value: string | null) => `Submitted ${value ?? 'at an unrecorded time'} ET`,
  stewardFormApprovalBlock: () => null,
}));
vi.mock('react-native', async () => {
  const { createElement: h } = await import('react');
  const text = ({ children }: { children?: ReactNode }) => h('div', null, children);
  return {
    View: text,
    Text: text,
    TextInput: ({ accessibilityLabel }: { accessibilityLabel?: string }) => h('input', { 'aria-label': accessibilityLabel }),
    Pressable: ({ children, onPress, accessibilityLabel }: { children?: ReactNode; onPress?: () => void; accessibilityLabel?: string }) => (
      h('button', { type: 'button', onClick: onPress, 'aria-label': accessibilityLabel }, children)
    ),
    StyleSheet: { create: <T,>(value: T) => value },
  };
});
vi.mock('../components/ui', async () => {
  const { createElement: h } = await import('react');
  const text = ({ children }: { children?: ReactNode }) => h('div', null, children);
  return {
    Body: text,
    Heading: text,
    Card: text,
    Screen: text,
    Button: ({ label, onPress, disabled, accessibilityLabel }: { label: string; onPress?: () => void; disabled?: boolean; accessibilityLabel?: string }) => (
      h('button', { type: 'button', onClick: onPress, disabled, 'aria-label': accessibilityLabel ?? label }, label)
    ),
    StateMessage: ({ title, body }: { title: string; body: string }) => h('div', null, title, body),
  };
});

import { StewardDeskSectionsScreen } from './StewardDeskSectionsScreen';

let root: Root;
let host: HTMLDivElement;

function listPage<T, C>(rows: T[], total: number | null, nextCursor: C | null) {
  return { rows, total, nextCursor };
}

function formRow(id: string, memberName: string): StewardFormReviewRow {
  return {
    id,
    memberName,
    userID: 'member-1',
    templateKey: 'grievance',
    templateLabel: 'Workplace issue report',
    templateVersion: 1,
    submittedAt: '2026-01-02T15:00:00Z',
    status: 'submitted',
    answers: { what: 'A fictional schedule change' },
    protectedAnswers: false,
    answersHidden: false,
  };
}

async function render(featureKey: 'steward-caseload' | 'steward-requests' | 'steward-forms' | 'steward-broadcasts') {
  await act(async () => { root.render(createElement(StewardDeskSectionsScreen, { featureKey })); });
}

async function clickLabel(label: string, index = 0) {
  const buttons = Array.from(host.querySelectorAll('button')).filter((item) => item.getAttribute('aria-label') === label || item.textContent === label);
  const button = buttons[index];
  expect(button, label).toBeTruthy();
  await act(async () => { button?.click(); });
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  runtime.userID = 'steward-1';
  runtime.role = 'steward';
  runtime.chapterID = 'chapter-a';
  runtime.loadCases.mockReset();
  runtime.loadRequests.mockReset();
  runtime.loadForms.mockReset();
  runtime.loadBroadcasts.mockReset();
  runtime.triage.mockReset().mockResolvedValue(undefined);
  runtime.review.mockReset().mockResolvedValue(undefined);
  runtime.send.mockReset().mockResolvedValue(undefined);
  runtime.detail.mockReset().mockResolvedValue({
    templateLabel: 'Workplace issue report',
    templateVersion: 1,
    submittedAt: '2026-01-02T15:00:00Z',
    lines: [{ label: 'What happened', value: 'A fictional schedule change' }],
    answersUnavailable: false,
    filingUnavailable: false,
    filerSigned: true,
    attachments: [],
    cosigners: [],
    cosignersUnavailable: false,
    expectation: { answers: {}, attachmentIds: [], cosignerIds: [] },
  });
  runtime.push.mockReset();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
});

// A11Y-UG-NATIVE-STEWARD-ROW-ACTIONS-OMIT-TARGET-20261109: two
// requests and two forms, two of each from one fictional Tamarack member.
// Every repeated button gets its visible action text first, then the member
// and record, and acting on one named record reaches only that record.

function request(id: string, memberName: string, topic: string, status = 'requested'): StewardRequestRow {
  return { id, memberName, topic, status, createdAt: null };
}

function form(id: string, memberName: string, templateLabel: string, submittedAt: string): StewardFormReviewRow {
  return { ...formRow(id, memberName), templateLabel, submittedAt };
}

function buttonNames(): string[] {
  return Array.from(host.querySelectorAll('button')).map((item) => item.getAttribute('aria-label') ?? '');
}

function visibleLabels(): string[] {
  return Array.from(host.querySelectorAll('button')).map((item) => item.textContent ?? '');
}

describe('committee member request and form buttons name their target', () => {
  it('shows the request time once, omitting it when the record has no date', async () => {
    runtime.loadRequests.mockResolvedValue(listPage([
      { ...request('request-1', 'Marcus Greene', 'Schedule change'), createdAt: '2026-11-18T15:47:10Z' },
      request('request-2', 'Priya Natarajan', 'Overtime posting'),
    ], 2, null));
    await render('steward-requests');
    expect(host.textContent?.match(/Requested Nov 18, 2026,/g)).toHaveLength(1);
  });

  it('names each Acknowledge and Close request with the worker and topic and triages only that request', async () => {
    runtime.loadRequests.mockResolvedValue(listPage([
      request('request-1', 'Marcus Greene', 'Schedule change'),
      request('request-2', 'Marcus Greene', 'Overtime posting', 'acknowledged'),
      request('request-3', 'Priya Natarajan', 'Schedule change'),
    ], 3, null));
    await render('steward-requests');
    expect(visibleLabels().filter((label) => label === 'Acknowledge' || label === 'Close request')).toEqual([
      'Acknowledge', 'Close request', 'Close request', 'Acknowledge', 'Close request',
    ]);
    const names = buttonNames().filter((name) => name.startsWith('Acknowledge') || name.startsWith('Close'));
    expect(names).toEqual([
      'Acknowledge request from Marcus Greene: Schedule change',
      'Close request from Marcus Greene: Schedule change',
      'Close request from Marcus Greene: Overtime posting',
      'Acknowledge request from Priya Natarajan: Schedule change',
      'Close request from Priya Natarajan: Schedule change',
    ]);
    expect(new Set(names).size).toBe(names.length);
    await clickLabel('Close request from Marcus Greene: Overtime posting');
    expect(runtime.triage).toHaveBeenCalledTimes(1);
    expect(runtime.triage).toHaveBeenCalledWith(expect.objectContaining({ client: expect.any(Function) }), 'request-2', 'close');
  });

  it('tells two identical-looking requests apart without a remembered row position', async () => {
    runtime.loadRequests.mockResolvedValue(listPage([
      request('request-1', 'Marcus Greene', 'Schedule change'),
      request('request-2', 'Marcus Greene', 'Schedule change'),
    ], 2, null));
    await render('steward-requests');
    const names = buttonNames().filter((name) => name.startsWith('Acknowledge'));
    expect(names).toEqual([
      'Acknowledge request from Marcus Greene: Schedule change, 1 of 2',
      'Acknowledge request from Marcus Greene: Schedule change, 2 of 2',
    ]);
    await clickLabel('Acknowledge request from Marcus Greene: Schedule change, 2 of 2');
    expect(runtime.triage).toHaveBeenCalledWith(expect.objectContaining({ client: expect.any(Function) }), 'request-2', 'acknowledge');
    expect(runtime.triage).toHaveBeenCalledTimes(1);
  });

  it('names each Review with the form, the worker and the submitted time and opens only that form', async () => {
    runtime.loadForms.mockResolvedValue(listPage([
      form('form-1', 'Marcus Greene', 'Workplace issue report', '2026-01-02T15:00:00Z'),
      form('form-2', 'Marcus Greene', 'Workplace issue report', '2026-01-05T19:30:00Z'),
      form('form-3', 'Priya Natarajan', 'Overtime claim', '2026-01-03T14:00:00Z'),
    ], 3, null));
    await render('steward-forms');
    expect(visibleLabels().filter((label) => label === 'Review')).toHaveLength(3);
    const names = buttonNames().filter((name) => name.startsWith('Review '));
    expect(names).toEqual([
      'Review Workplace issue report from Marcus Greene, Submitted 2026-01-02T15:00:00Z ET',
      'Review Workplace issue report from Marcus Greene, Submitted 2026-01-05T19:30:00Z ET',
      'Review Overtime claim from Priya Natarajan, Submitted 2026-01-03T14:00:00Z ET',
    ]);
    expect(new Set(names).size).toBe(3);
    await clickLabel(names[1]!);
    expect(runtime.detail).toHaveBeenCalledTimes(1);
    expect(runtime.detail.mock.calls[0]![0]).toMatchObject({ id: 'form-2' });
  });
});
