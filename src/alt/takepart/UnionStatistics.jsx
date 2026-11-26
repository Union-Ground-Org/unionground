// The Statistics page's three union-wide panels (pages/stats.js: wins and
// actions by month, how grievances end, the chapter table) on
// get_member_union_statistics (REQ-UG-ALT-MEMBER-PAGES-SERVER-DATA-20261030).
// The server publishes each breakdown whole or withholds it whole under the
// organization's anonymity floor; a withheld breakdown, a withheld chapter
// figure, a failed read and a reader outside a union organization each say
// so here. Without a client (the fixture demo) the panels keep the
// "not published" state they had, and nothing is drawn from sample data.
import { useEffect, useState } from "react";
import { useLang } from "../../lib/LanguageContext.jsx";
import { localeFor } from "../../lib/i18n.js";
import { MemberApiError } from "../../lib/memberApiError.js";
import { formatNumber } from "../format.js";
import { BarChart, DataTable, HBars } from "./charts.jsx";
import "../../lib/i18n/features/altTakePartStrings.js";

export const OUTCOMES = ["upheld", "settled", "withdrawn", "denied", "other"];
const OUTCOME_COLOR = { upheld: "var(--ug-hero)", settled: "var(--ug-case)", withdrawn: "var(--ug-act-text)", denied: "var(--ug-terra)", other: "var(--ug-purple)" };

export async function loadUnionStatistics(client) {
  const { data, error } = await client.rpc("get_member_union_statistics");
  if (error) throw new MemberApiError("Union statistics", error);
  return data && typeof data === "object" ? data : { available: false };
}

// "2026-10" as the reader's short month name ("Oct", "oct").
export function monthLabel(month, lang) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(month || ""));
  if (!match) return String(month || "");
  return new Date(Number(match[1]), Number(match[2]) - 1, 1).toLocaleDateString(localeFor(lang), { month: "short" });
}

function Panel({ id, title, sub = null, tools = null, children }) {
  return (
    <div className="ug-panel ug-ta-report" aria-labelledby={`ug-stats-${id}`}>
      <div className="ug-tl-head ug-ta-report-head">
        <h2 id={`ug-stats-${id}`}>{title}</h2>
        {tools ? <div className="ug-tl-tools">{tools}</div> : null}
      </div>
      {sub ? <p className="ug-ta-muted ug-ta-gap-b">{sub}</p> : null}
      {children}
    </div>
  );
}

function Empty({ title, body }) {
  return <div className="ug-empty ug-ta-empty"><b>{title}</b>{body}</div>;
}

