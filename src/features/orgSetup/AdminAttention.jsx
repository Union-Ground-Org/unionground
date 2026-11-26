// REQ-UG-ADMIN-OVERVIEW-GOALS-AND-ACTIVITY-LOG-20261030: the admin
// overview's one list of what is waiting on an administrator, read from the
// desk the overview already loaded (no extra request). The progress count of
// setting up the organization is the guide's milestone ring above the desk,
// not a second tally here.
import { useWorkspace } from "../../components/WorkspacePages.jsx";
import { useLang } from "../../lib/LanguageContext.jsx";
import "../../lib/i18n/features/adminAttentionStrings.js";

const WAITING_GOVERNANCE = new Set(["submitted", "reviewing"]);
// Member requests are decided on the Requests page (Settings), the place the
// request notifications name.
const REQUESTS_PAGE = Object.freeze({ path: "/m/settings/requests", view: "settings" });
const WAITING_REWARDS = new Set(["claimed", "granted", "shipped"]);

function rewardNeedsAttention(reward) {
  return WAITING_REWARDS.has(reward?.status);
}

function expired(value, now) {
  const at = Date.parse(value ?? "");
  return Number.isFinite(at) && at <= now;
}

/**
 * What needs an administrator now, from the admin desk payload. A source the
 * desk could not read (null) is reported as unreadable rather than as zero.
 * @returns {{ items: { key: string, count: number, sectionId?: string, page?: { path: string, view: string }, atLeast?: boolean }[], unreadable: string[] }}
 */
export function adminAttentionItems(desk, now = Date.now()) {
  const items = [];
  const unreadable = [];
  const add = (key, count, sectionId) => { if (count > 0) items.push({ key, count, sectionId }); };

  // BUG-UG-INVITATION-SUGGESTIONS-HIDDEN-FROM-ADMIN-DESK-20261102:
  // the server lists only the requests this viewer may decide, so the counts
  // never include a request they cannot act on. A further page means the
  // count is a floor.
  if (desk?.memberRequests === null) unreadable.push("memberRequests");
  else if (desk?.memberRequests) {
    const pending = desk.memberRequests.items.filter((item) => item?.status === "pending");
    const atLeast = desk.memberRequests.hasMore === true;
    for (const [key, kind] of [["invitationSuggestions", "invitation_suggestion"], ["accessRequests", "access_request"]]) {
      const count = pending.filter((item) => item.kind === kind).length;
      if (count > 0) items.push({ key, count, page: REQUESTS_PAGE, atLeast });
    }
  }

  if (desk?.invitations === null) unreadable.push("invitations");
  else {
    const invitations = Array.isArray(desk?.invitations?.items) ? desk.invitations.items : [];
    add("invitationsFailed", invitations.filter((item) => item?.status === "delivery_failed").length, "admin-invitations");
    add("invitationsPending", invitations.filter((item) => item?.status === "pending" && !expired(item.expiresAt, now)).length, "admin-invitations");
  }
  if (desk?.failedLoginInbox === null) unreadable.push("failedLogins");
  else {
    // The inbox page is bounded; its uncapped open count is the answer when present.
    const inbox = desk?.failedLoginInbox;
    const open = Number.isInteger(inbox?.openCount) ? inbox.openCount : (inbox?.items ?? []).filter((item) => item?.status === "open").length;
    add("failedLogins", open, "admin-failed-logins");
  }
  if (desk?.mfaPolicy === null) unreadable.push("staffTwoStep");
  else if (desk?.mfaPolicy) add("staffTwoStep", Math.max(0, (Number(desk.mfaPolicy.staffTotal) || 0) - (Number(desk.mfaPolicy.staffEnrolled) || 0)), "admin-mfa");
  if (desk?.governance === null) unreadable.push("governance");
  else add("governance", (desk?.governance ?? []).filter((item) => WAITING_GOVERNANCE.has(item?.status)).length, "admin-governance");
  if (desk?.rewardQueue === null) unreadable.push("rewardClaims");
  else add("rewardClaims", (desk?.rewardQueue ?? []).filter(rewardNeedsAttention).length, "admin-rewards");

  return { items, unreadable };
}

export function AdminAttention({ desk, onOpenRewardClaims, now = Date.now() }) {
  const { t } = useLang();
  const workspace = useWorkspace();
  const { items, unreadable } = adminAttentionItems(desk, now);
  const pageFor = (sectionId) => workspace?.pages?.find((page) => page.sectionId === sectionId) ?? null;
  return <section className="admin-attention" aria-labelledby="admin-attention-title">
    <h2 id="admin-attention-title">{t("adminAttention.title")}</h2>
    {items.length > 0 ? <ul>
      {items.map((item) => {
        const label = t(`adminAttention.${item.key}.${item.atLeast ? "atLeast" : item.count === 1 ? "one" : "other"}`, { count: item.count });
        const page = item.page ? { path: item.page.path, viewKey: item.page.view } : pageFor(item.sectionId);
        return <li key={item.key} data-attention={item.key}>
          {page && workspace?.open
            ? <a href={page.path} onClick={(event) => {
              event.preventDefault();
              if (item.key === "rewardClaims") onOpenRewardClaims?.();
              workspace.open(page.path, page.viewKey || workspace.view);
            }}>{label}</a>
            : label}
        </li>;
      })}
    </ul> : unreadable.length === 0 && <p>{t("adminAttention.none")}</p>}
    {unreadable.length > 0 && <p className="admin-attention__unreadable" role="status">{t("adminAttention.unreadable")}</p>}
  </section>;
}
