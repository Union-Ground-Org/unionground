import { useMemo, useRef, useState } from "react";
import { ANALYTICS_CHART_TYPES, ANALYTICS_LAYOUT_SCOPES, paginateAnalyticsLayouts, paginateAnalyticsMembers } from "../parity.js";
import { ArrivalCount, ChartArrival, arriveAt } from "../../../components/ChartArrival.jsx";
import { BusyButton } from "../../../components/BusyControls.jsx";
import { runBusyWrite } from "../../../lib/busyWrite.js";

const COPY = {
  en: {
    unavailable: "This analytics workspace is not available from the current protected snapshot.",
    noRows: "No authorized records are available yet.",
    health: "Organization health tree",
    healthSub: "Campaign health and transparent worker support signals. Issue volume never lowers a worker score.",
    explorer: "Analytics explorer",
    explorerSub: "Search and inspect authorized worker signals without exporting private row content.",
    explorerNamed: "Members are named in every group, including groups of 25 or fewer. Scores and support labels show unless a member has hidden their score.",
    studio: "Charts studio",
    studioSub: "Build a protected view from the approved aggregate datasets and save a reusable layout.",
    chapterCharts: "Campaign charts",
    chapterChartsSub: "Shared campaign scorecards use the same authorization and privacy floor as the source dataset.",
    search: "Search workers",
    memberColumn: "Worker",
    allChapters: "All campaigns",
    allSignals: "All support signals",
    score: "Overall score",
    participation: "Participation",
    readiness: "Profile readiness",
    followThrough: "Follow-through",
    cases: "Active issues",
    overdue: "Overdue deadlines",
    attention: "Support signal",
    dataset: "Dataset",
    chartType: "Chart type",
    layoutName: "Layout name",
    scope: "Sharing scope",
    scopeLabels: { personal: "Only me", chapter: "Campaign", organization: "Whole organization" },
    chapter: "Campaign",
    save: "Save layout",
    saving: "Saving…",
    saved: "Layout saved.",
    saveError: "The layout could not be saved.",
    deleteError: "The layout could not be removed.",
    remove: "Remove",
    deleting: "Removing…",
    previousPage: "Previous page",
    nextPage: "Next page",
    layoutPages: "Layout pages",
    memberPages: "Worker pages",
    page: "Page",
    of: "of",
    signals: { urgent: "Urgent", support: "Support", watch: "Watch", steady: "Steady" },
    chartTypes: { bar: "Bar", stacked_bar: "Stacked bar", line: "Line", area: "Area", table: "Table" },
    chartTypeLabels: {
      bar: "bar chart",
      stacked_bar: "stacked bar chart",
      line: "line chart",
      area: "area chart",
      table: "data table",
    },
    emptyLayouts: "No shared campaign layouts have been saved yet.",
    protected: "This chapter's own score shows once it has at least 25 members. Its members are named below.",
  },
  es: {
    unavailable: "Este espacio de analítica no está disponible en la instantánea protegida actual.",
    noRows: "Todavía no hay registros autorizados.",
    health: "Árbol de salud de la organización",
    healthSub: "Salud de campañas y señales transparentes de apoyo. La cantidad de asuntos nunca reduce una puntuación.",
    explorer: "Explorador de analítica",
    explorerSub: "Busca e inspecciona señales autorizadas sin exportar contenido privado por persona.",
    explorerNamed: "Cada miembro aparece con nombre en todos los grupos, también en los de 25 o menos. La puntuación y la etiqueta de apoyo aparecen salvo si la persona decidió ocultar la puntuación.",
    studio: "Estudio de gráficas",
    studioSub: "Crea una vista protegida con conjuntos agregados aprobados y guarda un diseño reutilizable.",
    chapterCharts: "Gráficas de campañas",
    chapterChartsSub: "Los tableros compartidos usan la misma autorización y mínimo de privacidad que el conjunto de datos de origen.",
    search: "Buscar trabajadores",
    memberColumn: "Trabajador",
    allChapters: "Todas las campañas",
    allSignals: "Todas las señales de apoyo",
    score: "Puntuación general",
    participation: "Participación",
    readiness: "Preparación del perfil",
    followThrough: "Seguimiento",
    cases: "Asuntos activos",
    overdue: "Plazos vencidos",
    attention: "Señal de apoyo",
    dataset: "Conjunto de datos",
    chartType: "Tipo de gráfica",
    layoutName: "Nombre del diseño",
    scope: "Alcance compartido",
    scopeLabels: { personal: "Solo yo", chapter: "Campaña", organization: "Toda la organización" },
    chapter: "Campaña",
    save: "Guardar diseño",
    saving: "Guardando…",
    saved: "Diseño guardado.",
    saveError: "No se pudo guardar el diseño.",
    deleteError: "No se pudo eliminar el diseño.",
    remove: "Eliminar",
    deleting: "Eliminando…",
    previousPage: "Página anterior",
    nextPage: "Página siguiente",
    layoutPages: "Páginas de diseños",
    memberPages: "Páginas de trabajadores",
    page: "Página",
    of: "de",
    signals: { urgent: "Urgente", support: "Apoyo", watch: "Observar", steady: "Estable" },
    chartTypes: { bar: "Barras", stacked_bar: "Barras apiladas", line: "Línea", area: "Área", table: "Tabla" },
    chartTypeLabels: {
      bar: "gráfica de barras",
      stacked_bar: "gráfica de barras apiladas",
      line: "gráfica de líneas",
      area: "gráfica de área",
      table: "tabla de datos",
    },
    emptyLayouts: "Todavía no hay diseños compartidos de campaña.",
    protected: "La puntuación propia de este capítulo aparece cuando tiene al menos 25 miembros. Abajo aparece cada miembro con nombre.",
  },
};

