import { runBusyWrite, prepareBusyWrite } from "../lib/busyWrite.js";
import { BusyButton, BusyInput, BusySelect } from "../components/BusyControls.jsx";
import { PlatformAnnouncementSettings } from "../features/platformAnnouncements/PlatformAnnouncements.jsx";
import { UnitSettingsPanel } from "../features/chapterAccess/UnitSettingsPanel.jsx";
import { PracticeHistorySettingsEntry } from "../features/learningPeriod/LearningPeriod.jsx";
import { FormAutofillSetting } from "../components/FormAutofillSetting.jsx";
import { NEW_PASSWORD_MIN } from "../lib/passwordPolicy.js";
import "../components/workplace-roster.css";
import { WorkspaceSection, WorkspaceOverview, useWorkspace, useWorkspaceTitle, WorkspaceCardTitle, WorkspaceCardHead } from "../components/WorkspacePages.jsx";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { useCalendarFeed } from "../lib/useCalendarFeed.js";
import {
  AtSign, Bell, BriefcaseBusiness, CalendarDays, ChartNoAxesColumnIncreasing,
  ChevronRight, Clock3, FilePenLine, FolderKanban, Gift, Globe2, Keyboard, LogOut, MapPin,
  Megaphone, MessageCircle, MessageSquare, Monitor, Moon, PenLine, Scale, Search,
  Smartphone, Timer, Vote,
} from "lucide-react";
import { LearningLearnArea, LearningManageGate } from "../features/learningContent/LearningLearnArea.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import { formatEasternTimestamp } from "../lib/easternTimestamp.js";
import { ENGAGEMENT_EMAIL_PREFERENCE_KEYS, NOTIFICATION_TOPIC_KEYS, REMINDER_PREFERENCE_KEYS, countMemberActionsThisYear } from "../lib/memberApi.js";
import { leadershipRoleLine, titleOnlyRole } from "../lib/chapterLeadership.js";
import { privacyStatements } from "../features/messaging/visibility.js";
import { MySeniorityCard } from "../features/seniority/MySeniorityCard.jsx";
import { MfaSettings } from "../components/MfaSettings.jsx";
import { adminSetupPathFromSearch } from "../lib/setupSecurityReturn.js";
import { STEWARD_PRESENCE, noStewardCopy } from "../lib/stewardConversations.js";
import { MessageWorkflowPicker } from "../components/MessageWorkflowPicker.jsx";
import { useDeviceParityState } from "../lib/deviceParity.js";
import { useMessageWorkflowPreference } from "../lib/messageWorkflow.js";
import { isDemoAnalyticsEnabled, setDemoAnalyticsEnabled, subscribeDemoAnalytics } from "../lib/deferredObservability.js";
import { featureLimit } from "../lib/featureSwitches.js";
import { setKeyboardShortcutsEnabled, useKeyboardShortcutsAvailable, useKeyboardShortcutsEnabled } from "../lib/keyboardShortcuts.js";
import { NavUsageSettingsCard } from "../features/memberHome/NavUsageSettingsCard.jsx";
import { SiteViewSettingsCard } from "../alt/SiteViewSettingsCard.jsx";
import { AltAccountPage } from "../alt/help/AltAccountPage.jsx";
import { HelpCrumbs } from "../alt/help/HelpParts.jsx";
import "../lib/i18n/features/altHelpPagesStrings.js";
import "../lib/i18n/features/learningContentStrings.js";

const SETUP_REVIEW_NEXT = "setup-review";
const SETUP_REVIEW_PATH = "/m/admin/setup-review";
// Roles & access, where an administrator names a steward (the launch checklist's step).
const STEWARD_ACCESS_PATH = "/m/admin/access";

// ============================================================================
// The Union Base "More" hub (prototype page id `settings`, screen label
// "Mobile · More"). This is the screen the bottom nav's ☰ More tab lands on at
// /m/settings: profile card, steward CTA, UNION and DO SOMETHING link lists,
// then the settings/chapter/security/account stacks — rebuilt pixel-to-pixel
// from the prototype with every live capability of the old Settings screen
// re-housed inside the prototype's card patterns.
// ============================================================================

const TOPIC_COPY = {
  deadlines: { labelKey: "settings.topicDeadlines", subKey: "settings.topicDeadlinesSub", icon: Clock3 },
  cases: { labelKey: "settings.topicCases", subKey: "settings.topicCasesSub", icon: FolderKanban },
  forms: { labelKey: "settings.topicForms", subKey: "settings.topicFormsSub", icon: FilePenLine },
  votes: { labelKey: "settings.topicVotes", subKey: null, icon: Vote },
  events: { labelKey: "settings.topicEvents", subKey: "settings.topicEventsSub", icon: MapPin },
  // Rendered for EVERYONE, deliberately: the tasks SURFACE is staff-only but
  // the notices are not — the assignee roster has no role filter, so a
  // role-less member can be handed a task and will receive the assignment
  // notice. Hiding the toggle from exactly that member would make the notice
  // unmutable for its least-consenting audience.
  tasks: { labelKey: "settings.topicTasks", subKey: "settings.topicTasksSub", icon: BriefcaseBusiness },
  appointments: { labelKey: "settings.topicAppointments", subKey: "settings.topicAppointmentsSub", icon: CalendarDays },
  workload: { labelKey: "settings.topicWorkload", subKey: "settings.topicWorkloadSub", icon: ChartNoAxesColumnIncreasing },
  // REQ-UG-CHANNEL-CONTROLS-RESTORED-20261001: channel mentions, @here and
  // keyword alerts. Per-channel levels and mute live on each channel; this
  // switch decides whether those notices may also leave the app.
  messages: { labelKey: "settings.topicMessages", subKey: "settings.topicMessagesSub", icon: AtSign },
};

// Derived from the persistence list, never restated: a topic the writer cannot
// persist must not be offered as a switch.
// Union Ground carries no dues, so a dues topic is never offered even if a
// shared persistence list still names it.
const NOTIFICATION_TOPICS = NOTIFICATION_TOPIC_KEYS.filter((key) => key !== "dues").map((key) => ({ key, ...TOPIC_COPY[key] }));

// Union email from the engagement outbox (broadcasts, surveys, welcome mail).
// A one-click unsubscribe link in each email turns the matching switch off.
const ENGAGEMENT_EMAIL_COPY = {
  announcements: { labelKey: "settings.emailAnnouncements", subKey: "settings.emailAnnouncementsSub", icon: Megaphone },
  surveys: { labelKey: "settings.emailSurveys", subKey: "settings.emailSurveysSub", icon: Vote },
  welcome: { labelKey: "settings.emailWelcome", subKey: "settings.emailWelcomeSub", icon: Megaphone },
};
const ENGAGEMENT_EMAIL_CHOICES = ENGAGEMENT_EMAIL_PREFERENCE_KEYS.map((key) => ({ key, ...ENGAGEMENT_EMAIL_COPY[key] }));

// REQ-UG-ONBOARDING-ADMIN-SERVER-GAPS-20261104: the member's switch
// for the onboarding reminder staff can send; the server refuses a reminder
// while it is off. Shown with the topics, written like an email choice.
const REMINDER_COPY = {
  onboarding: { labelKey: "settings.topicOnboarding", subKey: "settings.topicOnboardingSub", icon: Timer },
};
const REMINDER_CHOICES = REMINDER_PREFERENCE_KEYS.map((key) => ({ key, ...REMINDER_COPY[key] }));
// Choices that a write sends only when the member flips that switch.
const WRITE_WHEN_FLIPPED_KEYS = [...ENGAGEMENT_EMAIL_PREFERENCE_KEYS, ...REMINDER_PREFERENCE_KEYS];

// An absent key means "enabled" everywhere — in the enqueue trigger and here —
// so unset topics must render on.
const DEFAULT_TOPIC_PREFS = Object.fromEntries([...NOTIFICATION_TOPIC_KEYS, ...WRITE_WHEN_FLIPPED_KEYS].map((key) => [key, true]));

// [IANA id, catalogue key]. The id is what the server stores and must never
// move with the language; the label is member-facing copy on an otherwise
// fully translated form, so it is a key rather than a string.
const FOCUS_TIME_ZONES = [
  ["America/New_York", "settings.zoneNewYork"],
  ["America/Chicago", "settings.zoneChicago"],
  ["America/Denver", "settings.zoneDenver"],
  ["America/Phoenix", "settings.zonePhoenix"],
  ["America/Los_Angeles", "settings.zoneLosAngeles"],
  ["America/Anchorage", "settings.zoneAnchorage"],
  ["Pacific/Honolulu", "settings.zoneHonolulu"],
  ["America/Puerto_Rico", "settings.zonePuertoRico"],
  ["America/Detroit", "settings.zoneDetroit"],
  ["America/Indiana/Indianapolis", "settings.zoneIndianapolis"],
];

const DEMO_SESSIONS = [
  {
    handle: "demo-current",
    deviceLabel: "windows_computer",
    browserLabel: "chrome",
    current: true,
    lastActiveAt: "2026-08-12T15:30:00Z",
    sample: true,
  },
  {
    handle: "demo-remote",
    deviceLabel: "apple_mobile",
    browserLabel: "safari",
    current: false,
    lastActiveAt: "2026-08-11T19:15:00Z",
    sample: true,
  },
];

// The prototype's iOS-style pill switch (46×28, 22px knob). The pill itself is
// the switch control; the row around it is static so the accessible name stays
// the visible label and the sub-line stays the description.
function Toggle({ id, checked, disabled, pending = false, busy, onToggle, describedBy }) {
  return (
    <BusyButton
      type="button"
      className={checked ? "morehub-toggle is-on" : "morehub-toggle"}
      role="switch"
      aria-checked={checked}
      aria-labelledby={`${id}-label`}
      aria-describedby={describedBy ? `${id}-sub` : undefined}
      aria-busy={busy || undefined}
      disabled={disabled}
      pending={pending || busy}
      onClick={onToggle}
    >
      <span className="morehub-toggle__knob" aria-hidden="true" />
    </BusyButton>
  );
}

// A toggle row in the desktop prototype's settings-card row pattern: emoji
// glyph in a fixed 24px slot, bold label + muted sub, pill switch on the right.
function ToggleRow({ icon, id, label, sub, checked, disabled, pending = false, busy, onToggle }) {
  const Icon = icon;
  return (
    <div className="setin-row setin-row--toggle">
      {Icon ? <span className="setin-row__icon" aria-hidden="true"><Icon size={18} /></span> : null}
      <span className="setin-row__text">
        <strong id={`${id}-label`}>{label}</strong>
        {sub ? <small id={`${id}-sub`}>{sub}</small> : null}
      </span>
      <Toggle id={id} checked={checked} disabled={disabled} pending={pending} busy={busy} onToggle={onToggle} describedBy={Boolean(sub)} />
    </div>
  );
}

// "22:00" → "10:00 PM" / "10:00 p.\u00a0m.". Still deterministic (no Intl/locale
// involvement — a prior hydration incident came from locale-formatted times):
// the meridiem is the one localized part and it comes from the catalogue, which
// carries ICU's Spanish form for it. Returns null for anything unparseable so
// the quiet-hours chip simply doesn't render.
function formatQuietTime(value, t) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value || "");
  if (!match) return null;
  const hours = Number(match[1]);
  if (hours > 23) return null;
  const suffix = t(hours >= 12 ? "settings.quietPm" : "settings.quietAm");
  return `${hours % 12 || 12}:${match[2]} ${suffix}`;
}

