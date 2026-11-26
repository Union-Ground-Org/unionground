import { getSupabaseClient as businessTestClient } from './supabase';
import { stubSessionWriter } from '../testing/stubSessionWriter';
const businessWriter = stubSessionWriter(() => businessTestClient());
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rpc, from } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));

vi.mock('./supabase', () => ({
  assertFreshMobileCalendarSession: vi.fn(async () => 'member-1'),
  getSupabaseClient: vi.fn(() => ({ rpc, from })),
}));

import { getSupabaseClient } from './supabase';
import {
  checkInMobileEvent,
  describeEventActionRefusal,
  loadMobileEventsHistory,
  loadMobileStewardAppointmentsDesk,
  loadMobileStewardAppointmentsPage,
  rewardKindLabel,
  scanCheckinRefusalCopy,
  scanMobileEventCheckin,
  setMobileEventRsvp,
} from './livedIn';
import { collectPages } from './pagination';

const serviceSource = readFileSync(fileURLToPath(new URL('./livedIn.ts', import.meta.url)), 'utf8');
const screenSource = readFileSync(fileURLToPath(new URL('../features/LiveLivedInScreens.tsx', import.meta.url)), 'utf8');
const featureSource = readFileSync(fileURLToPath(new URL('../features/FeatureScreen.tsx', import.meta.url)), 'utf8');
const compassSource = readFileSync(fileURLToPath(new URL('../components/CompassPanel.tsx', import.meta.url)), 'utf8');

