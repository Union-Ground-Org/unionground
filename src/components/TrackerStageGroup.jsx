import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Pager } from "./Pager.jsx";
import { usePagedList } from "../lib/usePagedQueue.js";
import { useLang } from "../lib/LanguageContext.jsx";
import "./trackerStageGroup.css";

/** A collapsible stage: five preview rows, then bounded pages of 25. */
export function TrackerStageGroup({ id, name, count, rows, collapsed, onToggle, headerAction, renderRow, footer, showAllLabel, showFewerLabel, dataGroup, onRevealRows, revealRowsLabel, revealRowsPage = 1 }) {
  const { t } = useLang();
  const [expanded, setExpanded] = useState(false);
  const paged = usePagedList(rows, 25);
  const visible = expanded ? paged.rows : rows.slice(0, 5);
  return <section className="kan-list__group sg-tracker-stage" aria-labelledby={`${id}-title`} data-group={dataGroup}>
    <header>
      <button type="button" className="kan-list__collapse sg-tracker-stage__toggle" aria-expanded={!collapsed} aria-controls={id} aria-label={`${name}, ${count}`} onClick={onToggle}>
        {collapsed ? <ChevronRight size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
        <strong id={`${id}-title`}>{name}</strong>{" "}<span>{count}</span>
      </button>
      {headerAction}
    </header>
    <div id={id} hidden={collapsed}>
      <ul className="kan-list__rows">{visible.map(renderRow)}</ul>
      {rows.length > 5 && <button type="button" className="kan-list__reveal sg-tracker-stage__show" aria-expanded={expanded} onClick={() => { setExpanded(!expanded); paged.setPage(1); }}>{expanded ? showFewerLabel || t("kanban.showFewerTasks") : showAllLabel ? showAllLabel(rows.length) : t("kanban.showAllTasks", { count: rows.length })}</button>}
      {expanded && rows.length > 25 && <Pager total={rows.length} page={paged.page} onPageChange={paged.setPage} />}
      {onRevealRows && <button type="button" className="kan-list__reveal sg-tracker-stage__show" onClick={() => { setExpanded(true); paged.setPage(revealRowsPage); onRevealRows(); }}>{revealRowsLabel}</button>}
      {footer}
    </div>
  </section>;
}