function sessionDeviceIcon(session) {
  return /(mobile|phone|iphone|android)/i.test(session?.deviceLabel || "") ? Smartphone : Monitor;
}

// A tappable list row in the prototype's 54px hub pattern: glyph, bold label,
// optional red/gold badge or muted meta, chevron.
function HubRow({ icon, label, badge, badgeTone, meta, onActivate, href, refused = false, busy = false }) {
  // A destination the shell's route guard would refuse is not offered at all:
  // rendering it hands the member a control whose only outcome is a bounced
  // URL and a refusal toast (see navTarget below).
  if (refused) return null;
  const Icon = icon;
  const inner = (
    <>
      <span className="morehub-row__icon" aria-hidden="true"><Icon size={19} /></span>
      <span className="morehub-row__label">{label}</span>
      {badge ? <span className={badgeTone === "gold" ? "morehub-row__badge morehub-row__badge--gold" : "morehub-row__badge"}>{badge}</span> : null}
      {meta ? <span className="morehub-row__meta">{meta}</span> : null}
      <span className="morehub-row__chev" aria-hidden="true"><ChevronRight size={18} /></span>
    </>
  );
  if (href) {
    return <a className="morehub-row morehub-row--nav" href={href} target="_blank" rel="noopener noreferrer">{inner}</a>;
  }
  return <BusyButton type="button" className="morehub-row morehub-row--nav" pending={busy} aria-busy={busy || undefined} onClick={onActivate}>{inner}</BusyButton>;
}

// REQ-UG-MEMBER-FIND-MY-STEWARD-HOME-ENTRY-20260922. A steward decides for
// themselves whether members see a direct address or number beside their name
// on the Find-my-steward card. This is the ONLY writer: the RPC behind it takes
// no steward id, so nobody can publish someone else's channel, and the default
// with no saved row is the in-app conversation alone.
// REQ-UG-MEMBER-OFFICER-MESSAGING-AND-VISIBILITY-20261030: a
// chapter officer or administrator shares here too (members-only: the members
// of their chapter, on Who runs this chapter); bodyKey says where it shows.
function StewardContactVisibilityCard({ api, uid, t, bodyKey = "settings.stewardContactBody" }) {
  const busyWriteRef = useRef(new Set());
  const [value, setValue] = useState(null);
  const [state, setState] = useState("loading");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => api.load())
      .then((loaded) => { if (live) { setValue(loaded); setState("ready"); } })
      .catch(() => { if (live) setState("error"); });
    return () => { live = false; };
  }, [api]);

  if (state === "loading") return <section className="setin-card"><p>{t("settings.stewardContactLoading")}</p></section>;
  if (state === "error") {
    return <section className="setin-card"><p role="alert">{t("settings.stewardContactError")}</p></section>;
  }

  const patch = (next) => setValue((current) => ({ ...current, ...next }));
  const save = async () => {
    return runBusyWrite(busyWriteRef, "busy", async (releaseBusyWrite) => {
      setBusy(true);
      try {
        const saved = await api.save(value);
        setValue(saved);
        setState("saved");
      } catch {
        setState("saveError");
      } finally {
        setBusy(false);

        releaseBusyWrite();
      }
    });
  };

  return (
    <section className="setin-card steward-contact" aria-labelledby={`${uid}-steward-contact-title`}>
      <div className="setin-card__head">
        <h3 id={`${uid}-steward-contact-title`}>{t("settings.stewardContactTitle")}</h3>
        <p>{t(bodyKey)}</p>
      </div>
      <div className="steward-contact__row">
        <label htmlFor={`${uid}-steward-share-email`}>
          <input
            id={`${uid}-steward-share-email`}
            type="checkbox"
            checked={value.shareEmail}
            onChange={(event) => patch({ shareEmail: event.target.checked })}
          />
          {t("settings.stewardContactShareEmail")}
        </label>
        <label htmlFor={`${uid}-steward-email`}>
          <span>{t("settings.stewardContactEmail")}</span>
          <input
            id={`${uid}-steward-email`}
            type="email"
            value={value.contactEmail ?? ""}
            onChange={(event) => patch({ contactEmail: event.target.value })}
          />
        </label>
      </div>
      <div className="steward-contact__row">
        <label htmlFor={`${uid}-steward-share-phone`}>
          <input
            id={`${uid}-steward-share-phone`}
            type="checkbox"
            checked={value.sharePhone}
            onChange={(event) => patch({ sharePhone: event.target.checked })}
          />
          {t("settings.stewardContactSharePhone")}
        </label>
        <label htmlFor={`${uid}-steward-phone`}>
          <span>{t("settings.stewardContactPhone")}</span>
          <input
            id={`${uid}-steward-phone`}
            type="tel"
            value={value.contactPhone ?? ""}
            onChange={(event) => patch({ contactPhone: event.target.value })}
          />
        </label>
      </div>
      <BusyButton type="button" className="dialog-primary" pending={busy} onClick={save}>
        {busy ? t("settings.stewardContactSaving") : t("settings.stewardContactSave")}
      </BusyButton>
      {state === "saved" && <p className="steward-contact__note" role="status">{t("settings.stewardContactSaved")}</p>}
      {state === "saveError" && <p className="steward-contact__note" role="alert">{t("settings.stewardContactSaveError")}</p>}
      <p className="steward-contact__note">{t("settings.stewardContactDefault")}</p>
    </section>
  );
}

// REQ-UG-PROFILE-WORKPLACE-JOB-PHONE-AND-PRONOUNS-20261006. The
// member keeps their own pronouns, job, worksite and phone here and decides
// who sees them. Nothing is shared by default; "admins" shows the shared
// fields to administrators in the admin member directory and nowhere else.
function ProfileDetailsCard({ api, uid, t }) {
  const busyWriteRef = useRef(new Set());
  const [value, setValue] = useState(null);
  const [savedValue, setSavedValue] = useState(null);
  const [state, setState] = useState("loading");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => api.load())
      .then((loaded) => { if (live) { setValue(loaded); setSavedValue(loaded); setState("ready"); } })
      .catch(() => { if (live) setState("error"); });
    return () => { live = false; };
  }, [api]);

  if (state === "loading") return <section className="setin-card"><p>{t("settings.profileDetailsLoading")}</p></section>;
  if (state === "error") {
    return <section className="setin-card"><p role="alert">{t("settings.profileDetailsError")}</p></section>;
  }

  const patch = (next) => {
    setValue((current) => ({ ...current, ...next }));
    setState("dirty");
  };
  const save = async (event) => {
    return prepareBusyWrite(busyWriteRef, "busy", () => {
      event.preventDefault();
      if (busy) return;
      return async (releaseBusyWrite) => {
      setBusy(true);
      try {
        const saved = await api.save(value);
        setValue(saved);
        setSavedValue(saved);
        setState("saved");
      } catch (error) {
        // Only the server's phone-format refusal is about the phone; anything
        // else (offline, session, timeout) gets the plain not-saved message.
        const badPhone = error?.code === "22023" && /invalid phone number/.test(error?.message ?? "");
        setState(badPhone ? "phoneError" : "saveError");
      } finally {
        setBusy(false);

        releaseBusyWrite();
      }
          };
    }, event);
  };
  const text = (key, field, props = {}) => (
    <label htmlFor={`${uid}-profile-${field}`}>
      {t(key)}
      <BusyInput
        id={`${uid}-profile-${field}`}
        value={value[field] ?? ""}
        pending={busy}
        onChange={(event) => patch({ [field]: event.target.value })}
        {...props}
      />
    </label>
  );
  const visibility = (key, field) => (
    <label htmlFor={`${uid}-profile-${field}`}>
      {t(key)}
      <BusySelect id={`${uid}-profile-${field}`} value={value[field]} pending={busy} onChange={(event) => patch({ [field]: event.target.value })}>
        <option value="only_me">{t("settings.profileDetailsOnlyMe")}</option>
        <option value="admins">{t("settings.profileDetailsAdmins")}</option>
      </BusySelect>
    </label>
  );

  return (
    <form className="setin-card profile-details" aria-labelledby={`${uid}-profile-details-title`} onSubmit={save}>
      <div className="setin-card__head">
        <h3 id={`${uid}-profile-details-title`}>{t("settings.profileDetailsTitle")}</h3>
        <p>{t("settings.profileDetailsBody")}</p>
      </div>
      <div className="profile-details__grid">
        {text("settings.profileDetailsPronouns", "pronouns", { maxLength: 40, autoComplete: "off" })}
        {text("settings.profileDetailsJobTitle", "jobTitle", { maxLength: 120, autoComplete: "organization-title" })}
        {text("settings.profileDetailsWorksite", "worksite", { maxLength: 160, autoComplete: "off", list: `${uid}-worksites` })}
        {text("roster.shift", "shift", { maxLength: 120, list: `${uid}-shifts` })}
        {text("roster.classification", "classification", { maxLength: 120, list: `${uid}-classifications` })}
        {[['worksite','worksites'],['shift','shifts'],['classification','classifications']].map(([field, list]) => <datalist id={`${uid}-${list}`} key={field}>
          {(value.workplaceOptions?.[field] ?? []).map((option) => <option key={option} value={option} />)}
        </datalist>)}
        {visibility("settings.profileDetailsVisibility", "detailsVisibility")}
        {text("settings.profileDetailsPhone", "phone", { type: "tel", inputMode: "tel", maxLength: 40, autoComplete: "tel" })}
        {visibility("settings.profileDetailsPhoneVisibility", "phoneVisibility")}
      </div>
      <p className="profile-details__note">{t("roster.visibility")} {t("roster.suggestions")}</p>
      <BusyButton type="submit" className="dialog-primary" pending={busy}>
        {busy ? t("settings.profileDetailsSaving") : t("settings.profileDetailsSave")}
      </BusyButton>
      {state === "saved" && <p className="profile-details__note" role="status">{t("settings.profileDetailsSaved")}</p>}
      {state === "dirty" && !busy && <p className="profile-details__note" role="status">{t("settings.profileDetailsUnsaved")}</p>}
      {state === "saveError" && <p className="profile-details__note" role="alert">{t("settings.profileDetailsSaveError")}</p>}
      {state === "phoneError" && <p className="profile-details__note" role="alert">{t("settings.profileDetailsPhoneError")}</p>}
      <p className="profile-details__note">
        {savedValue.detailsVisibility === "admins" || savedValue.phoneVisibility === "admins"
          ? t("settings.profileDetailsShared")
          : t("settings.profileDetailsDefault")}
      </p>
    </form>
  );
}

