import { WorkspaceSection, useWorkspace, WorkspaceCardTitle } from "../components/WorkspacePages.jsx";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { Settings2, ShieldAlert, Tags } from "lucide-react";
import { TERM_LABEL_KEYS, useLang } from "../lib/LanguageContext.jsx";
import { formatGroupMoment } from "../lib/i18n/zonedDates.js";
import { PLANE_CARD_CLASS } from "../lib/staffPlaneStyles.js";
import { CHAPTER_ONLY_ADMIN_ACCESS } from "../lib/organizationWorkspaceAccess.js";
import { OrganizationRoleRefusal } from "./OrganizationRoleRefusal.jsx";
import { WorkloadCategoriesCard } from "./AdminWorkloadCategories.jsx";
import { WorkloadConfigurationCard } from "./AdminWorkloadConfiguration.jsx";
import { confirmSettingChange } from "../lib/settingChangeConfirmation.js";
import { isPlatformWideSetting } from "../lib/platformWideSettings.js";
import {
  SETTING_CATEGORIES, boundsText, categoryLabel, draftFromValue, enumOptionLabel, formatSettingValue, groupSettings,
  isChoiceList, isEnum, isLeftOutSetting, listedSettings, parseTextList, sameValue, settingCategory, settingDescription, settingLabel, validValue, valueFromDraft,
} from "../lib/organizationSettingsAdmin.js";
import { isConflictRefusalCode } from "../lib/memberApiError.js";
import { configurationListedWhile } from "../lib/heldSettingCompanions.js";
import { prepareBusyWrite, runBusyWrite } from "../lib/busyWrite.js";
import { BusyButton, BusySelect } from "./BusyControls.jsx";
import { Pager } from "./Pager.jsx";
import { usePagedList } from "../lib/usePagedQueue.js";
import "./settingChoices.css";

// Failed sign-in rows carry the tokens auth_configuration_operations checks;
// they display through the catalogue, and a token this release does not know
// shows as itself.
const SIGN_IN_SOURCE_LABELS = {
  "web-saas": "webSaas", "web-sample": "webSample", "native-ios": "nativeIos", "native-android": "nativeAndroid",
};
// Union Ground signs in with a password only; any other method stays its token.
const SIGN_IN_METHOD_LABELS = { password: "password" };
const ONBOARDING_CHECKLIST_PATH = "/m/support/onboarding";

// REQ-UG-NAVIGATION-HELP-AND-SETUP-COPY-20261030 (finding 111): a
// short, static guide to the switches a small local can safely turn off, read
// from what each switch does. Names come from the switch catalogue, so a
// renamed switch is renamed here too. It names only switches in the admin list,
// which leaves out a held one, so a held feature is never named; while a
// refresh or retry of that list is in flight it names none, because the list
// on screen may predate a hold
// (BUG-UG-SMALL-LOCAL-GUIDE-NAMES-HELD-SWITCHES-20261112).
const SMALL_LOCAL_GUIDE = Object.freeze([
  ["compass", ["features.ai_assistant.enabled"]],
  ["intelligence", ["features.intelligence.issue_signals", "features.intelligence.weekly_digest", "features.intelligence.neuro_map_derived_graph", "features.intelligence.neuro_map_auto_progress"]],
  ["attention", ["features.attention.guided_portal"]],
  ["coordinators", ["features.casework.gc_escalation_flags", "features.casework.gc_escalation_notify"]],
  ["engagement", ["features.engagement_voice.contextual_pulses", "features.engagement_voice.weekly_question_priority_slot", "features.engagement_voice.quarterly_survey_gate"]],
  ["integrations", ["features.integrations.scim", "features.integrations.drive_case_meeting_folders", "features.integrations.org_calendar_push"]],
]);
const SMALL_LOCAL_KEEP_ON = Object.freeze(["features.casework.deadline_reminders", "features.casework.mark_missed_deadlines", "features.casework.ulp_deadline"]);

function SmallLocalGuide({ settings, current, open, onToggle }) {
  const { t, lang } = useLang();
  // A left-out feature's switch is never named, here or in the list below.
  const listed = new Set(settings.filter((item) => !isLeftOutSetting(item)).map((item) => item.key));
  const groups = SMALL_LOCAL_GUIDE.map(([id, keys]) => [id, keys.filter((key) => listed.has(key))]).filter(([, keys]) => keys.length > 0);
  const keepOn = SMALL_LOCAL_KEEP_ON.filter((key) => listed.has(key));
  if (current && groups.length === 0) return null;
  const names = (keys) => new Intl.ListFormat(lang, { type: "conjunction" }).format(keys.map((key) => settingLabel(t, { key })));
  // Its open state lives in the card, so a refresh after a save does not fold it.
  return <details className="xus-cardbody xus-config-guide" open={open} onToggle={(event) => onToggle(event.currentTarget.open)} aria-busy={current ? undefined : true}>
    <summary>{t("admin.config.smallLocal.summary")}</summary>
    <p className="xus-note">{t("admin.config.smallLocal.intro")}</p>
    {current && <>
      <ul>{groups.map(([id, keys]) => <li key={id} data-guide={id}><strong>{keys.map((key) => settingLabel(t, { key })).join(" · ")}</strong>: {t(`admin.config.smallLocal.${id}`)}</li>)}</ul>
      {keepOn.length > 0 && <p className="xus-note">{t("admin.config.smallLocal.keepOn", { names: names(keepOn) })}</p>}
    </>}
  </details>;
}

function tokenLabel(t, prefix, labels, token) {
  return Object.hasOwn(labels, token) ? t(`${prefix}.${labels[token]}`) : token;
}