function WorkspaceBoundary({ workspace, copy }) {
  if (workspace?.state === "ready") return null;
  return <p className="mi1-ana__note" role="status">{copy.unavailable}</p>;
}

function LayoutPagination({ pagination, setPage, copy, label = copy.layoutPages }) {
  if (pagination.pageCount <= 1) return null;
  return (
    <nav className="mi1-ana-pagination" aria-label={label}>
      <button
        type="button"
        className="outline-pill mi1-ana__tab"
        disabled={pagination.page === 0}
        onClick={() => setPage(pagination.page - 1)}
      >{copy.previousPage}</button>
      <p className="mi1-ana__note" role="status" aria-label={label}>
        {copy.page} {pagination.page + 1} {copy.of} {pagination.pageCount}
      </p>
      <button
        type="button"
        className="outline-pill mi1-ana__tab"
        disabled={pagination.page + 1 >= pagination.pageCount}
        onClick={() => setPage(pagination.page + 1)}
      >{copy.nextPage}</button>
    </nav>
  );
}

// Stored tokens (support signal, chart type) read as words; an unknown token
// still shows as stored rather than disappearing.
function tokenLabel(labels, value) {
  return labels?.[value] || value || "—";
}

function ScoreLine({ label, value }) {
  return (
    <div className="mi1-ana-score">
      <span>{label}</span>
      <strong>{value == null ? "—" : value}</strong>
    </div>
  );
}

function MemberDetail({ member, copy }) {
  if (!member) return null;
  return (
    <article className="plane-card ach-card mi1-ana-detail" aria-live="polite">
      <div>
        <p className="mi1-ana__eyebrow">{member.chapterName}</p>
        <h3 className="ach-card__title">{member.name}</h3>
      </div>
      <div className="mi1-ana__grid">
        <ScoreLine label={copy.score} value={member.overallScore} />
        <ScoreLine label={copy.participation} value={member.participationScore} />
        <ScoreLine label={copy.readiness} value={member.profileReadiness} />
        <ScoreLine label={copy.followThrough} value={member.followThrough} />
        <ScoreLine label={copy.cases} value={member.activeCases} />
        <ScoreLine label={copy.overdue} value={member.overdueCases} />
      </div>
      <p className="mi1-ana__note">{copy.attention}: {tokenLabel(copy.signals, member.attention)}</p>
    </article>
  );
}

