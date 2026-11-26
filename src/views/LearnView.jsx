import { ArrowRight, BookOpen, Flag, Handshake, LockKeyhole, Scale, ShieldCheck, Users } from "lucide-react";
import { useState } from "react";
import { LanguageProvider, useLang } from "../lib/LanguageContext.jsx";
import { preferredLanguage } from "../lib/preferredLanguage.js";
import { BrandMark, BrandWordmark } from "../components/BrandMark.jsx";

// The public front door, served at "/" and "/learn".
//
// This is the one surface a worker meets before they have an account, so it
// follows the saved language exactly the way /reset and /verify do — it does
// not get to assume English. Every string here resolves through the `learn.*`
// namespace; nothing is a literal.
const LIFECYCLE_STAGE_KEYS = [
  "learn.stageOrganize",
  "learn.stageRecognize",
  "learn.stageCertify",
  "learn.stageBargain",
  "learn.stageFirstContract",
  "learn.stageEngage",
  "learn.stageGrow",
  "learn.stageCooperate",
];

const SURFACES = [
  { icon: Users, titleKey: "learn.surfaceOrganizingTitle", bodyKey: "learn.surfaceOrganizingBody" },
  { icon: Flag, titleKey: "learn.surfaceCardsTitle", bodyKey: "learn.surfaceCardsBody" },
  { icon: Scale, titleKey: "learn.surfaceResistanceTitle", bodyKey: "learn.surfaceResistanceBody" },
  { icon: Handshake, titleKey: "learn.surfaceHandshakesTitle", bodyKey: "learn.surfaceHandshakesBody" },
];

const RESEARCH = [
  { titleKey: "learn.researchOutcomesTitle", bodyKey: "learn.researchOutcomesBody" },
  { titleKey: "learn.researchEngagementTitle", bodyKey: "learn.researchEngagementBody" },
  { titleKey: "learn.researchCooperationTitle", bodyKey: "learn.researchCooperationBody" },
];

const DEMO_HREF = "/m?demo=1";

export function LearnView({
  // Same default expression ConnectView reads. "Make a private connection" was
  // this page's hero CTA, its closing CTA and its only advertised action —
  // while /connect ships disabled (.env.example VITE_UNIONGROUND_CONNECT_ENABLED=0),
  // so the single thing the public site asked a worker to do dead-ended on
  // "Connection intake is not open yet." The CTAs now read the same flag the
  // destination does, and fall back to the demo rather than to a closed door.
  connectEnabled = import.meta.env.VITE_UNIONGROUND_CONNECT_ENABLED === "1",
} = {}) {
  const [lang, setLang] = useState(preferredLanguage);
  return (
    <LanguageProvider lang={lang}>
      <LearnScreen connectEnabled={connectEnabled} onLanguageChange={setLang} />
    </LanguageProvider>
  );
}

