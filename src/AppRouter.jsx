import { Suspense, useEffect, useState } from "react";
import { syncObservabilityContext } from "./lib/deferredObservability.js";
import { usePageMetadata } from "./lib/pageMetadata.js";
import { BrandMark } from "./components/BrandMark.jsx";
import { InvitationAcceptView } from "./views/InvitationAcceptView.jsx";
import { OpenSignupView } from "./views/OpenSignupView.jsx";
import { OpenSignupConfirmView } from "./views/OpenSignupConfirmView.jsx";
import { PasswordResetView } from "./views/PasswordResetView.jsx";
import { EMAIL_AUTH_PATHS } from "./lib/emailedAuthLink.js";
import { PublicInterestStopConfirmView } from "./views/PublicInterestStopConfirmView.jsx";
import { ChunkBoundary, ChunkReady } from "./components/ChunkBoundary.jsx";
import { CrashScreenContent } from "./components/CrashScreen.jsx";
import { appAuthStorageKey, appSupabase as supabase } from "./lib/supabase.js";
import { AUTH_PATHS, normalizeAppPath, unknownAppPath } from "./lib/appRoutes.js";
import { lazyView } from "./lib/lazyView.js";
import { canonicalAutomationPath } from "./features/automation/links.js";
import { languageLoaded, t as translate } from "./lib/i18n.js";
import { bootLanguage } from "./lib/bootLanguage.js";
import { LanguageProvider, useLang } from "./lib/LanguageContext.jsx";
import { LEGAL_CHANGELOG_PATH, LEGAL_INSTRUMENTS } from "./lib/legalInstruments.js";
import { BOOT_LANGUAGE_STANDALONE_PATHS, LANGUAGE_SWITCH_STANDALONE_PATHS, StandaloneLanguageShell } from "./components/StandaloneLanguageShell.jsx";
import { VIEW_SUPPORT_EMAIL, AppLoadingScreen, pathViews, staffToolByPath, useOpenSignupAvailable } from "./MemberShellShared.jsx";
// Union Ground's public front door is the Learn page at "/" (no landing page),
// with Connect beside it; retired legacy addresses explain themselves. These
// are static because they are a signed-out stranger's first paint.
import { LearnView } from "./views/LearnView.jsx";
import { ConnectView } from "./views/ConnectView.jsx";
import { RetiredLegacyView } from "./views/RetiredLegacyView.jsx";

const MemberApp = lazyView(() => import("./App.jsx").then((module) => ({ default: module.MemberApp })));

// BUG-UG-STANDALONE-FALLBACK-LANGUAGE-20261025: a standalone page's
// loading and error fallbacks read the language inside StandaloneLanguageShell,
// so the language bar above them switches their text too.
function StandaloneViewLoading() {
  const { t } = useLang();
  return <AppLoadingScreen label={t("app.loading")} />;
}

function StandaloneViewFailure({ kind }) {
  const { t } = useLang();
  return (
    <main className="loading-screen" role="alert">
      <span className="loading-screen__brand" aria-hidden="true"><BrandMark size={48} /></span>
      <p>{t(kind === "chunk" ? "app.viewLoadFailedTitle" : "app.viewCrashTitle")}</p>
      {kind === "chunk" || !VIEW_SUPPORT_EMAIL ? null : <p>{t("app.viewCrashSupport")} <a href={`mailto:${VIEW_SUPPORT_EMAIL}`}>{VIEW_SUPPORT_EMAIL}</a></p>}
      <button className="dialog-primary" type="button" onClick={() => window.location.reload()}>{t("app.tryAgain")}</button>
    </main>
  );
}

function MemberShellFailure({ kind }) {
  return kind === "crash"
    ? <main role="alert" className="loading-screen"><CrashScreenContent /></main>
    : <StandaloneViewFailure kind={kind} />;
}

// The standalone routes stay out of viewLoaders: they render INSTEAD of the
// member shell, so warming them for a signed-in member would download a screen
// that member can never navigate to from inside the app.

const GetAppView = lazyView(() => import("./views/GetAppView.jsx").then((m) => ({ default: m.GetAppView })));

const RequestInviteView = lazyView(() => import("./views/RequestInviteView.jsx").then((m) => ({ default: m.RequestInviteView })));



