// The selectable pill used by the forms editor and the workload log. Both views
// carried a byte-identical private copy, so a tweak to the selected-state border
// or the 40px hit target only ever landed on one of them.
export function chipStyle(active) {
  return {
    minHeight: 44,
    padding: "8px 14px",
    borderRadius: 999,
    border: active ? "1.5px solid var(--green)" : "1px solid var(--border)",
    background: active ? "var(--green-soft)" : "var(--card)",
    color: active ? "var(--green)" : "var(--ink)",
    fontSize: 12.5,
    fontWeight: active ? 800 : 700,
    cursor: "pointer",
  };
}
