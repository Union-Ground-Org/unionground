import { useId, useState } from "react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { FEATURE_GROUPS } from "../../lib/mobileNav.js";
import { siteGuideEnabled } from "../../lib/siteGuide.js";
import { NAV_PINS_MAX } from "./navUsage.js";
import { clearNavUsageForUser, navUsageEnabled, useNavPins } from "./useNavUsage.js";
import "./navUsageSettings.css";
import { WorkspaceCardTitle } from "../../components/WorkspacePages.jsx";

// REQ-UG-USAGE-BASED-NAVIGATION-20261001: the member-level control for the
// device-only "Most used" ranking. Shown only while the organization has the
// feature on; Reset forgets every count this browser kept for this account.
// REQ-UG-NAVIGATION-HELP-AND-SETUP-COPY-20261030 (finding 89): a pin
// toggle for each member destination. Pinned places lead the side menu, kept
// on this device the same way as the counts; Reset leaves them alone.
// Pins are offered only where they show: the classic desktop and tablet rail
// (pinsOffered), stored in memory only for demo sessions (persist), and only
// for destinations that rail can list.
export function NavUsageSettingsCard({ data, persist = true, pinsOffered = true }) {
  const { t } = useLang();
  const titleId = useId();
  const pinsTitleId = useId();
  const [status, setStatus] = useState("");
  const memberId = data?.member?.id ?? null;
  const enabled = Boolean(memberId) && navUsageEnabled(data?.organizationConfiguration);
  const { pins, togglePin } = useNavPins({ userId: memberId, organizationId: data?.member?.organizationId ?? null, enabled: enabled && pinsOffered, persist });
  const siteGuide = siteGuideEnabled(data?.organizationConfiguration);
  if (!enabled) return null;
  const full = pins.length >= NAV_PINS_MAX;
  const groups = FEATURE_GROUPS
    .map((group) => ({ ...group, items: group.items.filter((item) => item?.path && !item.action && (siteGuide || item.key !== "site-guide")) }))
    .filter((group) => group.items.length > 0);
  return (
    <section className="setin-card" aria-labelledby={titleId}>
      <div className="setin-card__head">
        <WorkspaceCardTitle outline as="h3" id={titleId}>{t("navUsage.settingsTitle")}</WorkspaceCardTitle>
        <p>{t("navUsage.settingsBody")}</p>
      </div>
      <div className="setin-row">
        <div className="setin-row__text">
          <button
            type="button"
            className="dialog-secondary"
            onClick={() => { clearNavUsageForUser(memberId); setStatus(t("navUsage.resetDone")); }}
          >
            {t("navUsage.reset")}
          </button>
        </div>
      </div>
      {pinsOffered && (
        <div className="nav-pins" role="group" aria-labelledby={pinsTitleId}>
          <h4 id={pinsTitleId} className="nav-pins__title">{t("navUsage.pinsTitle")}</h4>
          <p className="nav-pins__help">{full ? t("navUsage.pinsFull", { max: NAV_PINS_MAX }) : t("navUsage.pinsHelp", { max: NAV_PINS_MAX })}</p>
          {groups.map((group) => (
            <div key={group.key} className="nav-pins__group">
              <p className="nav-pins__group-title">{t(group.labelKey)}</p>
              <ul className="nav-pins__list">
                {group.items.map((item) => {
                  const label = t(item.labelKey);
                  const pinned = pins.includes(item.key);
                  return (
                    <li key={item.key} className="nav-pins__row">
                      <span className="nav-pins__label">{label}</span>
                      <button
                        type="button"
                        className="nav-pins__toggle"
                        aria-label={t("navUsage.pinLabel", { label })}
                        aria-pressed={pinned}
                        disabled={!pinned && full}
                        onClick={() => {
                          togglePin(item.key);
                          setStatus(t(pinned ? "navUsage.unpinDone" : "navUsage.pinDone", { label }));
                        }}
                      >
                        {t(pinned ? "navUsage.pinnedShort" : "navUsage.pinShort")}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
      <small role="status">{status}</small>
    </section>
  );
}
