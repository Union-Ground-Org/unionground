import { createHash, createPrivateKey, sign as cryptoSign } from "node:crypto";
import { connect as connectHttp2, constants as http2Constants } from "node:http2";
import { cronAuthorization, cronRefusalBody } from "./_lib/cronAuth.js";
import {
  json,
  methodGuard,
  unionGroundProvider,
  requireEnv,
  supabaseHeaders,
  supabaseRpc,
  validateMutationOrigin,
} from "./_lib/http.js";
import { organizationFooterAddress, renderEmail, renderText, settingsUrlFor } from "./_lib/emailTemplate.js";
import { eventEmailLeaseMatches, eventEmailTemplate } from "./_lib/eventEmail.js";
import mobileReleaseFoundation from "../config/mobile-release-foundation.json" with { type: "json" };
import { brandText } from "./_lib/brand.js";
import { recordAccountMailFailure } from "./_lib/accountMailAlerts.js";
import { ACCOUNT_NOTICE_ROW_WORST_CASE_MS, ACCOUNT_NOTICE_RPC_TIMEOUT_MS, deliverAccountNotices, purgeAccountNotices } from "./_lib/recoveryCodeNotice.js";

// Outbound notification dispatcher (PR5). Production is called two ways, both
// bearing CRON_SECRET: a pg_cron tick POSTs every 5 minutes via pg_net, and a
// daily Vercel cron GET is the plan-safe backstop. Union Ground has no
// SAMPLE backend, so there is no separate SAMPLE dispatch path at all.
// Overlapping invocations are harmless — claim_notification_deliveries uses
// FOR UPDATE SKIP LOCKED.
//
// Email is generic except for event title/date/change freshly authorized by
// get_event_notification_email for this delivery/attempt/lease and address.
// Every push remains generic. Notification title/body never reach a provider;
// the claim RPC still does not return them.
//
// Stopping outbound: the real switch is private.notification_controls
// .outbound_enabled in the database, because it works within one claim cycle,
// needs no deploy, and keeps working when Vercel is the broken thing.
// NOTIFY_KILL_SWITCH below is only a static fail-safe baked into a deployment —
// changing it in project settings does nothing until the next deploy, so never
// reach for it in an incident.
//
// Budget: every claim is leased. A row handed to this function carries the
// attempt number the claim wrote, and a result is only accepted while the row
// is still on that attempt. That is what makes it safe to abandon work when
// the deadline runs out — abandoned rows are reclaimed by the 15-minute
// watchdog rather than double-recorded.

const EMAIL_BATCH = 60;
const PUSH_BATCH = 25;
// Vercel kills the function at maxDuration (300s). Stop claiming well before
// that: work claimed and then abandoned mid-flight is what strands rows in
// 'sending' and produces duplicate sends a watchdog cycle later.
const INVOCATION_BUDGET_MS = 230_000;
// The account-security email sweep (a used recovery code) has its own reserved
// window: the retention purge, one claim and one worst-case row. It runs after
// both channels and starts no later than the end of their shared
// INVOCATION_BUDGET_MS, so email and push keep their whole budgets. Worst case
// it ends at INVOCATION_BUDGET_MS + ACCOUNT_NOTICE_RESERVE_MS (270 s), inside
// the function's 300 s maxDuration.
const ACCOUNT_NOTICE_BATCH = 10;
const ACCOUNT_NOTICE_RESERVE_MS = ACCOUNT_NOTICE_RPC_TIMEOUT_MS * 2 + ACCOUNT_NOTICE_ROW_WORST_CASE_MS;
const ACCOUNT_NOTICE_BUDGET_MS = ACCOUNT_NOTICE_RESERVE_MS;
const CLAIM_TIMEOUT_MS = 10_000;
const RECORD_TIMEOUT_MS = 20_000;
const EMAIL_SEND_TIMEOUT_MS = 20_000;
const EVENT_EMAIL_AUTHORIZATION_TIMEOUT_MS = 3_000;
const PUSH_SEND_TIMEOUT_MS = 10_000;
const PRUNE_TIMEOUT_MS = 8_000;
const NATIVE_AUTHORIZATION_TIMEOUT_MS = 3_000;
const PUSH_CONCURRENCY = 5;
const EMAIL_CONCURRENCY = 8;
const MAX_SUBSCRIPTIONS_PER_ROW = 10; // mirrors the claim RPC's cap
const MAX_NATIVE_INSTALLATIONS_PER_ROW = 10; // mirrors the claim RPC's cap
const MAX_PUSH_TARGETS_PER_ROW = MAX_SUBSCRIPTIONS_PER_ROW + MAX_NATIVE_INSTALLATIONS_PER_ROW;
// The native app identity (apps/mobile/app.config.ts): MOBILE_APPLICATION_ID
// when set, else the source default in config/mobile-release-foundation.json.
// APNS_BUNDLE_ID must name that same app. The email link is not a constant:
// configuredAppUrl() reads NOTIFY_APP_URL, because Union Ground has no
// provisioned domain and must never link a sibling product's site.
function mobileApplicationId(env) {
  return String(env.MOBILE_APPLICATION_ID || "").trim() || mobileReleaseFoundation.applicationId;
}
const APNS_AUTH_REFRESH_SECONDS = 50 * 60;
const APNS_EXPIRATION_SECONDS = 60 * 60;
// The postal line in the email footer. No default on purpose — see
// postalLine() in ./_lib/emailTemplate.js. Unset means the line is omitted,
// never guessed.
const ORG_POSTAL_ADDRESS = process.env.ORG_POSTAL_ADDRESS || "";

// Time that must remain when work stops, so results can still be written. An
// unrecorded send is a future duplicate, so recording is the one step that may
// never be the thing that runs out of budget. Two record attempts plus slack.
const RECORD_RESERVE_MS = RECORD_TIMEOUT_MS * 2 + 5_000;

// Provable worst case for ONE WAVE of work, used to size claims and to decide
// whether more rows fit. A wave is what runs at the same time, so a batch costs
// ceil(rows / concurrency) waves of wall clock.
//
// Push is the expensive channel and its wave is one ROW: dispatchPushBatch
// iterates rows serially and only the subscriptions inside a row overlap — up
// to ten of them, five at a time, and a dead endpoint costs a send timeout plus
// a prune round trip in the same slot.
const PUSH_ROW_WORST_CASE_MS =
  Math.ceil(MAX_PUSH_TARGETS_PER_ROW / PUSH_CONCURRENCY) * (PUSH_SEND_TIMEOUT_MS + PRUNE_TIMEOUT_MS)
  + Math.ceil(MAX_NATIVE_INSTALLATIONS_PER_ROW / PUSH_CONCURRENCY) * NATIVE_AUTHORIZATION_TIMEOUT_MS
  + PUSH_SEND_TIMEOUT_MS; // one shared first-use FCM OAuth exchange
const EMAIL_ROW_WORST_CASE_MS = EMAIL_SEND_TIMEOUT_MS + EVENT_EMAIL_AUTHORIZATION_TIMEOUT_MS;
const CHANNEL_HANDOFF_SLACK_MS = 5_000;

// Email is claimed first and would otherwise be able to spend the entire
// invocation, leaving push claiming nothing every tick — a 20k email day would
// delay every queued push for hours. This channel deadline leaves one
// worst-case in-flight email, explicit scheduler slack, one worst-case push
// row, and PUSH'S later recording reserve. affordableRows also keeps EMAIL'S
// own recording reserve inside this earlier window; those are two distinct
// result writes, not the same reserve counted twice.
const EMAIL_BUDGET_MS = INVOCATION_BUDGET_MS
  - EMAIL_ROW_WORST_CASE_MS
  - CHANNEL_HANDOFF_SLACK_MS
  - PUSH_ROW_WORST_CASE_MS
  - RECORD_RESERVE_MS;

