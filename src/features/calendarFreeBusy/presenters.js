export const CALENDAR_FREEBUSY_VIEW_STATES = Object.freeze([
  "empty",
  "loading",
  "success",
  "validation",
  "unauthorized",
  "wrong_organization",
  "retry",
]);

const DISCLAIMER = "Calendar imports are opaque instants. Union Ground never stores event titles, attendees, descriptions, or locations from a provider calendar.";

function failureState(result) {
  if (result?.reason === "catalog_unavailable") return "retry";
  if (result?.reason === "wrong_organization") return "wrong_organization";
  if (result?.reason === "invalid_input") return "validation";
  if (result?.reason === "activation_unset" || result?.reason === "empty_organization") return "empty";
  return "unauthorized";
}

function failureMessage(result) {
  if (result?.reason === "activation_unset") {
    return "Google and Microsoft free/busy stay off until this organization registers its own OAuth app. Request still records the ask.";
  }
  if (result?.reason === "empty_organization") {
    return "No organization is selected. Free/busy setup waits for the first real organization.";
  }
  if (result?.reason === "wrong_organization") {
    return "That calendar request named a different organization and was denied.";
  }
  if (result?.reason === "catalog_unavailable") {
    return "Calendar setup could not be reached. Try again.";
  }
  if (result?.reason === "invalid_input") {
    return "Choose Google or Microsoft.";
  }
  return "You are not authorized to change calendar sync for this organization.";
}

export function presentLoading() {
  return {
    state: "loading",
    title: "Calendar free/busy",
    message: "Checking whether a chapter-owned provider app is registered.",
    disclaimer: DISCLAIMER,
    providers: [],
  };
}

export function presentRetry() {
  return {
    state: "retry",
    title: "Calendar free/busy",
    message: "Calendar setup could not be reached. Try again.",
    disclaimer: DISCLAIMER,
    providers: [],
  };
}

export function presentCalendarFreeBusy(result) {
  if (!result?.ok) {
    return {
      state: failureState(result),
      reason: result?.reason ?? "invalid_input",
      title: "Calendar free/busy",
      message: failureMessage(result),
      disclaimer: DISCLAIMER,
      providers: [],
    };
  }

  const providers = (result.providers || []).map((row) => ({
    provider: row.provider,
    label: row.provider === "microsoft" ? "Microsoft Outlook" : "Google Calendar",
    configured: Boolean(row.configured),
    connection: row.connection || "none",
    message: row.configured
      ? "The chapter-owned app is registered. Request opens the provider to reconcile opaque event times."
      : "Unset. Request records the ask. Sync stays off until an operator registers the organization's OAuth app.",
  }));

  const anyConfigured = providers.some((row) => row.configured);
  return {
    state: anyConfigured ? "success" : "empty",
    title: "Calendar free/busy",
    message: anyConfigured
      ? "A provider app is registered. Members still cannot see why a slot is busy."
      : "No customer OAuth app is registered. The product is present; live calendar reconciliation is unset.",
    disclaimer: DISCLAIMER,
    providers,
  };
}