describe('authenticated lived-in mobile data', () => {
  it('preserves a refused HTTP status from the real meeting read for draft retirement', async () => {
    const query = {
      select() { return query; }, order() { return query; },
      async range() { return { data: null, error: { code: '', message: 'Forbidden' }, status: 403 }; },
    };
    from.mockReturnValue(query);
    try { await expect(loadMobileEventsHistory()).rejects.toMatchObject({ status: 403 }); }
    finally { from.mockReset(); }
  });
  it('collects every authorized page instead of truncating history at 100 rows', async () => {
    const rows = Array.from({ length: 487 }, (_, id) => ({ id }));
    const fetchPage = vi.fn(async (from: number, to: number) => rows.slice(from, to + 1));

    await expect(collectPages(fetchPage, 200)).resolves.toEqual(rows);
    expect(fetchPage).toHaveBeenNthCalledWith(1, 0, 199);
    expect(fetchPage).toHaveBeenNthCalledWith(2, 200, 399);
    expect(fetchPage).toHaveBeenNthCalledWith(3, 400, 599);
  });

  it('reads availability without reading the admission secret and gates both native controls', async () => {
    const select = vi.fn<(columns: string) => void>();
    const from = vi.fn((table: string) => {
      const query = {
        select(columns: string) { select(columns); return query; },
        order() { return query; },
        async range() { return { error: null, data: table === 'member_events' ? [
          { id: 'meeting', check_in_offered: true },
          { id: 'deadline', check_in_offered: false },
          { id: 'unknown' },
        ] : [] }; },
      };
      return query;
    });
    vi.mocked(getSupabaseClient).mockReturnValue({ from, rpc } as never);
    try {
      const events = await loadMobileEventsHistory();
      expect(events.map((event) => event.checkInOffered)).toEqual([true, false, false]);
      expect(select.mock.calls[0]?.[0].split(',')).toContain('check_in_offered');
      for (const [columns] of select.mock.calls) expect(columns.split(',')).not.toContain('check_in_code');
      expect(screenSource).toContain('const checkInOpen = event.checkInOffered &&');
      expect(screenSource).toContain('{!event.checkInOffered ? <Body muted>No check-in</Body> : eventCheckInClosed(event) ? <Body muted>Check-in closed. This meeting has ended.</Body> : null}');
      expect(screenSource).toContain('{!staffDesk && !event.cancelled && checkInOpen && !event.checkedInAt ?');
      expect(screenSource).toContain('{scanAllowedHere && !event.cancelled && checkInOpen ?');
    } finally {
      vi.mocked(getSupabaseClient).mockReturnValue({ rpc } as never);
    }
  });

  it('uses only authenticated RLS reads and existing atomic worker RPCs', () => {
    // The Native App Reads The Web Surveys: The
    // member_surveys pulse writer is retired; surveys go through
    // services/memberSurveys.ts on the web session RPCs.
    expect(serviceSource).not.toContain("rpc('submit_survey_response'");
    expect(serviceSource).not.toContain("'member_surveys'");
    expect(serviceSource).toContain("rpc('rsvp_to_event'");
    expect(serviceSource).toContain("rpc('check_in_to_event'");
    // Union Ground has no points economy: contributions come from the
    // recognition summary, never the retired points summary or point events.
    expect(serviceSource).toContain("rpc('get_member_recognition_summary'");
    expect(serviceSource).not.toContain("rpc('get_member_rewards_summary'");
    expect(serviceSource).not.toContain("'member_point_events'");
    expect(serviceSource).toContain("rpc('get_workload_stats'");
    expect(serviceSource).toContain("rpc('save_member_guide_exchange'");
    expect(serviceSource).not.toMatch(/service[_-]?role/i);
    expect(serviceSource).not.toContain("from('member_profiles')");
  });

  it('covers the complete seeded worker history and interactive surfaces', () => {
    for (const table of [
      'member_events', 'member_event_rsvps', 'member_event_checkins',
      'member_recognition_rules', 'member_recognition_events', 'member_action_log', 'member_workload_logs', 'member_rights_lessons',
      'member_rights_progress', 'member_steward_requests', 'member_kb_articles',
      'member_broadcasts', 'member_broadcast_receipts', 'chapter_documents', 'chapter_records',
      'chapter_tasks', 'member_guide_threads', 'member_guide_messages',
    ]) expect(serviceSource).toContain(`'${table}'`);
    expect(serviceSource).toContain('.from(table)');
    expect(serviceSource).toContain('.order(tieColumn');

    for (const feature of ['LiveEventsScreen', 'LiveRewardsScreen', 'LiveWorkloadScreen', 'LiveRightsScreen', 'LiveChapterScreen', 'LiveTasksScreen']) {
      expect(screenSource).toContain(`function ${feature}`);
    }
    expect(screenSource).toContain('maxLength={32}');
    expect(serviceSource).toContain("rows('chapter_documents', 'id,title,document_type,summary,version,status,updated_at'");
    expect(serviceSource).toContain(".select('id,title,document_type,summary,body,version,status,updated_at')");
    expect(serviceSource).toContain(".eq('id', documentID)");
    expect(screenSource).toContain('<Body>{sourceDocument.body}</Body>');
    expect(featureSource).toContain('<LiveLivedInScreen key={partnerScope} featureKey={featureKey} sourceID={sourceID} onOpenTask={openTask} />');
  });

  it('keeps SAMPLE and PREVIEW labels out of authenticated empty-state copy', () => {
    const authenticatedCopy = `${screenSource}\n${featureSource}`;
    expect(authenticatedCopy).not.toMatch(/No (SAMPLE|PREVIEW)/);
  });

  it('keeps each Guide conversation inside the selected persisted thread', () => {
    expect(serviceSource).toContain("messages.filter((message) => message.thread_id === thread.id).map");
    expect(serviceSource).toContain('threads: threadRecords');
    expect(compassSource).toContain("accessibilityLabel={t('Guide conversations')}");
    expect(compassSource).toContain('disabled={busy}');
    expect(compassSource).toContain('return [activeThread, ...updated.filter((thread) => thread.id !== savedThreadID)];');
    expect(compassSource).toContain('title: title.slice(0, 120)');
  });

  it('waits for authenticated Guide history before accepting an interaction', () => {
    expect(compassSource).toContain("const authenticatedMemberID = mode === 'authenticated' ? session?.user.id ?? null : null;");
    expect(compassSource).toContain("const historyReady = mode === 'authenticated' && authenticatedMemberID !== null && loadedMemberID === authenticatedMemberID && loadedOrganizationID === (organizationID ?? null);");
    expect(compassSource).toContain('setLoadedMemberID(authenticatedMemberID);');
    expect(compassSource).toContain('if (currentScope.current !== requestScope) return;');
    expect(compassSource).toContain('if (!trimmed || busy || !historyReady || paused || pendingSave) return;');
    // IA wave B ( follow-up 7) widened the populate-not-fire guard set to
    // include `busy`, so a suggestion chip goes inert with the composer instead
    // of staying lit and silently refusing. The history gate is unchanged.
    expect(compassSource).toContain('disabled={!historyReady || paused || pendingSave !== null || busy}');
    // The thread chips have no in-flight concern of their own and keep the
    // original set, so the widening is scoped to the affordances that populate.
    expect(compassSource).toContain('disabled={busy || pendingSave !== null}');
  });

  it('clears volatile Guide state at every authenticated identity boundary', () => {
    // A real identity/scope change remounts the owner. Its temporary session
    // check keeps that owner concealed instead of erasing unfinished work.
    expect(compassSource).toContain("const scope = useHeldScreenScope(mode === 'booting', [session?.user.id], [mode, organizationID, dashboard?.member.chapterID, authorizedRoles, confirmedMembershipScope]);");
    expect(compassSource).toContain('<FullCompassPanel key={scope} {...props} scope={scope} />');
    expect(compassSource).toContain('useState<PendingCompassSave | null>(null)');
    expect(compassSource).toContain('[authenticatedMemberID, historyReload, mode, previewHat, organizationID, requests]');
  });

  it('shows a successful Guide answer even when history persistence fails', () => {
    const appendReply = compassSource.indexOf('setMessages(transcript);');
    const persistReply = compassSource.indexOf('await saveMobileCompassExchange');
    expect(appendReply).toBeGreaterThanOrEqual(0);
    expect(persistReply).toBeGreaterThan(appendReply);
    expect(compassSource).toContain('Answer received, but Guide history was not saved.');
    expect(compassSource).toContain('setPendingSave({ writer, threadID, question: trimmed, answer, sources: reply.sources, transcript, previousMessages: messages });');
    expect(compassSource).toContain('async function retryPendingSave()');
    expect(compassSource).toContain(">{t('Try saving again')}</Text>");
    expect(compassSource).toContain('function discardPendingSave()');
    expect(compassSource).toContain('setMessages(pendingSave.previousMessages);');
    expect(compassSource).toContain(">{t('Discard unsaved answer')}</Text>");
    expect(compassSource).toContain('const answer = reply.answer.slice(0, maxPersistedAnswerLength);');
  });

  it('rolls back an unsaved optimistic question when Guide cannot answer', () => {
    expect(compassSource).toContain('current.some((message) => message.id === userMessage.id) ? messages : current');
    expect(compassSource).toContain('setQuestion(trimmed);');
    expect(compassSource).toContain('setPaused(true);');
  });

  it('reads cancellation state, prioritizes recent meetings, and separates the staff desk', () => {
    expect(serviceSource).toContain("'id,chapter_id,title,summary,starts_at,ends_at,event_kind,event_date,series_id,check_in_offered,rsvp_open,sort_at,location,order_index,cancelled_at,cancelled_reason'");
    expect(serviceSource).toContain("rows('member_events', 'id,chapter_id,title,summary,starts_at,ends_at,event_kind,event_date,series_id,check_in_offered,rsvp_open,sort_at,location,order_index,cancelled_at,cancelled_reason', 'sort_at', true, 'id', undefined, LEGACY_EVENT_COLUMNS)");
    expect(serviceSource).toContain('cancelled: event.cancelled_at != null');
    expect(screenSource).toContain("featureKey === 'events-desk' ? <LiveEventsScreen staffDesk sourceID={sourceID} /> : <LiveEventsScreen sourceID={sourceID} />");
    expect(screenSource).toContain("function LiveEventsScreen({ staffDesk = false, sourceID }");
    expect(screenSource).toContain("status={event.cancelled ? 'Cancelled' : event.eventKind && event.eventKind !== 'meeting' ? eventTypeText(eventLanguage, event.eventKind) : event.checkedInAt ? 'Checked in'");
  });

  it('renders nullable task dates honestly and keeps the committee member audit write non-blocking', () => {
    expect(serviceSource).toContain("startDate: task.start_date == null ? null : String(task.start_date)");
    expect(serviceSource).toContain("dueDate: task.due_date == null ? null : String(task.due_date)");
    expect(screenSource).toContain("const schedule = task.startDate || task.dueDate");
    expect(serviceSource).toContain('This row is audit-only');
  });

  it('surfaces the seeded campaign record archive instead of dropping it', () => {
    expect(serviceSource).toContain("rows('chapter_records', 'id,record_type,title,body,occurred_at,archived_at', 'occurred_at')");
    expect(screenSource).toContain('Records · {data.records.length}');
    expect(screenSource).toContain('data.records.map((item)');
  });

  it('excludes retracted broadcast bodies at the database boundary', () => {
    expect(serviceSource).toContain("rows('member_broadcasts', 'id,sender,title,body,published_at,order_index', 'published_at', false, 'id', 'retracted_at')");
    expect(serviceSource).not.toContain('broadcasts.filter((broadcast) => !broadcast.retracted_at)');
  });

  it('says what is loading instead of describing authorization checks', () => {
    const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
    const sources = [
      screenSource,
      featureSource,
      read('../../app/issue/[id].tsx'),
      read('../../app/conversation/[id].tsx'),
      read('../features/StewardFinderSheet.tsx'),
      read('../features/OrgStructureScreen.tsx'),
      read('../features/WorkScreen.tsx'),
    ];
    for (const source of sources) {
      expect(source).not.toContain('Checking your current authorization');
      expect(source).not.toContain('Rechecking your campaign and role');
      expect(source).not.toContain('authorized history');
      expect(source).not.toContain('authorized meetings');
      expect(source).not.toContain('authorized issue work is on its way');
    }
    expect(screenSource).toContain('{task.priority.charAt(0).toLocaleUpperCase()}{task.priority.slice(1)}');
  });

  it('keeps complete workload and itemized contribution histories reachable', () => {
    expect(screenSource).not.toContain('data.logs.slice(0, 30)');
    expect(screenSource).toContain('data.logs.map((log)');
    expect(screenSource).toContain('acknowledgements={data.events.map((event) => ({ id: event.id, recognitionKind: event.recognitionKind, sourceLabel: event.sourceLabel, dateLabel: formatDay(event.occurredAt) }))}');
    expect(screenSource).toContain('acknowledgements.map((item) => (');
    expect(screenSource).not.toMatch(/Ledger ·|\} points|week streak/);
  });

  it('names reward ledger rows with the web ledger labels, never a raw kind', () => {
    expect(rewardKindLabel('vote')).toBe('Vote cast');
    expect(rewardKindLabel('survey')).toBe('Pulse survey');
    expect(rewardKindLabel('checkin')).toBe('Meeting check-in');
    expect(rewardKindLabel('create_standard_task')).toBe('Create standard task');
    expect(rewardKindLabel('')).toBe('Confirmed action');
    // Contributions lists acknowledgements by recognition kind; it has no ledger.
    expect(screenSource).not.toContain("event.kind.replaceAll('_', ' ')");
  });

  it('allows a new committee member request after the prior request is closed', () => {
    expect(screenSource).toContain("status === 'requested' || status === 'acknowledged'");
    expect(screenSource).not.toContain('Boolean(lesson.requestStatus)');
    expect(serviceSource).toContain(".from('member_steward_requests').select('id,lesson_id,status,created_at').eq('user_id', userID)");
  });

  it('keeps verification and access-check wording out of demo-path state copy', () => {
    const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
    const sources = [
      screenSource,
      featureSource,
      read('../../app/(tabs)/home.tsx'),
      read('../components/HomeCarousel.tsx'),
      read('../features/WorkScreen.tsx'),
      read('../features/LiveAppointmentsFeature.tsx'),
      read('../features/MemberSupportScreen.tsx'),
      read('../features/OrgStructureScreen.tsx'),
      read('../features/PulseScreen.tsx'),
      read('../features/MemberPulseScreen.tsx'),
      read('../features/StewardPulseScreen.tsx'),
      read('../features/LeadershipPulseScreen.tsx'),
      read('../features/SavedPulseCharts.tsx'),
    ];
    for (const source of sources) {
      expect(source).not.toContain('Securely loading');
      expect(source).not.toContain('Weekly history could not be verified');
      expect(source).not.toContain('Loading your authorized figures');
      expect(source).not.toContain('no longer available to this session');
      expect(source).not.toContain('authorized reader');
      expect(source).not.toContain('authorized staff person');
      expect(source).not.toContain('Stripe is not connected');
    }
    expect(featureSource).toContain('title={`${title} is not open to your role`}');
  });

  it('offers in-place retry on every lived-in loader failure', () => {
    expect(screenSource).toContain('function LoadError({ message, onRetry }');
    expect(screenSource).toContain('<Button label="Try again" onPress={onRetry} />');
    expect(screenSource.match(/<LoadError message=.* onRetry=/g)).toHaveLength(4);
    expect(screenSource).toContain('setRightsReload((value) => value + 1)');
    expect(screenSource).toContain('setChapterReload((value) => value + 1)');
  });

  it('does not retain a dead lived-in feature export', () => {
    expect(screenSource).not.toContain('AUTHENTICATED_LIVED_IN_FEATURES');
  });

  // get_steward_appointments returns camelCase jsonb (src/data/fallback.js
  // stewardApptDesk); list_steward_appointments pages are snake_case rows
  // (src/lib/memberApi.js loadStewardAppointmentsPage).
  const stewardDeskPayload = {
    schedule: { timezone: 'America/New_York', minNoticeMinutes: 240, bufferBeforeMinutes: 10, bufferAfterMinutes: 10, maxPerDay: 6, accepting: true },
    windows: [{ id: 'win-1', weekday: 2, startMinute: 540, endMinute: 720 }],
    blackouts: [{ id: 'blk-1', startDate: '2026-09-01', endDate: '2026-09-03' }],
    connections: [{ id: 'conn-1', provider: 'google', status: 'active', accountLabel: 'chapter@example.org' }],
    upcoming: [
      { id: 'sappt-1', memberName: 'Jordan Mills', type: 'grievance_followup', durationMinutes: 30, startsAt: '2026-09-22T13:30:00Z', endsAt: '2026-09-22T14:00:00Z', place: 'Boston office · Room 204', status: 'confirmed', reasonCategory: 'discipline', routedVia: 'steward' },
    ],
    recent: [
      { id: 'sappt-2', memberName: 'Ava Ramos', type: 'office_hours', durationMinutes: 20, startsAt: '2026-09-10T15:00:00Z', status: 'completed' },
    ],
    stats: { noShows30d: 1, completed30d: 4 },
  };
  const stewardPageRows = [
    { id: 'sappt-3', member_name: 'Theo Nguyen', appointment_type: 'onboarding', duration_minutes: 20, starts_at: '2026-09-05T14:00:00Z', ends_at: '2026-09-05T14:20:00Z', place: 'Zoom onboarding', status: 'completed', reason_category: null, routed_via: 'chapter' },
  ];

  function mockStewardAppointmentsClient() {
    const rpc = vi.fn(async (name: string) => {
      if (name === 'get_steward_appointments') return { data: stewardDeskPayload, error: null };
      if (name === 'list_steward_appointments') return { data: stewardPageRows, error: null };
      return { data: null, error: new Error(`unexpected rpc ${name}`) };
    });
    const from = vi.fn(() => {
      throw new Error('from() must not be called on the committee member one-on-ones path');
    });
    vi.mocked(getSupabaseClient).mockReturnValue({ rpc, from } as never);
    return { rpc, from };
  }

  it('loads the committee member one-on-ones desk from the committee member RPCs and never member_cases', async () => {
    const { rpc, from } = mockStewardAppointmentsClient();
    const desk = await loadMobileStewardAppointmentsDesk();
    expect(rpc).toHaveBeenCalledWith('get_steward_appointments');
    expect(from).not.toHaveBeenCalled();
    expect(desk.upcoming).toEqual([
      { id: 'sappt-1', memberName: 'Jordan Mills', type: 'grievance_followup', durationMinutes: 30, startsAt: '2026-09-22T13:30:00Z', endsAt: '2026-09-22T14:00:00Z', place: 'Boston office · Room 204', status: 'confirmed', reasonCategory: 'discipline', routedVia: 'steward' },
    ]);
    expect(desk.recent[0]?.endsAt).toBeNull();
    expect(desk.outcomes).toEqual({ completed30d: 4, noShows30d: 1 });
    expect(desk.availability).toEqual({
      timezone: 'America/New_York', accepting: true, minNoticeMinutes: 240,
      windows: [{ id: 'win-1', weekday: 2, startMinute: 540, endMinute: 720 }],
      blackouts: [{ id: 'blk-1', startDate: '2026-09-01', endDate: '2026-09-03' }],
    });
    expect(desk.connections).toEqual([{ id: 'conn-1', provider: 'google', status: 'active', accountLabel: 'chapter@example.org' }]);

    const page = await loadMobileStewardAppointmentsPage('recent', null, 25);
    expect(rpc).toHaveBeenCalledWith('list_steward_appointments', { p_scope: 'recent', p_after_starts: null, p_after_id: null, p_limit: 25 });
    expect(from).not.toHaveBeenCalled();
    expect(page.rows[0]).toMatchObject({ id: 'sappt-3', memberName: 'Theo Nguyen', type: 'onboarding', startsAt: '2026-09-05T14:00:00Z', endsAt: '2026-09-05T14:20:00Z' });
    expect(page.nextCursor).toBeNull();

    const paged = await loadMobileStewardAppointmentsPage('upcoming', { startsAt: '2026-09-05T14:00:00Z', id: 'sappt-3' }, 1);
    expect(rpc).toHaveBeenCalledWith('list_steward_appointments', { p_scope: 'upcoming', p_after_starts: '2026-09-05T14:00:00Z', p_after_id: 'sappt-3', p_limit: 1 });
    expect(from).not.toHaveBeenCalled();
    expect(paged.nextCursor).toEqual({ startsAt: '2026-09-05T14:00:00Z', id: 'sappt-3' });
  });

  it('refuses an unauthorized staff scope before any committee member one-on-ones RPC', () => {
    // The live screen applies the same staff-scope gate FeatureScreen checks
    // and only invokes the desk loader after the gate passes, so an
    // unauthorized session renders the refusal state and issues no RPC.
    expect(screenSource).toContain("canOpenFeature('authenticated', 'steward-appointments', null, chapterRoles, organizationRoles)");
    const gate = screenSource.indexOf('if (!stewardAppointmentsAuthorized)');
    const load = screenSource.indexOf('loadMobileStewardAppointmentsDesk()');
    expect(gate).toBeGreaterThan(-1);
    expect(load).toBeGreaterThan(gate);
    // A completed desk failure must not keep the loading card mounted.
    expect(screenSource).toContain('{error ? <Card><Body style={{ color: theme.destructive }}>The committee member one-on-one desk could not be refreshed through your current campaign authorization.</Body><Button label="Try again" onPress={() => setReload((value) => value + 1)} /></Card> : desk === null ? <Loading title="Loading committee member one-on-ones" /> : <>');
  });

  it('gives the staff Meetings desk the committee member scan workflow without touching worker check-in', () => {
    // The scan service calls only scan_event_checkin with the selected event
    // id and the entered token, and never the member check_in_to_event RPC.
    const scanService = serviceSource.slice(serviceSource.indexOf('export async function scanMobileEventCheckin'), serviceSource.indexOf('export async function loadMobileContributions'));
    expect(scanService).toContain("rpc('scan_event_checkin', { p_event_id: eventID, p_token: token.trim() })");
    expect(scanService).not.toContain('check_in_to_event');
    // A proven success requires checkedIn, a named member identity, the
    // already-on-file boolean, and finite point counts; anything else throws.
    expect(scanService).toContain('row.checkedIn !== true');
    expect(scanService).toContain('memberUserID == null');
    expect(scanService).toContain('memberName == null');
    expect(scanService).toContain("typeof row.alreadyCheckedIn !== 'boolean'");
    expect(scanService).toContain('details: \'scan_code_invalid\'');
  });

  it('renders the scan control only for an authorized committee member on the staff desk', () => {
    // Authorization comes from the loaded staff scope; without a steward grant
    // the desk renders no scan control and the handler refuses before any RPC.
    expect(screenSource).toContain("const { captureAuthenticatedSessionGuard, authorizedRoles, dashboard, mode, sampleHat, liveSampleBackend } = useApp();");
    expect(screenSource).toContain("const stewardScanAllowed = staffDesk && authorizedRoles.includes('steward');");
    expect(screenSource).toContain('if (!stewardCanScan(event)) return;');
    // The staff scan branch submits the selected event and the entered code to
    // the scan service, names the member, and distinguishes both result variants.
    expect(screenSource).toContain('accessibilityLabel={`Worker check-in code for ${event.title}`}');
    expect(screenSource).toContain('<Button label="Scan check-in"');
    expect(screenSource).toContain('await scanMobileEventCheckin(writer, event.id, code[event.id] ?? \'\')');
    expect(screenSource).toContain('`${name} already has a check-in on file for this meeting.`');
    expect(screenSource).toContain('`${name} is checked in.`');
    // The scan reply still carries the RPC's award fields, but no points are shown.
    expect(screenSource).not.toContain('memberAwardedPoints');
    expect(screenSource).toContain('const copy = scanCheckinRefusalCopy(error);');
    expect(screenSource).toContain('delete next[event.id]; return next; });');
    // Member RSVP and self-check-in controls stay gated on !staffDesk, and the
    // member path still calls only checkInMobileEvent (check_in_to_event).
    expect(screenSource).toContain('{!staffDesk && !event.cancelled && upcoming && event.rsvpOpen !== false ? <View accessibilityRole="radiogroup"');
    expect(screenSource).toContain('{!staffDesk && !event.cancelled && checkInOpen && !event.checkedInAt ? <View style={styles.inline}>',
    );
    expect(screenSource).toContain('await checkInMobileEvent(writer, event.id, code[event.id] ?? \'\')');
    expect(screenSource.indexOf('scanMobileEventCheckin(writer, event.id')).toBeGreaterThan(screenSource.indexOf('checkInMobileEvent(writer, event.id'));
  });

  it('retires a stale scan confirmation on the next attempt and announces the result', () => {
    // A rejected token must never sit beside the previous success for the
    // same event: the prior result clears when a new attempt begins (the
    // failure path then has nothing left to retire).
    expect(screenSource).toContain('delete next[event.id]; return next;');
    // The outcome speaks through the established announcement path: a polite
    // live region for TalkBack, plus the queued VoiceOver announcement on iOS.
    // The queue is the desk's own (owned attempt identity, cancelled on
    // unmount), not a bare platform call — the Q19 ownership contract.
    expect(screenSource).toContain('accessibilityLiveRegion="polite"><Body>{scanResultCopy(scanResults[event.id]!)}</Body>');
    expect(screenSource).toContain("import { useAccessibilityAnnouncementQueue } from '../lib/announce';");
    expect(screenSource).toContain("if (Platform.OS === 'ios') queueScanAnnouncement(copy);");
    // Refusals use the same pair: the global error Card is a live region, and
    // the catch announces the mapped copy on iOS.
    expect(screenSource).toContain('accessibilityLiveRegion="polite"><Body style={{ color: theme.destructive }}>{error}</Body>');
    expect(screenSource).toContain('const copy = scanCheckinRefusalCopy(error);');
    expect(screenSource).toContain('setError(copy);');
  });

  it('offers the scan control only for meetings in the committee member\'s own campaign', () => {
    // member_events_select_scoped also returns public and cross-agency events
    // owned by other chapters, but scan_event_checkin requires the event's
    // chapter to equal the caller's. The feed therefore carries the owning
    // chapter so the desk can hide a scanner that could only ever refuse.
    const loader = serviceSource.slice(
      serviceSource.indexOf('export async function loadMobileEventsHistory'),
      serviceSource.indexOf('export async function prepareAuthorizedEventCalendarExport'),
    );
    expect(loader).toContain("rows('member_events', 'id,chapter_id,title,");
    expect(loader).toContain("chapterID: typeof event.chapter_id === 'string' ? event.chapter_id : null");
    // The gate compares that chapter with the signed-in member's own chapter
    // (member_profiles.chapter_id, the same value scan_event_checkin locks),
    // and both the control and the result line hang off it.
    expect(screenSource).toContain('const stewardChapterID = dashboard?.member.chapterID ?? null;');
    expect(screenSource).toContain(
      "return stewardScanAllowed && stewardChapterID !== null && event.chapterID === stewardChapterID;",
    );
    expect(screenSource).toContain('const scanAllowedHere = stewardCanScan(event);');
    expect(screenSource).toContain('{scanAllowedHere && !event.cancelled && checkInOpen ?');
    expect(screenSource).toContain('{scanAllowedHere && scanResults[event.id] ?');
    expect(screenSource).not.toContain('{stewardScanAllowed && !meeting.cancelled && checkInOpen ?');
  });

  it('clears the consumed token after a successful scan', () => {
    const successBranch = screenSource.slice(
      screenSource.indexOf('const result = await scanMobileEventCheckin'),
      screenSource.indexOf('} catch (error) {'),
    );
    expect(successBranch).toContain('delete next[event.id]; return next;');
    expect(successBranch).toContain('setCode((current) =>');
  });
});

