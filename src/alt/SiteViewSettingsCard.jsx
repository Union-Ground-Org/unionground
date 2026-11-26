import { useId } from "react";
import { useLang } from "../lib/LanguageContext.jsx";

// REQ-UG-AB-MEMBER-DEFAULT-ALT-VIEW-20261030: the member's own switch
// between the classic view and the alternate site shell, in either shell's
// Settings. `siteView` is App's { alt, onChange }; without it (signed out, the
// fixture demo) the card renders nothing. The choice is stored per member in
// this browser and overrides the member-default-view experiment.
export function SiteViewSettingsCard({ siteView }) {
  const { t } = useLang();
  const titleId = useId();
  const bodyId = useId();
  if (!siteView) return null;
  const { alt, onChange } = siteView;
  return (
    <section className="setin-card site-view-card" aria-labelledby={titleId}>
      <div className="setin-card__head">
        <h3 id={titleId}>{t("altShell.siteViewTitle")}</h3>
        <p id={bodyId}>{t(alt ? "altShell.siteViewBodyAlt" : "altShell.siteViewBodyClassic")}</p>
      </div>
      <div className="setin-row">
        <div className="setin-row__text">
          <button type="button" className="dialog-secondary site-view-switch" aria-describedby={bodyId} onClick={() => onChange(!alt)}>
            {t(alt ? "altShell.switchToClassic" : "altShell.switchToAlt")}
          </button>
        </div>
      </div>
    </section>
  );
}
