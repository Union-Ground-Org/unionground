export type NoticeAudience = {
  value: string;
  kind: 'chapter' | 'organization' | 'unit' | 'committee';
  chapterId: string;
  name: string;
  unitId?: string;
  committeeId?: string;
};
export type NoticeAudienceContext = {
  chapterId: string | null | undefined;
  role: string | null | undefined;
  canPostOrganization?: boolean;
  isCurrent?: () => boolean;
};
type NoticeClient = {
  rpc: (name: string, fields?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
};
export declare const NOTICE_AUDIENCE_UNAVAILABLE: 'notice_audience_unavailable';
export declare function loadNoticeAudiences(client: NoticeClient, context: NoticeAudienceContext): Promise<NoticeAudience[]>;
export declare function publishNoticeAudience(client: NoticeClient, title: string, body: string, locale: string, audience?: NoticeAudience, operationKey?: string): Promise<unknown>;
export declare function publishNoticeForAudience(client: NoticeClient, title: string, body: string, locale: string, value: string | undefined, context: NoticeAudienceContext, operationKey?: string): Promise<unknown>;
