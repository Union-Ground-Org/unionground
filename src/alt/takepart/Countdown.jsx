// The prototype's ballot countdown (pages/votes.js `data-countdown`, ticked
// every second by its mount; the text is core.js fmt.countdown). Only this
// span re-renders on a tick. With reduced motion the text is drawn once and
// does not tick; the card's closing line still names the exact close.
import { useEffect, useState } from "react";

const REDUCE_QUERY = "(prefers-reduced-motion: reduce)";

function reducedMotion() {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && Boolean(window.matchMedia(REDUCE_QUERY)?.matches);
}

// fmt.countdown: "2d 4h 05m", "4h 05m", then "12:07" inside the last hour.
export function countdownText(ms) {
  if (!(ms > 0)) return "0:00";
  const total = Math.floor(ms / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, "0");
  if (days) return `${days}d ${hours}h ${mm}m`;
  if (hours) return `${hours}h ${mm}m`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function Countdown({ target }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (reducedMotion() || target - Date.now() <= 0) return undefined;
    const tick = setInterval(() => {
      const next = Date.now();
      setNow(next);
      if (target - next <= 0) clearInterval(tick);
    }, 1000);
    return () => clearInterval(tick);
  }, [target]);
  return <span className="ug-ta-countdown ug-tnum">{countdownText(target - now)}</span>;
}
