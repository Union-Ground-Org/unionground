import { getSupabaseClient as businessTestClient } from './supabase';
import { stubSessionWriter } from '../testing/stubSessionWriter';
const businessWriter = stubSessionWriter(() => businessTestClient());
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// BUG-UG-NATIVE-SEVEN-FEATURE-KEYS-OPEN-ONLY-THE-GENERIC-SCREEN-20261113
//: the reads and writes behind the live Campaigns, Be heard and Search
// screens. A fake client records each call so the test reads what the screen
// would send, against the same RPC and column names the web uses.
type Call = { kind: 'rpc' | 'from'; name: string; args?: unknown; steps: [string, unknown[]][] };
const calls: Call[] = [];
let answers: Record<string, { data?: unknown; error?: unknown; status?: number }> = {};

function builder(call: Call) {
  const answer = () => answers[call.name] ?? { data: [], error: null };
  const chain: Record<string, unknown> = {};
  for (const step of ['select', 'eq', 'order', 'limit', 'insert']) {
    chain[step] = (...args: unknown[]) => { call.steps.push([step, args]); return chain; };
  }
  chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => Promise.resolve(answer()).then(resolve, reject);
  return chain;
}

vi.mock('./supabase', () => ({
  getSupabaseClient: () => ({
    rpc: async (name: string, args: unknown) => { calls.push({ kind: 'rpc', name, args, steps: [] }); return answers[name] ?? { data: null, error: null }; },
    from: (name: string) => { const call: Call = { kind: 'from', name, steps: [] }; calls.push(call); return builder(call); },
  }),
}));

import { CAMPAIGN_REGISTRY_PAGE_SIZE, changeCampaign, loadCampaignRegistryPage, normalizeStaffCampaign } from './campaignRegistry';
import { type BeHeardDraft, BE_HEARD_CATEGORIES, BE_HEARD_SEND_FAILED_CONNECTION, BE_HEARD_SEND_REFUSED, beHeardDraftProblem, beHeardSendFailureText, loadMyBeHeardReports, sendBeHeardReport } from './beHeard';
import { LIVE_SEARCH_SOURCE_LIMIT, liveSearchRowsFrom, loadLiveSearchIndex } from './memberSearch';

beforeEach(() => {
  calls.length = 0;
  answers = {};
});

const ballot = { id: 'b1', kind: 'ballot', state: 'draft', scope: 'chapter', titleEn: 'Ratify the contract', titleEs: '', bodyEn: '', closesAt: '2026-12-01T17:00:00Z', quorumTarget: 40, options: [{ id: 'o1' }, { id: 'o2' }] };

describe('live campaign registry', () => {
  it('reads one bounded page with the registry RPC and keeps the server counts and cursor', async () => {
    answers.get_staff_vote_campaigns = { data: { campaigns: [ballot, { id: '', kind: 'pulse', state: 'open', titleEn: 'x' }], counts: { all: 3, draft: 1, open: 2, closed: 0 }, nextCursor: { kind: 'ballot', id: 'b1' } }, error: null };
    const page = await loadCampaignRegistryPage('draft');
    expect(calls[0]).toMatchObject({ kind: 'rpc', name: 'get_staff_vote_campaigns', args: { p_state: 'draft', p_limit: CAMPAIGN_REGISTRY_PAGE_SIZE, p_cursor: null } });
    expect(page.campaigns).toEqual([{ id: 'b1', kind: 'ballot', state: 'draft', scope: 'chapter', titleEn: 'Ratify the contract', titleEs: '', bodyEn: '', closesAt: '2026-12-01T17:00:00Z', quorumTarget: 40, optionCount: 2 }]);
    expect(page.counts).toEqual({ all: 3, draft: 1, open: 2, closed: 0 });
    expect(page.nextCursor).toEqual({ kind: 'ballot', id: 'b1' });
    await loadCampaignRegistryPage('all', { kind: 'ballot', id: 'b1' });
    expect(calls[1]?.args).toEqual({ p_state: null, p_limit: CAMPAIGN_REGISTRY_PAGE_SIZE, p_cursor: { kind: 'ballot', id: 'b1' } });
  });

  it('leaves out a row it cannot name or act on, and never gives a pulse a quorum', () => {
    expect(normalizeStaffCampaign({ ...ballot, state: 'archived' })).toBeNull();
    expect(normalizeStaffCampaign({ ...ballot, titleEn: '  ' })).toBeNull();
    expect(normalizeStaffCampaign({ ...ballot, kind: 'pulse' })?.quorumTarget).toBeNull();
  });

  it('sends each state change to its own RPC with the kind and id, and surfaces a refusal', async () => {
    await changeCampaign(businessWriter, 'publish', { kind: 'ballot', id: 'b1' });
    await changeCampaign(businessWriter, 'close', { kind: 'pulse', id: 'p1' });
    await changeCampaign(businessWriter, 'deleteDraft', { kind: 'ballot', id: 'b2' });
    expect(calls.map((call) => [call.name, call.args])).toEqual([
      ['publish_vote_campaign', { p_kind: 'ballot', p_campaign_id: 'b1' }],
      ['close_vote_campaign', { p_kind: 'pulse', p_campaign_id: 'p1' }],
      ['delete_vote_campaign_draft', { p_kind: 'ballot', p_campaign_id: 'b2' }],
    ]);
    answers.publish_vote_campaign = { data: null, error: { message: 'forbidden' } };
    await expect(changeCampaign(businessWriter, 'publish', { kind: 'ballot', id: 'b1' })).rejects.toBeTruthy();
  });
});

