import { useEffect, useState } from "react";
import { Pause, Play } from "lucide-react";
import { useLang } from "../lib/LanguageContext.jsx";
import { ICONS } from "./orbit/UnionOrbit.jsx";
import { BrandMark } from "./BrandMark.jsx";
import "./signInDesigns.css";

// REQ-UG-PUBLIC-PAGE-SECTION-SWITCHES-AND-SIGN-IN-DESIGNS-2-TO-4-20261117
// (#9038): the story side of sign-in designs 2 ("orbit") and 4 ("together") in
// the Union Ground promo package (sign-in/login-2-orbit.html and
// login-4-together.html). Design 3 ("quiet") has no story side. AuthScreen
// loads this module only when one of those designs is released
// (features.public_pages.sign_in_design_N), only at the width that draws it,
// and only after its first paint.
//
// The small orbit is the packages' two rings of three tiles around the mark.
// Its tiles are Union Ground's own capability icons from the theme's
// icons.json, through the shared orbit engine, never a union's logo (owner
// answers of November 13, 2026, choice 5). The package's "hand" and "heart"
// line icons have no theme icon, so the inner ring carries messages, chapters
// and cases. The orbit is decoration (aria-hidden); the words beside it are
// read. It stops under reduced motion and when paused (WCAG 2.2.2).
const OUTER = ["calendar", "vote", "rights"];
const INNER = ["messages", "chapters", "cases"];
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function reducedMotion() {
  return typeof window.matchMedia === "function" && window.matchMedia(REDUCED_MOTION).matches;
}

function Tile({ name }) {
  return (
    <span className="sgauth-design__orb">
      <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">{ICONS[name]}</svg>
    </span>
  );
}

// The pause choice can be held by the caller (gate final on #9067, r3s1): the
// sign-in page keeps it above the story side, which unmounts below 900 CSS px,
// so a visitor who paused, narrowed the window and widened it again finds the
// orbit still paused. Without those props the story keeps the choice itself.
// `onDark`: the story sits on pine (design 2 in the pine look, a review note).
export default function SignInDesignStory({ design, onDark = false, paused: heldPaused, onPausedChange }) {
  const { t } = useLang();
  const [still, setStill] = useState(reducedMotion);
  const [ownPaused, setOwnPaused] = useState(false);
  const held = typeof onPausedChange === "function";
  const paused = held ? Boolean(heldPaused) : ownPaused;
  const setPaused = held ? onPausedChange : setOwnPaused;
  useEffect(() => {
    // Gate round 1 on #9067 (r1s1, r2s1): the visitor may change the motion
    // setting while the page is open; the orbit and its control follow it.
    if (typeof window.matchMedia !== "function") return undefined;
    const query = window.matchMedia(REDUCED_MOTION);
    const follow = () => setStill(query.matches);
    follow();
    query.addEventListener?.("change", follow);
    return () => query.removeEventListener?.("change", follow);
  }, []);
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    // A hidden tab stops the rings, as the design 1 orbit does. Gate round 1
    // on #9067 (r1s2): a story that mounts in a tab already hidden starts
    // stopped, so the state is applied once when the listener is set up.
    const pauseWhenHidden = () => document.documentElement.toggleAttribute("data-sgauth-tab-hidden", document.hidden);
    pauseWhenHidden();
    document.addEventListener("visibilitychange", pauseWhenHidden);
    return () => {
      document.removeEventListener("visibilitychange", pauseWhenHidden);
      document.documentElement.removeAttribute("data-sgauth-tab-hidden");
    };
  }, []);
  return (
    <aside className={`sgauth-design sgauth-design--${design}`} aria-label={t("auth.design.storyLabel")} data-paused={paused || still}>
      <div>
        <p className="sgauth-design__eyebrow">{t("auth.design.eyebrow")}</p>
        <h2>
          <span>{t(`auth.design${design}.lead`)}</span> <em className="sgauth-design__accent">{t(`auth.design${design}.accent`)}</em>
        </h2>
        <p className="sgauth-design__copy">{t("auth.design.copy")}</p>
      </div>
      <div className="sgauth-design__slot">
        <div className="sgauth-design__orbit" aria-hidden="true">
          <div className="sgauth-design__glow" />
          <div className="sgauth-design__ring">{OUTER.map((name) => <Tile key={name} name={name} />)}</div>
          <div className="sgauth-design__ring sgauth-design__ring--inner">{INNER.map((name) => <Tile key={name} name={name} />)}</div>
          {/* The mark keeps its tile on paper (design 2) and has none, drawn
              larger, on the green half (design 4) and on pine: theme rule 9. */}
          <div className="sgauth-design__core">{design === 4 || onDark ? <BrandMark size={64} /> : <BrandMark size={64} />}</div>
        </div>
      </div>
      <div className="sgauth-design__foot">
        <p className="sgauth-design__bottom">{t("auth.design.bottom")}</p>
        {!still && (
          <button className="sgauth-design__motion" type="button" aria-pressed={paused} onClick={() => setPaused(!paused)}>
            {paused ? <Play size={16} aria-hidden="true" /> : <Pause size={16} aria-hidden="true" />}
            <span>{paused ? t("auth.orbitPlay") : t("auth.orbitPause")}</span>
          </button>
        )}
      </div>
    </aside>
  );
}