describe('scan_event_checkin client contract', () => {
  beforeEach(() => {
    rpc.mockReset();
    vi.mocked(getSupabaseClient).mockImplementation(() => ({ rpc }) as never);
  });

  it('maps stable RPC detail tokens onto actionable committee member copy', () => {
    expect(scanCheckinRefusalCopy({ details: 'checkin_not_offered' })).toBe('This meeting has no check-in.');
    expect(scanCheckinRefusalCopy({ details: 'scan_code_used' })).toBe('That code has already been used.');
    expect(scanCheckinRefusalCopy({ details: 'scan_code_self' })).toBe("You can't scan your own check-in code.");
    expect(scanCheckinRefusalCopy({ details: 'scan_event_cancelled' })).toBe('This meeting was cancelled, so check-in is closed.');
    expect(scanCheckinRefusalCopy({ details: 'scan_not_steward' })).toBe('A current committee role and required two-step sign-in are needed to scan.');
    expect(scanCheckinRefusalCopy({ details: 'scan_code_expired' })).toBe('That code expired. Ask the worker to refresh it.');
    expect(scanCheckinRefusalCopy({ details: ' scan_code_invalid ' })).toBe('That code is invalid or no longer available.');
    expect(scanCheckinRefusalCopy({ details: 'scan_code_missing' })).toBe("Enter the worker's check-in code.");
    expect(scanCheckinRefusalCopy(new Error('raw'))).toBe('That check-in code was not accepted. Ask the worker to refresh it.');
  });

  it('returns a proven scan row and rejects a null or incomplete success payload', async () => {
    rpc.mockResolvedValueOnce({
      data: {
        memberUserId: 'member-1',
        memberName: 'Ada Worker',
        checkedIn: true,
        alreadyCheckedIn: false,
        memberAwardedPoints: 5,
        scannerAwardedPoints: 1,
      },
      error: null,
    });
    await expect(scanMobileEventCheckin(businessWriter, 'event-1', ' TOKEN ')).resolves.toEqual({
      memberUserID: 'member-1',
      memberName: 'Ada Worker',
      checkedIn: true,
      alreadyCheckedIn: false,
      memberAwardedPoints: 5,
      scannerAwardedPoints: 1,
    });
    expect(rpc).toHaveBeenCalledWith('scan_event_checkin', { p_event_id: 'event-1', p_token: 'TOKEN' });

    rpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(scanMobileEventCheckin(businessWriter, 'event-1', 'TOKEN')).rejects.toMatchObject({ details: 'scan_code_invalid' });

    rpc.mockResolvedValueOnce({
      data: { memberUserId: 'member-1', memberName: 'Ada Worker', alreadyCheckedIn: false, memberAwardedPoints: 0, scannerAwardedPoints: 0 },
      error: null,
    });
    await expect(scanMobileEventCheckin(businessWriter, 'event-1', 'TOKEN')).rejects.toMatchObject({ details: 'scan_code_invalid' });
  });
});