describe('live Be heard', () => {
  it('offers exactly the categories the table accepts', () => {
    expect(BE_HEARD_CATEGORIES.map((item) => item.key)).toEqual(['workplace_issue', 'safety', 'question', 'app_feedback', 'other']);
  });

  it('waits for a topic, a title and a few words before it sends', () => {
    expect(beHeardDraftProblem({ category: null, title: 'Heat', details: 'The break room is 95 degrees.' })).toBe('Choose a topic.');
    expect(beHeardDraftProblem({ category: 'safety', title: ' ', details: 'The break room is 95 degrees.' })).toBe('Add a short title.');
    expect(beHeardDraftProblem({ category: 'safety', title: 'Heat', details: 'Hot' })).toBe('Write at least 8 characters.');
    expect(beHeardDraftProblem({ category: 'safety', title: 'Heat', details: 'The break room is 95 degrees.' })).toBeNull();
  });

  it('inserts only the three worker columns, trimmed, and lists only the worker’s own reports', async () => {
    await sendBeHeardReport(businessWriter, { category: 'safety', title: '  Heat  ', details: '  The break room is 95 degrees.  ' });
    expect(calls[0]).toMatchObject({ kind: 'from', name: 'member_intake_reports' });
    expect(calls[0]?.steps).toEqual([['insert', [{ category: 'safety', title: 'Heat', details: 'The break room is 95 degrees.' }]]]);
    answers.member_intake_reports = { data: [{ id: 'r1', category: 'safety', title: 'Heat', status: 'triaged', created_at: '2026-11-13T15:00:00Z' }], error: null };
    const reports = await loadMyBeHeardReports('user-1');
    expect(calls[1]?.steps).toContainEqual(['eq', ['reporter_id', 'user-1']]);
    expect(reports).toEqual([{ id: 'r1', category: 'safety', title: 'Heat', status: 'triaged', createdAt: '2026-11-13T15:00:00Z' }]);
    expect(await loadMyBeHeardReports('')).toEqual([]);
  });

  it('refuses an incomplete draft without calling the server, and reports a refused insert', async () => {
    await expect(sendBeHeardReport(businessWriter, { category: null, title: 'Heat', details: 'The break room is 95 degrees.' })).rejects.toThrow('The report is not complete.');
    expect(calls).toEqual([]);
    answers.member_intake_reports = { data: null, error: { message: 'pin step-up' } };
    await expect(sendBeHeardReport(businessWriter, { category: 'other', title: 'Heat', details: 'The break room is 95 degrees.' })).rejects.toThrow(BE_HEARD_SEND_FAILED_CONNECTION);
  });

  // A refusal by the server is not a connection problem.
  it('says the server refused a send it answered, and blames the connection only when nothing answered', async () => {
    const draft: BeHeardDraft = { category: 'other', title: 'Heat', details: 'The break room is 95 degrees.' };
    answers.member_intake_reports = { data: null, error: { code: '42501', message: 'new row violates row-level security policy' }, status: 403 };
    await expect(sendBeHeardReport(businessWriter, draft)).rejects.toThrow(BE_HEARD_SEND_REFUSED);
    answers.member_intake_reports = { data: null, error: { code: '', message: 'TypeError: Network request failed' }, status: 0 };
    await expect(sendBeHeardReport(businessWriter, draft)).rejects.toThrow(BE_HEARD_SEND_FAILED_CONNECTION);
    expect(beHeardSendFailureText({ code: 'PGRST202' }, 404)).toBe(BE_HEARD_SEND_REFUSED);
    expect(beHeardSendFailureText({ code: '23514' }, null)).toBe(BE_HEARD_SEND_REFUSED);
    expect(beHeardSendFailureText({}, 500)).toBe(BE_HEARD_SEND_REFUSED);
    expect(beHeardSendFailureText({}, undefined)).toBe(BE_HEARD_SEND_FAILED_CONNECTION);
    // Neither sentence quotes the server.
    for (const text of [BE_HEARD_SEND_REFUSED, BE_HEARD_SEND_FAILED_CONNECTION]) expect(text).not.toMatch(/policy|violates|PGRST|42501/);
  });
});

