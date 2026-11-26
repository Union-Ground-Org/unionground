import { stubSessionWriter } from '../testing/stubSessionWriter';
import { describe, expect, it, vi } from 'vitest';
import { canReadConnections, connectionDraft, connectionScopeKey, initialConnectionSettings, normalizeConnectionProfile, validConnectionDraft,
  rankNativeConnections, type ConnectionActor } from '../lib/connectionSuggestionsShared';
import { connectionFailureState, createMobileConnectionAdapter, normalizeConnectionWorkspace } from './chapterConnections';

const actor: ConnectionActor = { userId: 'person-a', organizationId: 'org-a', chapterId: 'chapter-a', selectedHat: 'admin',
  organizationRoles: ['admin'], chapterRoles: [], membershipStatus: 'active', mfaSatisfied: true };
const publishedAt = '2026-09-28T12:00:00Z';
const profile = (id: string, country = 'US') => ({ id, kind: 'chapter', displayName: id,
  publication: { status: 'published', publishedAt }, location: { country, state: 'MA', metro: 'Boston' },
  sectorKeys: ['care'], issuePriorities: [{ key: 'staffing', strength: 1 }], expertiseOffered: ['staffing'] });
const workspace = () => ({ organizationId: actor.organizationId, chapterId: actor.chapterId, profile: profile('chapter-a'),
  draft: connectionDraft({ location: { country: 'US', state: 'MA', metro: 'Boston' }, declaredIssueKeys: ['staffing'] }),
  canPublish: true, chapters: [{ id: actor.chapterId, name: 'Campaign A' }], hiddenChapterIds: [], analysis: {} });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