// Shapes PostgREST returns for the refusals rsvp_to_event and check_in_to_event
// raise (supabase/migrations/20260901153739_event_organization_isolation.sql;
// rsvp_to_event's past-event guard is 20260925250100_event_rsvp_time_window.sql).
const assuranceRefusal = { code: '42501', message: 'authentication required', details: null };
const cancelledRefusal = { code: '22023', message: 'this meeting was cancelled', details: 'event_cancelled' };
const pastRefusal = { code: '22023', message: 'this meeting is in the past', details: 'event_past' };
const outOfScopeRefusal = { code: '22023', message: 'event not found', details: null };
const windowRefusal = { code: '22023', message: 'check-in is only open around the meeting start time', details: null };
const wrongCodeRefusal = { code: '22023', message: 'invalid check-in code', details: null };

describe('worker meeting action refusals', () => {
  beforeEach(() => {
    rpc.mockReset();
    vi.mocked(getSupabaseClient).mockReturnValue({ rpc } as never);
  });

  it('reports removed check-in without recommending an absent code', async () => {
    const refusal = { code: '22023', message: 'this meeting has no check-in', details: 'checkin_not_offered' };
    rpc.mockResolvedValue({ data: null, error: refusal });
    await expect(checkInMobileEvent(businessWriter, 'event-1', 'CODE')).rejects.toMatchObject(refusal);
    expect(describeEventActionRefusal(refusal, 'check-in')).toBe('This meeting has no check-in.');
  });

  it('carries the check_in_to_event refusal SQLSTATE back to the caller', async () => {
    rpc.mockResolvedValue({ data: null, error: assuranceRefusal });

    await expect(checkInMobileEvent(businessWriter, 'event-1', 'CODE')).rejects.toMatchObject({ code: '42501' });
    expect(rpc).toHaveBeenCalledWith('check_in_to_event', { p_event_id: 'event-1', p_code: 'CODE' });
  });

  // SEC-UG-EVENT-CHECKIN-CODE-UNBOUNDED-GUESSES-20260920: a wrong code and
  // a lockout are one returned payload; the service throws it in the refusal
  // shape so the member reads the same sentence and nothing retries.
  it('throws the check_in_to_event refusal payload as the wrong-code refusal', async () => {
    rpc.mockResolvedValue({ data: { checkedIn: false, refused: true, code: '22023', message: 'invalid check-in code' }, error: null });

    await expect(checkInMobileEvent(businessWriter, 'event-1', 'CODE')).rejects.toMatchObject(wrongCodeRefusal);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(describeEventActionRefusal({ code: '22023', message: 'invalid check-in code', details: null }, 'check-in'))
      .toBe('That check-in code did not match. Confirm it with the meeting organizer.');
  });

  it('resolves a successful check_in_to_event payload without throwing', async () => {
    rpc.mockResolvedValue({ data: { checkedIn: true, alreadyCheckedIn: false, awardedPoints: 50 }, error: null });
    await expect(checkInMobileEvent(businessWriter, 'event-1', 'CODE')).resolves.toBeUndefined();
  });

  it('carries the rsvp_to_event refusal detail back to the caller', async () => {
    rpc.mockResolvedValue({ data: null, error: cancelledRefusal });

    await expect(setMobileEventRsvp(businessWriter, 'event-1', 'going')).rejects.toMatchObject({ details: 'event_cancelled' });
    expect(rpc).toHaveBeenCalledWith('rsvp_to_event', { p_event_id: 'event-1', p_status: 'going' });
  });

  it('names two-step verification instead of blaming the check-in code', () => {
    const sentence = describeEventActionRefusal(assuranceRefusal, 'check-in');

    expect(sentence).toBe('Check-in needs two-step verification. Confirm it for this session, then check in again.');
    expect(sentence).not.toMatch(/code/i);
    expect(describeEventActionRefusal(assuranceRefusal, 'rsvp'))
      .toBe('That RSVP needs two-step verification. Confirm it for this session, then try again.');
  });

  it('separates a cancelled meeting, a past meeting, an out-of-scope meeting, a closed window, and a wrong code', () => {
    expect(describeEventActionRefusal(cancelledRefusal, 'check-in')).toBe('This meeting was cancelled, so check-in is closed.');
    expect(describeEventActionRefusal(cancelledRefusal, 'rsvp')).toBe('This meeting was cancelled, so RSVPs are closed.');
    expect(describeEventActionRefusal(pastRefusal, 'rsvp')).toBe('This meeting has already started, so RSVPs are closed.');
    expect(describeEventActionRefusal(outOfScopeRefusal, 'check-in')).toBe('That meeting is no longer available to your account.');
    expect(describeEventActionRefusal(outOfScopeRefusal, 'rsvp')).toBe('That meeting is no longer available to your account.');
    expect(describeEventActionRefusal(windowRefusal, 'check-in'))
      .toBe('Check-in opens two hours before the meeting and closes four hours after it starts.');
    expect(describeEventActionRefusal(wrongCodeRefusal, 'check-in'))
      .toBe('That check-in code did not match. Confirm it with the meeting organizer.');
  });

  // BUG-UG-NATIVE-EVENTS-IGNORE-RSVP-SWITCH-20261106: the trigger's
  // refusal for an event staff closed to RSVPs fell through to the generic line.
  it('tells the worker a meeting is not collecting RSVPs', async () => {
    const closedRefusal = { code: '22023', message: 'this meeting is not collecting RSVPs', details: 'rsvp_closed' };
    rpc.mockResolvedValue({ data: null, error: closedRefusal });
    await expect(setMobileEventRsvp(businessWriter, 'event-1', 'going')).rejects.toMatchObject({ details: 'rsvp_closed' });
    expect(describeEventActionRefusal(closedRefusal, 'rsvp')).toBe('This meeting is not collecting RSVPs.');
    expect(describeEventActionRefusal({ code: '22023', message: 'refused', details: 'rsvp_closed' }, 'rsvp')).toBe('This meeting is not collecting RSVPs.');
  });

  it('keeps the previous sentences for an unrecognized failure', () => {
    for (const failure of [new Error('network request failed'), 'offline', null, undefined]) {
      expect(describeEventActionRefusal(failure, 'check-in')).toBe('Check-in was not confirmed. Check the meeting time and code.');
      expect(describeEventActionRefusal(failure, 'rsvp')).toBe('That RSVP was not confirmed.');
    }
  });

  it('routes both events-screen handlers through the refusal mapper', () => {
    expect(screenSource).toContain("catch (refusal) { setError(describeEventActionRefusal(refusal, 'rsvp')); }");
    expect(screenSource).toContain("catch (refusal) { setError(describeEventActionRefusal(refusal, 'check-in')); }");
    expect(screenSource).not.toContain("catch { setError('That RSVP was not confirmed.'); }");
    expect(screenSource).not.toContain("catch { setError('Check-in was not confirmed. Check the meeting time and code.'); }");
  });
});

