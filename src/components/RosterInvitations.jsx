import { useEffect, useRef, useState } from "react";
import { BusyButton, BusyInput, BusySelect } from "./BusyControls.jsx";
import { runBusyWrite } from "../lib/busyWrite.js";
import { useLang } from "../lib/LanguageContext.jsx";
import { dateTimeFormat } from "../lib/i18n.js";
import { matchRosterInvitations, parseRosterInvitations } from "../features/memberOperations/rosterInvitations.js";
import "./workplace-roster.css";
import { WorkspaceCardTitle } from "./WorkspacePages.jsx";

const SENDABLE = ["ready", "failed", "waiting"];
// When the next roster batch can go: short date, minutes and the zone name.
export const RETRY_TIME_OPTIONS = Object.freeze({ month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });
// The server's roster-import limits (UX-UG-ROSTER-IMPORT-TAKES-DAYS-20261018).
const LIMIT_KEYS = {
  "limits.security.invitation_roster_admin_hourly": "roster.limit.adminHourly",
  "limits.security.invitation_roster_chapter_daily": "roster.limit.chapterDaily",
  "limits.security.invitation_roster_lookup_hourly": "roster.limit.lookupHourly",
};

export function RosterInvitations({ api, chapters, reload, invitations = [] }) {
  const { t, lang } = useLang();
  const [chapterId, setChapterId] = useState(chapters[0]?.id ?? "");
  const [rows, setRows] = useState([]);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  // Synchronous write lock (record 8435): refuses a second activation before
  // React commits the busy state.
  const busyWriteRef = useRef(new Set());
  // A roster-import limit stop: which limit and when the next batch can go.
  const [limited, setLimited] = useState(null);
  const generation = useRef(0);
  const sending = useRef(false);
  const chapterScope = chapters.map((chapter) => chapter.id).sort().join("|");
  useEffect(() => {
    generation.current += 1;
    setRows([]);
    setError(false);
    setBusy(false);
    setLimited(null);
    setChapterId((current) => chapterScope.split("|").includes(current) ? current : chapterScope.split("|")[0]);
    return () => { generation.current += 1; };
  }, [chapterScope]);

  async function read(event) {
    const file = event.target.files?.[0];
    const ticket = ++generation.current;
    setRows([]);
    setError(false);
    setLimited(null);
    if (!file) return;
    try {
      if (file.size > 2 * 1024 * 1024) throw new Error("size");
      const next = matchRosterInvitations(parseRosterInvitations(await file.text()), invitations);
      if (generation.current === ticket) setRows(next);
    } catch {
      if (generation.current === ticket) setError(true);
    }
  }

  function send() {
    return runBusyWrite(busyWriteRef, "roster", () => sendNow());
  }

  async function sendNow() {
    if (sending.current || !chapters.some((chapter) => chapter.id === chapterId)) return;
    sending.current = true;
    setBusy(true);
    setLimited(null);
    const ticket = generation.current;
    // Stop at the first refusal: caps, access changes and failed deliveries
    // must not cause hundreds of extra requests. Accepted rows never retry.
    try {
      for (const row of rows.filter((item) => SENDABLE.includes(item.state))) {
        if (generation.current !== ticket) break;
        try {
          const result = await api.inviteMember({ email: row.email, fullName: row.fullName, locale: row.locale, chapterId, initialRole: null, source: "roster" });
          if (result?.accepted !== true) throw new Error("unconfirmed");
          if (generation.current === ticket) setRows((current) => current.map((item) => item.row === row.row ? { ...item, state: "sent" } : item));
        } catch (failure) {
          // A government or employer address can never be an account address:
          // that row is marked and the rest of the roster still goes out.
          if (failure?.code === "email-domain-blocked") {
            if (generation.current === ticket) setRows((current) => current.map((item) => item.row === row.row ? { ...item, state: "blocked" } : item));
            continue;
          }
          // A roster limit refused this row before anything was created: it
          // waits for the next batch, and the stop says which limit and when.
          const stop = failure?.code === "rate-limited" && LIMIT_KEYS[failure.limit] && failure.retryAt
            ? { key: LIMIT_KEYS[failure.limit], retryAt: failure.retryAt } : null;
          if (generation.current === ticket) {
            setRows((current) => current.map((item) => item.row === row.row ? { ...item, state: stop ? "waiting" : "failed" } : item));
            setLimited(stop);
          }
          break;
        }
      }
      if (generation.current === ticket) reload?.();
    } finally {
      sending.current = false;
      if (generation.current === ticket) setBusy(false);
    }
  }

  const ready = rows.filter((row) => SENDABLE.includes(row.state)).length;
  const matched = rows.filter((row) => row.state === "invited").length;
  return <section className="xus-cardbody roster-invitations" aria-label={t("roster.importTitle")}>
    <WorkspaceCardTitle as="h3" outline>{t("roster.importTitle")}</WorkspaceCardTitle>
    <p className="xus-note">{t("roster.importHelp")}</p>
    <p className="xus-note">{t("roster.importLimits")}</p>
    <label className="xus-field">{t("roster.chapter")}<BusySelect className="xus-input" value={chapterId} pending={busy} disabled={rows.some((row) => row.state === "sent")} onChange={(event) => setChapterId(event.target.value)}>
      {chapters.map((chapter) => <option key={chapter.id} value={chapter.id}>{chapter.name}</option>)}
    </BusySelect></label>
    <label className="xus-field">{t("roster.file")}<BusyInput type="file" accept=".csv,text/csv" pending={busy} onChange={read} /></label>
    {error && <p role="alert" className="xus-note">{t("roster.invalidFile")}</p>}
    {limited && <p role="alert" className="xus-note">{t(limited.key, { time: dateTimeFormat(lang, RETRY_TIME_OPTIONS).format(new Date(limited.retryAt)), count: ready })}</p>}
    {rows.length > 0 && <>
      <p role="status">{t("roster.preview", { total: rows.length, ready })}</p>
      {matched > 0 && <p className="xus-note">{t("roster.matched", { count: matched })}</p>}
      <ol className="roster-preview">{rows.map((row) => <li key={row.row}>{row.fullName || row.email} — {t(`roster.row.${row.state}`)}</li>)}</ol>
      <BusyButton type="button" className="xus-btn xus-btn--go" pending={busy} disabled={!ready || !chapters.some((chapter) => chapter.id === chapterId)} onClick={send}>
        {t(busy ? "roster.sending" : "roster.send", { count: ready })}
      </BusyButton>
    </>}
  </section>;
}
