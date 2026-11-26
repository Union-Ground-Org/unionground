import "./filterPills.css";

export function FilterPills({ label, options, value, onChange, className = "" }) {
  return <div role="group" aria-label={label} className={`sg-filters ${className}`.trim()}>
    {options.map((option) => <button key={option.value} type="button" className="sg-filters__item" aria-pressed={option.value === value} disabled={option.disabled} onClick={() => onChange(option.value)}>{option.label}{option.count != null && <>{" "}<span className="sg-filters__count">{option.count}</span></>}</button>)}
  </div>;
}
