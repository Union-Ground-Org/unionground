// REQ-UG-AI-USAGE-DIGEST-20261001 — the weekly and monthly usage trend
// digest admins, stewards and chapter advisors read inside the analytics Usage
// view. Every figure arrives already floored and suppressed from
// public.get_analytics_usage_digests; this panel renders what it was given and
// says plainly when a window is withheld. Compass wording is requested only
// when the organization turned both switches on.
import { useCallback, useEffect, useRef, useState } from "react";
import { BusyButton } from "../../../components/BusyControls.jsx";
import { useLang } from "../../../lib/LanguageContext.jsx";
import { localeFor } from "../../../lib/i18n.js";
import { useRequestGeneration } from "../../../lib/useRequestGeneration.js";
import { normalizeUsageDigests } from "../usageDigest.js";

function Figure({ label, value, withheld }) {
  return (
    <div className="mi1-ana__tile">
      <span className="mi1-ana__tile-label">{label}</span>
      <span className="mi1-ana__tile-value">{value === null ? withheld : value}</span>
    </div>
  );
}

function DigestCard({ digest, copy, onWord, wording, error }) {
  const latest = digest.latest;
  return (
    <section className="mi1-ana__digest" data-usage-digest-period={digest.period}>
      <h3>{copy.period[digest.period]}</h3>
      <p className="mi1-ana__note">
        {copy.window(latest?.start, latest?.end)}
      </p>
      {!digest.hasData && <p className="mi1-ana__note">{copy.noData}</p>}
      {latest && (
        <div className="mi1-ana__grid">
          <Figure label={copy.actors} value={latest.actors} withheld={copy.withheld} />
          <Figure label={copy.checkins} value={latest.checkins} withheld={copy.withheld} />
        </div>
      )}
      {latest?.suppressed && <p className="mi1-ana__note">{copy.protected(latest.minCohort)}</p>}
      {digest.deltas.length > 0 && (
        <ul className="mi1-ana__digest-deltas">
          {digest.deltas.map((delta) => (
            <li key={delta.metric}>
              {copy.metric[delta.metric]}: {copy.direction[delta.direction]}
            </li>
          ))}
        </ul>
      )}
      {latest && !latest.suppressed && latest.checkins === null && (
        <p className="mi1-ana__note">{copy.checkinsProtected(latest.minCohort)}</p>
      )}
      {digest.ai.status === "enriched" && (
        <div className="mi1-ana__digest-ai">
          <p>{digest.ai.summary}</p>
          {digest.ai.highlights.length > 0 && (
            <ul>{digest.ai.highlights.map((item) => <li key={item}>{item}</li>)}</ul>
          )}
          {digest.ai.caution && <p className="mi1-ana__note">{digest.ai.caution}</p>}
          <p className="mi1-ana__note">{copy.aiNotice}</p>
        </div>
      )}
      {digest.hasData && digest.ai.status === "available" && onWord && (
        <BusyButton
          type="button"
          className="plane-button"
          pending={wording}
          onClick={() => onWord(digest)}
        >
          {wording ? copy.wordingBusy : copy.wordingAction}
        </BusyButton>
      )}
      {error && <p className="mi1-ana__note" role="status">{error}</p>}
    </section>
  );
}

