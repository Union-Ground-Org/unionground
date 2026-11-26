import { BusyButton } from "../../components/BusyControls.jsx";
// The alternate shell's Account and Alerts pages (REQ-UG-ALT-PORT-MEMBER-PAGES-20261030)
// for SettingsView. Account is the prototype's pages/account.js `/me`: the
// greeting hero, its figures row and its split of panels. Alerts is
// pages/alerts.js `/alerts`, drawn at /m/settings/notifications: numbered
// panels for chapters, what to send and how, beside a sticky preview.
//
// Nothing here owns state or talks to the server. Every control is one of
// SettingsView's own blocks (passed in `blocks`, already bound to its state
// and handlers) or a prototype-styled control calling SettingsView's own
// handler. The settings page routing is kept: a block shows only on the
// settings page its classic section belongs to (WorkspaceSection's rule), so
// sign-in, two-step, PIN, passkeys, sessions, data choices and the switch
// back to the classic site sit exactly where they do in the classic shell.
import { useLang } from "../../lib/LanguageContext.jsx";
import { seededTierName } from "../../lib/seededLabels.js";
// The settings page directory the classic overview leads with, as-is.
import { WorkspaceOverview as WorkspaceDirectory } from "../../components/WorkspacePages.jsx";
import { BrandMark, Icon } from "../icons.jsx";
import { formatClock, formatDay, formatNumber, toDate } from "../format.js";
import { HelpCrumbs, HelpSwitchRow } from "./HelpParts.jsx";
import "../../lib/i18n/features/altHelpPagesStrings.js";

const RING_RADIUS = 52;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

// The classic sections each block belongs to, in the hub's order. `heading`
// is the eyebrow the classic hub draws above the block.
const MAIN_BLOCKS = [
  ["setupNextCard", ["overview"]],
  ["profileDetails", ["settings-profile"]],
  ["visibilityCard", ["settings-privacy"]],
  ["stewardContact", ["settings-privacy"]],
  ["ctaCard", ["settings-shortcuts"]],
  ["unionRows", ["settings-shortcuts"], "morehub.union"],
  ["doRows", ["settings-shortcuts"], "morehub.doSomething"],
  ["learningManage", ["overview"]],
  ["messageWorkflowCard", ["settings-messages"]],
  ["navUsageCard", ["settings-appearance"]],
  ["notificationsCard", ["settings-notifications"]],
  ["analyticsCard", ["settings-privacy"]],
  ["siteViewCard", ["overview", "settings-language"]],
  ["keyboardShortcutsCard", ["overview"]],
  ["languageCard", ["settings-language"]],
  ["chapterCard", ["settings-profile"], "morehub.yourChapter"],
  ["leadershipCard", ["settings-profile"]],
  ["requestsCard", ["settings-requests"]],
  ["securityCard", ["settings-security"], "morehub.security"],
  ["calendarCard", ["settings-calendar"], "settings.calendarHeading"],
  ["sessionsCard", ["settings-sessions"], "settings.sessionsEyebrow"],
];

function joinChannels(t, channels) {
  if (channels.length < 2) return channels[0] ?? "";
  return t("altHelpPages.channelJoin", { a: channels[0], b: channels[1] });
}

function firstName(member) {
  if (member.firstName) return member.firstName;
  const [first] = String(member.fullName || "").trim().split(/\s+/);
  return first || member.initials || "";
}

