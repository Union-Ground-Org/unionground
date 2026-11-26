// Match the shared row's visible member/reference prefix in either language.
// Escape fixture text so names with punctuation remain literal locators.
export function caseListOpenerName({ memberName, reference }) {
  const prefix = `${memberName} ${reference}`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${prefix}(?: —|$)`);
}
