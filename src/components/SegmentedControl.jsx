import "./segmentedControl.css";

/** Switches views of the same data without changing the route. */
export function SegmentedControl({ label, options, value, onChange, className = "" }) {
  return <div role="group" aria-label={label} className={`sg-segments ${className}`.trim()}>
    {options.map((option) => <button key={option.value} type="button" className="sg-segments__item" aria-pressed={option.value === value} disabled={option.disabled} onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>;
}