// The prototype's tier ring and three figures, from the member's rewards
// summary. A figure the summary does not carry shows a dash, never a guess.
function AccountKpis({ rewards, actionsThisYear = null, t, lang }) {
  // The summary's own count first; else the member's point events this year
  // (SettingsView's read), never a zero it does not know.
  const actions = rewards?.actionsYtd ?? (Number.isInteger(actionsThisYear) ? actionsThisYear : null);
  const points = rewards?.totalPoints ?? null;
  const toGo = rewards?.pointsToGo ?? null;
  const top = rewards?.isMaxTier === true;
  const pct = top ? 100 : points != null && toGo != null && points + toGo > 0 ? Math.round((points / (points + toGo)) * 100) : 0;
  const ringLabel = top ? t("altHelpPages.kpiRingTop") : rewards?.nextTierName ? t("altHelpPages.kpiRing", { pct, tier: seededTierName(rewards.nextTierName, t) }) : t("altHelpPages.kpiNoPoints");
  return (
    <section className="ug-wrap ug-alt-page-kpis" aria-label={t("altHelpPages.kpisLabel")}>
      <div className="ug-kpis">
        <div className="ug-kpi ug-alt-help-ring">
          <svg viewBox="0 0 120 120" role="img" aria-label={ringLabel}>
            <circle cx="60" cy="60" r={RING_RADIUS} fill="none" stroke="#fff" strokeWidth="12" />
            <circle cx="60" cy="60" r={RING_RADIUS} fill="none" stroke="var(--ug-gold)" strokeWidth="12" strokeLinecap="round" strokeDasharray={`${((pct / 100) * RING_LENGTH).toFixed(1)} ${RING_LENGTH.toFixed(1)}`} transform="rotate(-90 60 60)" />
            <text x="60" y="66" textAnchor="middle" className="ug-alt-help-ring-n">{points == null ? "—" : formatNumber(points, lang)}</text>
          </svg>
          <span>
            <small>{rewards ? t("altHelpPages.kpiTier", { n: rewards.tierNumber }) : t("altHelpPages.kpiNoPoints")}</small>
            <b>{seededTierName(rewards?.tierName, t) ?? "—"}</b>
            <span>{top ? t("altHelpPages.kpiTop") : rewards?.nextTierName && toGo != null ? t("altHelpPages.kpiToNext", { points: formatNumber(toGo, lang), tier: seededTierName(rewards.nextTierName, t) }) : ""}</span>
          </span>
        </div>
        <div className="ug-kpi"><small>{t("altHelpPages.kpiStreak")}</small><b className="ug-tnum">{rewards ? t("altHelpPages.kpiStreakValue", { n: formatNumber(rewards.weekStreak ?? 0, lang) }) : "—"}</b><span>{t("altHelpPages.kpiStreakSub")}</span></div>
        <div className="ug-kpi"><small>{t("altHelpPages.kpiActions")}</small><b className="ug-tnum">{actions == null ? "—" : formatNumber(actions, lang)}</b><span>{actions == null ? t("altHelpPages.kpiNotTracked") : t("altHelpPages.kpiActionsSub")}</span></div>
        <div className="ug-kpi"><small>{t("altHelpPages.kpiRecruited")}</small><b className="ug-tnum">—</b><span>{t("altHelpPages.kpiNotTracked")}</span></div>
      </div>
    </section>
  );
}

function panel(key, node, heading = null) {
  if (!node) return null;
  return (
    <div className="ug-panel ug-alt-help-card" key={key}>
      {heading ? <h2>{heading}</h2> : null}
      <div className="ug-legacy">{node}</div>
    </div>
  );
}