export function OrganizationHealthPanel({ workspace, lang = "en" }) {
  const copy = COPY[lang] || COPY.en;
  const [selected, setSelected] = useState(null);
  if (workspace?.state !== "ready") return <WorkspaceBoundary workspace={workspace} copy={copy} />;
  return (
    <section className="mi1-ana-workspace" aria-labelledby="analytics-health-title">
      <div>
        <h2 id="analytics-health-title" className="ach-card__title">{copy.health}</h2>
        <p className="mi1-ana__note">{copy.healthSub}</p>
      </div>
      {!workspace.chapters.length ? <p className="mi1-ana__note">{copy.noRows}</p> : null}
      <div className="mi1-ana-tree">
        {workspace.chapters.map((chapter) => (
          <article key={chapter.chapterId} className="plane-card ach-card">
            <div className="mi1-ana-tree__head">
              <div>
                <h3 className="ach-card__title">{chapter.chapterName}</h3>
                <p className="mi1-ana__note">{chapter.health?.protected ? copy.protected : `${copy.score}: ${chapter.health?.score ?? "—"}`}</p>
              </div>
              <span className="mi1-ana-badge">{chapter.members.length}</span>
            </div>
            <div className="mi1-ana-tree__members" role="list">
              {chapter.members.map((member) => (
                <div key={member.id} role="listitem">
                  <button
                    type="button"
                    className="mi1-ana-member"
                    aria-pressed={selected?.id === member.id}
                    onClick={() => setSelected(member)}
                  >
                    <span><strong>{member.name}</strong><small>{tokenLabel(copy.signals, member.attention)}</small></span>
                    <span>{member.overallScore ?? "—"}</span>
                  </button>
                </div>
              ))}
            </div>
          </article>
        ))}
      </div>
      <MemberDetail member={selected} copy={copy} />
    </section>
  );
}

