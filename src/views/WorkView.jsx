import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { EmptyState, ScreenHeader } from "../components/Primitives.jsx";
import { useLang } from "../lib/LanguageContext.jsx";

const FILTERS = ["all", "to_do", "in_progress", "review", "done"];

function statusLabel(t, status) {
  return t(`work.status.${status}`);
}

export function WorkView({ data, onProfile, onAssistant }) {
  const { t } = useLang();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (data.organizingWork ?? []).filter((task) => {
      const matchesStatus = filter === "all" || task.status === filter;
      const matchesQuery = !needle || `${task.reference} ${task.title} ${task.type} ${task.assignee}`.toLowerCase().includes(needle);
      return matchesStatus && matchesQuery;
    });
  }, [data.organizingWork, filter, query]);

  return (
    <div className="screen work-screen">
      <ScreenHeader
        initials={data.member.initials}
        eyebrow={t("work.eyebrow")}
        title={t("work.heading")}
        compact
        onProfile={onProfile}
        onAssistant={onAssistant}
      />
      <p className="work-intro">{t("work.intro")}</p>
      <label className="work-search">
        <span className="visually-hidden">{t("work.searchLabel")}</span>
        <Search size={18} aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("work.searchPlaceholder")}
        />
      </label>
      <div className="work-filters" role="group" aria-label={t("work.filterLabel")}>
        {FILTERS.map((status) => (
          <button
            key={status}
            type="button"
            aria-pressed={filter === status}
            onClick={() => setFilter(status)}
          >
            {status === "all" ? t("work.status.all") : statusLabel(t, status)}
          </button>
        ))}
      </div>
      <section className="work-list" aria-live="polite">
        {visible.length === 0 ? (
          <EmptyState>{query ? t("work.emptySearch") : t("work.empty")}</EmptyState>
        ) : visible.map((task) => (
          <article className="work-row" key={task.id}>
            <div className="work-row__top">
              <span className="work-row__reference">{task.reference}</span>
              <span className={`work-row__status work-row__status--${task.status}`}>{statusLabel(t, task.status)}</span>
            </div>
            <h2>{task.title}</h2>
            <div className="work-row__meta">
              <span>{task.type}</span>
              <span>{t("work.assignee", { assignee: task.assignee })}</span>
              <span>{t("work.due", { due: task.due })}</span>
              <span>{t("work.checklist", { done: task.checklist.done, total: task.checklist.total })}</span>
              {task.blocked && <strong>{t("work.blocked")}</strong>}
            </div>
          </article>
        ))}
      </section>
      <p className="work-boundary">{t("work.boundary")}</p>
    </div>
  );
}
