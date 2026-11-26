import "./chip.css";

export function Chip({ tone = "neutral", children, className = "" }) {
  return <span className={`civic-chip civic-tone-${tone} sg-chip sg-chip--${tone} ${className}`.trim()}>{children}</span>;
}
