import { useMemo } from "react";
import { makeCheckinQrMatrix } from "../lib/checkinQr.js";

const QUIET_ZONE = 4;

export function CheckinQrCode({ token, label }) {
  const matrix = useMemo(() => makeCheckinQrMatrix(token), [token]);
  const size = matrix.length + QUIET_ZONE * 2;
  const path = matrix.flatMap((row, y) => row.map((dark, x) => (
    dark ? `M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z` : ""
  ))).join("");

  return (
    <svg
      className="mevents-code-tile__qr"
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      {/* Pure black/white is required machine-readable QR artwork, not a UI
          color token. The four-module quiet zone is part of that contract. */}
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}