it('reads a date-only item and joins attendance independently for each occurrence', async () => {
  vi.mocked(getSupabaseClient).mockReturnValue({ rpc, from } as never);
  const tables: Record<string, unknown[]> = {
    member_events: [
      { id: 'first', title: 'Meeting', starts_at: '2027-01-31T15:00:00Z', ends_at: '2027-01-31T16:00:00Z', event_kind: 'meeting', series_id: 'series', check_in_offered: true },
      { id: 'second', title: 'Meeting', starts_at: '2027-02-28T15:00:00Z', event_kind: 'meeting', series_id: 'series', check_in_offered: true },
      { id: 'deadline', title: 'Submit', starts_at: null, event_kind: 'deadline', event_date: '2027-02-01', check_in_offered: false },
    ],
    member_event_rsvps: [{ event_id: 'first', status: 'going' }], member_event_checkins: [],
  };
  from.mockImplementation((table: string) => {
    const query = { select: vi.fn(() => query), order: vi.fn(() => query), range: vi.fn(async () => ({ data: tables[table], error: null })) };
    return query;
  });
  const result = await loadMobileEventsHistory();
  expect(result[0]).toMatchObject({ endsAt: '2027-01-31T16:00:00Z', rsvp: 'going' });
  expect(result.map((event) => event.id)).toEqual(['first', 'deadline', 'second']);
  expect(result[2]?.rsvp).toBeNull();
  expect(result[1]).toMatchObject({ startsAt: '', eventDate: '2027-02-01', eventKind: 'deadline', checkInOffered: false });
  expect(screenSource).toContain('eventWhenLabel(event, eventLanguage)');
});