describe('live search index', () => {
  it('reads each source once, bounded, with published non-sample rights articles only', async () => {
    await loadLiveSearchIndex();
    expect(calls.map((call) => call.name).sort()).toEqual(['member_ballots', 'member_events', 'member_forms', 'member_kb_articles']);
    for (const call of calls) expect(call.steps).toContainEqual(['limit', [LIVE_SEARCH_SOURCE_LIMIT]]);
    const events = calls.find((call) => call.name === 'member_events');
    expect(events?.steps.filter(([step]) => step === 'order' || step === 'limit')).toEqual([
      ['order', ['sort_at', { ascending: false }]],
      ['order', ['id', { ascending: false }]],
      ['limit', [100]],
    ]);
    const rights = calls.find((call) => call.name === 'member_kb_articles');
    expect(rights?.steps).toContainEqual(['eq', ['status', 'published']]);
    expect(rights?.steps).toContainEqual(['eq', ['is_sample', false]]);
  });

  it('keeps the Meetings calendar day in the index without formatting it', async () => {
    vi.stubEnv('TZ', 'Asia/Tokyo');
    try {
      expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Asia/Tokyo');
      answers.member_events = { data: [
        { id: 'timed', title: 'Fixture meeting', starts_at: '2025-07-04 02:15:00.123456+00', location: 'Hall' },
        { id: 'day', title: 'Fixture holiday', event_date: '2025-07-04', starts_at: '2025-07-04T00:00:00Z' },
        { id: 'saved', title: 'Another fixture holiday', event_date: '2025-07-05', starts_at: null },
        { id: 'unknown', title: 'Fixture without a date', starts_at: 'invalid', location: 'Park' },
      ], error: null };
      const index = await loadLiveSearchIndex();
      expect(index.rows.map(({ body, eventDay }) => ({ body, eventDay }))).toEqual([
        { body: 'Hall', eventDay: '2025-07-03' },
        { body: '', eventDay: '2025-07-04' },
        { body: '', eventDay: '2025-07-05' },
        { body: 'Park', eventDay: null },
      ]);
      expect(calls.find((call) => call.name === 'member_events')?.steps)
        .toContainEqual(['select', ['id,title,starts_at,event_date,location']]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('names a source that failed instead of reading it as no matches', async () => {
    answers.member_events = { data: null, error: { message: 'timeout' } };
    answers.member_ballots = { data: [{ id: 'b1', title: 'Contract vote', closes_at: '2020-01-01T00:00:00Z', active: true }], error: null };
    const index = await loadLiveSearchIndex();
    expect(index.unavailable).toEqual(['events']);
    expect(index.rows).toEqual([{
      id: 'ballots:b1', scope: 'ballots', title: 'Contract vote', body: '', href: '/feature/voting',
      ballot: { closesAtMs: Date.parse('2020-01-01T00:00:00Z'), closed: true },
    }]);
  });

  it('shapes rows without inventing a destination for forms, meetings or rights', () => {
    const now = Date.parse('2026-11-13T12:00:00Z');
    expect(liveSearchRowsFrom('forms', [{ id: 'f1', template_key: 'overtime_claim', status: 'in_review' }], now)).toEqual([{ id: 'forms:f1', scope: 'forms', title: 'Overtime claim', body: 'In review' }]);
    const [article] = liveSearchRowsFrom('rights', [{ id: 'k1', article_ref: 'Art. 7', title: 'Weingarten', body: 'x'.repeat(400) }], now);
    expect(article?.title).toBe('Art. 7 · Weingarten');
    expect(article?.body.length).toBe(160);
    expect(article?.href).toBeUndefined();
    expect(liveSearchRowsFrom('events', [{ id: '', title: 'No id' }, { id: 'e1', title: '' }], now)).toEqual([]);
    expect(liveSearchRowsFrom('ballots', [{ id: 'b2', title: 'Open vote', closes_at: '2026-12-01T00:00:00Z', active: true }], now)[0]?.ballot)
      .toEqual({ closesAtMs: Date.parse('2026-12-01T00:00:00Z'), closed: false });
  });
});

// and P3-3 on .
describe('live screen scope and search loading', () => {
  const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

  it('reloads each live screen on a campaign, organization or account switch, as the neighbouring live routes do', () => {
    const feature = source('../features/FeatureScreen.tsx');
    for (const [key, screen] of [['campaigns', 'LiveCampaignsScreen'], ['voice', 'LiveBeHeardScreen'], ['search', 'LiveSearchScreen'], ['steward', 'LiveCaseworkDeskScreen'], ['coordinator', 'LiveCaseQueueScreen']]) {
      expect(feature).toContain(`if (featureKey === '${key}') return <${screen} key={partnerScope} />;`);
    }
    // Forms also takes back the editor the route kept through the switch's
    // re-check when the member and scope are the same .
    expect(feature).toContain("if (featureKey === 'forms') return <LiveFormsScreen key={partnerScope} kept={formsEditor} />;");
  });

  it('says "No matches" only after every search source has answered', () => {
    const screens = source('../features/LiveFeatureScreens.tsx');
    expect(screens).toContain("const searchPending = index === null && !failed && scope !== 'cases';");
    expect(screens).toContain('{results.length === 0 ? (searchPending');
  });
});
