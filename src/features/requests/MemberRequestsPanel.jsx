import { useCallback, useEffect, useRef, useState } from "react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { MEMBER_REQUEST_ROLES } from "../../lib/memberApi.js";
import { AdminInvitationError } from "../../lib/adminInvitationApi.js";
import { formatEasternTimestamp } from "../../lib/easternTimestamp.js";
import { announceChapterSetupChanged } from "../../lib/onboardingGuide.js";
import { withLoadDeadline } from "../../lib/loadDeadline.js";
import { Button } from "../../components/Button.jsx";
import { BusyButton } from "../../components/BusyControls.jsx";
import { runBusyWrite } from "../../lib/busyWrite.js";
import { WorkspaceCardHead } from "../../components/WorkspacePages.jsx";
import { unitsForChapter } from "../orgSetup/unitsApi.js";

// REQ-UG-INVITATION-SUGGESTIONS-AND-ACCESS-REQUESTS-20261030: one
// place to suggest an invitation, ask for a staff role, follow both, and (for
// the people who may decide) approve or decline them. Nothing is sent to a
// suggested address until a decider approves; approving sends it through the
// existing invitation route under the decider's own account and limits.

const ROLE_LABEL_KEYS = Object.freeze({ steward: "demo.hatSteward", coordinator: "demo.hatCoordinator", advisor: "demo.hatAdvisor" });

// Invitation route answers after the approval and invitation were committed
// but the email could not be sent or its sending could not be recorded.
const APPROVED_EMAIL_UNCERTAIN = new Set(["delivery-unavailable", "delivery-status-unavailable"]);
// Answers given before anything was written. Any other failure (a busy
// service, a lost connection) may have come after the approval committed.
const NOTHING_CHANGED = new Set(["invalid-request", "request-unavailable", "not-permitted", "not-configured", "rate-limited", "session-expired"]);

function usePagedList(load) {
  const [state, setState] = useState({ status: "loading", items: [], hasMore: false, busy: false });
  const generation = useRef(0);
  const pageReads = useRef(new Set());
  const reload = useCallback(async () => {
    const mine = generation.current + 1;
    generation.current = mine;
    try {
      const page = await load(null);
      if (generation.current === mine) setState({ status: "ready", items: page.items, hasMore: page.hasMore, busy: false });
    } catch {
      if (generation.current === mine) setState({ status: "failed", items: [], hasMore: false, busy: false });
    }
  }, [load]);
  const more = useCallback(() => {
    const mine = generation.current;
    const last = state.items.at(-1);
    if (!last || state.busy) return;
    return runBusyWrite(pageReads, mine, async () => {
      setState((current) => ({ ...current, busy: true, moreFailed: false }));
      try {
        const page = await load({ createdAt: last.createdAt, id: last.id });
        if (generation.current !== mine) return;
        setState((current) => {
          const known = new Set(current.items.map((item) => item.id));
          return { ...current, items: [...current.items, ...page.items.filter((item) => !known.has(item.id))], hasMore: page.hasMore, busy: false };
        });
      } catch {
        if (generation.current === mine) setState((current) => ({ ...current, busy: false, moreFailed: true }));
      }
    });
  }, [load, state.items, state.busy]);
  useEffect(() => {
    void reload();
    return () => { generation.current += 1; };
  }, [reload]);
  return { state, reload, more };
}

function requestSummary(t, item) {
  return item.kind === "invitation_suggestion"
    ? t("requests.summary.suggestion", { name: item.inviteeName, chapter: item.chapterName || item.chapterId })
    : t("requests.summary.access", { role: t(ROLE_LABEL_KEYS[item.requestedRole] || "demo.hatMember"), chapter: item.chapterName || item.chapterId });
}

function RequestList({ list, emptyKey, renderActions = null }) {
  const { t } = useLang();
  const { state, more } = list;
  if (state.status === "loading") return <p role="status">{t("requests.loading")}</p>;
  if (state.status === "failed") return <p role="status">{t("requests.unavailable")}</p>;
  if (state.items.length === 0) return <p>{t(emptyKey)}</p>;
  return <>
    <ul className="member-requests__list">
      {state.items.map((item) => <li key={item.id} className="cwk-row">
        <div className="cwk-row__main">
          <p><strong>{requestSummary(t, item)}</strong> <span className="cwk-chip">{t(`requests.status.${item.status}`)}</span></p>
          {item.fromIntake
            ? <p>{t("requests.fromIntake")}</p>
            : item.requesterName && <p>{t("requests.from", { name: item.requesterName })}</p>}
          {item.inviteeEmail && renderActions && <p>{item.inviteeEmail}</p>}
          {item.note && <p>{item.note}</p>}
          {renderActions?.(item)}
        </div>
      </li>)}
    </ul>
    {state.hasMore && <BusyButton type="button" className="cwk-btn cwk-btn--ghost" pending={state.busy} onClick={() => void more()}>{t("requests.more")}</BusyButton>}
    {state.moreFailed && <p role="alert">{t("requests.moreFailed")}</p>}
  </>;
}