function LearnScreen({ connectEnabled, onLanguageChange }) {
  const { t } = useLang();
  return (
    <div className="public-site">
      <a className="skip-link" href="#main-content">{t("app.skip")}</a>
      <header className="public-header">
        <a className="public-brand" href="/" aria-label={t("learn.brandAria")}><BrandMark size={30} /><span className="public-brand__name"><BrandWordmark /></span></a>
        <nav aria-label={t("learn.navLabel")}>
          <a href="#how">{t("learn.navHow")}</a>
          <a href="#preview">{t("learn.navPreview")}</a>
          <a href="#research">{t("learn.navResearch")}</a>
          <a href="#trust">{t("learn.navTrust")}</a>
          {connectEnabled && <a href="/connect">{t("learn.navConnect")}</a>}
          <button type="button" className="public-lang" onClick={() => {
            const next = t("learn.languageSwitchTo");
            try { window.localStorage.setItem("unionground-lang", next); } catch { /* private mode */ }
            onLanguageChange(next);
          }}>{t("learn.languageSwitch")}</button>
          <a className="public-signin" href="/m">{t("learn.signIn")}</a>
        </nav>
      </header>

      <main id="main-content">
        <section className="public-hero">
          <div className="public-hero__copy">
            <span className="public-kicker">{t("learn.heroKicker")}</span>
            <h1>{t("learn.heroTitleTop")}<br />{t("learn.heroTitleBottom")}</h1>
            <p>{t("learn.heroBody")}</p>
            <div className="public-hero__actions">
              {connectEnabled ? (
                <>
                  <a className="public-primary" href="/connect">{t("learn.ctaPrimary")} <ArrowRight size={18} /></a>
                  <a className="public-secondary" href={DEMO_HREF}>{t("learn.ctaDemo")}</a>
                </>
              ) : (
                <a className="public-primary" href={DEMO_HREF}>{t("learn.ctaDemo")} <ArrowRight size={18} /></a>
              )}
            </div>
          </div>
          <aside className="public-field-card" aria-label={t("learn.privacyLabel")}>
            <span className="public-field-card__mark"><LockKeyhole size={23} /></span>
            <strong>{t("learn.privacyTitle")}</strong>
            <ul>
              <li>{t("learn.privacyNoNames")}</li>
              <li>{t("learn.privacyNoSupport")}</li>
              <li>{t("learn.privacyNoAllegations")}</li>
              <li>{t("learn.privacyNoOrganizing")}</li>
            </ul>
          </aside>
        </section>

        <section className="public-lifecycle" id="how">
          <header><span>{t("learn.lifecycleEyebrow")}</span><h2>{t("learn.lifecycleTitle")}</h2></header>
          <ol>
            {LIFECYCLE_STAGE_KEYS.map((stageKey, index) => (
              <li key={stageKey}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{t(stageKey)}</strong>
                {index < LIFECYCLE_STAGE_KEYS.length - 1 && <ArrowRight size={16} aria-hidden="true" />}
              </li>
            ))}
          </ol>
          <p>{t("learn.lifecycleNote")}</p>
        </section>

        <section className="public-surfaces public-surfaces--four" id="preview">
          {SURFACES.map(({ icon: Icon, titleKey, bodyKey }) => (
            <article key={titleKey}><span><Icon size={21} /></span><h2>{t(titleKey)}</h2><p>{t(bodyKey)}</p></article>
          ))}
        </section>

        <section className="public-research" id="research">
          <div>
            <span className="public-kicker">{t("learn.researchKicker")}</span>
            <h2>{t("learn.researchTitle")}</h2>
          </div>
          <ul>
            {RESEARCH.map(({ titleKey, bodyKey }) => (
              <li key={titleKey}><BookOpen size={18} /><span><strong>{t(titleKey)}</strong>{t(bodyKey)}</span></li>
            ))}
          </ul>
        </section>

        <section className="public-trust" id="trust">
          <div><ShieldCheck size={28} /><span className="public-kicker">{t("learn.trustKicker")}</span><h2>{t("learn.trustTitle")}</h2></div>
          <dl>
            <div><dt>{t("learn.trustPublicTerm")}</dt><dd>{t("learn.trustPublicBody")}</dd></div>
            <div><dt>{t("learn.trustProtectedTerm")}</dt><dd>{t("learn.trustProtectedBody")}</dd></div>
            <div><dt>{t("learn.trustNotCollectedTerm")}</dt><dd>{t("learn.trustNotCollectedBody")}</dd></div>
          </dl>
        </section>

        <section className="public-cta">
          <span>{t("learn.ctaEyebrow")}</span>
          <h2>{t("learn.ctaTitle")}</h2>
          {connectEnabled ? (
            <>
              <a className="public-primary" href="/connect">{t("learn.ctaPrimary")} <ArrowRight size={18} /></a>
              <a className="public-secondary" href={DEMO_HREF}>{t("learn.ctaDemoWorkspace")}</a>
            </>
          ) : (
            <>
              <p>{t("learn.connectClosed")}</p>
              <a className="public-primary" href={DEMO_HREF}>{t("learn.ctaDemoWorkspace")} <ArrowRight size={18} /></a>
            </>
          )}
          <small>{t("learn.ctaDisclaimer")}</small>
        </section>
      </main>

      <footer className="public-footer">
        <a className="public-brand" href="/"><BrandMark size={30} /><span className="public-brand__name"><BrandWordmark /></span></a>
        <p>{t("learn.footerTagline")}</p>
        <nav aria-label={t("learn.footerLegal")}>
          <a href="/m">{t("learn.footerWorkspace")}</a>
        </nav>
      </footer>
    </div>
  );
}