export const DISPATCH_BUDGETS = Object.freeze({
  invocationMs: INVOCATION_BUDGET_MS,
  emailMs: EMAIL_BUDGET_MS,
  emailRowWorstCaseMs: EMAIL_ROW_WORST_CASE_MS,
  emailConcurrency: EMAIL_CONCURRENCY,
  channelHandoffSlackMs: CHANNEL_HANDOFF_SLACK_MS,
  pushRowWorstCaseMs: PUSH_ROW_WORST_CASE_MS,
  recordReserveMs: RECORD_RESERVE_MS,
  accountNoticeMs: ACCOUNT_NOTICE_BUDGET_MS,
  accountNoticeReserveMs: ACCOUNT_NOTICE_RESERVE_MS,
});

export const TEMPLATES = {
  deadlines: {
    en: { subject: "A deadline needs your attention", body: "One of your Union Ground deadlines needs attention. Open the app to review it." },
    es: { subject: "Un plazo requiere tu atención", body: "Uno de tus plazos en Union Ground requiere atención. Abre la app para revisarlo." },
  },
  cases: {
    en: { subject: "There's movement on one of your issues", body: "An issue you're part of has an update in Union Ground. Open the app to read it." },
    es: { subject: "Hay novedades en uno de tus asuntos", body: "Un asunto en el que participas tiene una novedad en Union Ground. Abre la app para leerla." },
  },
  forms: {
    en: { subject: "An update on one of your forms", body: "One of your Union Ground forms has an update. Open the app to read it." },
    es: { subject: "Novedades en uno de tus formularios", body: "Uno de tus formularios en Union Ground tiene una novedad. Abre la app para leerla." },
  },
  votes: {
    en: { subject: "A vote or poll needs your voice", body: "A vote or poll is waiting for you in Union Ground. Open the app to take part." },
    es: { subject: "Una votación o encuesta espera tu voz", body: "Una votación o encuesta te espera en Union Ground. Abre la app para participar." },
  },
  events: {
    en: { subject: "Campaign meeting update", body: "There's an update about a campaign meeting in Union Ground. Open the app for details." },
    es: { subject: "Novedades de una reunión de la campaña", body: "Hay novedades sobre una reunión de la campaña en Union Ground. Abre la app para ver los detalles." },
  },
  // Shoulder-test rule holds in mail too: no task notice ever names a task,
  // campaign or workstream.
  tasks: {
    en: { subject: "An update on your campaign work", body: "Something on your Union Ground task list changed. Open the app to see it." },
    es: { subject: "Novedades en tu trabajo de la campaña", body: "Algo cambió en tu lista de tareas de Union Ground. Abre la app para verlo." },
  },
  // One-on-one notices never name the conversation's reason: a reason in a
  // subject line is exactly the disclosure the reason-category-only schema
  // exists to prevent.
  appointments: {
    en: { subject: "An update about a one-on-one", body: "One of your Union Ground one-on-ones has an update. Open the app for the details." },
    es: { subject: "Novedades sobre una reunión individual", body: "Una de tus reuniones individuales en Union Ground tiene novedades. Abre la app para ver los detalles." },
  },
  // No 'dues' template: Union Ground leaves dues out (owner decision,
  // 2026-10-13), so a dues row fails closed as unsendable like any other
  // kind without a template.
  // Mentions, @here and keyword alerts from campaign channels. Never names the
  // channel, the author or the post: a channel's name can itself disclose who
  // is organizing.
  messages: {
    en: { subject: "A campaign channel needs your attention", body: "Someone mentioned you, or a post matched your alerts, in a Union Ground campaign channel. Open the app to read it." },
    es: { subject: "Un canal de la campaña requiere tu atención", body: "Alguien te mencionó, o una publicación coincidió con tus alertas, en un canal de la campaña de Union Ground. Abre la app para leerla." },
  },
  workload: {
    receipt: {
      en: { subject: "Workplace log received", body: "Your workplace log receipt is #{code}. Keep this code for your records." },
      es: { subject: "Registro del lugar de trabajo recibido", body: "Tu comprobante del registro del lugar de trabajo es #{code}. Guarda este código." },
    },
    reminder: {
      en: { subject: "Workplace log reminder", body: "It is time to update your workplace log in Union Ground. Open the app when you are ready." },
      es: { subject: "Recordatorio del registro del lugar de trabajo", body: "Es hora de actualizar tu registro del lugar de trabajo en Union Ground. Abre la aplicación cuando puedas." },
    },
  },
};

function configuredAppUrl() {
  const raw = process.env.NOTIFY_APP_URL;
  if (!raw) return null;
  try {
    const value = new URL(raw);
    if (
      value.protocol !== "https:"
      || !value.hostname
      || value.username
      || value.password
      || value.pathname !== "/m"
      || value.search
      || value.hash
    ) return null;
    return value.toString();
  } catch {
    return null;
  }
}

// Fails closed. A kind with no template — 'general', or anything a future
// migration adds — is NOT sendable, and must terminate as skipped rather than
// go out under a generic "you have an update" fallback. 'general' is the kind
// a member cannot switch off, so a fallback that sent it would be a hole
// straight through the preference system.
export function templateFor(kind, lang, metadata = null) {
  const entry = Object.prototype.hasOwnProperty.call(TEMPLATES, kind) ? TEMPLATES[kind] : null;
  if (!entry) return null;
  if (kind === "workload") {
    if (!metadata || !Object.prototype.hasOwnProperty.call(entry, metadata.event)) return null;
    if (metadata.event === "receipt" && !/^[0-9a-f]{8}$/.test(metadata.receiptCode ?? "")) return null;
    if (metadata.event === "reminder" && metadata.receiptCode != null) return null;
    const eventTemplate = brandText(entry[metadata.event][lang === "es" ? "es" : "en"]);
    return {
      subject: eventTemplate.subject.replace("{code}", metadata.receiptCode ?? ""),
      body: eventTemplate.body.replace("{code}", metadata.receiptCode ?? ""),
    };
  }
  return brandText(entry[lang === "es" ? "es" : "en"]);
}

// Shoulder rule: a push banner is readable over a shoulder on a lock screen.
// Case/form/vote pushes must not name their topic; email keeps the per-topic
// subject because an inbox sits behind the mail account's own lock. Deadlines,
// tasks and events stay per-topic: the first two are already topic-generic by
// design (see the tasks comment above) and meetings are campaign-wide.
// 'appointments' is push-sensitive too: that a worker has a one-on-one booked
// with an organizer is itself the sensitive fact.
export const PUSH_SENSITIVE_KINDS = new Set(["cases", "forms", "votes", "appointments", "workload"]);
const GENERIC_PUSH = {
  en: { subject: "Something needs your attention", body: "Open Union Ground to see what's new." },
  es: { subject: "Algo requiere tu atención", body: "Abre Union Ground para ver las novedades." },
};
// Same fail-closed gate as templateFor: an ineligible kind stays null/skipped.
export function pushTemplateFor(kind, lang, metadata = null) {
  const base = templateFor(kind, lang, metadata);
  if (!base) return null;
  if (PUSH_SENSITIVE_KINDS.has(kind)) return brandText(GENERIC_PUSH[lang === "es" ? "es" : "en"]);
  return base;
}

function logFailure(scope, detail) {
  console.error(`[notifications-dispatch] ${scope}: ${detail}`);
}

