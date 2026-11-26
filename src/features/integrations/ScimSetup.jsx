import { useEffect, useRef, useState } from "react";
import { BusyButton, BusySelect } from "../../components/BusyControls.jsx";
import { runBusyWrite, useBusyScope } from "../../lib/busyWrite.js";
import { useLang } from "../../lib/LanguageContext.jsx";
import { formatDateTimeWithZone } from "../../lib/i18n/zonedDates.js";
import { SCIM_MAPPABLE_ROLES, scimEndpointUrl, scimSetupSteps } from "./scim.js";

// Integrations > SCIM (REQ-UG-SCIM-PROVISIONING-20261001). Every value on
// this page is read from public.get_scim_control(); every control calls an
// RPC the database authorizes (organization admin + MFA). A vp reads the page
// without write controls.
const REASON_KEYS = Object.freeze({
  mfa_required: "integrations.error.mfa",
  unauthorized: "integrations.error.unauthorized",
  scim_switched_off: "integrations.scimErrorSwitchedOff",
  scim_no_default_chapter: "integrations.scimErrorNoChapter",
  scim_token_limit: "integrations.scimErrorTokenLimit",
  name_required: "integrations.scimErrorLabel",
});

function reasonText(t, reason) {
  return t(REASON_KEYS[reason] || "integrations.changeFailed");
}