// REQ-UG-WHO-RUNS-THIS-CHAPTER-AND-ONE-WORD-FOR-STAFF-20261006. One
// screen naming the chapter's officers, President and administrators, and the
// one place the app defines "staff" and "staff hat". Name, title and role only.
// REQ-UG-MEMBER-OFFICER-MESSAGING-AND-VISIBILITY-20261030: each
// person the server says the member may write to has a Message button, and an
// email or phone appears only when that officer shared it with members.
function ChapterLeadershipCard({ api, uid, t, onMessage = null, viewerIsAdmin = false, adminHatWorn = false }) {
  const [state, setState] = useState({ phase: "loading", people: [], chapterId: null });
  const [reads, setReads] = useState(0);
  const [granting, setGranting] = useState(null);
  // Record 8435: every grant shares one busy state, so they share one lock. It
  // ends where granting does, so a grant that throws at once leaves a ready
  // button that sends.
  const grantWriteRef = useRef(new Set());
  const [grantNote, setGrantNote] = useState(null);

  useEffect(() => {
    let live = true;
    Promise.resolve().then(() => api.load())
      .then((loaded) => { if (live) setState({ phase: "ready", people: loaded?.people ?? [], chapterId: loaded?.chapterId ?? null }); })
      .catch(() => { if (live) setState({ phase: "error", people: [], chapterId: null }); });
    return () => { live = false; };
  }, [api, reads]);

  // REQ-UG-SCOPED-ROLES-AND-OFFICER-ACCESS-20261030 (, finding
  // 69): someone titled President without President access sees who can give
  // it, and a chapter administrator can give it from here.
  // The viewer's own roles count as well as their row: the roster is capped,
  // and an administrator ranked past the cap still administers (
  // r1s2 on). set_member_chapter_role checks the authority either way.
  // Giving access is a chapter-administration action, so it is offered only
  // under the explicitly worn Admin hat, the rule the desk rail follows
  // (AGENTS.md; Codex review on). Under Member or another hat the
  // roster stays readable and the action is not shown.
  const me = state.people.find((person) => person.id === api.selfId) ?? null;
  const viewerAdministers = adminHatWorn && (viewerIsAdmin || Boolean(me?.administrator || me?.organizationAdministrator));
  const chapterAdministrators = state.people.filter((person) => person.id !== api.selfId && person.administrator);
  const roleLabel = (role) => t(role === "president" ? "settings.leadershipPresident" : "settings.leadershipAdministrator");

  function grantPresident(person) {
    return runBusyWrite(grantWriteRef, "grant-president", (unlock) => grantPresidentNow(person, unlock));
  }

  async function grantPresidentNow(person, unlock) {
    if (granting || !state.chapterId || typeof api.grantPresident !== "function") { unlock(); return; }
    setGranting(person.id);
    setGrantNote(null);
    try {
      await api.grantPresident(person.id, state.chapterId);
      setGrantNote({ ok: true, text: t("settings.leadershipGranted", { name: person.name }) });
      setReads((count) => count + 1);
    } catch {
      setGrantNote({ ok: false, text: t("settings.leadershipGrantFailed") });
    } finally {
      setGranting(null);
      unlock();
    }
  }

  function accessPath(person) {
    const role = titleOnlyRole(person);
    if (!role) return null;
    if (person.id === api.selfId) {
      return <p className="chapter-leadership__access">{chapterAdministrators.length
        ? t("settings.leadershipTitleOnlySelf", { title: person.title, role: roleLabel(role), names: chapterAdministrators.map((admin) => admin.name).join(", ") })
        : t("settings.leadershipTitleOnlySelfNoAdmin", { title: person.title, role: roleLabel(role) })}</p>;
    }
    if (role === "president" && viewerAdministers && typeof api.grantPresident === "function") {
      return <BusyButton type="button" className="chapter-leadership__grant" pending={Boolean(granting)} onClick={() => grantPresident(person)}>
        {t("settings.leadershipGrantPresident", { name: person.name })}
      </BusyButton>;
    }
    return null;
  }

  return (
    <section className="setin-card chapter-leadership" aria-labelledby={`${uid}-leadership-title`}>
      <div className="setin-card__head">
        <h3 id={`${uid}-leadership-title`}>{t("settings.leadershipTitle")}</h3>
        <p>{t("settings.leadershipBody")}</p>
      </div>
      {state.phase === "loading" && <p>{t("settings.leadershipLoading")}</p>}
      {state.phase === "error" && <p role="alert">{t("settings.leadershipError")}</p>}
      {state.phase === "ready" && state.people.length === 0 && <p>{t("settings.leadershipEmpty")}</p>}
      {state.phase === "ready" && state.people.length > 0 && (
        <ul className="chapter-leadership__list">
          {state.people.map((person) => (
            <li key={person.id}>
              <strong>{person.name}</strong>
              <small>{leadershipRoleLine(person, t)}</small>
              {person.contact?.email && <small>{t("officerContact.email")}: <a href={`mailto:${person.contact.email}`}>{person.contact.email}</a></small>}
              {person.contact?.phone && <small>{t("officerContact.phone")}: <a href={`tel:${person.contact.phone}`}>{person.contact.phone}</a></small>}
              {onMessage && person.canMessage && (
                <button type="button" className="dialog-secondary chapter-leadership__message" aria-label={t("officerContact.messageNamed", { name: person.name })} onClick={() => onMessage(person)}>
                  {t("officerContact.message")}
                </button>
              )}
              {accessPath(person)}
            </li>
          ))}
        </ul>
      )}
      {grantNote && <p className="chapter-leadership__note" role={grantNote.ok ? "status" : "alert"}>{grantNote.text}</p>}
      <p className="chapter-leadership__note">{t("settings.leadershipStaffDefinition")}</p>
    </section>
  );
}

const SMS_INACTIVE_KEYS = { error: "settings.smsError", disabled: "settings.smsDisabled" };

// /m/settings?learning=manage is the governed quotes-and-lessons editor for
// every hat: Settings is a shared account view, so staff reach it without
// changing hat and no route guard is widened. Only the editor page mounts
// there; the server decides who may manage anything and refuses the rest.
// learningContent is App's wiring (session, per-session client factory,
// selected organization and chapter, language).
export function SettingsView(props) {
  const { learningContent = null, learningSection = null, onLearningSection = null, alt = false, onOpenHome = null } = props;
  const { t } = useLang();
  if (learningSection === "manage" && learningContent) {
    const manage = <LearningLearnArea {...learningContent} section="manage" returnTo="settings" onSection={onLearningSection} />;
    // Under the alternate shell the editor keeps its own h1 below the
    // prototype's crumb trail (REQ-UG-ALT-PORT-MEMBER-PAGES-20261030).
    if (alt) {
      return (
        <div className="ug-alt-help">
          <section className="ug-page-hero ug-alt-help-hero"><div className="ug-wrap"><HelpCrumbs onOpenHome={onOpenHome} trail={[{ label: t("altHelpPages.account"), href: "/m/settings", onOpen: () => onLearningSection?.("library") }, { label: t("learningContent.library.manage") }]} /></div></section>
          <div className="ug-wrap ug-legacy">{manage}</div>
        </div>
      );
    }
    return (
      <div className="screen">
        {manage}
      </div>
    );
  }
  return <SettingsHub {...props} />;
}

function SettingsCalendarFeed({ loadStatus, rotate, revoke, stepUpPrompt }) {
  const { t } = useLang();
  const { status, link, busy, retrying, retry, mint, turnOff, nextActionRef } = useCalendarFeed(loadStatus, rotate, revoke);
  const [copied, setCopied] = useState(false);
  const replaceWarningId = useId();
  const active = status === "active";
  const ready = active || status === "inactive";

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // The field stays selectable when the clipboard is unavailable.
    }
  }

  if (status === "refused") return stepUpPrompt;

  return <>
    <p className="setin-note">{t("settings.calendarSub")}</p>
    <p className="setin-note">{t("settings.calendarShareWarning")}</p>
    {loadStatus && <p className={ready ? "visually-hidden" : "setin-note"} role="status">
      {status === "loading" && t("settings.calendarStatusLoading")}
      {status === "error" && t("settings.calendarStatusFailed")}
    </p>}
    {link && (
      <>
        <p className="setin-note">{t("settings.calendarOnceWarning")}</p>
        <div className="setin-linkbox">
          <input value={link} readOnly aria-label={t("settings.calendarHeading")} onFocus={(event) => event.target.select()} />
          <button type="button" className="dialog-primary" onClick={copyLink}>{copied ? t("settings.calendarCopied") : t("rights.copy")}</button>
        </div>
      </>
    )}
    {active && rotate && <p id={replaceWarningId} className="setin-note">{t("settings.calendarReplaceWarning")}</p>}
    <div className="setin-actions">
      {(status === "error" || retrying) && <BusyButton type="button" className="dialog-secondary" pending={retrying} onClick={retry}>{t("settings.calendarStatusRetry")}</BusyButton>}
      {ready && rotate && <BusyButton ref={!active ? nextActionRef : undefined} type="button" className="dialog-primary" pending={busy} aria-describedby={active ? replaceWarningId : undefined} onClick={() => mint(() => setCopied(false))}>{t(active ? "settings.calendarReplaceLink" : "settings.calendarGetLink")}</BusyButton>}
      {active && revoke && <BusyButton ref={nextActionRef} type="button" className="dialog-secondary" pending={busy} onClick={(event) => turnOff(event, () => setCopied(false))}>{t("settings.calendarRevoke")}</BusyButton>}
    </div>
  </>;
}