// Third-party exception text is not ours to repeat. web-push embeds the
// configured VAPID contact address in its validation errors, and provider
// bodies can carry a recipient address; both would land in the log and in the
// JSON this handler returns. Reduce anything unrecognised to a stable code.
function safeReason(scope, error) {
  const name = error?.name;
  if (name === "TimeoutError" || name === "AbortError") return `${scope} timeout`;
  if (name === "TypeError") return `${scope} network`;
  return `${scope} error`;
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function normalizedPem(value) {
  return typeof value === "string" ? value.replace(/\\n/g, "\n").trim() : "";
}

export function createApnsJwt({ teamId, keyId, privateKey }, nowSeconds = Math.floor(Date.now() / 1000)) {
  const header = base64Url(JSON.stringify({ alg: "ES256", kid: keyId }));
  const claims = base64Url(JSON.stringify({ iss: teamId, iat: nowSeconds }));
  const unsigned = `${header}.${claims}`;
  const signature = cryptoSign("sha256", Buffer.from(unsigned), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${unsigned}.${base64Url(signature)}`;
}

export function createFcmAssertion(
  { clientEmail, privateKey },
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(JSON.stringify({
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  }));
  const unsigned = `${header}.${claims}`;
  return `${unsigned}.${base64Url(cryptoSign("RSA-SHA256", Buffer.from(unsigned), privateKey))}`;
}

function loadApnsConfiguration(env = process.env) {
  const values = [
    env.APNS_TEAM_ID,
    env.APNS_KEY_ID,
    env.APNS_PRIVATE_KEY,
    env.APNS_BUNDLE_ID,
  ];
  if (values.every((value) => !value)) return { configured: false };
  if (values.some((value) => !value)) throw new Error("apns configuration incomplete");

  const [teamId, keyId, rawPrivateKey, bundleId] = values.map((value) => value.trim());
  if (!/^[A-Z0-9]{10}$/.test(teamId)
      || !/^[A-Z0-9]{10}$/.test(keyId)
      || bundleId !== mobileApplicationId(env)) {
    throw new Error("apns configuration rejected");
  }
  const privateKey = createPrivateKey(normalizedPem(rawPrivateKey));
  if (privateKey.asymmetricKeyType !== "ec") throw new Error("apns configuration rejected");
  const curve = privateKey.asymmetricKeyDetails?.namedCurve;
  if (curve && !["prime256v1", "P-256"].includes(curve)) throw new Error("apns configuration rejected");
  return {
    configured: true,
    teamId,
    keyId,
    privateKey,
    bundleId,
    authenticationToken: null,
    authenticationTokenIssuedAt: 0,
    sessions: new Map(),
  };
}

function loadFcmConfiguration(env = process.env) {
  const raw = env.FCM_SERVICE_ACCOUNT_JSON;
  if (!raw) return { configured: false };
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(raw);
  } catch {
    throw new Error("fcm configuration rejected");
  }
  const projectId = typeof serviceAccount?.project_id === "string" ? serviceAccount.project_id.trim() : "";
  const clientEmail = typeof serviceAccount?.client_email === "string" ? serviceAccount.client_email.trim() : "";
  const privateKeyValue = normalizedPem(serviceAccount?.private_key);
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(projectId)
      || !/^[^\s@]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(clientEmail)
      || !privateKeyValue) {
    throw new Error("fcm configuration rejected");
  }
  const privateKey = createPrivateKey(privateKeyValue);
  if (privateKey.asymmetricKeyType !== "rsa") throw new Error("fcm configuration rejected");
  return {
    configured: true,
    projectId,
    clientEmail,
    privateKey,
    accessToken: null,
    accessTokenPromise: null,
  };
}

function nativeInstallationTargetAllowed(installation) {
  if (!installation || typeof installation !== "object") return false;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(installation.installationId ?? "")) return false;
  if (!/^[0-9a-f]{64}$/.test(installation.tokenHash ?? "")) return false;
  if (installation.targetKey !== `native:${String(installation.installationId).toLowerCase()}`) return false;
  if (installation.provider === "apns") {
    return ["sandbox", "production"].includes(installation.environment)
      && /^[0-9a-f]{32,512}$/.test(installation.token ?? "")
      && installation.token.length % 2 === 0;
  }
  return installation.provider === "fcm"
    && installation.environment === "production"
    && typeof installation.token === "string"
    && installation.token.length >= 20
    && installation.token.length <= 4096
    && !/\s/.test(installation.token);
}

export function nativeInstallationAllowed(installation) {
  return nativeInstallationTargetAllowed(installation)
    && /^[0-9a-f]{64}$/.test(installation.sessionHandle ?? "");
}

async function fetchFcmAccessToken(configuration) {
  if (configuration.accessToken) return configuration.accessToken;
  if (!configuration.accessTokenPromise) {
    configuration.accessTokenPromise = (async () => {
      const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: createFcmAssertion(configuration),
        }).toString(),
        signal: AbortSignal.timeout(PUSH_SEND_TIMEOUT_MS),
      });
      if (!response.ok) throw Object.assign(new Error("fcm oauth rejected"), { statusCode: response.status });
      const payload = await response.json().catch(() => null);
      if (typeof payload?.access_token !== "string" || payload.access_token.length < 20) {
        throw new Error("fcm oauth rejected");
      }
      configuration.accessToken = payload.access_token;
      return configuration.accessToken;
    })().finally(() => {
      configuration.accessTokenPromise = null;
    });
  }
  return configuration.accessTokenPromise;
}

async function sendOneFcm(configuration, installation, template) {
  try {
    const accessToken = await fetchFcmAccessToken(configuration);
    const response = await fetch(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(configuration.projectId)}/messages:send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: {
            token: installation.token,
            notification: { title: template.subject, body: template.body },
            data: { screen: "home" },
            android: {
              priority: "normal",
              ttl: "3600s",
              notification: {
                channel_id: "union-updates",
                visibility: "PRIVATE",
                default_sound: false,
              },
            },
          },
        }),
        signal: AbortSignal.timeout(PUSH_SEND_TIMEOUT_MS),
      },
    );
    if (response.ok) return { ok: true };
    let errorCode = "";
    try {
      const body = await response.json();
      errorCode = body?.error?.details?.find((entry) => entry?.errorCode)?.errorCode ?? "";
    } catch {
      errorCode = "";
    }
    return {
      ok: false,
      terminal: errorCode === "UNREGISTERED",
      statusCode: response.status,
    };
  } catch (error) {
    return { ok: false, terminal: false, statusCode: error?.statusCode ?? 0 };
  }
}

function cachedApnsJwt(configuration, nowSeconds) {
  if (!configuration.authenticationToken
      || nowSeconds < configuration.authenticationTokenIssuedAt
      || nowSeconds - configuration.authenticationTokenIssuedAt >= APNS_AUTH_REFRESH_SECONDS) {
    configuration.authenticationToken = createApnsJwt(configuration, nowSeconds);
    configuration.authenticationTokenIssuedAt = nowSeconds;
  }
  return configuration.authenticationToken;
}

export function createApnsHeaders(
  configuration,
  installation,
  nowSeconds = Math.floor(Date.now() / 1000),
) {
  return {
    [http2Constants.HTTP2_HEADER_METHOD]: "POST",
    [http2Constants.HTTP2_HEADER_PATH]: `/3/device/${installation.token}`,
    authorization: `bearer ${cachedApnsJwt(configuration, nowSeconds)}`,
    "apns-topic": configuration.bundleId,
    "apns-push-type": "alert",
    "apns-priority": "10",
    "apns-expiration": String(nowSeconds + APNS_EXPIRATION_SECONDS),
    "content-type": "application/json",
  };
}

function apnsClient(configuration, origin) {
  const existing = configuration.sessions.get(origin);
  if (existing && !existing.closed && !existing.destroyed) return existing;
  const client = connectHttp2(origin);
  configuration.sessions.set(origin, client);
  const forget = () => {
    if (configuration.sessions.get(origin) === client) configuration.sessions.delete(origin);
  };
  client.on("close", forget);
  // A listener is required to keep a connection-level failure from becoming
  // an uncaught EventEmitter error. Each stream also classifies its own error.
  client.on("error", forget);
  return client;
}

function closeApnsClients(configuration) {
  if (!configuration?.sessions) return;
  for (const client of configuration.sessions.values()) client.close();
  configuration.sessions.clear();
}

export async function sendOneApns(configuration, installation, template) {
  const origin = installation.environment === "sandbox"
    ? "https://api.sandbox.push.apple.com"
    : "https://api.push.apple.com";
  const payload = JSON.stringify({
    aps: {
      alert: { title: template.subject, body: template.body },
      category: "UNION_UPDATE",
      sound: null,
      "thread-id": "union-update",
    },
    screen: "home",
  });

  return new Promise((resolve) => {
    let settled = false;
    let statusCode = 0;
    let responseBody = "";
    let request;
    const client = apnsClient(configuration, origin);
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      // APNs multiplexes sibling sends on this HTTP/2 session. Cancel only the
      // timed-out stream; destroying the client would fail every healthy peer.
      request?.close(http2Constants.NGHTTP2_CANCEL);
      finish({ ok: false, terminal: false, statusCode: 0 });
    }, PUSH_SEND_TIMEOUT_MS);

    try {
      request = client.request(createApnsHeaders(configuration, installation));
    } catch {
      finish({ ok: false, terminal: false, statusCode: 0 });
      return;
    }
    request.setEncoding("utf8");
    request.on("response", (headers) => {
      statusCode = Number(headers[http2Constants.HTTP2_HEADER_STATUS] ?? 0);
    });
    request.on("data", (chunk) => {
      if (responseBody.length < 4096) responseBody += chunk;
    });
    request.on("error", () => finish({ ok: false, terminal: false, statusCode }));
    request.on("close", () => finish({ ok: false, terminal: statusCode === 410, statusCode }));
    request.on("end", () => {
      if (statusCode === 200) {
        finish({ ok: true });
        return;
      }
      let reason = "";
      try {
        reason = JSON.parse(responseBody)?.reason ?? "";
      } catch {
        // Keep the closed default; provider response text is never surfaced.
      }
      finish({
        ok: false,
        terminal: statusCode === 410
          || ["BadDeviceToken", "Unregistered", "DeviceTokenNotForTopic"].includes(reason),
        statusCode,
      });
    });
    request.end(payload);
  });
}

function remainingMs(budget) {
  return budget.limitMs - (Date.now() - budget.startedAt);
}

// How many rows may be claimed such that even the worst case finishes with
// recording time to spare. Returning 0 means "do not claim at all" — claiming
// work this invocation cannot finish is precisely what strands rows.
function affordableRows(budget, perRowMs, cap, concurrency = 1) {
  const usable = remainingMs(budget) - RECORD_RESERVE_MS;
  if (usable <= 0) return 0;
  // Email rows run in parallel, so one worst-case time slice buys one whole
  // concurrency wave. Push rows remain sequential at this level because each
  // row already fans its targets out internally.
  const waves = Math.floor(usable / perRowMs);
  return Math.max(0, Math.min(cap, waves * Math.max(1, concurrency)));
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function run() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

// One bulk call per batch. The per-row version could not survive its own
// arithmetic — 100 sequential round trips at a 20s timeout is far past the
// function ceiling, so a slow database would strand already-sent rows.
// Recording failure is NOT swallowed: an unrecorded send is a future duplicate,
// so it has to surface.
async function recordResults(supabaseUrl, serviceKey, results) {
  if (!results.length) return { applied: 0, ignored: 0 };
  // One retry. The provider has already accepted these messages, so the choice
  // on a transient database error is between one more round trip now and a
  // guaranteed duplicate send after the watchdog reclaim.
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await supabaseRpc(
        supabaseUrl,
        serviceKey,
        serviceKey,
        "record_notification_delivery_results",
        { p_results: results },
        { timeoutMs: RECORD_TIMEOUT_MS },
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

// The recorder answers with what it applied and what it ignored as stale — a
// result whose lease had already moved on. Both channels fold that in the same
// way, at the same point: once results are written, the batch is accounted for.
function applyRecorded(summary, recorded) {
  summary.recorded += recorded?.applied ?? 0;
  summary.staleResults += recorded?.ignored ?? 0;
}

// A claimed row is only usable if it carries the lease the recorder will match
// on. A missing `attempt` would be dropped from the JSON and silently ignored
// by the recorder; an explicit null aborts the whole record call. Either way
// the row stays 'sending' and is re-sent later — so reject the batch BEFORE
// contacting a provider rather than after.
function leaseIsValid(row) {
  return typeof row?.deliveryId === "string"
    && row.deliveryId.length > 0
    && Number.isInteger(row?.attempt)
    && row.attempt > 0
    && Number.isSafeInteger(row?.leaseEpoch)
    && row.leaseEpoch > 0;
}

// Nothing may be sent from a batch whose results cannot be recorded, so the
// WHOLE batch is refused on the first bad lease. Exported because this is the
// one control both channels rely on to keep a malformed claim away from a
// provider, and it deserves a test that does not need a live queue.
export function assertLeases(scope, rows) {
  const malformed = rows.filter((row) => !leaseIsValid(row));
  if (!malformed.length) return;
  logFailure(scope, `claim returned ${malformed.length} row(s) without a usable lease`);
  throw new Error("claim returned rows without a usable lease");
}

function resultFor(row, status, providerMessageId, error, deliveredTargetKeys = []) {
  return {
    deliveryId: row.deliveryId,
    attempt: row.attempt,
    leaseEpoch: row.leaseEpoch,
    status,
    providerMessageId: providerMessageId ?? null,
    error: error ?? null,
    ...(deliveredTargetKeys.length ? { deliveredTargetKeys } : {}),
  };
}

// The database constrains stored endpoints to this same host set, but the
// dispatcher is what actually makes the request, and it must not depend on a
// constraint in another system holding. A row restored from a backup taken
// before that constraint existed, or written by any future path that bypasses
// it, would otherwise have this service-role function POST wherever it says.
const PUSH_HOST_SUFFIXES = [
  "googleapis.com",
  "push.services.mozilla.com",
  "notify.windows.com",
  "push.apple.com",
];

export function pushEndpointAllowed(endpoint) {
  if (typeof endpoint !== "string" || !endpoint) return false;
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function webPushTargetAllowed(subscription) {
  if (!pushEndpointAllowed(subscription?.endpoint)) return false;
  const expectedTargetKey = `web:${createHash("sha256").update(subscription.endpoint).digest("hex")}`;
  return subscription?.targetKey === expectedTargetKey;
}

async function claimBatch(supabaseUrl, serviceKey, channel, limit) {
  const rows = await supabaseRpc(
    supabaseUrl,
    serviceKey,
    serviceKey,
    "claim_notification_deliveries",
    { p_channel: channel, p_limit: limit },
    { timeoutMs: CLAIM_TIMEOUT_MS },
  );
  return Array.isArray(rows) ? rows : [];
}

// Resend deduplicates identical Idempotency-Key values for 24h.
//
// The key is derived from the delivery id ALONE — deliberately not the attempt,
// and not the batch. The retry that matters is exactly the ambiguous one: the
// provider accepted the message but the response never arrived, the row was
// recorded failed (or left to the watchdog), and a later invocation picks it up
// on a new attempt. Folding the attempt into the key would hand Resend a key it
// has never seen and send the member a second copy — the deduplication window
// would only ever cover retries that could not happen. Keying on the batch
// membership was worse again: two invocations that claim overlapping-but-
// different sets produce different keys for the same message.
//
// One delivery row means one member sees one message, so the delivery id is the
// correct identity, and Resend's 24h window comfortably covers the 48h queue's
// realistic retry span (the backoff caps at 60 minutes).
export function idempotencyKey(deliveryId) {
  return `sg-notify-${createHash("sha256").update(String(deliveryId)).digest("hex").slice(0, 48)}`;
}

// One request per delivery rather than one batch request.
//
// The batch endpoint returns a single 2xx for the whole set, which forces an
// all-or-nothing reading: a body that accepted three of four messages has to be
// treated as a total failure, and the retry then re-sends the three that were
// already accepted. Per-message sends give each delivery its own definitive
// outcome and let the per-delivery Idempotency-Key actually do its job. The
// cost is N requests instead of one, which EMAIL_CONCURRENCY absorbs.
async function sendOneEmail(resendKey, from, appUrl, row, template) {
  const address = Object.hasOwn(row, "postalAddress") ? organizationFooterAddress(row.postalAddress) : ORG_POSTAL_ADDRESS;
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey(row.deliveryId),
      },
      // Generic constants, or the authorized event source projection only.
      // renderEmail escapes the bounded source title in every HTML context;
      // notification title/body remain unavailable to provider copy.
      body: JSON.stringify({
        from,
        to: [row.email],
        subject: template.subject,
        text: renderText({ body: template.body, appUrl, lang: row.lang, address }),
        html: renderEmail({
          kind: row.kind,
          lang: row.lang,
          subject: template.subject,
          body: template.body,
          appUrl,
          address,
        }),
        headers: {
          // One-click unsubscribe is a Gmail/Yahoo bulk requirement and the
          // honest affordance either way. Pointed at the settings route until
          // an unsubscribe endpoint exists — built by the same function the
          // footer link uses, because appUrl already ends in /m and writing
          // the path twice is how one of them ends up /m/m/settings.
          "List-Unsubscribe": `<${settingsUrlFor(appUrl)}>`,
        },
      }),
      signal: AbortSignal.timeout(EMAIL_SEND_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, reason: `resend http ${response.status}`, status: response.status };
    let id = null;
    try {
      id = JSON.parse(await response.text())?.id ?? null;
    } catch {
      id = null;
    }
    // A 2xx with no usable id still means Resend accepted it; the id is only
    // used for tracing, so this must not be turned into a resend.
    return { ok: true, id: typeof id === "string" ? id : null };
  } catch (error) {
    return { ok: false, reason: safeReason("resend", error), status: 0 };
  }
}

async function dispatchEmailBatch(supabaseUrl, serviceKey, resendKey, from, appUrl, summary, budget) {
  const limit = affordableRows(budget, EMAIL_ROW_WORST_CASE_MS, EMAIL_BATCH, EMAIL_CONCURRENCY);
  // Reaching the deliberately smaller email share is normal throttling. No row
  // was claimed or deferred, so this must not turn an otherwise healthy tick
  // red. Push uses the remaining shared invocation clock below.
  if (limit < 1) return { handled: 0, exhausted: true, deadlineReached: false };
  const rows = await claimBatch(supabaseUrl, serviceKey, "email", limit);
  if (!rows.length) return { handled: 0, exhausted: false, deadlineReached: false };
  summary.claimed += rows.length;

  assertLeases("email", rows);

  const results = [];
  const sendable = [];
  for (const row of rows) {
    const template = templateFor(row.kind, row.lang, row);
    if (!template) {
      summary.skipped += 1;
      results.push(resultFor(row, "skipped", null, "kind is not outbound-eligible"));
    } else if (!row.email) {
      summary.skipped += 1;
      results.push(resultFor(row, "skipped", null, "no email address"));
    } else {
      sendable.push({ row, template });
    }
  }

  let providerFailures = 0;
  let providerAttempts = 0;
  let deferredInBatch = 0;
  await mapWithConcurrency(sendable, EMAIL_CONCURRENCY, async ({ row, template }) => {
    // A claim can start within the email share and still reach this worker
    // after siblings consumed it. Return untouched rows to pending instead of
    // starting a send that would consume push's reserved row and record window.
    if (remainingMs(budget) < EMAIL_ROW_WORST_CASE_MS + RECORD_RESERVE_MS) {
      deferredInBatch += 1;
      summary.deferred += 1;
      results.push(resultFor(row, "deferred", null, "deferred: email channel budget"));
      return null;
    }
    if (row.kind === "events") {
      let projection;
      try {
        projection = await supabaseRpc(supabaseUrl, serviceKey, serviceKey,
          "get_event_notification_email", {
            p_delivery_id: row.deliveryId, p_attempt: row.attempt,
            p_lease_epoch: row.leaseEpoch, p_email: row.email,
          }, { timeoutMs: EVENT_EMAIL_AUTHORIZATION_TIMEOUT_MS });
      } catch {
        // Missing migration, timeout or RPC refusal never authorizes fallback.
        deferredInBatch += 1;
        summary.deferred += 1;
        results.push(resultFor(row, "deferred", null, "event email authorization unavailable"));
        return null;
      }
      if (projection?.status === "generic" && eventEmailLeaseMatches(projection, row)) {
        template = templateFor("events", projection.lang);
      } else {
        template = eventEmailTemplate(projection, row);
      }
      if (!template) {
        summary.skipped += 1;
        results.push(resultFor(row, "skipped", null, "event email not authorized"));
        return null;
      }
      row = { ...row, lang: projection.lang };
    }
    providerAttempts += 1;
    const outcome = await sendOneEmail(resendKey, from, appUrl, row, template);
    if (outcome.ok) {
      summary.sent += 1;
      results.push(resultFor(row, "sent", outcome.id, null));
    } else {
      providerFailures += 1;
      summary.failed += 1;
      logFailure("email", outcome.reason);
      results.push(resultFor(row, "failed", null, outcome.reason));
    }
    return null;
  });

  // Every send failing is a provider-level problem (revoked key, outage), not
  // per-message bad luck, and the handler must not report a healthy tick. Keep
  // the counters on the invocation summary rather than latching the result of
  // one batch: a later successful batch proves that the provider is reachable.
  // Budget deferrals never reached Resend, so they are not provider attempts.
  // Counting them in the denominator can make an all-failed provider batch
  // look healthy when a later claimed batch is returned to pending untouched.
  summary.providerAttemptedRows += providerAttempts;
  summary.providerFailedRows += providerFailures;
  summary.providerDown = summary.providerAttemptedRows > 0
    && summary.providerFailedRows === summary.providerAttemptedRows;

  applyRecorded(summary, await recordResults(supabaseUrl, serviceKey, results));
  return {
    handled: rows.length,
    exhausted: deferredInBatch > 0 || rows.length < limit,
    deadlineReached: false,
  };
}

async function pruneSubscription(supabaseUrl, serviceKey, endpoint) {
  try {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/member_push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`,
      {
        method: "DELETE",
        // count=exact is what makes a no-op DELETE distinguishable. PostgREST
        // answers a filter that matched nothing with the same 2xx it uses for
        // a real delete, so without the count this function reports success
        // for an endpoint it did not remove.
        headers: supabaseHeaders(serviceKey, serviceKey, { Prefer: "return=minimal,count=exact" }),
        signal: AbortSignal.timeout(PRUNE_TIMEOUT_MS),
      },
    );
    // Counting a prune that did not happen would report a self-healing queue
    // that is in fact re-sending to the same dead endpoint every time.
    if (!response.ok) {
      logFailure("prune", `http ${response.status}`);
      return false;
    }
    // Content-Range is "*/N" (or "0-0/N") — the affected count is after the
    // slash. A zero here means the row was already gone or the filter never
    // matched: the DELETE worked, nothing was pruned, and summary.pruned must
    // not claim otherwise.
    const affected = Number(String(response.headers?.get?.("content-range") || "").split("/")[1]);
    if (!Number.isFinite(affected)) {
      logFailure("prune", "no count returned");
      return false;
    }
    if (affected < 1) {
      logFailure("prune", "miss");
      return false;
    }
    return true;
  } catch {
    logFailure("prune", "network");
    return false;
  }
}

