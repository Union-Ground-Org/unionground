// The design's sign-in page chrome around the production AuthScreen. The form,
// its password/PIN/social/SSO flows and every message stay AuthScreen's; this
// only supplies the page hero, the panel and the brand header the design drew.
import { Component, lazy, Suspense, useEffect, useState } from "react";
import { useLang } from "../lib/LanguageContext.jsx";
import { captureViewError } from "../lib/deferredObservability.js";
import { BrandMark } from "./icons.jsx";
import "./styles/design.css";
import "./styles/shell.css";
import DotGrid from "./DotGrid.jsx";

// UX-UG-WEBSITE-ONE-STANDARD-PAGE-WIDTH-20261116: the page takes the
// site's one standard width, and the row beside the panel carries the story
// side of sign-in design 1 in the Union Ground promo package, the same orbit
// the classic sign-in page draws. It is decoration: a separate chunk asked for
// only at the width that shows it (shell.css), and a failure draws nothing.
const SignInOrbit = lazy(() => import("../components/SignInOrbit.jsx"));
const STORY_WIDTH_QUERY = "(min-width: 900px)";

class StoryBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    captureViewError(error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

function SignedOutStory() {
  const [orbitWanted, setOrbitWanted] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia(STORY_WIDTH_QUERY);
    const update = () => { if (query.matches) setOrbitWanted(true); };
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  return (
    <div className="ug-signin-story">
      <div className="ug-signin-story-stage">
        {orbitWanted && <StoryBoundary><Suspense fallback={null}><SignInOrbit /></Suspense></StoryBoundary>}
      </div>
    </div>
  );
}

export default function AltSignedOut({ onBackToLanding = null, children }) {
  const { t } = useLang();
  return (
    <div className="ugalt ug-signed-out" data-shell="alt">
      <header className="ug-hdr" id="ug-hdr">
        <div className="ug-wrap"><div className="ug-hdr-bar">
          <a className="ug-brand" href="/" aria-label="Union Ground" onClick={onBackToLanding ? (event) => { event.preventDefault(); onBackToLanding(); } : undefined}>
            <BrandMark /><span>Union Ground<small>{t("altShell.brandTag")}</small></span>
          </a>
          {onBackToLanding ? (
            <div className="ug-hdr-tools">
              <button className="ug-btn ug-btn-dark ug-btn-sm" type="button" onClick={onBackToLanding}>{t("altShell.backToSite")}</button>
            </div>
          ) : null}
        </div></div>
      </header>
      <section className="ug-page-hero">
        <DotGrid />
        <div className="ug-wrap ug-signin">
          <div className="ug-panel-w ug-signin-panel">
            <div className="ug-signin-title">{t("altShell.signinLead")} <span className="ug-accent">{t("altShell.signinAccent")}</span></div>
            <p className="ug-lede">{t("altShell.signinLede")}</p>
            {children}
            <p className="ug-signin-foot">{t("altShell.signinNew")}</p>
          </div>
          <SignedOutStory />
        </div>
      </section>
    </div>
  );
}