const VerifyReceiptView = lazyView(() => import("./views/VerifyReceiptView.jsx").then((m) => ({ default: m.VerifyReceiptView })));

const SubprocessorRegisterView = lazyView(() => import("./views/SubprocessorRegisterView.jsx").then((m) => ({ default: m.SubprocessorRegisterView })));

const TelemetryDisclosureView = lazyView(() => import("./views/TelemetryDisclosureView.jsx").then((m) => ({ default: m.TelemetryDisclosureView })));

const PrivacyView = lazyView(() => import("./views/LegalView.jsx").then((m) => ({ default: () => <m.LegalView page="privacy" /> })));

const TermsView = lazyView(() => import("./views/LegalView.jsx").then((m) => ({ default: () => <m.LegalView page="terms" /> })));

const AccessibilityView = lazyView(() => import("./views/LegalView.jsx").then((m) => ({ default: () => <m.LegalView page="accessibility" /> })));

const AccessibilityStatementView = lazyView(() => import("./views/LegalView.jsx").then((m) => ({ default: () => <m.LegalView page="accessibilityStatement" /> })));

const AboutView = lazyView(() => import("./views/AboutView.jsx").then((m) => ({ default: m.AboutView })));







const OperatorView = lazyView(() => import("./views/OperatorView.jsx").then((m) => ({ default: m.OperatorView })));

const ContactView = lazyView(() => import("./views/ContactView.jsx").then((m) => ({ default: m.ContactView })));

const NotFoundView = lazyView(() => import("./views/NotFoundView.jsx").then((m) => ({ default: m.NotFoundView })));

// How long an address that is unknown on the first render waits before the
// not-found page (BUG-UG-NOT-FOUND-FLASH-ON-PAGE-TRANSITIONS-20261103).
export const NOT_FOUND_GRACE_MS = 300;

const AiDisclosureView = lazyView(() => import("./views/LegalView.jsx").then((m) => ({ default: () => <m.LegalView page="aiDisclosure" /> })));

const RetentionView = lazyView(() => import("./views/LegalView.jsx").then((m) => ({ default: () => <m.LegalView page="retention" /> })));

const DeletionRequestView = lazyView(() => import("./views/LegalView.jsx").then((m) => ({ default: () => <m.LegalView page="deletionRequest" /> })));

// D-13 and D-14 (owner, October 10, 2026): one instrument route behind each
// summary, plus the public version history, both built from the shared
// instrument source so a route cannot exist without a version behind it.
const LegalChangelogRoute = lazyView(() => import("./views/LegalView.jsx").then((m) => ({ default: () => <m.LegalChangelogView /> })));

// Union Ground leaves out the public chapter directory and public events
// (/chapters/..., /events/:id) and the public union catalog (/unions,
// /orgs/:slug, /unions/claim/confirm): a campaign that is still forming keeps
// its workers off the public front door. The small signed-out views (invite,
// signup, reset, stop-updates) stay static on purpose: measured, each one's
// own chunk cost more compressed bytes in total than it took off the first load.

const legalInstrumentRoutes = Object.fromEntries(LEGAL_INSTRUMENTS.map((entry) => [
  entry.path,
  lazyView(() => import("./views/LegalView.jsx").then((m) => ({ default: () => <m.LegalInstrumentView instrumentKey={entry.key} /> }))),
]));

function OpenSignupRoute() {
  return <OpenSignupView available={useOpenSignupAvailable()} />;
}

function OpenSignupConfirmRoute() {
  return <OpenSignupConfirmView available={useOpenSignupAvailable()} client={supabase} />;
}