export function UsageDigestPanel({ load = null, onRequestWording = null }) {
  const { lang, t } = useLang();
  const [model, setModel] = useState(null);
  const [state, setState] = useState(load ? "loading" : "idle");
  const [busyId, setBusyId] = useState(null);
  // Record 8435: a synchronous lock that mirrors busyId exactly. It names the
  // digest whose wording request is the live one, so a second press on that
  // digest is refused before React commits busy, and it clears at every point
  // busyId clears (the live request settling, a new read, a replaced wording
  // callback). A newer request for another digest supersedes it, as before.
  const liveWording = useRef(null);
  const [error, setError] = useState("");
  const requests = useRequestGeneration(load);
  const wordingRequests = useRequestGeneration(onRequestWording);

  const formatDate = useCallback((value) => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
    const [year, month, day] = value.split("-").map(Number);
    // Date only: no time part, so the app's one clock helper is not involved.
    return new Intl.DateTimeFormat(localeFor(lang), {
      year: "numeric", month: "short", day: "numeric", timeZone: "UTC",
    }).format(Date.UTC(year, month - 1, day));
  }, [lang]);

  const copy = {
    title: t("usageDigest.title"),
    sub: t("usageDigest.sub"),
    off: t("usageDigest.off"),
    loading: t("usageDigest.loading"),
    unavailable: t("usageDigest.unavailable"),
    noData: t("usageDigest.noData"),
    withheld: t("usageDigest.withheld"),
    protected: (floor) => t("usageDigest.protected", { count: floor }),
    actors: t("usageDigest.actors"),
    checkins: t("usageDigest.checkins"),
    aiNotice: t("usageDigest.aiNotice"),
    wordingAction: t("usageDigest.wordingAction"),
    wordingBusy: t("usageDigest.wordingBusy"),
    wordingFailed: t("usageDigest.wordingFailed"),
    period: { weekly: t("usageDigest.periodWeekly"), monthly: t("usageDigest.periodMonthly") },
    metric: { actors: t("usageDigest.actors"), checkins: t("usageDigest.checkins") },
    direction: {
      up: t("usageDigest.directionUp"),
      down: t("usageDigest.directionDown"),
      flat: t("usageDigest.directionFlat"),
      unknown: t("usageDigest.directionUnknown"),
    },
    window: (start, end) => `${formatDate(start)} – ${formatDate(end)}`,
    checkinsProtected: (floor) => t("usageDigest.checkinsProtected", { count: floor }),
  };

  useEffect(() => {
    if (!load) return;
    const request = requests.begin();
    setBusyId(null);
    liveWording.current = null;
    setError("");
    setState("loading");
    load()
      .then((payload) => {
        if (!request.isCurrent()) return;
        setModel(normalizeUsageDigests(payload));
        setState("ready");
      })
      .catch(() => {
        if (!request.isCurrent()) return;
        setState("error");
      });
  }, [load, requests]);

  useEffect(() => { setBusyId(null); liveWording.current = null; setError(""); }, [wordingRequests]);

  const requestWording = useCallback(async (digest) => {
    if (!onRequestWording || !digest?.id || liveWording.current?.id === digest.id) return;
    const live = { id: digest.id };
    liveWording.current = live;
    // Both calls return a full digest model. A later read/wording wins, and a
    // replaced wording callback retires its work without causing a new read.
    const request = requests.begin();
    const wording = wordingRequests.begin();
    const current = () => request.isCurrent() && wording.isCurrent();
    setBusyId(digest.id);
    setError("");
    try {
      const payload = await onRequestWording({ digestId: digest.id, period: digest.period });
      if (!current()) return;
      if (payload) setModel(normalizeUsageDigests(payload));
    } catch {
      if (current()) setError(t("usageDigest.wordingFailed"));
    } finally {
      if (current()) setBusyId(null);
      if (liveWording.current === live) liveWording.current = null;
    }
  }, [onRequestWording, requests, wordingRequests, t]);

  if (state === "idle") return null;
  return (
    <section className="mi1-ana__digests" data-usage-digest="">
      <h2 className="ach-card__title">{copy.title}</h2>
      <p className="mi1-ana__note">{copy.sub}</p>
      {state === "loading" && <p className="mi1-ana__loading" role="status" aria-live="polite">{copy.loading}</p>}
      {state === "error" && <p className="mi1-ana__note" role="status">{copy.unavailable}</p>}
      {state === "ready" && model && !model.enabled && <p className="mi1-ana__note">{copy.off}</p>}
      {state === "ready" && model?.enabled && model.digests.length === 0 && <p className="mi1-ana__note">{copy.noData}</p>}
      {state === "ready" && model?.enabled && model.digests.map((digest) => (
        <DigestCard
          key={digest.period}
          digest={digest}
          copy={copy}
          onWord={onRequestWording ? requestWording : null}
          wording={busyId === digest.id}
          error={busyId === null && error && digest.ai.status === "available" ? error : ""}
        />
      ))}
    </section>
  );
}