export function UnionStatistics({ client = null }) {
  const { t, lang } = useLang();
  const [read, setRead] = useState(() => (client ? { state: "loading" } : { state: "none" }));
  const [tables, setTables] = useState({});

  useEffect(() => {
    if (!client) {
      setRead({ state: "none" });
      return undefined;
    }
    let active = true;
    setRead({ state: "loading" });
    loadUnionStatistics(client).then(
      (value) => { if (active) setRead(value.available === true ? { state: "ready", value } : { state: value.locked === true ? "locked" : "unavailable" }); },
      () => { if (active) setRead({ state: "error" }); },
    );
    return () => { active = false; };
  }, [client]);

  const toggle = (key) => (
    <button
      type="button"
      className="ug-btn ug-btn-soft ug-btn-xs ug-ta-on-panel"
      aria-expanded={Boolean(tables[key])}
      aria-controls={`ug-report-table-${key}`}
      onClick={() => setTables((current) => ({ ...current, [key]: !current[key] }))}
    >
      {tables[key] ? t("altTakePart.hideTable") : t("altTakePart.showTable")}
    </button>
  );

  if (read.state !== "ready") {
    const status = {
      none: [t("altTakePart.statsNotYet"), null],
      loading: [t("altTakePart.statsUnionLoading"), ""],
      error: [t("altTakePart.statsUnionError"), ""],
      unavailable: [t("altTakePart.statsNotYet"), t("altTakePart.statsUnionUnavailable")],
      locked: [t("altTakePart.statsUnionLockedTitle"), t("altTakePart.statsUnionLocked")],
    }[read.state];
    const panel = (key) => (
      <Panel id={key} title={t(`altTakePart.stats_${key}Title`)}>
        <div className="ug-empty ug-ta-empty" aria-busy={read.state === "loading" || undefined}><b>{status[0]}</b>{status[1] ?? t(`altTakePart.stats_${key}Empty`)}</div>
      </Panel>
    );
    return (
      <>
        <div className="ug-grid-2">{panel("monthly")}{panel("outcomes")}</div>
        {panel("chapters")}
      </>
    );
  }

  const { value } = read;
  const floor = formatNumber(value.privacyFloor, lang);
  const withheld = <Empty title={t("altTakePart.statsWithheldTitle")} body={t("altTakePart.statsWithheld", { floor })} />;
  const series = (part) => (part?.withheld === false && Array.isArray(part.months) ? part.months : null);
  const wins = series(value.wins);
  const actions = series(value.actions);
  const months = (wins ?? actions ?? []).map((row) => row.month);
  const count = (rows, month) => rows?.find((row) => row.month === month)?.count ?? null;
  const bars = (rows) => rows.map((row) => ({ v: row.count, label: monthLabel(row.month, lang), val: formatNumber(row.count, lang) }));
  const dash = (number) => (number == null ? "—" : formatNumber(number, lang));

  const outcomes = value.outcomes?.withheld === false && Array.isArray(value.outcomes.rows) ? value.outcomes.rows.filter((row) => OUTCOMES.includes(row.outcome)) : null;
  const outcomeTotal = outcomes ? outcomes.reduce((sum, row) => sum + row.count, 0) : 0;

  const chapterRows = Array.isArray(value.chapters?.rows) ? value.chapters.rows : [];
  const openWithheld = value.chapters?.openCasesWithheld === true;
  const chapterTable = chapterRows.map((row) => [row.name, dash(row.members), openWithheld ? "—" : dash(row.openCases)]);
  const anyChapterWithheld = openWithheld || chapterRows.some((row) => row.members == null);

  return (
    <>
      <div className="ug-grid-2">
        <Panel id="monthly" title={t("altTakePart.stats_monthlyTitle")} sub={t("altTakePart.stats_monthlySub")} tools={months.length ? toggle("monthly") : null}>
          <h3 className="ug-ta-muted">{t("altTakePart.stats_monthlyWins")}</h3>
          {wins ? <BarChart bars={bars(wins)} color="var(--ug-hero)" label={t("altTakePart.stats_monthlyWins")} /> : withheld}
          <h3 className="ug-ta-muted">{t("altTakePart.stats_monthlyActions")}</h3>
          {actions ? <BarChart bars={bars(actions)} color="var(--ug-act-text)" label={t("altTakePart.stats_monthlyActions")} /> : withheld}
          {months.length ? (
            <div id="ug-report-table-monthly" hidden={!tables.monthly}>
              <DataTable
                head={[t("altTakePart.stats_monthCol"), t("altTakePart.stats_monthlyWins"), t("altTakePart.stats_monthlyActions")]}
                rows={months.map((month) => [monthLabel(month, lang), dash(count(wins, month)), dash(count(actions, month))])}
              />
            </div>
          ) : null}
        </Panel>
        <Panel id="outcomes" title={t("altTakePart.stats_outcomesTitle")} sub={t("altTakePart.stats_outcomesSub")} tools={outcomeTotal ? toggle("outcomes") : null}>
          {outcomes ? (
            outcomeTotal ? (
              <>
                <HBars name="takepart:stats:outcomes" rows={outcomes.map((row) => ({ label: t(`altTakePart.outcome_${row.outcome}`), w: Math.round((100 * row.count) / outcomeTotal), val: formatNumber(row.count, lang), color: OUTCOME_COLOR[row.outcome] }))} />
                <div id="ug-report-table-outcomes" hidden={!tables.outcomes}>
                  <DataTable head={[t("altTakePart.statsTableItem"), t("altTakePart.statsTableValue")]} rows={outcomes.map((row) => [t(`altTakePart.outcome_${row.outcome}`), formatNumber(row.count, lang)])} />
                </div>
              </>
            ) : <Empty title={t("altTakePart.stats_outcomesNoneTitle")} body={t("altTakePart.stats_outcomesNone")} />
          ) : withheld}
        </Panel>
      </div>
      <Panel id="chapters" title={t("altTakePart.stats_chaptersTitle")} sub={t("altTakePart.stats_chaptersSub")}>
        {chapterTable.length ? (
          <>
            <DataTable head={[t("altTakePart.stats_chapterCol"), t("altTakePart.stats_membersCol"), t("altTakePart.stats_openCol")]} rows={chapterTable} />
            {anyChapterWithheld ? <p className="ug-ta-muted ug-ta-gap">{t("altTakePart.stats_chaptersWithheld", { floor })}</p> : null}
          </>
        ) : <Empty title={t("altTakePart.stats_chaptersNoneTitle")} body={t("altTakePart.stats_chaptersNone")} />}
      </Panel>
    </>
  );
}