// REQ-UG-FEATURE-SWITCHES-AND-LIMITS-PAGE-20261001: the grouped "Feature
// switches & limits" page. Every platform_setting_definitions row renders here
// automatically, grouped by its category, with its default, bounds, an
// overridden marker and the last change from the configuration audit. Saves
// carry the setting's updatedAt so a newer change by another admin is refused
// (40001) instead of silently overwritten.
function SettingControl({ item, draft, invalid, label, describedBy, onChange }) {
  const { t } = useLang();
  const common = { "aria-describedby": describedBy, "aria-invalid": invalid || undefined };
  if (item.kind === "boolean") {
    return <label className="xus-field xus-field--check"><input type="checkbox" aria-label={t("admin.config.toggleName", { label })} aria-describedby={describedBy} checked={draft === true} onChange={(event) => onChange(event.target.checked)} /><span aria-hidden="true">{draft === true ? t("admin.config.on") : t("admin.config.off")}</span></label>;
  }
  if (isEnum(item)) {
    return <label className="xus-field"><span className="sr-only">{label}</span><select className="xus-input" {...common} value={draft ?? ""} onChange={(event) => onChange(event.target.value)}>
      {item.allowedValues.map((option) => <option key={option} value={option}>{enumOptionLabel(t, item, option)}</option>)}
    </select></label>;
  }
  if (isChoiceList(item)) {
    // REQ-UG-PEER-ROLE-CONTACT-ACROSS-CHAPTERS-20261109: a list drawn
    // from fixed values is ticked, not typed, and keeps the definition's order.
    const chosen = new Set(parseTextList(draft));
    return <fieldset className="xus-field xus-field--wide xus-config-choices" aria-describedby={describedBy} aria-invalid={invalid || undefined}>
      <legend className="sr-only">{label}</legend>
      {item.allowedValues.map((option) => <label key={option} className="xus-field xus-field--check"><input type="checkbox" checked={chosen.has(option)} onChange={(event) => onChange(item.allowedValues.filter((value) => (value === option ? event.target.checked : chosen.has(value))).join("\n"))} /><span>{enumOptionLabel(t, item, option)}</span></label>)}
    </fieldset>;
  }
  if (item.kind === "text_list") {
    return <label className="xus-field xus-field--wide"><span className="sr-only">{label}</span><textarea className="xus-input" rows={Math.min(8, Math.max(3, String(draft ?? "").split("\n").length))} {...common} value={draft ?? ""} onChange={(event) => onChange(event.target.value)} /></label>;
  }
  const integer = item.kind === "integer";
  return <label className="xus-field"><span className="sr-only">{label}</span><input className="xus-input" type={integer ? "number" : "text"} inputMode={integer ? "numeric" : undefined} step={integer ? 1 : undefined} min={item.minimum ?? undefined} max={item.maximum ?? undefined} maxLength={integer ? undefined : 240} {...common} value={draft ?? ""} onChange={(event) => onChange(event.target.value)} /></label>;
}

// Label changes name an organization's own term. A setting change names a
// switch, so it shows only while that switch is in the current admin list,
// which leaves out a held one; the stored audit row is kept
// (BUG-UG-SMALL-LOCAL-GUIDE-NAMES-HELD-SWITCHES-20261112).
const LABEL_HISTORY_ACTIONS = new Set(["label_updated", "label_removed"]);

function ConfigurationHistory({ api, settings, settingsCurrent }) {
  const { t, lang } = useLang();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState({ loading: false, failed: false, items: [] });
  if (typeof api?.loadConfigurationAudit !== "function") return null;
  const byKey = new Map((settingsCurrent ? settings ?? [] : []).map((item) => [item.key, item]));
  const loading = state.loading || !settingsCurrent;
  const items = state.items.filter((entry) => LABEL_HISTORY_ACTIONS.has(entry.action) || byKey.has(entry.key));
  async function load() {
    setState((current) => ({ ...current, loading: true, failed: false }));
    try {
      setState({ loading: false, failed: false, items: await api.loadConfigurationAudit(null, 50) });
    } catch { setState({ loading: false, failed: true, items: [] }); }
  }
  return <div className="xus-cardbody xus-cardbody--divided">
    <button className="xus-btn" type="button" aria-expanded={open} aria-controls="admin-configuration-history" onClick={() => { const next = !open; setOpen(next); if (next) void load(); }}>{open ? t("admin.config.historyHide") : t("admin.config.history")}</button>
    {open && <div id="admin-configuration-history" className="xus-config-history">
      {loading && <p className="xus-note" role="status">{t("admin.config.historyLoading")}</p>}
      {state.failed && <p className="xus-note xus-note--error" role="alert">{t("admin.config.historyFailed")}</p>}
      {!loading && !state.failed && items.length === 0 && <p className="xus-note">{t("admin.config.historyEmpty")}</p>}
      {items.length > 0 && <ul className="xus-config-history__list">{items.map((entry) => {
        const item = byKey.get(entry.key);
        const name = item ? settingLabel(t, item) : t(entry.key);
        const values = entry.action === "setting_updated" || entry.action === "setting_reset"
          ? t("admin.config.historyValues", { from: formatSettingValue(t, item, entry.previousValue), to: formatSettingValue(t, item, entry.newValue) })
          : "";
        return <li key={entry.id}><strong className="xus-name">{name}</strong><small className="xus-meta">{t(`admin.config.historyAction.${entry.action}`)}{values ? ` · ${values}` : ""}</small><small className="xus-meta">{t("admin.config.changedBy", { name: entry.actorName || t("admin.config.unknownActor"), when: formatGroupMoment(entry.createdAt, lang) })}</small></li>;
      })}</ul>}
    </div>}
  </div>;
}

