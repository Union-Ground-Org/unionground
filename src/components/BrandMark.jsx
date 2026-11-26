import { BRAND, OFFICIAL_MARK } from "../lib/brand.js";

// The product mark. An official build (branding/official/) shows the Union
// Ground mark: on its tile by default, without the tile (variant "plain") on
// green and dark surfaces such as the desktop rail. Every other build shows a
// neutral glyph drawn here: a plain rounded square with the initial of the
// build's own name, and no Union Ground artwork.
export const NEUTRAL_MARK_FILL = "#3f4a46";
export const NEUTRAL_MARK_INK = "#ffffff";

export function NeutralMark({ size = 34, initial = BRAND.initial }) {
  return (
    <svg className="brand-mark brand-mark--neutral" width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true" focusable="false">
      <rect width="64" height="64" rx="15" fill={NEUTRAL_MARK_FILL} />
      <text x="32" y="43" textAnchor="middle" fontFamily="system-ui, -apple-system, 'Segoe UI', sans-serif" fontSize="30" fontWeight="700" fill={NEUTRAL_MARK_INK}>{initial}</text>
    </svg>
  );
}

export function BrandMark({ size = 34, variant = "tile" }) {
  if (OFFICIAL_MARK) {
    const src = variant === "plain" ? OFFICIAL_MARK.plain : OFFICIAL_MARK.tile;
    return <img className="brand-mark brand-mark--official" src={src} width={size} height={size} alt="" aria-hidden="true" style={{ display: "block" }} />;
  }
  return <NeutralMark size={size} />;
}

// The wordmark: the official build keeps its accented first word; any other
// build prints its own name as one run of text.
export function BrandWordmark() {
  if (BRAND.official) return <><span>Union</span> Ground</>;
  return <>{BRAND.name}</>;
}