const standaloneViews = {
  // Union Ground's public front door. "/" is the Learn page, not the member
  // shell; signed-in workers enter at /m.
  "/": LearnView,
  "/learn": LearnView,
  "/connect": ConnectView,
  // Retired legacy addresses render an explanation rather than a 404.
  "/contractsurvey": RetiredLegacyView,
  "/design": RetiredLegacyView,
  "/invite": InvitationAcceptView,
  [EMAIL_AUTH_PATHS.invitation]: InvitationAcceptView,
  "/signup": OpenSignupRoute,
  "/signup/confirm": OpenSignupConfirmRoute,
  "/reset-password": PasswordResetView,
  [EMAIL_AUTH_PATHS.passwordReset]: PasswordResetView,
  "/get-app": GetAppView,
  "/request-invite": RequestInviteView,
  "/stop-updates": PublicInterestStopConfirmView,
  "/verify": VerifyReceiptView,
  "/subprocessors": SubprocessorRegisterView,
  "/telemetry": TelemetryDisclosureView,
  "/privacy": PrivacyView,
  "/terms": TermsView,
  "/accessibility": AccessibilityView,
  "/about": AboutView,
  "/contact": ContactView,
  "/operator": OperatorView,
  "/ai-disclosure": AiDisclosureView,
  "/retention": RetentionView,
  "/privacy/deletion-request": DeletionRequestView,
  "/accessibility/statement": AccessibilityStatementView,
  [LEGAL_CHANGELOG_PATH]: LegalChangelogRoute,
  ...legalInstrumentRoutes,
};

// Every address under a retired legacy tree (an old contract-survey link, a
// design-tool export such as /design/<file>.dc.html) explains the retirement
// too; an exact-match lookup alone would hand those deep links to the member
// shell instead.
const RETIRED_LEGACY_PREFIXES = Object.entries(standaloneViews)
  .filter(([, view]) => view === RetiredLegacyView)
  .map(([path]) => `${path}/`);

function standaloneViewFromPath() {
  const path = normalizeAppPath(window.location.pathname);
  if (Object.hasOwn(standaloneViews, path)) return standaloneViews[path];
  return RETIRED_LEGACY_PREFIXES.some((prefix) => path.startsWith(prefix)) ? RetiredLegacyView : null;
}

// Which top-level surface an address renders: one standalone page, the
// not-found page, or the shell. Union Ground's front door ("/") is a
// standalone page, so Back and Forward can cross between a standalone page and
// an earlier shell entry inside one document. App re-renders only when the key
// changes and leaves popstate between shell routes to MemberApp.
function appRouteKey(pathname) {
  const path = normalizeAppPath(pathname);
  if (Object.hasOwn(standaloneViews, path)) return `standalone:${path}`;
  const known = Boolean(pathViews[path] || staffToolByPath[path] || AUTH_PATHS.has(path));
  return known || path === "/" || path === "/demo" ? "shell" : "not-found";
}

// The address the traversal landed on, recorded before any component listener
// runs: MemberApp's own popstate handler may rewrite a signed-out visit's
// /m/... entry to "/" while keeping its sign-in screen, and that rewrite must
// not be read as a Back to the front door. Module scope registers first.
let traversedPathname = null;
if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => { traversedPathname = window.location.pathname; });
}