async function pruneNativeInstallation(supabaseUrl, serviceKey, installation) {
  try {
    return await supabaseRpc(
      supabaseUrl,
      serviceKey,
      serviceKey,
      "prune_native_push_installation",
      {
        p_installation_id: installation.installationId,
        p_provider: installation.provider,
        p_environment: installation.environment,
        p_token_hash: installation.tokenHash,
      },
      { timeoutMs: PRUNE_TIMEOUT_MS },
    ) === true;
  } catch {
    logFailure("native-prune", "rpc error");
    return false;
  }
}

async function sendOnePush(webpush, sub, payload) {
  // web-push has no AbortSignal. Its own `timeout` covers the socket; the race
  // is the backstop for a peer that accepts TLS and then simply never answers,
  // which is otherwise indistinguishable from a slow push service and would
  // hold the whole invocation until Vercel kills it.
  //
  // KNOWN LIMITATION, not an oversight: losing the race does not cancel the
  // underlying request, so a push that completes after the timeout can still be
  // delivered while we have already recorded the row as failed — and the retry
  // then delivers a second copy. web-push exposes no way to destroy the socket,
  // and unlike email there is no provider-side idempotency key for push. The
  // exposure is bounded and cheap: the payload is a generic per-topic template
  // with no member text, so the worst case is one duplicate banner. Promise.race
  // does observe the late rejection, so it cannot surface as an unhandled
  // rejection. Fixing this properly means replacing the transport — and it will
  // stay that way: web-push's last release is 3.6.7 (2024-01-16), so there is no
  // upstream fix to wait for. Do not treat this comment as a pending upgrade.
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("push timeout"), { statusCode: 0 })), PUSH_SEND_TIMEOUT_MS);
  });
  try {
    await Promise.race([
      webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload,
        { TTL: 3600, timeout: PUSH_SEND_TIMEOUT_MS },
      ),
      guard,
    ]);
    return { ok: true };
  } catch (error) {
    return { ok: false, statusCode: error?.statusCode ?? 0 };
  } finally {
    clearTimeout(timer);
  }
}