// REQ-UG-MEMBER-SENT-INVITATIONS-20261111 (#8171): what a member's
// own send answered. The server answers accepted, with nothing sent, for an
// address that already has an account or a live invitation, so the sentence
// never says which.
export function memberSendNoticeKey(error) {
  if (!error) return "requests.send.sent";
  if (error instanceof AdminInvitationError && error.code === "rate-limited" && error.retryAt) return "requests.send.limit";
  if (error instanceof AdminInvitationError && error.code === "email-domain-blocked") return "admin.emailDomainBlocked";
  if (error instanceof AdminInvitationError && error.code === "not-permitted") return "requests.send.notPermitted";
  return "requests.send.failed";
}

const stewardRequest = (item) => item.kind === "access_request" && item.requestedRole === "steward";

export function MemberRequestsPanel({ api, canDecide = false, memberSendEnabled = false, lang = "en", onNotice = () => {}, refreshKey = 0 }) {
  const { t } = useLang();
  const [busy, setBusy] = useState(false);
  const [deciding, setDeciding] = useState(null);
  // A request or a member invitation shares one lock (as they
  // share busy), and decisions share another (as they share deciding).
  const busyWriteRef = useRef(new Set());
  // #7663: a Steward request is approved into the unit the decider chooses.
  const [unitRead, setUnitRead] = useState(null);
  const [unitAttempt, setUnitAttempt] = useState(0);
  const [stewardUnits, setStewardUnits] = useState({});
  const canReadUnits = canDecide && typeof api.listChapterUnits === "function";
  const currentUnitRead = unitRead?.api === api && unitRead.attempt === unitAttempt ? unitRead : null;
  const unitPhase = !canReadUnits ? "failed" : currentUnitRead?.phase ?? "loading";
  const units = canReadUnits ? currentUnitRead?.items ?? [] : [];
  useEffect(() => {
    if (!canReadUnits) return undefined;
    let live = true;
    const read = Promise.resolve().then(() => api.listChapterUnits());
    void withLoadDeadline(read)
      .then((items) => { if (live) setUnitRead({ api, attempt: unitAttempt, phase: "ready", items: Array.isArray(items) ? items : [] }); })
      .catch(() => { if (live) setUnitRead({ api, attempt: unitAttempt, phase: "failed" }); });
    return () => { live = false; };
  }, [api, canReadUnits, unitAttempt]);
  const loadMine = useCallback((before) => api.listMine(before), [api]);
  const loadPending = useCallback((before) => api.listToDecide("pending", before), [api]);
  const mine = usePagedList(loadMine);
  const loadNothing = useCallback(async () => ({ items: [], hasMore: false }), []);
  const pending = usePagedList(canDecide ? loadPending : loadNothing);
  // A request notification opened while this page is already showing reloads
  // both lists, so the request it names is there.
  const reloadMine = mine.reload;
  const reloadPending = pending.reload;
  const seenRefresh = useRef(refreshKey);
  useEffect(() => {
    if (seenRefresh.current === refreshKey) return;
    seenRefresh.current = refreshKey;
    void reloadMine();
    void reloadPending();
  }, [refreshKey, reloadMine, reloadPending]);

  function submit(event, kind) {
    return runBusyWrite(busyWriteRef, "request", () => submitNow(event, kind), event);
  }

  async function submitNow(event, kind) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const fields = kind === "invitation_suggestion"
      ? { kind, inviteeName: String(data.get("name") || "").trim(), inviteeEmail: String(data.get("email") || "").trim(), note: String(data.get("note") || "").trim() || null }
      : { kind, requestedRole: String(data.get("role") || ""), note: String(data.get("note") || "").trim() || null };
    if (busy) return;
    setBusy(true);
    try {
      await api.submit(fields);
      form.reset();
      onNotice(t(kind === "invitation_suggestion" ? "requests.suggest.sent" : "requests.access.sent"));
      await mine.reload();
    } catch (error) {
      onNotice(t(/role already held/u.test(String(error?.message)) ? "requests.access.held"
        : /request limit/u.test(String(error?.message)) ? "requests.limit" : "requests.failed"));
    } finally {
      setBusy(false);
    }
  }

  // #8171: with the organization switch on, the member's invitation goes
  // straight out under the member's own limits; off, it stays a suggestion.
  function send(event) {
    return runBusyWrite(busyWriteRef, "request", () => sendNow(event), event);
  }

  async function sendNow(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    if (busy) return;
    setBusy(true);
    try {
      await api.invite({ memberSent: true, fullName: String(data.get("name") || "").trim(), email: String(data.get("email") || "").trim(), locale: String(data.get("locale") || lang) });
      form.reset();
      onNotice(t(memberSendNoticeKey(null)));
    } catch (error) {
      const key = memberSendNoticeKey(error);
      onNotice(key === "requests.send.limit" ? t(key, { time: formatEasternTimestamp(error.retryAt, lang)?.text ?? "" }) : t(key));
    } finally {
      setBusy(false);
    }
  }

  function decide(item, decision) {
    return runBusyWrite(busyWriteRef, "decide", () => decideNow(item, decision));
  }

  async function decideNow(item, decision) {
    if (deciding) return;
    setDeciding(item.id);
    try {
      if (decision === "approved" && item.kind === "invitation_suggestion") {
        // The invitation route approves the request and creates its
        // invitation in one server transaction under this decider's account
        // and limits; a request someone already decided creates nothing.
        await api.invite({ requestId: item.id, email: item.inviteeEmail, fullName: item.inviteeName, chapterId: item.chapterId, initialRole: null, locale: lang });
      } else {
        if (decision === "approved" && stewardRequest(item)) {
          await api.decide(item.id, decision, stewardUnits[item.id]);
          // An approved steward request places a steward in a unit: the staff
          // guide's units step reads its facts again (#7674).
          announceChapterSetupChanged();
        } else await api.decide(item.id, decision);
      }
      onNotice(t(decision === "approved" ? "requests.decide.approved" : "requests.decide.declined"));
    } catch (error) {
      const viaInvitationRoute = decision === "approved" && item.kind === "invitation_suggestion";
      onNotice(t(APPROVED_EMAIL_UNCERTAIN.has(error?.code) ? "requests.decide.approvedUnsent"
        : /invitation already sent/u.test(String(error?.message)) ? "requests.decide.alreadyInvited"
          : (viaInvitationRoute ? !NOTHING_CHANGED.has(error?.code) : error instanceof TypeError) ? "requests.decide.unconfirmed"
            : "requests.decide.failed"));
    } finally {
      setDeciding(null);
    }
    // Whatever happened, show where every request now stands, in both lists
    // (a decider may have decided a request they made themselves).
    await Promise.all([pending.reload(), mine.reload()]);
  }

  return (
    <section className="setin-card member-requests" aria-labelledby="member-requests-title">
      <WorkspaceCardHead title={t("requests.title")} id="member-requests-title">
        <div className="setin-card__head"><h2 id="member-requests-title">{t("requests.title")}</h2></div>
      </WorkspaceCardHead>
      <div className="setin-card__body">
        <p>{t("requests.sub")}</p>
        {memberSendEnabled && <form className="cwk-form" aria-label={t("requests.send.title")} onSubmit={(event) => void send(event)}>
          <h3>{t("requests.send.title")}</h3>
          <p>{t("requests.send.sub")}</p>
          <label className="cwk-form__label">{t("requests.suggest.name")}<input name="name" required minLength="2" maxLength="120" /></label>
          <label className="cwk-form__label">{t("requests.suggest.email")}<input name="email" type="email" required maxLength="254" /></label>
          <label className="cwk-form__label">{t("requests.send.language")}
            <select name="locale" defaultValue={lang === "es" ? "es" : "en"}>
              <option value="en">English</option>
              <option value="es">Español</option>
            </select>
          </label>
          <BusyButton className="cwk-btn cwk-btn--green" pending={busy}>{t("requests.send.action")}</BusyButton>
        </form>}
        {/* The suggestion an administrator approves stays reachable with member
            sending on: a member the server refuses (an account under a week old,
            for one) or a send that is unavailable still has a way to invite
            (Sol gate round 1, r1s1). */}
        <form className="cwk-form" aria-label={t("requests.suggest.title")} onSubmit={(event) => void submit(event, "invitation_suggestion")}>
          <h3>{t("requests.suggest.title")}</h3>
          <p>{t("requests.suggest.sub")}</p>
          <label className="cwk-form__label">{t("requests.suggest.name")}<input name="name" required minLength="2" maxLength="120" /></label>
          <label className="cwk-form__label">{t("requests.suggest.email")}<input name="email" type="email" required maxLength="254" /></label>
          <label className="cwk-form__label">{t("requests.note")}<textarea name="note" maxLength="500" /></label>
          <BusyButton className="cwk-btn cwk-btn--green" pending={busy}>{t("requests.suggest.action")}</BusyButton>
        </form>
        <form className="cwk-form" aria-label={t("requests.access.title")} onSubmit={(event) => void submit(event, "access_request")}>
          <h3>{t("requests.access.title")}</h3>
          <p>{t("requests.access.sub")}</p>
          <label className="cwk-form__label">{t("requests.access.role")}
            <select name="role" required defaultValue="">
              <option value="" disabled>{t("requests.access.choose")}</option>
              {MEMBER_REQUEST_ROLES.map((role) => <option key={role} value={role}>{t(ROLE_LABEL_KEYS[role])}</option>)}
            </select>
          </label>
          <label className="cwk-form__label">{t("requests.note")}<textarea name="note" maxLength="500" /></label>
          <BusyButton className="cwk-btn cwk-btn--green" pending={busy}>{t("requests.access.action")}</BusyButton>
        </form>
        <h3>{t("requests.mine")}</h3>
        <RequestList list={mine} emptyKey="requests.mineEmpty" />
        {canDecide && <>
          <h3>{t("requests.toDecide")}</h3>
          <RequestList list={pending} emptyKey="requests.toDecideEmpty" renderActions={(item) => {
            if (item.status !== "pending") return null;
            const isSteward = stewardRequest(item);
            const chapterUnits = isSteward ? unitsForChapter(units, item.chapterId) : [];
            const picked = chapterUnits.some((unit) => unit.id === stewardUnits[item.id]);
            const unitsMessage = unitPhase === "loading" ? "access.unitsLoading"
              : unitPhase === "failed" ? "access.unitsLoadFailed"
              : chapterUnits.length === 0 ? "access.unitsAskAdmin"
              : !picked ? "requests.stewardUnitNeeded" : null;
            return <div className="xus-btnrow">
              {/* BUG-UG-INVITATION-SUGGESTIONS-HIDDEN-FROM-ADMIN-DESK-20261102:
                  approval creates a Member invitation to the suggester's chapter
                  (approve_member_request_invitation); a staff role is never
                  granted from a suggestion's note. */}
              {item.kind === "invitation_suggestion" && <p className="requests-scope">{t("requests.approveScope", { chapter: item.chapterName || item.chapterId })}</p>}
              {isSteward && <>
                <label className="cwk-form__label">{t("requests.stewardUnit")}
                  <select disabled={chapterUnits.length === 0} value={picked ? stewardUnits[item.id] : ""} onChange={(event) => { const value = event.target.value; setStewardUnits((current) => ({ ...current, [item.id]: value })); }}>
                    <option value="">{t("requests.access.choose")}</option>
                    {chapterUnits.map((unit) => <option key={unit.id} value={unit.id}>{unit.name}</option>)}
                  </select>
                </label>
                <div aria-live="polite" aria-atomic="true">{unitsMessage && <p className="requests-scope">{t(unitsMessage)}</p>}</div>
                {unitPhase === "failed" && canReadUnits &&
                  <Button size="small" variant="secondary" onClick={() => setUnitAttempt((attempt) => attempt + 1)}>{t("app.tryAgain")}</Button>}
              </>}
              <BusyButton type="button" className="cwk-btn cwk-btn--green" pending={deciding === item.id} disabled={isSteward && !picked} onClick={() => void decide(item, "approved")}>{t("requests.approve")}</BusyButton>
              <BusyButton type="button" className="cwk-btn cwk-btn--ghost" pending={deciding === item.id} onClick={() => void decide(item, "declined")}>{t("requests.decline")}</BusyButton>
            </div>;
          }} />
        </>}
      </div>
    </section>
  );
}