function useAppRouteKey() {
  const [routeKey, setRouteKey] = useState(() => appRouteKey(window.location.pathname));
  useEffect(() => {
    const sync = () => setRouteKey(appRouteKey(traversedPathname ?? window.location.pathname));
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  return routeKey;
}

export function App() {
  const legacyAutomationPath = canonicalAutomationPath(window.location.pathname, window.location.search, window.location.hash);
  if (legacyAutomationPath) window.history.replaceState(window.history.state, "", legacyAutomationPath);
  // Re-render when Back or Forward crosses between a standalone page (the
  // Learn front door at "/") and the shell; see appRouteKey.
  useAppRouteKey();
  const pathname = window.location.pathname;
  usePageMetadata(pathname);
  const [resumingSignOut, setResumingSignOut] = useState(() => {
    if (normalizeAppPath(window.location.pathname) !== "/") return false;
    try {
      return window.sessionStorage.getItem(`${appAuthStorageKey}.explicit-sign-out-visit`) === "1";
    } catch {
      // swallow-ok: blocked tab storage leaves the public front door available.
      return false;
    }
  });
  useEffect(() => {
    if (!resumingSignOut) return undefined;
    const leaveResumedSignIn = () => setResumingSignOut(false);
    window.addEventListener("popstate", leaveResumedSignIn, { once: true });
    return () => window.removeEventListener("popstate", leaveResumedSignIn);
  }, [resumingSignOut]);
  const Standalone = resumingSignOut && normalizeAppPath(pathname) === "/" ? null : standaloneViewFromPath();
  // main.jsx settled the boot language's catalogue before this first render; if
  // it could not load, the standalone page is English throughout (copy, the
  // document language and every component that picks a locale), never English
  // copy marked as Spanish.
  const bootLang = bootLanguage();
  const standaloneLang = languageLoaded(bootLang) ? bootLang : "en";
  // The emailed and linked standalone pages with no site header carry an
  // English/Español bar (StandaloneLanguageShell); every page with the site
  // header carries the switch inside that header instead (#9539 C-1).
  const standaloneLanguageSwitch = LANGUAGE_SWITCH_STANDALONE_PATHS.includes(normalizeAppPath(pathname));
  const standaloneBootLanguage = BOOT_LANGUAGE_STANDALONE_PATHS.includes(normalizeAppPath(pathname));
  // Standalone routes render instead of the shell, and are reached without a
  // session — so there is no member language to read yet, and the fallback has
  // to fall back to the same boot-language guess the shell uses.
  const normalizedPath = normalizeAppPath(pathname);
  const knownMemberRoute = Boolean(pathViews[normalizedPath] || staffToolByPath[normalizedPath] || AUTH_PATHS.has(normalizedPath));
  const unknownRoute = !Standalone && !knownMemberRoute && normalizedPath !== "/" && normalizedPath !== "/demo";
  // BUG-UG-NOT-FOUND-FLASH-ON-PAGE-TRANSITIONS-20261103: an address
  // that is unknown on the first render waits NOT_FOUND_GRACE_MS on the loading
  // screen, then the address is read again. One that resolved in the meantime
  // (rewritten in place, or moved by Back) opens its page and never paints the
  // not-found page; one still unknown gets it. A known address never starts
  // the timer; public-link navigation and browser history update the route separately.
  const [unknownRouteSettled, setUnknownRouteSettled] = useState(false);
  useEffect(() => {
    if (!unknownRoute || unknownRouteSettled) return undefined;
    const timer = window.setTimeout(() => setUnknownRouteSettled(true), NOT_FOUND_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [unknownRoute, unknownRouteSettled]);
  // An unknown address under /m opens the shell, which shows its own
  // not-found page; only unknown public addresses get the public 404.
  const RoutedView = Standalone || (unknownRoute && !unknownAppPath(normalizedPath) ? NotFoundView : null);
  // Standalone pages render outside MemberApp and read no session, so they set
  // the cookieless public-page context themselves (#6247 round 1).
  const standaloneView = RoutedView ? normalizedPath.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "home" : null;
  useEffect(() => {
    if (standaloneView) syncObservabilityContext({ userId: null, view: standaloneView, authPending: false });
  }, [standaloneView]);
  if (normalizedPath === "/demo") {
    // The fixture demo lives in the ?demo=1 query (Union Ground has no SAMPLE host).
    window.location.replace("/m?demo=1");
    return <LanguageProvider lang={standaloneLang}><AppLoadingScreen label={translate(standaloneLang, "app.loading")} /></LanguageProvider>;
  }
  // Outside the ChunkBoundary on purpose: ChunkReady must not mark this
  // address loaded while only the wait is on screen.
  if (unknownRoute && !unknownRouteSettled) {
    return <LanguageProvider lang={standaloneLang}><AppLoadingScreen label={translate(standaloneLang, "app.loading")} /></LanguageProvider>;
  }
  return RoutedView ? (
    <StandaloneLanguageShell languageSwitch={standaloneLanguageSwitch} loadBootLanguage={standaloneBootLanguage}>
      {/* A standalone chunk that still fails after lazyView's retry gets an
          explicit error with a reload, not the crash screen: a reload fetches
          the current deploy's shell, which is what a rotated chunk needs. */}
      <ChunkBoundary fallback={(_dismiss, kind) => <StandaloneViewFailure kind={kind} />}>
        <Suspense fallback={<StandaloneViewLoading />}>
          <RoutedView />
          <ChunkReady />
        </Suspense>
      </ChunkBoundary>
    </StandaloneLanguageShell>
  ) : (
    <ChunkBoundary fallback={(_dismiss, kind) => <LanguageProvider lang={standaloneLang}><MemberShellFailure kind={kind} /></LanguageProvider>}>
      <Suspense fallback={<LanguageProvider lang={standaloneLang}><AppLoadingScreen label={translate(standaloneLang, "app.loading")} /></LanguageProvider>}>
        <MemberApp />
      </Suspense>
    </ChunkBoundary>
  );
}