async function dispatchPushBatch(supabaseUrl, serviceKey, providers, summary, budget) {
  const batchCap = Number.isInteger(budget.batchSize)
    ? Math.max(1, Math.min(PUSH_BATCH, budget.batchSize))
    : PUSH_BATCH;
  const limit = affordableRows(budget, PUSH_ROW_WORST_CASE_MS, batchCap);
  // No row was claimed or deferred. Exhausting the deliberately bounded push
  // share after a successful full batch is healthy throttling, just as it is
  // for email. A claimed row that cannot finish still reports the deadline via
  // summary.deferred below.
  if (limit < 1) return { handled: 0, exhausted: true, deadlineReached: false };
  const rows = await claimBatch(supabaseUrl, serviceKey, "push", limit);
  if (!rows.length) return { handled: 0, exhausted: false, deadlineReached: false };
  summary.claimed += rows.length;

  assertLeases("push", rows);

  const results = [];
  let providerAttemptedRows = 0;
  let providerFailedRows = 0;
  for (const row of rows) {
    // The deadline is checked HERE, per row, not once before the batch. A batch
    // that starts inside the budget can still run far past it — twenty-five rows
    // of ten endpoints is minutes of worst case — and being killed mid-batch is
    // the bad outcome: the rows are already 'sending', the sends already
    // happened, and nothing was recorded, so the watchdog re-sends every one of
    // them to real members.
    if (remainingMs(budget) < PUSH_ROW_WORST_CASE_MS + RECORD_RESERVE_MS) {
      // Hand the untouched rows straight back rather than abandoning them: a
      // deferred result under a valid lease returns the row to pending without
      // burning an attempt, with the same 15-minute delay as the watchdog.
      summary.deferred += 1;
      results.push(resultFor(row, "deferred", null, "deferred: invocation budget"));
      continue;
    }
    const template = pushTemplateFor(row.kind, row.lang, row);
    if (!template) {
      summary.skipped += 1;
      results.push(resultFor(row, "skipped", null, "kind is not outbound-eligible"));
      continue;
    }
    const claimedSubscriptions = Array.isArray(row.subscriptions) ? row.subscriptions : [];
    const subscriptions = claimedSubscriptions.filter(webPushTargetAllowed);
    const malformedSubscriptions = claimedSubscriptions.length - subscriptions.length;
    const claimedNative = Array.isArray(row.nativeInstallations) ? row.nativeInstallations : [];
    // A separately gated SQL rollout can lag this source deployment. The old
    // claim has valid native metadata but no session handle. Defer the whole
    // delivery before any send so mixed web/native failures cannot burn its
    // native retries; never submit an unbound legacy token to a provider.
    if (claimedNative.some(installation => nativeInstallationTargetAllowed(installation)
      && !Object.hasOwn(installation, "sessionHandle"))) {
      summary.configurationDeferred += 1;
      if (!summary.unavailableProviders.includes("native-schema")) {
        summary.unavailableProviders.push("native-schema");
      }
      results.push(resultFor(row, "deferred", null, "native claim schema unavailable"));
      continue;
    }
    const nativeInstallations = claimedNative.filter(nativeInstallationAllowed);
    const malformedNative = claimedNative.length - nativeInstallations.length;
    if (!subscriptions.length && !nativeInstallations.length
        && malformedSubscriptions === 0 && malformedNative === 0) {
      summary.skipped += 1;
      results.push(resultFor(row, "skipped", null, "no usable push subscriptions"));
      continue;
    }
    const payload = JSON.stringify({ title: template.subject, body: template.body, url: "/m" });

    const targets = [
      ...subscriptions.map((subscription) => ({ kind: "web", subscription })),
      ...nativeInstallations.map((installation) => ({ kind: "native", installation })),
    ];
    const outcomes = await mapWithConcurrency(targets, PUSH_CONCURRENCY, async (target) => {
      if (target.kind === "web") {
        if (!providers.web) return { deferred: true, provider: "web", statusCode: 503 };
        const outcome = await sendOnePush(providers.web, target.subscription, payload);
        if (!outcome.ok && (outcome.statusCode === 404 || outcome.statusCode === 410)) {
          const pruned = await pruneSubscription(supabaseUrl, serviceKey, target.subscription.endpoint);
          if (pruned) {
            summary.pruned += 1;
            return { dead: true, providerAttempted: true, providerFailure: false };
          }
          return {
            retryable: true, statusCode: 503, providerAttempted: true,
            providerFailure: false, cleanupFailure: true,
          };
        }
        return outcome.ok
          ? {
              delivered: true, targetKey: target.subscription.targetKey,
              providerAttempted: true, providerFailure: false,
            }
          : {
              retryable: true, statusCode: outcome.statusCode,
              providerAttempted: true, providerFailure: true,
            };
      }

      const installation = target.installation;
      const configuration = providers[installation.provider];
      if (!configuration) return { deferred: true, provider: installation.provider, statusCode: 503 };
      // Recheck the exact claimed installation and lease at the last server
      // boundary before provider submission. Missing/ambiguous RPC answers
      // defer rather than sending a token retained from an earlier claim.
      let authorized;
      try {
        authorized = await supabaseRpc(supabaseUrl, serviceKey, serviceKey,
          "authorize_native_push_dispatch", {
            p_delivery_id: row.deliveryId, p_attempt: row.attempt,
            p_lease_epoch: row.leaseEpoch, p_installation_id: installation.installationId,
            p_provider: installation.provider, p_environment: installation.environment,
            p_token_hash: installation.tokenHash, p_session_handle: installation.sessionHandle,
          }, { timeoutMs: NATIVE_AUTHORIZATION_TIMEOUT_MS });
      } catch {
        return { deferred: true, provider: installation.provider, statusCode: 503 };
      }
      if (authorized === false) return { dead: true, providerAttempted: false, providerFailure: false };
      if (authorized !== true) return { deferred: true, provider: installation.provider, statusCode: 503 };
      const outcome = installation.provider === "apns"
        ? await sendOneApns(configuration, installation, template)
        : await sendOneFcm(configuration, installation, template);
      if (!outcome.ok && outcome.terminal) {
        const pruned = await pruneNativeInstallation(supabaseUrl, serviceKey, installation);
        if (pruned) {
          summary.pruned += 1;
          return { dead: true, providerAttempted: true, providerFailure: false };
        }
        return {
          retryable: true, statusCode: 503, providerAttempted: true,
          providerFailure: false, cleanupFailure: true,
        };
      }
      return outcome.ok
        ? {
            delivered: true, targetKey: installation.targetKey,
            providerAttempted: true, providerFailure: false,
          }
        : {
            retryable: true, statusCode: outcome.statusCode,
            providerAttempted: true, providerFailure: true,
          };
    });
    if (malformedSubscriptions > 0) {
      outcomes.push({ retryable: true, statusCode: 422, providerFailure: false, invalidTarget: true });
    }
    if (malformedNative > 0) {
      outcomes.push({ retryable: true, statusCode: 422, providerFailure: false, invalidTarget: true });
    }

    const deliveredTargetKeys = outcomes.filter((o) => o?.delivered).map((o) => o.targetKey);
    const retryable = outcomes.filter((o) => o?.retryable);
    const configurationDeferred = outcomes.filter((o) => o?.deferred);
    const malformed = retryable.find((o) => o.statusCode === 422);
    const providerFailure = retryable.find((o) => o.providerFailure !== false);
    if (outcomes.some((o) => o?.cleanupFailure)) summary.cleanupFailed = true;
    summary.invalidTargets += outcomes.filter((o) => o?.invalidTarget).length;
    const providerOutcomes = outcomes.filter((o) => o?.providerAttempted);
    if (providerOutcomes.length > 0) {
      providerAttemptedRows += 1;
      if (providerOutcomes.every((o) => o.providerFailure === true)) providerFailedRows += 1;
    }
    for (const outcome of configurationDeferred) {
      if (!summary.unavailableProviders.includes(outcome.provider)) {
        summary.unavailableProviders.push(outcome.provider);
      }
    }
    if (malformed && !providerFailure) {
      const reason = "push failed: 422";
      logFailure("push", reason);
      summary.failed += 1;
      results.push(resultFor(row, "failed", null, reason, deliveredTargetKeys));
    } else if (retryable.length > 0) {
      const reasonOutcome = providerFailure ?? retryable[0];
      const reason = `push failed: ${reasonOutcome.statusCode || "timeout"}`;
      logFailure("push", reason);
      summary.failed += 1;
      results.push(resultFor(row, "failed", null, reason, deliveredTargetKeys));
    } else if (configurationDeferred.length > 0) {
      summary.configurationDeferred += 1;
      results.push(resultFor(
        row,
        "deferred",
        null,
        `provider unavailable: ${configurationDeferred[0].provider}`,
        deliveredTargetKeys,
      ));
    } else if (deliveredTargetKeys.length > 0) {
      summary.sent += 1;
      results.push(resultFor(row, "sent", null, null, deliveredTargetKeys));
    } else {
      summary.skipped += 1;
      results.push(resultFor(row, "skipped", null, "all push endpoints expired"));
    }
  }

  // Aggregate across every claimed batch in this invocation. Latching a true
  // result from one full batch would leave the tick red even when a later batch
  // successfully reached a provider.
  summary.providerAttemptedRows += providerAttemptedRows;
  summary.providerFailedRows += providerFailedRows;
  summary.providerDown = summary.providerAttemptedRows > 0
    && summary.providerFailedRows === summary.providerAttemptedRows;

  applyRecorded(summary, await recordResults(supabaseUrl, serviceKey, results));
  return {
    handled: rows.length,
    exhausted: summary.deferred > 0 || rows.length < limit,
    deadlineReached: summary.deferred > 0,
  };
}

