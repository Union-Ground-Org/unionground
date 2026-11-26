import {
  CONNECTION_ISSUE_TOPICS, canReadConnections, collectPublishedProfiles, connectionAbortSignal, connectionDraft, isConnectionHandshakeReceipt, matchingProfile, normalizeConnectionProfile,
  type ConnectionActor, type ConnectionData, type ConnectionDraft, type ConnectionProfile,
  type ConnectionSourceKind, type ConnectionWorkspace,
} from '../lib/connectionSuggestionsShared';
import type { MobileSessionWriter } from './supabase';

export type ConnectionRpcClient = {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
};
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_connection_response');
  return value as Record<string, unknown>;
};
const optionalObject = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function normalizeConnectionWorkspace(value: unknown): ConnectionWorkspace {
  const input = object(value);
  if (typeof input.organizationId !== 'string' || (input.chapterId !== null && typeof input.chapterId !== 'string')) throw new Error('invalid_connection_scope');
  const analysis = optionalObject(input.analysis);
  const latest = optionalObject(analysis.latest);
  const publicProfile = input.profile ? normalizeConnectionProfile(matchingProfile(input.profile)) : null;
  if (input.profile && !publicProfile) throw new Error('invalid_connection_profile');
  if (publicProfile && publicProfile.id !== input.chapterId) throw new Error('connection_chapter_changed');
  const draftInput = input.draft == null ? null : object(input.draft);
  // A published projection mixes declared and derived catalog facts. Require
  // the server's explicit editable draft instead of turning those facts into
  // declarations or accidentally replacing existing declarations with null.
  if (publicProfile && (!draftInput || ['declaredLocalKey', 'declaredUnionFamilyKey', 'declaredIssueKeys', 'shareAnalyzedIssues']
    .some((key) => !Object.hasOwn(draftInput, key)))) throw new Error('invalid_connection_draft');
  if (!Array.isArray(input.hiddenChapterIds)) throw new Error('invalid_connection_hidden_ids');
  const hiddenChapterIds = input.hiddenChapterIds.map((id: unknown) => {
    if (typeof id !== 'string' || !/^[A-Za-z0-9:_-]{1,160}$/.test(id)) throw new Error('invalid_connection_hidden_ids');
    return id;
  });
  const chapters = Array.isArray(input.chapters) ? input.chapters.map(optionalObject) : [];
  return {
    organizationId: input.organizationId, chapterId: input.chapterId as string | null,
    chapterName: typeof input.chapterName === 'string' ? input.chapterName : String(chapters.find((chapter) => chapter.id === input.chapterId)?.name || ''),
    profile: publicProfile, draft: draftInput ? connectionDraft(draftInput) : null, canPublish: input.canPublish === true,
    canRequestHandshake: input.canRequestHandshake === true,
    hiddenChapterIds,
    analysis: {
      nextPeriodKey: typeof analysis.nextPeriodKey === 'string' ? analysis.nextPeriodKey : null,
      nextPeriodFrozen: analysis.nextPeriodFrozen === true,
      latest: analysis.latest ? { topics: (Array.isArray(latest.topics) ? latest.topics : []).flatMap((topic: unknown) => {
        const row = optionalObject(topic); return typeof row.key === 'string' && CONNECTION_ISSUE_TOPICS.includes(row.key) ? [{ key: row.key }] : [];
      }) } : null,
    },
  };
}

export function connectionFailureState(error: unknown): 'unavailable' | 'unauthorized' | 'error' {
  const code = optionalObject(error).code;
  return code === 'PGRST202' || code === '42883' ? 'unavailable' : code === '42501' ? 'unauthorized' : 'error';
}

