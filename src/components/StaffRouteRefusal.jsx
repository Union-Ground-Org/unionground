import { useEffect, useRef } from "react";
import "./StaffRouteRefusal.css";

export function StaffRouteRefusal({ refusal, message, homeClearance, dismissLabel, onDismiss }) {
  const cardRef = useRef(null);
  useEffect(() => {
    // Only a new refusal moves focus/scroll. Translating an existing notice
    // must not steal focus from the profile dialog or other active controls.
    cardRef.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: "instant" });
  }, [refusal]);

  return <div
    ref={cardRef}
    className={`view-error staff-route-refusal${homeClearance ? " staff-route-refusal--home" : ""}`}
    role="status"
    tabIndex={-1}
    data-staff-route-refusal=""
  >
    <p>{message}</p>
    <button className="dialog-primary" type="button" onClick={onDismiss}>{dismissLabel}</button>
  </div>;
}
