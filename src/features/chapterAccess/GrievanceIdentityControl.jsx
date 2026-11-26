import { BusyInput } from "../../components/BusyControls.jsx";
import { useLang } from "../../lib/LanguageContext.jsx";
import { SWITCH_ERROR_KEYS, SettingLoadFailed, useSettingSwitch } from "./settingSwitch.jsx";
import "./chapterAccess.css";

// The assigned steward's switch that hides the member's identity from other
// stewards. It shares the case-topic switches' read, save and re-read handling
// (settingSwitch.jsx, #9955): a failed read says so, and a failed re-read after
// a confirmed save is not reported as a failed save.
export function GrievanceIdentityControl({ api, caseId }) {
  const { t } = useLang();
  const ready = Boolean(api?.loadIdentityVisibility && api?.setIdentityPrivate);
  const { value, busy, error, change, loadFailed, retrying, retry, switchRef, retryRef } = useSettingSwitch(ready ? () => api.loadIdentityVisibility(caseId) : null, [api, caseId]);
  if (loadFailed) {
    return <div className="chapter-access">
      <SettingLoadFailed messageKey="access.identityLoadError" retrying={retrying} onRetry={retry} retryRef={retryRef} />
    </div>;
  }
  if (!value?.canChange) return null;
  return <div className="chapter-access">
    <label className="institutional-check"><BusyInput ref={switchRef} type="checkbox" checked={value.private} pending={busy} onChange={(event) => { const enabled = event.target.checked; void change(() => api.setIdentityPrivate(caseId, enabled), { ...value, private: enabled }); }} />{t("access.identityPrivate")}</label>
    {error && <p role="alert">{t(SWITCH_ERROR_KEYS[error])}</p>}
  </div>;
}
