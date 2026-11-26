import { useEffect, useRef, useState } from "react";
import { PLANE_CARD_CLASS } from "../../lib/staffPlaneStyles.js";
import { useLang } from "../../lib/LanguageContext.jsx";
import { formatDateTimeWithZone } from "../../lib/i18n/zonedDates.js";
import { WEBHOOK_EVENTS } from "./webhooks.js";
import { INTEGRATION_PROVIDER_CATALOG } from "./catalog.js";
import { FireworksConnector } from "./FireworksConnector.jsx";
import { ScimSetup } from "./ScimSetup.jsx";
import { RoutedTabPages, WorkspaceTabSection, useWorkspace, workspaceHref } from "../../components/WorkspacePages.jsx";
import { BusyButton } from "../../components/BusyControls.jsx";
import { runBusyWrite } from "../../lib/busyWrite.js";

function Card({ id, title, sub, children }) {
  return (
    <article id={id} className={`${PLANE_CARD_CLASS} xus-card role-section-target`} tabIndex="-1">
      <header className="xus-cardhead">
        <div className="xus-cardhead__copy">
          <h2 className="xus-cardttl">{title}</h2>
          <p className="xus-cardsub">{sub}</p>
        </div>
      </header>
      <div className="xus-cardbody">{children}</div>
    </article>
  );
}

// A status, job kind or provider the catalogue does not name stays readable as
// its own token rather than printing the missing key at the staff surface.
function orToken(t, key, token) {
  const label = t(key);
  return label === key ? token : label;
}

function statusLabel(t, status) {
  return orToken(t, `integrations.status.${status}`, status);
}

// The provider catalog carries the English label and setup summary as data.
// The catalogue carries both locales; a provider it does not name falls back to
// the catalog entry, which is what the Spanish table used to do.
function providerLabel(t, row) {
  return orToken(t, `integrations.provider.${row.provider}.label`, row.catalog.label);
}

// A job row names its service, kind and status in words (#10033, B-56 of
// #9529): it used to read "twilio provider_health · queued".
function jobProviderLabel(t, provider) {
  return orToken(t, `integrations.provider.${provider}.label`, INTEGRATION_PROVIDER_CATALOG[provider]?.label || provider);
}

function jobKindLabel(t, kind) {
  return orToken(t, `integrations.jobKind.${kind}`, kind);
}

function jobStatusLabel(t, job) {
  return job.providerStatus
    ? orToken(t, `integrations.providerStatus.${job.providerStatus}`, job.providerStatus)
    : orToken(t, `integrations.jobStatus.${job.status}`, job.status);
}

function providerSummary(t, row) {
  return orToken(t, `integrations.provider.${row.provider}.summary`, row.catalog.setupSummary);
}

const SMS_PURPOSES = Object.freeze(["urgent_alert", "policy_notice", "onboarding"]);

const E164_PHONE = /^\+[1-9][0-9]{7,14}$/;

// Keep only the persisted chapter settings the organization still allows, so a
// status change never erases them and never trips the RPC's allowed-key check.
function allowedChapterSettings(row) {
  const settings = row.chapterOverride?.overrideSettings;
  if (!settings || typeof settings !== "object") return {};
  const allowed = row.allowedChapterOverrideKeys || [];
  return Object.fromEntries(Object.entries(settings).filter(([key]) => allowed.includes(key)));
}

// A chapter control is only real when the provider has an override catalog. The
// server keeps `allow_chapter_overrides` false for a provider with no keys, so
// offering the opt-in there is a button that can never change anything.
function offersChapterControls(row) {
  if (row.provider === "scim") return false;
  if (row.allowChapterOverrides) return true;
  return Boolean(row.allowedChapterOverrideKeys?.length || row.catalog?.chapterOverrideKeys?.length);
}

// Sync-run statuses arrive as the provider tokens the table constrains
// (success / warning / failed). A token this release does not know still has to
// read as a word, never as a bare provider string.
// The control read returns null totals when the backend withholds them (a
// platform organization's results); 0 is a measured zero (#6277).
const CONSTANT_CONTACT_TOTALS = ["memberCount", "activeContactCount", "sendCount", "openCount", "clickCount"];
function constantContactTotalsWithheld(constantContact) {
  return CONSTANT_CONTACT_TOTALS.some((key) => constantContact?.[key] === null);
}

function syncRunStatusLabel(t, status) {
  return orToken(t, `integrations.ccRunStatus.${status}`, t("integrations.ccRunStatus.unknown"));
}

