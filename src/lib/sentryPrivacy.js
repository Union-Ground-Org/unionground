import { createSentryPrivacy, privateSentryOptions as sharedPrivateSentryOptions } from "./shared-core/sentryPrivacy.js";
export { sanitizeSentryBreadcrumb, sanitizeSentryEvent, sanitizeSentrySpan } from "./shared-core/sentryPrivacy.js";

// Product identity stays local; all privacy filtering lives in shared-core.
const privacy = createSentryPrivacy("sentry.javascript.unionground-private-errors");

export function sanitizeSentryEnvelope(envelope, metadata = {}) {
  return privacy.sanitizeSentryEnvelope(envelope, metadata);
}

export function privateSentryTransport(makeTransport, metadata = {}) {
  return privacy.privateSentryTransport(makeTransport, metadata);
}

// Sentry 11 replaced sendDefaultPii with dataCollection, and an unset
// dataCollection now collects every category (user, cookies, headers,
// bodies, queries, queues, GenAI). It also attaches a call-site stack to
// captureMessage. Both inits spread these options to keep the v10 baseline or
// tighter. The browser init replaces dataCollection with its own block, which
// lists every category but queues; the browser has no queue instrumentation.
// The private transport above still forwards scrubbed events only.
export function privateSentryOptions() {
  return {
    ...sharedPrivateSentryOptions(),
    attachStacktrace: false,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    },
  };
}
