import { lazy, Suspense, useId, useMemo, useRef, useState } from "react";
import { BusyButton } from "../../components/BusyControls.jsx";
import { runBusyWrite } from "../../lib/busyWrite.js";
import { BookOpen, PenLine } from "lucide-react";
import { learningContentCopy } from "../../lib/i18n/learningContent.js";
import { LearningContentBody } from "./LearningContentBody.jsx";
import {
  learningScopeFrom, learningScopeKey, learningScopeReady, learningScopeTenant, learningTransportReady,
  useLearningApi, useLearningLibrary, useLearningPolicy,
} from "./hooks.js";
import "./learningContent.css";

// The editor is only for authorized managers; members never download it.
const LearningManager = lazy(() => import("./LearningManager.jsx").then((module) => ({ default: module.LearningManager })));

// Learn's governed-content area. section "manage" renders the focused editor
// page; anything else renders the published mini-lesson library. Props come
// from App exactly as for the Home card. returnTo names the page the editor's
// back control returns to: "learn" (/m/rights) or "settings" (/m/settings).
export function LearningLearnArea({ client = null, createSessionClient = null, session = null, organizationId = null, chapterId = null, locale = "en", preview = false, api = null, section = null, onSection = null, returnTo = "learn", memberHat = false }) {
  const scope = learningScopeFrom({ session, organizationId, chapterId, locale, preview });
  const transportReady = Boolean(api) || learningTransportReady({ preview, session, createSessionClient, client });
  const backLabel = learningContentCopy(locale)(returnTo === "settings" ? "manage.backSettings" : "manage.back");
  if (!learningScopeReady(scope, transportReady)) {
    return section === "manage" ? <ManageBlocked tr={learningContentCopy(locale)} backLabel={backLabel} onBack={onSection ? () => onSection(null) : null} /> : null;
  }
  return (
    <LearnSession key={learningScopeKey(scope)} scope={scope} transport={{ client, session, createSessionClient, override: api }}
      section={section} onSection={onSection} backLabel={backLabel} memberHat={memberHat} />
  );
}

// For surfaces outside Learn (Settings): renders its children only for a
// caller the server reports as a manager or a platform owner. One policy read,
// no polling and no content read; the editor itself re-checks everything.
export function LearningManageGate({ client = null, createSessionClient = null, session = null, organizationId = null, chapterId = null, locale = "en", preview = false, api = null, children }) {
  const scope = learningScopeFrom({ session, organizationId, chapterId, locale, preview });
  const transportReady = Boolean(api) || learningTransportReady({ preview, session, createSessionClient, client });
  if (!learningScopeReady(scope, transportReady)) return null;
  return <ManageGateSession key={learningScopeKey(scope)} scope={scope} transport={{ client, session, createSessionClient, override: api }}>{children}</ManageGateSession>;
}

function ManageGateSession({ scope, transport, children }) {
  const api = useLearningApi(scope, transport);
  const { policy } = useLearningPolicy(api, scope, { poll: false });
  return policy && (policy.canManage || policy.isPlatformOwner) ? children : null;
}

function ManageBlocked({ tr, backLabel, onBack }) {
  return (
    <section className="lc-manage">
      {onBack ? <button type="button" className="learn-back" onClick={onBack}><span aria-hidden="true">‹</span>{backLabel}</button> : null}
      <h1 className="lc-manage__title">{tr("manage.title")}</h1>
      <p className="lc-notice" role="status">{tr("manage.notAllowed")}</p>
    </section>
  );
}

function LearnSession({ scope, transport, section, onSection, backLabel, memberHat }) {
  const tenant = learningScopeTenant(scope);
  const api = useLearningApi(scope, transport);
  const policyState = useLearningPolicy(api, scope, { poll: tenant });
  const tr = useMemo(() => learningContentCopy(scope.locale), [scope.locale]);
  if (section === "manage") {
    return (
      <Suspense fallback={<p className="lc-status" role="status">{tr("manage.loading")}</p>}>
        <LearningManager api={api} scope={scope} policyState={policyState} backLabel={backLabel} onBack={onSection ? () => onSection(null) : null} />
      </Suspense>
    );
  }
  const onManage = onSection ? () => onSection("manage") : null;
  const manageDescription = tr(memberHat ? "library.manageStaffSub" : "library.manageSub");
  // Without a selected organization and chapter there is no library to read;
  // a provisioned platform owner still gets the way into the platform editor.
  if (!tenant) {
    return policyState.policy?.isPlatformOwner && onManage ? <ManageEntry tr={tr} description={manageDescription} onManage={onManage} /> : null;
  }
  return <LearningLibrary api={api} scope={scope} policyState={policyState} tr={tr} manageDescription={manageDescription} onManage={onManage} />;
}

function ManageEntry({ tr, description, onManage }) {
  return (
    <button type="button" className="learn-row lc-manage-entry" onClick={onManage}>
      <span className="learn-row__icon" aria-hidden="true"><PenLine size={18} /></span>
      <span className="learn-row__copy">
        <span className="learn-row__label">{tr("library.manage")}</span>
        <span className="learn-row__sub">{description}</span>
      </span>
      <span className="learn-row__chev" aria-hidden="true">›</span>
    </button>
  );
}

