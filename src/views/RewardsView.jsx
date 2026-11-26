import { EmptyState, ScreenHeader, SectionTitle } from "../components/Primitives.jsx";
import { useLang } from "../lib/LanguageContext.jsx";
import { localeFor } from "../lib/i18n.js";

// The participation path, in order. These were an inline
// `lang === "es" ? {…} : {…}` table — a second translation catalogue hiding
// inside a view, invisible to the en/es parity test that guards every other
// string in the app.
const RUNG_KEYS = [
  ["learn", "rewards.rungLearn"],
  ["attend", "rewards.rungAttend"],
  ["volunteer", "rewards.rungVolunteer"],
  ["organize", "rewards.rungOrganize"],
  ["lead", "rewards.rungLead"],
];

export function RewardsView({ data, onProfile, onAssistant }) {
  const { t, lang } = useLang();
  const catalog = data.recognitionCatalog || { rules: [], events: [] };
  const rules = catalog.rules || [];
  const events = catalog.events || [];
  const currentRung = data.recognition?.currentRung || "learn";

  return (
    <div className="screen">
      <ScreenHeader
        initials={data.member.initials}
        eyebrow={t("rewards.eyebrow")}
        title={t("rewards.title")}
        compact
        onProfile={onProfile}
        onAssistant={onAssistant}
      />

      <section className="message-section contribution-boundary">
        <SectionTitle sub={t("rewards.maxTier")}>{t("rewards.nextTier")}</SectionTitle>
        <p>{t("rewards.noEffect")}</p>
      </section>

      <ol className="participation-path" aria-label={t("rewards.currentTier")}>
        {RUNG_KEYS.map(([rung, labelKey]) => (
          <li className={`participation-path__item${currentRung === rung ? " participation-path__item--current" : ""}`} key={rung}>
            <strong>{t(labelKey)}</strong>
            {currentRung === rung ? <small>{t("rewards.currentTier")}</small> : null}
          </li>
        ))}
      </ol>

      <section className="message-section">
        <SectionTitle sub={t("rewards.catalogSub")}>{t("rewards.catalogTitle")}</SectionTitle>
        {rules.length === 0 ? <EmptyState><p>{t("rewards.emptyCatalog")}</p></EmptyState> : null}
        <div className="conversation-list">
          {rules.map((rule) => (
            <article className="conversation rule-row" key={rule.recognitionKind}>
              <span className="conversation__avatar" aria-hidden="true">✓</span>
              <span>
                <strong>{rule.label}</strong>
                <small>{rule.description}</small>
              </span>
              <span className="conversation__meta">
                <span className="reward-chip">{t("rewards.pointsShort")}</span>
              </span>
            </article>
          ))}
        </div>
      </section>

      <section className="message-section">
        <SectionTitle sub={t("rewards.recentSub")}>{t("rewards.recent")}</SectionTitle>
        {events.length === 0 ? <EmptyState><p>{t("rewards.noAcknowledgements")}</p></EmptyState> : null}
        <div className="conversation-list">
          {events.map((event) => {
            const rule = rules.find((item) => item.recognitionKind === event.recognitionKind);
            return (
              <article className="conversation" key={event.id}>
                <span className="conversation__avatar" aria-hidden="true">✓</span>
                <span>
                  <strong>{rule?.label || event.recognitionKind}</strong>
                  <small>{event.sourceLabel || t("rewards.pointsShort")}</small>
                </span>
                <time className="conversation__meta" dateTime={event.occurredAt}>
                  {new Intl.DateTimeFormat(localeFor(lang), { month: "short", day: "numeric", year: "numeric" }).format(new Date(event.occurredAt))}
                </time>
              </article>
            );
          })}
        </div>
      </section>

      <section className="message-section contribution-boundary">
        <SectionTitle sub={t("rewards.notRewardedSub")}>{t("rewards.notRewardedTitle")}</SectionTitle>
        <p>{t("rewards.notRewardedList")}</p>
      </section>
    </div>
  );
}
