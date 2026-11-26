// This adapter never enters the messaging store, search, persistence or telemetry.
// Its client is captured for one session by the host surface.

/** @typedef {{ id: string, announcementId: string, revision: number, title: string, body: string, publishedAt: string, expiresAt: string, sourceType: 'platform-announcement' }} Announcement */
/** @typedef {{ items: Announcement[], hidden: boolean, generation: number | null }} Feed */
/** @typedef {{ enabled: boolean, generation: number, consentVersion: string, platformOrganizationId: string | null }} FollowSettings */
/**
 * @typedef {object} AnnouncementApi
 * @property {(locale?: string, cursor?: Announcement | null) => Promise<Feed>} feed
 * @property {(hidden: boolean) => Promise<{ hidden: boolean }>} preference
 * @property {() => Promise<FollowSettings>} settings
 * @property {(enabled: boolean, generation: number) => Promise<FollowSettings>} follow
 */
/** @typedef {{ access_token: string, user: { id: string } }} Session */

export const ANNOUNCEMENT_NOTICE = "platform-updates-v1";
export const ANNOUNCEMENT_PAGE = 20;
export const ANNOUNCEMENT_LEASE_MS = 30_000;

/**
 * @param {Session | null} session
 * @returns {string | null}
 */
export function announcementSessionId(session) {
  try {
    const part = session.access_token.split(".")[1].replaceAll("-", "+").replaceAll("_", "/");
    const id = JSON.parse(globalThis.atob(part)).session_id;
    return typeof id === "string" && id ? id : null;
  } catch { return null; }
}

/**
 * @param {{ session: Session | null, organizationId: string | null, chapterId?: string | null, hat?: string, locale?: string }} context
 * @returns {string | null}
 */
export function announcementScope({ session, organizationId, chapterId, hat = "member", locale = "en" }) {
  const sessionId = announcementSessionId(session);
  return sessionId && session?.user?.id && organizationId
    ? JSON.stringify([organizationId, chapterId ?? null, session.user.id, sessionId, hat, locale]) : null;
}

/**
 * @param {unknown} data
 * @returns {Feed}
 */
function cleanFeed(data) {
  if (!data || !Array.isArray(data.items) || data.items.length > ANNOUNCEMENT_PAGE) throw new Error("Platform updates unavailable");
  const items = data.items.map(row => {
    if (typeof row.id !== "string" || typeof row.announcementId !== "string" || !Number.isSafeInteger(row.revision)
      || typeof row.title !== "string" || [...row.title].length > 120 || typeof row.body !== "string" || [...row.body].length > 4000
      || !Number.isFinite(Date.parse(row.publishedAt)) || !Number.isFinite(Date.parse(row.expiresAt))) throw new Error("Platform updates unavailable");
    return { id: row.id, announcementId: row.announcementId, revision: row.revision, title: row.title, body: row.body,
      publishedAt: row.publishedAt, expiresAt: row.expiresAt, sourceType: "platform-announcement" };
  });
  return { items, hidden: data.hidden === true, generation: Number.isSafeInteger(data.generation) ? data.generation : null };
}

/**
 * @param {{ rpc(name: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown, error: unknown }> }} client
 * @param {string} organizationId
 * @returns {AnnouncementApi}
 */
export function createAnnouncementApi(client, organizationId) {
  async function call(name, args = {}) {
    try {
      if (!organizationId) throw new Error();
      const result = await client.rpc("platform_announcement_request", {
        p_organization_id: organizationId, p_action: name, p_args: args,
      });
      if (result.error || !result.data) {
        const error = new Error();
        error.denied = result.error?.code === "42501";
        throw error;
      }
      return result.data;
    } catch (cause) {
      const error = new Error("Platform updates unavailable");
      error.denied = cause?.denied === true;
      throw error;
    }
  }
  return {
    feed: async (locale = "en", cursor = null) => cleanFeed(await call("list_my_platform_announcements", {
      p_locale: locale === "es" ? "es" : "en", p_limit: ANNOUNCEMENT_PAGE,
      p_before: cursor?.publishedAt ?? null, p_before_id: cursor?.id ?? null,
    })),
    preference: hidden => call("set_my_platform_announcement_preference", { p_hidden: hidden }),
    settings: () => call("get_platform_announcement_follow_settings"),
    follow: (enabled, generation) => call("set_platform_announcement_follow", {
      p_enabled: enabled, p_expected_generation: generation, p_consent_version: ANNOUNCEMENT_NOTICE,
    }),
    workspace: (after = null, auditBefore = null) => call("get_platform_announcement_publisher_workspace", {
      p_limit: ANNOUNCEMENT_PAGE, p_after_id: after, p_audit_before: auditBefore,
    }),
    followers: (after = null) => call("list_platform_follow_status", { p_after: after, p_limit: ANNOUNCEMENT_PAGE }),
    save: draft => call("save_platform_announcement_draft", draft),
    transition: (action, id, revision) => {
      if (!["review", "publish", "withdraw"].includes(action)) return Promise.reject(new Error("Platform updates unavailable"));
      return call(`${action}_platform_announcement`, { p_id: id, p_expected_revision: revision });
    },
    hideLocal: id => call("hide_organization_platform_announcement", { p_id: id }),
  };
}