function emptySummary(extra = {}) {
  return {
    configured: true, claimed: 0, sent: 0, failed: 0, skipped: 0,
    recorded: 0, staleResults: 0, deferred: 0, configurationDeferred: 0,
    unavailableProviders: [], providerDown: false, cleanupFailed: false,
    providerAttemptedRows: 0, providerFailedRows: 0,
    invalidTargets: 0, ...extra,
  };
}

// Both channels drive their batch function identically: keep claiming while a
// full batch keeps coming back, stop as soon as one comes back short, and note
// deadlineReached when the budget — not an empty queue — is what stopped it.
async function runChannel(scope, summary, budget, runBatch) {
  try {
    const maxBatches = Number.isInteger(budget.maxBatches)
      ? Math.max(1, budget.maxBatches)
      : Number.POSITIVE_INFINITY;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const { handled, exhausted, deadlineReached } = await runBatch(summary, budget);
      if (deadlineReached) summary.deadlineReached = true;
      if (!handled) {
        break;
      }
      if (exhausted) break;
      if (batch + 1 === maxBatches) summary.batchLimitReached = true;
    }
  } catch (error) {
    // Errors reaching here are ours (an RPC name, a lease rejection), not
    // provider text — sendOneEmail and the VAPID setup already reduce anything
    // third-party to a code, so this keeps the operator-useful detail.
    summary.error = String(error?.message || error);
    logFailure(scope, summary.error);
  }
  return summary;
}

