import { useLang } from "../lib/LanguageContext.jsx";
import UnionOrbit from "./orbit/UnionOrbit.jsx";
import "./signInOrbit.css";

// UX-UG-SIGN-IN-FORM-WITH-ORBIT-STORY-SIDE-20261113: the story side of
// sign-in design 1 in the Union Ground promo package
// (sign-in/login-1-original-orbit.html). AuthScreen loads this module only at
// desktop width and only after its first paint, so phones never download it
// and the sign-in first-paint bytes do not grow.
//
// The orbit itself is the shared engine in ./orbit/UnionOrbit.jsx, which the
// home page draws too (UX-UG-ONE-ORBIT-ENGINE-FOR-HOME-AND-SIGN-IN-20261113):
// the package's capability icons, never a union's logo (owner answers of
// November 13, 2026, choice 5). Here it is decorative beside the story, sized
// by signInOrbit.css at the reference's desktop sizes times 0.8.
export { ORBIT_RINGS } from "./orbit/UnionOrbit.jsx";

// The sign-in page holds the pause choice and passes it in.
export default function SignInOrbit({ paused, onPausedChange }) {
  const { t } = useLang();
  return <UnionOrbit prefix="sgauth-orbit" pauseLabel={t("auth.orbitPause")} playLabel={t("auth.orbitPlay")} paused={paused} onPausedChange={onPausedChange} />;
}
