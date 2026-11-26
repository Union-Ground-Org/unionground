import { publicContact } from "../../lib/publicContact.js";
import "../../lib/i18n/features/automationAvailabilityStrings.js";

// A terminal workspace response is authoritative even when the current hat
// passes the local role check. Never infer a missing role from an inactive workspace.
export function automationAuthoringBlock(reason, t) {
  switch (reason) {
    case "session_inactive":
      return { message: t("automationAvailability.inactiveWorkspace"), action: t("automationAvailability.restoreWorkspace"), href: publicContact("support")?.href ?? "/contact" };
    case "role_denied":
      return { message: t("automationAvailability.staffRequired"), action: t("automationAvailability.requestStaff"), href: "/m/settings/requests" };
    case "mfa_required":
      return { message: t("admin.automation.unavailableMfa"), action: t("automationAvailability.verifyMfa"), href: "/m/settings/security" };
    case "persistence_unset":
      return { message: t("admin.automation.unavailableUnset"), action: t("automationAvailability.setupStorage"), href: publicContact("support")?.href ?? "/contact" };
    default:
      return null;
  }
}
