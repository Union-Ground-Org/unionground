import { useEffect, useRef, useState } from "react";
import { runBusyWrite } from "../../lib/busyWrite.js";
import { BusyButton } from "../../components/BusyControls.jsx";
import { useLang } from "../../lib/LanguageContext.jsx";

// One read-and-save switch, shared by a case's identity-privacy switch and the
// case-topic switches. The server decides who may change each; these controls
// only read and save them.
//  gate r2s1/r4s1: a refused save and a failed re-read after a confirmed
// save are different errors. After a confirmed save the control shows the
// saved value even when the re-read fails.
export const SWITCH_ERROR_KEYS = { save: "access.saveError", reload: "access.reloadError" };

// BUG-UG-CASE-PRIVACY-AND-TOPIC-SWITCHES-VANISH-ON-A-FAILED-READ-20261125
//: the server refuses a caller outside the role
// or scope with 42501, and an older backend has no such call (PGRST202, 42883
// or HTTP 404). Both mean this person has no switch here, so nothing shows.
// Any other failed read says the setting could not be loaded and offers Try
// again, instead of looking like a case without the switch.
const NO_SWITCH_CODES = new Set(["42501", "not_authorized", "PGRST202", "42883"]);

function readOffersNoSwitch(error) {
  return NO_SWITCH_CODES.has(error?.code) || error?.status === 403 || error?.status === 404;
}

export function useSettingSwitch(load, keys) {
  const busyWriteRef = useRef(new Set());
  const [value, setValue] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const generation = useRef(0);
  //: Try again is removed when its read lands. The switch that
  // replaces it takes focus, so a keyboard user is not sent to the page. A
  // refused read leaves nothing of this control to focus.
  //: only when Try again still held focus as the
  // read landed, and no other control took it before the switch would.
  const switchRef = useRef(null);
  const retryRef = useRef(null);
  const focusSwitchRef = useRef(false);
  useEffect(() => {
    if (!focusSwitchRef.current) return;
    focusSwitchRef.current = false;
    const active = globalThis.document?.activeElement;
    if (!active || active === globalThis.document.body || active === retryRef.current) switchRef.current?.focus();
  });
  const read = (current, retried = false) => load().then((result) => {
    if (current !== generation.current) return;
    // Checked before the commit that removes Try again.
    if (retried && retryRef.current && retryRef.current === globalThis.document?.activeElement) focusSwitchRef.current = true;
    setValue(result); setLoadFailed(false);
  }, (failure) => {
    if (current === generation.current) setLoadFailed(!readOffersNoSwitch(failure));
  });
  useEffect(() => {
    const current = ++generation.current;
    setValue(null); setBusy(false); setError(null); setLoadFailed(false); setRetrying(false);
    if (!load) return undefined;
    void read(current);
    return () => { generation.current += 1; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, keys);
  async function retry() {
    const current = generation.current;
    //: the retry lock belongs to one scope (one case or chapter), so a
    // retry still running for the one the person left never refuses this one.
    return runBusyWrite(busyWriteRef, `retrying:${current}`, async (releaseBusyWrite) => {
      setRetrying(true);
      try { await read(current, true); } finally {
        if (current === generation.current) setRetrying(false);
        releaseBusyWrite();
      }
    });
  }
  async function change(save, confirmed) {
    return runBusyWrite(busyWriteRef, "busy", async (releaseBusyWrite) => {
      try {
        const current = generation.current;
        setBusy(true); setError(null);
        let next = confirmed;
        let failure = null;
        try {
          await save();
          try { next = await load(); } catch { failure = "reload"; }
        } catch { next = undefined; failure = "save"; }
        if (current !== generation.current) return;
        if (next !== undefined) setValue(next);
        setError(failure);
        setBusy(false);
      } finally { releaseBusyWrite(); }
    });
  }
  return { value, busy, error, change, loadFailed, retrying, retry, switchRef, retryRef };
}

export function SettingLoadFailed({ messageKey, retrying, onRetry, retryRef }) {
  const { t } = useLang();
  return <>
    <p role="alert">{t(messageKey)}</p>
    <BusyButton ref={retryRef} type="button" pending={retrying} onClick={() => void onRetry()}>{t("access.retry")}</BusyButton>
  </>;
}
