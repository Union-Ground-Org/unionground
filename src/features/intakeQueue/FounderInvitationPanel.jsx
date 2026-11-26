import { useId, useState } from "react";
import "../../lib/i18n/features/intakeQueueStrings.js";
import { BusyButton } from "../../components/BusyControls.jsx";
import { focusedElement } from "./useSuccessFocus.js";

const P = "intakeQueue.founder";
const MIN_NAME_LENGTH = 2;
export function FounderInvitationPanel({ row, t, busy, onInvite, onInvited }) {
  const [open, setOpen] = useState(false);
  const [organization, setOrganization] = useState(row.organizationName ?? "");
  const [name, setName] = useState("");
  const organizationId = useId();
  const nameId = useId();
  const fullName = name.trim();
  const organizationName = organization.trim();
  const nameTooShort = fullName.length < MIN_NAME_LENGTH;
  const organizationTooShort = organizationName.length < MIN_NAME_LENGTH;
  const reason = nameTooShort ? "nameTooShort" : organizationTooShort ? "organizationTooShort" : null;
  const disabledReason = !busy && reason ? `${t(`${P}.${reason}`, { min: MIN_NAME_LENGTH })} ${t(`${P}.nameLengthCounting`)}` : null;
  const invitation = row.founderInvitation;
  const statuses = ["pending", "accepted", "accepting", "revoked", "expired", "delivery_failed", "superseded"];
  let status = statuses.includes(invitation?.status) ? invitation.status : "unknown";
  if (status === "pending") {
    if (Date.parse(invitation.expiresAt) <= Date.now()) status = "expired";
    else if (!invitation.sentAt) status = "unconfirmed";
  }
  if (invitation?.id) return <section className="xus-intake-pass" aria-label={t(`${P}.heading`)}>
    <p className="xus-note">{t(`${P}.linked`)} <code>{invitation.id}</code></p>
    <p className="xus-note">{t(`${P}.state.${status}`, { invitationId: invitation.id })}</p>
  </section>;
  if (row.status === "closed") return null;
  async function submit(event) {
    event.preventDefault();
    if (busy || reason) return;
    const started = focusedElement();
    if (await onInvite(row, { organizationName, fullName }, event)) {
      setName(""); setOpen(false);
      onInvited?.(started);
    }
  }
  return <section className="xus-intake-pass" aria-label={t(`${P}.heading`)}>
    {!open && <button type="button" className="xus-btn" disabled={Boolean(busy)} onClick={() => setOpen(true)}>{t(`${P}.open`)}</button>}
    {open && <form className="xus-intake-passform" onSubmit={submit}>
      <p className="xus-note">{t(`${P}.confirm`, { email: row.email })}</p>
      <p className="xus-note">{row.email}</p>
      <label className="xus-field" htmlFor={organizationId}>{t(`${P}.organization`)}
        <input id={organizationId} className="xus-input" required minLength={MIN_NAME_LENGTH} maxLength={120} value={organization} readOnly={Boolean(busy)} onChange={(event) => setOrganization(event.target.value)} />
      </label>
      <label className="xus-field" htmlFor={nameId}>{t(`${P}.name`)}
        <input id={nameId} className="xus-input" required minLength={MIN_NAME_LENGTH} maxLength={120} value={name} readOnly={Boolean(busy)} autoComplete="off" onChange={(event) => setName(event.target.value)} />
      </label>
      <p className="xus-note">{t(`${P}.nameHelp`)}</p>
      <div className="xus-btnrow">
        <BusyButton className="xus-btn xus-btn--go" type="submit" pending={busy === "founder"} disabled={Boolean(busy || reason)} disabledReason={disabledReason}>{t(`${P}.submit`)}</BusyButton>
        <button type="button" className="xus-btn" disabled={Boolean(busy)} onClick={() => { setOpen(false); setName(""); }}>{t(`${P}.cancel`)}</button>
      </div>
    </form>}
  </section>;
}