async function dispatchEmail(supabaseUrl, serviceKey, budget) {
  const resendKey = process.env.RESEND_API_KEY;
  const from = process.env.NOTIFY_FROM_ADDRESS;
  // Email is unconfigured without an owner-set https .../m link: there is no
  // default product URL to fall back on.
  const appUrl = configuredAppUrl();
  if (!resendKey || !from || !appUrl) return { configured: false };

  return runChannel("email", emptySummary(), budget, (batchSummary, batchBudget) =>
    dispatchEmailBatch(supabaseUrl, serviceKey, resendKey, from, appUrl, batchSummary, batchBudget));
}

async function dispatchPush(supabaseUrl, serviceKey, budget, nativeEnv = process.env) {
  const publicKey = process.env.VITE_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  // No default contact: a sibling product's address must never be sent to a
  // push service. Web push without VAPID_CONTACT is incomplete configuration.
  const contact = process.env.VAPID_CONTACT;
  const providers = { web: null, apns: null, fcm: null };
  const attempted = {
    web: Boolean(publicKey || privateKey),
    apns: [nativeEnv.APNS_TEAM_ID, nativeEnv.APNS_KEY_ID,
      nativeEnv.APNS_PRIVATE_KEY, nativeEnv.APNS_BUNDLE_ID].some(Boolean),
    fcm: Boolean(nativeEnv.FCM_SERVICE_ACCOUNT_JSON),
  };
  const degradedProviders = [];

  // Validate providers independently before claiming. A malformed native
  // credential must not take the working web transport down with it.
  try {
    if (publicKey || privateKey) {
      if (!publicKey || !privateKey || !contact) throw new Error("vapid configuration incomplete");
      const module = await import("web-push");
      providers.web = module.default ?? module;
      providers.web.setVapidDetails(contact, publicKey, privateKey);
    }
  } catch {
    degradedProviders.push("web");
    providers.web = null;
  }
  try {
    const apns = loadApnsConfiguration(nativeEnv);
    providers.apns = apns.configured ? apns : null;
  } catch {
    degradedProviders.push("apns");
  }
  try {
    const fcm = loadFcmConfiguration(nativeEnv);
    providers.fcm = fcm.configured ? fcm : null;
  } catch {
    degradedProviders.push("fcm");
  }

  if (degradedProviders.length) logFailure("push", "push provider configuration rejected");
  if (!providers.web && !providers.apns && !providers.fcm) {
    if (Object.values(attempted).some(Boolean)) {
      return { configured: true, error: "push provider configuration rejected", degradedProviders };
    }
    return { configured: false };
  }

  let stalePruned = 0;
  let staleCleanupFailed = false;
  if (providers.apns || providers.fcm) {
    try {
      stalePruned = Number(await supabaseRpc(
        supabaseUrl,
        serviceKey,
        serviceKey,
        "prune_stale_native_push_installations",
        {
          p_before: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
          p_limit: 100,
        },
        { timeoutMs: PRUNE_TIMEOUT_MS },
      )) || 0;
    } catch {
      staleCleanupFailed = true;
      logFailure("push", "native stale-token cleanup failed");
    }
  }

  try {
    return await runChannel(
      "push",
      emptySummary({ pruned: 0, stalePruned, staleCleanupFailed, degradedProviders }),
      budget,
      (batchSummary, batchBudget) =>
        dispatchPushBatch(supabaseUrl, serviceKey, providers, batchSummary, batchBudget),
    );
  } finally {
    closeApnsClients(providers.apns);
  }
}

