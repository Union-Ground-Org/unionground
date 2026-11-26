import { useCallback, useEffect, useRef, useState } from "react";
import { BusyButton } from "../../components/BusyControls.jsx";
import { runBusyWrite } from "../../lib/busyWrite.js";
import { PLANE_CARD_CLASS } from "../../lib/staffPlaneStyles.js";
import { useLang } from "../../lib/LanguageContext.jsx";
import { formatDateTimeWithZone } from "../../lib/i18n/zonedDates.js";
import {
  disconnectOrganizationCalendar,
  loadGoogleActivations,
  saveOrganizationCalendarId,
  startOrganizationCalendarConnection,
} from "./googleActivations.js";

// Honest setup surface for the optional organization calendar activation
// (REQ-UG-ORG-CALENDAR-PUSH-SYNC-20261001). It says exactly what is
// missing: the operator's credentials, the administrator's Connect step, or the
// organization switch. No control is shown that cannot complete. There is no
// Google Wallet pass: Union Ground has no membership card to save.
function callbackNotice() {
  if (typeof window === "undefined") return "";
  const value = new URLSearchParams(window.location.search).get("calendar_push");
  return ["connected", "failed", "unset"].includes(value) ? value : "";
}

export function GoogleActivationsPanel({ client }) {
  const { t, lang } = useLang();
  const [state, setState] = useState({ status: "loading", data: null });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [calendarDraft, setCalendarDraft] = useState(null);
  const [notice] = useState(callbackNotice);
  const busyWriteRef = useRef(new Set());

  const refresh = useCallback(async () => {
    try {
      const data = await loadGoogleActivations(client);
      setState({ status: "ready", data });
    } catch (failure) {
      setState({ status: failure?.status === 403 ? "forbidden" : "error", data: null });
    }
  }, [client]);

  useEffect(() => { void refresh(); }, [refresh]);

  // One calendar change at a time: the Connect, Save and Disconnect controls
  // share one busy state, so they share one lock. Every action is async, so
  // none can settle in the same turn it starts.
  function run(action) {
    return runBusyWrite(busyWriteRef, "calendar", () => runNow(action));
  }

  async function runNow(action) {
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
    } catch {
      setError(t("googleActivations.actionFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (state.status === "forbidden") return null;
  const data = state.data;
  const calendar = data?.calendar;
  const connection = calendar?.connection || null;
  const calendarId = calendarDraft ?? connection?.calendarId ?? "primary";

  return (
    <article id="integration-google-activations" className={`${PLANE_CARD_CLASS} xus-card role-section-target`} tabIndex="-1">
      <header className="xus-cardhead">
        <div className="xus-cardhead__copy">
          <h2 className="xus-cardttl">{t("googleActivations.title")}</h2>
          <p className="xus-cardsub">{t("googleActivations.sub")}</p>
        </div>
      </header>
      <div className="xus-cardbody">
        {notice === "connected" ? <p className="xus-note" role="status">{t("googleActivations.calendarConnectedNotice")}</p> : null}
        {notice === "failed" ? <p className="xus-note xus-note--error" role="alert">{t("googleActivations.calendarFailedNotice")}</p> : null}
        {error ? <p className="xus-note xus-note--error" role="alert">{error}</p> : null}
        {state.status === "loading" ? <p className="xus-note" role="status">{t("googleActivations.loading")}</p> : null}
        {state.status === "error" ? (
          <>
            <p className="xus-note xus-note--error" role="alert">{t("googleActivations.loadFailed")}</p>
            <BusyButton type="button" className="xus-btn" pending={busy} onClick={() => void refresh()}>{t("integrations.retry")}</BusyButton>
          </>
        ) : null}
        {/* An organization administrator reads this card. Notes for Union
            Ground's operator ("the operator has not added ...") and the
            repository path of the setup guide are not theirs to act on, so an
            activation that is not set up shows only its title and summary
            under the card's "stays off until it is set up" line
            (BUG-UG-ADMIN-INTEGRATIONS-SHOWS-OPERATOR-NOTES-AND-REPO-PATH-20261106). */}
        {data ? (
          <ul>
            <li className="xus-erow">
              <div className="xus-emain">
                <strong className="xus-etitle">{t("googleActivations.calendarTitle")}</strong>
                <p className="xus-eline">{t("googleActivations.calendarSummary")}</p>
                {!calendar.configured ? null : !connection ? (
                  <>
                    <p className="xus-eline" role="status">{t("googleActivations.calendarNotConnected")}</p>
                    <BusyButton type="button" className="xus-btn xus-btn--go" pending={busy}
                      onClick={() => run(() => startOrganizationCalendarConnection(client))}>
                      {t("googleActivations.calendarConnect")}
                    </BusyButton>
                  </>
                ) : (
                  <>
                    <p className="xus-eline" role="status">
                      {t(connection.status === "error" ? "googleActivations.calendarError" : "googleActivations.calendarConnected", { account: connection.accountEmail || t("googleActivations.googleAccount") })}
                    </p>
                    {connection.lastErrorCode ? <p className="xus-eline">{t(connection.lastErrorCode === "grant_revoked" ? "googleActivations.calendarReconnect" : "googleActivations.calendarLastError")}</p> : null}
                    {!calendar.enabled ? <p className="xus-eline">{t("googleActivations.calendarSwitchOff")}</p> : null}
                    <small className="xus-meta">
                      {t("googleActivations.calendarScope", { scope: t(calendar.scope === "all_events" ? "googleActivations.scopeAll" : "googleActivations.scopePublic") })}
                      {" · "}{t("googleActivations.calendarCopied", { count: Number(calendar.copiedEvents || 0) })}
                      {Number(calendar.failingEvents || 0) > 0 ? ` · ${t("googleActivations.calendarFailing", { count: Number(calendar.failingEvents) })}` : ""}
                      {connection.lastRunAt ? ` · ${t("googleActivations.calendarLastRun", { date: formatDateTimeWithZone(connection.lastRunAt, lang) })}` : ""}
                    </small>
                    <form className="xus-form" onSubmit={(event) => {
                      event.preventDefault();
                      void run(async () => { await saveOrganizationCalendarId(client, calendarId); setCalendarDraft(null); });
                    }}>
                      <label className="xus-field">
                        {t("googleActivations.calendarId")}
                        <input className="xus-input" value={calendarId} maxLength={255} autoComplete="off"
                          aria-describedby="google-activations-calendar-id-hint"
                          onChange={(event) => setCalendarDraft(event.target.value)} />
                      </label>
                      <small className="xus-meta" id="google-activations-calendar-id-hint">{t("googleActivations.calendarIdHint")}</small>
                      <div className="xus-btnrow">
                        <BusyButton type="submit" className="xus-btn" pending={busy}>{t("googleActivations.calendarSave")}</BusyButton>
                        {connection.lastErrorCode === "grant_revoked" ? (
                          <BusyButton type="button" className="xus-btn xus-btn--go" pending={busy}
                            onClick={() => run(() => startOrganizationCalendarConnection(client))}>
                            {t("googleActivations.calendarConnect")}
                          </BusyButton>
                        ) : null}
                        <BusyButton type="button" className="xus-btn" pending={busy}
                          onClick={() => window.confirm(t("googleActivations.calendarDisconnectConfirm")) && run(() => disconnectOrganizationCalendar(client))}>
                          {t("googleActivations.calendarDisconnect")}
                        </BusyButton>
                      </div>
                    </form>
                  </>
                )}
              </div>
            </li>
          </ul>
        ) : null}
      </div>
    </article>
  );
}
