import { useCallback, useEffect, useRef, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { formatDateTimeWithZone } from "../../lib/i18n.js";
import { PLANE_CARD_CLASS } from "../../lib/staffPlaneStyles.js";
import { BusyButton } from "../../components/BusyControls.jsx";
import { runBusyWrite } from "../../lib/busyWrite.js";

// REQ-UG-CHAPTER-LEADERSHIP-RECOVERY-20261001: the organization admin's
// cooling-off review. Pending claims come first with a Reject control (an
// optional note goes to the member); decided claims stay listed for six
// months as the governance record. list_chapter_leadership_claims and
// reject_chapter_leadership_claim enforce the admin role, MFA and the
// selected organization.
export function LeadershipClaimsPanel({ api, onNotice = () => {} }) {
  const { t, lang } = useLang();
  const [list, setList] = useState(null);
  const [failed, setFailed] = useState(false);
  const [notes, setNotes] = useState({});
  const [busy, setBusy] = useState(null);
  // Record 8435: a synchronous write lock, refused before React commits busy.
  const busyWriteRef = useRef(new Set());
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!api?.listLeadershipClaims) return;
    try {
      setList(await api.listLeadershipClaims());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  if (!api?.listLeadershipClaims) return null;

  function reject(item) {
    return runBusyWrite(busyWriteRef, "claims", () => rejectNow(item));
  }

  async function rejectNow(item) {
    setBusy(item.id);
    setError("");
    try {
      await api.rejectLeadershipClaim(item.id, notes[item.id] ?? "");
      onNotice(t("leadershipClaims.rejected"));
      await load();
    } catch {
      setError(t("leadershipClaims.failed"));
    } finally {
      setBusy(null);
    }
  }

  const items = Array.isArray(list?.items) ? list.items : [];
  return (
    <article id="admin-leadership-claims" className={`${PLANE_CARD_CLASS} xus-card role-section-target`} tabIndex="-1" data-testid="admin-leadership-claims">
      <header className="xus-cardhead">
        <span className="xus-glyph" aria-hidden="true"><ShieldCheck size={18} /></span>
        <div className="xus-cardhead__copy">
          <h3 className="xus-cardttl">{t("leadershipClaims.title")}</h3>
          {list && <p className="xus-cardsub">{t("leadershipClaims.sub", { months: list.inactivityMonths, hours: list.coolingOffHours })}</p>}
        </div>
      </header>
      {failed && <div className="xus-cardbody"><p className="xus-note">{t("leadershipClaims.unavailable")}</p></div>}
      {list && list.enabled === false && <div className="xus-cardbody"><p className="xus-note">{t("leadershipClaims.off")}</p></div>}
      {list && items.length === 0 && <div className="xus-cardbody"><p className="xus-note">{t("leadershipClaims.empty")}</p></div>}
      {error && <div className="xus-cardbody"><p className="xus-note xus-note--error" role="alert">{error}</p></div>}
      {items.map((item) => {
        const name = item.claimantName || "—";
        const chapter = item.chapterName || item.chapterId;
        const noteId = `leadership-claim-note-${item.id}`;
        return (
          <div className="xus-cardbody" key={item.id}>
            <strong>{t("leadershipClaims.item", { name, chapter })}</strong>
            <small className="xus-meta">
              {t(`leadershipClaims.status.${item.status}`)} · {t("leadershipClaims.claimed", { date: formatDateTimeWithZone(item.claimedAt, lang) })}
              {item.status === "pending" && <> · {t("leadershipClaims.effective", { date: formatDateTimeWithZone(item.effectiveAt, lang) })}</>}
              {" · "}{t("leadershipClaims.inactiveLeaders", { count: item.inactiveLeaderCount })}
            </small>
            {item.decidedByName && item.status !== "pending" && <small className="xus-meta">{t("leadershipClaims.decidedBy", { name: item.decidedByName })}</small>}
            {item.decisionNote && <blockquote>{item.decisionNote}</blockquote>}
            {item.status === "pending" && (
              <div className="xus-form">
                <label className="xus-field" htmlFor={noteId}>{t("leadershipClaims.note")}
                  <textarea id={noteId} className="xus-input xus-input--area" maxLength={1000} value={notes[item.id] ?? ""} onChange={(event) => setNotes((current) => ({ ...current, [item.id]: event.target.value }))} />
                </label>
                <BusyButton type="button" className="xus-btn xus-btn--danger" pending={busy !== null} aria-label={t("leadershipClaims.rejectNamed", { name, chapter })} onClick={() => reject(item)}>
                  {busy === item.id ? t("auth.working") : t("leadershipClaims.reject")}
                </BusyButton>
              </div>
            )}
          </div>
        );
      })}
    </article>
  );
}