export function ScimSetup({ store, actor, onHeld }) {
  const { lang, t } = useLang();
  const [control, setControl] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [chapterDraft, setChapterDraft] = useState("");
  const [label, setLabel] = useState("");
  // The one-time token, bound to the activation (member and organization)
  // that issued it: another member or organization never
  // sees it, and a same-login token renewal keeps it.
  const [secretOnce, setSecretOnce] = useState(null);
  const busyWriteRef = useRef(new Set());
  // The page re-reads its control when the actor changes. A write that answers
  // after that belongs to the earlier member or organization: it may not
  // replace this page's control, error or one-time token.
  const scope = useBusyScope(`${actor?.userId ?? ""}\u0000${actor?.selectedOrganizationId ?? ""}`);

  useEffect(() => {
    let active = true;
    Promise.resolve(store.getScimControl?.(actor)).then((result) => {
      if (!active) return;
      if (result?.ok) {
        setControl(result.data);
        setError("");
      } else {
        setControl(null);
        setError(t(result?.reason === "unauthorized" ? "integrations.unauthorized" : "integrations.scimUnavailable"));
      }
    }).catch(() => { if (active) setError(t("integrations.scimUnavailable")); });
    return () => { active = false; };
  }, [actor, lang, store, t]);

  // Every control shares one busy state, so they share one lock, released
  // where busy clears.
  function run(action) {
    return runBusyWrite(busyWriteRef, "scim", (unlock) => runNow(action, unlock));
  }

  async function runNow(action, unlock) {
    const started = scope.generation;
    setBusy(true);
    setError("");
    try {
      const result = await action();
      if (!scope.isCurrent(started)) return null;
      if (!result?.ok) {
        setError(reasonText(t, result?.reason));
        return result;
      }
      if (result.data) setControl(result.data);
      return result;
    } catch {
      if (scope.isCurrent(started)) setError(t("integrations.changeFailed"));
      return null;
    } finally {
      unlock();
      setBusy(false);
    }
  }

  // Another member or organization: the token leaves state, not just the
  // screen (a same-login renewal keeps the activation, so it stays).
  if (secretOnce && secretOnce.generation !== scope.generation) setSecretOnce(null);
  const shownSecret = secretOnce?.generation === scope.generation ? secretOnce.plaintext : null;

  // Held with single sign-on (#9037): the server answers released false and
  // nothing else, to a read or to any write that lands after the hold, and
  // the setup shows nothing at all. The page is told, so its SCIM tab and
  // card leave with the setup.
  const held = control?.released === false;
  useEffect(() => { if (held) onHeld?.(); }, [held, onHeld]);
  if (held) return null;
  if (!control) {
    return <p className="xus-note" role="status">{error || t("integrations.loading")}</p>;
  }

  const canManage = control.canManage === true;
  const steps = scimSetupSteps(control);
  const selectedChapter = chapterDraft || control.defaultChapterId || "";
  const liveTokens = control.tokens.filter((token) => !token.revokedAt && Date.parse(token.expiresAt) > Date.now());
  const canIssue = canManage && control.enabled && Boolean(control.defaultChapterId);
  const stamp = (value) => (value ? formatDateTimeWithZone(value, lang) : t("integrations.scimNever"));

  return (
    <div className="xus-sec scim-setup">
      {error ? <p className="xus-note xus-note--error" role="alert">{error}</p> : null}
      <p className="xus-note" role="status">
        {control.enabled ? t("integrations.scimSwitchOn") : t("integrations.scimSwitchOff")}
        {" "}
        <a href="/m/admin/configuration">{t("integrations.scimSwitchLink")}</a>
      </p>

      <h3 className="xus-eyebrow">{t("integrations.scimStepsTitle")}</h3>
      <ol className="xus-steps">
        {steps.map((step) => (
          <li key={step.id}>
            <strong>{t(step.done ? "integrations.scimStepDone" : step.optional ? "integrations.scimStepOptional" : "integrations.scimStepTodo")}</strong>
            {" "}
            {t(`integrations.scimStep.${step.id}`)}
          </li>
        ))}
      </ol>

      <h3 className="xus-eyebrow">{t("integrations.scimProviderTitle")}</h3>
      <dl className="xus-facts">
        <dt>{t("integrations.scimEndpoint")}</dt>
        <dd><code>{scimEndpointUrl()}</code></dd>
        <dt>{t("integrations.scimAuth")}</dt>
        <dd>{t("integrations.scimAuthValue")}</dd>
        <dt>{t("integrations.scimIdentifier")}</dt>
        <dd>{t("integrations.scimIdentifierValue")}</dd>
        <dt>{t("integrations.scimLimits")}</dt>
        <dd>{t("integrations.scimLimitsValue", { requests: control.requestsPerMinute, invitations: control.invitationsPerDay })}</dd>
      </dl>
      <p className="xus-note">{t("integrations.scimProvisioningRule")}</p>

      <h3 className="xus-eyebrow">{t("integrations.scimChapterTitle")}</h3>
      {canManage ? (
        <form className="xus-form" onSubmit={(event) => {
          event.preventDefault();
          if (selectedChapter) run(() => store.saveScimSettings(actor, { defaultChapterId: selectedChapter }));
        }}>
          <label className="setin-quiet-wide">
            {t("integrations.scimChapterLabel")}
            <select value={selectedChapter} onChange={(event) => setChapterDraft(event.target.value)}>
              <option value="">{t("integrations.scimChapterChoose")}</option>
              {control.chapters.map((chapter) => <option key={chapter.id} value={chapter.id}>{chapter.name}</option>)}
            </select>
          </label>
          <BusyButton type="submit" className="xus-btn xus-btn--go" pending={busy} disabled={!selectedChapter || selectedChapter === control.defaultChapterId}>
            {t("integrations.scimChapterSave")}
          </BusyButton>
        </form>
      ) : (
        <p className="xus-note">{control.chapters.find((chapter) => chapter.id === control.defaultChapterId)?.name || t("integrations.scimChapterUnset")}</p>
      )}

      <h3 className="xus-eyebrow">{t("integrations.scimTokensTitle")}</h3>
      {shownSecret ? (
        <div className="xus-inline" role="group" aria-label={t("integrations.scimTokenOnce")}>
          <p className="xus-note">{t("integrations.scimTokenOnce")}</p>
          <input readOnly value={shownSecret} aria-label={t("integrations.scimTokenOnce")} onFocus={(event) => event.target.select()} />
          <button type="button" className="xus-btn" onClick={() => setSecretOnce(null)}>{t("integrations.copied")}</button>
        </div>
      ) : null}
      {control.tokens.length === 0 ? <p className="xus-note">{t("integrations.scimNoTokens")}</p> : (
        <ul>
          {control.tokens.map((token) => (
            <li className="xus-row" key={token.id}>
              <strong>{token.label}</strong>
              <span> {token.tokenPrefix}… · {t("integrations.scimTokenExpires")} {stamp(token.expiresAt)} · {t("integrations.scimTokenUsed")} {stamp(token.lastUsedAt)}{token.revokedAt ? ` · ${t("integrations.revoked")}` : ""}</span>
              {canManage && !token.revokedAt ? (
                <BusyButton type="button" className="xus-btn" aria-label={`${t("integrations.revoke")} ${token.label}`} pending={busy}
                  onClick={() => run(() => store.revokeScimToken(actor, { tokenId: token.id }))}>
                  {t("integrations.revoke")}
                </BusyButton>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canManage ? (
        <form className="xus-form" onSubmit={async (event) => {
          event.preventDefault();
          const issuedIn = scope.generation;
          const result = await run(() => store.issueScimToken(actor, { label }));
          if (result?.ok && result.secret?.plaintext) {
            setSecretOnce({ plaintext: result.secret.plaintext, generation: issuedIn });
            setLabel("");
          }
        }}>
          <label className="setin-quiet-wide">
            {t("integrations.scimTokenLabel")}
            <input maxLength={80} value={label} onChange={(event) => setLabel(event.target.value)} placeholder={t("integrations.scimTokenPlaceholder")} />
          </label>
          <BusyButton type="submit" className="xus-btn xus-btn--go" pending={busy} disabled={!canIssue || !label.trim()} aria-describedby="scim-issue-help">
            {t("integrations.issueScim")}
          </BusyButton>
          <p className="xus-note" id="scim-issue-help">
            {!control.enabled ? t("integrations.scimErrorSwitchedOff")
              : !control.defaultChapterId ? t("integrations.scimErrorNoChapter")
                : t("integrations.scimTokenHelp", { count: liveTokens.length })}
          </p>
        </form>
      ) : null}

      <h3 className="xus-eyebrow">{t("integrations.scimGroupsTitle")}</h3>
      <p className="xus-note">{t("integrations.scimGroupsRule")}</p>
      {control.groups.length === 0 ? <p className="xus-note">{t("integrations.scimNoGroups")}</p> : (
        <ul>
          {control.groups.map((group) => (
            <li className="xus-row" key={group.id}>
              <strong>{group.displayName}</strong>
              <span> {t("integrations.scimGroupMembers", { count: group.memberCount })}</span>
              {canManage ? (
                <label>
                  <span className="sr-only">{t("integrations.scimGroupRoleFor", { group: group.displayName })}</span>
                  <BusySelect value={group.mappedRole || ""} pending={busy}
                    onChange={(event) => run(() => store.setScimGroupRole(actor, { groupId: group.id, role: event.target.value || null }))}>
                    <option value="">{t("integrations.scimRoleNone")}</option>
                    {SCIM_MAPPABLE_ROLES.map((role) => <option key={role} value={role}>{t(`integrations.scimRole.${role}`)}</option>)}
                  </BusySelect>
                </label>
              ) : (
                <span> · {t(group.mappedRole ? `integrations.scimRole.${group.mappedRole}` : "integrations.scimRoleNone")}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      <h3 className="xus-eyebrow">{t("integrations.scimPeopleTitle")}</h3>
      <p className="xus-note">{t("integrations.scimPeopleCounts", {
        total: control.users.total, invited: control.users.invited, active: control.users.active,
        reactivation: control.users.reactivationInvited, attention: control.users.needsAdmin, removed: control.users.deprovisioned,
      })}</p>
      {control.attention.length ? (
        <ul aria-label={t("integrations.scimAttentionTitle")}>
          {control.attention.map((person) => (
            <li className="xus-row" key={person.id}>
              <strong>{person.userName}</strong>
              <span> · {t(`integrations.scimReason.${person.stateReason || "unknown"}`)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
