export function accessScope(value) {
  value = String(value || "");
  if (value.startsWith("unit:")) return { unitId: value.slice(5) };
  if (value.startsWith("committee:")) return { committeeId: value.slice(10) };
  return {};
}