export function IntegrationControlPlane({ store, actor, notice = "", noticeRole = "status", googleActivations = null }) {
  const workspace = useWorkspace();
  const { lang, t } = useLang();
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState("");
  const [actionNotice, setActionNotice] = useState("");
  // #9936: the confirmation line stays mounted (its text changes), is
  // scrolled into view when it is set off screen, and clears on a tab change.
  const actionNoticeRef = useRef(null);
  const activeTab = workspace?.page?.group === "integrations" ? workspace.page.tab : null;
  const shownTab = useRef(activeTab);
  useEffect(() => {
    if (shownTab.current === activeTab) return;
    shownTab.current = activeTab;
    setActionNotice("");
  }, [activeTab]);
  useEffect(() => {
    const line = actionNoticeRef.current;
    if (!actionNotice || !line || typeof window === "undefined") return;
    const box = line.getBoundingClientRect();
    if (box.top < 0 || box.bottom > window.innerHeight) line.scrollIntoView?.({ block: "nearest" });
  }, [actionNotice]);
  const [secretOnce, setSecretOnce] = useState(null);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookEvents, setWebhookEvents] = useState([]);
  const [apiKeyName, setApiKeyName] = useState("");
  const [smsMemberId, setSmsMemberId] = useState("");
  const [smsMemberQuery, setSmsMemberQuery] = useState("");
  const [smsMemberResults, setSmsMemberResults] = useState([]);
  const [smsPurpose, setSmsPurpose] = useState("urgent_alert");
  const [smsBody, setSmsBody] = useState("");
  const [smsIdempotencyKey, setSmsIdempotencyKey] = useState(() => globalThis.crypto.randomUUID());
  const [smsNotice, setSmsNotice] = useState("");
  const [chapterFromNumberDraft, setChapterFromNumberDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  // Every action here shares one busy state, so they share one synchronous
  // lock: a second activation is refused before React commits busy (#8435).
  const busyWriteRef = useRef(new Set());
  const exclusive = (work) => runBusyWrite(busyWriteRef, "integration", work);
  const smsMemberIdRef = useRef(smsMemberId);
  const smsMemberResultsRef = useRef(smsMemberResults);
  smsMemberIdRef.current = smsMemberId;
  smsMemberResultsRef.current = smsMemberResults;

  // Every provider timestamp on this screen is an ISO-8601 instant. Route them
  // all through the repository's single locale source so the stamps read in the
  // member's language beside the COPY labels instead of as machine UTC.
  const stamp = (value) => formatDateTimeWithZone(value, lang);

  // Single sign-on is on the release calendar (#8579). Its tab, page and setup
  // show only once the server says it is released; while it is held, or its
  // state cannot be read, a link to the tab lands on the first tab instead
  // (docs/contracts/staged-feature-releases.md, "Held means invisible").
  const [ssoReleased, setSsoReleased] = useState(null);
  useEffect(() => {
    let active = true;
    Promise.resolve(store.getSsoControl?.(actor))
      .then((result) => { if (active) setSsoReleased(result?.ok === true && result.data?.released !== false); })
      .catch(() => { if (active) setSsoReleased(false); });
    return () => { active = false; };
  }, [actor, store]);

  // Directory sync (SCIM) is held with single sign-on (#9037): its tab, setup
  // and Providers row show only once public.get_scim_control() answers
  // released, the same way. Try again reads it again too,
  // and a setup write that answers held hides it at once.
  const [scimReleased, setScimReleased] = useState(null);
  const [scimAttempt, setScimAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    Promise.resolve(store.getScimControl?.(actor))
      .then((result) => { if (active) setScimReleased(result?.ok === true && result.data?.released !== false); })
      .catch(() => { if (active) setScimReleased(false); });
    return () => { active = false; };
  }, [actor, store, scimAttempt]);
  const heldTabs = [...(ssoReleased ? [] : ["sso"]), ...(scimReleased ? [] : ["scim"])];

  useEffect(() => {
    let active = true;
    Promise.resolve(store.getSnapshot(actor)).then((result) => {
      if (!active) return;
      if (!result.ok) {
        setSnapshot(null);
        setError(result.reason === "unauthorized"
          ? t("integrations.unauthorized")
          : t("integrations.unavailable"));
        return;
      }
      setError("");
      setSnapshot(result.data);
    }).catch(() => {
      if (!active) return;
      setSnapshot(null);
      setError(t("integrations.unavailable"));
    });
    return () => { active = false; };
  }, [actor, lang, store, t]);

  async function refresh({ preserveError = false } = {}) {
    const result = await store.getSnapshot(actor);
    if (!result.ok) {
      setSnapshot(null);
      setError(result.reason === "unauthorized"
        ? t("integrations.unauthorized")
        : t("integrations.unavailable"));
      return;
    }
    if (!preserveError) setError("");
    setSnapshot(result.data);
  }

  // #9936: successKey (a key, or a function of the result giving one) is the
  // confirmation shown at the top of the page on every tab; onSuccess runs
  // only when the action succeeded.
  function run(action, successKey = "", onSuccess = null) {
    return exclusive(() => runNow(action, successKey, onSuccess));
  }

  async function runNow(action, successKey = "", onSuccess = null) {
    setBusy(true);
    setError("");
    setActionNotice("");
    try {
      const result = await action();
      const actionFailed = !result?.ok;
      if (actionFailed) setError(publicError(result?.reason, t));
      // The key, not its text: a language change re-renders the confirmation.
      else {
        const key = typeof successKey === "function" ? successKey(result) : successKey;
        if (key) setActionNotice(key);
        onSuccess?.();
      }
      if (result?.signingSecret) setSecretOnce({
        label: t("integrations.signingSecret"),
        value: result.signingSecret.plaintext,
        custody: t("integrations.signingCustody"),
      });
      if (result?.secret) setSecretOnce({
        label: t("integrations.apiKey"),
        value: result.secret.plaintext,
        custody: t("integrations.keyCustody"),
      });
      await refresh({ preserveError: actionFailed });
    } catch {
      setError(t("integrations.changeFailed"));
    } finally {
      setBusy(false);
    }
  }

  function saveChapterFromNumber(event, row) {
    event.preventDefault();
    const fromNumber = (chapterFromNumberDraft ?? row.chapterOverride?.overrideSettings?.fromNumber ?? "").trim();
    if (fromNumber && !E164_PHONE.test(fromNumber)) {
      setError(t("integrations.invalidFromNumber"));
      return;
    }
    const { fromNumber: _previous, ...rest } = allowedChapterSettings(row);
    run(async () => {
      const result = await store.setChapterOverride(actor, {
        provider: row.provider,
        chapterId: actor.chapterId,
        status: "enabled",
        overrideSettings: fromNumber ? { ...rest, fromNumber } : rest,
      });
      if (result?.ok) setChapterFromNumberDraft(null);
      return result;
    });
  }

  function startConstantContact() {
    return exclusive(() => startConstantContactNow());
  }

  async function startConstantContactNow() {
    setBusy(true);
    setError("");
    try {
      const result = await store.beginConstantContactOAuth(actor);
      if (!result?.ok || !result.authorizationUrl) {
        setError(publicError(result?.reason, t));
        return;
      }
      window.location.assign(result.authorizationUrl);
    } catch {
      setError(t("integrations.changeFailed"));
    } finally {
      setBusy(false);
    }
  }

  function loadOlderDeliveries() {
    return exclusive(() => loadOlderDeliveriesNow());
  }

  async function loadOlderDeliveriesNow() {
    if (!snapshot?.deliveryCursor) return;
    setBusy(true);
    setError("");
    try {
      const result = await store.listWebhookDeliveries(actor, snapshot.deliveryCursor);
      if (!result?.ok) {
        setError(publicError(result?.reason, t));
        return;
      }
      const page = result.data || {};
      setSnapshot((current) => ({
        ...(current || {}),
        deliveries: [
          ...(Array.isArray(current?.deliveries) ? current.deliveries : []),
          ...(Array.isArray(page.items)
            ? page.items.filter((item) => !(current?.deliveries || []).some((existing) => existing.id === item.id))
            : []),
        ],
        deliveryCursor: page.nextBeforeCreatedAt && page.nextBeforeId
          ? { beforeCreatedAt: page.nextBeforeCreatedAt, beforeId: page.nextBeforeId }
          : null,
      }));
    } catch {
      setError(t("integrations.olderFailed"));
    } finally {
      setBusy(false);
    }
  }

  function loadOlderJobs() {
    return exclusive(() => loadOlderJobsNow());
  }

  async function loadOlderJobsNow() {
    if (!snapshot?.jobCursor) return;
    setBusy(true);
    setError("");
    try {
      const result = await store.listIntegrationJobs(actor, snapshot.jobCursor);
      if (!result?.ok) {
        setError(publicError(result?.reason, t));
        return;
      }
      const page = result.data || {};
      setSnapshot((current) => ({
        ...(current || {}),
        jobs: [
          ...(Array.isArray(current?.jobs) ? current.jobs : []),
          ...(Array.isArray(page.items)
            ? page.items
              .map((job) => ({ ...job, kind: job.kind || job.jobKind || "unknown" }))
              .filter((item) => !(current?.jobs || []).some((existing) => existing.id === item.id))
            : []),
        ],
        jobCursor: page.nextBeforeCreatedAt && page.nextBeforeId
          ? { beforeCreatedAt: page.nextBeforeCreatedAt, beforeId: page.nextBeforeId }
          : null,
      }));
    } catch {
      setError(t("integrations.olderJobsFailed"));
    } finally {
      setBusy(false);
    }
  }

  function searchSmsRecipients(event) {
    event?.preventDefault?.();
    return exclusive(() => searchSmsRecipientsNow(event));
  }

  async function searchSmsRecipientsNow(event) {
    event?.preventDefault?.();
    if (smsMemberQuery.trim().length < 2) return;
    setBusy(true);
    setError("");
    try {
      const result = await store.searchSmsRecipients(actor, smsMemberQuery);
      if (!result?.ok) setError(publicError(result?.reason, t));
      else {
        const next = Array.isArray(result.data) ? result.data : [];
        const selectedId = smsMemberIdRef.current;
        const selected = selectedId
          ? smsMemberResultsRef.current.find((member) => member.userId === selectedId)
          : null;
        setSmsMemberResults(
          selected && !next.some((member) => member.userId === selected.userId)
            ? [selected, ...next]
            : next,
        );
      }
    } catch {
      setError(t("integrations.changeFailed"));
    } finally {
      setBusy(false);
    }
  }

  if (!snapshot) {
    return (
      <section aria-label={t("integrations.plane")}>
        {secretOnce ? (
          <Card id="integration-secret-once" title={t("integrations.copyNow")} sub={secretOnce.custody}>
            <p className="xus-note">{secretOnce.label}</p>
            <input readOnly value={secretOnce.value} aria-label={secretOnce.label} onFocus={(event) => event.target.select()} />
            <button type="button" className="xus-btn" onClick={() => setSecretOnce(null)}>{t("integrations.copied")}</button>
          </Card>
        ) : null}
        <Card id="integration-control" title={t("integrations.integrations")} sub={t("integrations.integrationSub")}>
          <p className="xus-note" role="status">{error || t("integrations.loading")}</p>
          {error ? <BusyButton type="button" className="xus-btn" pending={busy} onClick={() => { setScimAttempt((value) => value + 1); return refresh(); }}>{t("integrations.retry")}</BusyButton> : null}
        </Card>
      </section>
    );
  }

  return (
    <section aria-label={t("integrations.plane")}>
      <RoutedTabPages group="integrations" hidden={heldTabs} redirectHidden={ssoReleased !== null && scimReleased !== null} labels={{ title: t("integrations.integrations"), providers: t("integrations.providers"), "constant-contact": t("integrations.ccTitle"), jobs: t("integrations.jobs"), sms: t("integrations.smsSend"), webhooks: t("integrations.webhooks"), "api-keys": t("integrations.apiKeys"), scim: t("integrations.scim"), sso: t("integrations.sso") }} />
      {notice ? <p className="xus-note" role={noticeRole}>{notice}</p> : null}
      {error ? <p className="xus-note xus-note--error" role="alert">{error}</p> : null}
      <p ref={actionNoticeRef} className="xus-note xus-note--live" role="status">{actionNotice ? t(actionNotice) : ""}</p>
      {secretOnce ? (
        <Card id="integration-secret-once" title={t("integrations.copyNow")} sub={secretOnce.custody}>
          <p className="xus-note">{secretOnce.label}</p>
          <input readOnly value={secretOnce.value} aria-label={secretOnce.label} onFocus={(event) => event.target.select()} />
          <button type="button" className="xus-btn" onClick={() => setSecretOnce(null)}>{t("integrations.copied")}</button>
        </Card>
      ) : null}

      <WorkspaceTabSection group="integrations" name="providers"><Card
        id="integration-providers"
        title={t("integrations.providers")}
        sub={t("integrations.providersSub")}
      >
        <ul>
          {snapshot.providers.filter((row) => row.catalog?.setupSurface !== "dues" && (row.provider !== "scim" || scimReleased)).map((row) => (
            <li className="xus-erow" key={row.provider}>
              <div className="xus-etop">
                <div className="xus-emain">
                  <strong className="xus-etitle">{providerLabel(t, row)}</strong>
                  <p className="xus-eline">{providerSummary(t, row)}</p>
                  <small className="xus-meta">{statusLabel(t, row.status)} · {row.effective.enabled ? t("integrations.effectiveOn") : t("integrations.effectiveOff")}</small>
                </div>
                {row.provider === "scim" ? (
                  <a className="xus-btn" href={workspaceHref("/m/integrations/scim")} onClick={(event) => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); workspace.open("/m/integrations/scim"); }}>{t("integrations.scimOpenSetup")}</a>
                ) : row.status === "unset" ? (
                  <BusyButton
                    type="button"
                    className="xus-btn xus-btn--go"
                    aria-label={`${t("integrations.requestSetup")} ${row.catalog.label}`}
                    pending={busy}
                    onClick={() => run(() => store.requestActivation(actor, { provider: row.provider }), "integrations.done.setupRequested")}
                  >
                    {t("integrations.requestSetup")}
                  </BusyButton>
                ) : (
                  <div className="xus-btnrow">
                    <span className="xus-chip">{statusLabel(t, row.status)}</span>
                    {/* Inventory A1: off, or ask again, without resending credentials or settings. */}
                    {row.status === "disabled" ? (
                      <BusyButton
                        type="button"
                        className="xus-btn"
                        aria-label={`${t("integrations.requestAgain")} ${row.catalog.label}`}
                        pending={busy}
                        onClick={() => run(() => store.setProviderStatus(actor, { provider: row.provider, status: "requested" }))}
                      >
                        {t("integrations.requestAgain")}
                      </BusyButton>
                    ) : (
                      <BusyButton
                        type="button"
                        className="xus-btn"
                        aria-label={`${t("integrations.turnOff")} ${row.catalog.label}`}
                        pending={busy}
                        onClick={() => run(() => store.setProviderStatus(actor, { provider: row.provider, status: "disabled" }))}
                      >
                        {t("integrations.turnOff")}
                      </BusyButton>
                    )}
                  </div>
                )}
              </div>
              {actor.chapterId && offersChapterControls(row) ? (
                <div className="xus-btnrow" aria-label={`${row.catalog.label} ${t("integrations.chapterControls")}`}>
                  {!row.allowChapterOverrides ? (
                    <BusyButton
                      type="button"
                      className="xus-btn"
                      pending={busy}
                      onClick={() => run(() => store.configureProvider(actor, {
                        provider: row.provider,
                        allowChapterOverrides: true,
                        allowedChapterOverrideKeys: row.allowedChapterOverrideKeys.length
                          ? row.allowedChapterOverrideKeys
                          : row.catalog.chapterOverrideKeys,
                      }))}
                    >
                      {t("integrations.enableChapter")}
                    </BusyButton>
                  ) : [
                    ["inherit", t("integrations.inherit")],
                    ["enabled", t("integrations.enableHere")],
                    ["disabled", t("integrations.disableHere")],
                  ].map(([status, label]) => (
                    <BusyButton
                      type="button"
                      className="xus-btn"
                      pending={busy} disabled={(row.chapterOverride?.status || "inherit") === status}
                      key={status}
                      onClick={() => run(() => store.setChapterOverride(actor, {
                        provider: row.provider,
                        chapterId: actor.chapterId,
                        status,
                        overrideSettings: allowedChapterSettings(row),
                      }))}
                    >
                      {label}
                    </BusyButton>
                  )).concat(
                    // Inventory A1: chapter controls could be switched on but never off.
                    <BusyButton
                      type="button"
                      className="xus-btn"
                      key="chapter-controls-off"
                      pending={busy}
                      onClick={() => run(() => store.configureProvider(actor, {
                        provider: row.provider,
                        allowChapterOverrides: false,
                        allowedChapterOverrideKeys: [],
                      }))}
                    >
                      {t("integrations.disableChapter")}
                    </BusyButton>,
                  )}
                </div>
              ) : null}
              {actor.chapterId
                && row.provider === "twilio"
                && row.allowChapterOverrides
                && row.chapterOverride?.status === "enabled"
                && (row.allowedChapterOverrideKeys || []).includes("fromNumber") ? (
                <form className="xus-form" onSubmit={(event) => saveChapterFromNumber(event, row)}>
                  <label className="xus-field">
                    {t("integrations.chapterFromNumber")}
                    <input
                      className="xus-input"
                      type="tel"
                      inputMode="tel"
                      autoComplete="off"
                      aria-describedby="integration-chapter-from-number-hint"
                      value={chapterFromNumberDraft ?? row.chapterOverride.overrideSettings?.fromNumber ?? ""}
                      onChange={(event) => setChapterFromNumberDraft(event.target.value)}
                    />
                  </label>
                  <small className="xus-meta" id="integration-chapter-from-number-hint">{t("integrations.chapterFromNumberHint")}</small>
                  <BusyButton type="submit" className="xus-btn" pending={busy}>{t("integrations.saveChapterFromNumber")}</BusyButton>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      </Card></WorkspaceTabSection>

      <WorkspaceTabSection group="integrations" name="providers">
        <Card id="integration-ai-connector" title={t("integrations.fireworksSectionTitle")} sub={t("integrations.fireworksSub")}>
          {snapshot.organizationId === actor.selectedOrganizationId ? <FireworksConnector key={actor.selectedOrganizationId} store={store} actor={actor} connectors={snapshot.aiConnectors} onRefresh={refresh} /> : null}
        </Card>
      </WorkspaceTabSection>

      {googleActivations ? <WorkspaceTabSection group="integrations" name="providers">{googleActivations}</WorkspaceTabSection> : null}

      <WorkspaceTabSection group="integrations" name="constant-contact"><Card id="integration-constant-contact" title={t("integrations.ccTitle")} sub={t("integrations.ccSub")}>
        {!snapshot.constantContact?.available ? (
          <p className="xus-note" role="status">{t("integrations.ccUnavailable")}</p>
        ) : snapshot.constantContact.connected ? (
          <>
            {/* A null total is withheld by the backend (a platform organization's
                results); only an absent key falls back to zero (#6277). */}
            <div className="xus-erow">
              <div className="xus-emain">
                <strong className="xus-etitle">{snapshot.constantContact.accountLabel || t("integrations.ccConnected")}</strong>
                <p className="xus-eline">
                  {t("integrations.ccLastSync")}: {stamp(snapshot.constantContact.lastSyncAt) || t("integrations.ccNeverSynced")}
                </p>
                {constantContactTotalsWithheld(snapshot.constantContact) ? null : (
                  <small className="xus-meta">
                    {snapshot.constantContact.memberCount || 0} {t("integrations.ccMembers")} · {snapshot.constantContact.activeContactCount || 0} {t("integrations.ccActive")}
                  </small>
                )}
              </div>
              <div className="xus-btnrow">
                <BusyButton type="button" className="xus-btn xus-btn--go" pending={busy} onClick={() => run(() => store.syncConstantContact(actor, { limit: 25 }), (result) => (result?.skipped ? "integrations.done.syncNothing" : "integrations.done.syncFinished"))}>{t("integrations.ccSync")}</BusyButton>
                <BusyButton type="button" className="xus-btn" pending={busy} onClick={() => run(() => store.disconnectConstantContact(actor))}>{t("integrations.ccDisconnect")}</BusyButton>
              </div>
            </div>
            <p className="xus-note">
              {constantContactTotalsWithheld(snapshot.constantContact)
                ? t("integrations.ccTotalsWithheld")
                : <>{snapshot.constantContact.sendCount || 0} {t("integrations.ccSends")} · {snapshot.constantContact.openCount || 0} {t("integrations.ccOpens")} · {snapshot.constantContact.clickCount || 0} {t("integrations.ccClicks")}</>}
            </p>
            <p className="xus-note">{t("integrations.ccAnalyticsLimit")}</p>
          </>
        ) : snapshot.providers.find((row) => row.provider === "constant_contact")?.status === "unset" ? (
          <p className="xus-note">{t("integrations.ccRequestFirst")}</p>
        ) : (
          <BusyButton type="button" className="xus-btn xus-btn--go" pending={busy} onClick={startConstantContact}>{t("integrations.ccConnect")}</BusyButton>
        )}

        <h3 className="xus-etitle">{t("integrations.ccHistory")}</h3>
        {snapshot.constantContact?.syncRuns?.length ? (
          <ol>
            {snapshot.constantContact.syncRuns.map((runItem) => (
              <li className="xus-row" key={runItem.id}>
                <strong>{syncRunStatusLabel(t, runItem.status)}</strong>
                <span>{runItem.processedCount} · {runItem.matchedCount} {t("integrations.ccMembers")} · {stamp(runItem.finishedAt)}</span>
              </li>
            ))}
          </ol>
        ) : <p className="xus-note">{t("integrations.ccNoHistory")}</p>}

        <h3 className="xus-etitle">{t("integrations.ccAnalytics")}</h3>
        {snapshot.constantContact?.analytics?.length ? (
          <ul>
            {snapshot.constantContact.analytics.map((row) => (
              <li className="xus-row" key={row.memberId}>
                <strong>{row.memberName}</strong>
                <span>{row.sendsCount} {t("integrations.ccSends")} · {row.opensCount} {t("integrations.ccOpens")} · {row.clicksCount} {t("integrations.ccClicks")} · {t("integrations.ccActivity")}: {stamp(row.lastActivityAt) || t("integrations.ccNoActivity")}</span>
              </li>
            ))}
          </ul>
        ) : <p className="xus-note">{t("integrations.ccNoAnalytics")}</p>}
      </Card></WorkspaceTabSection>

      <WorkspaceTabSection group="integrations" name="jobs"><Card id="integration-jobs" title={t("integrations.jobs")} sub={t("integrations.jobsSub")}>
        <p className="xus-note">{t("integrations.queuePermission")}</p>
        {snapshot.jobs.length === 0 ? <p className="xus-note">{t("integrations.noJobs")}</p> : (
          <ul>
            {snapshot.jobs.map((job) => (
              <li className="xus-row" key={job.id}>
                <strong>{jobProviderLabel(t, job.provider)}</strong>
                <span> {jobKindLabel(t, job.kind)} · {jobStatusLabel(t, job)}</span>
                {job.errorCode ? <small className="xus-meta">{job.errorCode}</small> : null}
                {job.status === "failed"
                  && ["provider_health", "connection_probe"].includes(job.kind)
                  && Number(job.attemptCount || 0) < 5
                  && snapshot.capabilities?.jobsWrite !== false ? (
                  <BusyButton type="button" className="xus-btn" aria-label={`${t("integrations.retryJob")} ${jobProviderLabel(t, job.provider)} ${jobKindLabel(t, job.kind)}`} pending={busy} onClick={() => run(() => store.retryJob(actor, { jobId: job.id }), "integrations.done.jobRequeued")}>{t("integrations.retryJob")}</BusyButton>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {snapshot.jobCursor ? <BusyButton type="button" className="xus-btn" pending={busy} onClick={loadOlderJobs}>{t("integrations.loadOlderJobs")}</BusyButton> : null}
        {snapshot.capabilities?.jobsWrite !== false ? <div className="xus-btnrow">
          <BusyButton
            type="button"
            className="xus-btn"
            pending={busy}
            onClick={() => run(() => store.enqueueJob(actor, { provider: "twilio", kind: "provider_health" }), "integrations.readinessQueued")}
          >
            {t("integrations.queueCheck")}
          </BusyButton>
          <BusyButton type="button" className="xus-btn" pending={busy} onClick={() => run(() => store.runNextJob(actor), "integrations.done.nextJobProcessed")}>{t("integrations.runNext")}</BusyButton>
        </div> : <p className="xus-note">{t("integrations.workerOnly")}</p>}
      </Card></WorkspaceTabSection>

      {snapshot.providers.some((row) => row.provider === "twilio" && row.status === "connected" && row.effective.enabled) ? (
        <WorkspaceTabSection group="integrations" name="sms"><Card id="integration-sms-send" title={t("integrations.smsSend")} sub={t("integrations.smsSendSub")}>
          {smsNotice ? <p className="xus-note" role="status">{smsNotice}</p> : null}
          <div className="xus-form">
          <form className="xus-form" onSubmit={searchSmsRecipients}>
            <label className="xus-field">{t("integrations.memberSearch")}<input className="xus-input" type="search" minLength="2" value={smsMemberQuery} onChange={(event) => setSmsMemberQuery(event.target.value)} autoComplete="off" /></label>
            <BusyButton type="submit" className="xus-btn" pending={busy} disabled={smsMemberQuery.trim().length < 2}>{t("integrations.searchMembers")}</BusyButton>
          </form>
          <form className="xus-form" onSubmit={(event) => {
            event.preventDefault();
            exclusive(() => {
              setBusy(true);
              setError("");
              setSmsNotice("");
              return Promise.resolve(store.sendSms(actor, {
                memberId: smsMemberId.trim(),
                purpose: smsPurpose,
                body: smsBody.trim(),
                idempotencyKey: smsIdempotencyKey,
              })).then(async (result) => {
                if (!result?.ok) setError(publicError(result?.reason, t));
                else {
                  setSmsBody("");
                  setSmsIdempotencyKey(globalThis.crypto.randomUUID());
                  setSmsNotice(t("integrations.messageQueued"));
                }
                await refresh({ preserveError: !result?.ok });
              }).catch(() => setError(t("integrations.changeFailed"))).finally(() => setBusy(false));
            });
          }}>
            <label className="xus-field">{t("integrations.chooseMember")}<select className="xus-input" required value={smsMemberId} onChange={(event) => { setSmsMemberId(event.target.value); setSmsIdempotencyKey(globalThis.crypto.randomUUID()); }}><option value="">{smsMemberResults.length ? t("integrations.chooseMember") : t("integrations.noMembers")}</option>{smsMemberResults.map((member) => <option value={member.userId} key={member.userId}>{member.fullName} · ••••{member.phoneLast4}</option>)}</select></label>
            <label className="xus-field">{t("integrations.purpose")}<select className="xus-input" value={smsPurpose} onChange={(event) => { setSmsPurpose(event.target.value); setSmsIdempotencyKey(globalThis.crypto.randomUUID()); }}>{SMS_PURPOSES.map((value) => <option value={value} key={value}>{t(`integrations.smsPurpose.${value}`)}</option>)}</select></label>
            <label className="xus-field">{t("integrations.message")}<textarea className="xus-input xus-input--area" required maxLength="1600" value={smsBody} onChange={(event) => { setSmsBody(event.target.value); setSmsIdempotencyKey(globalThis.crypto.randomUUID()); }} /></label>
            <BusyButton type="submit" className="xus-btn xus-btn--go" pending={busy}>{t("integrations.sendMessage")}</BusyButton>
          </form>
          </div>
        </Card></WorkspaceTabSection>
      ) : workspace ? <WorkspaceTabSection group="integrations" name="sms"><Card id="integration-sms-unavailable" title={t("integrations.smsSend")} sub={t("integrations.smsUnavailableSub")}>
        <a className="xus-btn" href={workspaceHref("/m/integrations/providers")} onClick={(event) => { if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); workspace.open("/m/integrations/providers"); }}>{t("integrations.providers")}</a>
      </Card></WorkspaceTabSection> : null}

      <WorkspaceTabSection group="integrations" name="webhooks"><Card id="integration-webhooks" title={t("integrations.webhooks")} sub={t("integrations.webhooksSub")}>
        {snapshot.webhooks.length === 0 ? <p className="xus-note">{t("integrations.noWebhooks")}</p> : (
          <ul>
            {snapshot.webhooks.map((hook) => (
              <li className="xus-erow" key={hook.id}>
                <div className="xus-emain">
                  <strong className="xus-etitle">{hook.url}</strong>
                  <p className="xus-eline">{hook.events.join(", ")}</p>
                  <small className="xus-meta">{hook.active ? t("integrations.active") : t("integrations.paused")}{hook.lastDeliveryStatus ? ` · ${t("integrations.last")} ${hook.lastDeliveryStatus}${stamp(hook.lastDeliveryAt) ? ` · ${stamp(hook.lastDeliveryAt)}` : ""}` : ""}</small>
                </div>
                <div className="xus-btnrow">
                  <BusyButton type="button" className="xus-btn" aria-label={`${hook.active ? t("integrations.pause") : t("integrations.resume")} ${hook.url}`} pending={busy} onClick={() => run(() => store.toggleWebhook(actor, { webhookId: hook.id, active: !hook.active }))}>
                    {hook.active ? t("integrations.pause") : t("integrations.resume")}
                  </BusyButton>
                  {snapshot.capabilities?.webhookDelivery !== false ? (
                    <BusyButton type="button" className="xus-btn" aria-label={`${t("integrations.sendTest")} ${hook.url}`} pending={busy} onClick={() => run(() => store.enqueueWebhookDelivery(actor, { webhookId: hook.id, eventName: hook.events[0] }), "integrations.done.testQueued")}>
                      {t("integrations.sendTest")}
                    </BusyButton>
                  ) : null}
                  {snapshot.capabilities?.webhookSecretRotation !== false ? (
                    <BusyButton type="button" className="xus-btn" aria-label={`${t("integrations.rotateWebhookSecret")} ${hook.url}`} pending={busy} onClick={() => run(() => store.rotateWebhookSecret(actor, { webhookId: hook.id }))}>
                      {t("integrations.rotateWebhookSecret")}
                    </BusyButton>
                  ) : null}
                  <BusyButton type="button" className="xus-btn" aria-label={`${t("integrations.remove")} ${hook.url}`} pending={busy} onClick={() => run(() => store.deleteWebhook(actor, { webhookId: hook.id }))}>{t("integrations.remove")}</BusyButton>
                </div>
              </li>
            ))}
          </ul>
        )}
        {snapshot.deliveries.length > 0 ? (
          <>
            <ol aria-label={t("integrations.history")}>
              {snapshot.deliveries.map((delivery) => (
                <li key={delivery.id}>{delivery.eventName} · {delivery.status} · {delivery.destinationHost}</li>
              ))}
            </ol>
            {snapshot.deliveryCursor ? (
              <BusyButton type="button" className="xus-btn" pending={busy} onClick={loadOlderDeliveries}>{t("integrations.loadOlder")}</BusyButton>
            ) : null}
          </>
        ) : null}
        <form className="xus-form" onSubmit={(event) => {
          event.preventDefault();
          // Clear each field only if it still holds what was sent.
          const sentUrl = webhookUrl;
          const sentEvents = webhookEvents;
          run(() => store.createWebhook(actor, { url: sentUrl, events: sentEvents }), "integrations.done.endpointAdded", () => {
            setWebhookUrl((current) => (current === sentUrl ? "" : current));
            setWebhookEvents((current) => (current.length === sentEvents.length && current.every((name) => sentEvents.includes(name)) ? [] : current));
          });
        }}>
          <label className="setin-quiet-wide">
            {t("integrations.endpoint")}
            <input value={webhookUrl} onChange={(event) => setWebhookUrl(event.target.value)} placeholder="https://hooks.example.com/union-ground" />
          </label>
          <fieldset>
            <legend>{t("integrations.events")}</legend>
            {WEBHOOK_EVENTS.map((eventName) => (
              <label key={eventName}>
                <input
                  type="checkbox"
                  checked={webhookEvents.includes(eventName)}
                  onChange={(event) => {
                    setWebhookEvents((current) => event.target.checked
                      ? [...current, eventName]
                      : current.filter((item) => item !== eventName));
                  }}
                />
                {eventName}
              </label>
            ))}
          </fieldset>
          <BusyButton type="submit" className="xus-btn xus-btn--go" pending={busy}>{t("integrations.addWebhook")}</BusyButton>
        </form>
      </Card></WorkspaceTabSection>

      <WorkspaceTabSection group="integrations" name="api-keys"><Card id="integration-api-keys" title={t("integrations.apiKeys")} sub={t("integrations.apiKeysSub")}>
        {snapshot.apiKeys.length === 0 ? <p className="xus-note">{t("integrations.noApiKeys")}</p> : (
          <ul>
            {snapshot.apiKeys.map((key) => (
              <li className="xus-row" key={key.id}>
                <strong>{key.name}</strong>
                <span> {key.keyPrefix}{key.revokedAt ? ` · ${t("integrations.revoked")}` : ""}</span>
                {!key.revokedAt ? (
                  <>
                    {snapshot.capabilities?.apiKeyRotation !== false ? (
                      <BusyButton type="button" className="xus-btn" aria-label={`${t("integrations.rotate")} ${key.name}`} pending={busy} onClick={() => run(() => store.rotateApiKey(actor, { keyId: key.id }))}>{t("integrations.rotate")}</BusyButton>
                    ) : null}
                    <BusyButton type="button" className="xus-btn" aria-label={`${t("integrations.revoke")} ${key.name}`} pending={busy} onClick={() => run(() => store.revokeApiKey(actor, { keyId: key.id }))}>{t("integrations.revoke")}</BusyButton>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <form className="xus-form" onSubmit={(event) => {
          event.preventDefault();
          run(() => store.issueApiKey(actor, { name: apiKeyName }));
        }}>
          <label className="setin-quiet-wide">
            {t("integrations.keyName")}
            <input maxLength={80} value={apiKeyName} onChange={(event) => setApiKeyName(event.target.value)} placeholder={t("integrations.keyPlaceholder")} />
          </label>
          <BusyButton type="submit" className="xus-btn xus-btn--go" pending={busy}>{t("integrations.issueKey")}</BusyButton>
        </form>
      </Card></WorkspaceTabSection>

      {scimReleased ? <WorkspaceTabSection group="integrations" name="scim"><Card id="integration-scim" title={t("integrations.scim")} sub={t("integrations.scimPublicMessage")}>
        <ScimSetup store={store} actor={actor} onHeld={() => setScimReleased(false)} />
      </Card></WorkspaceTabSection> : null}

      {/* No single sign-on section: SSO sign-in is left out of Union Ground. */}
    </section>
  );
}

function publicError(reason, t) {
  switch (reason) {
    case "readiness_setup_required":
      return t("integrations.readinessSetupRequired");
    case "mfa_required":
      return t("integrations.error.mfa");
    case "unauthorized":
      return t("integrations.error.unauthorized");
    case "cross_organization_denied":
      return t("integrations.error.cross");
    case "https_required":
    case "invalid_url":
    case "port_forbidden":
    case "host_required":
    case "encoded_host_forbidden":
    case "private_or_metadata_ip":
    case "blocked_host":
    case "blocked_suffix":
    case "credentials_forbidden":
    case "invalid_ip":
      return t("integrations.error.webhook");
    case "scim_setup_on_scim_tab":
      return t("integrations.error.scim");
    case "events_required":
    case "unknown_events":
      return t("integrations.error.events");
    case "activation_unset":
    case "provider_not_connected":
      return t("integrations.ccRequestFirst");
    default:
      return t("integrations.changeFailed");
  }
}