describe('native campaign connection backend contract', () => {
  it('requests a handshake with an exact campaign target and rejects mismatched receipts or actor scope', async () => {
    const fields: { title: string; purpose: string; dataScope: 'docs_only'; idempotencyKey: string } = { title: ' Training ', purpose: ' Share approved lessons ', dataScope: 'docs_only', idempotencyKey: 'stable-request-key' };
    const rpc = vi.fn(async () => ({ data: { id: 'request-id', status: 'requested', chapter_id: 'chapter-a', receiving_chapter_id: 'chapter-b' }, error: null }));
    const adapter = createMobileConnectionAdapter(stubSessionWriter(() => ({ rpc })), { rpc }, actor);
    await adapter.requestHandshake('chapter-a', 'chapter-b', fields);
    expect(rpc).toHaveBeenCalledWith('request_chapter_connection_handshake', { p_selected_hat: 'admin', p_chapter_id: 'chapter-a',
      p_target_chapter_id: 'chapter-b', p_title: 'Training', p_purpose: 'Share approved lessons', p_data_scope: 'docs_only', p_idempotency_key: 'stable-request-key' });
    await expect(adapter.requestHandshake('wrong-source', 'chapter-b', fields)).rejects.toThrow('connection_chapter_changed');
    await expect(createMobileConnectionAdapter(stubSessionWriter(() => ({ rpc })), { rpc }, { ...actor, mfaSatisfied: false }).requestHandshake('chapter-a', 'chapter-b', fields)).rejects.toMatchObject({ code: '42501' });
    expect(rpc).toHaveBeenCalledTimes(1);
    rpc.mockResolvedValue({ data: { id: 'request-id', status: 'requested', chapter_id: 'chapter-a', receiving_chapter_id: 'wrong-target' }, error: null });
    await expect(adapter.requestHandshake('chapter-a', 'chapter-b', fields)).rejects.toThrow('invalid_handshake_response');
  });

  it.each(['accepted', 'active', 'declined', 'closed', 'unknown', 'draft'])('validates replay lifecycle status %s through the shared contract', async (status) => {
    const rpc = vi.fn(async () => ({ data: { id: 'request-id', status, chapter_id: 'chapter-a', receiving_chapter_id: 'chapter-b' }, error: null }));
    const result = createMobileConnectionAdapter(stubSessionWriter(() => ({ rpc })), { rpc }, actor).requestHandshake('chapter-a', 'chapter-b', {
      title: 'Training', purpose: 'Approved lessons', dataScope: 'no_member_data', idempotencyKey: 'stable-key',
    });
    if (['unknown', 'draft'].includes(status)) await expect(result).rejects.toThrow('invalid_handshake_response');
    else await expect(result).resolves.toMatchObject({ id: 'request-id', status });
  });

  it.each(['', ' ', 'bad/id', 'a'.repeat(161), 17, null])('rejects the entire workspace for malformed hidden identifier %j', async (id) => {
    const rpc = vi.fn(async () => ({ data: { ...workspace(), hiddenChapterIds: ['valid-chapter', id] }, error: null }));
    await expect(createMobileConnectionAdapter(stubSessionWriter(() => ({ rpc })), { rpc }, actor).load(new AbortController().signal)).rejects.toThrow('invalid_connection_hidden_ids');
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('requires a complete explicit draft for an existing publication and never converts catalog identities to declarations', () => {
    const response = { ...workspace(), profile: { ...profile('chapter-a'), localKey: 'catalog-local', unionFamilyKey: 'catalog-union' } };
    expect(() => normalizeConnectionWorkspace({ ...response, draft: null })).toThrow('invalid_connection_draft');
    expect(() => normalizeConnectionWorkspace({ ...response, draft: { declaredIssueKeys: [] } })).toThrow('invalid_connection_draft');
    expect(normalizeConnectionWorkspace(response).draft).toMatchObject({ declaredLocalKey: null, declaredUnionFamilyKey: null });
    expect(normalizeConnectionWorkspace({ ...response, draft: { ...response.draft, declaredLocalKey: 'declared-local', declaredUnionFamilyKey: 'declared-union' } }).draft)
      .toMatchObject({ declaredLocalKey: 'declared-local', declaredUnionFamilyKey: 'declared-union' });
  });

  it('allows only known aggregate issue topics into native rendering', () => {
    const result = normalizeConnectionWorkspace({ ...workspace(), analysis: { latest: { topics: [
      { key: 'staffing' }, { key: 'Private grievance narrative' }, { key: '<unsafe>' }, { key: 7 }, { key: 'pay' },
    ] } } });
    expect(result.analysis.latest?.topics).toEqual([{ key: 'staffing' }, { key: 'pay' }]);
  });
  it('scans every keyset page and can rank a best match after the thousandth profile', async () => {
    const candidates = Array.from({ length: 1251 }, (_, index) => ({ ...profile(`p${String(index).padStart(5, '0')}`, index === 1250 ? 'US' : 'CA'), sectorKeys: [] }));
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'get_chapter_connection_workspace') return { data: workspace(), error: null };
      const start = args.p_after_id ? candidates.findIndex((row) => row.id === args.p_after_id) + 1 : 0;
      const rows = candidates.slice(start, start + Number(args.p_limit));
      const complete = start + rows.length === candidates.length;
      return { data: { rows, complete, nextCursor: complete ? null : rows.at(-1)!.id, snapshotToken: publishedAt }, error: null };
    });
    const data = await createMobileConnectionAdapter(stubSessionWriter(() => ({ rpc })), { rpc }, actor).load(new AbortController().signal);
    expect(data.profiles).toHaveLength(1251);
    expect(rpc).toHaveBeenCalledTimes(7);
    for (const [, args] of rpc.mock.calls) {
      expect(args.p_selected_hat).toBe('admin'); expect(args.p_chapter_id).toBe('chapter-a');
      expect(args).not.toHaveProperty('organizationId'); expect(args).not.toHaveProperty('p_organization_id');
    }
    const settings = initialConnectionSettings();
    settings.weights = { location: 100, sector: 0, issues: 0, expertise: 0, local: 0, union: 0 };
    expect(rankNativeConnections(data, settings, Date.parse(publishedAt))?.results[0]?.id).toBe('p01250');
  });

  it('discards an old workspace response after cancellation before requesting candidates', async () => {
    const pending = deferred<{ data: unknown; error: null }>();
    const rpc = vi.fn(() => pending.promise);
    const controller = new AbortController();
    const load = createMobileConnectionAdapter(stubSessionWriter(() => ({ rpc })), { rpc }, actor).load(controller.signal);
    controller.abort(); pending.resolve({ data: workspace(), error: null });
    await expect(load).rejects.toThrow(); expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('supports the native AbortSignal polyfill that has no throwIfAborted method', async () => {
    const signal = { aborted: false };
    const rpc = vi.fn(async (name: string) => ({ data: name === 'get_chapter_connection_workspace' ? workspace()
      : { rows: [], complete: true, nextCursor: null, snapshotToken: 'snapshot' }, error: null }));
    await expect(createMobileConnectionAdapter(stubSessionWriter(() => ({ rpc })), { rpc }, actor).load(signal)).resolves.toMatchObject({ profiles: [] });
    signal.aborted = true;
    await expect(createMobileConnectionAdapter(stubSessionWriter(() => ({ rpc })), { rpc }, actor).load(signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it.each([{ organizationId: 'another-org' }, { chapterId: 'another-chapter', profile: profile('another-chapter') }])('rejects workspace scope drift: %j', async (change) => {
    const rpc = vi.fn(async () => ({ data: { ...workspace(), ...change }, error: null }));
    await expect(createMobileConnectionAdapter(stubSessionWriter(() => ({ rpc })), { rpc }, actor).load(new AbortController().signal)).rejects.toThrow('connection_scope_changed');
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('fails closed on unauthorized hats, missing MFA and inactive memberships', async () => {
    const rpc = vi.fn();
    for (const changed of [{ mfaSatisfied: false }, { membershipStatus: 'inactive' }, { selectedHat: 'vp' }, { organizationId: null }]) {
      const invalid = { ...actor, ...changed };
      expect(canReadConnections(invalid)).toBe(false);
      await expect(createMobileConnectionAdapter(stubSessionWriter(() => ({ rpc })), { rpc }, invalid).load(new AbortController().signal)).rejects.toMatchObject({ code: '42501' });
    }
    expect(rpc).not.toHaveBeenCalled();
    expect(canReadConnections({ ...actor, organizationRoles: [], chapterRoles: ['admin'] })).toBe(true);
  });

  it('uses all five write RPCs with exact scope and never sends local source text', async () => {
    const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({ data: {}, error: null }));
    const adapter = createMobileConnectionAdapter(stubSessionWriter(() => ({ rpc })), { rpc }, actor);
    const draft = connectionDraft({ location: { country: 'US' }, declaredIssueKeys: ['staffing'], rawText: 'private source', cohortCount: 50 });
    await adapter.save('chapter-a', draft);
    await adapter.withdraw('chapter-a');
    await adapter.reviewSource('chapter-a', 'grievance', ' aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa ', ['staffing']);
    await adapter.freezeIssues('chapter-a');
    await adapter.hide('chapter-a', 'chapter-b', true);
    expect(rpc.mock.calls).toEqual([
      ['save_chapter_connection_profile', { p_selected_hat: 'admin', p_chapter_id: 'chapter-a', p_profile: draft, p_publish: true }],
      ['withdraw_chapter_connection_profile', { p_selected_hat: 'admin', p_chapter_id: 'chapter-a' }],
      ['set_chapter_connection_source_tags', { p_selected_hat: 'admin', p_chapter_id: 'chapter-a', p_source_kind: 'grievance', p_source_id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', p_topic_keys: ['staffing'] }],
      ['freeze_chapter_connection_issue_aggregates', { p_selected_hat: 'admin', p_chapter_id: 'chapter-a' }],
      ['set_chapter_connection_hidden', { p_selected_hat: 'admin', p_chapter_id: 'chapter-a', p_target_chapter_id: 'chapter-b', p_hidden: true }],
    ]);
    expect(JSON.stringify(rpc.mock.calls)).not.toMatch(/rawText|private source|cohortCount/);
    await expect(adapter.withdraw('chapter-b')).rejects.toThrow('connection_chapter_changed');
  });

  it('classifies unavailable and authorization failures without a fixture fallback', async () => {
    expect(connectionFailureState({ code: 'PGRST202' })).toBe('unavailable');
    expect(connectionFailureState({ code: '42501' })).toBe('unauthorized');
    expect(connectionFailureState(new Error('offline'))).toBe('error');
    await expect(createMobileConnectionAdapter(stubSessionWriter(() => null), null, actor).load(new AbortController().signal)).rejects.toThrow('connection_service_unavailable');
  });
});

describe('native shared matching and scope behavior', () => {
  it('normalizes country/region codes and refuses a metro without its region', () => {
    expect(connectionDraft({ location: { country: ' us ', state: ' ma ', metro: 'Boston' } }).location)
      .toEqual({ country: 'US', state: 'MA', metro: 'Boston' });
    expect(validConnectionDraft(connectionDraft({ location: { country: 'US', metro: 'Boston' } }))).toBe(false);
    expect(validConnectionDraft(connectionDraft({ location: { country: 'US' } }))).toBe(true);
    expect(validConnectionDraft(connectionDraft({ location: { country: 'US', state: 'MA', metro: 'Boston' } }))).toBe(true);
  });
  it('resets on every identity or authority change, independent of role ordering', () => {
    const base = connectionScopeKey(actor, 'authenticated');
    for (const changed of [{ userId: 'other' }, { organizationId: 'other' }, { chapterId: 'other' }, { selectedHat: 'steward' },
      { organizationRoles: [] }, { chapterRoles: ['admin'] }, { membershipStatus: 'inactive' }, { mfaSatisfied: false }]) {
      expect(connectionScopeKey({ ...actor, ...changed }, 'authenticated')).not.toBe(base);
    }
    expect(connectionScopeKey(actor, 'preview')).not.toBe(base);
    expect(connectionScopeKey({ ...actor, organizationRoles: ['admin', 'advisor'] }, 'authenticated'))
      .toBe(connectionScopeKey({ ...actor, organizationRoles: ['advisor', 'admin'] }, 'authenticated'));
  });

  it('does not promote analyzed priorities to declarations or retain unknown profile fields', () => {
    const draft = connectionDraft({ issuePriorities: [{ key: 'safety', strength: 1 }], declaredIssueKeys: ['pay', 'unknown'],
      sourceText: 'private', shareAnalyzedIssues: true, sectorKeys: ['care', 'unknown'] });
    expect(draft.declaredIssueKeys).toEqual(['pay']); expect(draft.sectorKeys).toEqual(['care']);
    expect(draft).not.toHaveProperty('sourceText');
    expect(connectionDraft({ issuePriorities: [{ key: 'safety', strength: 1 }] }).declaredIssueKeys).toEqual([]);
  });

  it('keeps 100 displayed results reachable while the full catalog is considered', () => {
    const data = { workspace: normalizeConnectionWorkspace(workspace()), profiles: Array.from({ length: 137 }, (_, i) =>
      normalizeConnectionProfile({ ...profile(`row${String(i).padStart(3, '0')}`), discoverable: true, publishedAt })!) };
    const settings = initialConnectionSettings();
    expect(rankNativeConnections(data, settings, Date.parse(publishedAt), 13)?.results).toHaveLength(13);
    const result = rankNativeConnections(data, settings, Date.parse(publishedAt), 100);
    expect(result?.results).toHaveLength(100); expect(result?.scannedCount).toBe(137);
    const zero = rankNativeConnections(data, { ...settings, weights: { location: 0, sector: 0, issues: 0, expertise: 0, local: 0, union: 0 } }, Date.parse(publishedAt));
    expect(zero?.reason).toBe('needs_preferences'); expect(zero?.results).toEqual([]);
  });
});
