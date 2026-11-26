#!/usr/bin/env node
// Operator-only: start a new organization by inviting its founder.
//
// Accounts are invitation-only, and an organization administrator can only
// invite people into an organization that already exists. This command is the
// way for the operator of a deployment to start a further one: it creates the
// organization and its default chapter and emails the founder the ordinary
// one-time invitation. Accepting it creates the founder's account and makes
// them the organization's first administrator; they invite everyone else.
//
//   node --env-file=<production env file> scripts/invite-organization-founder.mjs create \
//     --organization "Example Workers Union" --email founder@example.org \
//     --name "Founder Full Name" [--locale en|es] [--key <uuid>] [--dry-run]
//   node --env-file=<production env file> scripts/invite-organization-founder.mjs resend \
//     --invitation <invitation id> [--dry-run]
//
//   node --env-file=<production env file> scripts/invite-organization-founder.mjs from-request \
//     --request <partner invitation request id> [--organization "Name"] [--decline] [--dry-run]
//
// from-request sends the founder invitation a chapter asked for from its
// "offices not yet on Union Ground" panel: the contact, language and office
// come from the request, the organization is named after the catalogue office
// unless --organization says otherwise, and the email names the asking
// chapter and its standing offer. The request id is the idempotency key, so a
// rerun never starts a second organization. --decline records that Union
// Ground will not send it. Either way the contact's name and address are
// erased from the request and the chapter is told.
//
// Needs SUPABASE_URL (or VITE_SUPABASE_URL), RESEND_API_KEY,
// NOTIFY_FROM_ADDRESS and INVITATION_APP_ORIGIN. The backend must pass the
// API's one provider rule (api/_lib/providerBoundary.js) before any request. With SUPABASE_SERVICE_ROLE_KEY
// empty or unset, the server key is the project's secret key read through the
// Management API (scripts/lib/supabase-server-key.mjs; SUPABASE_SERVER_KEY_NAME
// picks one during a rotation). A dry run writes nothing; with a complete
// environment it also resolves the key and prints the key's fingerprint. The link is valid for
// 15 minutes. It prints ids only, never the link, the secret or a key.
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { supabaseRpc } from "../api/_lib/http.js";
import { productionProviderDecision } from "../api/_lib/providerBoundary.js";
import { digest, invitationSecret, invitationUrl, sendInvitationEmail, UUID } from "../api/_lib/memberInvitations.js";
import { describeServerKey, resolveServerKey } from "./lib/supabase-server-key.mjs";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === "--dry-run") { flags.dryRun = true; continue; }
    if (arg === "--decline") { flags.decline = true; continue; }
    // A flag never takes another flag as its value: "--actor --dry-run" must
    // not turn a dry run into a real one.
    if (!arg.startsWith("--") || i + 1 >= rest.length || rest[i + 1].startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    flags[arg.slice(2)] = rest[i + 1];
    i += 1;
  }
  return { command, flags };
}

// SUPABASE_URL is an alias of VITE_SUPABASE_URL. Set both and they must name
// the same backend, so neither can carry a target the other hides.
function backendUrlInput(env) {
  const values = [env.SUPABASE_URL, env.VITE_SUPABASE_URL]
    .map((value) => String(value ?? "").trim().replace(/\/$/, ""))
    .filter(Boolean);
  if (new Set(values).size > 1) throw new Error("SUPABASE_URL and VITE_SUPABASE_URL name different backends; set one");
  return values[0] ?? "";
}