function LessonDisclosure({ item, tr }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <article className="lc-lesson">
      <h3 className="lc-lesson__heading">
        <button type="button" className="lc-lesson__toggle" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen((value) => !value)}>
          <span className="lc-lesson__icon" aria-hidden="true"><BookOpen size={18} /></span>
          <span className="lc-lesson__title">{item.title}</span>
          <span className="lc-lesson__chev" aria-hidden="true">{open ? "−" : "+"}</span>
        </button>
      </h3>
      {open ? (
        <div className="lc-lesson__panel" id={panelId}>
          <LearningContentBody item={item} tr={tr} expanded showSource showTitle={false} />
        </div>
      ) : (
        <p className="lc-lesson__teaser" id={panelId}>{item.body}</p>
      )}
      {item.topics.length > 0 ? (
        <ul className="lc-topics">{item.topics.map((topic) => <li key={topic}>{topic}</li>)}</ul>
      ) : null}
    </article>
  );
}

function LearningLibrary({ api, scope, policyState, tr, manageDescription, onManage }) {
  const library = useLearningLibrary(api, scope, policyState);
  const titleId = useId();
  const [restore, setRestore] = useState("idle");
  // Record 8435: a synchronous write lock, refused before React commits busy.
  const busyWriteRef = useRef(new Set());
  const policy = library.policy;

  function showOnHome() {
    return runBusyWrite(busyWriteRef, "home", () => showOnHomeNow());
  }

  async function showOnHomeNow() {
    setRestore("working");
    try {
      const hidden = await api.setHomeHidden({ chapterId: scope.chapterId, hidden: false });
      policyState.confirm({ homeHidden: hidden });
      setRestore(hidden ? "failed" : "done");
    } catch {
      setRestore("failed");
    }
  }

  const canManage = Boolean(onManage && (policy?.canManage || policy?.isPlatformOwner || policyState.policy?.canManage));
  // BUG-UG-MINI-LESSONS-OFF-SECTION-IS-A-DEAD-END-THAT-BLAMES-THE-UNION-20261124
  // (record 9839): the policy is platform AND organization AND chapter, so off can
  // come from a switch nobody in the chapter holds. A section a person can
  // never use is not offered; a manager keeps the way into the editor.
  if (library.status === "off" && !canManage) return null;

  return (
    <section className="lc-library" aria-labelledby={titleId}>
      <div className="lc-library__head">
        <h2 className="lc-library__title" id={titleId}>{tr("library.title")}</h2>
        <p className="lc-library__sub">{tr("library.sub")}</p>
        {/* #9533 B-22: with mini-lessons off the page said it was "Showing
            lessons published in English" and, below, that they are off. */}
        {library.status === "off" ? null : <p className="lc-library__sub">{tr("library.language", { language: tr(`locale.${scope.locale}`) })}</p>}
      </div>

      {policy?.homeHidden ? (
        <div className="lc-notice">
          <p>{tr("library.hiddenNotice")}</p>
          <BusyButton type="button" className="lc-button" pending={restore === "working"} onClick={showOnHome}>
            {restore === "working" ? tr("library.restoring") : tr("library.showOnHome")}
          </BusyButton>
        </div>
      ) : null}
      {restore === "done" && !policy?.homeHidden ? <p className="lc-status" role="status">{tr("library.restored")}</p> : null}
      {restore === "failed" ? <p className="lc-error" role="alert">{tr("library.restoreFailed")}</p> : null}

      {library.status === "loading" ? <p className="lc-status" role="status">{tr("library.loading")}</p> : null}
      {library.status === "error" ? (
        <div className="lc-notice" role="alert">
          <p>{tr("library.error")}</p>
          <button type="button" className="lc-button" onClick={library.retry}>{tr("library.retry")}</button>
        </div>
      ) : null}
      {/* REQ-UG-RIGHTS-CONTRACT-AND-LIBRARY-CONTENT-20261030: a
          manager who reaches an off library gets the way into the editor. */}
      {library.status === "off" ? <div className="lc-notice">
        <p className="lc-status">{tr("library.off")}</p>
        <button type="button" className="lc-button" onClick={onManage}>{tr("library.offTurnOn")}</button>
      </div> : null}
      {library.status === "ready" && library.lessons.length === 0 && !library.hasMore ? <p className="lc-status">{tr("library.empty")}</p> : null}

      {library.lessons.length > 0 ? (
        <ul className="lc-lessons">
          {library.lessons.map((item) => <li key={item.id}><LessonDisclosure item={item} tr={tr} /></li>)}
        </ul>
      ) : null}
      {library.hasMore ? (
        <button type="button" className="lc-button lc-button--quiet" disabled={library.loadingMore} onClick={library.loadMore}>{tr("library.loadMore")}</button>
      ) : null}
      {library.moreFailed ? <p className="lc-error" role="alert">{tr("library.loadMoreFailed")}</p> : null}

      {onManage && (policy?.canManage || policy?.isPlatformOwner) ? <ManageEntry tr={tr} description={manageDescription} onManage={onManage} /> : null}
    </section>
  );
}
