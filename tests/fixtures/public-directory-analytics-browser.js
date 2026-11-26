import posthog from "posthog-js";
import { initObservability, memberIdentitySettled, syncObservabilityContext } from "../../src/lib/observability.js";

window.verifyLedger613 = async () => {
  const events = [];
  initObservability({
    hostname: "unionground.net",
    location: { origin: "https://unionground.net", get pathname() { return window.location.pathname; }, get href() { return `https://unionground.net${window.location.pathname}`; } },
    history: window.history,
    storage: window.localStorage,
    automated: false,
  });
  const scrub = posthog.config.before_send;
  // This isolated automated fixture needs real member/public captures as
  // positive controls. Production's bot filter remains unchanged.
  posthog.set_config({ opt_out_useragent_filter: true, before_send: (event) => {
    const clean = scrub(event);
    if (clean) events.push(JSON.parse(JSON.stringify(clean)));
    return clean;
  } });
  syncObservabilityContext({ userId: "synthetic-member", organizationId: "synthetic-organization", view: "today" });
  await memberIdentitySettled();
  const memberEvents = events.splice(0);
  window.history.pushState(null, "", "/chapters/chapter-00");
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const beforeReset = events.splice(0);
  syncObservabilityContext({ userId: null, view: "chapters-chapter-00", authPending: false });
  return { automaticPageViews: posthog.config.capture_pageview, memberEvents, beforeReset, publicEvents: events };
};