export function readConfig(env) {
  const config = {
    supabaseUrl: backendUrlInput(env),
    serviceKey: String(env.SUPABASE_SERVICE_ROLE_KEY || ""),
    serviceKeyName: String(env.SUPABASE_SERVER_KEY_NAME || ""),
    resendKey: String(env.RESEND_API_KEY || ""),
    from: String(env.NOTIFY_FROM_ADDRESS || ""),
    appOrigin: String(env.INVITATION_APP_ORIGIN || "").replace(/\/$/, ""),
  };
  const missing = Object.entries({
    "SUPABASE_URL or VITE_SUPABASE_URL": config.supabaseUrl,
    RESEND_API_KEY: config.resendKey,
    NOTIFY_FROM_ADDRESS: config.from,
    INVITATION_APP_ORIGIN: config.appOrigin,
  }).filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`missing environment: ${missing.join(", ")}`);
  if (new URL(config.appOrigin).origin !== config.appOrigin) throw new Error("INVITATION_APP_ORIGIN must be a bare origin");
  const decision = productionProviderDecision({ ...env, VITE_SUPABASE_URL: config.supabaseUrl });
  if (!decision.ok) throw new Error(`backend refused before any request: ${decision.reason}`);
  return { ...config, supabaseUrl: decision.url };
}

// The configuration with its server key resolved; logs only the fingerprint.
// A dry run with an incomplete environment checks the flags only (the
// role-play kit's offline rehearsal) and says what was not checked.
export async function resolveConfig(env, log, { token, fetchImpl } = {}, { dryRun = false } = {}) {
  let config;
  try {
    config = readConfig(env);
  } catch (error) {
    if (!dryRun) throw error;
    log(`Server key: not checked (${error.message}).`);
    return null;
  }
  const resolved = await resolveServerKey({
    supabaseUrl: config.supabaseUrl, envKey: config.serviceKey, keyName: config.serviceKeyName, token, fetchImpl,
  });
  log(describeServerKey(resolved));
  return { ...config, serviceKey: resolved.key };
}

function createFields(flags) {
  const organization = String(flags.organization || "").trim();
  const email = String(flags.email || "").trim().toLowerCase();
  const fullName = String(flags.name || "").trim();
  const locale = String(flags.locale || "en").trim().toLowerCase();
  const key = String(flags.key || randomUUID());
  if (organization.length < 2 || organization.length > 120) throw new Error("--organization must be 2-120 characters");
  if (!EMAIL.test(email) || email.length > 254) throw new Error("--email must be an email address");
  if (fullName.length < 2 || fullName.length > 120) throw new Error("--name must be 2-120 characters");
  if (!["en", "es"].includes(locale)) throw new Error("--locale must be en or es");
  if (!UUID.test(key)) throw new Error("--key must be a UUID");
  return { organization, email, fullName, locale, key };
}

const serviceRpc = (config, name, body) => supabaseRpc(config.supabaseUrl, config.serviceKey, config.serviceKey, name, body);

//: the database refuses a name holding a phone number with this detail
// (20261118200200); say so in plain words instead of the call's failure code.
export const PHONE_NUMBER_DETAIL = "organization name holds a phone number";
export const PHONE_NUMBER_REFUSAL = "Refused: the organization name holds a phone number (seven or more digits that run together; a date, or a year after a local number of four or five digits, does not count). Nothing was created; choose another name with --organization.";

// Resolves to null, after saying why, when the name holds a phone number.
async function createFounderInvitation(config, fields, secret, log) {
  try {
    return await serviceRpc(config, "create_organization_founder_invitation", {
      p_organization_name: fields.organization,
      p_email: fields.email,
      p_full_name: fields.fullName,
      p_locale: fields.locale,
      p_token_hash: digest(secret),
      p_idempotency_key: fields.key,
    });
  } catch (error) {
    if (error?.code === "22023" && error?.details === PHONE_NUMBER_DETAIL) {
      log(PHONE_NUMBER_REFUSAL);
      return null;
    }
    throw error;
  }
}

async function deliver(config, result, recipient, log, names = { source: "founder" }) {
  const link = invitationUrl(config.appOrigin, recipient.secret);
  let sent;
  try {
    sent = await sendInvitationEmail({
      resendKey: config.resendKey,
      from: config.from,
      to: recipient.email,
      locale: recipient.locale,
      link,
      appOrigin: config.appOrigin,
      invitationId: result.invitationId,
      deliveryVersion: result.deliveryVersion,
      names,
      organizationLookup: {
        supabaseUrl: config.supabaseUrl, serviceKey: config.serviceKey, organizationId: result.organizationId,
      },
    });
  } catch {
    sent = false;
  }
  await serviceRpc(config, "record_organization_founder_invitation_delivery", {
    p_invitation_id: result.invitationId,
    p_delivery_version: result.deliveryVersion,
    p_outcome: sent ? "sent" : "failed",
  });
  log(sent
    ? `Invitation sent. It expires at ${result.expiresAt}; the founder must accept it before then.`
    : "The email provider refused the invitation. Nothing was sent; run resend to try again.");
  return sent;
}

