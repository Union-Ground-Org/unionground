// My Reports reads the member's saved layout from get_my_report_preferences,
// which the member session loader caches. A save that only updated app data
// left that cached value behind, so the next projection (leaving the page and
// coming back) restored the layout from before the save. Confirming the saved
// layout into the loader replaces the cached value and re-reads the resource.
export const REPORT_PREFERENCES_RESOURCE = "rpc:get_my_report_preferences";

export function confirmReportPreferences(loader, config) {
  loader?.confirmRows(REPORT_PREFERENCES_RESOURCE, () => config);
}