function SettingsHub({ unitSettingsApi = null, alt = false, onOpenHome = null, keyboardShortcutsOffered = true, announcementContext = null, data, siteView = null, onProfile, onNavigate, canNavigateView = null, memberHatOpensHeldPlanes = false, stewardPresence = null, adminHatWorn = false, onSignOut, signingOut = false, onAddShortcut, lang, onLanguage, onNotificationPrefs, onFocusSettings, push, onPushSubscribe, onPushRefresh, onPushUnsubscribe, onCalendarRotate, onCalendarRevoke, loadCalendarFeedStatus, calendarFeedScope, authClient, onMfaChanged, onLoadSessions, onRevokeSession, onSignOutEverywhere, sessionDemo = false, sharedAccount = false, visitorMessageWorkflow = null, memberPinSurface = true, sessionRestricted = false, stepUpPrompt = null, stewardContactApi = null, onMessageOfficer = null, chapterLeadershipApi = null, seniorityApi = null, profileDetailsApi = null, formAutofillApi = null, learningContent = null, onLearningSection = null, requestsPanel = null, personalReminders = null, navPins = null }) {
  const busyWriteRef = useRef(new Set());
  const pageTitle = useWorkspaceTitle(null);
  const workspace = useWorkspace();
  const { t } = useLang();
  // Every switch is named from OUTSIDE the pill via `${id}-label` / `${id}-sub`
  // ids. Those used to be fixed strings ("push", "dnd", …), so two mounted
  // copies of this view would collide and cross-wire aria-labelledby — scope
  // every id under this instance's useId prefix instead.
  const uid = useId();
  const member = data.member || {};
  const isSteward = (data.roles || []).includes("steward");
  // UX-UG-ADMIN-NOT-TOLD-ONBOARDING-NEEDS-CHECKLIST-20261018: a new
  // organization's creator lands here (?next=setup-review) to turn on two-step
  // sign-in. Once it is on and the admin role is back, offer setup next.
  const offerSetupNext = typeof window !== "undefined"
    && new URLSearchParams(window.location.search).get("next") === SETUP_REVIEW_NEXT
    && (data.roles || []).includes("admin")
    && data.staffMfa?.enrolled === true && data.staffMfa?.blocked !== true;
  const demoAnalyticsEnabled = useSyncExternalStore(subscribeDemoAnalytics, () => isDemoAnalyticsEnabled());
  const [demoAnalyticsUnsaved, setDemoAnalyticsUnsaved] = useState(false);
  const keyboardShortcutsOn = useKeyboardShortcutsEnabled();
  const keyboardShortcutsAvailable = useKeyboardShortcutsAvailable();
  const [keyboardShortcutsUnsaved, setKeyboardShortcutsUnsaved] = useState(false);
  //  (Sol on 6031d693): a member who turned shortcuts on elsewhere must
  // still reach the switch to turn them off. Once it has been shown on this
  // visit it stays, so turning it off does not pull it out from under them.
  const [keyboardShortcutsShown, setKeyboardShortcutsShown] = useState(keyboardShortcutsOn);
  useEffect(() => { if (keyboardShortcutsOn) setKeyboardShortcutsShown(true); }, [keyboardShortcutsOn]);
  // Optimistic topic toggles: flip locally first, then persist; revert if the
  // write fails so the switch never lies about what the server holds.
  const [prefs, setPrefs] = useDeviceParityState("settings.notificationPrefs", () => ({
    ...DEFAULT_TOPIC_PREFS,
    ...(member.notificationPrefs || {}),
    // An unset welcome choice follows announcements, which governed welcome
    // mail before it had its own switch (the database applies the same rule).
    ...(Object.hasOwn(member.notificationPrefs || {}, "welcome")
      ? {}
      : { welcome: member.notificationPrefs?.announcements !== false }),
  }));
  const [prefsBusy, setPrefsBusy] = useState(false);
  const accountWorkflow = useMessageWorkflowPreference(visitorMessageWorkflow ? "" : member.id || "");
  const [messageWorkflow, setMessageWorkflow] = visitorMessageWorkflow ?? accountWorkflow;
  const [pushBusy, setPushBusy] = useState(false);
  const [sms, setSms] = useState(null);
  const [smsPhone, setSmsPhone] = useState("");
  const [smsBusy, setSmsBusy] = useState(false);
  const [smsError, setSmsError] = useState("");
  const [focusBusy, setFocusBusy] = useState(false);
  const [sessions, setSessions] = useState(sessionDemo ? DEMO_SESSIONS : null);
  const [showAllSessions, setShowAllSessions] = useState(false);
  const sortedSessions = [...(sessions || [])].sort((a, b) =>
    (Date.parse(b.lastActiveAt) || 0) - (Date.parse(a.lastActiveAt) || 0));
  const visibleSessions = showAllSessions ? sortedSessions : sortedSessions.slice(0, 10);
  const [sessionsError, setSessionsError] = useState(false);
  const [sessionActionError, setSessionActionError] = useState("");
  const [sessionNotice, setSessionNotice] = useState("");
  const [confirmSession, setConfirmSession] = useState(null);
  const [confirmEverywhere, setConfirmEverywhere] = useState(false);
  const [sessionBusy, setSessionBusy] = useState("");
  const [returnSessionFocus, setReturnSessionFocus] = useState("");
  const [returnEverywhereFocus, setReturnEverywhereFocus] = useState(false);
  const sessionConfirmRef = useRef(null);
  const everywhereConfirmRef = useRef(null);
  const sessionActionRefs = useRef(new Map());
  const everywhereActionRef = useRef(null);
  const sessionNoticeRef = useRef(null);
  const savedTimeZone = member.quietHoursTimezone || "America/New_York";
  const offeredTimeZones = FOCUS_TIME_ZONES.map(([value, labelKey]) => [value, t(labelKey)]);
  // A saved zone outside the ten stays selectable so an existing preference is
  // never silently dropped; it has no catalogue entry, so it keeps its raw
  // IANA id as its label in both languages.
  const focusTimeZones = FOCUS_TIME_ZONES.some(([value]) => value === savedTimeZone)
    ? offeredTimeZones
    : [[savedTimeZone, savedTimeZone], ...offeredTimeZones];

  // Live counts for the hub-row metas: prototype values ("1 EARNED", "3 this
  // month", "1 DRAFT") are seed data — these are the member's real numbers.
  // data.events carries the full chapter archive (past rows included) so the
  // Events screen can show attendance history; this meta counts upcoming only.
  const upcomingEvents = (data.events || []).filter((item) => item.isPast !== true).length;
  const draftForms = (data.forms || []).filter((item) => item.status === "draft").length;

  const roleLine = [
    t("morehub.roleMember"),
    isSteward ? t("morehub.roleSteward") : null,
    member.chapterName || null,
  ].filter(Boolean).join(" · ");

  const go = (view, path) => { if (onNavigate) onNavigate(view, path); };

  // The hub renders the same rows for every hat, but the shell refuses a
  // member-plane route while a staff hat is worn: the tap changed the URL,
  // the guard snapped it back to the plane, and the member got "Your Steward
  // hat cannot open that page" for a control this hub itself offered.
  // `canNavigateView` is the shell's own guard bound to the selected hat
  // (App's explicitHatAllowsView), so the row and the route it would trigger
  // can never disagree — one call decides both whether the row appears and
  // where it goes, and no hat is switched implicitly. No predicate (the
  // member hat, or a mount that does not pass one) offers every row.
  // The way back to Admin is offered where the shell would open it: under the
  // Admin hat, or under Member when the shell's own entrance rule lets a
  // Member-worn account enter a plane it holds the role for (the SaaS origin
  // with roles known; App answers that as memberHatOpensHeldPlanes). SAMPLE
  // hats are separate persona accounts, so there the Member hat gets no link,
  // and another worn staff hat is refused, so no link either.
  const adminSetupPath = adminSetupPathFromSearch(window.location.search);
  //: one rule for every admin-desk link on this page (also the
  // Member tools setup step below): no guard passed, the guard lets the worn
  // hat open the admin path, or the Member hat may enter a plane it holds.
  const adminDeskOpens = (path) => !canNavigateView
    || canNavigateView("admin", path)
    || memberHatOpensHeldPlanes;
  const adminLinkAllowed = adminDeskOpens(adminSetupPath);
  const navTarget = (view, path) => ({
    refused: canNavigateView ? !canNavigateView(view, path) : false,
    onActivate: () => go(view, path),
  });

  // Each write sends the WHOLE prefs object, so two toggles in flight at once
  // race: whichever lands last wins and silently undoes the other. The visible
  // result is a switch showing "off" while the server still has the topic on —
  // i.e. mail the member believes they stopped. One write at a time.
  async function togglePref(key) {
    return prepareBusyWrite(busyWriteRef, "prefsBusy", () => {
      if (prefsBusy) return;
      const previous = prefs;
      const next = { ...prefs, [key]: !prefs[key] };
      return async (releaseBusyWrite) => {
      setPrefs(next);
      setPrefsBusy(true);
      // An engagement email choice is written only when the member flips that
      // switch, so a topic toggle can never re-subscribe someone who used an
      // email's unsubscribe link after this screen loaded.
      const persisted = Object.fromEntries(Object.entries(next)
        .filter(([name]) => !WRITE_WHEN_FLIPPED_KEYS.includes(name) || name === key));
      try {
        await onNotificationPrefs(persisted);
      } catch {
        setPrefs(previous);
      } finally {
        setPrefsBusy(false);

        releaseBusyWrite();
      }
          };
    });
  }

  async function pushAction(action) {
    return prepareBusyWrite(busyWriteRef, "pushBusy", () => {
      if (pushBusy) return;
      return async (releaseBusyWrite) => {
      setPushBusy(true);
      try {
        await action();
      } finally {
        setPushBusy(false);

        releaseBusyWrite();
      }
          };
    });
  }

  const pushAvailable = push && push.supported && !push.denied;

  // The alternate shell's Account figures count this year's actions from the
  // member's own point events when the rewards summary carries no count;
  // null (a dash) until the read lands or when it fails.
  const [actionsThisYear, setActionsThisYear] = useState(null);
  const needsActionCount = alt && Boolean(authClient) && data?.rewards?.actionsYtd == null;
  useEffect(() => {
    if (!needsActionCount) return undefined;
    let active = true;
    countMemberActionsThisYear(authClient).then((count) => { if (active) setActionsThisYear(count); }, () => {});
    return () => { active = false; };
  }, [needsActionCount, authClient]);

  useEffect(() => {
    if (!authClient) {
      setSms(null);
      return undefined;
    }
    let active = true;
    setSmsError("");
    Promise.resolve(authClient.rpc("get_my_sms_preference")).then(({ data: value, error }) => {
      if (!active) return;
      if (error || !value) setSmsError(t("settings.smsUnavailable"));
      else setSms(value);
    }, () => { if (active) setSmsError(t("settings.smsUnavailable")); });
    return () => { active = false; };
  }, [authClient, t]);

  async function saveSms(consented) {
    return prepareBusyWrite(busyWriteRef, "smsBusy", () => {
      if (!authClient || smsBusy) return;
      return async (releaseBusyWrite) => {
      setSmsBusy(true);
      setSmsError("");
      try {
        const { data: value, error } = await authClient.rpc("set_my_sms_consent", {
          p_phone_e164: consented ? smsPhone.trim() : null,
          p_consented: consented,
        });
        if (error || !value) throw error || new Error("sms-unavailable");
        setSms(value);
        if (!consented) setSmsPhone("");
      } catch {
        setSmsError(t("settings.smsSaveFailed"));
      } finally {
        setSmsBusy(false);

        releaseBusyWrite();
      }
          };
    });
  }

  useEffect(() => {
    if (sessionDemo) {
      setSessions(DEMO_SESSIONS);
      setSessionsError(false);
      return undefined;
    }
    if (!onLoadSessions) return undefined;
    let active = true;
    setSessions(null);
    setSessionsError(false);
    Promise.resolve(onLoadSessions()).then(
      (rows) => {
        if (active) setSessions(Array.isArray(rows) ? rows : []);
      },
      () => {
        if (active) {
          setSessions(null);
          setSessionsError(true);
        }
      },
    );
    return () => { active = false; };
  }, [onLoadSessions, sessionDemo]);

  useEffect(() => {
    if (confirmSession) sessionConfirmRef.current?.focus();
  }, [confirmSession]);

  useEffect(() => {
    if (confirmEverywhere) everywhereConfirmRef.current?.focus();
  }, [confirmEverywhere]);

  useEffect(() => {
    if (!returnSessionFocus || confirmSession) return;
    sessionActionRefs.current.get(returnSessionFocus)?.focus();
  }, [confirmSession, returnSessionFocus]);

  useEffect(() => {
    if (!returnEverywhereFocus || confirmEverywhere) return;
    everywhereActionRef.current?.focus();
  }, [confirmEverywhere, returnEverywhereFocus]);

  useEffect(() => {
    if (sessionNotice) sessionNoticeRef.current?.focus();
  }, [sessionNotice]);

  function sessionLabel(session) {
    const device = t(`settings.sessionDevice.${session.deviceLabel || "signed_in_device"}`);
    const browser = t(`settings.sessionBrowser.${session.browserLabel || "browser"}`);
    return `${device} · ${browser}`;
  }

  // App publishes the ordinary sign-out refusal in its notice. Consume that
  // rejection at the hub button; the session confirmation still awaits the
  // original callback so it can show its own inline refusal and retry.
  function signOutFromHub() {
    return Promise.resolve(onSignOut()).catch(() => {});
  }

  async function revokeSelectedSession() {
    return prepareBusyWrite(busyWriteRef, "sessionBusy", () => {
      if (!confirmSession || sessionBusy) return;
      const target = confirmSession;
      return async (releaseBusyWrite) => {
      setSessionBusy(target.handle);
      setSessionActionError("");
      setSessionNotice("");
      try {
        if (!sessionDemo) {
          if (target.current) { await onSignOut(); { releaseBusyWrite(); return; } }
          await onRevokeSession(target.handle);
        }
        setSessions((current) => (current || []).filter((item) => item.handle !== target.handle));
        setConfirmSession(null);
        setSessionNotice(sessionDemo ? t("settings.sessionDemoRevokeSuccess") : t("settings.sessionRevokeSuccess"));
      } catch {
        setSessionActionError(t("settings.sessionRevokeFailed"));
      } finally {
        setSessionBusy("");

        releaseBusyWrite();
      }
          };
    });
  }

  async function signOutAllSessions() {
    return prepareBusyWrite(busyWriteRef, "sessionBusy", () => {
      if (sessionBusy) return;
      return async (releaseBusyWrite) => {
      setSessionBusy("global");
      setSessionActionError("");
      setSessionNotice("");
      try {
        if (sessionDemo) {
          setSessions([]);
          setConfirmEverywhere(false);
          setSessionNotice(t("settings.sessionDemoGlobalSuccess"));
        } else {
          await onSignOutEverywhere();
        }
      } catch {
        setSessionActionError(t("settings.sessionGlobalFailed"));
      } finally {
        setSessionBusy("");

        releaseBusyWrite();
      }
          };
    });
  }

  // Each settings block once, so the classic hub below and the alternate
  // shell's Account and Alerts pages (REQ-UG-ALT-PORT-MEMBER-PAGES-20261030)
  // draw the same controls on the same state and handlers.
  const togglePush = () => pushAction(push.subscribed ? onPushUnsubscribe : onPushSubscribe);
  const toggleDnd = async () => {
    return runBusyWrite(busyWriteRef, "focusBusy", async (releaseBusyWrite) => {
      setFocusBusy(true);
      try { await onFocusSettings({ dndEnabled: !member.dndEnabled }); } catch { /* parent already reports the save failure */ } finally { setFocusBusy(false);
        releaseBusyWrite();
      }
    });
  };
  const quietStart = formatQuietTime(member.quietHoursStart, t);
  const quietEnd = formatQuietTime(member.quietHoursEnd, t);
  const smsConsented = sms?.activationStatus === "active" && sms?.consented;
  const smsStatus = sms?.activationStatus === "active"
    ? sms?.consented
      ? t("settings.smsConsented", { last4: sms.phoneLast4 || "••••" })
      : t("settings.smsActiveOff")
    // The RPC's publicMessage is English-only free text; the
    // non-active states read from the catalogue instead.
    : t(SMS_INACTIVE_KEYS[sms?.activationStatus] || "settings.smsInactive");

  const setupNextCard = offerSetupNext ? (
    <section className="setin-card" aria-labelledby={`${uid}-setup-next-title`}>
      <div className="setin-card__head">
        <h3 id={`${uid}-setup-next-title`}>{t("settings.setupNext.title")}</h3>
        <p>{t("settings.setupNext.body")}</p>
      </div>
      <a className="morehub-card-btn" href={SETUP_REVIEW_PATH} onClick={(event) => {
        if (!onNavigate || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onNavigate("admin", SETUP_REVIEW_PATH);
      }}>{t("settings.setupNext.link")}</a>
    </section>
  ) : null;

  const profileCard = (
    <section className="morehub-profile">
      <span className="morehub-profile__avatar" aria-hidden="true">{member.initials}</span>
      <span className="morehub-profile__text">
        <strong>{member.fullName || member.initials}</strong>
        <small>{roleLine}</small>
      </span>
      <button type="button" className="morehub-card-btn" onClick={onProfile}>{t("morehub.card")}</button>
    </section>
  );

  // A PIN-restricted session cannot read or write these; the server
  // refuses it, so the card is not offered until full sign-in.
  const profileDetails = profileDetailsApi && !sessionRestricted ? <ProfileDetailsCard api={profileDetailsApi} uid={uid} t={t} /> : null;
  // REQ-UG-FORMS-OFFER-WORKPLACE-AUTOFILL-20261030: how forms use
  // those details, under the same full-session rule.
  const formAutofillSetting = formAutofillApi && !sessionRestricted ? <FormAutofillSetting api={formAutofillApi} uid={uid} t={t} /> : null;

  const visibilityCard = (
    <section className="morehub-visibility" aria-labelledby={`${uid}-visibility-title`}>
      <strong id={`${uid}-visibility-title`}>{t("settings.visibilityTitle")}</strong>
      <p>{t("settings.visibilityBody")}</p>
      {/* The same sentences Messages, Profile and the footer use
          (features/messaging/visibility.js), so no page answers differently. */}
      <ul className="morehub-visibility__list">
        {privacyStatements(t).map((statement) => <li key={statement.key}>{statement.text}</li>)}
      </ul>
    </section>
  );

  // A listed officer may share contact details with members too (the server
  // re-checks that they are on their chapter's leadership list).
  // An officer known only by a display title holds no role; the server's own
  // leadership list (the card below reports it) says whether they are listed.
  // Loaded here, not from the Profile card, so a Privacy page opened directly
  // still offers the editor; keyed by member so another account's answer is
  // never reused.
  const [selfListed, setSelfListed] = useState({ userId: null, listed: false });
  const leadershipEligibilityReadable = Boolean(chapterLeadershipApi && member.chapterName && member.id && !sessionRestricted);
  useEffect(() => {
    if (!leadershipEligibilityReadable) return undefined;
    let live = true;
    const userId = member.id;
    Promise.resolve().then(() => chapterLeadershipApi.load())
      .then((loaded) => { if (live) setSelfListed({ userId, listed: (loaded?.people ?? []).some((person) => person.id === userId) }); })
      .catch(() => { if (live) setSelfListed({ userId, listed: false }); });
    return () => { live = false; };
  }, [chapterLeadershipApi, leadershipEligibilityReadable, member.id]);
  const selfListedLeader = leadershipEligibilityReadable && selfListed.userId === member.id && selfListed.listed;
  // Eligibility is the server's leadership list only: a role name alone is not
  // enough (an organization-wide President grant is not a chapter Presidency,
  // and set_my_steward_contact_visibility would refuse the save).
  const isChapterLeader = selfListedLeader;
  const stewardContact = (isSteward || isChapterLeader) && stewardContactApi
    ? <StewardContactVisibilityCard api={stewardContactApi} uid={uid} t={t} bodyKey={isChapterLeader ? "settings.contactSharingBody" : "settings.stewardContactBody"} />
    : null;

  //  (D1-19): with no steward named for the reader (stewardPresence),
  // the panel promises no reply and opens no inbox. It says who is missing;
  // an administrator who can open the admin desk (adminDeskOpens, the rule of
  // the page's other admin link) gets the setup step that
  // names one (chapters first when the reader has none), anyone else who can
  // name one. Named, paused and unknown keep the panel as it was.
  const noStewardCta = noStewardCopy(stewardPresence);
  const nameStewardPath = stewardPresence === STEWARD_PRESENCE.noChapter ? SETUP_REVIEW_PATH : STEWARD_ACCESS_PATH;
  const offerNameSteward = Boolean(noStewardCta) && (data.roles || []).includes("admin") && adminDeskOpens(nameStewardPath);
  // Deep-green steward CTA panel.
  const ctaCard = noStewardCta ? (
    <section className="morehub-cta" data-no-steward={stewardPresence}>
      <strong>{t(noStewardCta.title)}</strong>
      <p>{offerNameSteward ? t("morehub.ctaNoStewardAdmin") : t(noStewardCta.who)}</p>
      {offerNameSteward ? (
        <button type="button" onClick={() => go("admin", nameStewardPath)}>
          {t(stewardPresence === STEWARD_PRESENCE.noChapter ? "morehub.ctaSetupChapters" : "morehub.ctaNameSteward")}
        </button>
      ) : null}
    </section>
  ) : (
    <section className="morehub-cta">
      <strong>{t("morehub.ctaTitle")}</strong>
      <p>{t("morehub.ctaBody")}</p>
      <button type="button" onClick={() => go("messages", "/m/messages")}><MessageCircle size={18} aria-hidden="true" /> {t("morehub.ctaButton")}</button>
    </section>
  );

  const unionRows = (
    <section className="morehub-list">
      {/* Contributions carry no points total in Union Ground, so the row
          has no badge; "rewards.title" is the "Contributions" label. */}
      <HubRow icon={Gift} label={t("rewards.title")} {...navTarget("rewards", "/m/rewards")} />
      <HubRow icon={CalendarDays} label={t("morehub.appointments")} {...navTarget("appointments", "/m/appointments")} />
      {/* No contract row: a campaign that is still forming a union has no
          contract to read, and contract articles are left out of Union
          Ground until a first contract exists. */}
      <HubRow icon={Scale} label={t("morehub.rights")} meta={t("morehub.rightsMeta")} {...navTarget("rights", "/m/rights")} />
      <HubRow icon={CalendarDays} label={t("morehub.events")} meta={upcomingEvents > 0 ? t("morehub.eventsMeta", { count: upcomingEvents }) : null} {...navTarget("events", "/m/events")} />
    </section>
  );

  const doRows = (
    <section className="morehub-list">
      {/* Be heard is its own screen as of Wave 2c; the chapter commons keeps
          a row of its own right below so /m/organize stays one tap away. */}
      <HubRow icon={Megaphone} label={t("morehub.beHeard")} meta={t("morehub.beHeardMeta")} {...navTarget("voice", "/m/voice")} />
      <HubRow icon={FolderKanban} label={t("morehub.organize")} meta={t("morehub.organizeMeta")} {...navTarget("hub", "/m/organize")} />
      <HubRow icon={FilePenLine} label={t("morehub.forms")} badge={draftForms > 0 ? t("morehub.formsMeta", { count: draftForms }) : null} badgeTone="gold" {...navTarget("forms", "/m/forms")} />
      {/* No meta line: the catalogue's workload meta advertises a point award,
          and Union Ground has no points economy. */}
      <HubRow icon={Timer} label={t("morehub.workload")} {...navTarget("workload", "/m/workload")} />
      <HubRow icon={ChartNoAxesColumnIncreasing} label={t("morehub.reports")} meta={t("morehub.reportsMeta")} {...navTarget("numbers", "/m/numbers")} />
      {/* Live-only rows (recorded deviations): the six-tab prototype bar has
          no Search, and the steward tab set has no Voice — these are the
          phone's member-reachable paths to /m/search and /m/voting. */}
      <HubRow icon={Search} label={t("morehub.search")} meta={t("morehub.searchMeta")} {...navTarget("search", "/m/search")} />
      <HubRow icon={Vote} label={t("morehub.voice")} meta={t("morehub.voiceMeta")} {...navTarget("voting", "/m/voting")} />
    </section>
  );

  // Only a caller the server reports as a manager or platform owner sees
  // this row; the gate reads the policy once and never reads content.
  const learningManage = learningContent && onLearningSection ? (
    <LearningManageGate {...learningContent}>
      <section className="morehub-list" aria-label={t("learningContent.library.manage")}>
        <HubRow icon={PenLine} label={t("learningContent.library.manage")}
          meta={t(learningContent.memberHat ? "learningContent.library.manageStaffSub" : "learningContent.library.manageSub")}
          onActivate={() => onLearningSection("manage")} />
      </section>
    </LearningManageGate>
  ) : null;

  const messageWorkflowCard = (
    <section className="setin-card" aria-labelledby={`${uid}-message-workflow-title`}>
      <WorkspaceSection name="settings-messages"><div className="setin-card__head">
        <WorkspaceCardTitle outline as="h3" id={`${uid}-message-workflow-title`}>{t("inbox.workflow.settingsTitle")}</WorkspaceCardTitle>
        <p>{t("inbox.workflow.settingsBody")}</p>
      </div></WorkspaceSection>
      <PracticeHistorySettingsEntry />
      <PlatformAnnouncementSettings context={announcementContext} locale={lang} />
      <MessageWorkflowPicker value={messageWorkflow} onChange={setMessageWorkflow} compact legendId={`${uid}-message-workflow-title`} />
    </section>
  );

  // REQ-UG-USAGE-BASED-NAVIGATION-20261001: reset the device-only ranking.
  const navUsageCard = <NavUsageSettingsCard data={data} persist={navPins?.persist ?? (!sessionDemo && memberPinSurface)} pinsOffered={navPins?.offered ?? false} />;

  const pushRows = push ? (
    pushAvailable ? (
      <><ToggleRow
        icon={Bell}
        id={`${uid}-push`}
        label={t("morehub.push")}
        sub={t("settings.pushSub")}
        checked={Boolean(push.subscribed)}
        pending={pushBusy}
        busy={pushBusy}
        onToggle={togglePush}
      />
      {push.subscribed && onPushRefresh ? (
        <div className="setin-row">
          <div className="setin-row__text">
            <small id={`${uid}-push-refresh-help`}>{t("settings.pushRefreshSub")}</small>
            <BusyButton type="button" className="dialog-secondary" aria-describedby={`${uid}-push-refresh-help`} pending={pushBusy} aria-busy={pushBusy} onClick={() => pushAction(onPushRefresh)}>{t("settings.pushRefresh")}</BusyButton>
          </div>
        </div>
      ) : null}</>
    ) : (
      <div className="setin-row setin-row--toggle">
        <span className="setin-row__icon" aria-hidden="true"><Bell size={18} /></span>
        <span className="setin-row__text">
          <strong>{t("morehub.push")}</strong>
          <small>{push.denied ? t("settings.pushBlocked") : t("settings.pushUnsupported")}</small>
        </span>
      </div>
    )
  ) : null;

  const smsForm = authClient && sms?.activationStatus === "active" && !sms?.consented ? (
    <form className="setin-quiet" onSubmit={(event) => { event.preventDefault(); saveSms(true); }}>
      <label className="setin-quiet-wide">{t("settings.smsPhone")}<input type="tel" inputMode="tel" autoComplete="tel" placeholder="+15085550123" maxLength={16} pattern="\+[1-9][0-9]{7,14}" required value={smsPhone} onChange={(event) => setSmsPhone(event.target.value)} /></label>
      <p className="setin-note">{t("settings.smsConsentHelp")}</p>
      <BusyButton type="submit" className="dialog-primary" pending={smsBusy}>{smsBusy ? t("auth.working") : t("settings.smsTurnOn")}</BusyButton>
    </form>
  ) : null;
  const smsErrorLine = smsError ? <p className="setin-note auth-message--error" role="alert">{smsError}</p> : null;

  const quietForm = (
    <form className="setin-quiet" onSubmit={async (event) => {
      return prepareBusyWrite(busyWriteRef, "focusBusy", () => {
        event.preventDefault();
        if (focusBusy) return;
        const values = new FormData(event.currentTarget);
      return async (releaseBusyWrite) => {
        setFocusBusy(true);
        try {
          await onFocusSettings({
            quietHoursStart: String(values.get("start") || ""),
            quietHoursEnd: String(values.get("end") || ""),
            quietHoursTimezone: String(values.get("timezone") || "America/New_York"),
            urgentNotificationsEnabled: values.get("urgent") === "on",
          });
        } catch { /* parent already reports the save failure */ } finally { setFocusBusy(false);
        releaseBusyWrite();
      }
            };
    }, event);
    }}>
      <label>{t("settings.quietStart")}<input type="time" name="start" defaultValue={member.quietHoursStart} /></label>
      <label>{t("settings.quietEnd")}<input type="time" name="end" defaultValue={member.quietHoursEnd} /></label>
      <label className="setin-quiet-wide">{t("settings.timezone")}<select name="timezone" defaultValue={savedTimeZone} required>{focusTimeZones.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <label className="setin-quiet-check"><input type="checkbox" name="urgent" defaultChecked={member.urgentNotificationsEnabled} />{t("settings.allowUrgent")}</label>
      <BusyButton type="submit" className="dialog-primary" pending={focusBusy}>{t("settings.saveQuiet")}</BusyButton>
    </form>
  );
  // The prototype's quiet-hours row shows the saved window as a chip; live
  // keeps the editable form beneath it. The chip is real member state only —
  // nothing renders until both times are saved.
  const quietChip = quietStart && quietEnd ? <span className="setin-chip">{quietStart} — {quietEnd}</span> : null;

  // Prototype pg.settings "Notifications" card: card head with the weekly
  // week promise, CHANNELS eyebrow (push + device rows + quiet hours),
  // then the BY TOPIC eyebrow over one pill row per persistable topic.
  const notificationsCard = push || onAddShortcut || onNotificationPrefs || onFocusSettings || authClient ? (
    <section className="setin-card" aria-labelledby={`${uid}-notif-title`}>
      <WorkspaceSection name="settings-notifications"><div className="setin-card__head">
        <WorkspaceCardTitle outline as="h3" id={`${uid}-notif-title`}>{t("setin.notifTitle")}</WorkspaceCardTitle>
        <p>{t("setin.notifSub", { n: featureLimit(data.organizationConfiguration, "limits.notifications.member_weekly_nudges", 5) })}</p>
      </div></WorkspaceSection>
      {push || onAddShortcut || onFocusSettings ? (
        <div className="setin-eyebrow">{t("setin.channels")}</div>
      ) : null}
      {pushRows}
      {authClient ? (
        <div className="setin-row setin-row--toggle">
          <span className="setin-row__icon" aria-hidden="true"><MessageSquare size={18} /></span>
          <span className="setin-row__text">
            <strong>{t("settings.smsTitle")}</strong>
            <small>{smsStatus}</small>
          </span>
          {smsConsented ? (
            <BusyButton type="button" className="dialog-secondary" pending={smsBusy} onClick={() => saveSms(false)}>{t("settings.smsTurnOff")}</BusyButton>
          ) : null}
        </div>
      ) : null}
      {smsForm}
      {smsErrorLine}
      {onAddShortcut ? (
        <button type="button" className="setin-row setin-row--toggle setin-row--nav" onClick={onAddShortcut}>
          <span className="setin-row__icon" aria-hidden="true"><Smartphone size={18} /></span>
          <span className="setin-row__text">
            <strong>{t("morehub.shortcut")}</strong>
            <small>{t("morehub.shortcutSub")}</small>
          </span>
          <span className="setin-row__chev" aria-hidden="true">›</span>
        </button>
      ) : null}
      {onFocusSettings ? (
        <>
          <ToggleRow
            icon={Moon}
            id={`${uid}-dnd`}
            label={t("settings.dnd")}
            sub={t("settings.dndSub")}
            checked={Boolean(member.dndEnabled)}
            pending={focusBusy}
            busy={focusBusy}
            onToggle={toggleDnd}
          />
          <div className="setin-row">
            <span className="setin-row__icon" aria-hidden="true"><Clock3 size={18} /></span>
            <span className="setin-row__text">
              <strong>{t("setin.quietTitle")}</strong>
              <small>{t("setin.quietSub")}</small>
            </span>
            {quietChip}
          </div>
          {quietForm}
        </>
      ) : null}
      {onNotificationPrefs ? (
        <>
          {/* Live granularity beyond the prototype's single notifications
              pill, arranged under the desktop prototype's BY TOPIC
              grouping pattern. */}
          <div className="setin-eyebrow">{t("morehub.byTopic")}</div>
          {[...NOTIFICATION_TOPICS, ...REMINDER_CHOICES].map((topic) => (
            <ToggleRow
              key={topic.key}
              icon={topic.icon}
              id={`${uid}-topic-${topic.key}`}
              label={t(topic.labelKey)}
              sub={topic.subKey ? t(topic.subKey) : null}
              checked={Boolean(prefs[topic.key])}
              pending={prefsBusy}
              busy={prefsBusy}
              onToggle={() => togglePref(topic.key)}
            />
          ))}
          <div className="setin-eyebrow">{t("settings.unionEmail")}</div>
          {ENGAGEMENT_EMAIL_CHOICES.map((choice) => (
            <ToggleRow
              key={choice.key}
              icon={choice.icon}
              id={`${uid}-email-${choice.key}`}
              label={t(choice.labelKey)}
              sub={t(choice.subKey)}
              checked={Boolean(prefs[choice.key])}
              pending={prefsBusy}
              busy={prefsBusy}
              onToggle={() => togglePref(choice.key)}
            />
          ))}
        </>
      ) : null}
    </section>
  ) : null;

  // Prototype "Language" card. Its four-language radio list is rendered as
  // the one pinned Español pill (only Spanish is fully translated; a radio
  // group of dead languages is fabricated state).
  // REQ-UG-VISIBLE-ANALYTICS-OPT-OUT-20261016: one browser-wide
  // switch governs every product-analytics producer, the workspace page
  // views on any account and PostHog on the public demo.
  const analyticsCard = (
    <section className="setin-card" aria-labelledby={`${uid}-demo-analytics-title`}>
      <WorkspaceSection name="settings-privacy"><div className="setin-card__head">
        <h3 id={`${uid}-demo-analytics-title`}>{t("settings.demoAnalyticsCard")}</h3>
      </div></WorkspaceSection>
      <ToggleRow
        icon={ChartNoAxesColumnIncreasing}
        id={`${uid}-demo-analytics`}
        label={t("settings.demoAnalyticsTitle")}
        sub={t("settings.demoAnalyticsSub")}
        checked={demoAnalyticsEnabled}
        onToggle={() => {
          const next = !demoAnalyticsEnabled;
          setDemoAnalyticsEnabled(next, { onSaved: (saved) => setDemoAnalyticsUnsaved(!saved) });
        }}
      />
      {demoAnalyticsUnsaved ? <p className="setin-body-sub" role="status">{t("settings.demoAnalyticsUnsaved")}</p> : null}
    </section>
  );

  // REQ-UG-KEYBOARD-SHORTCUTS-OFF-BY-DEFAULT-20261103: the member's
  // one Keyboard shortcuts switch, off until they turn it on. It needs a
  // member (or the fixture demo's session) to hold the choice.
  //  (site audit B-39): a phone has no keyboard to set shortcuts for, so
  // the phone shell offers the card only while the switch is on (or was on
  // earlier in this visit), never to someone who has not turned them on.
  const keyboardShortcutsCard = keyboardShortcutsAvailable && (keyboardShortcutsOffered || keyboardShortcutsOn || keyboardShortcutsShown) ? (
    <section className="setin-card" aria-labelledby={`${uid}-keyboard-shortcuts-title`}>
      <div className="setin-card__head">
        <h3 id={`${uid}-keyboard-shortcuts-title`}>{t("settings.keyboardShortcutsCard")}</h3>
      </div>
      <ToggleRow
        icon={Keyboard}
        id={`${uid}-keyboard-shortcuts`}
        label={t("settings.keyboardShortcutsTitle")}
        sub={t("settings.keyboardShortcutsSub")}
        checked={keyboardShortcutsOn}
        onToggle={() => setKeyboardShortcutsUnsaved(!setKeyboardShortcutsEnabled(!keyboardShortcutsOn))}
      />
      {keyboardShortcutsUnsaved ? <p className="setin-body-sub" role="status">{t("settings.keyboardShortcutsUnsaved")}</p> : null}
    </section>
  ) : null;

  // REQ-UG-AB-MEMBER-DEFAULT-ALT-VIEW-20261030: classic view or the new site view.
  const siteViewCard = <SiteViewSettingsCard siteView={siteView} />;

  const languageCard = (
    <section className="setin-card" aria-labelledby={`${uid}-lang-title`}>
      <WorkspaceSection name="settings-language"><WorkspaceCardHead title={t("setin.langTitle")} id={`${uid}-lang-title`}><div className="setin-card__head">
        <h3 id={`${uid}-lang-title`}>{t("setin.langTitle")}</h3>
      </div></WorkspaceCardHead></WorkspaceSection>
      <ToggleRow
        id={`${uid}-lang-es`}
        label={t("morehub.spanish")}
        sub={t("morehub.spanishSub")}
        checked={lang === "es"}
        onToggle={() => onLanguage(lang === "es" ? "en" : "es")}
      />
    </section>
  );

  const noChapterAssigned = data.member && !member.chapterId && !member.chapterMemberships?.length;
  const chapterCard = member.chapterName || noChapterAssigned ? (
    <section className="setin-card">
      <WorkspaceSection name="settings-profile"><div className="setin-card__body">
        {member.chapterName ? (
          <>
            <strong className="setin-body-title">{member.chapterName}</strong>
            <p className="setin-body-sub">{t("settings.chapterSub")}</p>
          </>
        ) : <p className="setin-body-sub">{t("settings.noChapter")}</p>}
      </div></WorkspaceSection>
    </section>
  ) : null;
  // REQ-UG-STEWARD-SENIORITY-LIST-AND-BID-TRACKER-20261030: the
  // member's own seniority entry and bids; the card hides itself when empty.
  const seniorityCard = seniorityApi && !sessionRestricted ? <MySeniorityCard api={seniorityApi} /> : null;
  const leadershipCard = member.chapterName && chapterLeadershipApi && !sessionRestricted
    ? <ChapterLeadershipCard api={chapterLeadershipApi} uid={uid} t={t} onMessage={onMessageOfficer} viewerIsAdmin={(data.roles || []).includes("admin")} adminHatWorn={adminHatWorn} />
    : null;

  // Demo mode has no real auth client, so there is nothing to enrol. A shared
  // SAMPLE demo persona account is every visitor's at once: none of them may
  // set its password, second factor, passkey or PIN
  // (UB-UG-DEMO-STRAIGHT-IN-ENTRY-RESTORED-20261107).
  const securityCard = authClient && !sharedAccount ? (
    <section className="setin-card">
      <WorkspaceSection name="settings-security"><div className="setin-card__body">
        {/* D5-3: password, two-step and passkey settings need a password
            or passkey sign-in; a PIN session sees the step-up instead. */}
        {sessionRestricted ? stepUpPrompt : (
          <>
            <PasswordChangeForm client={authClient} t={t} />
            <MfaSettings
              client={authClient}
              staffMfa={data.staffMfa}
              adminSetupPath={data.roles?.includes("admin") && adminLinkAllowed ? adminSetupPath : null}
              onStandingChanged={onMfaChanged}
              passkeyEnrollmentEnabled={data.organizationConfiguration?.passkeyEnrollmentEnabled !== false}
              recoveryCodeEnrollmentEnabled={data.organizationConfiguration?.recoveryCodeEnrollmentEnabled !== false}
            />
          </>
        )}
        {/* Member-visible switch from get_member_organization_configuration()
            (W1-SETTINGS switches map). The panel's own status read decides
            eligibility across every organization the member belongs to. */}
      </div></WorkspaceSection>
    </section>
  ) : null;

  const calendarBody = sessionRestricted ? stepUpPrompt : <>
    <SettingsCalendarFeed key={calendarFeedScope} loadStatus={loadCalendarFeedStatus} rotate={onCalendarRotate} revoke={onCalendarRevoke} stepUpPrompt={stepUpPrompt} />
    {/* REQ-UG-CALENDAR-REMINDERS-APPOINTMENTS-WORKLOAD-20261030:
        the member's private dates, which the feed above also carries. */}
    {personalReminders && <><h3 className="setin-subhead">{t("personalReminders.calendarTitle")}</h3><p className="setin-note">{t("personalReminders.calendarHelp")}</p>{personalReminders}</>}
  </>;
  const calendarCard = onCalendarRotate ? (
    <section className="setin-card">
      <WorkspaceSection name="settings-calendar"><div className="setin-card__body">
        {calendarBody}
      </div></WorkspaceSection>
    </section>
  ) : null;

  const sessionsCard = onLoadSessions || sessionDemo ? (
    <section className="setin-card" aria-labelledby={`${uid}-sessions-title`}>
      <WorkspaceSection name="settings-sessions"><div className="setin-card__head">
        <WorkspaceCardTitle outline as="h3" id={`${uid}-sessions-title`}>{t("settings.sessionsTitle")}</WorkspaceCardTitle>
        <p>{t("settings.sessionPolicy")}</p>
      </div></WorkspaceSection>
      {sessionRestricted ? stepUpPrompt : <>
      {sessionDemo ? <p className="setin-session-sample"><strong>{t("settings.sessionSampleHeading")}</strong> · {t("settings.sessionSampleNote")}</p> : null}
      {sessionsError ? <p className="setin-session-message" role="alert">{t("settings.sessionsUnavailable")}</p> : null}
      {!sessionsError && sessions === null ? <p className="setin-session-message" role="status">{t("settings.sessionsLoading")}</p> : null}
      {!sessionsError && sessions?.length === 0 ? <p className="setin-session-message">{t("settings.sessionsEmpty")}</p> : null}
      <div id={`${uid}-session-history`}>
      {visibleSessions.map((session) => {
        const label = sessionLabel(session);
        const timestamp = formatEasternTimestamp(session.lastActiveAt, lang);
        const activityText = `${t(session.current ? "settings.sessionCurrent" : "settings.sessionOther")} · ${t("settings.sessionLastActive", { date: timestamp?.text || t("settings.sessionUnknownDate") })}`;
        const open = confirmSession?.handle === session.handle;
        const SessionIcon = sessionDeviceIcon(session);
        return (
          <div className="setin-session" key={session.handle}>
            <div className="setin-row setin-session-row">
              <span className="setin-row__icon" aria-hidden="true"><SessionIcon size={18} /></span>
              <span className="setin-row__text">
                <strong>{label}</strong>
                <small>{timestamp ? <time dateTime={timestamp.dateTime}>{activityText}</time> : activityText}</small>
              </span>
              {session.sample ? <span className="setin-session-badge">{t("settings.sessionSampleBadge")}</span> : null}
              {(sessionDemo || (session.current ? onSignOut : onRevokeSession)) && !open ? (
                <button
                  ref={(node) => {
                    if (node) sessionActionRefs.current.set(session.handle, node);
                    else sessionActionRefs.current.delete(session.handle);
                  }}
                  type="button"
                  className="setin-session-action"
                  aria-label={t("settings.sessionRevokeNamed", { device: label })}
                  onClick={() => {
                    setSessionActionError("");
                    setSessionNotice("");
                    setConfirmEverywhere(false);
                    setConfirmSession(session);
                  }}
                >
                  {t("settings.sessionRevoke")}
                </button>
              ) : null}
            </div>
            {open ? (
              <div className="setin-session-confirm" role="group" aria-label={t("settings.sessionRevokeConfirmGroup", { device: label })}>
                <p>{t("settings.sessionRevokeWarning", { device: label })}</p>
                {sessionActionError ? <p className="setin-session-error" role="alert">{sessionActionError}</p> : null}
                <div className="setin-actions">
                  <BusyButton ref={sessionConfirmRef} type="button" className="dialog-primary" pending={Boolean(sessionBusy)} onClick={revokeSelectedSession}>{t("settings.sessionRevokeConfirm")}</BusyButton>
                  <BusyButton type="button" className="dialog-secondary" pending={Boolean(sessionBusy)} onClick={() => { setReturnSessionFocus(session.handle); setConfirmSession(null); setSessionActionError(""); }}>{t("settings.sessionCancel")}</BusyButton>
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
      </div>
      {sortedSessions.length > 10 && <div className="setin-actions">
        <BusyButton type="button" className="dialog-secondary" aria-expanded={showAllSessions}
          aria-controls={`${uid}-session-history`} pending={Boolean(sessionBusy)}
          onClick={() => { setShowAllSessions(!showAllSessions); setConfirmSession(null); setSessionActionError(""); }}>
          {showAllSessions ? t("settings.sessionsShowRecent") : t("settings.sessionsShowAll", { count: sortedSessions.length })}
        </BusyButton>
      </div>}
      {sessionNotice ? <p ref={sessionNoticeRef} className="setin-session-notice" role="status" tabIndex={-1}>{sessionNotice}</p> : null}
      {(onSignOutEverywhere || sessionDemo) ? (
        <div className="setin-session-global">
          {!confirmEverywhere ? (
            <button ref={everywhereActionRef} type="button" className="dialog-secondary" onClick={() => { setReturnEverywhereFocus(false); setConfirmSession(null); setSessionActionError(""); setSessionNotice(""); setConfirmEverywhere(true); }}>{t("settings.sessionGlobal")}</button>
          ) : (
            <div className="setin-session-confirm" role="group" aria-label={t("settings.sessionGlobalConfirmGroup")}>
              <p>{t("settings.sessionGlobalWarning")}</p>
              {sessionActionError ? <p className="setin-session-error" role="alert">{sessionActionError}</p> : null}
              <div className="setin-actions">
                <BusyButton ref={everywhereConfirmRef} type="button" className="dialog-primary" pending={Boolean(sessionBusy)} onClick={signOutAllSessions}>{t("settings.sessionGlobalConfirm")}</BusyButton>
                <BusyButton type="button" className="dialog-secondary" pending={Boolean(sessionBusy)} onClick={() => { setReturnEverywhereFocus(true); setConfirmEverywhere(false); setSessionActionError(""); }}>{t("settings.sessionCancel")}</BusyButton>
              </div>
            </div>
          )}
        </div>
      ) : null}
      </>}
    </section>
  ) : null;

  const accountRows = (
    <section className="morehub-list">
      <HubRow icon={Globe2} label={t("settings.viewPublic")} meta={t("settings.publicMeta")} href="/" />
      {onSignOut ? (
        <HubRow icon={LogOut} label={signingOut ? t("app.signingOut") : t("morehub.signOut")} busy={signingOut} onActivate={signOutFromHub} />
      ) : null}
    </section>
  );
  const footnote = <p className="morehub-footnote">{t("morehub.footerPrivacy")}</p>;
  const requestsCard = requestsPanel && !sessionRestricted ? requestsPanel : null;

  if (alt) {
    return (
      <AltAccountPage
        topics={NOTIFICATION_TOPICS}
        emailChoices={ENGAGEMENT_EMAIL_CHOICES}
        notifSub={t("setin.notifSub", { n: featureLimit(data.organizationConfiguration, "limits.notifications.member_weekly_nudges", 5) })}
        actionsThisYear={needsActionCount ? actionsThisYear : null}
        {...{ workspace, uid, t, data, member, roleLine, pageTitle, onOpenHome, onProfile, onSignOut: onSignOut ? signOutFromHub : null, signingOut, go, navTarget, prefs, prefsBusy, togglePref, push, pushAvailable, pushBusy, togglePush, pushAction, onPushRefresh, authClient, smsConsented, smsStatus, smsBusy, saveSms, smsForm, smsErrorLine, onFocusSettings, focusBusy, toggleDnd, quietForm, quietChip, onAddShortcut, onCalendarRotate, calendarBody, onNotificationPrefs }}
        blocks={{ setupNextCard, profileDetails, visibilityCard, stewardContact, ctaCard, unionRows, doRows, learningManage, messageWorkflowCard, navUsageCard, notificationsCard, analyticsCard, siteViewCard, keyboardShortcutsCard, languageCard, chapterCard, leadershipCard: leadershipCard || seniorityCard ? <>{leadershipCard}{seniorityCard}</> : null, requestsCard, securityCard, calendarCard, sessionsCard, accountRows, footnote }}
      />
    );
  }

  return (
    <div className="screen morehub">
      <h1 className="morehub-title">{pageTitle || t("nav.settings")}</h1>
      <WorkspaceOverview />

      {setupNextCard ? <WorkspaceSection name="overview">{setupNextCard}</WorkspaceSection> : null}

      {/* Profile card — avatar, name, role · chapter, and the member Card. */}
      <WorkspaceSection name={["overview","settings-profile"]}>{profileCard}</WorkspaceSection>

      {profileDetails ? <WorkspaceSection name="settings-profile">{profileDetails}{formAutofillSetting}</WorkspaceSection> : null}

      {/* REQ-UG-INVITATION-SUGGESTIONS-AND-ACCESS-REQUESTS-20261030 */}
      {requestsCard ? <WorkspaceSection name="settings-requests">{requestsCard}</WorkspaceSection> : null}

      <WorkspaceSection name="settings-privacy">{visibilityCard}</WorkspaceSection>

      {stewardContact ? <WorkspaceSection name="settings-privacy">{stewardContact}</WorkspaceSection> : null}

      <WorkspaceSection name="settings-shortcuts">{ctaCard}</WorkspaceSection>

      <WorkspaceSection name="settings-shortcuts"><h2 className="morehub-eyebrow">{t("morehub.union")}</h2></WorkspaceSection>
      <WorkspaceSection name="settings-shortcuts">{unionRows}</WorkspaceSection>

      <WorkspaceSection name="settings-shortcuts"><h2 className="morehub-eyebrow">{t("morehub.doSomething")}</h2></WorkspaceSection>
      <WorkspaceSection name="settings-shortcuts">{doRows}</WorkspaceSection>

      <WorkspaceSection name="overview"><h2 className="morehub-eyebrow">{t("morehub.settings")}</h2></WorkspaceSection>

      {learningManage ? <WorkspaceSection name="overview">{learningManage}</WorkspaceSection> : null}

      <WorkspaceSection name="settings-messages">{messageWorkflowCard}</WorkspaceSection>

      <WorkspaceSection name="settings-appearance">{navUsageCard}</WorkspaceSection>

      {notificationsCard ? <WorkspaceSection name="settings-notifications">{notificationsCard}</WorkspaceSection> : null}

      <WorkspaceSection name="settings-privacy">{analyticsCard}</WorkspaceSection>

      {/* The Language card leads its page with an h2, followed by the site
          view card's h3 (#9525, ledger 815). */}
      <WorkspaceSection name="settings-language">{languageCard}</WorkspaceSection>

      <WorkspaceSection name={["overview", "settings-language"]}>{siteViewCard}</WorkspaceSection>

      {keyboardShortcutsCard ? <WorkspaceSection name="overview">{keyboardShortcutsCard}</WorkspaceSection> : null}

      {chapterCard ? (
        <>
          <WorkspaceSection name="settings-profile"><h2 className="morehub-eyebrow">{t("morehub.yourChapter")}</h2></WorkspaceSection>
          <WorkspaceSection name="settings-profile">{chapterCard}</WorkspaceSection>
          {member.chapterName && (leadershipCard || seniorityCard) ? (
            <WorkspaceSection name="settings-profile">{leadershipCard}{seniorityCard}</WorkspaceSection>
          ) : null}
        </>
      ) : null}

      {securityCard ? (
        <>
          <WorkspaceSection name="settings-security"><WorkspaceCardTitle outline className="morehub-eyebrow">{t("morehub.security")}</WorkspaceCardTitle></WorkspaceSection>
          <WorkspaceSection name="settings-security">{securityCard}</WorkspaceSection>
        </>
      ) : null}

      {calendarCard ? (
        <>
          <WorkspaceSection name="settings-calendar"><WorkspaceCardTitle outline className="morehub-eyebrow">{t("settings.calendarHeading")}</WorkspaceCardTitle></WorkspaceSection>
          <WorkspaceSection name="settings-calendar">{calendarCard}</WorkspaceSection>
        </>
      ) : null}

      {sessionsCard ? (
        <>
          <WorkspaceSection name="settings-sessions"><h2 className="morehub-eyebrow">{t("settings.sessionsEyebrow")}</h2></WorkspaceSection>
          <WorkspaceSection name="settings-sessions">{sessionsCard}</WorkspaceSection>
        </>
      ) : null}

      {unitSettingsApi && <WorkspaceSection name="settings-profile"><UnitSettingsPanel api={unitSettingsApi} chapterId={data.member?.chapterId} memberScope scopeKey={`${data.member?.id}:${data.member?.chapterId}:${data.member?.organizationId}`} /></WorkspaceSection>}
      <WorkspaceSection name={["overview","settings-profile"]}><h2 className="morehub-eyebrow">{t("morehub.account")}</h2></WorkspaceSection>
      <WorkspaceSection name={["overview","settings-profile"]}>{accountRows}</WorkspaceSection>

      {footnote}
    </div>
  );
}

const REAUTH_ERROR_CODES = new Set(["reauthentication_needed", "reauthentication_not_valid"]);
const CURRENT_PASSWORD_ERROR_CODES = new Set(["current_password_required", "current_password_invalid", "current_password_mismatch"]);

export function PasswordChangeForm({ client, t }) {
  const busyWriteRef = useRef(new Set());
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState(null);
  const requestState = useRef("idle");
  const ruleId = useId();
  const locked = outcome?.kind === "success";

  async function submit(event) {
    return prepareBusyWrite(busyWriteRef, "busy", () => {
      event.preventDefault();
      // State updates are batched: a second submit in the same render must not
      // start another change whose late failure could replace a success.
      if (requestState.current !== "idle") return;
      const formElement = event.currentTarget;
      const form = new FormData(formElement);
      const password = String(form.get("password") || "");
      const confirm = String(form.get("confirm") || "");
      if (password.length < NEW_PASSWORD_MIN) {
        setOutcome({ kind: "error", key: "auth.passwordRule" });
        return;
      }
      if (password !== confirm) {
        setOutcome({ kind: "error", key: "auth.passwordMismatch" });
        return;
      }
      const currentPassword = String(form.get("currentPassword") || "");
      if (!currentPassword) {
        setOutcome({ kind: "error", key: "auth.passwordCurrentRequired" });
        return;
      }
      return async (releaseBusyWrite) => {
      requestState.current = "busy";
      setBusy(true);
      setOutcome(null);
      try {
        // Auth validates this proof on the existing session, preserving staff
        // AAL2. The hosted current-password control must also be enabled; the
        // separate secure_password_change flag allows a 24-hour recent session.
        const { error } = await client.auth.updateUser({ password, current_password: currentPassword });
        if (error) throw error;
        // Its own call, after the password is safe: writing user_metadata fires
        // the case-graph bookkeeping lock, which must never be able to roll the
        // password back. A null value deletes the emailed-password marker the
        // Home card reads (api/_lib/memberInvitations.js PASSWORD_ISSUED_KEY); a
        // failure only leaves the prompt up until the next change.
        try { await client.auth.updateUser({ data: { union_ground_password_issued_at: null } }); } catch { /* prompt stays */ }
        formElement.reset();
        requestState.current = "success";
        setOutcome({ kind: "success", key: "auth.passwordChanged" });
      } catch (error) {
        // secure_password_change refuses a session without a recent sign-in no
        // matter how often it retries; every other failure (a dropped
        // connection, a lost response) may not even have failed, so it gets
        // the neutral line instead of the sign-out remedy.
        requestState.current = "idle";
        setOutcome({ kind: "error", key: CURRENT_PASSWORD_ERROR_CODES.has(error?.code) ? "auth.passwordCurrentFailed"
          : REAUTH_ERROR_CODES.has(error?.code) ? "auth.passwordChangeReauth" : "auth.passwordChangeFailed" });
      } finally {
        formElement.elements.namedItem("currentPassword").value = "";
        setBusy(false);

        releaseBusyWrite();
      }
          };
    }, event);
  }

  return (
    <form className="stack-form setin-password-form" onSubmit={submit}>
      <strong className="setin-body-title">{t("auth.passwordChange")}</strong>
      <p className="auth-rule" id={ruleId}><strong>{t("auth.passwordMinimum")}</strong>{" "}{t("auth.passwordAdvice")}</p>
      <label>{t("auth.passwordCurrent")}<BusyInput name="currentPassword" type="password" autoComplete="current-password" required pending={busy} disabled={locked} /></label>
      <label>{t("auth.passwordNew")}<BusyInput name="password" type="password" autoComplete="new-password" required minLength={NEW_PASSWORD_MIN} aria-describedby={ruleId} pending={busy} disabled={locked} /></label>
      <label>{t("auth.passwordConfirm")}<BusyInput name="confirm" type="password" autoComplete="new-password" required minLength={NEW_PASSWORD_MIN} aria-describedby={ruleId} pending={busy} disabled={locked} /></label>
      <BusyButton type="submit" className="dialog-primary" pending={busy} disabled={locked}>{t("auth.passwordChange")}</BusyButton>
      {outcome ? <div className={`auth-message auth-message--${outcome.kind === "error" ? "error" : "info"}`} role={outcome.kind === "error" ? "alert" : "status"}>
        <p>{t(outcome.key)}</p>
        {outcome.kind === "success" ? <button type="button" className="dialog-secondary" onClick={() => { requestState.current = "idle"; setOutcome(null); }}>{t("auth.passwordOutcomeDismiss")}</button> : null}
      </div> : null}
    </form>
  );
}