async function fromRequest(flags, env, log, keySource) {
  const requestId = String(flags.request || "");
  if (!UUID.test(requestId)) throw new Error("--request must be the partner invitation request id");
  const override = flags.organization === undefined ? null : String(flags.organization).trim();
  if (override !== null && (override.length < 2 || override.length > 120)) throw new Error("--organization must be 2-120 characters");
  const config = await resolveConfig(env, log, keySource, { dryRun: flags.dryRun });
  if (!config) { log(`Dry run: would ${flags.decline ? "decline" : "send"} partner invitation request ${requestId}. Nothing was read or sent.`); return 0; }
  const request = await serviceRpc(config, "take_partner_invitation_request", { p_request_id: requestId });
  if (!request) { log("Refused: no waiting partner invitation request has that id. Nothing was sent."); return 2; }
  const finish = (outcome) => serviceRpc(config, "finish_partner_invitation_request", { p_request_id: requestId, p_outcome: outcome });
  if (flags.decline) {
    if (flags.dryRun) { log(`Dry run: would decline partner invitation request ${requestId} from ${request.invitingChapter}. Nothing was recorded.`); return 0; }
    await finish("declined");
    log(`Partner invitation request ${requestId} declined; the contact was erased and ${request.invitingChapter} was told.`);
    return 0;
  }
  if (request.onPlatform) { log(`Refused: ${request.officeName} is already on Union Ground. Nothing was sent; run with --decline to close the request.`); return 2; }
  const fields = createFields({
    organization: override ?? request.officeName, email: request.contactEmail, name: request.contactName,
    locale: request.locale, key: requestId,
  });
  if (flags.dryRun) {
    log(`Dry run: would start "${fields.organization}" and invite ${fields.email} (${fields.locale}) as its founder for ${request.invitingChapter}. Nothing was created.`);
    return 0;
  }
  const names = { source: "founder", partnerChapter: request.invitingChapter, partnerOffer: request.offerTitle || null };
  const secret = invitationSecret();
  let delivery;
  if (UUID.test(String(request.invitationId || ""))) {
    // An earlier run issued an invitation for this request: replace the latest
    // one (a resend supersedes it with a new id) rather than the first.
    delivery = await serviceRpc(config, "resend_organization_founder_invitation", { p_invitation_id: request.invitationId, p_token_hash: digest(secret) });
    if (!delivery?.send) { log("Refused: that founder invitation can't be resent (accepted, revoked, the organization already has an administrator, or the address asked to stop mail). Run with --decline to close the request."); return 2; }
    log(`Founder invitation ${delivery.invitationId} (version ${delivery.deliveryVersion}) for organization ${delivery.organizationId}.`);
  } else {
    const result = await createFounderInvitation(config, fields, secret, log);
    if (result === null) return 2;
    if (result?.status === "name_unavailable") { log("Refused: an organization with that name already exists. Nothing was created; pass --organization with another name."); return 2; }
    if (result?.status === "email_unavailable") { log("Refused: that address already has an account or a live invitation. Nothing was created; run with --decline to close the request."); return 2; }
    if (result?.status !== "invited") throw new Error("unexpected response from create_organization_founder_invitation");
    log(`Organization ${result.organizationId} (chapter ${result.chapterId}), founder invitation ${result.invitationId}.`);
    delivery = result;
    if (!result.send) {
      // Created by an earlier run that stopped before recording it. The replay
      // returns the first invitation, which an unrecorded resend may already
      // have superseded: record it as the chain's root, read back the newest
      // invitation in that chain, and replace that one with a fresh link.
      await serviceRpc(config, "note_partner_founder_invitation", { p_request_id: requestId, p_invitation_id: result.invitationId });
      const latest = await serviceRpc(config, "take_partner_invitation_request", { p_request_id: requestId });
      const target = UUID.test(String(latest?.invitationId || "")) ? latest.invitationId : result.invitationId;
      delivery = await serviceRpc(config, "resend_organization_founder_invitation", { p_invitation_id: target, p_token_hash: digest(secret) });
      if (!delivery?.send) { log("Refused: that founder invitation can't be resent (accepted, revoked, the organization already has an administrator, or the address asked to stop mail)."); return 2; }
    }
  }
  // Recorded before the email, so an interrupted or refused delivery is
  // retried against this invitation on the next run.
  await serviceRpc(config, "note_partner_founder_invitation", { p_request_id: requestId, p_invitation_id: delivery.invitationId });
  const recipient = { email: fields.email, locale: fields.locale, secret };
  if (!(await deliver(config, delivery, recipient, log, names))) return 1;
  await finish("sent");
  log(`Partner invitation request ${requestId} recorded as sent; the contact was erased and ${request.invitingChapter} was told.`);
  return 0;
}

