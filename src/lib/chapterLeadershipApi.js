import { setMemberChapterRole } from "./chapterLifecycleApi.js";
import { getChapterLeadership } from "./memberApi.js";

// REQ-UG-SCOPED-ROLES-AND-OFFICER-ACCESS-20261030 (#6560): what the
// Who runs this chapter card needs. selfId is read when the card renders, so
// a refreshed session never rebuilds the card; grantPresident gives a
// title-only President the role through the same call as Members & access
// (set_member_chapter_role, which needs an administrator of that chapter).
export function chapterLeadershipApiFor(client, sessionRef) {
  return {
    load: () => getChapterLeadership(client),
    get selfId() { return sessionRef?.current?.user?.id ?? null; },
    grantPresident: (userId, chapterId) => setMemberChapterRole(client, userId, chapterId, "vp", true),
  };
}
