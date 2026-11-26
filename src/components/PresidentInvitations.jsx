import { useCallback, useEffect, useRef, useState } from "react";
import { BusyButton } from "./BusyControls.jsx";
import { runBusyWrite } from "../lib/busyWrite.js";
import { invitationErrorKey, invitationStatusLine } from "../lib/adminInvitationApi.js";
import { useLang } from "../lib/LanguageContext.jsx";
import { countKey } from "../lib/i18n.js";
import { PLANE_CARD_CLASS } from "../lib/staffPlaneStyles.js";
import { SectionTitle } from "./Primitives.jsx";
import { WorkspaceListPager, useWorkspace, workspaceListRows } from "./WorkspacePages.jsx";
import "./PresidentInvitations.css";

const ACTIONABLE = new Set(["pending", "delivery_failed", "expired"]);

// A chapter President's invitation card on the President plane
// (BUG-UG-CHAPTER-PRESIDENT-CANNOT-INVITE-20261003; owner decision,
// October 4, 2026: own chapter only, as plain members). The database decides
// who may invite where: the card lists only the chapters get_member_invitations
// returns and never offers starting access. When the reader refuses (no
// President role for the selected chapter, or a database without the
// President path yet) the card is not shown on the overview; on its own page
// it says the invitations could not be loaded and offers Try again, held
// while that read runs. On the demo (an api with sendingUnavailable) the
// card has no Send, Resend or Revoke; its own page says at once, whatever
// the read returns, that the demo does not send invitations, then lists the
// chapter's invitations or the retry
// (BUG-UG-DEMO-PRESIDENT-INVITE-PAGE-BLANK-20261124).
// The list shows one chapter at a time: the chapter picked in the form, else
// the open chapter (the read's `chapter`), else the first listed. The read
// returns every chapter the President presides over (an organization-wide
// President presides over all of them), so an unscoped list mixed other
// chapters' invitations under "Invite people into your chapter"
// (BUG-UG-PRESIDENT-INVITATIONS-LIST-HOLDS-OTHER-CHAPTERS-20261125).
export function presidentInvitationChapterId(invitations, pickedId) {
  const chapters = Array.isArray(invitations?.chapters) ? invitations.chapters : [];
  if (pickedId && chapters.some((chapter) => chapter.id === pickedId)) return pickedId;
  const openId = invitations?.chapter?.id;
  if (openId && chapters.some((chapter) => chapter.id === openId)) return openId;
  return chapters[0]?.id ?? null;
}

