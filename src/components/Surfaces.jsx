import { BusyButton } from "./BusyControls.jsx";

// Member-surface primitives that were copied between views rather than shared.
//
// The card here is NOT the staff-plane `card` in lib/staffPlaneStyles.js — the
// member surfaces carry a border and an 18px radius, the staff planes do not.
// Two surfaces, two constants, on purpose; collapsing them would silently
// restyle five dashboards.
// E1 (review v5): the values moved to the .m-card rule in styles.css so the
// surface can carry hover, press and focus states — a style object cannot.
// Still NOT the staff-plane surface: that one is .plane-card, border-free and
// 20px. Two surfaces, two classes, same reason as before.
export const CARD_CLASS = "m-card";

// The on/off control. `label` is the accessible name and the state comes from
// aria-checked, so the name stays stable across toggles instead of being
// announced twice. Callers own whatever visible text sits beside it.
// `pending` is for a change still saving: the switch reads as unavailable and
// ignores clicks but stays focusable. A disabled element loses focus at the
// next rendering update (the HTML focus fixup rule), which would send a
// keyboard or screen-reader user to the top of the page mid-save.
export function Switch({ label, checked, onChange, disabled = false, pending = false, "aria-describedby": describedBy }) {
  return (
    <BusyButton
      type="button"
      className="sg-switch"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      aria-describedby={describedBy}
      disabled={disabled}
      pending={pending}
      onClick={() => onChange(!checked)}
    >
      <span className="sg-switch__track" aria-hidden="true">
        <span className="sg-switch__fill" />
        <span className="sg-switch__thumb">
          <span className="sg-switch__cue sg-switch__cue--off">×</span>
          <span className="sg-switch__cue sg-switch__cue--on">✓</span>
        </span>
      </span>
    </BusyButton>
  );
}