export function AnalyticsExplorerPanel({ workspace, lang = "en" }) {
  const copy = COPY[lang] || COPY.en;
  const [query, setQuery] = useState("");
  const [chapterId, setChapterId] = useState("");
  const [attention, setAttention] = useState("");
  const [selected, setSelected] = useState(null);
  const [page, setPage] = useState(0);
  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return (workspace?.members || []).filter((member) => (
      (!needle || member.name.toLocaleLowerCase().includes(needle))
      && (!chapterId || member.chapterId === chapterId)
      && (!attention || member.attention === attention)
    ));
  }, [attention, chapterId, query, workspace?.members]);
  const memberPage = paginateAnalyticsMembers(rows, page);
  if (workspace?.state !== "ready") return <WorkspaceBoundary workspace={workspace} copy={copy} />;
  return (
    <section className="mi1-ana-workspace" aria-labelledby="analytics-explorer-title">
      <div>
        <h2 id="analytics-explorer-title" className="ach-card__title">{copy.explorer}</h2>
        <p className="mi1-ana__note">{copy.explorerSub}</p>
        <p className="mi1-ana__note">{copy.explorerNamed}</p>
      </div>
      <div className="mi1-ana-filters">
        <label>
          <span>{copy.search}</span>
          <input value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} type="search" />
        </label>
        <label>
          <span>{copy.chapter}</span>
          <select value={chapterId} onChange={(event) => { setChapterId(event.target.value); setPage(0); }}>
            <option value="">{copy.allChapters}</option>
            {workspace.chapters.map((chapter) => <option key={chapter.chapterId} value={chapter.chapterId}>{chapter.chapterName}</option>)}
          </select>
        </label>
        <label>
          <span>{copy.attention}</span>
          <select value={attention} onChange={(event) => { setAttention(event.target.value); setPage(0); }}>
            <option value="">{copy.allSignals}</option>
            {Object.keys(copy.signals).map((value) => <option key={value} value={value}>{copy.signals[value]}</option>)}
          </select>
        </label>
      </div>
      {!rows.length ? <p className="mi1-ana__note">{copy.noRows}</p> : (
        <>
          <div className="mi1-ana-table-wrap">
            <table className="mi1-ana__table">
              <thead><tr><th>{copy.memberColumn}</th><th>{copy.chapter}</th><th>{copy.score}</th><th>{copy.attention}</th></tr></thead>
              <tbody>{memberPage.items.map((member) => (
                <tr key={member.id}>
                  <td><button type="button" className="mi1-ana-link" onClick={() => setSelected(member)}>{member.name}</button></td>
                  <td>{member.chapterName}</td><td>{member.overallScore ?? "—"}</td><td>{tokenLabel(copy.signals, member.attention)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
          <LayoutPagination pagination={memberPage} setPage={setPage} copy={copy} label={copy.memberPages} />
        </>
      )}
      <MemberDetail member={selected} copy={copy} />
    </section>
  );
}

const CHART_TYPE_CLASSES = Object.freeze({
  bar: "mi1-ana-chart--bar",
  stacked_bar: "mi1-ana-chart--stacked",
  line: "mi1-ana-chart--line",
  area: "mi1-ana-chart--area",
});

function normalizeChartType(chartType) {
  return ANALYTICS_CHART_TYPES.includes(chartType) ? chartType : "bar";
}

function svgPoints(rows, max) {
  const height = 48;
  const pad = 5;
  const inner = height - pad * 2;
  const span = 100 - pad * 2;
  const step = rows.length > 1 ? span / (rows.length - 1) : 0;
  return rows.map((row, index) => `${(pad + index * step).toFixed(2)},${(height - pad - (Math.abs(row.value) / max) * inner).toFixed(2)}`).join(" ");
}

function BarGraphic({ dataset, max }) {
  return dataset.rows.map((row, index) => (
    <div key={row.label} className="mi1-ana-chart__row">
      <span>{row.label}</span>
      <span className="mi1-ana-chart__track"><span className="arrive-x" style={arriveAt(index, { width: `${Math.max(2, Math.round((Math.abs(row.value) / max) * 100))}%` })} /></span>
      <strong><ArrivalCount value={row.value} index={index} /></strong>
    </div>
  ));
}

function StackedBarGraphic({ dataset }) {
  const total = dataset.rows.reduce((sum, row) => sum + Math.abs(row.value), 0) || 1;
  return (
    <div className="mi1-ana-chart__stack arrive-x">
      {dataset.rows.map((row) => (
        <span
          key={row.label}
          className="mi1-ana-chart__segment"
          style={{ flexGrow: Math.abs(row.value) / total, flexShrink: 0, flexBasis: 0 }}
        />
      ))}
    </div>
  );
}

function LineGraphic({ dataset, max }) {
  return (
    <svg className="mi1-ana-chart__svg" viewBox="0 0 100 48" preserveAspectRatio="none" aria-hidden="true">
      <polyline className="mi1-ana-chart__line arrive-line" points={svgPoints(dataset.rows, max)} />
    </svg>
  );
}

function AreaGraphic({ dataset, max }) {
  const points = svgPoints(dataset.rows, max);
  const first = points.split(" ")[0].split(",")[0];
  const last = points.split(" ").at(-1).split(",")[0];
  return (
    <svg className="mi1-ana-chart__svg" viewBox="0 0 100 48" preserveAspectRatio="none" aria-hidden="true">
      <polygon className="mi1-ana-chart__area arrive-line" points={`${points} ${last},43 ${first},43`} />
    </svg>
  );
}

const CHART_GRAPHICS = Object.freeze({
  bar: BarGraphic,
  stacked_bar: StackedBarGraphic,
  line: LineGraphic,
  area: AreaGraphic,
});

function DatasetPreview({ dataset, chartType, copy = COPY.en }) {
  if (!dataset?.rows?.length) return null;
  const type = normalizeChartType(chartType);
  const chartLabel = copy.chartTypeLabels[type];
  if (type === "table") {
    return <table className="mi1-ana__table"><tbody>{dataset.rows.map((row) => <tr key={row.label}><td>{row.label}</td><td>{row.value}</td></tr>)}</tbody></table>;
  }
  const max = Math.max(...dataset.rows.map((row) => Math.abs(row.value)), 1);
  const Graphic = CHART_GRAPHICS[type] || BarGraphic;
  return (
    <ChartArrival name={`analytics:dataset:${dataset.label}`} className={`mi1-ana-chart ${CHART_TYPE_CLASSES[type] || CHART_TYPE_CLASSES.bar}`} role="img" aria-label={`${dataset.label}, ${chartLabel}`}>
      <Graphic dataset={dataset} max={max} />
    </ChartArrival>
  );
}

function idempotencyKey() {
  return globalThis.crypto?.randomUUID?.() || null;
}

// save_organization_analytics_layout refuses organization sharing without one of these organization roles.
const ORGANIZATION_LAYOUT_ROLES = ["coordinator", "admin", "vp"];

export function AnalyticsStudioPanel({ workspace, viewer = null, lang = "en", onSaveLayout, onDeleteLayout }) {
  const copy = COPY[lang] || COPY.en;
  const organizationRoles = Array.isArray(viewer?.organizationRoles) ? viewer.organizationRoles : [];
  const scopes = organizationRoles.some((role) => ORGANIZATION_LAYOUT_ROLES.includes(role))
    ? ANALYTICS_LAYOUT_SCOPES
    : ANALYTICS_LAYOUT_SCOPES.filter((value) => value !== "organization");
  const firstDataset = workspace?.datasets?.[0]?.id || "";
  const [datasetId, setDatasetId] = useState(firstDataset);
  const [chartType, setChartType] = useState("bar");
  const [name, setName] = useState("");
  const [scope, setScope] = useState("personal");
  const [chapterId, setChapterId] = useState(workspace?.chapters?.[0]?.chapterId || "");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  // Record 8435: a synchronous write lock, refused before React commits busy.
  const busyWriteRef = useRef(new Set());
  const [page, setPage] = useState(0);
  // One save intent keeps one idempotency key until the server confirms it,
  // so a retry after an unknown outcome replays the same receipt instead of
  // creating a second layout.
  const pendingSave = useRef(null);
  const dataset = workspace?.datasets?.find((item) => item.id === datasetId) || workspace?.datasets?.[0] || null;
  const layoutPage = paginateAnalyticsLayouts(workspace?.layouts, page);
  if (workspace?.state !== "ready") return <WorkspaceBoundary workspace={workspace} copy={copy} />;

  function save() {
    return runBusyWrite(busyWriteRef, "layouts", () => saveNow());
  }

  async function saveNow() {
    if (!onSaveLayout || !dataset || !name.trim()) return;
    const request = {
      name: name.trim(), scope, chapterId: scope === "chapter" ? chapterId : null,
      spec: { datasetId: dataset.id, chartType, title: name.trim() },
    };
    const intent = JSON.stringify(request);
    const key = pendingSave.current?.intent === intent ? pendingSave.current.key : idempotencyKey();
    if (!key) { setNotice(copy.saveError); return; }
    pendingSave.current = { intent, key };
    setBusy(true); setNotice(copy.saving);
    const result = await onSaveLayout({ ...request, idempotencyKey: key });
    setBusy(false); setNotice(result?.ok ? copy.saved : copy.saveError);
    if (result?.ok) { pendingSave.current = null; setName(""); }
  }

  function remove(id) {
    return runBusyWrite(busyWriteRef, "layouts", () => removeNow(id));
  }

  async function removeNow(id) {
    if (!onDeleteLayout) return;
    const key = idempotencyKey();
    if (!key) { setNotice(copy.deleteError); return; }
    setBusy(true); setNotice(copy.deleting);
    const result = await onDeleteLayout({ id, idempotencyKey: key });
    setBusy(false); setNotice(result?.ok ? "" : copy.deleteError);
  }

  return (
    <section className="mi1-ana-workspace" aria-labelledby="analytics-studio-title">
      <div><h2 id="analytics-studio-title" className="ach-card__title">{copy.studio}</h2><p className="mi1-ana__note">{copy.studioSub}</p></div>
      <div className="mi1-ana-filters">
        <label><span>{copy.dataset}</span><select value={dataset?.id || ""} onChange={(event) => setDatasetId(event.target.value)}>{workspace.datasets.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label><span>{copy.chartType}</span><select value={chartType} onChange={(event) => setChartType(event.target.value)}>{ANALYTICS_CHART_TYPES.map((type) => <option key={type} value={type}>{tokenLabel(copy.chartTypes, type)}</option>)}</select></label>
        <label><span>{copy.layoutName}</span><input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} /></label>
        <label><span>{copy.scope}</span><select value={scope} onChange={(event) => setScope(event.target.value)}>{scopes.map((value) => <option key={value} value={value}>{copy.scopeLabels[value]}</option>)}</select></label>
        {scope === "chapter" ? <label><span>{copy.chapter}</span><select value={chapterId} onChange={(event) => setChapterId(event.target.value)}>{workspace.chapters.map((chapter) => <option key={chapter.chapterId} value={chapter.chapterId}>{chapter.chapterName}</option>)}</select></label> : null}
      </div>
      <article className="plane-card ach-card"><h3 className="ach-card__title">{name.trim() || dataset?.label}</h3><DatasetPreview dataset={dataset} chartType={chartType} copy={copy} /></article>
      <BusyButton type="button" className="outline-pill mi1-ana__tab" pending={busy} disabled={!name.trim() || !dataset || scope === "chapter" && !chapterId} onClick={() => void save()}>{busy ? copy.saving : copy.save}</BusyButton>
      {notice ? <p className="mi1-ana__note" role="status">{notice}</p> : null}
      <div className="mi1-ana-layouts">{layoutPage.items.map((layout) => (
        <article key={layout.id} className="plane-card ach-card"><h3 className="ach-card__title">{layout.name}</h3><p className="mi1-ana__note">{copy.scopeLabels[layout.scope] || layout.scope} · {tokenLabel(copy.chartTypes, layout.spec.chartType)}</p>{layout.canEdit ? <BusyButton type="button" className="mi1-ana-link" pending={busy} onClick={() => void remove(layout.id)}>{copy.remove}</BusyButton> : null}</article>
      ))}</div>
      <LayoutPagination pagination={layoutPage} setPage={setPage} copy={copy} />
    </section>
  );
}

export function ChapterChartsPanel({ workspace, lang = "en" }) {
  const copy = COPY[lang] || COPY.en;
  const [page, setPage] = useState(0);
  const layoutPage = paginateAnalyticsLayouts(workspace?.chapterCharts, page);
  if (workspace?.state !== "ready") return <WorkspaceBoundary workspace={workspace} copy={copy} />;
  return (
    <section className="mi1-ana-workspace" aria-labelledby="analytics-chapter-charts-title">
      <div><h2 id="analytics-chapter-charts-title" className="ach-card__title">{copy.chapterCharts}</h2><p className="mi1-ana__note">{copy.chapterChartsSub}</p></div>
      {!workspace.chapterCharts.length ? <p className="mi1-ana__note">{copy.emptyLayouts}</p> : null}
      <div className="mi1-ana-layouts">{layoutPage.items.map((layout) => {
        const dataset = workspace.datasets.find((item) => item.id === layout.spec.datasetId && (!layout.chapterId || !item.chapterId || item.chapterId === layout.chapterId));
        return <article key={layout.id} className="plane-card ach-card"><h3 className="ach-card__title">{layout.name}</h3><p className="mi1-ana__note">{workspace.chapters.find((chapter) => chapter.chapterId === layout.chapterId)?.chapterName || layout.chapterId}</p><DatasetPreview dataset={dataset} chartType={layout.spec.chartType} copy={copy} /></article>;
      })}</div>
      <LayoutPagination pagination={layoutPage} setPage={setPage} copy={copy} />
    </section>
  );
}