function ConfigurationCard({ configuration, configurationCurrent = true, chapterScoped = false, api, reload, onNotice }) {
  const { t, lang } = useLang();
  const workspace = useWorkspace();
  const [drafts, setDrafts] = useState({});
  const [busy, setBusy] = useState("");
  const [failed, setFailed] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [changedOnly, setChangedOnly] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  // REQ-UG-NAVIGATION-HELP-AND-SETUP-COPY-20261030 (finding 88): the
  // shell toast fades, so the row just saved (or reset) keeps a visible line
  // saying so until it is edited again or another row is written.
  const [confirmed, setConfirmed] = useState(null);
  const previousServerValues = useRef({});
  // Two administrators editing one setting. Each
  // unsaved draft remembers the version (updatedAt) of the read it was typed
  // over, and Save sends that version, so a newer value another administrator
  // saved in between is refused (40001) instead of silently overwritten. The
  // typed value stays in the field and the row shows the newer saved value;
  // once refused (refusedDrafts), the next Save is made over the version on
  // screen, which the row shows. ownVersions: the version this
  // administrator's own save or reset wrote, until the next read shows it,
  // so a draft typed in that gap (or during the save) is based on it and
  // their own value is never named as another administrator's.
  const draftVersions = useRef({});
  const refusedDrafts = useRef(new Set());
  const ownVersions = useRef({});
  // The version of each row the administrator has seen:
  // the one on screen when the row was first shown on this page, then the one
  // on screen at their last Save or Use default on it (or their own write). A
  // Save that goes out against the version on screen (after a refusal) and
  // every reset carry that version, so a refresh landing just before the click
  // would let it replace a value the administrator has not read. When the
  // row's version moved since they saw it, that click sends nothing: the row
  // shows the new value with a plain notice (moved, per row), and the next
  // deliberate click goes out.
  const seenVersions = useRef({});
  const [moved, setMoved] = useState({});
  const clearMoved = (key) => setMoved((current) => {
    if (!Object.hasOwn(current, key)) return current;
    const { [key]: _cleared, ...rest } = current;
    return rest;
  });
  const latestDrafts = useRef(drafts);
  latestDrafts.current = drafts;
  // Synchronous write lock: every row's Save and Use default share
  // one busy state, so they share one lock, released where busy clears.
  const busyWriteRef = useRef(new Set());
  // While a refresh or retry is in flight the previous read stays on screen;
  // a limit that acts beside a switch the new read may hold waits for it, so
  // everything below reads the list without those rows until the read lands
  // (BUG-UG-HELD-FEATURE-LIMITS-STILL-LISTED-20261112).
  const listedConfiguration = useMemo(() => configurationListedWhile(configuration, configurationCurrent), [configuration, configurationCurrent]);
  // BUG-UG-ADMIN-SECURITY-SETTINGS-REFRESH-DROPS-UNSAVED-LIMIT-EDIT-20261115
  //: the rows only that wait leaves out. Their unsaved edits are kept
  // until the read lands, so a typed limit shows again when its row returns;
  // a row the new read really leaves out takes its edit with it.
  const waitingKeys = useMemo(() => {
    const listed = new Set((listedConfiguration?.settings ?? []).map((item) => item.key));
    return (configuration?.settings ?? []).map((item) => item.key).filter((key) => !listed.has(key));
  }, [configuration, listedConfiguration]);
  configuration = listedConfiguration;

  useEffect(() => {
    const nextServerValues = Object.fromEntries((configuration?.settings ?? []).map((item) => [item.key, draftFromValue(item, item.value)]));
    const waiting = waitingKeys.filter((key) => Object.hasOwn(previousServerValues.current, key));
    setDrafts((current) => ({
      ...Object.fromEntries(waiting.filter((key) => Object.hasOwn(current, key)).map((key) => [key, current[key]])),
      ...Object.fromEntries(Object.entries(nextServerValues).map(([key, value]) => [
        key,
        Object.hasOwn(current, key) && current[key] !== previousServerValues.current[key] ? current[key] : value,
      ])),
    }));
    previousServerValues.current = {
      ...Object.fromEntries(waiting.map((key) => [key, previousServerValues.current[key]])),
      ...nextServerValues,
    };
    // A current read shows every own save before it, so their versions are done.
    if (configurationCurrent) ownVersions.current = {};
  }, [configuration, configurationCurrent, waitingKeys]);

  const settings = listedSettings(configuration && configuration.settings);
  const groups = groupSettings(settings, { t, query, category, changedOnly });
  const presentCategories = SETTING_CATEGORIES.filter((name) => settings.some((item) => !isLeftOutSetting(item) && settingCategory(item) === name));
  const shown = groups.reduce((sum, group) => sum + group.items.length, 0);
  //  review P1-1, a review note (3): the version a row shows when it
  // is first rendered on this page (including after a remount, or when a
  // filter first lets it through) is the one the administrator has seen until
  // they click it. A row hidden by a filter is not seeded from a read nobody
  // saw, so it gets no false hold when the filter is cleared.
  useEffect(() => {
    for (const group of groups) {
      for (const item of group.items) if (!Object.hasOwn(seenVersions.current, item.key)) seenVersions.current[item.key] = item.updatedAt ?? null;
    }
  });

  // The checks before a write (validation, a moved version, a confirmation)
  // send nothing and run without the lock, so the next deliberate click goes
  // out at once; the lock is taken only when a write starts.
  function write(item, action) {
    return prepareBusyWrite(busyWriteRef, "setting", () => prepareWrite(item, action));
  }

  // Save is disabled while its value is invalid or unchanged (the row's
  // `invalid` is this same validValue), and every row's Save and Use default
  // are pending while a write holds the lock, so neither check is repeated here.
  function prepareWrite(item, action) {
    const value = action === "reset" ? null : valueFromDraft(item, drafts[item.key]);
    const shownVersion = item.updatedAt ?? null;
    //  review P3-2: the screen still shows the read from before this
    // administrator's own save or reset; that is not a change by anyone else,
    // so the click is not held and goes out against their own write.
    const ownPending = Object.hasOwn(ownVersions.current, item.key) && seenVersions.current[item.key] === ownVersions.current[item.key]
      && shownVersion !== ownVersions.current[item.key];
    const currentVersion = ownPending ? ownVersions.current[item.key] : shownVersion;
    const sendsShownVersion = action === "reset" || !Object.hasOwn(draftVersions.current, item.key) || refusedDrafts.current.has(item.key);
    if (sendsShownVersion && !ownPending && Object.hasOwn(seenVersions.current, item.key) && seenVersions.current[item.key] !== shownVersion) {
      seenVersions.current[item.key] = shownVersion;
      setFailed(""); setConfirmed(null); setMoved((current) => ({ ...current, [item.key]: action }));
      return undefined;
    }
    // D5-3: turning a security boundary off (restricted PIN sessions) asks first.
    if (action !== "reset" && !confirmSettingChange(t, item, value)) return undefined;
    seenVersions.current[item.key] = currentVersion;
    return (unlock) => writeNow(item, action, value, currentVersion, unlock);
  }

  async function writeNow(item, action, value, currentVersion, unlock) {
    setBusy(`${action}:${item.key}`); setFailed(""); setConfirmed(null); clearMoved(item.key);
    try {
      if (action === "reset") {
        const written = await api.resetOrganizationSetting(item.key, currentVersion);
        // A draft kept through the reset is based on the reset now, not on the read before it.
        if (Object.hasOwn(written ?? {}, "updatedAt")) {
          ownVersions.current[item.key] = written.updatedAt;
          if (Object.hasOwn(draftVersions.current, item.key)) draftVersions.current[item.key] = written.updatedAt;
          refusedDrafts.current.delete(item.key);
        }
        // Their own reset is a version they know.
        if (Object.hasOwn(written ?? {}, "updatedAt")) seenVersions.current[item.key] = written.updatedAt;
        onNotice(t("admin.config.resetDone", { label: settingLabel(t, item) }));
      } else {
        const sent = drafts[item.key];
        const expected = Object.hasOwn(draftVersions.current, item.key) && !refusedDrafts.current.has(item.key)
          ? draftVersions.current[item.key] : currentVersion;
        let written = null;
        if (typeof api.setOrganizationSetting === "function") written = await api.setOrganizationSetting(item.key, value, expected);
        else await api.updateOrganizationSetting(item.key, value);
        previousServerValues.current = { ...previousServerValues.current, [item.key]: sent };
        const ownVersion = Object.hasOwn(written ?? {}, "updatedAt") ? written.updatedAt : undefined;
        if (ownVersion !== undefined) ownVersions.current[item.key] = ownVersion;
        // Their own save is a version they know.
        if (ownVersion !== undefined) seenVersions.current[item.key] = ownVersion;
        refusedDrafts.current.delete(item.key);
        // The field was changed while the save ran (P1 of the  review): that
        // draft is based on this save, or on the version it was sent against
        // when the save gives none back, never on nothing.
        if (latestDrafts.current[item.key] !== sent) draftVersions.current[item.key] = ownVersion !== undefined ? ownVersion : expected;
        else delete draftVersions.current[item.key];
        onNotice(t("admin.config.saved"));
      }
      setConfirmed({ key: item.key, action });
      reload();
    } catch (error) {
      if (isConflictRefusalCode(error?.code)) {
        // The administrator has now been told; Save again replaces the version on screen.
        if (action !== "reset") refusedDrafts.current.add(item.key);
        setFailed({ key: item.key, kind: "conflict" }); reload();
      } else setFailed({ key: item.key, kind: "failed" });
    } finally { unlock(); setBusy(""); }
  }

  return <WorkspaceSection name="admin-configuration"><article id="admin-configuration" className={`${PLANE_CARD_CLASS} xus-card role-section-target`} tabIndex="-1" aria-labelledby="admin-configuration-title">
    <header className="xus-cardhead">
      <span className="xus-glyph" aria-hidden="true"><Settings2 size={18} /></span>
      <div className="xus-cardhead__copy"><WorkspaceCardTitle outline className="xus-cardttl" id="admin-configuration-title">{t("admin.config.title")}</WorkspaceCardTitle><p className="xus-cardsub">{t("admin.config.sub")}</p></div>
    </header>
    {/* BUG-UG-CHAPTER-ADMIN-SEES-ORG-ADMIN-PAGES-THAT-FAIL-20261102: a chapter-only Admin is told which role opens it, not that it "could not be read". */}
    {chapterScoped ? <div className="xus-cardbody"><OrganizationRoleRefusal pageKey="admin.config.title" access={CHAPTER_ONLY_ADMIN_ACCESS} compact /></div>
      : configuration === null ? <div className="xus-cardbody"><p className="xus-note">{t("admin.config.unavailable")}</p></div> : <>
      <SmallLocalGuide settings={settings} current={configurationCurrent} open={guideOpen} onToggle={setGuideOpen} />
      <div className="xus-cardbody xus-inline xus-config-filters" role="search" aria-label={t("admin.config.filtersLabel")}>
        <label className="xus-field">{t("admin.config.search")}<input className="xus-input" type="search" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <label className="xus-field">{t("admin.config.category")}<select className="xus-input" value={category} onChange={(event) => setCategory(event.target.value)}><option value="">{t("admin.config.allCategories")}</option>{presentCategories.map((name) => <option key={name} value={name}>{categoryLabel(t, name)}</option>)}</select></label>
        <label className="xus-field xus-field--check"><input type="checkbox" aria-label={t("admin.config.changedOnly")} checked={changedOnly} onChange={(event) => setChangedOnly(event.target.checked)} /><span aria-hidden="true">{t("admin.config.changedOnly")}</span></label>
        <p className="xus-note" role="status" aria-live="polite">{t("admin.config.shown", { count: shown, total: settings.length })}</p>
      </div>
      {/*  W3a-11: a failure shows in its row; here only if filters hide the row. */}
      {failed && !groups.some((group) => group.items.some((item) => item.key === failed.key)) && <div className="xus-cardbody"><p className="xus-note xus-note--error" role="alert">{t(failed.kind === "conflict" ? "admin.config.conflict" : "admin.config.failed")}</p></div>}
      {groups.length === 0 && <div className="xus-cardbody"><p className="xus-note">{t("admin.config.empty")}</p></div>}
      {groups.map((group) => <section key={group.category} className="xus-config-group" aria-labelledby={`admin-config-group-${group.category}`}>
        <h3 className="xus-config-group__title" id={`admin-config-group-${group.category}`}>{categoryLabel(t, group.category)}</h3>
        {/* UX-UG-ADMIN-NOT-TOLD-ONBOARDING-NEEDS-CHECKLIST-20261018:
            the guide switches read as on, but they run only from the
            organization's own checklist; say so where they are switched. */}
        {group.category === "guidance_onboarding" && <p className="xus-note xus-config-group__note">{t("admin.config.onboardingChecklistNote")}{" "}
          <a href={ONBOARDING_CHECKLIST_PATH} onClick={(event) => { if (workspace) { event.preventDefault(); workspace.open(ONBOARDING_CHECKLIST_PATH, "memberSupport"); } }}>{t("admin.config.onboardingChecklistLink")}</a></p>}
        {group.items.map((item) => {
          const label = settingLabel(t, item);
          const draft = drafts[item.key];
          const draftValue = valueFromDraft(item, draft);
          const changed = !sameValue(draftValue, item.value);
          const invalid = changed && !validValue(item, draftValue);
          // The draft was typed over an older read than the one on screen.
          // Not when that version is the administrator's own write,
          // which the screen shows only once the refresh lands.
          const stale = changed && Object.hasOwn(draftVersions.current, item.key) && draftVersions.current[item.key] !== (item.updatedAt ?? null)
            && !(Object.hasOwn(ownVersions.current, item.key) && draftVersions.current[item.key] === ownVersions.current[item.key]);
          const domId = `admin-setting-${item.key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
          const movedHere = Object.hasOwn(moved, item.key);
          const last = item.lastChange?.at ? t("admin.config.changedBy", { name: item.lastChange.actorName || t("admin.config.unknownActor"), when: formatGroupMoment(item.lastChange.at, lang) }) : "";
          const facts = [
            t("admin.config.default", { value: formatSettingValue(t, item, item.defaultValue) }),
            boundsText(t, item), item.kind === "text_list" && !isChoiceList(item) ? t("admin.config.listHelp") : "", last,
          ].filter(Boolean).join(" · ");
          return <div className="xus-cardbody xus-config-row" key={item.key} data-setting-key={item.key}>
            <div className="xus-rowmain">
              <strong className="xus-name">{label}{item.overridden && <> <span className="xus-chip xus-chip--note">{t("admin.config.changed")}</span></>}</strong>
              <small className="xus-meta" id={`${domId}-description`}>{settingDescription(t, item)}</small>
              <small className="xus-meta" id={`${domId}-facts`}>{facts}</small>
              {invalid && <small className="xus-meta xus-note--error" id={`${domId}-invalid`}>{t("admin.config.invalidValue")}</small>}
              {stale && <small className="xus-meta xus-note--error" id={`${domId}-stale`} data-testid="admin-setting-stale">{t("admin.config.staleDraft", { value: formatSettingValue(t, item, item.value) })}</small>}
              {movedHere && <small className="xus-meta xus-note--error" id={`${domId}-moved`} role="alert" data-testid="admin-setting-moved">{t(moved[item.key] === "reset" ? "admin.config.movedBeforeReset" : "admin.config.movedBeforeSave", { value: formatSettingValue(t, item, item.value) })}</small>}
              {failed?.key === item.key && <small className="xus-meta xus-note--error" role="alert" data-testid="admin-setting-failed">{t(failed.kind === "conflict" ? "admin.config.conflict" : "admin.config.failed")}</small>}
              {confirmed?.key === item.key && <small className="xus-meta xus-note--success" data-testid="admin-setting-confirmed">{confirmed.action === "reset" ? t("admin.config.resetDone", { label }) : t("admin.config.saved")}</small>}
            </div>
            {item.organizationEditable === false || isPlatformWideSetting(item.key) ? <div className="xus-config-control">
              {/* Platform-wide value: shown as a fact, never as a control that would fail on save. */}
              <strong className="xus-name" aria-describedby={`${domId}-description`}>{formatSettingValue(t, item, item.value ?? item.defaultValue)}</strong>
              <span className="xus-chip xus-chip--note">{t("admin.config.platformOnly")}</span>
              {isPlatformWideSetting(item.key) && <p className="xus-note">{t("admin.config.platformWide")}</p>}
            </div> : <div className="xus-config-control">
              <SettingControl item={item} draft={draft} invalid={invalid} label={label} describedBy={`${domId}-description ${domId}-facts${invalid ? ` ${domId}-invalid` : ""}${stale ? ` ${domId}-stale` : ""}${movedHere ? ` ${domId}-moved` : ""}`} onChange={(next) => {
                setConfirmed((current) => current?.key === item.key ? null : current);
                clearMoved(item.key);
                // A draft started from the saved value takes the version of the read on screen.
                if (!changed || !Object.hasOwn(draftVersions.current, item.key)) {
                  draftVersions.current[item.key] = Object.hasOwn(ownVersions.current, item.key) ? ownVersions.current[item.key] : item.updatedAt ?? null;
                  refusedDrafts.current.delete(item.key);
                }
                setDrafts((current) => ({ ...current, [item.key]: next }));
              }} />
              <BusyButton className="xus-btn xus-btn--go" type="button" pending={Boolean(busy)} disabled={!changed || invalid} aria-label={busy === `save:${item.key}` ? t("admin.config.savingName", { label }) : t("admin.config.saveName", { label })} onClick={() => write(item, "save")}>{busy === `save:${item.key}` ? t("auth.working") : t("admin.config.save")}</BusyButton>
              {item.overridden && typeof api.resetOrganizationSetting === "function" && <BusyButton className="xus-btn" type="button" pending={Boolean(busy)} aria-label={t("admin.config.resetName", { label })} onClick={() => write(item, "reset")}>{busy === `reset:${item.key}` ? t("auth.working") : t("admin.config.reset")}</BusyButton>}
            </div>}
          </div>;
        })}
      </section>)}
      <ConfigurationHistory api={api} settings={settings} settingsCurrent={configurationCurrent} />
    </>}
  </article></WorkspaceSection>;
}

// REQ-UG-CHAPTER-UNITS-WORKSITES-AND-LOCAL-PROFILE-20261030: the
// "chapter" and "worksite" words come first, and one Save writes every
// changed label (each still goes through update_organization_label).
const TERM_VALUE = /^\p{L}[\p{L} '&-]{0,29}$/u;

function LabelsCard({ configuration, chapterScoped = false, api, reload, onNotice }) {
  const { t } = useLang();
  const labelsId = useId();
  const [drafts, setDrafts] = useState({});
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const previousServerValues = useRef({});
  const menuKeys = useMemo(() => (configuration ? configuration.labelKeys ?? [] : []).filter((key) => !TERM_LABEL_KEYS.includes(key)), [configuration]);
  const allKeys = useMemo(() => [...TERM_LABEL_KEYS, ...menuKeys], [menuKeys]);
  useEffect(() => {
    const nextServerValues = Object.fromEntries(allKeys.map((key) => [
      key,
      configuration?.labelOverrides?.[key] ?? "",
    ]));
    setDrafts((current) => Object.fromEntries(Object.entries(nextServerValues).map(([key, value]) => [
      key,
      current[key] !== undefined && current[key] !== previousServerValues.current[key] ? current[key] : value,
    ])));
    previousServerValues.current = nextServerValues;
  }, [configuration, allKeys]);

  const changed = allKeys.filter((key) => (drafts[key] ?? "").trim() !== (previousServerValues.current[key] ?? "").trim());
  const invalidTerm = (key) => TERM_LABEL_KEYS.includes(key) && Boolean((drafts[key] ?? "").trim()) && !TERM_VALUE.test((drafts[key] ?? "").trim());
  const anyInvalid = allKeys.some(invalidTerm);

  // The loop stops the moment this card is retired or a write answers
  // without a result (App's guard answers nothing once the session or scope
  // that started the save is gone), so no later label is written under a
  // different session.
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // Synchronous write lock, released where busy clears.
  const busyWriteRef = useRef(new Set());
  function saveAll() {
    return runBusyWrite(busyWriteRef, "labels", (unlock) => saveAllNow(unlock));
  }
  async function saveAllNow(unlock) {
    if (busy || changed.length === 0 || anyInvalid) return;
    setBusy(true); setFailed(false);
    try {
      for (const key of changed) {
        const result = await api.updateOrganizationLabel(key, drafts[key] || "");
        if (!mounted.current || !result || typeof result !== "object") return;
        previousServerValues.current = { ...previousServerValues.current, [key]: drafts[key] || "" };
      }
      onNotice(t("admin.labels.savedAll"));
      reload();
    } catch { if (mounted.current) setFailed(true); } finally { unlock(); if (mounted.current) setBusy(false); }
  }

  // data-label-key: a stable hook for scripts; the key itself is never shown.
  const row = (key) => {
    const term = TERM_LABEL_KEYS.includes(key);
    const invalid = invalidTerm(key);
    const ruleId = `${labelsId}-${key}-rule`;
    return <div className="xus-label-row" key={key} data-label-key={key}>
      <div>
        <label className="xus-field"><span>{t(key)}</span><input className="xus-input" maxLength={term ? 30 : 40} value={drafts[key] || ""}
          aria-invalid={invalid || undefined} aria-describedby={invalid ? ruleId : term ? `${labelsId}-term-rule` : undefined}
          placeholder={t("admin.labels.default", { label: t(key) })} onChange={(event) => setDrafts((current) => ({ ...current, [key]: event.target.value }))} /></label>
        {invalid && <small className="xus-note xus-note--error" id={ruleId}>{t("admin.labels.termRule")}</small>}
      </div>
    </div>;
  };

  return <WorkspaceSection name="admin-labels"><article id="admin-labels" className={`${PLANE_CARD_CLASS} xus-card role-section-target`} tabIndex="-1">
    <header className="xus-cardhead">
      <span className="xus-glyph" aria-hidden="true"><Tags size={18} /></span>
      <div className="xus-cardhead__copy"><WorkspaceCardTitle outline className="xus-cardttl">{t("admin.labels.title")}</WorkspaceCardTitle><p className="xus-cardsub">{t("admin.labels.sub")}</p></div>
    </header>
    {chapterScoped ? <div className="xus-cardbody"><OrganizationRoleRefusal pageKey="admin.labels.title" access={CHAPTER_ONLY_ADMIN_ACCESS} compact /></div>
      : configuration === null ? <div className="xus-cardbody"><p className="xus-note">{t("admin.config.unavailable")}</p></div> : <div className="xus-cardbody xus-form">
      {failed && <p className="xus-note xus-note--error" role="alert">{t("admin.labels.failed")}</p>}
      <h3 className="xus-etitle">{t("admin.labels.termsTitle")}</h3>
      <p className="xus-note">{t("admin.labels.termsSub")}</p>
      {TERM_LABEL_KEYS.map(row)}
      <small className="xus-note" id={`${labelsId}-term-rule`}>{t("admin.labels.termRule")}</small>
      {menuKeys.length > 0 && <h3 className="xus-etitle">{t("admin.labels.menusTitle")}</h3>}
      {menuKeys.length > 0 && <p className="xus-note">{t("admin.labels.menusSub")}</p>}
      {menuKeys.map(row)}
      <BusyButton className="xus-btn xus-btn--go" type="button" pending={busy} disabled={changed.length === 0 || anyInvalid}
        disabledReason={anyInvalid ? t("admin.labels.fixTerms") : null} aria-label={busy ? t("admin.labels.savingAll") : t("admin.labels.saveAll")} onClick={saveAll}>{busy ? t("auth.working") : t("admin.labels.saveAll")}</BusyButton>
    </div>}
  </article></WorkspaceSection>;
}

// Both disposition actions stay disabled until a preset reason is chosen or
// the note holds two trimmed characters. The note is a sibling of its help
// text rather than a wrapping label so the rule is the input's description
// and never part of its name.
const noteFieldId = (itemId) => `admin-login-note-${itemId}`;
const noteHelpId = (itemId) => `admin-login-note-help-${itemId}`;
const reasonFieldId = (itemId) => `admin-login-reason-${itemId}`;
// REQ-UG-FAILED-SIGNIN-PRESET-DISPOSITIONS-20261006: one-tap reasons
// for the common cases. The server still stores a 2-240 character note, so the
// chosen reason (in the reviewer's language) becomes the note, followed by any
// free text.
const DISPOSITION_REASONS = ["mistyped", "forgotPassword", "serverError", "testing"];
const NOTE_LIMIT = 240;
const REASON_SEPARATOR = " — ";

// The free text is clamped to what the reason label (in the current language)
// leaves, so the composed note always fits the server's limit even after the
// reviewer switches language with a long note in the field.
function dispositionNote(t, reason, text) {
  const free = String(text || "").slice(0, freeTextLimit(t, reason)).trim();
  if (!reason) return free;
  const label = t(`admin.loginInbox.reason.${reason}`);
  return free ? `${label}${REASON_SEPARATOR}${free}` : label;
}

function freeTextLimit(t, reason) {
  return reason ? NOTE_LIMIT - t(`admin.loginInbox.reason.${reason}`).length - REASON_SEPARATOR.length : NOTE_LIMIT;
}

function noteIsTruncated(t, reason, text) {
  return String(text || "").length > freeTextLimit(t, reason);
}

const LOGIN_INBOX_PAGE_SIZE = 10;

function FailedLoginInbox({ initial, api, onNotice }) {
  const { t, lang } = useLang();
  const [inbox, setInbox] = useState(initial);
  const [filter, setFilter] = useState("");
  const [notes, setNotes] = useState({});
  const [reasons, setReasons] = useState({});
  // Edit the full draft; translated reason labels constrain only the saved note.
  const [busy, setBusy] = useState("");
  // A disposition's own pending mark and lock. A filter read clears `busy`
  // while a disposition still runs, so the disposition keeps its own mark,
  // set and cleared with its lock .
  const [disposing, setDisposing] = useState(false);
  const busyWriteRef = useRef(new Set());
  const [failed, setFailed] = useState(false);
  const requestToken = useRef(0);
  const filterRef = useRef("");
  const loadFilterRef = useRef(null);

  const loadFilter = useCallback(async (next) => {
    const token = ++requestToken.current;
    setBusy("filter"); setFailed(false);
    try {
      const nextInbox = await api.loadFailedLoginInbox(next || null);
      if (token !== requestToken.current) return;
      setInbox(nextInbox);
    } catch {
      if (token === requestToken.current) setFailed(true);
    } finally {
      if (token === requestToken.current) setBusy("");
    }
  }, [api]);
  loadFilterRef.current = loadFilter;

  useEffect(() => {
    if (filterRef.current) {
      loadFilterRef.current(filterRef.current);
      return;
    }
    requestToken.current += 1;
    setBusy((current) => (current === "filter" ? "" : current));
    setInbox(initial);
  }, [initial]);

  // UX-UG-LONG-PAGES-RENDER-EVERY-ROW-EXPANDED-WITH-NO-PAGING-20261122
  // (A-15): every report used to be drawn with its own form, 55 on one
  // 13,087 px page under "All". Open reports, the ones that need a decision,
  // now come first, newest first within each status, ten to a page.
  const items = inbox?.items ?? [];
  const ordered = [...items.filter((item) => item.status === "open"), ...items.filter((item) => item.status !== "open")];
  const paged = usePagedList(ordered, LOGIN_INBOX_PAGE_SIZE);

  function applyFilter(next) {
    filterRef.current = next;
    setFilter(next);
    paged.setPage(1);
    loadFilter(next);
  }
  function disposition(item, status) {
    return runBusyWrite(busyWriteRef, "disposition", (unlock) => dispositionNow(item, status, unlock));
  }
  // Mark reviewed and Dismiss are disabled while the note is under 2
  // characters, the note is capped at NOTE_LIMIT as it is built, and both are
  // pending while any read or disposition runs.
  async function dispositionNow(item, status, unlock) {
    const note = dispositionNote(t, reasons[item.id], notes[item.id]);
    setBusy(item.id); setDisposing(true); setFailed(false);
    try {
      await api.dispositionFailedLoginAttempt(item.id, status, note);
      onNotice(t("admin.loginInbox.saved"));
      await loadFilter(filterRef.current);
    } catch { setFailed(true); setBusy(""); }
    finally { unlock(); setDisposing(false); }
  }

  const attention = inbox && Number(inbox.openLast24Hours) >= Number(inbox.attentionThreshold);
  return <WorkspaceSection name="admin-failed-logins"><article id="admin-failed-logins" className={`${PLANE_CARD_CLASS} xus-card role-section-target`} tabIndex="-1">
    <header className="xus-cardhead">
      <span className="xus-glyph" aria-hidden="true"><ShieldAlert size={18} /></span>
      <div className="xus-cardhead__copy"><WorkspaceCardTitle outline className="xus-cardttl">{t("admin.loginInbox.title")}</WorkspaceCardTitle><p className="xus-cardsub">{t("admin.loginInbox.sub")}</p></div>
      {attention && <span className="xus-chip xus-chip--note">{t("admin.loginInbox.attention", { count: inbox.openLast24Hours })}</span>}
    </header>
    {initial === null ? <div className="xus-cardbody"><p className="xus-note">{t("admin.loginInbox.unavailable")}</p></div> : <>
      <div className="xus-cardbody xus-inline">
        <label className="xus-field">{t("admin.loginInbox.filter")}<BusySelect className="xus-input" value={filter} pending={busy === "filter"} onChange={(event) => applyFilter(event.target.value)}><option value="">{t("admin.loginInbox.all")}</option><option value="open">{t("admin.loginInbox.open")}</option><option value="reviewed">{t("admin.loginInbox.reviewed")}</option><option value="dismissed">{t("admin.loginInbox.dismissed")}</option></BusySelect></label>
      </div>
      {failed && <div className="xus-cardbody"><p className="xus-note xus-note--error" role="alert">{t("admin.loginInbox.failed")}</p></div>}
      {items.length === 0 && <div className="xus-cardbody"><p className="xus-note">{t("admin.loginInbox.empty")}</p></div>}
      {paged.rows.map((item) => <div className="xus-cardbody xus-login-attempt" key={item.id}>
        <div className="xus-rowmain"><strong className="xus-name">{item.memberName}</strong><small className="xus-meta">{formatGroupMoment(item.occurredAt, lang)} · {tokenLabel(t, "admin.loginInbox.source", SIGN_IN_SOURCE_LABELS, item.source)} · {tokenLabel(t, "admin.loginInbox.method", SIGN_IN_METHOD_LABELS, item.method)}</small><small className="xus-meta">{item.userAgent} · {t("admin.loginInbox.reference", { reference: item.memberReference })}</small>{item.dispositionNote && <p className="xus-note">{item.dispositionNote}</p>}</div>
        {item.status === "open" ? <div className="xus-form">
          <div className="xus-field">
            <label htmlFor={reasonFieldId(item.id)}>{t("admin.loginInbox.reason")}</label>
            <select className="xus-input" id={reasonFieldId(item.id)} value={reasons[item.id] || ""} onChange={(event) => {
              const reason = event.target.value;
              setReasons((current) => ({ ...current, [item.id]: reason }));
            }}>
              <option value="">{t("admin.loginInbox.reasonNone")}</option>
              {DISPOSITION_REASONS.map((reason) => <option key={reason} value={reason}>{t(`admin.loginInbox.reason.${reason}`)}</option>)}
            </select>
          </div>
          <div className="xus-field">
            <label htmlFor={noteFieldId(item.id)}>{t("admin.loginInbox.note")}</label>
            <input className="xus-input" id={noteFieldId(item.id)} maxLength={NOTE_LIMIT} aria-describedby={`${noteHelpId(item.id)}${noteIsTruncated(t, reasons[item.id], notes[item.id]) ? ` ${noteHelpId(item.id)}-trimmed` : ""}`} value={notes[item.id] || ""} onChange={(event) => setNotes((current) => ({ ...current, [item.id]: event.target.value }))} />
            <small className="xus-note" id={noteHelpId(item.id)}>{t("admin.loginInbox.noteHelp")}</small>
            {noteIsTruncated(t, reasons[item.id], notes[item.id]) && <small className="xus-note" id={`${noteHelpId(item.id)}-trimmed`} role="status">{t("admin.loginInbox.noteTrimmed", { count: freeTextLimit(t, reasons[item.id]) })}</small>}
          </div>
          <div className="xus-btnrow"><BusyButton className="xus-btn xus-btn--go" type="button" pending={Boolean(busy) || disposing} disabled={dispositionNote(t, reasons[item.id], notes[item.id]).length < 2} onClick={() => disposition(item, "reviewed")}>{t("admin.loginInbox.markReviewed")}</BusyButton><BusyButton className="xus-btn" type="button" pending={Boolean(busy) || disposing} disabled={dispositionNote(t, reasons[item.id], notes[item.id]).length < 2} onClick={() => disposition(item, "dismissed")}>{t("admin.loginInbox.dismiss")}</BusyButton></div>
        </div> : <span className="xus-chip">{t(`admin.loginInbox.${item.status}`)}</span>}
      </div>)}
      {items.length > LOGIN_INBOX_PAGE_SIZE && <Pager total={items.length} page={paged.page} pageSize={LOGIN_INBOX_PAGE_SIZE} onPageChange={paged.setPage} labels={{ navigation: t("admin.loginInbox.title") }} />}
    </>}
  </article></WorkspaceSection>;
}

export function AdminSecurityConfiguration({ configuration, configurationCurrent = true, chapterScoped = false, failedLoginInbox, api, reload, onNotice }) {
  return <>
    <ConfigurationCard configuration={configuration} configurationCurrent={configurationCurrent} chapterScoped={chapterScoped} api={api} reload={reload} onNotice={onNotice} />
    <LabelsCard configuration={configuration} chapterScoped={chapterScoped} api={api} reload={reload} onNotice={onNotice} />
    {api?.loadWorkloadConfiguration
      ? <WorkloadConfigurationCard key={configuration?.organizationId} chapterScoped={chapterScoped} api={api} onNotice={onNotice} />
      : <WorkloadCategoriesCard configuration={configuration} chapterScoped={chapterScoped} api={api} reload={reload} onNotice={onNotice} />}
    <FailedLoginInbox initial={failedLoginInbox} api={api} onNotice={onNotice} />
  </>;
}