// A channel that has work waiting but no provider configured is not "fine" —
// its rows sit until they expire 48 hours later and nobody is told. Ask the
// database whether each unconfigured channel has a queue.
async function pendingByChannel(supabaseUrl, serviceKey) {
  try {
    const rows = await supabaseRpc(
      supabaseUrl, serviceKey, serviceKey,
      "get_notification_dispatch_health", {}, { timeoutMs: CLAIM_TIMEOUT_MS },
    );
    const health = Array.isArray(rows) ? rows[0] : rows;
    return {
      email: Number(health?.queue?.pending_email ?? 0),
      push: Number(health?.queue?.pending_push ?? 0),
    };
  } catch {
    return null;
  }
}

// Retention runs first on every tick, with no time check, provider or not.
// Without a mail provider nothing is claimed. With one, a claim that cannot be
// made or a send the provider refuses raises the private account-mail alert.
// Claimed rows that do not fit before the deadline wait for their two-minute
// lease and go on a later tick.
async function sweepAccountNotices(supabaseUrl, serviceKey, startedAt, clock = Date.now) {
  const sweepStartedAt = clock();
  // Its own share from now, never past the reserved window's end.
  const deadline = Math.min(sweepStartedAt + ACCOUNT_NOTICE_BUDGET_MS, startedAt + INVOCATION_BUDGET_MS + ACCOUNT_NOTICE_RESERVE_MS);
  await purgeAccountNotices({ url: supabaseUrl, serviceKey });
  const resendKey = String(process.env.RESEND_API_KEY || "").trim();
  const from = String(process.env.NOTIFY_FROM_ADDRESS || "").trim();
  if (!resendKey || !from) return;
  const delivery = await deliverAccountNotices({
    url: supabaseUrl, serviceKey, resendKey, from, userId: null, limit: ACCOUNT_NOTICE_BATCH, deadline, clock,
  });
  if (delivery.unavailable || delivery.failed > 0) recordAccountMailFailure("recovery_notice_send_failed");
}

export default async function handler(request, response) {
  if (!validateMutationOrigin(request)) return json(response, 403, { error: "untrusted-origin" });
  if (methodGuard(request, ["GET", "POST"], () => json(response, 405, { error: "method not allowed" }))) return;
  // Fail closed: an absent, under-strength or placeholder CRON_SECRET
  // authorizes nobody. This endpoint can mail every member in the chapter, so
  // it holds the one shared rule in api/_lib/cronAuth.js.
  const cron = cronAuthorization(request);
  if (!cron.ok) {
    json(response, cron.status, cronRefusalBody(cron));
    return;
  }
  // The one Union Ground provider, validated by the provider contract. With
  // no provisioned project this answers not configured and touches nothing.
  const { ok: providerValid, supabaseUrl, serviceRoleKey: serviceKey } = unionGroundProvider();
  if (process.env.NOTIFY_KILL_SWITCH === "1") {
    // The switch holds delivery, not retention: account-notice rows and their
    // addresses still go after seven days.
    if (providerValid && supabaseUrl && serviceKey) await purgeAccountNotices({ url: supabaseUrl, serviceKey });
    json(response, 200, { disabled: true });
    return;
  }
  if (requireEnv([providerValid, supabaseUrl, serviceKey], () => json(response, 503, { error: "not configured" }))) return;

  const startedAt = Date.now();

  // Runs whatever the channel configuration says. An unconfigured or
  // switched-off channel never claims, so a queue that only aged out during a
  // claim would grow without bound.
  let expired = null;
  let expiryError = null;
  try {
    expired = await supabaseRpc(supabaseUrl, serviceKey, serviceKey, "expire_notification_deliveries", {}, { timeoutMs: CLAIM_TIMEOUT_MS });
  } catch (error) {
    expiryError = String(error?.message || error);
    logFailure("expire", expiryError);
  }

  // Email runs first and is capped so a large mail backlog still leaves one
  // worst-case push row plus the result-recording reserve in every tick.
  const email = await dispatchEmail(supabaseUrl, serviceKey, {
    startedAt,
    limitMs: EMAIL_BUDGET_MS,
  });
  const push = await dispatchPush(supabaseUrl, serviceKey, { startedAt, limitMs: INVOCATION_BUDGET_MS });

  // Account-security email (a used recovery code) is queued in the commit that
  // caused it and normally sent by that route at once; this sends whatever is
  // still due, such as after a lost reply. It runs after both channels, in its
  // reserved window after the invocation budget, and never throws.
  await sweepAccountNotices(supabaseUrl, serviceKey, startedAt);

  const body = { expired, email, push, elapsedMs: Date.now() - startedAt };

  // A cron that always reports success is a cron nobody watches. Anything that
  // stopped delivery from working has to come back non-2xx so it shows up in
  // Vercel logs and in net._http_response, which is what
  // get_notification_dispatch_health() reads.
  if (expiryError || email.error || push.error) {
    json(response, 500, { ...body, error: expiryError || email.error || push.error });
    return;
  }
  if (email.deadlineReached || push.deadlineReached) {
    const channels = [email.deadlineReached ? "email" : null, push.deadlineReached ? "push" : null]
      .filter(Boolean)
      .join(", ");
    json(response, 502, { ...body, error: `dispatch deadline reached: ${channels}` });
    return;
  }
  if (push.degradedProviders?.length || push.unavailableProviders?.length
      || push.staleCleanupFailed || push.cleanupFailed || push.invalidTargets > 0) {
    const unavailable = [...new Set([
      ...(push.degradedProviders ?? []),
      ...(push.unavailableProviders ?? []),
    ])];
    const degraded = [
      unavailable.length ? `provider(s) ${unavailable.join(", ")}` : null,
      push.staleCleanupFailed || push.cleanupFailed ? "stale-token cleanup" : null,
      push.invalidTargets > 0 ? "malformed target data" : null,
    ].filter(Boolean).join(", ");
    json(response, 502, { ...body, error: `push degraded: ${degraded}` });
    return;
  }
  if (email.providerDown || push.providerDown) {
    json(response, 502, {
      ...body,
      error: `every ${email.providerDown ? "email" : "push"} send in this tick failed`,
    });
    return;
  }
  if (!email.configured && !push.configured) {
    json(response, 503, { ...body, error: "no outbound provider configured" });
    return;
  }
  // One channel configured and the other not is only healthy while the
  // unconfigured one has nothing waiting. The enqueue trigger does not know
  // which providers exist, so it will happily queue email for a deployment that
  // has no Resend key — and those rows would sit silently until they expired.
  const unconfigured = [];
  if (!email.configured) unconfigured.push("email");
  if (!push.configured) unconfigured.push("push");
  if (unconfigured.length) {
    const pending = await pendingByChannel(supabaseUrl, serviceKey);
    const stranded = unconfigured.filter((channel) => (pending?.[channel] ?? 0) > 0);
    if (stranded.length) {
      json(response, 503, {
        ...body,
        error: `queued work for unconfigured channel(s): ${stranded.join(", ")}`,
      });
      return;
    }
  }
  json(response, 200, body);
}
