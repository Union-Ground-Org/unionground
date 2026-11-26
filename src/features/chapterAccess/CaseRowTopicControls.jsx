import { BusyInput } from "../../components/BusyControls.jsx";
import { useLang } from "../../lib/LanguageContext.jsx";
import { SWITCH_ERROR_KEYS, SettingLoadFailed, useSettingSwitch } from "./settingSwitch.jsx";
import "./chapterAccess.css";

// REQ-UG-LIST-ROW-DETAIL-TOGGLE-CHAPTER-AND-STEWARD-20261104 (#7043):
// case lists name a case by reference, type and step (#7015). The chapter's
// leadership can show case topics in its lists, and a case's own steward can
// show that case's topic in their own lists. The server decides both; these
// controls only read and save the switches (settingSwitch.jsx).

export function CaseRowTopicChapterControl({ api, chapterId }) {
  const { t } = useLang();
  const ready = Boolean(api?.caseRowTopicPolicy && api?.setCaseRowTopicPolicy && chapterId);
  const { value, busy, error, change, loadFailed, retrying, retry, switchRef, retryRef } = useSettingSwitch(ready ? () => api.caseRowTopicPolicy(chapterId) : null, [api, chapterId]);
  if (loadFailed) {
    return <div className="institutional-form">
      <h4>{t("access.caseRowTopic")}</h4>
      <SettingLoadFailed messageKey="access.caseRowTopicChapterLoadError" retrying={retrying} onRetry={retry} retryRef={retryRef} />
    </div>;
  }
  if (!value?.canChange) return null;
  return <div className="institutional-form">
    <h4>{t("access.caseRowTopic")}</h4>
    <label className="institutional-check"><BusyInput ref={switchRef} type="checkbox" checked={value.enabled === true} pending={busy} onChange={(event) => { const enabled = event.target.checked; void change(() => api.setCaseRowTopicPolicy(chapterId, enabled), { ...value, enabled }); }} />{t("access.caseRowTopicChapter")}</label>
    <p>{t("access.caseRowTopicChapterHelp")}</p>
    {error && <p role="alert">{t(SWITCH_ERROR_KEYS[error])}</p>}
  </div>;
}

export function CaseRowTopicCaseControl({ api, caseId }) {
  const { t } = useLang();
  const ready = Boolean(api?.loadCaseRowTopic && api?.setCaseRowTopic && caseId);
  const { value, busy, error, change, loadFailed, retrying, retry, switchRef, retryRef } = useSettingSwitch(ready ? () => api.loadCaseRowTopic(caseId) : null, [api, caseId]);
  if (loadFailed) {
    return <div className="chapter-access">
      <SettingLoadFailed messageKey="access.caseRowTopicLoadError" retrying={retrying} onRetry={retry} retryRef={retryRef} />
    </div>;
  }
  if (!value?.canChange) return null;
  return <div className="chapter-access">
    <label className="institutional-check"><BusyInput ref={switchRef} type="checkbox" checked={value.shown === true} pending={busy} onChange={(event) => { const shown = event.target.checked; void change(() => api.setCaseRowTopic(caseId, shown), { ...value, shown }); }} />{t("access.caseRowTopicCase")}</label>
    {/* #7059 gate r4g1: the chapter-on note sits beside the neutrality sentence, never in place of it. */}
    <p>{value.chapterShown === true ? `${t("access.caseRowTopicChapterOn")} ${t("access.caseRowTopicNeutral")}` : t("access.caseRowTopicCaseHelp")}</p>
    {error && <p role="alert">{t(SWITCH_ERROR_KEYS[error])}</p>}
  </div>;
}