export function AltAccountPage(props) {
  const { workspace, t, data, member, roleLine, pageTitle, onOpenHome, onProfile, onSignOut, signingOut = false, go, navTarget, blocks } = props;
  const { lang } = useLang();
  const section = workspace ? workspace.section : null;
  const shows = (names) => !workspace || names.includes(section);
  const accountCrumb = { label: t("altHelpPages.account"), href: "/m/settings", onOpen: () => go("settings", "/m/settings") };

  if (workspace && section === "settings-notifications") return <AltAlertsPage {...props} accountCrumb={accountCrumb} />;

  const overview = !workspace || section === "overview";
  const main = MAIN_BLOCKS.filter(([key, names]) => blocks[key] && shows(names)).map(([key, , heading]) => panel(key, blocks[key], heading ? t(heading) : null));
  const navOpen = (view, path) => {
    const target = navTarget(view, path);
    return target.refused ? null : target.onActivate;
  };
  const openCases = navOpen("cases", "/m/cases");
  const openVotes = navOpen("voting", "/m/voting");
  const openEvents = navOpen("events", "/m/events");
  const openHelp = navOpen("memberSupport", "/m/support");

  const rsvps = (data.events || [])
    .filter((item) => item.isPast !== true && !item.cancelledAt && item.rsvpStatus === "going")
    .map((item) => ({ item, at: toDate(item.startsAt ?? item.eventDate) }))
    .sort((left, right) => (left.at?.getTime() ?? 0) - (right.at?.getTime() ?? 0));
  const topicsOn = props.topics.filter((topic) => props.prefs[topic.key]).length;
  const channels = [props.push?.subscribed ? t("altHelpPages.channelPush") : null, props.smsConsented ? t("altHelpPages.channelSms") : null].filter(Boolean);

  const lede = [roleLine, member.sinceYear ? t("altHelpPages.since", { year: member.sinceYear }) : null, member.email ? t("altHelpPages.signedInAs", { email: member.email }) : null].filter(Boolean).join(" · ");

  return (
    <div className="ug-alt-help">
      <section className="ug-page-hero ug-alt-help-hero">
        <div className="ug-wrap">
          {overview ? (
            <>
              <HelpCrumbs onOpenHome={onOpenHome} trail={[{ label: t("altHelpPages.account") }]} />
              <div className="ug-alt-help-me">
                <span className="ug-person ug-alt-help-avatar" aria-hidden="true">{member.initials}</span>
                <div className="ug-alt-help-grow">
                  <h1>{t("altHelpPages.hi")}<span className="ug-accent">{firstName(member)}</span></h1>
                  {lede ? <p className="ug-lede">{lede}</p> : null}
                </div>
                <div className="ug-btn-row">
                  {onProfile ? <button className="ug-btn ug-btn-soft" type="button" onClick={onProfile}><Icon name="user" />{t("altHelpPages.card")}</button> : null}
                  {onSignOut ? <BusyButton className="ug-btn ug-btn-soft" type="button" pending={signingOut} aria-busy={signingOut || undefined} onClick={onSignOut}><Icon name="logout" />{signingOut ? t("app.signingOut") : t("altHelpPages.signOut")}</BusyButton> : null}
                </div>
              </div>
            </>
          ) : (
            <>
              <HelpCrumbs onOpenHome={onOpenHome} trail={[accountCrumb, { label: pageTitle }]} />
              <h1>{pageTitle}</h1>
              <p className="ug-lede">{t("altHelpPages.accountLede")}</p>
            </>
          )}
        </div>
      </section>
      {overview ? <AccountKpis rewards={data.rewards ?? null} actionsThisYear={props.actionsThisYear ?? null} t={t} lang={lang} /> : null}
      <section className="ug-wrap ug-split ug-alt-help-split">
        <div className="ug-alt-help-stack">
          {overview ? (
            <>
              <div className="ug-panel">
                <h2>{t("altHelpPages.casesTitle")}</h2>
                <p className="ug-alt-help-sub">{t("altHelpPages.casesBody")}</p>
                {openCases ? <button className="ug-btn ug-btn-dark ug-btn-sm" type="button" onClick={openCases}>{t("altHelpPages.casesOpen")}</button> : null}
              </div>
              <div className="ug-panel">
                <h2>{t("altHelpPages.ballotsTitle")}</h2>
                <p className="ug-alt-help-sub">{t("altHelpPages.ballotsBody")}</p>
                {openVotes ? <button className="ug-btn ug-btn-dark ug-btn-sm" type="button" onClick={openVotes}>{t("altHelpPages.ballotsOpen")}</button> : null}
              </div>
            </>
          ) : null}
          {workspace && overview ? panel("directory", <WorkspaceDirectory />, t("altHelpPages.settingsTitle")) : null}
          {main}
        </div>
        <aside className="ug-alt-help-stack">
          {overview ? (
            <>
              <div className="ug-panel-w">
                <h3>{t("altHelpPages.rsvpsTitle")}</h3>
                {rsvps.length ? (
                  <ul className="ug-list">
                    {rsvps.map(({ item, at }) => (
                      <li className="ug-li ug-alt-help-li" key={item.id}>
                        <span className="ug-av ug-av-sm ug-alt-help-av" aria-hidden="true"><Icon name="calendar" /></span>
                        <span><b>{item.title}</b><span>{at ? `${formatDay(at, lang)}${item.startsAt ? ` · ${formatClock(at, lang)}` : ""}` : ""}</span></span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="ug-alt-help-sub">{t("altHelpPages.rsvpsNone")} {openEvents ? <button type="button" className="ug-link ug-alt-help-read" onClick={openEvents}>{t("altHelpPages.rsvpsFind")}</button> : null}</p>
                )}
              </div>
              <div className="ug-panel">
                <h3>{t("altHelpPages.savedTitle")}</h3>
                <p className="ug-alt-help-sub">{t("altHelpPages.savedNone")} {openHelp ? <button type="button" className="ug-link ug-alt-help-read" onClick={openHelp}>{t("altHelpPages.savedBrowse")}</button> : null}</p>
              </div>
              <div className="ug-panel">
                <h3>{t("altHelpPages.alertsTitle")}</h3>
                {props.onNotificationPrefs ? (
                  <p className="ug-alt-help-sub">
                    {t("altHelpPages.alertsSummary", { on: topicsOn, total: props.topics.length })} · {channels.length ? t("altHelpPages.alertsBy", { channels: joinChannels(t, channels) }) : t("altHelpPages.alertsNoChannel")}
                  </p>
                ) : null}
                <button className="ug-btn ug-btn-soft ug-btn-sm" type="button" onClick={() => go("settings", "/m/settings/notifications")}>{t(topicsOn && channels.length ? "altHelpPages.alertsEdit" : "altHelpPages.alertsSetUp")}</button>
              </div>
            </>
          ) : (
            <div className="ug-panel-w ug-alt-help-who">
              <span className="ug-person ug-alt-help-avatar" aria-hidden="true">{member.initials}</span>
              <span><b>{member.fullName || member.initials}</b><span>{roleLine}</span></span>
              {onProfile ? <button className="ug-btn ug-btn-soft ug-btn-sm" type="button" onClick={onProfile}>{t("altHelpPages.card")}</button> : null}
            </div>
          )}
          {shows(["overview", "settings-profile"]) ? panel("account", <>{blocks.accountRows}{blocks.footnote}</>, t("morehub.account")) : null}
        </aside>
      </section>
    </div>
  );
}

function AltAlertsPage({ uid, t, member, onOpenHome, accountCrumb, topics, emailChoices, prefs, prefsBusy, togglePref, onNotificationPrefs, push, pushAvailable, pushBusy, togglePush, pushAction, onPushRefresh, authClient, smsConsented, smsStatus, smsBusy, saveSms, smsForm, smsErrorLine, onFocusSettings, focusBusy, toggleDnd, quietForm, quietChip, onAddShortcut, onCalendarRotate, calendarBody, notifSub }) {
  const memberships = Array.isArray(member.chapterMemberships) && member.chapterMemberships.length
    ? member.chapterMemberships.map((item) => ({ id: item.chapterId, name: item.name }))
    : member.chapterName ? [{ id: member.chapterId || member.chapterName, name: member.chapterName }] : [];
  const enabled = onNotificationPrefs ? [...topics, ...emailChoices].filter((choice) => prefs[choice.key]) : [];
  const via = [push?.subscribed ? t("altHelpPages.channelPush") : null, smsConsented ? t("altHelpPages.channelSms") : null].filter(Boolean);
  const quiet = Boolean(member.dndEnabled) || Boolean(quietChip);
  const anyChannel = Boolean(push || authClient || onFocusSettings || onAddShortcut || onCalendarRotate);
  const topicRow = (choice, prefix) => (
    <HelpSwitchRow
      key={choice.key}
      id={`${uid}-alt-${prefix}-${choice.key}`}
      label={t(choice.labelKey)}
      sub={choice.subKey ? t(choice.subKey) : null}
      checked={prefs[choice.key]}
      pending={prefsBusy}
      busy={prefsBusy}
      onToggle={() => togglePref(choice.key)}
    />
  );
  return (
    <div className="ug-alt-help">
      <section className="ug-page-hero ug-alt-help-hero">
        <div className="ug-wrap">
          <HelpCrumbs onOpenHome={onOpenHome} trail={[accountCrumb, { label: t("altHelpPages.alertsCrumb") }]} />
          <h1>{t("altHelpPages.alertsH1Lead")}<span className="ug-accent">{t("altHelpPages.alertsH1Accent")}</span></h1>
          <p className="ug-lede">{t("altHelpPages.alertsLede")}</p>
        </div>
      </section>
      <section className="ug-wrap ug-split ug-alt-help-split">
        <div className="ug-alt-help-stack">
          <div className="ug-panel">
            <h2>{t("altHelpPages.alertsChapters")}</h2>
            {memberships.length ? (
              <>
                <ul className="ug-chips ug-alt-help-chapters">
                  {memberships.map((item) => <li key={item.id}><span className="ug-chip">{item.name}</span></li>)}
                </ul>
                <p className="ug-alt-help-sub">{t("altHelpPages.alertsChaptersNote")}</p>
              </>
            ) : <p className="ug-alt-help-sub">{t("altHelpPages.alertsNoChapter")}</p>}
          </div>
          <div className="ug-panel">
            <h2>{t("altHelpPages.alertsWhat")}</h2>
            {onNotificationPrefs ? (
              <>
                <p className="ug-alt-help-sub">{notifSub}</p>
                <div className="ug-alt-help-opts">{topics.map((topic) => topicRow(topic, "topic"))}</div>
                <h3 className="ug-alt-help-h3">{t("settings.unionEmail")}</h3>
                <div className="ug-alt-help-opts">{emailChoices.map((choice) => topicRow(choice, "email"))}</div>
              </>
            ) : <p className="ug-alt-help-sub">{t("altHelpPages.alertsWhatNone")}</p>}
          </div>
          <div className="ug-panel">
            <h2>{t("altHelpPages.alertsHow")}</h2>
            <div className="ug-alt-help-opts">
              {push ? (pushAvailable ? (
                <>
                  <HelpSwitchRow id={`${uid}-alt-push`} label={t("morehub.push")} sub={t("settings.pushSub")} checked={push.subscribed} pending={pushBusy} busy={pushBusy} onToggle={togglePush} />
                  {push.subscribed && onPushRefresh ? (
                    <div className="ug-alt-help-inline">
                      <small id={`${uid}-alt-push-refresh-help`}>{t("settings.pushRefreshSub")}</small>
                      <BusyButton type="button" className="ug-btn ug-btn-soft ug-btn-xs" aria-describedby={`${uid}-alt-push-refresh-help`} pending={pushBusy} aria-busy={pushBusy} onClick={() => pushAction(onPushRefresh)}>{t("settings.pushRefresh")}</BusyButton>
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="ug-opt ug-alt-help-static"><span className="ug-ci ug-alt-help-ci" aria-hidden="true"><Icon name="browser" /></span><span className="ug-alt-help-grow"><b>{t("morehub.push")}</b><span>{push.denied ? t("settings.pushBlocked") : t("settings.pushUnsupported")}</span></span></div>
              )) : null}
              {authClient ? (
                <div className="ug-opt ug-alt-help-static">
                  <span className="ug-ci ug-alt-help-ci" aria-hidden="true"><Icon name="msg" /></span>
                  <span className="ug-alt-help-grow"><b>{t("settings.smsTitle")}</b><span>{smsStatus}</span></span>
                  {smsConsented ? <BusyButton type="button" className="ug-btn ug-btn-soft ug-btn-xs" pending={smsBusy} onClick={() => saveSms(false)}>{t("settings.smsTurnOff")}</BusyButton> : null}
                </div>
              ) : null}
              {smsForm || smsErrorLine ? <div className="ug-legacy">{smsForm}{smsErrorLine}</div> : null}
              <div className="ug-opt ug-alt-help-static">
                <span className="ug-ci ug-alt-help-ci" aria-hidden="true"><Icon name="mail" /></span>
                <span className="ug-alt-help-grow"><b>{t("altHelpPages.alertsEmail")}</b><span>{t("altHelpPages.alertsEmailBody")}</span></span>
              </div>
              {onFocusSettings ? (
                <>
                  <HelpSwitchRow id={`${uid}-alt-dnd`} label={t("settings.dnd")} sub={t("settings.dndSub")} checked={member.dndEnabled} pending={focusBusy} busy={focusBusy} onToggle={toggleDnd} />
                  <div className="ug-opt ug-alt-help-static ug-alt-help-quiet">
                    <span className="ug-ci ug-alt-help-ci" aria-hidden="true"><Icon name="moon" /></span>
                    <span className="ug-alt-help-grow"><b>{t("altHelpPages.alertsQuiet")}</b><span>{t("setin.quietSub")}</span></span>
                    {quietChip ? <span className="ug-legacy">{quietChip}</span> : null}
                  </div>
                  <div className="ug-legacy">{quietForm}</div>
                </>
              ) : null}
              {onAddShortcut ? (
                <button type="button" className="ug-opt" onClick={onAddShortcut}>
                  <span className="ug-ci ug-alt-help-ci" aria-hidden="true"><Icon name="phone" /></span>
                  <span className="ug-alt-help-grow"><b>{t("morehub.shortcut")}</b><span>{t("morehub.shortcutSub")}</span></span>
                  <Icon name="right" />
                </button>
              ) : null}
              {onCalendarRotate ? (
                <div className="ug-opt ug-alt-help-static ug-alt-help-calendar">
                  <span className="ug-ci ug-alt-help-ci" aria-hidden="true"><Icon name="calendar" /></span>
                  <div className="ug-alt-help-grow"><b>{t("settings.calendarHeading")}</b><div className="ug-legacy">{calendarBody}</div></div>
                </div>
              ) : null}
              {anyChannel ? null : <p className="ug-alt-help-sub">{t("altHelpPages.alertsHowNone")}</p>}
            </div>
          </div>
          <p className="ug-alt-help-sub">{t("altHelpPages.alertsSaved")}</p>
        </div>
        <aside className="ug-panel ug-alt-help-preview" aria-labelledby={`${uid}-alt-preview`}>
          <h3 id={`${uid}-alt-preview`}>{t("altHelpPages.previewTitle")}</h3>
          {enabled.length ? (
            <>
              <p className="ug-alt-help-sub">{via.length ? t("altHelpPages.previewVia", { channels: joinChannels(t, via) }) : t("altHelpPages.previewNoChannel")}{quiet ? ` ${t("altHelpPages.previewQuiet")}` : ""}</p>
              <div className="ug-alt-help-bots">
                {enabled.slice(0, 3).map((choice) => (
                  <div className="ug-bot ug-alt-help-bot" key={choice.key}>
                    <div className="ug-bot-h"><BrandMark className="ug-alt-help-mark" />{t("altHelpPages.previewBrand")} <span>{t("altHelpPages.previewTag")}</span></div>
                    <b>{t(choice.labelKey)}</b>
                    {choice.subKey ? <p>{t(choice.subKey)}</p> : null}
                  </div>
                ))}
              </div>
              {enabled.length > 3 ? <p className="ug-alt-help-sub">{t("altHelpPages.previewMore", { count: enabled.length - 3 })}</p> : null}
            </>
          ) : (
            <div className="ug-empty ug-alt-help-empty-w"><b>{t("altHelpPages.previewNone")}</b>{t("altHelpPages.previewNoneBody")}</div>
          )}
        </aside>
      </section>
    </div>
  );
}
