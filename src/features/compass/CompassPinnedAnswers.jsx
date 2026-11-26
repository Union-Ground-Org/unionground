// REQ-UG-COMPASS-ACTION-OFFERS-20261001: Compass answers the person pinned
// to Home (old offer_pin_home_card / offer_save_item). Read through
// public.list_compass_pinned_answers; unpinning goes through
// public.set_compass_answer_pinned.
import { useId, useRef, useState } from "react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { Button } from "../../components/Button.jsx";
import { BusyButton } from "../../components/BusyControls.jsx";
import { runBusyWrite } from "../../lib/busyWrite.js";

export function CompassPinnedAnswers({ pins = [], loadFailed = false, onRetry, onUnpin, onAsk }) {
  const { t } = useLang();
  const titleId = useId();
  const [busyId, setBusyId] = useState(null);
  // Record 8435: a synchronous write lock, refused before React commits busy.
  const busyWriteRef = useRef(new Set());
  const [error, setError] = useState("");
  const [retrying, setRetrying] = useState(false);
  if (!pins.length && !loadFailed) return null;

  async function retry() {
    setRetrying(true);
    try { await onRetry(); } finally { setRetrying(false); }
  }

  function unpin(pin) {
    return runBusyWrite(busyWriteRef, "unpin", () => unpinNow(pin));
  }

  async function unpinNow(pin) {
    if (busyId) return;
    setBusyId(pin.id);
    setError("");
    try { await onUnpin(pin.id); } catch { setError(t("compass.actions.failed")); } finally { setBusyId(null); }
  }

  return (
    <section className="home-card compass-pins" aria-labelledby={titleId}>
      <h2 id={titleId}>{t("compass.pins.title")}</h2>
      {loadFailed && <>
        <p role="alert">{t("compass.pins.loadFailed")}</p>
        {onRetry && <Button variant="secondary" size="small" pending={retrying} onClick={retry}>{t("app.tryAgain")}</Button>}
      </>}
      {!!pins.length && <ul>
        {pins.map((pin) => (
          <li key={pin.id}>
            {pin.question && <strong>{pin.question}</strong>}
            <p>{pin.answer}</p>
            <div className="compass-pins__actions">
              {onAsk && <button type="button" className="outline-pill" onClick={() => onAsk(pin.question)}>{t("compass.pins.followUp")}</button>}
              <BusyButton type="button" className="outline-pill" pending={busyId !== null} aria-label={t("compass.pins.unpinLabel", { question: pin.question || t("compass.pins.answer") })} onClick={() => unpin(pin)}>
                {t("compass.actions.unpin")}
              </BusyButton>
            </div>
          </li>
        ))}
      </ul>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