export async function run(argv, env, log = console.log, keySource = {}) {
  const { command, flags } = parseArgs(argv);
  if (command === "create") {
    const fields = createFields(flags);
    const config = await resolveConfig(env, log, keySource, { dryRun: flags.dryRun });
    if (flags.dryRun) {
      log(`Dry run: would start "${fields.organization}" and invite ${fields.email} (${fields.locale}) as its founder. Nothing was created.`);
      return 0;
    }
    // Printed before the request: if the response is lost after the database
    // committed, rerunning with this --key returns the same invitation id, and
    // resend issues a fresh link for it.
    log(`Key ${fields.key}. If this command is interrupted, rerun it with --key ${fields.key}.`);
    const secret = invitationSecret();
    const result = await createFounderInvitation(config, fields, secret, log);
    if (result === null) return 2;
    if (result?.status === "name_unavailable") { log("Refused: an organization with that name already exists. Nothing was created."); return 2; }
    if (result?.status === "email_unavailable") { log("Refused: that address already has an account or a live invitation. Nothing was created."); return 2; }
    if (result?.status !== "invited") throw new Error("unexpected response from create_organization_founder_invitation");
    log(`Organization ${result.organizationId} (chapter ${result.chapterId}), founder invitation ${result.invitationId}.`);
    if (!result.send) { log(`Already created with this --key; nothing was sent again. For a fresh link: resend --invitation ${result.invitationId}`); return 0; }
    return (await deliver(config, result, { email: fields.email, locale: fields.locale, secret }, log)) ? 0 : 1;
  }
  if (command === "resend") {
    const invitationId = String(flags.invitation || "");
    if (!UUID.test(invitationId)) throw new Error("--invitation must be the founder invitation id");
    const config = await resolveConfig(env, log, keySource, { dryRun: flags.dryRun });
    if (flags.dryRun) { log(`Dry run: would resend founder invitation ${invitationId}. Nothing was sent.`); return 0; }
    const secret = invitationSecret();
    const result = await serviceRpc(config, "resend_organization_founder_invitation", {
      p_invitation_id: invitationId,
      p_token_hash: digest(secret),
    });
    if (!result?.send) { log("Refused: that founder invitation can't be resent (accepted, revoked, the organization already has an administrator, or the address asked to stop mail)."); return 2; }
    const email = String(result.normalizedEmail || "");
    if (!EMAIL.test(email)) throw new Error("unexpected response from resend_organization_founder_invitation");
    log(`Founder invitation ${result.invitationId} (version ${result.deliveryVersion}) for organization ${result.organizationId}.`);
    return (await deliver(config, result, { email, locale: result.locale === "es" ? "es" : "en", secret }, log)) ? 0 : 1;
  }
  if (command === "from-request") return fromRequest(flags, env, log, keySource);
  throw new Error("usage: invite-organization-founder.mjs create|resend|from-request [flags] (see the file header)");
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  run(process.argv.slice(2), process.env).then(
    (code) => { process.exitCode = code; },
    (error) => { console.error(error.message); process.exitCode = 1; },
  );
}