export function createMobileConnectionAdapter(writer: MobileSessionWriter, client: ConnectionRpcClient | null, actor: ConnectionActor) {
  // Authenticated Supabase session/JWT is supplied by the mobile service. No
  // client tenant parameter, API secret, raw grievance or response text is sent.
  const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    if (!canReadConnections(actor)) throw Object.assign(new Error('not_authorized'), { code: '42501' });
    if (!client) throw new Error('connection_service_unavailable');
    const transport = ['get_chapter_connection_workspace', 'list_chapter_connection_profiles'].includes(name) ? client : await writer.client();
    const { data, error } = await transport.rpc(name, { p_selected_hat: actor.selectedHat, ...args });
    if (error) throw error;
    return object(data);
  };
  const chapterArgs = (chapterId: string): Record<string, unknown> => {
    if (!chapterId || (actor.chapterId && chapterId !== actor.chapterId)) throw new Error('connection_chapter_changed');
    return { p_chapter_id: chapterId };
  };
  return {
    async load(nativeSignal: Pick<AbortSignal, 'aborted'>): Promise<ConnectionData> {
      const signal = connectionAbortSignal(nativeSignal);
      signal.throwIfAborted();
      const workspace = normalizeConnectionWorkspace(await call('get_chapter_connection_workspace', actor.chapterId ? chapterArgs(actor.chapterId) : {}));
      signal.throwIfAborted();
      if (workspace.organizationId !== actor.organizationId || (actor.chapterId && workspace.chapterId !== actor.chapterId)) throw new Error('connection_scope_changed');
      if (!workspace.chapterId) return { workspace, profiles: [] };
      const chapterId = workspace.chapterId;
      const scanned = await collectPublishedProfiles(async ({ afterId, snapshotToken, limit }: { afterId: string | null; snapshotToken: string | null; limit: number }) => {
        const page = await call('list_chapter_connection_profiles', { ...chapterArgs(chapterId), p_after_id: afterId,
          p_snapshot_token: snapshotToken, p_limit: limit });
        if (!Array.isArray(page.rows)) throw new Error('invalid_connection_page');
        return { ...page, rows: page.rows.map((row: unknown) => matchingProfile(row)) };
      }, { signal, pageSize: 250 });
      signal.throwIfAborted();
      return { workspace, profiles: scanned.profiles as ConnectionProfile[] };
    },
    async save(chapterId: string, draft: ConnectionDraft): Promise<void> {
      await call('save_chapter_connection_profile', { ...chapterArgs(chapterId), p_profile: connectionDraft(draft), p_publish: true });
    },
    async withdraw(chapterId: string): Promise<void> {
      await call('withdraw_chapter_connection_profile', chapterArgs(chapterId));
    },
    async reviewSource(chapterId: string, sourceKind: ConnectionSourceKind, sourceId: string, topicKeys: string[]): Promise<void> {
      await call('set_chapter_connection_source_tags', { ...chapterArgs(chapterId), p_source_kind: sourceKind,
        p_source_id: sourceId.trim(), p_topic_keys: topicKeys });
    },
    async freezeIssues(chapterId: string): Promise<void> {
      await call('freeze_chapter_connection_issue_aggregates', chapterArgs(chapterId));
    },
    async hide(chapterId: string, targetId: string, hidden: boolean): Promise<void> {
      await call('set_chapter_connection_hidden', { ...chapterArgs(chapterId), p_target_chapter_id: targetId, p_hidden: hidden });
    },
    async requestHandshake(chapterId: string, targetId: string, fields: { title: string; purpose: string; dataScope: 'docs_only' | 'no_member_data' | 'aggregate_only'; idempotencyKey: string }): Promise<Record<string, unknown>> {
      if (!targetId || targetId === chapterId || !fields.title.trim() || !fields.purpose.trim() || !fields.idempotencyKey) throw new Error('invalid_handshake_request');
      const result = await call('request_chapter_connection_handshake', { ...chapterArgs(chapterId), p_target_chapter_id: targetId,
        p_title: fields.title.trim(), p_purpose: fields.purpose.trim(), p_data_scope: fields.dataScope, p_idempotency_key: fields.idempotencyKey });
      if (!isConnectionHandshakeReceipt(result, chapterId, targetId)) throw new Error('invalid_handshake_response');
      return result;
    },
  };
}
export type MobileConnectionAdapter = ReturnType<typeof createMobileConnectionAdapter>;