export function PresidentInvitations({ api }) {
  const { t, lang } = useLang();
  const workspace = useWorkspace();
  const [invitations, setInvitations] = useState(null);
  const [form, setForm] = useState({ fullName: "", email: "", chapterId: "", locale: lang });
  const [busy, setBusy] = useState(null);
  // Synchronous write lock (record 8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  const [error, setError] = useState(false);
  const [success, setSuccess] = useState(false);
  const [confirming, setConfirming] = useState(null);
  const [visibleEnd, setVisibleEnd] = useState(6);
  const [loadFailed, setLoadFailed] = useState(false);
  const [reading, setReading] = useState(false);
  // Only the newest read may set the list, so a late answer to an older read
  // never replaces a newer one.
  const readSeq = useRef(0);
  const sendingUnavailable = api?.sendingUnavailable === true;
  const ownPage = workspace?.section === "vp-invitations";

  const load = useCallback(async () => {
    if (!api) return;
    const seq = ++readSeq.current;
    setReading(true);
    try {
      const next = await api.load();
      if (seq !== readSeq.current) return;
      setInvitations(next);
      setLoadFailed(false);
    } catch {
      if (seq !== readSeq.current) return;
      setInvitations(null);
      setLoadFailed(true);
    } finally {
      if (seq === readSeq.current) setReading(false);
    }
  }, [api]);
  useEffect(() => { setVisibleEnd(6); setConfirming(null); load(); }, [load]);

  const chapters = Array.isArray(invitations?.chapters) ? invitations.chapters : [];
  const chapterId = presidentInvitationChapterId(invitations, form.chapterId);
  // Newest first, as the read orders them. Rows the President can resend or
  // revoke come first only where those actions exist (not on the demo).
  const chapterItems = (invitations?.items ?? []).filter((item) => item?.chapterId === chapterId);
  const items = sendingUnavailable ? chapterItems
    : [...chapterItems].sort((a, b) => Number(ACTIONABLE.has(b.status)) - Number(ACTIONABLE.has(a.status)));
  // The polite status line is derived from the list this render shows, never
  // stored: with more than one chapter listed and no read in flight it says
  // which chapter is shown and how many invitations it lists, in the current
  // language; otherwise it is empty. So it speaks when a pick or a settled
  // read changes the list, and cannot state a count or chapter not on screen.
  const shownChapterName = chapters.find((chapter) => chapter.id === chapterId)?.name;
  const listStatus = !reading && chapters.length > 1 && shownChapterName
    ? t(countKey("vp.invitationsChapterShown", items.length), { count: items.length, chapter: shownChapterName })
    : "";
  // Rendered in every state (first read, failed read, loaded) at the same place,
  // so its text changes on an element already in the page and is spoken.
  const statusLine = <p key="vp-invitations-status" id="vp-invitations-status" role="status" className="sr-only">{listStatus}</p>;
  const demoNotice = sendingUnavailable && (
    <div className={PLANE_CARD_CLASS} style={{ padding: 16, marginTop: 12 }}>
      <p className="xus-note">{t("vp.invitationsDemo")}</p>
    </div>
  );
  if (api && ownPage && chapters.length === 0 && (sendingUnavailable || loadFailed)) {
    return (<>
      {statusLine}
      <section id="vp-invitations" className="message-section vp-invitations" aria-label={t("admin.inviteTitle")}>
        <SectionTitle sub={t("vp.inviteSub")}>{t("admin.inviteTitle")}</SectionTitle>
        {demoNotice}
        {loadFailed && (
          <div className="xus-inline" style={{ marginTop: 12 }}>
            <p role="alert" className="xus-note">{t("admin.invitationsUnavailable")}</p>
            <BusyButton type="button" className="xus-btn" pending={reading} onClick={load}>{t("app.tryAgain")}</BusyButton>
          </div>
        )}
      </section>
    </>);
  }
  if (!api) return null;
  if (chapters.length === 0) return <>{statusLine}{null}</>;
  const visibleItems = workspaceListRows(items, visibleEnd, Boolean(workspace));
  const changePage = (end) => { setVisibleEnd(end); setConfirming(null); };
  function pickChapter(nextId) {
    setForm((current) => ({ ...current, chapterId: nextId }));
    changePage(6);
  }

  function submit(event) {
    return runBusyWrite(busyWriteRef, "invitation", () => submitNow(event), event);
  }

  async function submitNow(event) {
    event.preventDefault();
    if (busy || !chapterId) return;
    const submittedForm = form;
    setBusy("create"); setError(false); setSuccess(false);
    try {
      await api.inviteMember({ fullName: form.fullName.trim(), email: form.email.trim(), chapterId, initialRole: null, locale: form.locale, formerMember: false });
      setForm((current) => current === submittedForm ? { ...current, fullName: "", email: "" } : current);
      setSuccess(true);
      await load();
    } catch (failure) {
      setError(invitationErrorKey(failure));
    } finally {
      setBusy(null);
    }
  }

  function mutate(kind, invitation) {
    return runBusyWrite(busyWriteRef, "invitation", () => mutateNow(kind, invitation));
  }

  async function mutateNow(kind, invitation) {
    if (busy) return;
    setBusy(`${kind}:${invitation.id}`); setError(false); setSuccess(false); setConfirming(null);
    try {
      if (kind === "resend") await api.resendInvitation(invitation.id);
      else await api.revokeInvitation(invitation.id);
      setSuccess(true);
      await load();
    } catch (failure) {
      setError(invitationErrorKey(failure));
    } finally {
      setBusy(null);
    }
  }

  return (<>
    {statusLine}
    <section id="vp-invitations" className="message-section vp-invitations" aria-label={t("admin.inviteTitle")}>
      <SectionTitle sub={t("vp.inviteSub")}>{t("admin.inviteTitle")}</SectionTitle>
      {sendingUnavailable ? demoNotice : (
      <form className={`${PLANE_CARD_CLASS} xus-form`} style={{ padding: 16, marginTop: 12 }} onSubmit={submit}>
        <div className="xus-formgrid">
          <label className="xus-field">{t("admin.inviteName")}
            <input className="xus-input" autoComplete="name" value={form.fullName} onChange={(event) => setForm((current) => ({ ...current, fullName: event.target.value }))} minLength={2} maxLength={120} required />
          </label>
          <label className="xus-field">{t("admin.inviteEmail")}
            <input className="xus-input" type="email" inputMode="email" autoComplete="email" value={form.email} onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} maxLength={254} required />
          </label>
          <label className="xus-field">{t("admin.inviteChapter")}
            {chapters.length > 1 ? (
              <select className="xus-input" value={chapterId ?? ""} onChange={(event) => pickChapter(event.target.value)}>
                {chapters.map((chapter) => <option key={chapter.id} value={chapter.id}>{chapter.name}</option>)}
              </select>
            ) : (
              <input className="xus-input" value={chapters[0].name} disabled />
            )}
          </label>
          <label className="xus-field">{t("admin.inviteLanguage")}
            <select className="xus-input" value={form.locale} onChange={(event) => setForm((current) => ({ ...current, locale: event.target.value }))}>
              <option value="en">English</option>
              <option value="es">Español</option>
            </select>
          </label>
        </div>
        <p className="xus-note">{t("admin.inviteSafety")}</p>
        {error && <p role="alert" className="xus-note xus-note--error">{t(error)}</p>}
        {success && <p role="status" className="xus-note xus-note--success">{t("admin.invitationAccepted")}</p>}
        <div className="xus-btnrow">
          <BusyButton type="submit" className="xus-btn xus-btn--go" pending={Boolean(busy)}>{busy === "create" ? t("admin.invitationSending") : t("admin.invitationSend")}</BusyButton>
        </div>
      </form>
      )}
      {items.length === 0 && <p className="xus-note">{t("admin.invitationsEmpty")}</p>}
      {visibleItems.map((invitation) => {
        const canAct = !sendingUnavailable && ACTIONABLE.has(invitation.status);
        return (
          <div key={invitation.id} className="xus-row">
            <div className="xus-rowmain">
              <strong className="xus-name">{invitation.fullName}</strong>
              <small className="xus-meta">{invitation.normalizedEmail}</small>
              <small className="xus-meta">{invitationStatusLine(invitation, t)}{chapters.length > 1 && invitation.chapterName ? ` · ${invitation.chapterName}` : ""}</small>
              {invitation.source === "member" && <small className="xus-meta">{invitation.sentByMemberName ? t("admin.invitationSentByMember", { name: invitation.sentByMemberName }) : t("admin.invitationSentByAMember")}</small>}
            </div>
            {canAct && (
              <span className="xus-rowact">
                <BusyButton type="button" className="xus-btn" pending={Boolean(busy)} onClick={() => mutate("resend", invitation)}>{t("admin.invitationResend")}</BusyButton>
                <BusyButton type="button" className="xus-btn" pending={Boolean(busy)} onClick={() => setConfirming(invitation.id)}>{t("admin.invitationRevoke")}</BusyButton>
              </span>
            )}
            {confirming === invitation.id && (
              <div role="group" aria-label={t("admin.invitationRevokeConfirm", { name: invitation.fullName })} className="xus-confirm">
                <p className="xus-note">{t("admin.invitationRevokeConfirm", { name: invitation.fullName })}</p>
                <div className="xus-btnrow">
                  <BusyButton type="button" className="xus-btn xus-btn--danger" pending={Boolean(busy)} onClick={() => mutate("revoke", invitation)}>{t("admin.invitationRevokeYes")}</BusyButton>
                  <BusyButton type="button" className="xus-btn" pending={Boolean(busy)} onClick={() => setConfirming(null)}>{t("admin.cancel")}</BusyButton>
                </div>
              </div>
            )}
          </div>
        );
      })}
      {/* Keyed by the chapter shown: a new chapter remounts the pager, so its page
          status enters with its text and the chapter status above speaks for the
          change; Next and Previous still change it and speak. */}
      <WorkspaceListPager key={chapterId} count={items.length} end={visibleEnd} onChange={changePage}>
        {items.length > visibleEnd && <button type="button" className="xus-btn xus-show-more" onClick={() => changePage(visibleEnd + 6)}>{t("coordinator.showMore", { count: items.length - visibleEnd })}</button>}
      </WorkspaceListPager>
    </section>
  </>);
}
