import { Dialog } from "./Dialog.jsx";
import { BusyButton } from "./BusyControls.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import "./confirmAction.css";

// One confirmation for a consequential action (Lovable audit Batch A pattern
// 9; REQ-UG-LOVABLE-AUDIT-WEBAPP-FIXES-20261103): the title asks the
// question naming the action and its object, "What happens" lists the effect,
// then who is affected and whether it can be undone, and the confirm button
// repeats the action. Escape, the close button and Cancel all leave the record
// unchanged. `children` (a field the action needs, such as a reason) sits
// above the buttons, and `confirmDisabled` holds the confirm button until it
// is filled.
export function ConfirmActionDialog({ eyebrow, title, effects = [], affected = null, undo = null, confirmLabel, busy = false, busyLabel = null, confirmDisabled = false, children = null, onConfirm, onClose }) {
  const { t } = useLang();
  return (
    <Dialog eyebrow={eyebrow} title={title} onClose={onClose} wide>
      <div className="confirm-action" data-testid="confirm-action">
        {effects.length > 0 && <>
          <h3 className="confirm-action__label">{t("confirmAction.whatHappens")}</h3>
          <ul className="confirm-action__effects">{effects.map((effect) => <li key={effect}>{effect}</li>)}</ul>
        </>}
        {affected && <p className="confirm-action__fact"><strong>{t("confirmAction.affected")}</strong> {affected}</p>}
        {undo && <p className="confirm-action__fact"><strong>{t("confirmAction.undo")}</strong> {undo}</p>}
        {children}
        <div className="confirm-action__actions">
          <BusyButton type="button" className="dialog-secondary" onClick={onClose} pending={busy}>{t("confirmAction.cancel")}</BusyButton>
          <BusyButton type="button" className="dialog-primary" onClick={onConfirm} pending={busy} disabled={confirmDisabled}>{busy && busyLabel ? busyLabel : confirmLabel}</BusyButton>
        </div>
      </div>
    </Dialog>
  );
}