it.each(['42703', 'PGRST204'])('retries native meeting history against the legacy schema once: %s', async (code) => {
  const calls: { table: string; columns: string; orders: string[] }[] = [];
  const mockFrom = (table: string) => {
    const call = { table, columns: '', orders: [] as string[] };
    calls.push(call);
    const query = {
      select(columns: string) { call.columns = columns; return query; },
      order(column: string) { call.orders.push(column); return query; },
      async range() {
        return table === 'member_events' && call.columns.includes('event_kind')
          ? { data: null, error: { code, message: 'column member_events.event_kind does not exist' } }
          : { data: table === 'member_events' ? [{ id: 'legacy', title: 'Legacy meeting', starts_at: '2027-01-01T15:00:00Z' }] : [], error: null };
      },
    };
    return query;
  };
  vi.mocked(getSupabaseClient).mockReturnValue({ rpc, from: mockFrom } as never);
  try {
    const events = await loadMobileEventsHistory();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: 'legacy', endsAt: null, eventDate: null, seriesId: null, checkInOffered: false });
    expect(calls.filter((call) => call.table === 'member_events')).toHaveLength(2);
    expect(calls[3]?.orders).toEqual(['starts_at', 'id']);
    expect(calls[3]?.columns).not.toMatch(/ends_at|event_kind|event_date|series_id|sort_at|check_in_offered/);
  } finally { vi.mocked(getSupabaseClient).mockReturnValue({ rpc, from } as never); }
});

it('anchors the native header date range at local noon for date-only entries', () => {
  expect(screenSource).toContain('item.eventDate ? `${item.eventDate}T12:00:00` : item.startsAt');
});
